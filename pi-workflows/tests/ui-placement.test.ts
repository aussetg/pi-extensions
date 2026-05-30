import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RENDER_LIMITS } from "../src/constants.js";
import { WorkflowRegistry } from "../src/persistence/registry.js";
import { RunStore } from "../src/persistence/run-store.js";
import { WorkflowRunner } from "../src/runtime/runner.js";
import { visibleWidth } from "../src/utils/truncate.js";

let oldAgentDir: string | undefined;
let tmp: string;

beforeEach(async () => {
  oldAgentDir = process.env.PI_AGENT_DIR;
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflows-ui-placement-"));
  process.env.PI_AGENT_DIR = path.join(tmp, "agent");
});

afterEach(async () => {
  if (oldAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = oldAgentDir;
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("workflow UI placements", () => {
  it("routes runPanel, widget, completion, and artifact views to their intended surfaces", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });
    const widgetCalls: Array<{ key: string; value: unknown; options?: { placement?: string } }> = [];
    const updates: unknown[] = [];
    const ctx = {
      cwd,
      hasUI: true,
      sessionManager: { getSessionId: () => "test-session" },
      ui: {
        setWidget: (key: string, value: unknown, options?: { placement?: string }) => widgetCalls.push({ key, value, options }),
      },
    };
    const runner = new WorkflowRunner({ pi: { getActiveTools: () => [] } as any, runStore: new RunStore(), registry: new WorkflowRegistry() });

    const result = await runner.launchOrRun({
      toolCallId: "ui-placement-test",
      input: { script: placementScript(), mode: "await" },
      ctx,
      onUpdate: (partial) => updates.push(partial),
    });

    expect(result.status).toBe("completed");
    expect(result.uiViews?.map((view) => view.spec.id)).toEqual(["panel", "done"]);
    expect(JSON.stringify(result.uiViews)).not.toContain("artifact");
    expect(JSON.stringify(updates)).toContain("panel");

    const live = uniquePairs(widgetCalls.filter((call) => call.value !== undefined).map((call) => [call.key.split(":").pop()!, call.options?.placement ?? ""]));
    expect(live).toEqual([
      ["compact", "aboveEditor"],
      ["panel", "aboveEditor"],
    ]);

    const panelLines = renderWidget(widgetCalls, "panel", 80);
    const compactLines = renderWidget(widgetCalls, "compact", 80);
    expect(panelLines.length).toBeLessThanOrEqual(RENDER_LIMITS.panelViewLines);
    expect(compactLines.length).toBeLessThanOrEqual(RENDER_LIMITS.compactViewLines);
    expect([...panelLines, ...compactLines].every((line) => visibleWidth(line) <= 80)).toBe(true);

    expect(widgetCalls.filter((call) => call.value === undefined).map((call) => call.key.split(":").pop()).sort()).toEqual(["compact", "panel"]);
  });

  it("shows and clears the standard live progress widget for background runs", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });
    const widgetCalls: Array<{ key: string; value: unknown; options?: { placement?: string } }> = [];
    const ctx = {
      cwd,
      hasUI: true,
      sessionManager: { getSessionId: () => "test-session" },
      ui: {
        setWidget: (key: string, value: unknown, options?: { placement?: string }) => widgetCalls.push({ key, value, options }),
      },
    };
    const runStore = new RunStore();
    const runner = new WorkflowRunner({ pi: { getActiveTools: () => [] } as any, runStore, registry: new WorkflowRegistry() });

    const result = await runner.launchOrRun({
      toolCallId: "ui-standard-progress-test",
      input: { script: `export const meta = { name: 'standard_ui', description: 'exercise standard live UI' };\nreturn 'ok';`, mode: "async" },
      ctx,
    });

    await runStore.getLiveRun(result.runId)?.donePromise;

    const progressCalls = widgetCalls.filter((call) => call.key.endsWith(":__progress"));
    expect(progressCalls.some((call) => call.value !== undefined && call.options?.placement === "aboveEditor")).toBe(true);
    expect(progressCalls.some((call) => call.value === undefined)).toBe(true);
    const progressLines = renderFactory(progressCalls.find((call) => call.value !== undefined)!.value, 80);
    expect(progressLines.length).toBeLessThanOrEqual(RENDER_LIMITS.panelViewLines);
    expect(progressLines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("turns UI definition errors into failed workflow output", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });
    const runner = new WorkflowRunner({ pi: { getActiveTools: () => [] } as any, runStore: new RunStore(), registry: new WorkflowRegistry() });

    const result = await runner.launchOrRun({
      toolCallId: "ui-validation-failure-test",
      input: {
        mode: "await",
        script: `export const meta = { name: 'bad_ui', description: 'surface UI validation failure' };
ui.define({
  version: 1,
  id: 'bad',
  title: 'Bad',
  layout: { type: 'metric', label: 'Value', bind: '/value', onClick: 'boom' },
});
return 'should not complete';`,
      },
      ctx: { cwd, hasUI: false, sessionManager: { getSessionId: () => "test-session" } },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/unsupported key onClick/);
    expect(result.summary).toContain("failed");
  });

  it("sends async failures as follow-up messages even without UI", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });
    const messages: any[] = [];
    const runStore = new RunStore();
    const runner = new WorkflowRunner({ pi: { getActiveTools: () => [], sendMessage: (message: any) => messages.push(message) } as any, runStore, registry: new WorkflowRegistry() });

    const result = await runner.launchOrRun({
      toolCallId: "async-failure-message-test",
      input: { mode: "async", script: `export const meta = { name: 'async_fail', description: 'fail in background' };
throw new Error('background boom');` },
      ctx: { cwd, hasUI: false, sessionManager: { getSessionId: () => "test-session" } },
    });
    const live = runStore.getLiveRun(result.runId);
    await live?.donePromise;

    expect(messages).toHaveLength(1);
    expect(messages[0].details.status).toBe("failed");
    expect(messages[0].details.error).toContain("background boom");
  });

  it("closes live UI views while keeping their artifacts", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });
    const widgetCalls: Array<{ key: string; value: unknown; options?: { placement?: string } }> = [];
    const runStore = new RunStore();
    const runner = new WorkflowRunner({ pi: { getActiveTools: () => [] } as any, runStore, registry: new WorkflowRegistry() });

    const result = await runner.launchOrRun({
      toolCallId: "ui-close-test",
      input: {
        mode: "await",
        script: `export const meta = { name: 'ui_close', description: 'exercise ui.close' };
ui.define({
  version: 1,
  id: 'ephemeral',
  title: 'Ephemeral',
  placement: 'runPanel',
  initialState: { message: 'visible' },
  layout: { type: 'markdown', bind: '/message' },
});
await ui.update('ephemeral', { message: 'persisted before close' });
await ui.close('ephemeral');
return 'ok';`,
      },
      ctx: {
        cwd,
        hasUI: true,
        sessionManager: { getSessionId: () => "test-session" },
        ui: { setWidget: (key: string, value: unknown, options?: { placement?: string }) => widgetCalls.push({ key, value, options }) },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.uiViews ?? []).toEqual([]);
    expect(runStore.get(result.runId)?.uiViews.map((view) => view.viewId)).toEqual(["ephemeral"]);
    expect(widgetCalls.some((call) => call.key.endsWith(":ephemeral") && call.value !== undefined)).toBe(true);
    expect(widgetCalls.some((call) => call.key.endsWith(":ephemeral") && call.value === undefined)).toBe(true);
  });

  it("does not render completed background workflow widgets as still running", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });
    const widgetCalls: Array<{ key: string; value: unknown; options?: { placement?: string } }> = [];
    const runStore = new RunStore();
    const runner = new WorkflowRunner({ pi: { getActiveTools: () => [], sendMessage: () => undefined } as any, runStore, registry: new WorkflowRegistry() });

    const result = await runner.launchOrRun({
      toolCallId: "async-widget-status-test",
      input: { mode: "async", script: `export const meta = { name: 'async_widget_fail', description: 'fail in background UI' };
throw new Error('widget boom');` },
      ctx: {
        cwd,
        hasUI: true,
        sessionManager: { getSessionId: () => "test-session" },
        ui: { setWidget: (key: string, value: unknown, options?: { placement?: string }) => widgetCalls.push({ key, value, options }) },
      },
    });
    await runStore.getLiveRun(result.runId)?.donePromise;

    const progressFactory = widgetCalls.find((call) => call.key.endsWith(":__progress") && call.value !== undefined)?.value;
    const lines = renderFactory(progressFactory, 80).join("\n");
    expect(lines).toContain("failed");
    expect(lines).not.toContain("running");
  });
});

