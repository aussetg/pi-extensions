import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowAgent } from "../src/agents/workflow-agent.js";
import { DEFAULT_LIMITS } from "../src/constants.js";
import { JsonlJournal } from "../src/persistence/journal.js";
import { WorkflowRegistry } from "../src/persistence/registry.js";
import { RunStore } from "../src/persistence/run-store.js";
import { WorkflowBudget } from "../src/runtime/budget.js";
import { WorkflowAbortError } from "../src/runtime/errors.js";
import { RunControl } from "../src/runtime/run-control.js";
import { WorkflowRunner } from "../src/runtime/runner.js";
import { WorkflowScheduler } from "../src/runtime/scheduler.js";
import type { RunRecord } from "../src/types.js";

let oldAgentDir: string | undefined;
let tmp: string;
let cwd: string;

beforeEach(async () => {
  oldAgentDir = process.env.PI_AGENT_DIR;
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-budget-limits-"));
  process.env.PI_AGENT_DIR = path.join(tmp, "agent");
  cwd = path.join(tmp, "project");
  await fs.promises.mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (oldAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = oldAgentDir;
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("workflow budget and child workflow limits", () => {
  it("wakes all queued reservations when a serialized subagent exhausts the budget", async () => {
    const budget = new WorkflowBudget(10);
    const first = await budget.reserveExclusive();
    const queued = [budget.reserveExclusive(), budget.reserveExclusive(), budget.reserveExclusive()].map((promise) => promise.then(
      () => "started",
      (err) => err.name,
    ));

    budget.charge(11);
    first.release();

    await expect(Promise.all(queued)).resolves.toEqual(["WorkflowBudgetExceededError", "WorkflowBudgetExceededError", "WorkflowBudgetExceededError"]);
  });

  it("does not strand queued caught fanout agents after an over-budget subagent", async () => {
    let calls = 0;
    vi.spyOn(WorkflowAgent.prototype, "run").mockImplementation(async (call) => {
      calls++;
      return await writeMockAgentResult(call, `result ${calls}`, 20);
    });

    const controller = new AbortController();
    const run = runner().launchOrRun({
      toolCallId: "caught-fanout-budget-test",
      signal: controller.signal,
      input: {
        mode: "await",
        budgetTokens: 10,
        maxAgents: 5,
        script: `export const meta = { name: 'caught_fanout_budget', description: 'queued budget waiters all wake' };
const lanes = [0, 1, 2, 3];
return await parallel(lanes.map((lane) => async () => {
  try {
    await agent('lane ' + lane, { label: 'lane ' + lane });
    return 'ok';
  } catch (err) {
    return err.name + ': ' + err.message;
  }
}));
`,
      },
      ctx: workflowCtx(),
    });

    const result = await settleOrAbort(run, controller, 1500);

    expect(result.status).toBe("completed");
    expect(calls).toBe(1);
    expect(result.usage).toEqual(expect.objectContaining({ agentCount: 1, subagentTokens: 20 }));
    const output = JSON.parse(await fs.promises.readFile(result.outputPath!, "utf8")) as { result: string[] };
    expect(output.result).toHaveLength(4);
    expect(output.result.every((value) => value.startsWith("WorkflowBudgetExceededError:"))).toBe(true);
  });

  it("does not strand later queued agents when an earlier queued agent is skipped", async () => {
    const limit = DEFAULT_LIMITS.agentConcurrency;
    const run = makeRun("limiter_skip_queue_test");
    await fs.promises.mkdir(run.transcriptDir, { recursive: true });
    const control = new RunControl();
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    vi.spyOn(WorkflowAgent.prototype, "run").mockImplementation(async (call) => {
      started.push(call.callId);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      releases.set(call.callId, release);
      await gate;
      return await writeMockAgentResult(call, `result ${call.callId}`, 1);
    });

    const scheduler = new WorkflowScheduler({
      cwd,
      run,
      journal: new JsonlJournal(run.journalPath),
      control,
      budget: new WorkflowBudget(null),
      maxAgents: limit + 2,
      checkpoint: () => {},
    });
    const calls = Array.from({ length: limit + 2 }, (_, index) => scheduler.agentCall(`agent ${index}`, { label: `agent ${index}` }));

    try {
      await waitFor(() => started.length === limit, "initial limiter slots did not fill");
      await waitFor(() => run.progress.total === limit + 2, "queued agents were not registered");
      const queuedIds = run.progress.calls.map((call) => call.callId).filter((callId) => !started.includes(callId)).sort();
      expect(queuedIds).toHaveLength(2);
      const [firstQueued, secondQueued] = queuedIds;
      const firstQueuedCall = callPromiseById(run, calls, firstQueued);

      expect(control.skipAgent(firstQueued)).toBe(true);
      await expect(withTimeout(firstQueuedCall, 500, "skipped queued agent did not settle")).resolves.toBeNull();

      releases.get(started[0])?.();
      await waitFor(() => started.includes(secondQueued), "later queued agent did not start after one slot was released");
    } finally {
      for (const release of releases.values()) release();
      await Promise.allSettled(calls);
    }
  });

  it("cancels queued scheduler agents through request abort signals", async () => {
    const limit = DEFAULT_LIMITS.agentConcurrency;
    const run = makeRun("limiter_request_abort_test");
    await fs.promises.mkdir(run.transcriptDir, { recursive: true });
    const control = new RunControl();
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    vi.spyOn(WorkflowAgent.prototype, "run").mockImplementation(async (call) => {
      started.push(call.callId);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      releases.set(call.callId, release);
      await gate;
      return await writeMockAgentResult(call, `result ${call.callId}`, 1);
    });

    const scheduler = new WorkflowScheduler({
      cwd,
      run,
      journal: new JsonlJournal(run.journalPath),
      control,
      budget: new WorkflowBudget(null),
      maxAgents: limit + 2,
      checkpoint: () => {},
    });
    const controllers = Array.from({ length: limit + 2 }, () => new AbortController());
    const calls = controllers.map((controller, index) => scheduler.agentCall(`agent ${index}`, { label: `agent ${index}` }, controller.signal));

    try {
      await waitFor(() => started.length === limit, "initial limiter slots did not fill");
      await waitFor(() => run.progress.total === limit + 2, "queued agents were not registered");
      const queuedIds = run.progress.calls.map((call) => call.callId).filter((callId) => !started.includes(callId)).sort();
      expect(queuedIds).toHaveLength(2);
      const [firstQueued, secondQueued] = queuedIds;
      const firstQueuedCall = callPromiseById(run, calls, firstQueued);
      const firstQueuedIndex = callIndexById(run, firstQueued);

      controllers[firstQueuedIndex].abort(new WorkflowAbortError("request canceled"));
      await expect(withTimeout(firstQueuedCall, 500, "aborted queued agent did not settle")).rejects.toThrow(/request canceled/);
      expect(started).not.toContain(firstQueued);

      releases.get(started[0])?.();
      await waitFor(() => started.includes(secondQueued), "later queued agent did not start after one slot was released");
    } finally {
      for (const release of releases.values()) release();
      await Promise.allSettled(calls);
    }
  });

  it("cancels running scheduler agents through request abort signals", async () => {
    const run = makeRun("running_request_abort_test");
    await fs.promises.mkdir(run.transcriptDir, { recursive: true });
    const control = new RunControl();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted!: (value: string) => void;
    const abortedPromise = new Promise<string>((resolve) => {
      aborted = resolve;
    });
    vi.spyOn(WorkflowAgent.prototype, "run").mockImplementation(async (call) => {
      started();
      return await new Promise((_, reject) => {
        call.signal.addEventListener("abort", () => {
          aborted(call.signal.reason instanceof Error ? call.signal.reason.message : "aborted");
          reject(call.signal.reason);
        }, { once: true });
      });
    });

    const scheduler = new WorkflowScheduler({
      cwd,
      run,
      journal: new JsonlJournal(run.journalPath),
      control,
      budget: new WorkflowBudget(null),
      maxAgents: 1,
      checkpoint: () => {},
    });
    const controller = new AbortController();
    const call = scheduler.agentCall("agent", { label: "agent 0" }, controller.signal);

    await startedPromise;
    controller.abort(new WorkflowAbortError("request canceled"));

    await expect(withTimeout(call, 500, "running agent did not settle")).rejects.toThrow(/request canceled/);
    await expect(withTimeout(abortedPromise, 500, "running agent was not aborted")).resolves.toBe("request canceled");
    expect(run.progress.failed).toBe(1);
  });

  it("defaults subagent thinking one level below the launching session", async () => {
    const seen: Array<any> = [];
    vi.spyOn(WorkflowAgent.prototype, "run").mockImplementation(async (call) => {
      seen.push(call.options);
      return await writeMockAgentResult(call, `result ${seen.length}`, 10);
    });

    const result = await runner().launchOrRun({
      toolCallId: "thinking-default-test",
      input: {
        mode: "await",
        maxAgents: 5,
        script: `export const meta = { name: 'thinking_defaults', description: 'checks thinking defaults' };
await agent('default thinking', { label: 'default' });
await agent('explicit thinking', { label: 'explicit', thinking: 'xhigh' });
await agent('legacy suffix thinking', { label: 'suffix', model: 'sonnet:high' });
return 'done';
`,
      },
      ctx: { ...workflowCtx(), getThinkingLevel: () => "high" },
    });

    expect(result.status).toBe("completed");
    expect(seen.map((opts) => opts.thinking)).toEqual(["medium", "xhigh", undefined]);
  });

  it("inherits the launching model and applies explicit per-agent overrides", async () => {
    const seen: Array<any> = [];
    vi.spyOn(WorkflowAgent.prototype, "run").mockImplementation(async (call) => {
      seen.push(call.options);
      return await writeMockAgentResult(call, `result ${seen.length}`, 10);
    });

    const result = await runner().launchOrRun({
      toolCallId: "model-default-test",
      input: {
        mode: "await",
        maxAgents: 2,
        script: `export const meta = { name: 'model_defaults', description: 'checks model defaults' };
await agent('inherited model');
await agent('explicit model', { model: 'anthropic/claude-sonnet-4-5' });
return 'done';
`,
      },
      ctx: { ...workflowCtx(), model: { provider: "openai-codex", id: "gpt-5.4" } },
    });

    expect(result.status).toBe("completed");
    expect(seen.map((opts) => opts.model)).toEqual(["openai-codex/gpt-5.4", "anthropic/claude-sonnet-4-5"]);
  });

  it("does not treat exact registered model ids ending in a thinking suffix as legacy suffixes", async () => {
    const seen: Array<any> = [];
    vi.spyOn(WorkflowAgent.prototype, "run").mockImplementation(async (call) => {
      seen.push(call.options);
      return await writeMockAgentResult(call, `result ${seen.length}`, 10);
    });

    const result = await runner().launchOrRun({
      toolCallId: "thinking-exact-model-test",
      input: {
        mode: "await",
        maxAgents: 5,
        script: `export const meta = { name: 'thinking_exact_models', description: 'checks exact model suffix handling' };
await agent('bare exact model', { label: 'bare', model: 'sonnet:high' });
await agent('canonical exact model', { label: 'canonical', model: 'local/sonnet:high' });
await agent('legacy suffix', { label: 'suffix', model: 'other:high' });
await agent('explicit thinking', { label: 'explicit', model: 'sonnet:high', thinking: 'xhigh' });
return 'done';
`,
      },
      ctx: {
        ...workflowCtx(),
        getThinkingLevel: () => "high",
        modelRegistry: { getAll: () => [{ provider: "local", id: "sonnet:high" }, { provider: "local", id: "other" }] },
      },
    });

    expect(result.status).toBe("completed");
    expect(seen.map((opts) => opts.model)).toEqual(["sonnet:high", "local/sonnet:high", "other:high", "sonnet:high"]);
    expect(seen.map((opts) => opts.thinking)).toEqual(["medium", "medium", undefined, "xhigh"]);
  });

  it("rejects invalid subagent thinking levels before launching an agent", async () => {
    const runSpy = vi.spyOn(WorkflowAgent.prototype, "run").mockImplementation(async (call) => await writeMockAgentResult(call, "unexpected", 1));

    const result = await runner().launchOrRun({
      toolCallId: "thinking-invalid-test",
      input: {
        mode: "await",
        script: `export const meta = { name: 'bad_thinking', description: 'invalid thinking option' };
return await agent('bad', { thinking: 'ultra' });
`,
      },
      ctx: workflowCtx(),
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/opts\.thinking/);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("shares the parent max-agent cap with child workflows", async () => {
    const childPath = path.join(cwd, "child-two-agents.js");
    await fs.promises.writeFile(childPath, `export const meta = { name: 'child_two_agents', description: 'uses two agents' };
await agent('child one', { label: 'child one' });
await agent('child two', { label: 'child two' });
return 'child done';
`, "utf8");

    let calls = 0;
    vi.spyOn(WorkflowAgent.prototype, "run").mockImplementation(async (call) => {
      calls++;
      return await writeMockAgentResult(call, `result ${calls}`, 10);
    });

    const result = await runner().launchOrRun({
      toolCallId: "child-agent-cap-test",
      input: {
        mode: "await",
        maxAgents: 1,
        args: { childPath },
        script: `export const meta = { name: 'parent_agent_cap', description: 'delegates to child' };
return await workflow({ scriptPath: args.childPath });
`,
      },
      ctx: workflowCtx(),
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/agent cap exceeded/i);
    expect(calls).toBe(1);
    expect(result.usage).toEqual(expect.objectContaining({ agentCount: 1, subagentTokens: 10 }));
  });

  it("shares parent token budget with child workflows and reports child usage on failure", async () => {
    const childPath = path.join(cwd, "child-expensive-agent.js");
    await fs.promises.writeFile(childPath, `export const meta = { name: 'child_expensive_agent', description: 'uses budget' };
if (budget.remaining() !== 70) throw new Error('child saw wrong remaining budget: ' + budget.remaining());
return await agent('child expensive', { label: 'child expensive' });
`, "utf8");

    const tokenUsage = [30, 80];
    let calls = 0;
    vi.spyOn(WorkflowAgent.prototype, "run").mockImplementation(async (call) => {
      const tokens = tokenUsage[calls++] ?? 1;
      return await writeMockAgentResult(call, `used ${tokens}`, tokens);
    });

    const result = await runner().launchOrRun({
      toolCallId: "child-budget-test",
      input: {
        mode: "await",
        budgetTokens: 100,
        maxAgents: 5,
        args: { childPath },
        script: `export const meta = { name: 'parent_budget', description: 'delegates to child after spending' };
await agent('parent warmup', { label: 'parent warmup' });
return await workflow({ scriptPath: args.childPath });
`,
      },
      ctx: workflowCtx(),
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/budget exhausted/i);
    expect(result.error).toContain("110/100");
    expect(calls).toBe(2);
    expect(result.usage).toEqual(expect.objectContaining({ agentCount: 2, subagentTokens: 110 }));
  });
});

function runner(): WorkflowRunner {
  return new WorkflowRunner({ pi: { getActiveTools: () => [] } as any, runStore: new RunStore(), registry: new WorkflowRegistry() });
}

function workflowCtx(): any {
  return { cwd, hasUI: false, sessionManager: { getSessionId: () => "test-session" } };
}

function makeRun(name: string): RunRecord {
  const runId = `wr_${name}`;
  const runDir = path.join(tmp, runId);
  return {
    runId,
    taskId: "task",
    sessionId: "session",
    name,
    description: "test",
    status: "running",
    scriptPath: path.join(runDir, "script.js"),
    runDir,
    journalPath: path.join(runDir, "journal.jsonl"),
    logsPath: path.join(runDir, "logs.jsonl"),
    manifestPath: path.join(runDir, "manifest.json"),
    argsPath: path.join(runDir, "args.json"),
    transcriptDir: path.join(runDir, "subagents"),
    startedAt: new Date(0).toISOString(),
    argsHash: "sha256:args",
    scriptHash: "sha256:script",
    progress: { total: 0, running: 0, completed: 0, failed: 0, skipped: 0, calls: [], recentLogs: [], updatedAt: new Date(0).toISOString() },
    usage: { agentCount: 0, subagentTokens: 0, toolUses: 0, estimated: true },
  };
}

function callPromiseById(run: RunRecord, calls: Promise<unknown>[], callId: string): Promise<unknown> {
  const call = run.progress.calls.find((entry) => entry.callId === callId);
  if (!call) throw new Error(`unknown call id ${callId}`);
  const index = callIndexById(run, callId);
  const promise = calls[index];
  if (!promise) throw new Error(`missing promise for call id ${callId}`);
  return promise;
}

function callIndexById(run: RunRecord, callId: string): number {
  const call = run.progress.calls.find((entry) => entry.callId === callId);
  if (!call) throw new Error(`unknown call id ${callId}`);
  return Number(String(call.label).replace(/^agent /, ""));
}

async function settleOrAbort<T>(promise: Promise<T>, controller: AbortController, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error("test timeout"));
          reject(new Error(`workflow did not settle within ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(predicate: () => boolean, message: string, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function writeMockAgentResult(call: any, result: unknown, subagentTokens: number): Promise<any> {
  const callDir = path.join(call.transcriptDir, call.callId);
  await fs.promises.mkdir(callDir, { recursive: true });
  const resultPath = path.join(callDir, "result.json");
  const usage = { agentCount: 1, subagentTokens, toolUses: 0, estimated: false };
  await fs.promises.writeFile(resultPath, `${JSON.stringify({ status: "done", result, usage, model: "mock" })}\n`, "utf8");
  return { result, resultText: String(result), transcriptPath: path.join(callDir, "transcript.json"), resultPath, usage, model: "mock" };
}
