import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeWorkflowCommand } from "../src/commands/workflow-command.js";
import { WORKFLOW_RESOURCE_LIMITS } from "../src/constants.js";
import { workflowFilePath } from "../src/persistence/paths.js";
import { WorkflowRegistry } from "../src/persistence/registry.js";
import { RunStore } from "../src/persistence/run-store.js";
import { WorkflowViewRenderer } from "../src/ui/workflow-view-renderer.js";

const meta = { name: "x", description: "test workflow" };
const source = "export const meta = { name: 'x', description: 'test workflow' };\nreturn 'ok';\n";

let oldAgentDir: string | undefined;
let tmp: string;

beforeEach(async () => {
  oldAgentDir = process.env.PI_AGENT_DIR;
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflows-command-"));
  process.env.PI_AGENT_DIR = path.join(tmp, "agent");
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (oldAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = oldAgentDir;
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("/workflow command routing", () => {
  it("routes activation commands directly", async () => {
    const activation = {
      enable: vi.fn(),
      disable: vi.fn(),
      toggle: vi.fn(),
      report: vi.fn(),
    };
    const deps = makeDeps(new RunStore(), activation);
    const ctx = { cwd: path.join(tmp, "project"), hasUI: false };

    await routeWorkflowCommand({} as any, { action: "enable" }, deps, ctx);
    await routeWorkflowCommand({} as any, { action: "disable" }, deps, ctx);
    await routeWorkflowCommand({} as any, { action: "toggle" }, deps, ctx);
    await routeWorkflowCommand({} as any, { action: "status" }, deps, ctx);

    expect(activation.enable).toHaveBeenCalledWith(ctx);
    expect(activation.disable).toHaveBeenCalledWith(ctx);
    expect(activation.toggle).toHaveBeenCalledWith(ctx);
    expect(activation.report).toHaveBeenCalledWith(ctx);
  });

  it("routes manager to UI widgets and list to text output", async () => {
    const cwd = await makeCwd();
    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: {} });
    await runStore.setStatus(record.runId, "completed", { outputPath: path.join(record.runDir, "output.json") });
    const activation = { updateStatus: vi.fn() };
    const deps = makeDeps(runStore, activation);
    const widgetCalls: Array<{ key: string; value: unknown; options?: { placement?: string } }> = [];

    await routeWorkflowCommand({} as any, { action: "manager" }, deps, uiCtx(cwd, "manager-session", widgetCalls));

    expect(activation.updateStatus).toHaveBeenCalled();
    expect(widgetCalls.some((call) => call.key.startsWith("workflow:command-preview:") && call.value !== undefined && call.options?.placement === "aboveEditor")).toBe(true);

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await routeWorkflowCommand({} as any, { action: "list", filter: "all" }, deps, noUiCtx(cwd));

    expect(activation.updateStatus).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(record.runId));
  });

  it("routes run and resume through the workflow runner", async () => {
    const cwd = await makeCwd();
    const scriptPath = path.join(cwd, "route-workflow.js");
    await fs.promises.writeFile(scriptPath, source, "utf8");
    const runStore = new RunStore();
    const deps = makeDeps(runStore);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await routeWorkflowCommand({ getActiveTools: () => [] } as any, { action: "run", target: scriptPath, args: { q: "x" }, mode: "await" }, deps, noUiCtx(cwd));

    const first = runStore.list("completed")[0];
    expect(first?.status).toBe("completed");
    expect(first?.argsHash).toBeTruthy();

    await routeWorkflowCommand({ getActiveTools: () => [] } as any, { action: "resume", runId: first.runId, mode: "await" }, deps, noUiCtx(cwd));

    expect(runStore.list("completed").some((run) => run.resumeFromRunId === first.runId)).toBe(true);
  });

  it("routes live controls and skip-agent", async () => {
    const cwd = await makeCwd();
    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: {} });
    const control = {
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      skipAgent: vi.fn(() => true),
    };
    runStore.registerControl(record.runId, control);
    const deps = makeDeps(runStore);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await routeWorkflowCommand({} as any, { action: "pause", runId: record.runId }, deps, noUiCtx(cwd));
    expect(control.pause).toHaveBeenCalledOnce();
    expect(runStore.get(record.runId)?.status).toBe("paused");

    await routeWorkflowCommand({} as any, { action: "continue", runId: record.runId }, deps, noUiCtx(cwd));
    expect(control.resume).toHaveBeenCalledOnce();
    expect(runStore.get(record.runId)?.status).toBe("running");

    await routeWorkflowCommand({} as any, { action: "skip-agent", runId: record.runId, callId: "agent-1" }, deps, noUiCtx(cwd));
    expect(control.skipAgent).toHaveBeenCalledWith("agent-1");

    await routeWorkflowCommand({} as any, { action: "stop", runId: record.runId }, deps, noUiCtx(cwd));
    expect(control.stop).toHaveBeenCalledWith("stopped by /workflow stop");
  });

  it("routes artifact and UI opening to text or widget surfaces", async () => {
    const cwd = await makeCwd();
    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: {} });
    record.outputPath = path.join(record.runDir, "output.json");
    await fs.promises.writeFile(record.outputPath, "result text", "utf8");
    await fs.promises.mkdir(path.join(record.transcriptDir, "agent-1"), { recursive: true });
    await attachUiView(record, "main", "hello from ui");
    await runStore.setStatus(record.runId, "completed", { outputPath: record.outputPath, uiViews: record.uiViews });
    const deps = makeDeps(runStore);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await routeWorkflowCommand({} as any, { action: "open", runId: record.runId, target: "result" }, deps, noUiCtx(cwd));
    await routeWorkflowCommand({} as any, { action: "open", runId: record.runId, target: "script" }, deps, noUiCtx(cwd));
    await routeWorkflowCommand({} as any, { action: "open", runId: record.runId, target: "journal" }, deps, noUiCtx(cwd));
    await routeWorkflowCommand({} as any, { action: "open", runId: record.runId, target: "transcripts" }, deps, noUiCtx(cwd));

    expect(log).toHaveBeenCalledWith("result text");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("export const meta"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("agent-1"));

    const widgetCalls: Array<{ key: string; value: unknown; options?: { placement?: string } }> = [];
    await routeWorkflowCommand({} as any, { action: "open", runId: record.runId, target: "ui", viewId: "main", width: 60 }, deps, uiCtx(cwd, "open-session", widgetCalls));

    expect(widgetCalls.some((call) => call.value !== undefined && JSON.stringify(call.value).includes("hello from ui"))).toBe(true);
  });

  it("surfaces missing artifact read errors", async () => {
    const cwd = await makeCwd();
    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: {} });
    await fs.promises.rm(record.scriptPath, { force: true });
    const deps = makeDeps(runStore);

    await expect(routeWorkflowCommand({} as any, { action: "open", runId: record.runId, target: "script" }, deps, noUiCtx(cwd))).rejects.toThrow(/ENOENT|no such file/i);
  });

  it("routes delete through RunStore and removes the run directory", async () => {
    const cwd = await makeCwd();
    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: {} });
    const control = { pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), skipAgent: vi.fn(() => false) };
    runStore.registerControl(record.runId, control);
    const deps = makeDeps(runStore);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await routeWorkflowCommand({} as any, { action: "delete", runId: record.runId }, deps, noUiCtx(cwd));

    expect(control.stop).toHaveBeenCalledWith("deleted");
    expect(runStore.get(record.runId)).toBeUndefined();
    await expect(fs.promises.stat(record.runDir)).rejects.toThrow(/ENOENT|no such file/i);
  });
});

