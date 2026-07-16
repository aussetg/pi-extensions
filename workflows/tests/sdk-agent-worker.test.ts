import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { AgentEvidenceLog, readAgentConversationTailPage } from "../src/artifacts/agent-attempt.js";
import {
  MISSING_RECEIPT_REMINDER,
  type AgentExecutionHandle,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type AgentEvent,
} from "../src/agents/executor.js";
import { AgentProtocolClient, type AgentWorkerProtocol } from "../src/agents/sdk-protocol.js";
import { AgentProtocolServer } from "../src/agents/sdk-protocol-server.js";
import {
  buildAgentSandboxLaunch,
  SdkAgentWorkerExecutor,
  SystemdSandboxedSdkCycleExecutor,
} from "../src/agents/sdk-executor.js";
import {
  AgentSessionSupervisor,
  type AgentSupervisionStore,
  type AgentWorkerCycleExecutor,
} from "../src/agents/supervisor.js";
import { buildFinishWorkContract, createAgentTerminalTools } from "../src/agents/sdk-tools.js";
import {
  createIsolatedAgentResourceLoader,
  openPinnedAgentSession,
  rewindRetryableAssistantFailure,
  runSdkAgentWorker,
} from "../src/agents/sdk-worker.js";
import { RunDatabase, RunDatabaseReader } from "../src/persistence/run-database.js";
import { parseFlowCommand } from "../src/commands/flow-command-parser.js";
import { HostAgentMediatedToolExecutor } from "../src/agents/host-mediator.js";
import type {
  AgentSessionRecord,
  AttemptRecord,
  OperationRecord,
  RunRecord,
} from "../src/runtime/durable-types.js";
import type { JsonValue } from "../src/types.js";
import { sha256, stableHash } from "../src/utils/hashes.js";

const roots: string[] = [];
const RUN_ID = "flow_11111111111111111111111111111111";
const NOW = "2026-07-16T09:00:00.000Z";

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

describe("Pi SDK agent worker contracts", () => {
  it("uses the exact dynamic finish schema and a bounded schema-less contract", async () => {
    const schema = {
      type: "object",
      properties: { answer: { type: "integer" } },
      required: ["answer"],
      additionalProperties: false,
    };
    const exact = buildFinishWorkContract(schema);
    expect(exact.parameters).toEqual(schema);
    expect(exact.schemaHash).toBe(stableHash(schema));
    expect(Object.isFrozen(exact.parameters)).toBe(true);

    const fallback = buildFinishWorkContract();
    expect(fallback.parameters).toMatchObject({
      type: "object",
      required: ["result"],
      additionalProperties: false,
      properties: { result: { type: "string", maxLength: 32_000 } },
    });

    const protocol = new FakeProtocol((toolName, toolCallId, payload) => {
      expect(toolName).toBe("finish_work");
      return {
        finish: {
          toolCallId,
          schemaHash: exact.schemaHash,
          value: payload,
          artifacts: [],
          committedAt: NOW,
        },
      };
    });
    const terminal = createAgentTerminalTools(protocol, schema);
    const finish = terminal.tools.find((tool) => tool.name === "finish_work")!;
    expect(finish.parameters).toEqual(schema);
    const result = await finish.execute("tool-finish", { answer: 42 }, undefined, undefined, {} as any);
    expect(result.terminate).toBe(true);
    expect(terminal.committedFinish()).toMatchObject({ value: { answer: 42 } });
  });

  it("loads no ambient resources and ignores plausible final assistant JSON without finish_work", async () => {
    const root = await workerRoot();
    const request = workerRequest(root);
    const protocol = new FakeProtocol(() => { throw new Error("No terminal tool was expected"); });
    let captured: CreateAgentSessionOptions | undefined;
    let listener: ((event: any) => void) | undefined;
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: '{"answer":42}' }],
      provider: "test",
      model: "model",
      stopReason: "stop",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    };
    const result = await runSdkAgentWorker({ runDir: root, request }, {
      protocol,
      resolveModel: () => ({ provider: "test", id: "model" }) as any,
      openSessionManager: () => SessionManager.inMemory(request.workspace.cwd),
      createSession: async (options) => {
        captured = options;
        return {
          extensionsResult: { extensions: [], errors: [] },
          session: {
            subscribe: (next: (event: any) => void) => { listener = next; return () => {}; },
            prompt: async () => {
              listener?.({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
              listener?.({
                type: "message_update",
                message: assistant,
                assistantMessageEvent: { type: "text_delta", delta: '{"answer":42}', partial: assistant },
              });
              listener?.({ type: "turn_end", turnIndex: 0, message: assistant, toolResults: [] });
            },
            dispose: () => {},
            getActiveToolNames: () => options.tools!,
            getAllTools: () => [
              { name: "read", parameters: { type: "object", additionalProperties: false } },
              ...["finish_work", "report_progress", "log_result", "publish_artifact"].map((name) => ({ name, parameters: {} })),
            ],
            model: { provider: "test", id: "model" },
            thinkingLevel: "off",
            messages: [assistant],
            agent: { continue: async () => {} },
          },
        };
      },
    });

    expect(result.outcome).toBe("yielded");
    expect(captured?.tools).not.toContain("workflow");
    expect(captured?.resourceLoader?.getExtensions().extensions).toEqual([]);
    expect(captured?.resourceLoader?.getSkills().skills).toEqual([]);
    expect(captured?.resourceLoader?.getPrompts().prompts).toEqual([]);
    expect(captured?.resourceLoader?.getThemes().themes).toEqual([]);
    expect(captured?.resourceLoader?.getAgentsFiles().agentsFiles).toEqual([]);
    expect(protocol.events.some((event) => event.type === "assistant-text")).toBe(true);
  });

  it("creates and reopens the exact persistent session under the run", async () => {
    const root = await workerRoot();
    const request = workerRequest(root);
    const created = await openPinnedAgentSession(root, request);
    expect(created.getSessionFile()).toBe(path.join(root, "sessions", request.executionId, "session.jsonl"));
    expect((await fs.promises.lstat(created.getSessionFile()!)).isFile()).toBe(true);

    const resumed = await openPinnedAgentSession(root, {
      ...request,
      instruction: { kind: "resume" },
      session: { ...request.session, resume: true },
    });
    expect(resumed.getSessionFile()).toBe(created.getSessionFile());
  });

  it("preserves failed provider output while retrying from its parent context", () => {
    const manager = SessionManager.inMemory("/workspace");
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "work" }], timestamp: Date.now() } as any);
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
      stopReason: "error",
      errorMessage: "interrupted",
      timestamp: Date.now(),
    } as any);
    expect(rewindRetryableAssistantFailure(manager)).toBe(true);
    expect((manager.getBranch().at(-1) as any).message.role).toBe("user");
    expect(manager.getEntries()).toHaveLength(2);

    manager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_interrupted|fc_1", name: "read", arguments: { path: "x" } }],
      stopReason: "toolUse",
      timestamp: Date.now(),
    } as any);
    expect(rewindRetryableAssistantFailure(manager)).toBe(true);
    expect((manager.getBranch().at(-1) as any).message.role).toBe("user");
    expect(manager.getEntries()).toHaveLength(3);
  });

  it("provides an inert explicit ResourceLoader", async () => {
    const loader = createIsolatedAgentResourceLoader("Pinned system prompt");
    await loader.reload();
    expect(loader.getSystemPrompt()).toBe("Pinned system prompt");
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(loader.getExtensions()).toMatchObject({ extensions: [], errors: [] });
  });

  it("detects successful candidate edits as meaningful progress", async () => {
    const root = await workerRoot();
    const candidate = path.join(root, "candidate-progress");
    await fs.promises.mkdir(candidate);
    await fs.promises.writeFile(path.join(candidate, "state.txt"), "before\n");
    const base = workerRequest(root);
    const parameters = { type: "object", additionalProperties: false };
    const request: AgentExecutionRequest = {
      ...base,
      tools: [{
        name: "write",
        schemaHash: stableHash(parameters).slice(7),
        mutatesWorkspace: true,
        usesMediatedNetwork: false,
      }],
      workspace: {
        mode: "candidate",
        root: candidate,
        cwd: candidate,
        preTreeHash: base.workspace.preTreeHash,
        workspace: {
          kind: "candidate",
          workspaceId: "candidate-progress",
          treeHash: base.workspace.preTreeHash,
          lineageHash: sha256("lineage"),
          writeScopeHash: sha256("scope"),
        },
      },
    };
    const protocol = new FakeProtocol(() => { throw new Error("No terminal tool expected"); });
    let listener: ((event: any) => void) | undefined;
    const result = await runSdkAgentWorker({ runDir: root, request }, {
      protocol,
      resolveModel: () => ({ provider: "test", id: "model" }) as any,
      openSessionManager: () => SessionManager.inMemory(candidate),
      createSession: async (options) => ({
        extensionsResult: { extensions: [], errors: [] },
        session: {
          subscribe: (next: (event: any) => void) => { listener = next; return () => {}; },
          prompt: async () => {
            listener?.({ type: "tool_execution_start", toolCallId: "write-1", toolName: "write", args: {} });
            await fs.promises.writeFile(path.join(candidate, "state.txt"), "after\n");
            listener?.({ type: "tool_execution_end", toolCallId: "write-1", toolName: "write", result: {}, isError: false });
          },
          dispose: () => {},
          getActiveToolNames: () => options.tools!,
          getAllTools: () => [
            { name: "write", parameters },
            ...["finish_work", "report_progress", "log_result", "publish_artifact"].map((name) => ({ name, parameters: {} })),
          ],
          model: { provider: "test", id: "model" },
          thinkingLevel: "off",
          messages: [],
          agent: { continue: async () => {} },
        },
      }),
    });
    expect(result).toMatchObject({ outcome: "yielded", meaningfulProgress: true });
    expect(protocol.events).toContainEqual(expect.objectContaining({
      type: "workspace-change",
      changedPaths: ["state.txt"],
    }));
  });
});

