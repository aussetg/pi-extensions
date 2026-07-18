import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SessionManager,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentEvent,
  AgentExecutionRequest,
} from "../src/agents/executor.js";
import type { AgentWorkerProtocol } from "../src/agents/sdk-protocol.js";
import { runSdkAgentWorker } from "../src/agents/sdk-worker.js";
import type { JsonValue } from "../src/types.js";
import { sha256, stableHash } from "../src/utils/hashes.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

describe("SDK agent worker", () => {
  it("uses the isolated ModelRuntime expected by the current Pi SDK", async () => {
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "workflow-sdk-worker-"));
    roots.push(parent);
    const runDir = path.join(parent, "run-worker");
    const agentDir = path.join(parent, "agent");
    await Promise.all([
      fs.promises.mkdir(runDir, { mode: 0o700 }),
      fs.promises.mkdir(agentDir, { mode: 0o700 }),
    ]);
    const request = workerRequest(runDir);
    const protocol = new FakeProtocol();
    let captured: CreateAgentSessionOptions | undefined;

    const result = await runSdkAgentWorker({ runDir, agentDir, request }, {
      protocol,
      resolveModel: () => ({ provider: "test", id: "model" }) as NonNullable<CreateAgentSessionOptions["model"]>,
      openSessionManager: () => SessionManager.inMemory(runDir),
      createSession: async options => {
        captured = options;
        return {
          extensionsResult: { extensions: [], errors: [] },
          session: {
            subscribe: () => () => {},
            prompt: async () => {},
            dispose: () => {},
            getActiveToolNames: () => options.tools!,
            getAllTools: () => [
              { name: "read", parameters: { type: "object", additionalProperties: false } },
              ...["finish_work", "report_progress", "log_result", "publish_artifact"]
                .map(name => ({ name, parameters: {} })),
            ],
            model: { provider: "test", id: "model" },
            thinkingLevel: "off",
            messages: [],
            agent: { continue: async () => {} },
          },
        };
      },
    });

    expect(result.outcome).toBe("yielded");
    expect(captured?.modelRuntime).toBeDefined();
    expect(captured).not.toHaveProperty("authStorage");
    expect(captured).not.toHaveProperty("modelRegistry");
    expect(captured?.resourceLoader?.getExtensions().extensions).toEqual([]);
    expect(protocol.events.some(event => event.type === "termination")).toBe(true);
  });
});

class FakeProtocol implements AgentWorkerProtocol {
  readonly events: AgentEvent[] = [];

  async request(_toolName: string, _toolCallId: string, _payload: JsonValue): Promise<JsonValue> {
    throw new Error("No protocol request expected");
  }

  async emit(event: AgentEvent): Promise<void> { this.events.push(event); }
  async close(): Promise<void> {}
  async [Symbol.asyncDispose](): Promise<void> {}
}

function workerRequest(runDir: string): AgentExecutionRequest {
  const parameters = { type: "object", additionalProperties: false };
  const treeHash = sha256("tree");
  return {
    runId: path.basename(runDir),
    operationId: "operation-worker",
    operationPath: "run/000000",
    attemptId: "attempt-worker",
    executionId: "execution-worker",
    profile: {
      id: "builtin:test",
      name: "test",
      description: "Test profile",
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
      schemaHash: stableHash(parameters).slice(7),
      mutatesWorkspace: false,
      usesMediatedNetwork: false,
    }],
    network: "none",
    workspace: {
      mode: "read-only",
      root: runDir,
      cwd: runDir,
      preTreeHash: treeHash,
      workspace: { kind: "snapshot", workspaceId: "snapshot-worker", treeHash },
    },
    inputs: { root: path.join(runDir, "inputs"), entries: [], hash: sha256("inputs") },
    context: { entries: [], hash: sha256("context") },
    protocol: { socketPath: path.join(runDir, "protocol.sock"), executionToken: "a".repeat(64) },
    semanticCallKey: sha256("call"),
    safety: {
      concurrency: 2,
      maximumAgentLaunches: 8,
      memoryBytes: 512 * 1024 * 1024,
      tasks: 64,
      cpuQuotaPercent: 200,
      cpuWeight: 100,
      outputBytes: 8 * 1024 * 1024,
      commandTimeoutMs: 60_000,
    },
    instruction: { kind: "initial-task", task: "Return an answer" },
    session: {
      agentSessionId: "agent-session-worker",
      piSessionPath: "sessions/execution-worker/session.jsonl",
      resume: false,
    },
  };
}