describe("/workflow save", () => {
  it("refuses to overwrite an existing workflow file", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });

    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: {} });
    const target = workflowFilePath("project", cwd, record.name);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, "existing workflow", "utf8");

    await expect(
      routeWorkflowCommand(
        {} as any,
        { action: "save", runId: record.runId, scope: "project" },
        { runStore, registry: new WorkflowRegistry(), renderer: new WorkflowViewRenderer(), activation: {} as any },
        { cwd, hasUI: false },
      ),
    ).rejects.toThrow(/already exists/);

    await expect(fs.promises.readFile(target, "utf8")).resolves.toBe("existing workflow");
  });
});

describe("/workflow resume", () => {
  it("surfaces corrupt persisted args instead of silently resuming with empty args", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });

    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: { keep: true } });
    await fs.promises.writeFile(record.argsPath, "{", "utf8");

    await expect(
      routeWorkflowCommand(
        {} as any,
        { action: "resume", runId: record.runId },
        { runStore, registry: new WorkflowRegistry(), renderer: new WorkflowViewRenderer(), activation: {} as any },
        { cwd, hasUI: false },
      ),
    ).rejects.toThrow(/JSON|Unexpected|position/);
  });

  it("surfaces oversized persisted args instead of reading them", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });

    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: { keep: true } });
    await fs.promises.truncate(record.argsPath, WORKFLOW_RESOURCE_LIMITS.runArgsBytes + 1);

    await expect(
      routeWorkflowCommand(
        {} as any,
        { action: "resume", runId: record.runId },
        { runStore, registry: new WorkflowRegistry(), renderer: new WorkflowViewRenderer(), activation: {} as any },
        { cwd, hasUI: false },
      ),
    ).rejects.toThrow(/exceeds/);
  });

  it("surfaces persisted args read errors instead of resuming with empty args", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });

    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: { keep: true } });
    await fs.promises.rm(record.argsPath, { force: true });
    await fs.promises.mkdir(record.argsPath);

    await expect(
      routeWorkflowCommand(
        {} as any,
        { action: "resume", runId: record.runId },
        { runStore, registry: new WorkflowRegistry(), renderer: new WorkflowViewRenderer(), activation: {} as any },
        { cwd, hasUI: false },
      ),
    ).rejects.toThrow(/unsafe file|EISDIR|directory|illegal operation/i);
  });

  it("rejects persisted args that are not a JSON object", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });

    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: { keep: true } });
    await fs.promises.writeFile(record.argsPath, "[]", "utf8");

    await expect(
      routeWorkflowCommand(
        {} as any,
        { action: "resume", runId: record.runId },
        { runStore, registry: new WorkflowRegistry(), renderer: new WorkflowViewRenderer(), activation: {} as any },
        { cwd, hasUI: false },
      ),
    ).rejects.toThrow(/JSON object/);
  });
});