function renderWidget(widgetCalls: Array<{ key: string; value: unknown }>, viewId: string, width: number): string[] {
  let call: { key: string; value: unknown } | undefined;
  for (let i = widgetCalls.length - 1; i >= 0; i--) {
    const entry = widgetCalls[i];
    if (entry.value !== undefined && entry.key.split(":").pop() === viewId) {
      call = entry;
      break;
    }
  }
  if (!call) throw new Error(`missing widget ${viewId}`);
  return renderFactory(call.value, width);
}

function renderFactory(value: unknown, width: number): string[] {
  if (typeof value !== "function") throw new Error("expected widget factory");
  const component = (value as (tui: unknown, theme: unknown) => { render(width: number): string[] })({}, undefined);
  return component.render(width) as string[];
}

function placementScript(): string {
  const view = (id: string, title: string, placement: string, value: number) => `
ui.define({
  version: 1,
  id: '${id}',
  title: '${title}',
  placement: '${placement}',
  initialState: { value: 0 },
  layout: { type: 'metric', label: '${title}', bind: '/value', format: 'number' },
});
await ui.update('${id}', { value: ${value} });`;

  return `export const meta = { name: 'ui_placements', description: 'exercise UI placement delivery' };
${view("panel", "Panel", "runPanel", 1)}
${view("compact", "Compact", "widget", 2)}
${view("done", "Done", "completion", 3)}
${view("artifact", "Artifact", "artifact", 4)}
return 'ok';
`;
}

function uniquePairs(pairs: string[][]): string[][] {
  return [...new Set(pairs.map((pair) => JSON.stringify(pair)))].map((text) => JSON.parse(text) as string[]).sort();
}
