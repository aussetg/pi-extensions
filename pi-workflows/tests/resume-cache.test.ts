import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowAgent } from "../src/agents/workflow-agent.js";
import { WORKFLOW_RESOURCE_LIMITS } from "../src/constants.js";
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

  it("skips replay entries with unsafe persisted result paths", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-resume-unsafe-result-path-"));
    const runDir = path.join(root, "source");
    const outsideDir = path.join(root, "outside");
    await fs.promises.mkdir(outsideDir, { recursive: true });
    await fs.promises.writeFile(path.join(outsideDir, "result.json"), `${JSON.stringify({ status: "done", result: "secret" })}\n`, "utf8");

    const journalPath = path.join(runDir, "journal.jsonl");
    const journal = new JsonlJournal(journalPath);
    await journal.append({
      type: "agent_result",
      runId: "wr_source",
      time: new Date(0).toISOString(),
      callId: "0001",
      chainKey: "traversal",
      status: "done",
      resultPath: "../../outside/result.json",
    });
    await journal.append({
      type: "agent_result",
      runId: "wr_source",
      time: new Date(0).toISOString(),
      callId: "0002",
      chainKey: "absolute",
      status: "done",
      resultPath: path.join(outsideDir, "result.json"),
    });

    const index = await ResumeIndex.fromRun(runDir, journalPath);
    expect(index.canReplay("traversal")).toBe(false);
    expect(index.canReplay("absolute")).toBe(false);
    await expect(index.load("traversal")).resolves.toBeUndefined();
    await expect(index.load("absolute")).resolves.toBeUndefined();
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

  it("copies replayed worktree artifacts into the new run and rewrites result paths", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-resume-worktree-artifacts-"));
    const sourceCallDir = path.join(root, "source", "subagents", "0007");
    await fs.promises.mkdir(sourceCallDir, { recursive: true });
    const sourceStatusPath = path.join(sourceCallDir, "worktree-status.txt");
    const sourcePatchPath = path.join(sourceCallDir, "worktree.patch");
    const sourceIgnoredManifestPath = path.join(sourceCallDir, "worktree-ignored.json");
    const sourceIgnoredFilesDir = path.join(sourceCallDir, "worktree-ignored");
    const sourcePath = path.join(sourceCallDir, "result.json");
    await fs.promises.mkdir(path.join(sourceIgnoredFilesDir, "build"), { recursive: true });
    await fs.promises.writeFile(sourceStatusPath, " M changed.txt\n", "utf8");
    await fs.promises.writeFile(sourcePatchPath, "diff --git a/changed.txt b/changed.txt\n", "utf8");
    await fs.promises.writeFile(sourceIgnoredManifestPath, `${JSON.stringify({ version: 1, kind: "worktree_ignored_files", files: [{ path: "build/ignored.txt", type: "file", bytes: 8, artifactPath: "build/ignored.txt" }], omitted: [], totalBytes: 8 })}\n`, "utf8");
    await fs.promises.writeFile(path.join(sourceIgnoredFilesDir, "build", "ignored.txt"), "ignored\n", "utf8");
    await fs.promises.writeFile(sourcePath, `${JSON.stringify({
      status: "done",
      result: { cached: true },
      workspace: {
        kind: "worktree",
        worktreeDir: path.join(sourceCallDir, "worktree"),
        statusPath: sourceStatusPath,
        patchPath: sourcePatchPath,
        ignoredManifestPath: sourceIgnoredManifestPath,
        ignoredFilesDir: sourceIgnoredFilesDir,
      },
    })}\n`, "utf8");

    const run = makeRun(path.join(root, "target"));
    await fs.promises.mkdir(run.transcriptDir, { recursive: true });
    const scheduler = new WorkflowScheduler({
      cwd: root,
      run,
      journal: new JsonlJournal(run.journalPath),
      control: new RunControl(),
      budget: new WorkflowBudget(null),
      resumeIndex: {
        canReplay: () => true,
        load: async () => ({ value: { cached: true }, sourcePath, status: "done" }),
      } as any,
      maxAgents: 10,
      persist: async () => {},
    });

    await expect(scheduler.agentCall("use cached result", { label: "cached" })).resolves.toEqual({ cached: true });

    const targetCallDir = path.join(run.transcriptDir, "0001");
    const materialized = JSON.parse(await fs.promises.readFile(path.join(targetCallDir, "result.json"), "utf8"));
    expect(materialized.workspace).toEqual(expect.objectContaining({
      kind: "worktree",
      worktreeDir: path.join(targetCallDir, "worktree"),
      statusPath: path.join(targetCallDir, "worktree-status.txt"),
      patchPath: path.join(targetCallDir, "worktree.patch"),
      ignoredManifestPath: path.join(targetCallDir, "worktree-ignored.json"),
      ignoredFilesDir: path.join(targetCallDir, "worktree-ignored"),
    }));
    expect(await fs.promises.readFile(materialized.workspace.statusPath, "utf8")).toBe(" M changed.txt\n");
    expect(await fs.promises.readFile(materialized.workspace.patchPath, "utf8")).toContain("diff --git");
    expect(await fs.promises.readFile(materialized.workspace.ignoredManifestPath, "utf8")).toContain("build/ignored.txt");
    expect(await fs.promises.readFile(path.join(materialized.workspace.ignoredFilesDir, "build", "ignored.txt"), "utf8")).toBe("ignored\n");
    expect(JSON.stringify(materialized.workspace)).not.toContain(sourceCallDir);
  });

  it("omits replayed worktree artifacts that point outside the source call directory", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-resume-artifact-escape-"));
    const sourceCallDir = path.join(root, "source", "subagents", "0007");
    const outsideDir = path.join(root, "outside");
    await fs.promises.mkdir(sourceCallDir, { recursive: true });
    await fs.promises.mkdir(outsideDir, { recursive: true });
    await fs.promises.writeFile(path.join(outsideDir, "secret.patch"), "secret\n", "utf8");
    const sourcePath = path.join(sourceCallDir, "result.json");
    await fs.promises.writeFile(sourcePath, `${JSON.stringify({
      status: "done",
      result: { cached: true },
      workspace: {
        kind: "worktree",
        worktreeDir: path.join(sourceCallDir, "worktree"),
        patchPath: "../../outside/secret.patch",
      },
    })}\n`, "utf8");

    const run = makeRun(path.join(root, "target"));
    await fs.promises.mkdir(run.transcriptDir, { recursive: true });
    const scheduler = new WorkflowScheduler({
      cwd: root,
      run,
      journal: new JsonlJournal(run.journalPath),
      control: new RunControl(),
      budget: new WorkflowBudget(null),
      resumeIndex: {
        canReplay: () => true,
        load: async () => ({ value: { cached: true }, sourcePath, status: "done" }),
      } as any,
      maxAgents: 10,
      persist: async () => {},
    });

    await expect(scheduler.agentCall("use cached result", { label: "cached" })).resolves.toEqual({ cached: true });

    const targetCallDir = path.join(run.transcriptDir, "0001");
    const materialized = JSON.parse(await fs.promises.readFile(path.join(targetCallDir, "result.json"), "utf8"));
    expect(materialized.workspace.patchPath).toBeUndefined();
    expect(materialized.workspace.error).toMatch(/patch artifact: unsafe/);
    await expect(fs.promises.stat(path.join(targetCallDir, "worktree.patch"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(materialized.workspace)).not.toContain(outsideDir);
  });

  it("omits replayed worktree artifacts that are symlinks", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-resume-artifact-symlink-"));
    const sourceCallDir = path.join(root, "source", "subagents", "0007");
    const outsideDir = path.join(root, "outside");
    await fs.promises.mkdir(sourceCallDir, { recursive: true });
    await fs.promises.mkdir(outsideDir, { recursive: true });
    const outsidePatch = path.join(outsideDir, "secret.patch");
    const sourcePatchPath = path.join(sourceCallDir, "worktree.patch");
    await fs.promises.writeFile(outsidePatch, "secret\n", "utf8");
    await fs.promises.symlink(outsidePatch, sourcePatchPath);
    const sourcePath = path.join(sourceCallDir, "result.json");
    await fs.promises.writeFile(sourcePath, `${JSON.stringify({
      status: "done",
      result: { cached: true },
      workspace: {
        kind: "worktree",
        worktreeDir: path.join(sourceCallDir, "worktree"),
        patchPath: sourcePatchPath,
      },
    })}\n`, "utf8");

    const run = makeRun(path.join(root, "target"));
    await fs.promises.mkdir(run.transcriptDir, { recursive: true });
    const scheduler = new WorkflowScheduler({
      cwd: root,
      run,
      journal: new JsonlJournal(run.journalPath),
      control: new RunControl(),
      budget: new WorkflowBudget(null),
      resumeIndex: {
        canReplay: () => true,
        load: async () => ({ value: { cached: true }, sourcePath, status: "done" }),
      } as any,
      maxAgents: 10,
      persist: async () => {},
    });

    await expect(scheduler.agentCall("use cached result", { label: "cached" })).resolves.toEqual({ cached: true });

    const targetCallDir = path.join(run.transcriptDir, "0001");
    const materialized = JSON.parse(await fs.promises.readFile(path.join(targetCallDir, "result.json"), "utf8"));
    expect(materialized.workspace.patchPath).toBeUndefined();
    expect(materialized.workspace.error).toMatch(/patch artifact: missing, unsafe, or too large/);
    await expect(fs.promises.stat(path.join(targetCallDir, "worktree.patch"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies replayed ignored artifacts from the manifest only and omits unsafe entries", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-resume-ignored-unsafe-"));
    const sourceCallDir = path.join(root, "source", "subagents", "0007");
    const sourceIgnoredManifestPath = path.join(sourceCallDir, "worktree-ignored.json");
    const sourceIgnoredFilesDir = path.join(sourceCallDir, "worktree-ignored");
    await fs.promises.mkdir(sourceIgnoredFilesDir, { recursive: true });
    await fs.promises.writeFile(sourceIgnoredManifestPath, `${JSON.stringify({
      version: 1,
      kind: "worktree_ignored_files",
      files: [{ path: "build/secret.txt", type: "file", bytes: 7, artifactPath: "../../outside/secret.txt" }],
      omitted: [],
      totalBytes: 7,
    })}\n`, "utf8");
    const sourcePath = path.join(sourceCallDir, "result.json");
    await fs.promises.writeFile(sourcePath, `${JSON.stringify({
      status: "done",
      result: { cached: true },
      workspace: {
        kind: "worktree",
        worktreeDir: path.join(sourceCallDir, "worktree"),
        ignoredManifestPath: sourceIgnoredManifestPath,
        ignoredFilesDir: sourceIgnoredFilesDir,
      },
    })}\n`, "utf8");

    const run = makeRun(path.join(root, "target"));
    await fs.promises.mkdir(run.transcriptDir, { recursive: true });
    const scheduler = new WorkflowScheduler({
      cwd: root,
      run,
      journal: new JsonlJournal(run.journalPath),
      control: new RunControl(),
      budget: new WorkflowBudget(null),
      resumeIndex: {
        canReplay: () => true,
        load: async () => ({ value: { cached: true }, sourcePath, status: "done" }),
      } as any,
      maxAgents: 10,
      persist: async () => {},
    });

    await expect(scheduler.agentCall("use cached result", { label: "cached" })).resolves.toEqual({ cached: true });

    const targetCallDir = path.join(run.transcriptDir, "0001");
    const materialized = JSON.parse(await fs.promises.readFile(path.join(targetCallDir, "result.json"), "utf8"));
    expect(materialized.workspace.ignoredManifestPath).toBe(path.join(targetCallDir, "worktree-ignored.json"));
    expect(materialized.workspace.ignoredFilesDir).toBeUndefined();
    expect(materialized.workspace.error).toMatch(/ignored artifact/);
    const manifest = JSON.parse(await fs.promises.readFile(materialized.workspace.ignoredManifestPath, "utf8"));
    expect(manifest.files).toEqual([]);
    expect(manifest.omitted).toEqual(expect.arrayContaining([expect.objectContaining({ path: "build/secret.txt", reason: "replay unsafe ignored artifact metadata" })]));
    await expect(fs.promises.stat(path.join(targetCallDir, "worktree-ignored", "outside", "secret.txt"))).rejects.toMatchObject({ code: "ENOENT" });
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
      persist: async () => {},
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
    expect(keyA).toMatch(/^v4:/);
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

  it("serializes concurrent replay decisions so the first miss disables later cached results", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-resume-concurrent-miss-"));
    const sourcePath = path.join(root, "source-result.json");
    await fs.promises.writeFile(sourcePath, `${JSON.stringify({ status: "done", result: "cached-later" })}\n`, "utf8");
    const run = makeRun(root);
    await fs.promises.mkdir(run.transcriptDir, { recursive: true });

    vi.spyOn(WorkflowAgent.prototype, "run").mockImplementation(async (call) => {
      return await writeMockAgentResult(call, `live:${call.prompt}`, 1);
    });

    let disabled = false;
    let canReplayCalls = 0;
    let loadCalls = 0;
    const scheduler = new WorkflowScheduler({
      cwd: root,
      run,
      journal: new JsonlJournal(run.journalPath),
      control: new RunControl(),
      budget: new WorkflowBudget(null),
      resumeIndex: {
        canReplay: () => {
          canReplayCalls++;
          return canReplayCalls === 2 && !disabled;
        },
        load: async () => {
          loadCalls++;
          return { value: "cached-later", sourcePath, status: "done" };
        },
        disableAfterFirstMiss: () => {
          disabled = true;
        },
      } as any,
      maxAgents: 10,
      persist: async () => {},
    });

    await expect(Promise.all([
      scheduler.agentCall("changed first", { label: "first" }),
      scheduler.agentCall("later", { label: "later" }),
    ])).resolves.toEqual(["live:changed first", "live:later"]);

    expect(canReplayCalls).toBe(2);
    expect(loadCalls).toBe(0);
    expect(run.progress.cached).toBe(0);
    expect(run.progress.completed).toBe(2);
  });

  it("rejects oversized journal events", async () => {
    const runDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-journal-limit-"));
    const journal = new JsonlJournal(path.join(runDir, "journal.jsonl"));

    await expect(journal.append({ type: "log", runId: "wr_test", time: new Date(0).toISOString(), message: "x".repeat(WORKFLOW_RESOURCE_LIMITS.journalEventBytes) } as any)).rejects.toThrow(/journal event exceeds/);
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
      persist: async () => {},
    });

    for (let i = 0; i < WORKFLOW_RESOURCE_LIMITS.logEntries + 5; i++) await scheduler.log(`log ${i}`);

    const logLines = (await fs.promises.readFile(run.logsPath, "utf8")).trim().split("\n").filter(Boolean);
    expect(logLines.length).toBeLessThanOrEqual(WORKFLOW_RESOURCE_LIMITS.logEntries + 1);
    expect(run.progress.recentLogs.at(-1)).toContain("workflow log quota reached");
    const events = await journal.readAll();
    expect(events.filter((event) => event.type === "log")).toHaveLength(logLines.length);
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

async function writeMockAgentResult(call: any, result: unknown, subagentTokens: number): Promise<any> {
  const callDir = path.join(call.transcriptDir, call.callId);
  await fs.promises.mkdir(callDir, { recursive: true });
  const resultPath = path.join(callDir, "result.json");
  const usage = { agentCount: 1, subagentTokens, toolUses: 0, estimated: false };
  await fs.promises.writeFile(resultPath, `${JSON.stringify({ status: "done", result, usage, model: "mock" })}\n`, "utf8");
  return { result, resultText: String(result), transcriptPath: path.join(callDir, "transcript.json"), resultPath, usage, model: "mock" };
}
