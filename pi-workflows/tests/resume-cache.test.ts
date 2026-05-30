import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowAgent } from "../src/agents/workflow-agent.js";
import { JsonlJournal, ResumeIndex } from "../src/persistence/journal.js";
import { WorkflowBudget } from "../src/runtime/budget.js";
import { RunControl } from "../src/runtime/run-control.js";
import { WorkflowScheduler } from "../src/runtime/scheduler.js";
import type { RunRecord } from "../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workflow resume cache", () => {
  it("indexes cached journal entries", async () => {
    const runDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-resume-index-"));
    const resultPath = path.join(runDir, "subagents", "0001", "result.json");
    const usage = { agentCount: 1, subagentTokens: 1234, toolUses: 2, durationMs: 5000, estimated: false };
    await fs.promises.mkdir(path.dirname(resultPath), { recursive: true });
    await fs.promises.writeFile(resultPath, `${JSON.stringify({ status: "done", result: { ok: true }, usage, model: "opus-test" })}\n`, "utf8");

    const journalPath = path.join(runDir, "journal.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.append({
      type: "agent_result",
      runId: "wr_source",
      time: new Date(0).toISOString(),
      callId: "0001",
      chainKey: "chain",
      status: "cached",
      resultPath: "subagents/0001/result.json",
    });

    const index = await ResumeIndex.fromRun(runDir, journalPath);
    const replay = await index.load("chain");
    expect(replay?.value).toEqual({ ok: true });
    expect(replay?.status).toBe("cached");
    expect(replay?.sourcePath).toBe(resultPath);
    expect(replay?.usage).toEqual(usage);
    expect(replay?.model).toBe("opus-test");
  });

  it("materializes replayed cached results into the new run", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-resume-materialize-"));
    const sourcePath = path.join(root, "source-result.json");
    const usage = { agentCount: 1, subagentTokens: 48700, toolUses: 9, durationMs: 28_000, estimated: false };
    await fs.promises.writeFile(sourcePath, `${JSON.stringify({ status: "done", result: { cached: true }, usage, model: "opus-test" })}\n`, "utf8");

    const run = makeRun(root);
    await fs.promises.mkdir(run.transcriptDir, { recursive: true });
    const journal = new JsonlJournal(run.journalPath);
    const scheduler = new WorkflowScheduler({
      cwd: root,
      run,
      journal,
      control: new RunControl(),
      budget: new WorkflowBudget(null),
      resumeIndex: {
        canReplay: () => true,
        load: async () => ({ value: { cached: true }, sourcePath, status: "done", usage, model: "opus-test" }),
      } as any,
      maxAgents: 10,
      persist: async () => {},
    });

    await expect(scheduler.agentCall("use cached result", { label: "cached" })).resolves.toEqual({ cached: true });

    const materializedPath = path.join(run.transcriptDir, "0001", "result.json");
    await expect(fs.promises.readFile(materializedPath, "utf8").then(JSON.parse)).resolves.toEqual({ status: "done", result: { cached: true }, usage, model: "opus-test" });

    const events = await journal.readAll();
    expect(events).toEqual([
      expect.objectContaining({
        type: "agent_result",
        status: "cached",
        resultPath: "subagents/0001/result.json",
        usage,
        model: "opus-test",
      }),
    ]);
    expect(run.progress.calls[0]).toEqual(expect.objectContaining({ status: "cached", cached: true, resultPath: materializedPath, usage, model: "opus-test" }));
    expect(run.usage.subagentTokens).toBe(0);
  });

  it("stores live per-agent usage on progress and in the journal", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-live-usage-"));
    const run = makeRun(root);
    await fs.promises.mkdir(run.transcriptDir, { recursive: true });
    const journal = new JsonlJournal(run.journalPath);
    const usage = { agentCount: 1, subagentTokens: 48_700, toolUses: 9, estimated: false };

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
      persist: async () => {},
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

    const events = await journal.readAll();
    expect(events.find((event) => event.type === "agent_result")).toEqual(expect.objectContaining({
      usage: expect.objectContaining({ agentCount: 1, subagentTokens: 48_700, toolUses: 9 }),
      model: "opus-test",
    }));
  });

  it("keeps agent replay keys stable across script and args hash changes", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-resume-key-stability-"));
    const sourcePath = path.join(root, "source-result.json");
    await fs.promises.writeFile(sourcePath, `${JSON.stringify({ status: "done", result: { cached: true } })}\n`, "utf8");

    const keyA = await replayKeyForRun(
      makeRun(path.join(root, "a"), {
        runId: "wr_a",
        argsHash: "sha256:args-a",
        scriptHash: "sha256:script-a",
      }),
      sourcePath,
    );
    const keyB = await replayKeyForRun(
      makeRun(path.join(root, "b"), {
        runId: "wr_b",
        argsHash: "sha256:args-b",
        scriptHash: "sha256:script-b",
      }),
      sourcePath,
    );

    expect(keyA).toBe(keyB);
    expect(keyA).toMatch(/^v3:/);
  });

  it("disables later replay after the first chain miss", async () => {
    const runDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-resume-disable-"));
    const resultPath = path.join(runDir, "subagents", "0002", "result.json");
    await fs.promises.mkdir(path.dirname(resultPath), { recursive: true });
    await fs.promises.writeFile(resultPath, `${JSON.stringify({ status: "done", result: "later" })}\n`, "utf8");

    const journalPath = path.join(runDir, "journal.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.append({
      type: "agent_result",
      runId: "wr_source",
      time: new Date(0).toISOString(),
      callId: "0002",
      chainKey: "later-chain",
      status: "done",
      resultPath: "subagents/0002/result.json",
    });

    const index = await ResumeIndex.fromRun(runDir, journalPath);
    expect(index.canReplay("later-chain")).toBe(true);
    expect(index.canReplay("changed-first-chain")).toBe(false);
    index.disableAfterFirstMiss();
    expect(index.canReplay("later-chain")).toBe(false);
  });
});

async function replayKeyForRun(run: RunRecord, sourcePath: string): Promise<string> {
  const keys: string[] = [];
  const journal = new JsonlJournal(run.journalPath);
  const scheduler = new WorkflowScheduler({
    cwd: path.dirname(run.runDir),
    run,
    journal,
    control: new RunControl(),
    budget: new WorkflowBudget(null),
    resumeIndex: {
      canReplay: (chainKey: string) => {
        keys.push(chainKey);
        return true;
      },
      load: async () => ({ value: { cached: true }, sourcePath, status: "done" }),
    } as any,
    maxAgents: 10,
    activeTools: ["workflow", "read", "bash"],
    persist: async () => {},
  });

  await expect(scheduler.agentCall("use cached result", { label: "cached", isolation: "shared" })).resolves.toEqual({ cached: true });
  expect(keys).toHaveLength(1);
  return keys[0]!;
}

function makeRun(root: string, overrides: Partial<RunRecord> = {}): RunRecord {
  const runId = overrides.runId ?? "wr_target";
  const runDir = path.join(root, runId);
  return {
    runId,
    taskId: "task",
    sessionId: "session",
    name: "resume_test",
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
    progress: { total: 0, running: 0, completed: 0, failed: 0, cached: 0, skipped: 0, calls: [], recentLogs: [], updatedAt: new Date(0).toISOString() },
    usage: { agentCount: 0, subagentTokens: 0, toolUses: 0, estimated: true },
    uiViews: [],
    ...overrides,
  };
}