describe("logical agent session supervision", () => {
  it("has process stop but no running-agent guidance command", () => {
    expect(parseFlowCommand("stop-effect abcdef12 run/agent:task")).toEqual({
      action: "stop-effect", runRef: "abcdef12", operationRef: "run/agent:task",
    });
    expect(() => parseFlowCommand("message abcdef12 --text redirect")).toThrow("Unknown /flow command");
    expect(() => parseFlowCommand("stop-effect abcdef12 run/agent:task --execution-id old-process")).toThrow(/Usage/);
  });

  it("finishes naturally and supports one or two fixed missing-receipt reminders", async () => {
    for (const reminderCount of [0, 1, 2]) {
      const root = await workerRoot();
      const request = workerRequest(root);
      const cycles = new ScriptedCycles([
        ...Array.from({ length: reminderCount }, () => yielded(false)),
        finished("done"),
      ]);
      const store = new MemorySupervisionStore();
      const supervisor = new AgentSessionSupervisor({
        cycleExecutor: cycles,
        request,
        sink: { emit: async () => {} },
        store,
        sleep: async () => {},
        sessionExists: async () => true,
      });
      await expect(supervisor.wait()).resolves.toMatchObject({ outcome: "finished" });
      expect(cycles.requests).toHaveLength(reminderCount + 1);
      for (const resumed of cycles.requests.slice(1)) {
        expect(resumed.session.resume).toBe(true);
        expect(resumed.session.piSessionPath).toBe(request.session.piSessionPath);
        expect(resumed.instruction).toEqual({ kind: "missing-receipt-reminder", text: MISSING_RECEIPT_REMINDER });
      }
    }
  });

  it("pauses on the third clean non-progressing yield and progress resets the sequence", async () => {
    const root = await workerRoot();
    const request = workerRequest(root);
    const strikes = new MemorySupervisionStore();
    const exhausted = new AgentSessionSupervisor({
      cycleExecutor: new ScriptedCycles([yielded(false), yielded(false), yielded(false)]),
      request,
      sink: { emit: async () => {} },
      store: strikes,
      sleep: async () => {},
      sessionExists: async () => true,
    });
    await expect(exhausted.wait()).resolves.toMatchObject({
      outcome: "paused",
      receiptlessStrikes: 3,
      reason: { code: "receiptless-yield-limit" },
    });

    const reset = new MemorySupervisionStore();
    const cycles = new ScriptedCycles([
      yielded(false), yielded(false), yielded(true), yielded(false), yielded(false), finished("after-progress"),
    ]);
    const recovered = new AgentSessionSupervisor({
      cycleExecutor: cycles,
      request,
      sink: { emit: async () => {} },
      store: reset,
      sleep: async () => {},
      sessionExists: async () => true,
    });
    await expect(recovered.wait()).resolves.toMatchObject({ outcome: "finished" });
    expect(reset.strikes).toBe(2);
    expect(reset.yields).toEqual([false, false, true, false, false]);
  });

  it("reopens the same session for provider, compaction, and killed-worker recovery without strikes", async () => {
    const root = await workerRoot();
    const request = workerRequest(root);
    const store = new MemorySupervisionStore();
    const cycles = new ScriptedCycles([
      retryFailure("provider", "provider-retry"),
      retryFailure("infrastructure", "compaction-interrupted", true),
      retryFailure("infrastructure", "worker-killed"),
      yielded(false),
      finished("recovered"),
    ]);
    const supervisor = new AgentSessionSupervisor({
      cycleExecutor: cycles,
      request,
      sink: { emit: async () => {} },
      store,
      sleep: async () => {},
      sessionExists: async () => true,
    });
    await expect(supervisor.wait()).resolves.toMatchObject({ outcome: "finished" });
    expect(store.retries).toBe(3);
    expect(store.strikes).toBe(0); // progress retained through the infrastructure failures reset the yield sequence
    expect(cycles.requests.slice(1, 4).map((entry) => entry.instruction.kind)).toEqual(["resume", "resume", "resume"]);
    expect(cycles.requests[4]!.instruction).toEqual({
      kind: "missing-receipt-reminder",
      text: MISSING_RECEIPT_REMINDER,
    });
    expect(new Set(cycles.requests.map((entry) => entry.session.piSessionPath))).toEqual(new Set([request.session.piSessionPath]));
  });

  it("bounds persistent infrastructure failure and cancellation without semantic guidance", async () => {
    const root = await workerRoot();
    const request = workerRequest(root);
    const store = new MemorySupervisionStore();
    const unavailable = new AgentSessionSupervisor({
      cycleExecutor: new ScriptedCycles([
        retryFailure("infrastructure", "systemd-failed"),
        retryFailure("infrastructure", "systemd-failed"),
      ]),
      request,
      sink: { emit: async () => {} },
      store,
      maximumInfrastructureFailures: 2,
      backoffMs: [0],
      sleep: async () => {},
      sessionExists: async () => true,
    });
    await expect(unavailable.wait()).resolves.toMatchObject({
      outcome: "paused",
      reason: { code: "agent-infrastructure-unavailable" },
      receiptlessStrikes: 0,
    });
    expect(store.paused).toBe(true);

    const blocked = new BlockingCycles();
    const cancelled = new AgentSessionSupervisor({
      cycleExecutor: blocked,
      request,
      sink: { emit: async () => {} },
      store: new MemorySupervisionStore(),
      sessionExists: async () => false,
    });
    await blocked.started;
    await cancelled.cancel("stop-effect");
    await expect(cancelled.wait()).resolves.toMatchObject({ outcome: "stopped" });
    expect(blocked.cancelReason).toBe("stop-effect");
  });

  it("builds persistent candidate, input, output, session, and protocol mounts without unsharing worker network", async () => {
    const root = await workerRoot();
    const request = workerRequest(root);
    const inputs = path.join(root, "inputs");
    const candidate = path.join(root, "candidate");
    await fs.promises.mkdir(inputs);
    await fs.promises.mkdir(candidate);
    await fs.promises.writeFile(path.join(candidate, "state.txt"), "before\n");
    const launch = await buildAgentSandboxLaunch({
      ...request,
      tools: [],
      workspace: {
        mode: "candidate",
        root: candidate,
        cwd: candidate,
        preTreeHash: request.workspace.preTreeHash,
        workspace: {
          kind: "candidate",
          workspaceId: "candidate-1",
          treeHash: request.workspace.preTreeHash,
          lineageHash: sha256("lineage"),
          writeScopeHash: sha256("scope"),
        },
      },
      inputs: { root: inputs, entries: [], hash: sha256("inputs") },
    }, { bwrapPath: "/usr/bin/bwrap" });
    expect(launch.argv).not.toContain("--unshare-net");
    expect(argumentPair(launch.argv, "--bind", candidate)).toEqual(["--bind", candidate, "/workspace"]);
    expect(launch.argv).toContain("/inputs");
    expect(launch.argv).toContain("/outputs");
    expect(launch.argv).toContain(`${launch.config.runDir}/agent-protocol.sock`);
    expect(launch.config.request.workspace).toMatchObject({ mode: "candidate", root: "/workspace", cwd: "/workspace" });
    expect(launch.config.request.session.piSessionPath).toBe(request.session.piSessionPath);
  });

  it("reattaches to a worker unit left alive by a killed coordinator", async () => {
    const root = await workerRoot();
    const request = workerRequest(root);
    const resultPath = path.join(root, "sessions", request.executionId, "worker-result.json");
    let inspections = 0;
    const fakeLauncher = {
      preflight: async () => {},
      inspect: async (unit: string) => {
        inspections += 1;
        if (inspections < 3) {
          return { unit, loadState: "loaded", activeState: "active", subState: "running", result: "success" };
        }
        await fs.promises.writeFile(resultPath, `${JSON.stringify(yielded(false))}\n`);
        return { unit, loadState: "not-found", activeState: "inactive", subState: "dead", result: "success" };
      },
      collect: async (unit: string) => ({ unit, termSent: false, killSent: false, collected: true }),
      stop: async (unit: string) => ({ unit, termSent: true, killSent: false, collected: true }),
      launch: async () => { throw new Error("A recovered live unit must not be relaunched"); },
    };
    const cycles = new SystemdSandboxedSdkCycleExecutor({ launcher: fakeLauncher as any });
    const handle = await cycles.start(request, { emit: async () => {} });
    await expect(handle.wait()).resolves.toMatchObject({ outcome: "yielded", meaningfulProgress: false });
    await handle.dispose?.();
    expect(inspections).toBeGreaterThanOrEqual(3);
  });

  it("runs one worker cycle in a transient systemd Bubblewrap unit with persistent mounts", async () => {
    const root = await workerRoot();
    const base = workerRequest(root);
    const candidate = path.join(root, "candidate-systemd");
    const inputs = path.join(root, "inputs-systemd");
    await fs.promises.mkdir(candidate);
    await fs.promises.mkdir(inputs);
    await fs.promises.writeFile(path.join(inputs, "fact.txt"), "mounted input\n");
    const request: AgentExecutionRequest = {
      ...base,
      tools: [],
      workspace: {
        mode: "candidate",
        root: candidate,
        cwd: candidate,
        preTreeHash: base.workspace.preTreeHash,
        workspace: {
          kind: "candidate",
          workspaceId: "candidate-systemd",
          treeHash: base.workspace.preTreeHash,
          lineageHash: sha256("lineage-systemd"),
          writeScopeHash: sha256("scope-systemd"),
        },
      },
      inputs: {
        root: inputs,
        entries: [{
          id: "fact",
          artifact: { digest: sha256("fact"), kind: "input", mediaType: "text/plain; charset=utf-8", bytes: 14 },
          path: path.join(inputs, "fact.txt"),
        }],
        hash: sha256("inputs-systemd"),
      },
    };
    const socket = net.createServer(() => {});
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(request.protocol.socketPath, resolve);
    });
    const entry = path.join(path.dirname(root), "sandbox-worker.mjs");
    await fs.promises.writeFile(entry, `
      import fs from "node:fs";
      const at = process.argv.indexOf("--config");
      const config = JSON.parse(fs.readFileSync(process.argv[at + 1], "utf8"));
      const fact = fs.readFileSync(config.request.inputs.entries[0].path, "utf8");
      fs.writeFileSync(config.request.workspace.root + "/edited.txt", fact);
      fs.writeFileSync("/outputs/evidence.txt", "sandbox output\\n");
      fs.writeFileSync(config.resultPath, JSON.stringify({
        outcome: "yielded", clean: true, meaningfulProgress: true,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, providerRequests: 0, cost: 0, elapsedMs: 1, complete: true },
        transcriptComplete: true,
      }) + "\\n");
    `);
    const cycles = new SystemdSandboxedSdkCycleExecutor({ entryPath: entry });
    const handle = await cycles.start(request, { emit: async () => {} });
    try {
      await expect(handle.wait()).resolves.toMatchObject({ outcome: "yielded", meaningfulProgress: true });
      expect(await fs.promises.readFile(path.join(candidate, "edited.txt"), "utf8")).toBe("mounted input\n");
      expect(await fs.promises.readFile(path.join(root, "outputs", request.executionId, "evidence.txt"), "utf8"))
        .toBe("sandbox output\n");
    } finally {
      await handle.dispose?.();
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
  }, 30_000);

  it("runs raw candidate commands with the network namespace unshared", async () => {
    const root = await workerRoot();
    const candidate = path.join(root, "candidate-command");
    await fs.promises.mkdir(candidate);
    const mediator = new HostAgentMediatedToolExecutor();
    const script = [
      'require("node:fs").writeFileSync("edited.txt", "edited\\n")',
      'const socket=require("node:net").connect({host:"1.1.1.1",port:443})',
      'socket.on("connect",()=>process.exit(9))',
      'socket.on("error",()=>process.exit(0))',
      'setTimeout(()=>process.exit(0),500)',
    ].join(";");
    const response = await mediator.execute({
      toolName: "workspace_command",
      toolCallId: "networkless-command",
      payload: { argv: [process.execPath, "-e", script], timeoutMs: 5_000 },
      runDir: root,
      executionId: "execution-worker-1",
      operationId: "operation-worker",
      attemptId: "attempt-worker-1",
      outputRoot: path.join(root, "outputs", "execution-worker-1"),
      workspace: { mode: "candidate", root: candidate, cwd: candidate },
      safety: runRecord().safety,
      signal: new AbortController().signal,
    });
    expect(response).toMatchObject({ ok: true, exitCode: 0, network: "unshared", unitCleaned: true });
    expect(await fs.promises.readFile(path.join(candidate, "edited.txt"), "utf8")).toBe("edited\n");
  }, 30_000);

  it("stops the mediated command unit when its owning signal is cancelled", async () => {
    const root = await workerRoot();
    const candidate = path.join(root, "candidate-command-cancel");
    await fs.promises.mkdir(candidate);
    const mediator = new HostAgentMediatedToolExecutor();
    const controller = new AbortController();
    const script = [
      'require("node:fs").writeFileSync("started.txt", "started\\n")',
      'setTimeout(()=>{require("node:fs").writeFileSync("late.txt", "late\\n");process.exit(0)},5000)',
    ].join(";");
    const execution = mediator.execute({
      toolName: "workspace_command",
      toolCallId: "cancel-command",
      payload: { argv: [process.execPath, "-e", script], timeoutMs: 10_000 },
      runDir: root,
      executionId: "execution-worker-cancel",
      operationId: "operation-worker-cancel",
      attemptId: "attempt-worker-cancel",
      outputRoot: path.join(root, "outputs", "execution-worker-cancel"),
      workspace: { mode: "candidate", root: candidate, cwd: candidate },
      safety: runRecord().safety,
      signal: controller.signal,
    });
    for (let retry = 0; retry < 100; retry += 1) {
      if (fs.existsSync(path.join(candidate, "started.txt"))) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(path.join(candidate, "started.txt"))).toBe(true);
    controller.abort(new Error("test cancelled command"));
    await expect(execution).rejects.toThrow(/test cancelled command/);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(fs.existsSync(path.join(candidate, "late.txt"))).toBe(false);
  }, 30_000);

  it("caps mediated command duration with the stored run safety", async () => {
    const root = await workerRoot();
    const candidate = path.join(root, "candidate-command-timeout");
    await fs.promises.mkdir(candidate);
    const mediator = new HostAgentMediatedToolExecutor();
    const safety = { ...runRecord().safety, commandTimeoutMs: 100 };
    const response = await mediator.execute({
      toolName: "workspace_command",
      toolCallId: "safety-timeout-command",
      payload: { argv: ["/usr/bin/sleep", "5"], timeoutMs: 10_000 },
      runDir: root,
      executionId: "execution-worker-timeout",
      operationId: "operation-worker-timeout",
      attemptId: "attempt-worker-timeout",
      outputRoot: path.join(root, "outputs", "execution-worker-timeout"),
      workspace: { mode: "candidate", root: candidate, cwd: candidate },
      safety,
      signal: new AbortController().signal,
    });
    expect(response).toMatchObject({ ok: false, timedOut: true, unitCleaned: true });
  }, 30_000);
});

