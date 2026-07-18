import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowExtension } from "../src/extension.js";
import { parseFlowCommand } from "../src/commands/flow-command-parser.js";
import { WorkflowNamedService } from "../src/runtime/named-workflow-service.js";

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

  it("parses explicit promotion exposure and rejects unknown commands", () => {
    expect(parseFlowCommand("promote user:fixture --exposure model --challenge sha256:" + "a".repeat(64))).toEqual({
      action: "promote", draftId: "user:fixture", exposure: "model", challenge: `sha256:${"a".repeat(64)}`,
    });
    expect(() => parseFlowCommand("unknown abcdef12")).toThrow("Unknown /flow command");
  });

  it("refuses launch from a session other than the bound primary session", async () => {
    const service = new WorkflowNamedService(fakePi([], [], new Map()) as any, {
      coordinator: { launcher: {}, launch: vi.fn() } as any,
    });
    service.bindContext(context("primary", process.cwd()) as any);
    await expect(service.invoke({ name: "builtin:research", args: {}, mode: "await" }, "model",
      context("subagent", process.cwd()) as any)).rejects.toThrow("primary bound session");
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
