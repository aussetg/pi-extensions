import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowRegistry } from "../src/persistence/registry.js";
import { RunStore } from "../src/persistence/run-store.js";
import { WorkflowRunner } from "../src/runtime/runner.js";
import { createWorkflowTool } from "../src/tool/workflow-tool.js";
import { renderWorkflowResult } from "../src/tool/workflow-tool-renderer.js";
import { renderWorkflowResultLines } from "../src/ui/workflow-result-component.js";
import type { WorkflowLaunchOutput, WorkflowViewSnapshot } from "../src/types.js";

let oldAgentDir: string | undefined;
let tmp: string;
let cwd: string;

beforeEach(async () => {
  oldAgentDir = process.env.PI_AGENT_DIR;
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflows-ui-regressions-"));
  process.env.PI_AGENT_DIR = path.join(tmp, "agent");
  cwd = path.join(tmp, "project");
  await fs.promises.mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  if (oldAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = oldAgentDir;
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("workflow UI regressions", () => {
  it("marks failed workflow tool results as tool errors", async () => {
    const tool = createWorkflowTool({ pi: { getActiveTools: () => [] } as any, runStore: new RunStore(), registry: new WorkflowRegistry() });

    const result = await tool.execute(
      "failed-tool-result-regression",
      {
        mode: "await",
        script: `export const meta = { name: 'fails_for_status', description: 'exercise failed tool result semantics' };
throw new Error('intentional workflow failure');`,
      },
      new AbortController().signal,
      () => undefined,
      workflowCtx(),
    );

    expect(result.details.status).toBe("failed");
    expect(result.isError).toBe(true);
  });

  it("uses the same panel profile for collapsed final results and collapsed running updates", () => {
    const finalDetails = workflowDetailsWithRunPanel("completed");
    const runningDetails = workflowDetailsWithRunPanel("async_launched");

    const finalCollapsed = renderWorkflowResult({ details: finalDetails }, { expanded: false, isPartial: false }).render(96);
    const runningCollapsed = renderWorkflowResult({ details: runningDetails }, { expanded: false, isPartial: true }).render(96);

    expect(finalCollapsed).toEqual(renderWorkflowResultLines(finalDetails, { profile: "panel" }, undefined, 96));
    expect(runningCollapsed).toEqual(renderWorkflowResultLines(runningDetails, { profile: "panel", partial: true }, undefined, 96));
    expect(finalCollapsed.join("\n")).toContain("Smoke Dashboard");
    expect(runningCollapsed.join("\n")).toContain("Smoke Dashboard");
  });

  it("accepts the model-native dashboard shape through ui.define() and ui.update()", async () => {
    const runner = new WorkflowRunner({ pi: { getActiveTools: () => [] } as any, runStore: new RunStore(), registry: new WorkflowRegistry() });

    const result = await runner.launchOrRun({
      toolCallId: "natural-dashboard-regression",
      input: {
        mode: "await",
        script: `export const meta = { name: 'natural_dashboard_shape', description: 'exercise model-native dashboard UI shape' };

function dashboard(step) {
  return {
    title: 'Natural dashboard',
    status: step >= 2 ? 'complete' : 'running',
    summary: \`step \${step}/2\`,
    metrics: [
      { label: 'step', value: \`\${step}/2\` },
      { label: 'phase', value: step === 1 ? 'define' : 'update' },
    ],
    sections: [
      {
        title: 'Checklist',
        rows: [
          { label: 'define dashboard', status: 'done' },
          { label: 'update dashboard', status: step >= 2 ? 'done' : 'pending' },
        ],
      },
      { title: 'Log', lines: [\`tick \${step}\`] },
    ],
  };
}

ui.define(dashboard(1));
await ui.update(dashboard(2));

return { ok: true };`,
      },
      ctx: workflowCtx(),
    });

    expect(result.status).toBe("completed");
    expect(JSON.stringify(result.uiViews)).toContain("Natural dashboard");
    expect(JSON.stringify(result.uiViews)).toContain("step 2/2");
    expect(JSON.stringify(result.uiViews)).toContain("tick 2");
  });

  it("defines then updates the default dashboard through ui.dashboard()", async () => {
    const runner = new WorkflowRunner({ pi: { getActiveTools: () => [] } as any, runStore: new RunStore(), registry: new WorkflowRegistry() });

    const result = await runner.launchOrRun({
      toolCallId: "dashboard-helper-regression",
      input: {
        mode: "await",
        script: `export const meta = { name: 'dashboard_helper_shape', description: 'exercise ui.dashboard helper' };

const first = ui.dashboard({
  title: 'Helper dashboard',
  summary: 'first state',
  metrics: { count: 1 },
});

const second = ui.dashboard({
  title: 'Helper dashboard',
  summary: 'second state',
  progress: { value: 2, total: 2 },
  sections: [{ title: 'Log', lines: ['done'] }],
});

return { first, second };`,
      },
      ctx: workflowCtx(),
    });

    expect(result.status).toBe("completed");
    expect(result.resultPreview).toContain('"id": "dashboard"');
    expect(JSON.stringify(result.uiViews)).toContain("second state");
    expect(JSON.stringify(result.uiViews)).toContain("done");
  });

  it("exposes a tiny ui.help() introspection string", async () => {
    const runner = new WorkflowRunner({ pi: { getActiveTools: () => [] } as any, runStore: new RunStore(), registry: new WorkflowRegistry() });

    const result = await runner.launchOrRun({
      toolCallId: "ui-help-regression",
      input: {
        mode: "await",
        script: `export const meta = { name: 'ui_help', description: 'exercise ui.help introspection' };
return ui.help();`,
      },
      ctx: workflowCtx(),
    });

    expect(result.status).toBe("completed");
    expect(result.resultPreview).toContain("ui.dashboard");
    expect(result.resultPreview).toContain("ui.define");
    expect(result.resultPreview).toContain("ui.update");
  });
});

function workflowCtx(): any {
  return {
    cwd,
    hasUI: false,
    sessionManager: { getSessionId: () => "test-session" },
  };
}

function workflowDetailsWithRunPanel(status: WorkflowLaunchOutput["status"]): WorkflowLaunchOutput {
  const startedAt = new Date(0).toISOString();
  return {
    status,
    taskId: "task",
    runId: `run_${status}`,
    name: "panel_mapping",
    description: "Exercise panel mapping",
    summary: "summary",
    scriptPath: "/tmp/script.js",
    transcriptDir: "/tmp/subagents",
    outputPath: "/tmp/output.json",
    resultPreview: "result payload",
    startedAt,
    endedAt: status === "async_launched" ? undefined : new Date(1000).toISOString(),
    progress: {
      total: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cached: 0,
      skipped: 0,
      phase: "Render",
      calls: [],
      recentLogs: [],
      updatedAt: new Date(500).toISOString(),
    },
    uiViews: [smokeDashboard()],
  };
}

function smokeDashboard(): WorkflowViewSnapshot {
  return {
    seq: 1,
    spec: {
      version: 1,
      id: "smoke",
      title: "Smoke Dashboard",
      placement: "runPanel",
      initialState: { summary: "panel summary", count: 2 },
      layout: {
        type: "vstack",
        children: [
          { type: "markdown", bind: "/summary", maxLines: 2 },
          { type: "metric", label: "Count", bind: "/count", format: "number" },
        ],
      },
    },
    state: { summary: "panel summary", count: 2 },
  };
}