describe("private coordinator agent protocol", () => {
  it("persists infrastructure recovery and pauses the operation exactly at three receiptless strikes", async () => {
    const fixture = await protocolFixture();
    fixture.database.recordAgentInfrastructureRetry({
      expectedRevision: fixture.database.readRun().revision,
      agentSessionId: fixture.agentSessionId,
      executionId: fixture.executionId,
      reason: {
        category: "infrastructure",
        code: "worker-killed",
        summary: "worker killed",
        retryable: true,
        operationId: fixture.operationId,
      },
      meaningfulProgress: false,
      at: NOW,
    });
    expect(fixture.database.readAgentSession(fixture.agentSessionId)).toMatchObject({
      receiptlessStrikes: 0,
      progress: { retries: 1 },
    });
    for (let strike = 1; strike <= 3; strike += 1) {
      const session = fixture.database.settleAgentYield({
        expectedRevision: fixture.database.readRun().revision,
        agentSessionId: fixture.agentSessionId,
        executionId: fixture.executionId,
        meaningfulProgress: false,
        at: new Date(Date.parse(NOW) + strike * 1_000).toISOString(),
      });
      expect(session.receiptlessStrikes).toBe(strike);
    }
    expect(fixture.database.readAgentSession(fixture.agentSessionId)?.status).toBe("paused");
    expect(fixture.database.readAttempt(fixture.attemptId)?.status).toBe("paused");
    expect(fixture.database.readOperation(fixture.operationId)?.status).toBe("paused");
    expect(fixture.database.readRun().status).toBe("paused");
    fixture.database.close();
  });

  it("authenticates, retries invalid finish arguments, commits before ack, and reconciles a post-finish crash", async () => {
    const fixture = await protocolFixture();
    const observed: AgentEvent[] = [];
    const evidence = new AgentEvidenceLog(fixture.runDir, {
      executionId: fixture.executionId,
      operationId: fixture.operationId,
      attemptId: fixture.attemptId,
    });
    await evidence.initialize();
    const clock = monotonicClock();
    const server = new AgentProtocolServer(fixture.runDir, fixture.database, {
      now: clock,
      eventSink: { emit: async (event) => { observed.push(event); await evidence.emit(event); } },
      resourceSampler: async () => ({ cpuUsec: 250, memoryCurrentBytes: 4_096, tasksCurrent: 3, tasksPeak: 4 }),
    });
    await server.start();
    const socketStat = await fs.promises.lstat(server.socketPath);
    expect(socketStat.isSocket()).toBe(true);
    expect(socketStat.mode & 0o077).toBe(0);
    const token = "a".repeat(64);
    const outputSchema = {
      type: "object",
      properties: { answer: { type: "integer" } },
      required: ["answer"],
      additionalProperties: false,
    };
    const handle = await server.authorize({
      executionId: fixture.executionId,
      agentSessionId: fixture.agentSessionId,
      operationId: fixture.operationId,
      attemptId: fixture.attemptId,
      outputSchema,
      resultMode: "value-and-artifact",
      maximumArtifactBytes: 1024 * 1024,
      executionToken: token,
    });
    await expect(AgentProtocolClient.connect({
      socketPath: handle.socketPath,
      executionId: fixture.executionId,
      executionToken: "b".repeat(64),
    })).rejects.toThrow(/authentication/i);

    const client = await AgentProtocolClient.connect({
      socketPath: handle.socketPath,
      executionId: fixture.executionId,
      executionToken: token,
    });
    await client.emit(eventFor(fixture, 1, "execution-start"));
    expect(observed).toHaveLength(1);
    expect(fixture.database.readAgentSession(fixture.agentSessionId)?.progress.resources).toEqual({
      cpuUsec: 250,
      memoryCurrentBytes: 4_096,
      tasksCurrent: 3,
      tasksPeak: 4,
    });
    expect((await readAgentConversationTailPage(fixture.runDir, fixture.executionId)).events).toHaveLength(1);
    await client.request("report_progress", "progress-1", {
      message: "Inspecting",
      current: 1,
      total: 2,
      metrics: [{ name: "files", value: 3, unit: "count" }],
    });
    expect(fixture.database.readAgentSession(fixture.agentSessionId)?.progress).toMatchObject({
      message: "Inspecting",
      current: 1,
      total: 2,
    });
    await client.request("log_result", "log-1", { message: "Found the durable boundary" });
    expect(fixture.database.listAgentProgress(fixture.agentSessionId).map((entry) => entry.event.type))
      .toEqual(["observed", "report", "log"]);

    const outputRoot = path.join(fixture.runDir, "outputs", fixture.executionId);
    await fs.promises.writeFile(path.join(outputRoot, "report.txt"), "durable evidence", "utf8");
    const outside = path.join(fixture.root, "outside.txt");
    await fs.promises.writeFile(outside, "outside", "utf8");
    await fs.promises.symlink(outside, path.join(outputRoot, "escape.txt"));
    await expect(client.request("publish_artifact", "publish-traversal", { path: "../outside.txt" }))
      .rejects.toThrow(/escapes/i);
    await expect(client.request("publish_artifact", "publish-symlink", { path: "escape.txt" }))
      .rejects.toThrow(/symbolic link/i);
    const publication = await client.request("publish_artifact", "publish-1", {
      path: "report.txt",
      name: "report",
      format: "text",
    });
    expect(publication).toMatchObject({ artifact: { kind: "agent-published", mediaType: "text/plain; charset=utf-8" } });
    const inlinePublication = await client.request("publish_artifact", "call_inline|fc_provider-owned", {
      content: "inline durable evidence",
      name: "inline-report",
      format: "text",
    });
    expect(inlinePublication).toMatchObject({ artifact: { kind: "agent-published", mediaType: "text/plain; charset=utf-8" } });
    await expect(client.request("publish_artifact", "publish-ambiguous", {
      path: "report.txt",
      content: "ambiguous",
      format: "text",
    })).rejects.toThrow(/exactly one/i);

    await expect(client.request("finish_work", "finish-1", { answer: "wrong" }))
      .rejects.toThrow(/operation schema/i);
    const acknowledged = await client.request("finish_work", "finish-1", { answer: 42 });
    const separateReader = RunDatabaseReader.open(path.join(fixture.runDir, "run.sqlite"));
    expect(separateReader.readAgentSession(fixture.agentSessionId)?.finish).toMatchObject({
      toolCallId: "finish-1",
      value: { answer: 42 },
      artifacts: [
        expect.objectContaining({ kind: "agent-published" }),
        expect.objectContaining({ kind: "agent-published" }),
      ],
    });
    separateReader.close();

    const revision = fixture.database.readRun().revision;
    expect(await client.request("finish_work", "finish-1", { answer: 42 })).toEqual(acknowledged);
    expect(fixture.database.readRun().revision).toBe(revision);
    await expect(client.request("finish_work", "finish-1", { answer: 43 }))
      .rejects.toThrow(/conflicting duplicate/i);

    const crashEntry = path.join(fixture.root, "crash-worker.mjs");
    await fs.promises.writeFile(crashEntry, "process.exit(9);\n", "utf8");
    const executor = new SdkAgentWorkerExecutor({ entryPath: crashEntry });
    const execution = await executor.start(executionRequestForFixture(fixture, handle, outputSchema), {
      emit: async () => {},
    });
    await expect(execution.wait()).resolves.toMatchObject({
      outcome: "finished",
      finish: { toolCallId: "finish-1", value: { answer: 42 } },
      transcriptComplete: false,
    });

    // The worker can disappear immediately after the ack. SQLite remains authority.
    await client.close();
    await server.close();
    expect(await evidence.finalize()).toMatchObject({ events: 1, digest: expect.stringMatching(/^sha256:/) });
    const reconciled = RunDatabaseReader.open(path.join(fixture.runDir, "run.sqlite"));
    expect(reconciled.readAgentSession(fixture.agentSessionId)?.finish?.toolCallId).toBe("finish-1");
    reconciled.close();
    fixture.database.close();
  });

  it("mediates research independently from candidate command mutation", async () => {
    const fixture = await protocolFixture();
    const candidate = path.join(fixture.runDir, "workspaces", "candidates", "mediated", "project");
    await fs.promises.mkdir(candidate, { recursive: true });
    const calls: string[] = [];
    const server = new AgentProtocolServer(fixture.runDir, fixture.database, {
      mediatedTools: {
        cancel: async () => {},
        execute: async (request) => {
          expect(fixture.database.readAgentMediatedToolIntent(fixture.agentSessionId, request.toolCallId))
            .toMatchObject({ status: "started", toolName: request.toolName });
          expect(fixture.database.readAgentToolReceipt(fixture.agentSessionId, request.toolCallId)).toBeUndefined();
          expect(request.safety).toEqual(runRecord().safety);
          calls.push(request.toolName);
          if (request.toolName === "web_search") return { results: [{ title: "Primary", url: "https://example.test/" }] } as JsonValue;
          if (request.toolName === "workspace_command") {
            await fs.promises.writeFile(path.join(request.workspace.root, "edited.txt"), "candidate edit\n");
            return { ok: true, network: "unshared" } as JsonValue;
          }
          throw new Error("unexpected mediator call");
        },
      },
    });
    await server.start();
    const token = "c".repeat(64);
    const authority = await server.authorize({
      executionId: fixture.executionId,
      agentSessionId: fixture.agentSessionId,
      operationId: fixture.operationId,
      attemptId: fixture.attemptId,
      resultMode: "value",
      executionToken: token,
      workspace: { mode: "candidate", root: candidate, cwd: candidate },
      network: "research",
    });
    const client = await AgentProtocolClient.connect({
      socketPath: authority.socketPath,
      executionId: fixture.executionId,
      executionToken: token,
    });
    expect(await client.request("web_search", "search-1", { query: "durable systems", maxResults: 3 }))
      .toMatchObject({ results: [{ url: "https://example.test/" }] });
    const revisionAfterSearch = fixture.database.readRun().revision;
    expect(await client.request("web_search", "search-1", { query: "durable systems", maxResults: 3 }))
      .toMatchObject({ results: [{ url: "https://example.test/" }] });
    expect(fixture.database.readRun().revision).toBe(revisionAfterSearch);
    expect(await client.request("workspace_command", "command-1", { argv: ["printf", "candidate"] }))
      .toEqual({ ok: true, network: "unshared" });
    expect(await fs.promises.readFile(path.join(candidate, "edited.txt"), "utf8")).toBe("candidate edit\n");
    expect(calls).toEqual(["web_search", "workspace_command"]);
    expect(fixture.database.listAgentToolReceipts(fixture.agentSessionId).map((receipt) => receipt.toolName))
      .toEqual(["web_search", "workspace_command"]);
    expect(fixture.database.readAgentMediatedToolIntent(fixture.agentSessionId, "search-1"))
      .toMatchObject({ status: "completed", completedAt: expect.any(String) });
    expect(fixture.database.readAgentMediatedToolIntent(fixture.agentSessionId, "command-1"))
      .toMatchObject({ status: "completed", completedAt: expect.any(String) });
    await client.close();
    await server.close();
    fixture.database.close();
  });

  it("quarantines a crash-left mediated intent instead of executing it again", async () => {
    const fixture = await protocolFixture();
    const candidate = path.join(fixture.runDir, "workspaces", "candidates", "uncertain", "project");
    await fs.promises.mkdir(candidate, { recursive: true });
    const payload = { argv: ["sh", "-c", "printf changed > value.txt"] } as JsonValue;
    const requestHash = stableHash({ protocolVersion: 1, toolName: "workspace_command", payload });
    fixture.database.startAgentMediatedTool({
      expectedRevision: fixture.database.readRun().revision,
      agentSessionId: fixture.agentSessionId,
      executionId: fixture.executionId,
      toolCallId: "command-crash",
      toolName: "workspace_command",
      requestHash,
      startedAt: NOW,
    });
    // This is the state left by a coordinator death after dispatch and before receipt commit.
    await fs.promises.writeFile(path.join(candidate, "value.txt"), "changed\n", "utf8");

    let executions = 0;
    const cancelled: string[] = [];
    const server = new AgentProtocolServer(fixture.runDir, fixture.database, {
      mediatedTools: {
        execute: async () => { executions += 1; return { ok: true }; },
        cancel: async (request) => { cancelled.push(request.toolCallId); },
      },
    });
    await server.start();
    await expect(server.authorize({
      executionId: fixture.executionId,
      agentSessionId: fixture.agentSessionId,
      operationId: fixture.operationId,
      attemptId: fixture.attemptId,
      resultMode: "value",
      executionToken: "d".repeat(64),
      workspace: { mode: "candidate", root: candidate, cwd: candidate },
    })).rejects.toThrow(/without a durable receipt/i);

    expect(executions).toBe(0);
    expect(cancelled).toEqual(["command-crash"]);
    expect(fixture.database.readAgentMediatedToolIntent(fixture.agentSessionId, "command-crash"))
      .toMatchObject({
        status: "uncertain",
        reason: { code: "mediated-tool-outcome-uncertain", retryable: false },
      });
    expect(fixture.database.readAgentToolReceipt(fixture.agentSessionId, "command-crash")).toBeUndefined();
    expect(fixture.database.readAgentSession(fixture.agentSessionId)?.status).toBe("paused");
    expect(fixture.database.readOperation(fixture.operationId)?.status).toBe("paused");
    expect(fixture.database.readRun().status).toBe("paused");
    expect(await fs.promises.readFile(path.join(candidate, "value.txt"), "utf8")).toBe("changed\n");

    await server.close();
    fixture.database.close();
  });

  it("cancels an in-flight mediated effect with its owning execution", async () => {
    const fixture = await protocolFixture();
    const candidate = path.join(fixture.runDir, "workspaces", "candidates", "cancelled", "project");
    await fs.promises.mkdir(candidate, { recursive: true });
    const owner = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const cancelled: string[] = [];
    const server = new AgentProtocolServer(fixture.runDir, fixture.database, {
      mediatedTools: {
        execute: async (request) => {
          entered();
          await new Promise<never>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
          });
          return null;
        },
        cancel: async (request) => { cancelled.push(request.toolCallId); },
      },
    });
    await server.start();
    const token = "e".repeat(64);
    const authority = await server.authorize({
      executionId: fixture.executionId,
      agentSessionId: fixture.agentSessionId,
      operationId: fixture.operationId,
      attemptId: fixture.attemptId,
      resultMode: "value",
      executionToken: token,
      workspace: { mode: "candidate", root: candidate, cwd: candidate },
      signal: owner.signal,
    });
    const client = await AgentProtocolClient.connect({
      socketPath: authority.socketPath,
      executionId: fixture.executionId,
      executionToken: token,
    });
    const request = client.request("workspace_command", "command-cancel", { argv: ["sleep", "60"] });
    await started;
    owner.abort(new Error("scope stopped"));
    await expect(request).rejects.toThrow(/without a durable receipt/i);

    expect(cancelled).toEqual(["command-cancel"]);
    expect(fixture.database.readAgentMediatedToolIntent(fixture.agentSessionId, "command-cancel"))
      .toMatchObject({ status: "uncertain", reason: { code: "mediated-tool-outcome-uncertain" } });
    expect(fixture.database.readRun().status).toBe("paused");

    await client.close();
    await server.close();
    fixture.database.close();
  });
});

