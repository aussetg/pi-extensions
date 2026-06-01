import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowAgent } from "../src/agents/workflow-agent.js";
import { WORKFLOW_AGENT_OPTION_LIMITS } from "../src/constants.js";
import { JsonlJournal } from "../src/persistence/journal.js";
import type { RunRecord } from "../src/types.js";
import { WorkflowBudget } from "../src/runtime/budget.js";
import { normalizeAgentOptions } from "../src/runtime/agent-options.js";
import { RunControl } from "../src/runtime/run-control.js";
import { WorkflowScheduler } from "../src/runtime/scheduler.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-agent-options-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("workflow agent option validation", () => {
  it("returns a canonical copy of valid options", () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

    expect(normalizeAgentOptions({
      label: "scan",
      phase: "Review",
      model: "sonnet",
      thinking: "low",
      isolation: "worktree",
      agentType: "reviewer",
      stallMs: 10_000,
      schema,
    })).toEqual({
      label: "scan",
      phase: "Review",
      model: "sonnet",
      thinking: "low",
      isolation: "worktree",
      agentType: "reviewer",
      stallMs: 10_000,
      schema,
    });
  });

  it("rejects unknown, accessor, and symbol option keys", () => {
    expect(() => normalizeAgentOptions({ tools: ["bash"] })).toThrow(/opts\.tools.*not supported/);

    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "label", {
      enumerable: true,
      get() {
        throw new Error("getter should not run");
      },
    });
    expect(() => normalizeAgentOptions(accessor)).toThrow(/opts\.label.*data property/);

    const symbolKey: Record<PropertyKey, unknown> = { label: "ok" };
    symbolKey[Symbol("x")] = true;
    expect(() => normalizeAgentOptions(symbolKey)).toThrow(/symbol keys/);
  });

  it("rejects invalid scalar option values", () => {
    expect(() => normalizeAgentOptions(null)).toThrow(/options must be an object/);
    expect(() => normalizeAgentOptions([])).toThrow(/options must be an object/);
    expect(() => normalizeAgentOptions({ thinking: "ultra" })).toThrow(/opts\.thinking/);
    expect(() => normalizeAgentOptions({ isolation: "sandbox" })).toThrow(/opts\.isolation/);
    expect(() => normalizeAgentOptions({ label: undefined })).toThrow(/opts\.label.*undefined/);
    expect(() => normalizeAgentOptions({ label: "" })).toThrow(/opts\.label.*non-empty/);
    expect(() => normalizeAgentOptions({ phase: "A\nB" })).toThrow(/opts\.phase.*control/);
    expect(() => normalizeAgentOptions({ model: 12 })).toThrow(/opts\.model.*string/);
    expect(() => normalizeAgentOptions({ agentType: "x".repeat(WORKFLOW_AGENT_OPTION_LIMITS.agentTypeBytes + 1) })).toThrow(/opts\.agentType.*exceeds/);
    expect(() => normalizeAgentOptions({ stallMs: 0 })).toThrow(/opts\.stallMs/);
    expect(() => normalizeAgentOptions({ stallMs: 1.5 })).toThrow(/opts\.stallMs/);
    expect(() => normalizeAgentOptions({ stallMs: WORKFLOW_AGENT_OPTION_LIMITS.stallMsMax + 1 })).toThrow(/opts\.stallMs/);
  });

  it("rejects non-JSON or oversized schema values", () => {
    expect(() => normalizeAgentOptions({ schema: [] })).toThrow(/schema must be a JSON object/);
    expect(() => normalizeAgentOptions({ schema: { ok: undefined } })).toThrow(/JSON-serializable/);
    expect(() => normalizeAgentOptions({ schema: { value: Number.NaN } })).toThrow(/non-finite/);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => normalizeAgentOptions({ schema: cyclic })).toThrow(/cycles/);

    const sparse: unknown[] = [];
    sparse[1] = "x";
    expect(() => normalizeAgentOptions({ schema: { enum: sparse } })).toThrow(/sparse arrays/);

    expect(() => normalizeAgentOptions({ schema: { text: "x".repeat(WORKFLOW_AGENT_OPTION_LIMITS.schemaBytes) } })).toThrow(/schema exceeds/);
  });

  it("rejects invalid options before launching or consuming the agent cap", async () => {
    const run = makeRun(tmp);
    await fs.promises.mkdir(run.transcriptDir, { recursive: true });
    const runSpy = vi.spyOn(WorkflowAgent.prototype, "run").mockImplementation(async (call) => await writeMockAgentResult(call, "ok"));
    const scheduler = new WorkflowScheduler({
      cwd: tmp,
      run,
      journal: new JsonlJournal(run.journalPath),
      control: new RunControl(),
      budget: new WorkflowBudget(null),
      maxAgents: 1,
      persist: async () => {},
    });

    await expect(scheduler.agentCall("bad", { isolation: "mars" })).rejects.toThrow(/opts\.isolation/);
    expect(runSpy).not.toHaveBeenCalled();

    await expect(scheduler.agentCall("good", { label: "good" })).resolves.toBe("ok");
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(run.progress.total).toBe(1);
  });
});

function makeRun(root: string): RunRecord {
  const runId = "wr_agent_options";
  const runDir = path.join(root, runId);
  return {
    runId,
    taskId: "task",
    sessionId: "session",
    name: "agent_options",
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

async function writeMockAgentResult(call: any, result: unknown): Promise<any> {
  const callDir = path.join(call.transcriptDir, call.callId);
  await fs.promises.mkdir(callDir, { recursive: true });
  const resultPath = path.join(callDir, "result.json");
  const usage = { agentCount: 1, subagentTokens: 1, toolUses: 0, estimated: false };
  await fs.promises.writeFile(resultPath, `${JSON.stringify({ status: "done", result, usage, model: "mock" })}\n`, "utf8");
  return { result, resultText: String(result), transcriptPath: path.join(callDir, "transcript.json"), resultPath, usage, model: "mock" };
}
