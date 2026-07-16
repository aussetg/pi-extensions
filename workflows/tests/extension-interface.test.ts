import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWorkflowExtension } from "../src/extension.js";
import { parseFlowCommand } from "../src/commands/flow-command-parser.js";
import { registerExecutePlanCommand } from "../src/commands/execute-plan-command.js";
import { registerGoalCommand } from "../src/commands/goal-command.js";
import { RunCatalog } from "../src/persistence/run-catalog.js";
import { NamedWorkflowService } from "../src/runtime/named-workflow-service.js";
import type { RunRecord } from "../src/runtime/durable-types.js";
import { sha256 } from "../src/utils/hashes.js";

describe("Phase 26 extension interface", () => {
  it("registers only strict execution/draft tools and the uniform command entry points", async () => {
    const tools: any[] = [];
    const commands: string[] = [];
    const pi = fakePi(tools, commands);
    await createWorkflowExtension(pi as any);

    expect(tools.map((tool) => tool.name).sort()).toEqual(["workflow", "workflow_draft"]);
    expect(commands.sort()).toEqual(["execute-plan", "flow", "goal"]);

    const execution = tools.find((tool) => tool.name === "workflow").parameters;
    expect(Object.keys(execution.properties).sort()).toEqual(["args", "mode", "name"]);
    expect(execution.additionalProperties).toBe(false);
    expect([...execution.required].sort()).toEqual(["args", "name"]);
    const executionFields = schemaPropertyNames(execution);
    for (const forbidden of [
      "source", "argv", "command", "profile", "tools", "model", "thinking", "workspace", "network", "policy",
      "approval", "challenge",
    ]) expect(executionFields).not.toContain(forbidden);

    const draft = tools.find((tool) => tool.name === "workflow_draft").parameters;
    expect(Object.keys(draft.properties).sort()).toEqual(["action", "expectedDraftHash", "name", "namespace", "source"]);
    expect(draft.additionalProperties).toBe(false);
    expect(JSON.stringify(draft)).not.toContain('"promote"');
  });

  it("parses exactly the rebuilt /flow surface", () => {
    expect(parseFlowCommand("run builtin:research --async --args '{\"question\":\"why\"}'")).toEqual({
      action: "run", name: "builtin:research", mode: "async", args: { question: "why" },
    });
    expect(parseFlowCommand("replay abcdef12 --await")).toEqual({
      action: "replay", sourceRunRef: "abcdef12", mode: "await",
    });
    expect(parseFlowCommand("fresh-run abcdef12 --args '{\"objective\":\"again\"}'")).toEqual({
      action: "fresh-run", sourceRunRef: "abcdef12", mode: "await", args: { objective: "again" },
    });
    expect(parseFlowCommand("stop-effect abcdef12 run/stage:work/agent:edit")).toEqual({
      action: "stop-effect", runRef: "abcdef12", operationRef: "run/stage:work/agent:edit",
    });
    for (const removed of ["extend abcdef12", "message abcdef12", "next abcdef12", "replan abcdef12", "skip abcdef12", "adopt-workspace abcdef12"]) {
      expect(() => parseFlowCommand(removed)).toThrow("Unknown /flow command");
    }
  });

  it("makes goal aliases submit the same ordinary invocation record as /flow run", async () => {
    const registered = new Map<string, any>();
    const pi = { registerCommand: (name: string, command: any) => registered.set(name, command) };
    const invoke = vi.fn(async (input) => ({
      runId: `flow_${"1".repeat(32)}`,
      status: "waiting",
      summary: {
        runId: `flow_${"1".repeat(32)}`,
        shortRunId: "11111111",
        workflowId: input.name,
        status: "waiting",
      },
      handoff: true,
    }));
    const workflows = { invoke } as any;
    registerGoalCommand(pi as any, workflows);
    registerExecutePlanCommand(pi as any, workflows);
    const ctx = { mode: "tui", ui: { notify: vi.fn() } };

    await registered.get("goal").handler("ship it", ctx);
    await registered.get("execute-plan").handler("ship it", ctx);

    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      { name: "builtin:goal", args: { objective: "ship it" }, mode: "await" },
      { name: "builtin:execute-plan", args: { objective: "ship it" }, mode: "await" },
    ]);
  });

  it("restores a bounded async completion notification without owning a coordinator", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "workflow-extension-client-"));
    try {
      const project = path.join(root, "project");
      await fs.promises.mkdir(project);
      const catalog = new RunCatalog(path.join(root, "runs"));
      const at = new Date().toISOString();
      const created = await catalog.create({
        run: runRecord(at),
        event: {
          type: "run-created",
          payload: { authority: "user", mode: "async", sessionId: "session-1", projectRoot: project },
          at,
        },
      });
      created.database.close();
      const tools: any[] = [];
      const commands: string[] = [];
      const pi = fakePi(tools, commands);
      const launch = vi.fn();
      const service = new NamedWorkflowService(pi as any, {
        catalog,
        coordinator: { launch } as any,
        pollIntervalMs: 25,
      });
      const notify = vi.fn();
      const ctx = {
        cwd: project,
        mode: "tui",
        sessionManager: {
          getSessionId: () => "session-1",
          getHeader: () => ({ id: "session-1" }),
          getEntries: () => [],
        },
        ui: { notify },
      };

      await service.restoreAsyncNotifications(ctx as any);
      service.detachContext();

      expect(pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: "workflow-completion", display: true }),
        { deliverAs: "nextTurn" },
      );
      expect(pi.appendEntry).toHaveBeenCalledWith("workflow-completion", expect.objectContaining({ runId: created.entry.runId }));
      expect(notify).toHaveBeenCalledOnce();
      expect(launch).not.toHaveBeenCalled();
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});

function fakePi(tools: any[], commands: string[]) {
  return {
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: (name: string) => commands.push(name),
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    on: vi.fn(),
    getThinkingLevel: () => "low",
    getActiveTools: () => [],
    setActiveTools: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
}

function runRecord(at: string): Omit<RunRecord, "runId"> {
  return {
    revision: 1,
    workflow: {
      id: "builtin:research",
      name: "research",
      sourceHash: sha256("source"),
      definitionHash: sha256("definition"),
      capabilities: ["read-project"],
    },
    invocationHash: sha256("invocation"),
    projectSnapshotHash: sha256("project"),
    routeSnapshotHash: sha256("routes"),
    contextIdentityHash: sha256("context"),
    status: "completed",
    safety: {
      concurrency: 4,
      maximumAgentLaunches: 100,
      memoryBytes: 2 ** 30,
      tasks: 128,
      cpuQuotaPercent: 200,
      cpuWeight: 100,
      outputBytes: 1024 * 1024,
      commandTimeoutMs: 60_000,
    },
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      providerRequests: 1,
      cost: 0,
      elapsedMs: 1,
      complete: true,
    },
    createdAt: at,
    updatedAt: at,
    endedAt: at,
  };
}

function schemaPropertyNames(schema: unknown): string[] {
  const names = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(visit);
    const record = value as Record<string, unknown>;
    if (record.properties && typeof record.properties === "object") {
      for (const name of Object.keys(record.properties)) names.add(name);
    }
    Object.values(record).forEach(visit);
  };
  visit(schema);
  return [...names];
}