describe("/workflow command preview widgets", () => {
  it("clears preview widgets independently per UI session", async () => {
    vi.useFakeTimers();
    try {
      const deps = { runStore: new RunStore(), registry: new WorkflowRegistry(), renderer: new WorkflowViewRenderer(), activation: {} as any };
      const callsA: Array<{ key: string; value: unknown; options?: { placement?: string } }> = [];
      const callsB: Array<{ key: string; value: unknown; options?: { placement?: string } }> = [];
      const ctxA = previewCtx("session-a", callsA);
      const ctxB = previewCtx("session-b", callsB);

      await routeWorkflowCommand({} as any, { action: "preview-ui", json: '{"title":"A","metrics":[{"label":"x","value":1}]}' }, deps, ctxA);
      await routeWorkflowCommand({} as any, { action: "preview-ui", json: '{"title":"B","metrics":[{"label":"y","value":2}]}' }, deps, ctxB);

      expect(callsA).toHaveLength(1);
      expect(callsB).toHaveLength(1);
      expect(callsA[0].key).not.toBe(callsB[0].key);
      expect(callsA[0].value).not.toBeUndefined();
      expect(callsB[0].value).not.toBeUndefined();

      await vi.advanceTimersByTimeAsync(30_000);

      expect(callsA).toContainEqual(expect.objectContaining({ key: callsA[0].key, value: undefined }));
      expect(callsB).toContainEqual(expect.objectContaining({ key: callsB[0].key, value: undefined }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to UI object identity when no session id is available", async () => {
    vi.useFakeTimers();
    try {
      const deps = { runStore: new RunStore(), registry: new WorkflowRegistry(), renderer: new WorkflowViewRenderer(), activation: {} as any };
      const callsA: Array<{ key: string; value: unknown; options?: { placement?: string } }> = [];
      const callsB: Array<{ key: string; value: unknown; options?: { placement?: string } }> = [];

      await routeWorkflowCommand({} as any, { action: "preview-ui", json: '{"title":"A"}' }, deps, previewCtx(undefined, callsA));
      await routeWorkflowCommand({} as any, { action: "preview-ui", json: '{"title":"B"}' }, deps, previewCtx(undefined, callsB));

      expect(callsA[0].key).not.toBe(callsB[0].key);

      await vi.advanceTimersByTimeAsync(30_000);

      expect(callsA).toContainEqual(expect.objectContaining({ key: callsA[0].key, value: undefined }));
      expect(callsB).toContainEqual(expect.objectContaining({ key: callsB[0].key, value: undefined }));
    } finally {
      vi.useRealTimers();
    }
  });
});

function makeDeps(runStore = new RunStore(), activation: Record<string, unknown> = {}): { runStore: RunStore; registry: WorkflowRegistry; renderer: WorkflowViewRenderer; activation: any } {
  return {
    runStore,
    registry: new WorkflowRegistry(),
    renderer: new WorkflowViewRenderer(),
    activation: {
      enable: () => undefined,
      disable: () => undefined,
      toggle: () => undefined,
      report: () => undefined,
      updateStatus: () => undefined,
      ...activation,
    },
  };
}

async function makeCwd(): Promise<string> {
  const cwd = path.join(tmp, "project");
  await fs.promises.mkdir(cwd, { recursive: true });
  return cwd;
}

function noUiCtx(cwd: string): any {
  return { cwd, hasUI: false, sessionManager: { getSessionId: () => "test-session" } };
}

function uiCtx(cwd: string, sessionId: string | undefined, calls: Array<{ key: string; value: unknown; options?: { placement?: string } }>): any {
  return { cwd, ...previewCtx(sessionId, calls) };
}

async function attachUiView(record: any, viewId: string, message: string): Promise<void> {
  const viewDir = path.join(record.runDir, "ui", viewId);
  await fs.promises.mkdir(viewDir, { recursive: true });
  const specPath = path.join(viewDir, "spec.json");
  const latestStatePath = path.join(viewDir, "state-latest.json");
  await fs.promises.writeFile(
    specPath,
    `${JSON.stringify(
      {
        version: 1,
        id: viewId,
        title: "Main view",
        initialState: { message },
        layout: { type: "markdown", bind: "/message" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.promises.writeFile(latestStatePath, `${JSON.stringify({ message }, null, 2)}\n`, "utf8");
  record.uiViews.push({ viewId, title: "Main view", specPath, latestStatePath });
}

function previewCtx(sessionId: string | undefined, calls: Array<{ key: string; value: unknown; options?: { placement?: string } }>): any {
  return {
    hasUI: true,
    ...(sessionId ? { sessionManager: { getSessionId: () => sessionId } } : {}),
    ui: {
      setWidget: (key: string, value: unknown, options?: { placement?: string }) => calls.push({ key, value, options }),
      notify: () => undefined,
    },
  };
}