class FakeProtocol implements AgentWorkerProtocol {
  readonly events: AgentEvent[] = [];
  constructor(private readonly respond: (toolName: string, toolCallId: string, payload: JsonValue) => JsonValue) {}
  async request(toolName: any, toolCallId: string, payload: JsonValue): Promise<JsonValue> {
    return this.respond(toolName, toolCallId, payload);
  }
  async emit(event: AgentEvent): Promise<void> { this.events.push(event); }
  async close(): Promise<void> {}
  async [Symbol.asyncDispose](): Promise<void> {}
}

class ScriptedCycles implements AgentWorkerCycleExecutor {
  readonly requests: AgentExecutionRequest[] = [];
  constructor(private readonly results: AgentExecutionResult[]) {}
  async start(request: AgentExecutionRequest): Promise<AgentExecutionHandle> {
    this.requests.push(structuredClone(request));
    const result = this.results.shift();
    if (!result) throw new Error("Unexpected supervised worker cycle");
    return {
      wait: async () => structuredClone(result),
      cancel: async () => {},
    };
  }
}

class MemorySupervisionStore implements AgentSupervisionStore {
  strikes = 0;
  retries = 0;
  paused = false;
  yields: boolean[] = [];
  async read() { return { receiptlessStrikes: this.strikes, status: this.paused ? "paused" as const : "running" as const }; }
  async settleYield(progress: boolean) {
    this.yields.push(progress);
    this.strikes = progress ? 0 : Math.min(3, this.strikes + 1);
    this.paused ||= this.strikes === 3;
    return { receiptlessStrikes: this.strikes, status: this.paused ? "paused" as const : "running" as const };
  }
  async recordInfrastructureRetry(_reason?: unknown, meaningfulProgress = false) {
    this.retries += 1;
    if (meaningfulProgress) this.strikes = 0;
  }
  async pauseInfrastructure() { this.paused = true; }
}

