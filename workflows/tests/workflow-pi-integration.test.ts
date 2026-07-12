import fs from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowRegistry } from "../src/persistence/registry.js";
import { RunStore } from "../src/persistence/run-store.js";
import { WorkflowRunner } from "../src/runtime/runner.js";
import { createWorkflowTool } from "../src/tool/workflow-tool.js";
import type { WorkflowLaunchOutput } from "../src/types.js";

const exec = promisify(execFile);

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
    const rendered = second.render(100).join("\n");
    expect(rendered).toContain("fresh partial row");
    expect(rendered).toContain("Review");
    expect(rendered).toContain("Verify");
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
await agent('record inherited tools', { workspace: 'shared' });
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

  it("returns opaque patch handles and applies each patch at most once", async () => {
    await initGitProject();
    const fakePi = path.join(tmp, "fake-pi-patch.mjs");
    await fs.promises.writeFile(
      fakePi,
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "await fs.promises.writeFile(path.join(process.cwd(), 'tracked.txt'), 'patched\\n', 'utf8');",
        "console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'implemented', usage: { input: 1, output: 1 } } }));",
      ].join("\n"),
      "utf8",
    );
    process.argv[1] = fakePi;

    const result = await new WorkflowRunner({ pi: { getActiveTools: () => ["read", "bash"] } as any, runStore: new RunStore(), registry: new WorkflowRegistry() }).launchOrRun({
      toolCallId: "patch-contract",
      input: {
        mode: "await",
        script: `export const meta = { name: 'patch_contract', description: 'exercise patch production and application' };
const candidate = await agent('implement the change', { workspace: 'patch' });
const applied = await apply(candidate.patch);
let duplicate = '';
try { await apply(candidate.patch); } catch (err) { duplicate = err.message; }
return { candidate, applied, duplicate };`,
      },
      ctx: workflowCtx(),
    });

    expect(result.status).toBe("completed");
    expect(await fs.promises.readFile(path.join(cwd, "tracked.txt"), "utf8")).toBe("patched\n");
    const output = JSON.parse(await fs.promises.readFile(result.outputPath!, "utf8")).result;
    expect(output.candidate).toEqual({
      result: "implemented",
      patch: expect.objectContaining({ kind: "workflow_patch", callId: "0001", files: ["tracked.txt"], empty: false }),
    });
    expect(JSON.stringify(output.candidate)).not.toMatch(/patchPath|worktreeDir/);
    expect(output.applied).toEqual(expect.objectContaining({ applied: true, files: ["tracked.txt"] }));
    expect(output.duplicate).toMatch(/already applied/);
    const journal = await fs.promises.readFile(path.join(path.dirname(result.scriptPath), "journal.jsonl"), "utf8");
    expect(journal).toContain('"type":"patch_applied"');
  });

  it("rejects a patch when its preimage changed and leaves the workspace untouched", async () => {
    await initGitProject();
    const fakePi = path.join(tmp, "fake-pi-conflicting-patch.mjs");
    await fs.promises.writeFile(
      fakePi,
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "const prompt = process.argv.at(-1);",
        "await fs.promises.writeFile(path.join(process.cwd(), 'tracked.txt'), prompt.includes('conflict') ? 'conflict\\n' : 'patched\\n', 'utf8');",
        "console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'done', usage: { input: 1, output: 1 } } }));",
      ].join("\n"),
      "utf8",
    );
    process.argv[1] = fakePi;

    const result = await new WorkflowRunner({ pi: { getActiveTools: () => ["bash"] } as any, runStore: new RunStore(), registry: new WorkflowRegistry() }).launchOrRun({
      toolCallId: "patch-conflict-contract",
      input: {
        mode: "await",
        script: `export const meta = { name: 'patch_conflict_contract', description: 'exercise transactional conflict checks' };
const candidate = await agent('make patch', { workspace: 'patch' });
await agent('create conflict', { workspace: 'shared' });
let error = '';
try { await apply(candidate.patch); } catch (err) { error = err.message; }
return { error };`,
      },
      ctx: workflowCtx(),
    });

    expect(result.status).toBe("completed");
    expect(await fs.promises.readFile(path.join(cwd, "tracked.txt"), "utf8")).toBe("conflict\n");
    const output = JSON.parse(await fs.promises.readFile(result.outputPath!, "utf8")).result;
    expect(output.error).toMatch(/no longer applies cleanly; workspace unchanged/);
  });

  it("derives the live widget from workflow execution progress", async () => {
    const renderedWidgets: Array<{ key: string; lines: string[] }> = [];
    const cleared: string[] = [];
    const runStore = new RunStore();
    const runner = new WorkflowRunner({ pi: { getActiveTools: () => [] } as any, runStore, registry: new WorkflowRegistry() });

    const result = await runner.launchOrRun({
      toolCallId: "set-widget-contract",
      input: {
        mode: "await",
        script: `export const meta = { name: 'set_widget_contract', description: 'exercise inferred progress rendering' };
phase('Inspect');
await log('checking');
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
    expect(renderedWidgets.some((widget) => widget.key.endsWith(":__progress") && widget.lines.join("\n").includes("set_widget_contract"))).toBe(true);
    expect(cleared.some((key) => key.endsWith(":__progress"))).toBe(true);
  });
});

function workflowCtx(): any {
  return {
    cwd,
    hasUI: false,
    sessionManager: { getSessionId: () => "test-session" },
  };
}

async function initGitProject(): Promise<void> {
  await exec("git", ["-C", cwd, "init"]);
  await exec("git", ["-C", cwd, "config", "user.name", "test"]);
  await exec("git", ["-C", cwd, "config", "user.email", "test@example.invalid"]);
  await fs.promises.writeFile(path.join(cwd, "tracked.txt"), "base\n", "utf8");
  await exec("git", ["-C", cwd, "add", "tracked.txt"]);
  await exec("git", ["-C", cwd, "-c", "commit.gpgsign=false", "commit", "-m", "base"]);
}

function workflowDetails(lastLabel: string): WorkflowLaunchOutput {
  const startedAt = new Date(0).toISOString();
  return {
    status: "async_launched",
    taskId: "task",
    runId: "wr_renderer_contract",
    name: "renderer_contract",
    description: "exercise tool renderer lifecycle",
    phases: [{ title: "Review" }, { title: "Verify" }],
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
      phase: "Review",
      updatedAt: startedAt,
      calls: [{ callId: "0001", label: lastLabel, status: "running", startedAt }],
      recentLogs: [],
    },
  };
}
