import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowAgent } from "../src/agents/workflow-agent.js";
import { WORKFLOW_RESOURCE_LIMITS } from "../src/constants.js";
import { JsonlJournal } from "../src/persistence/journal.js";
import { WorkflowBudget } from "../src/runtime/budget.js";
import { RunControl } from "../src/runtime/run-control.js";
import { WorkflowScheduler } from "../src/runtime/scheduler.js";
import type { RunRecord } from "../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workflow journal bounds", () => {
  it("rejects hostile journals that exceed the bounded read limit", async () => {
    const runDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-huge-journal-"));
    const journalPath = path.join(runDir, "journal.jsonl");
    await fs.promises.writeFile(journalPath, "", "utf8");
    await fs.promises.truncate(journalPath, WORKFLOW_RESOURCE_LIMITS.journalBytes + 1);

    await expect(new JsonlJournal(journalPath).readAll()).rejects.toThrow(/exceeds/);
  });

  it("rejects hostile journals with oversized events", async () => {
    const runDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-huge-journal-event-"));
    const journalPath = path.join(runDir, "journal.jsonl");
    await fs.promises.writeFile(journalPath, `${"x".repeat(WORKFLOW_RESOURCE_LIMITS.journalEventBytes + 1)}\n`, "utf8");

    await expect(new JsonlJournal(journalPath).readAll()).rejects.toThrow(/journal event exceeds/i);
  });

  it("rejects hostile journals with too many events", async () => {
    const runDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-many-journal-events-"));
    const journalPath = path.join(runDir, "journal.jsonl");
    const line = `${JSON.stringify({ type: "log", runId: "wr_source", time: new Date(0).toISOString(), message: "" })}\n`;
    await fs.promises.writeFile(journalPath, line.repeat(WORKFLOW_RESOURCE_LIMITS.journalEvents + 1), "utf8");

    await expect(new JsonlJournal(journalPath).readAll()).rejects.toThrow(/event count exceeds/);
  });

  it("rejects oversized journal events", async () => {
    const runDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-journal-limit-"));
    const journal = new JsonlJournal(path.join(runDir, "journal.jsonl"));

    await expect(journal.append({ type: "log", runId: "wr_test", time: new Date(0).toISOString(), message: "x".repeat(WORKFLOW_RESOURCE_LIMITS.journalEventBytes) } as any)).rejects.toThrow(/journal event exceeds/);
  });

  it("serializes quota checks and appends across journal instances", async () => {
    const runDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-journal-serial-"));
    const journalPath = path.join(runDir, "journal.jsonl");
    const event = { type: "log", runId: "wr_test", time: new Date(0).toISOString(), message: "last slot" } as const;
    const eventBytes = Buffer.byteLength(`${JSON.stringify(event)}\n`, "utf8");
    await fs.promises.writeFile(journalPath, "", "utf8");
    await fs.promises.truncate(journalPath, WORKFLOW_RESOURCE_LIMITS.journalBytes - eventBytes);

    const results = await Promise.allSettled([
      new JsonlJournal(journalPath).append(event),
      new JsonlJournal(journalPath).append(event),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await fs.promises.stat(journalPath)).size).toBe(WORKFLOW_RESOURCE_LIMITS.journalBytes);
  });
});