class BlockingCycles implements AgentWorkerCycleExecutor {
  cancelReason?: string;
  private release!: (result: AgentExecutionResult) => void;
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
  async start(): Promise<AgentExecutionHandle> {
    const result = new Promise<AgentExecutionResult>((resolve) => { this.release = resolve; });
    this.markStarted();
    return {
      wait: async () => await result,
      cancel: async (reason) => {
        this.cancelReason = reason;
        this.release({ outcome: "stopped", usage: zeroUsage(), transcriptComplete: false });
      },
    };
  }
}

function yielded(meaningfulProgress: boolean): AgentExecutionResult {
  return { outcome: "yielded", clean: true, meaningfulProgress, usage: zeroUsage(), transcriptComplete: true };
}

function finished(result: string): AgentExecutionResult {
  return {
    outcome: "finished",
    finish: {
      toolCallId: "finish-supervised",
      schemaHash: sha256("finish-schema"),
      value: { result },
      artifacts: [],
      committedAt: NOW,
    },
    usage: zeroUsage(),
    transcriptComplete: true,
  };
}

function retryFailure(
  category: "provider" | "infrastructure",
  code: string,
  meaningfulProgress = false,
): AgentExecutionResult {
  return {
    outcome: "failed",
    reason: { category, code, summary: code, retryable: true, operationId: "operation-worker" },
    meaningfulProgress,
    usage: zeroUsage(),
    transcriptComplete: false,
  };
}

