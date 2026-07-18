import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createWorkflowExtension } from "../src/extension.js";
import { parseFlowCommand } from "../src/commands/flow-command-parser.js";
import { WorkflowNamedService } from "../src/runtime/named-workflow-service.js";
import { WorkflowRunCatalog } from "../src/persistence/run-catalog.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.promises.rm(root, { recursive: true, force: true }))); });

describe("workflow extension cutover", () => {
  it("registers only the strict TypeScript tools after primary-session trust is known", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "workflow-extension-"));
    roots.push(root);
    const prior = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    try {
      const tools: any[] = [];
      const commands: string[] = [];
      const events = new Map<string, Function[]>();
      const pi = fakePi(tools, commands, events);
      await createWorkflowExtension(pi as any);
      expect(tools.map(tool => tool.name)).toEqual(["workflow_draft"]);

      const ctx = context("primary", process.cwd());
      await events.get("session_start")![0]!({}, ctx);

      expect(tools.map(tool => tool.name).sort()).toEqual(["workflow", "workflow_draft"]);
      expect(commands.sort()).toEqual(["execute-plan", "flow", "goal"]);
      const execution = tools.find(tool => tool.name === "workflow");
      expect(execution.parameters.oneOf).toHaveLength(6);
      expect(execution.parameters.oneOf.map((branch: any) => branch.properties.name.enum[0]).sort()).toEqual([
        "builtin:coding", "builtin:execute-plan", "builtin:goal", "builtin:optimize", "builtin:package-audit", "builtin:research",
      ]);
      const draft = tools.find(tool => tool.name === "workflow_draft");
      expect(JSON.stringify(draft.parameters)).not.toContain('"promote"');
      expect(pi.setActiveTools).toHaveBeenCalledWith(["workflow", "workflow_draft"]);
    } finally {
      if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prior;
    }
  }, 30_000);

  it("parses explicit promotion exposure and rejects removed control surfaces", () => {
    expect(parseFlowCommand("promote user:fixture --exposure model --challenge sha256:" + "a".repeat(64))).toEqual({
      action: "promote", draftId: "user:fixture", exposure: "model", challenge: `sha256:${"a".repeat(64)}`,
    });
    for (const removed of ["extend abcdef12", "message abcdef12", "next abcdef12", "replan abcdef12", "skip abcdef12"]) {
      expect(() => parseFlowCommand(removed)).toThrow("Unknown /flow command");
    }
  });

  it("refuses launch from a session other than the bound primary session", async () => {
    const service = new WorkflowNamedService(fakePi([], [], new Map()) as any, {
      coordinator: { launcher: {}, launch: vi.fn() } as any,
    });
    service.bindContext(context("primary", process.cwd()) as any);
    await expect(service.invoke({ name: "builtin:research", args: {}, mode: "await" }, "model",
      context("subagent", process.cwd()) as any)).rejects.toThrow("primary bound session");
  });

  it("reports schema-3 run evidence as legacy without opening it for execution", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "workflow-legacy-"));
    roots.push(root);
    const runId = `flow_${"a".repeat(32)}`;
    const runDir = path.join(root, runId);
    await fs.promises.mkdir(runDir, { recursive: true });
    const raw = new DatabaseSync(path.join(runDir, "run.sqlite"));
    raw.exec("PRAGMA user_version = 3");
    raw.close();
    const service = new WorkflowNamedService(fakePi([], [], new Map()) as any, {
      catalog: new WorkflowRunCatalog(root),
      coordinator: { launcher: {}, launch: vi.fn() } as any,
    });
    const runs = await service.list(context("primary", process.cwd()) as any);
    expect(runs).toEqual([expect.objectContaining({ runId, status: "legacy", workflowId: "legacy:schema-3" })]);
    expect(runs[0]!.reason?.summary).toContain("schema 3 cannot be opened");
  });
});

function context(id: string, cwd: string): any {
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    signal: new AbortController().signal,
    isProjectTrusted: () => false,
    modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet" }] },
    model: { provider: "anthropic", id: "claude-sonnet" },
    sessionManager: {
      getSessionId: () => id,
      getHeader: () => ({ id }),
      getEntries: () => [],
    },
    ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
  };
}

function fakePi(tools: any[], commands: string[], events: Map<string, Function[]>) {
  const active: string[] = [];
  return {
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: (name: string) => commands.push(name),
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    on: (name: string, callback: Function) => events.set(name, [...(events.get(name) ?? []), callback]),
    getThinkingLevel: () => "low",
    getActiveTools: () => [...active],
    setActiveTools: vi.fn((values: string[]) => { active.splice(0, active.length, ...values); }),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
}
