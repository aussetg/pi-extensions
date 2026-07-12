import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowRegistry } from "../src/persistence/registry.js";
import { RunStore } from "../src/persistence/run-store.js";
import { WorkflowRunner } from "../src/runtime/runner.js";
import { createWorkflowTool } from "../src/tool/workflow-tool.js";
import type { WorkflowLaunchOutput } from "../src/types.js";

let oldAgentDir: string | undefined;
let oldArgv1: string | undefined;
let tmp: string;
let cwd: string;

beforeEach(async () => {
  oldAgentDir = process.env.PI_AGENT_DIR;
  oldArgv1 = process.argv[1];
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflows-pi-integration-"));
  process.env.PI_AGENT_DIR = path.join(tmp, "agent");
  cwd = path.join(tmp, "project");
  await fs.promises.mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  if (oldAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = oldAgentDir;
  if (oldArgv1 === undefined) process.argv.splice(1, 1);
  else process.argv[1] = oldArgv1;
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("Pi integration contracts", () => {
  it("renders calls and reuses the Pi renderer context component for result updates", () => {
    const tool = createWorkflowTool({ pi: {} as any, runStore: new RunStore(), registry: new WorkflowRegistry() });
    const callLines = tool.renderCall({ scriptPath: "demo\nworkflow.js", mode: "await" }).render(80).join("\n");

    expect(callLines).toContain("workflow");
    expect(callLines).toContain("demo");
    expect(callLines).toContain("workflow.js");

    const context: { lastComponent?: unknown } = {};
    const first = tool.renderResult({ details: workflowDetails("first row") }, { isPartial: true }, undefined, context);
    context.lastComponent = first;
    const second = tool.renderResult({ details: workflowDetails("fresh partial row") }, { isPartial: true }, undefined, context);

    expect(second).toBe(first);
    expect(second.render(100).join("\n")).toContain("fresh partial row");
  });

  it("delivers background workflow completion through pi.sendMessage follow-up options", async () => {
    const messages: Array<{ message: any; options: any }> = [];
    const runStore = new RunStore();
    const runner = new WorkflowRunner({
      pi: {
        getActiveTools: () => [],
        sendMessage: (message: any, options: any) => messages.push({ message, options }),
      } as any,
      runStore,
      registry: new WorkflowRegistry(),
    });

    const launched = await runner.launchOrRun({
      toolCallId: "send-message-contract",
      input: {
        mode: "async",
        script: `export const meta = { name: 'send_message_contract', description: 'exercise async completion delivery' };
await new Promise((resolve) => setTimeout(resolve, 20));
return 'ok';`,
      },
      ctx: workflowCtx(),
    });

    expect(launched.status).toBe("async_launched");
    await runStore.getLiveRun(launched.runId)?.donePromise;

    expect(messages).toHaveLength(1);
    expect(messages[0].message).toMatchObject({ customType: "workflow_result", display: true, details: { status: "completed", runId: launched.runId } });
    expect(messages[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });

  it("inherits active Pi tools for subagents while stripping workflow itself", async () => {
    const fakePi = path.join(tmp, "fake-pi-tools.mjs");
    await fs.promises.writeFile(
      fakePi,
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "await fs.promises.writeFile(path.join(process.cwd(), 'subagent-argv.json'), JSON.stringify(process.argv.slice(2)), 'utf8');",
        "console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'done', usage: { input: 1, output: 1 } } }));",
      ].join("\n"),
      "utf8",
    );
    process.argv[1] = fakePi;
    const runner = new WorkflowRunner({
      pi: { getActiveTools: () => ["workflow", "bash", "read", "bash", "bad,tool"] } as any,
      runStore: new RunStore(),
      registry: new WorkflowRegistry(),
    });

    const result = await runner.launchOrRun({
      toolCallId: "active-tools-contract",
      input: {
        mode: "await",
        script: `export const meta = { name: 'active_tools_contract', description: 'exercise active tool inheritance' };
await agent('record inherited tools', { isolation: 'shared' });
return 'ok';`,
      },
      ctx: workflowCtx(),
    });

    expect(result.status).toBe("completed");
    const argv = JSON.parse(await fs.promises.readFile(path.join(cwd, "subagent-argv.json"), "utf8")) as string[];
    expect(argv).toContain("--tools");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("bash,read");
    expect(argv).not.toContain("workflow");
    expect(argv).not.toContain("--no-tools");
  });

  it("passes live widget factories that render against a realistic ctx.ui.setWidget callback", async () => {
    const renderedWidgets: Array<{ key: string; lines: string[] }> = [];
    const cleared: string[] = [];
    const runStore = new RunStore();
    const runner = new WorkflowRunner({ pi: { getActiveTools: () => [] } as any, runStore, registry: new WorkflowRegistry() });

    const result = await runner.launchOrRun({
      toolCallId: "set-widget-contract",
      input: {
        mode: "await",
        script: `export const meta = { name: 'set_widget_contract', description: 'exercise live widget callback rendering' };
await ui.define({
  version: 1,
  id: 'live',
  title: 'Live UI',
  placement: 'widget',
  initialState: { count: 1 },
  layout: { type: 'metric', label: 'count', bind: '/count' },
});
await ui.update('live', { count: 2 });
return 'ok';`,
      },
      ctx: {
        ...workflowCtx(),
        hasUI: true,
        ui: {
          setWidget: (key: string, value: unknown) => {
            if (value === undefined) {
              cleared.push(key);
              return;
            }
            if (typeof value === "function") {
              const component = (value as (tui: unknown, theme: unknown) => { render(width: number): string[] })({}, { fg: (_name: string, text: string) => text });
              renderedWidgets.push({ key, lines: component.render(80) });
            }
          },
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(renderedWidgets.some((widget) => widget.key.endsWith(":live") && widget.lines.join("\n").includes("Live UI") && widget.lines.join("\n").includes("count: 2"))).toBe(true);
    expect(cleared.some((key) => key.endsWith(":live"))).toBe(true);
  });
});

function workflowCtx(): any {
  return {
    cwd,
    hasUI: false,
    sessionManager: { getSessionId: () => "test-session" },
  };
}

function workflowDetails(lastLabel: string): WorkflowLaunchOutput {
  const startedAt = new Date(0).toISOString();
  return {
    status: "async_launched",
    taskId: "task",
    runId: "wr_renderer_contract",
    name: "renderer_contract",
    description: "exercise tool renderer lifecycle",
    summary: "summary",
    scriptPath: "/tmp/workflow.js",
    transcriptDir: "/tmp/subagents",
    startedAt,
    progress: {
      total: 1,
      running: 1,
      completed: 0,
      failed: 0,
      skipped: 0,
      updatedAt: startedAt,
      calls: [{ callId: "0001", label: lastLabel, status: "running", startedAt }],
      recentLogs: [],
    },
  };
}