function argumentPair(argv: string[], option: string, source: string): string[] | undefined {
  const at = argv.findIndex((value, index) => value === option && argv[index + 1] === source);
  return at < 0 ? undefined : argv.slice(at, at + 3);
}

async function workerRoot(): Promise<string> {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sdk-agent-worker-"));
  roots.push(parent);
  const runDir = path.join(parent, RUN_ID);
  await fs.promises.mkdir(runDir, { mode: 0o700 });
  return runDir;
}

function workerRequest(runDir: string): AgentExecutionRequest {
  const schema = { type: "object", additionalProperties: false };
  const executionId = "execution-worker-1";
  return {
    runId: RUN_ID,
    operationId: "operation-worker",
    operationPath: "run/agent:worker",
    attemptId: "attempt-worker-1",
    executionId,
    profile: {
      id: "builtin:test",
      name: "test",
      description: "test",
      instructions: "Do the exact task.",
      allowedTools: ["read"],
      hash: sha256("profile"),
      sourcePath: "<builtin:test>",
    },
    route: {
      id: "route:test",
      profileId: "builtin:test",
      provider: "test",
      model: "test/model",
      thinking: "off",
      hash: sha256("route"),
    },
    tools: [{
      name: "read",
      schemaHash: stableHash(schema).slice(7),
      mutatesWorkspace: false,
      usesMediatedNetwork: false,
    }],
    network: "none",
    resultMode: "value",
    workspace: {
      mode: "read-only",
      root: runDir,
      cwd: runDir,
      preTreeHash: sha256("tree"),
      workspace: { kind: "snapshot", workspaceId: "snapshot-1", treeHash: sha256("tree") },
    },
    inputs: { root: path.join(runDir, "inputs"), entries: [], hash: sha256("inputs") },
    context: { entries: [], hash: sha256("context") },
    protocol: { socketPath: path.join(runDir, "agent-protocol.sock"), executionToken: "a".repeat(64) },
    semanticCallKey: sha256("call"),
    safety: runRecord().safety,
    instruction: { kind: "initial-task", task: "Return an answer" },
    session: {
      agentSessionId: "agent-session-worker",
      piSessionPath: `sessions/${executionId}/session.jsonl`,
      resume: false,
    },
  };
}