describe("workflow scheduler", () => {
  it("stores live per-agent usage on progress and in the journal", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-live-usage-"));
    const run = makeRun(root);
    await fs.promises.mkdir(run.transcriptDir, { recursive: true });
    const journal = new JsonlJournal(run.journalPath);
    const usage = { agentCount: 1, subagentTokens: 48_700, toolUses: 9, estimated: false };
    const checkpoint = vi.fn();

    vi.spyOn(WorkflowAgent.prototype, "run").mockImplementation(async (call) => {
      const callDir = path.join(call.transcriptDir, call.callId);
      await fs.promises.mkdir(callDir, { recursive: true });
      const resultPath = path.join(callDir, "result.json");
      await fs.promises.writeFile(resultPath, `${JSON.stringify({ status: "done", result: "ok", usage, model: "opus-test" })}\n`, "utf8");
      return { result: "ok", resultText: "ok", transcriptPath: path.join(callDir, "transcript.json"), resultPath, usage, model: "opus-test" };
    });

    const scheduler = new WorkflowScheduler({
      cwd: root,
      run,
      journal,
      control: new RunControl(),
      budget: new WorkflowBudget(null),
      maxAgents: 10,
      checkpoint,
    });

    await expect(scheduler.agentCall("live usage", { label: "agent with usage" })).resolves.toBe("ok");

    expect(run.progress.calls[0]).toEqual(expect.objectContaining({
      status: "done",
      model: "opus-test",
      usage: expect.objectContaining({ agentCount: 1, subagentTokens: 48_700, toolUses: 9, estimated: false }),
    }));
    expect(run.progress.calls[0].usage?.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.usage).toEqual(expect.objectContaining({ agentCount: 1, subagentTokens: 48_700, toolUses: 9, estimated: true }));
    expect(run.usage.durationMs).toBeGreaterThanOrEqual(0);
    expect(checkpoint).toHaveBeenCalledTimes(1);

    const events = await journal.readAll();
    expect(events.find((event) => event.type === "agent_result")).toEqual(expect.objectContaining({
      usage: expect.objectContaining({ agentCount: 1, subagentTokens: 48_700, toolUses: 9 }),
      model: "opus-test",
    }));
  });

  it("treats an empty patch as a one-shot no-op", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-empty-patch-"));
    const run = makeRun(root);
    await fs.promises.mkdir(run.transcriptDir, { recursive: true });
    vi.spyOn(WorkflowAgent.prototype, "run").mockImplementation(async (call) => {
      const result = await writeMockAgentResult(call, "nothing to change", 1);
      return {
        ...result,
        workspace: { kind: "patch", worktreeDir: path.join(root, "removed"), workspaceRoot: root, changedFiles: [] },
      };
    });
    const scheduler = new WorkflowScheduler({
      cwd: root,
      run,
      journal: new JsonlJournal(run.journalPath),
      control: new RunControl(),
      budget: new WorkflowBudget(null),
      maxAgents: 1,
      checkpoint: () => undefined,
    });

    const candidate = await scheduler.agentCall("inspect", { workspace: "patch" }) as any;
    expect(candidate).toEqual({
      result: "nothing to change",
      patch: expect.objectContaining({ kind: "workflow_patch", empty: true, files: [] }),
    });
    await expect(scheduler.applyPatch(candidate.patch)).resolves.toEqual({ applied: false, patchId: candidate.patch.id, files: [] });
    expect(run.progress.recentLogs.at(-1)).toBe("patch 0001 contained no changes");
    await expect(scheduler.applyPatch(candidate.patch)).rejects.toThrow(/already applied/);
  });

  it("serializes budgeted agent starts and rejects queued calls after exhaustion", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-budget-serial-"));
    const run = makeRun(root);
    await fs.promises.mkdir(run.transcriptDir, { recursive: true });
    const journal = new JsonlJournal(run.journalPath);
    let starts = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    vi.spyOn(WorkflowAgent.prototype, "run").mockImplementation(async (call) => {
      starts++;
      if (starts > 1) throw new Error("second agent should not start after budget exhaustion");
      await firstGate;
      return await writeMockAgentResult(call, "one", 10);
    });

    const scheduler = new WorkflowScheduler({
      cwd: root,
      run,
      journal,
      control: new RunControl(),
      budget: new WorkflowBudget(10),
      maxAgents: 10,
      checkpoint: () => undefined,
    });

    const first = scheduler.agentCall("one", { label: "one" });
    const second = scheduler.agentCall("two", { label: "two" });

    await vi.waitFor(() => expect(starts).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(starts).toBe(1);

    releaseFirst();
    await expect(first).resolves.toBe("one");
    await expect(second).rejects.toThrow(/budget exhausted/i);
    expect(starts).toBe(1);
  });

  it("suppresses workflow logs after the log quota", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-log-limit-"));
    const run = makeRun(root);
    await fs.promises.mkdir(run.transcriptDir, { recursive: true });
    await fs.promises.writeFile(run.logsPath, "", "utf8");
    const journal = new JsonlJournal(run.journalPath);
    const scheduler = new WorkflowScheduler({
      cwd: root,
      run,
      journal,
      control: new RunControl(),
      budget: new WorkflowBudget(null),
      maxAgents: 10,
      checkpoint: () => undefined,
    });

    for (let i = 0; i < WORKFLOW_RESOURCE_LIMITS.logEntries + 5; i++) await scheduler.log(`log ${i}`);

    const logLines = (await fs.promises.readFile(run.logsPath, "utf8")).trim().split("\n").filter(Boolean);
    expect(logLines.length).toBeLessThanOrEqual(WORKFLOW_RESOURCE_LIMITS.logEntries + 1);
    expect(run.progress.recentLogs.at(-1)).toContain("workflow log quota reached");
    const events = await journal.readAll();
    expect(events.filter((event) => event.type === "log")).toHaveLength(logLines.length);
  });
});

function makeRun(root: string): RunRecord {
  const runDir = path.join(root, "wr_target");
  return {
    runId: "wr_target",
    taskId: "task",
    sessionId: "session",
    name: "scheduler_test",
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

async function writeMockAgentResult(call: any, result: unknown, subagentTokens: number): Promise<any> {
  const callDir = path.join(call.transcriptDir, call.callId);
  await fs.promises.mkdir(callDir, { recursive: true });
  const resultPath = path.join(callDir, "result.json");
  const usage = { agentCount: 1, subagentTokens, toolUses: 0, estimated: false };
  await fs.promises.writeFile(resultPath, `${JSON.stringify({ status: "done", result, usage, model: "mock" })}\n`, "utf8");
  return { result, resultText: String(result), transcriptPath: path.join(callDir, "transcript.json"), resultPath, usage, model: "mock" };
}
