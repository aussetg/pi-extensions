import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlJournal, ResumeIndex } from "../src/persistence/journal.js";
import { WorkflowBudget } from "../src/runtime/budget.js";
import { RunControl } from "../src/runtime/run-control.js";
import { WorkflowScheduler } from "../src/runtime/scheduler.js";
import type { RunRecord } from "../src/types.js";

describe("workflow resume cache", () => {
  it("indexes cached journal entries", async () => {
    const runDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-resume-index-"));
    const resultPath = path.join(runDir, "subagents", "0001", "result.json");
    await fs.promises.mkdir(path.dirname(resultPath), { recursive: true });
    await fs.promises.writeFile(resultPath, `${JSON.stringify({ status: "done", result: { ok: true } })}\n`, "utf8");

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
  });

  it("materializes replayed cached results into the new run", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-resume-materialize-"));
    const sourcePath = path.join(root, "source-result.json");
    await fs.promises.writeFile(sourcePath, `${JSON.stringify({ status: "done", result: { cached: true } })}\n`, "utf8");

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
        load: async () => ({ value: { cached: true }, sourcePath, status: "done" }),
      } as any,
      maxAgents: 10,
      persist: async () => {},
    });

    await expect(scheduler.agentCall("use cached result", { label: "cached" })).resolves.toEqual({ cached: true });

    const materializedPath = path.join(run.transcriptDir, "0001", "result.json");
    await expect(fs.promises.readFile(materializedPath, "utf8").then(JSON.parse)).resolves.toEqual({ status: "done", result: { cached: true } });

    const events = await journal.readAll();
    expect(events).toEqual([
      expect.objectContaining({
        type: "agent_result",
        status: "cached",
        resultPath: "subagents/0001/result.json",
      }),
    ]);
    expect(run.progress.calls[0]).toEqual(expect.objectContaining({ status: "cached", cached: true, resultPath: materializedPath }));
  });
});

function makeRun(root: string): RunRecord {
  const runDir = path.join(root, "wr_target");
  return {
    runId: "wr_target",
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
  };
}