async function protocolFixture() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sdk-agent-protocol-"));
  roots.push(root);
  const runDir = path.join(root, RUN_ID);
  await fs.promises.mkdir(runDir, { mode: 0o700 });
  const database = RunDatabase.create(path.join(runDir, "run.sqlite"), { run: { ...runRecord(), status: "running" } });
  const operationId = "operation-protocol";
  const attemptId = "attempt-protocol-1";
  const executionId = "execution-protocol-1";
  const agentSessionId = "agent-session-protocol";
  const operation: OperationRecord = {
    operationId,
    runId: RUN_ID,
    path: "run/agent:protocol",
    sourceId: "protocol",
    kind: "agent",
    ordinal: 0,
    status: "running",
    semanticInputHash: sha256("semantic"),
    attemptCount: 0,
    createdAt: NOW,
    startedAt: NOW,
    updatedAt: NOW,
  };
  database.insertOperation(1, operation, { type: "operation-started", operationId, payload: {}, at: NOW });
  const attempt: AttemptRecord = {
    attemptId,
    runId: RUN_ID,
    operationId,
    number: 1,
    effect: "agent",
    executionId,
    status: "running",
    usage: zeroUsage(),
    outputArtifacts: [],
    startedAt: NOW,
    updatedAt: NOW,
  };
  database.insertAttempt(2, attempt, { type: "attempt-started", operationId, attemptId, payload: {}, at: NOW });
  const session: AgentSessionRecord = {
    agentSessionId,
    runId: RUN_ID,
    operationId,
    profileId: "builtin:test",
    routeId: "route:test",
    piSessionPath: `sessions/${executionId}/session.jsonl`,
    workspace: { kind: "snapshot", workspaceId: "snapshot-1", treeHash: sha256("tree") },
    network: "none",
    status: "running",
    receiptlessStrikes: 0,
    currentExecutionId: executionId,
    progress: {
      metrics: [],
      usage: zeroUsage(),
      modelTurn: 0,
      toolCount: 0,
      retries: 0,
      workspaceChanged: false,
      workspaceChangeCount: 0,
      recentWorkspaceChanges: [],
      updatedAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
  database.createAgentSession(3, session, { type: "agent-session-started", operationId, attemptId, payload: {}, at: NOW });
  return { root, runDir, database, operationId, attemptId, executionId, agentSessionId };
}

function eventFor(fixture: Awaited<ReturnType<typeof protocolFixture>>, sequence: number, type: "execution-start"): AgentEvent {
  return {
    type,
    executionId: fixture.executionId,
    operationId: fixture.operationId,
    attemptId: fixture.attemptId,
    sequence,
    at: NOW,
    pid: process.pid,
  };
}

function executionRequestForFixture(
  fixture: Awaited<ReturnType<typeof protocolFixture>>,
  protocol: AgentExecutionRequest["protocol"],
  outputSchema: NonNullable<AgentExecutionRequest["outputSchema"]>,
): AgentExecutionRequest {
  const base = workerRequest(fixture.runDir);
  return {
    ...base,
    operationId: fixture.operationId,
    operationPath: "run/agent:protocol",
    attemptId: fixture.attemptId,
    executionId: fixture.executionId,
    outputSchema,
    resultMode: "value-and-artifact",
    protocol,
    instruction: { kind: "initial-task", task: "This process will crash after the committed finish" },
    session: {
      agentSessionId: fixture.agentSessionId,
      piSessionPath: `sessions/${fixture.executionId}/session.jsonl`,
      resume: false,
    },
  };
}

function runRecord(): RunRecord {
  return {
    runId: RUN_ID,
    revision: 1,
    workflow: {
      id: "builtin:test",
      name: "test",
      sourceHash: sha256("source"),
      definitionHash: sha256("definition"),
      capabilities: ["read-project"],
    },
    invocationHash: sha256("invocation"),
    projectSnapshotHash: sha256("project"),
    routeSnapshotHash: sha256("routes"),
    contextIdentityHash: sha256("context"),
    status: "queued",
    safety: {
      concurrency: 4,
      maximumAgentLaunches: 100,
      memoryBytes: 2 ** 30,
      tasks: 256,
      cpuQuotaPercent: 400,
      cpuWeight: 100,
      outputBytes: 8 * 1024 * 1024,
      commandTimeoutMs: 60_000,
    },
    usage: zeroUsage(),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function zeroUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    providerRequests: 0,
    cost: 0,
    elapsedMs: 0,
    complete: true,
  };
}

function monotonicClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.parse(NOW) + tick++ * 1000);
}
