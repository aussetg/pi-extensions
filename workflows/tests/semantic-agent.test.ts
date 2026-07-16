import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentProtocolClient } from "../src/agents/sdk-protocol.js";
import { SemanticAgentAdapter } from "../src/agents/semantic-adapter.js";
import {
  ScriptedAgentExecutor,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type AgentExecutorDescriptor,
  type AgentProfileSnapshot,
  type AgentRouteSnapshot,
  type AgentToolDescriptor,
} from "../src/agents/executor.js";
import { agentCallProvenance } from "../src/agents/call-identity.js";
import type { PreparedWorkflowExecutionResources } from "../src/agents/resources.js";
import { CandidateWorkspaceManager } from "../src/candidates/store.js";
import { parseStructuredWorkflow } from "../src/definition/workflow-definition.js";
import { RunDatabase } from "../src/persistence/run-database.js";
import type { OperationRecord, RunRecord } from "../src/runtime/durable-types.js";
import {
  executeSequentialSemanticRun,
  semanticInvocationHash,
  SemanticEngineCrashError,
  type SequentialSemanticEngineOptions,
  type SemanticEngineInvocation,
  type SemanticEffectRequest,
} from "../src/runtime/semantic-engine.js";
import { buildWorkflowCallKey, WORKFLOW_JOURNAL_ROOT_KEY } from "../src/persistence/workflow-journal.js";
import type { JsonValue } from "../src/types.js";
import { sha256, stableHash } from "../src/utils/hashes.js";
import { stableJson } from "../src/utils/stable-json.js";
import { captureProjectSnapshot } from "../src/workspaces/project-snapshot.js";

const roots: string[] = [];
const databases: RunDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) {
    await makeWritable(root).catch(() => undefined);
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

describe("semantic flow.agent adapter", () => {
  it("uses only finish_work for text, structured, artifact, and input results", async () => {
    const source = workflow(`
      const produced = await flow.agent("produce", {
        profile: "builtin:test",
        prompt: "Publish evidence.",
        resultMode: "value-and-artifact",
      });
      const answer = await flow.agent("consume", {
        profile: "builtin:test",
        prompt: "Use the evidence.",
        inputs: [{ id: "evidence", artifact: produced.artifact }],
        outputSchema: {
          type: "object", additionalProperties: false, required: ["answer"],
          properties: { answer: { type: "string" } },
        },
      });
      return { produced: produced.value, answer: answer.answer };
    `, `{ type: "object", required: ["produced", "answer"] }`);
    let calls = 0;
    const executor = scripted(async (request) => {
      calls++;
      if (request.operationPath.endsWith("agent:produce")) {
        return await committedFinish(request, { result: "receipt text" }, {
          artifact: { name: "evidence", contents: "durable evidence\n", format: "text" },
          assistantText: '{"result":"wrong final prose"}',
        });
      }
      expect(await fs.promises.readFile(request.inputs.entries[0]!.path, "utf8")).toBe("durable evidence\n");
      return await committedFinish(request, { answer: "from receipt" }, {
        assistantText: '{"answer":"wrong final prose"}',
      });
    });
    const fixture = await createFixture(source, executor);

    const outcome = await fixture.execute();
    expect(outcome).toMatchObject({ status: "completed", result: { produced: "receipt text", answer: "from receipt" } });
    expect(calls).toBe(2);
    const operations = fixture.database.listOperations({ limit: 16 }).filter((operation) => operation.kind === "agent");
    expect(operations.every((operation) => operation.attemptCount === 1 && operation.status === "completed")).toBe(true);
    for (const operation of operations) {
      expect(fixture.database.listOperationArtifacts(operation.operationId, "evidence")).toEqual([
        expect.objectContaining({ kind: "agent-transcript" }),
      ]);
      expect(fixture.database.readAgentSessionByOperation(operation.operationId)).toMatchObject({
        status: "completed",
        finish: { toolCallId: expect.any(String) },
      });
    }
  });

  it("runs parallel agents and represents a deliberate handoff in the finish schema", async () => {
    const source = workflow(`
      const first = await flow.agent("planner", {
        profile: "builtin:test", prompt: "Choose the next worker.",
        outputSchema: {
          type: "object", additionalProperties: false, required: ["outcome", "next"],
          properties: { outcome: { enum: ["handoff", "blocked"] }, next: { type: "string" } },
        },
      });
      if (first.outcome !== "handoff") return { handoff: false, values: [] };
      const branches = await flow.parallel("workers", {
        left: () => flow.agent("left", { profile: "builtin:test", prompt: first.next }),
        right: () => flow.agent("right", { profile: "builtin:test", prompt: first.next }),
      }, { failure: "fail-fast", concurrency: 2 });
      return { handoff: true, values: [branches.left, branches.right] };
    `, `{ type: "object", required: ["handoff", "values"] }`, 2);
    let active = 0;
    let maximum = 0;
    const executor = scripted(async (request) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        if (request.operationPath.endsWith("agent:planner")) {
          return await committedFinish(request, { outcome: "handoff", next: "continue from durable output" });
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        return await committedFinish(request, { result: request.operationPath.endsWith("agent:left") ? "left" : "right" });
      } finally { active--; }
    });
    const fixture = await createFixture(source, executor, { concurrency: 2 });

    expect(await fixture.execute()).toMatchObject({
      status: "completed",
      result: { handoff: true, values: ["left", "right"] },
    });
    expect(maximum).toBe(2);

    let blockedCalls = 0;
    const blocked = await createFixture(source, scripted(async (request) => {
      blockedCalls++;
      return await committedFinish(request, { outcome: "blocked", next: "human input required" });
    }), { concurrency: 2 });
    expect(await blocked.execute()).toMatchObject({
      status: "completed",
      result: { handoff: false, values: [] },
    });
    expect(blockedCalls).toBe(1);
  });

  it("combines candidate edits with mediated research and checkpoints the exact post-tree", async () => {
    const source = workflow(`
      return await flow.candidate("scope", async workspace => {
        const value = await flow.agent("edit", {
          profile: "builtin:test", prompt: "Research and edit.",
          workspace,
          network: "research",
        });
        return { value };
      });
    `, `{ type: "object", required: ["value"] }`, 1, ["read-project", "candidate-write", "mediated-network"]);
    const tools: AgentToolDescriptor[] = [{
      name: "web_search", schemaHash: sha256("web-search-schema").slice(7), mutatesWorkspace: false, usesMediatedNetwork: true,
    }, {
      name: "write", schemaHash: sha256("write-schema").slice(7), mutatesWorkspace: true, usesMediatedNetwork: false,
    }];
    const descriptor = executorDescriptor(tools);
    const executor = scripted(async (request) => {
      expect(request.network).toBe("research");
      expect(request.workspace.mode).toBe("candidate");
      const client = await connect(request);
      try {
        const searched = await client.request("web_search", "tool-search", { query: "phase twenty", maxResults: 3 });
        expect(searched).toEqual({ results: ["source"] });
        await fs.promises.writeFile(path.join(request.workspace.root, "edited.txt"), "candidate only\n");
        return finishResult(await client.request("finish_work", "tool-finish", { result: "edited" }));
      } finally { await client.close(); }
    }, descriptor);
    const fixture = await createFixture(source, executor, { tools });
    const manager = await CandidateWorkspaceManager.open(fixture.runDir, fixture.database);
    const workspace = await manager.create({ logicalId: "shared" });
    fixture.adapterOptions.candidateManager = manager;
    fixture.adapterOptions.mediatedTools = {
      cancel: async () => {},
      execute: async (request) => {
        expect(request.toolName).toBe("web_search");
        return { results: ["source"] };
      },
    };
    const adapter = new SemanticAgentAdapter(fixture.adapterOptions);
    fixture.database.transitionRun(fixture.database.readRun().revision, {
      status: "running",
      startedAt: new Date().toISOString(),
      event: { type: "run-started", payload: {}, at: new Date().toISOString() },
    });
    const admission = {
      run: fixture.database.readRun(),
      kind: "agent" as const,
      sourceId: "edit",
      path: "run/candidate:scope/agent:edit",
      input: { profile: "builtin:test", prompt: "Research and edit.", workspace, network: "research" },
    };
    const semanticInput = await adapter.semanticInput(admission);
    const at = new Date().toISOString();
    const operation: OperationRecord = {
      operationId: `operation_${"e".repeat(32)}`,
      runId: fixture.runId,
      path: admission.path,
      sourceId: "edit",
      kind: "agent",
      ordinal: 0,
      status: "running",
      semanticInputHash: stableHash(semanticInput),
      attemptCount: 0,
      createdAt: at,
      startedAt: at,
      updatedAt: at,
    };
    fixture.database.insertOperation(fixture.database.readRun().revision, operation, {
      type: "operation-started", operationId: operation.operationId, payload: {}, at,
    });
    const request: SemanticEffectRequest = {
      ...admission,
      run: fixture.database.readRun(),
      database: fixture.database,
      operation,
      signal: new AbortController().signal,
    };
    const identity = await adapter.journalIdentity(admission);
    const outcome = await adapter.execute(request);
    const completedAt = new Date().toISOString();
    const journal = {
      runId: fixture.runId,
      operationId: operation.operationId,
      ordinal: 0,
      previousJournalKey: WORKFLOW_JOURNAL_ROOT_KEY,
      semanticKey: identity.semanticKey,
      callKey: buildWorkflowCallKey({ previousJournalKey: WORKFLOW_JOURNAL_ROOT_KEY, operation, semanticKey: identity.semanticKey }),
      completionAuthority: "finish-work" as const,
      replayPolicy: "workspace" as const,
      result: outcome.result,
      postWorkspaceCheckpointId: outcome.workspaceCheckpoint!.checkpointId,
      committedAt: completedAt,
    };
    fixture.database.completeOperation({
      expectedRevision: fixture.database.readRun().revision,
      operationId: operation.operationId,
      attemptId: outcome.attemptId,
      completedAt,
      result: outcome.result,
      usage: outcome.usage!,
      resources: outcome.resources,
      evidenceArtifacts: outcome.evidenceArtifacts,
      workspaceCheckpoint: outcome.workspaceCheckpoint,
      journal,
      event: { type: "operation-completed", payload: {} },
    });
    await adapter.dispose();

    expect(outcome.result.value).toBe("edited");
    const storedOperation = fixture.database.readOperation(operation.operationId)!;
    expect(storedOperation.result?.workspace).toMatchObject({ kind: "candidate" });
    expect(fixture.database.readWorkflowCall(storedOperation.operationId)).toMatchObject({
      replayPolicy: "workspace",
      postWorkspaceCheckpointId: expect.any(String),
    });
    expect(await fs.promises.readFile(path.join((await manager.describe(workspace)).root, "edited.txt"), "utf8"))
      .toBe("candidate only\n");
  });

  it("resumes a finish committed before a coordinator crash without launching a new logical agent", async () => {
    const source = workflow(`
      const answer = await flow.agent("answer", { profile: "builtin:test", prompt: "Answer." });
      return { answer };
    `, `{ type: "object", required: ["answer"] }`);
    let calls = 0;
    const executor = scripted(async (request) => {
      calls++;
      return await committedFinish(request, { result: "durable" });
    });
    const fixture = await createFixture(source, executor);
    let crashed = false;
    await expect(fixture.execute(undefined, {
      faultInjector: (point) => {
        if (!crashed && point === "after-effect-settled") {
          crashed = true;
          throw new Error("coordinator power loss");
        }
      },
    })).rejects.toBeInstanceOf(SemanticEngineCrashError);

    expect(await fixture.execute()).toMatchObject({ status: "completed", result: { answer: "durable" } });
    expect(calls).toBe(1);
    expect(fixture.database.listOperations({ limit: 8 }).find((entry) => entry.kind === "agent")?.attemptCount).toBe(1);
  });

  it("replays an explicit cross-revision prefix without launching the target agent", async () => {
    const root = await temporaryRoot();
    const project = path.join(root, "project");
    await fs.promises.mkdir(project);
    await fs.promises.writeFile(path.join(project, "input.txt"), "same project\n");
    const source = workflow(`
      const answer = await flow.agent("answer", {
        profile: "builtin:test", prompt: "Answer.",
        outputSchema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } },
      });
      return answer;
    `, `{ type: "object", required: ["answer"] }`);
    let calls = 0;
    const executor = scripted(async (request) => {
      calls++;
      return await committedFinish(request, { answer: "replayed" });
    });
    const original = await createFixture(source, executor, { root, project });
    expect((await original.execute()).status).toBe("completed");
    const replay = await createFixture(source, executor, {
      root,
      project,
      replay: { sourceRunId: original.runId },
    });

    expect(await replay.execute(undefined, { replaySourceRunDir: original.runDir })).toMatchObject({
      status: "completed",
      result: { answer: "replayed" },
    });
    expect(calls).toBe(1);
    expect(replay.database.readRun().replay?.matchedCalls).toBe(1);
    expect(replay.database.readAgentSessionByOperation(
      replay.database.listOperations({ limit: 8 }).find((entry) => entry.kind === "agent")!.operationId,
    )).toBeUndefined();
  });

  it("rejects malformed receipt claims and returns collected agent failures as data", async () => {
    const malformed = workflow(`
      await flow.agent("bad", {
        profile: "builtin:test", prompt: "Bad.",
        outputSchema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } },
      });
      return { unreachable: true };
    `, `{ type: "object" }`);
    const fakeFinish = {
      toolCallId: "tool-fake", schemaHash: sha256("wrong"), value: { answer: "assistant prose" }, artifacts: [],
      committedAt: new Date().toISOString(),
    };
    const malformedFixture = await createFixture(malformed, scripted(async () => ({
      outcome: "finished", finish: fakeFinish, usage: zeroUsage(), transcriptComplete: true,
    })));
    expect(await malformedFixture.execute()).toMatchObject({ status: "failed" });

    const collected = workflow(`
      const branches = await flow.parallel("agents", {
        good: () => flow.agent("good", { profile: "builtin:test", prompt: "Good." }),
        bad: () => flow.agent("bad", { profile: "builtin:test", prompt: "Fail." }),
      }, { failure: "collect", concurrency: 2 });
      return { good: branches.good.ok, bad: branches.bad.ok, kind: branches.bad.failure.kind };
    `, `{ type: "object", required: ["good", "bad", "kind"] }`, 2);
    const collectedFixture = await createFixture(collected, scripted(async (request) => {
      if (request.operationPath.endsWith("agent:bad")) return {
        outcome: "failed",
        reason: { category: "provider", code: "provider-blocked", summary: "provider blocked", retryable: false, operationId: request.operationId },
        usage: zeroUsage(), transcriptComplete: true,
      };
      return await committedFinish(request, { result: "ok" });
    }), { concurrency: 2 });
    expect(await collectedFixture.execute()).toMatchObject({
      status: "completed",
      result: { good: true, bad: false, kind: "agent" },
    });
  });
});

interface FixtureOptions {
  root?: string;
  project?: string;
  concurrency?: number;
  tools?: AgentToolDescriptor[];
  replay?: { sourceRunId: string };
}

async function createFixture(source: string, executor: ScriptedAgentExecutor, options: FixtureOptions = {}) {
  const parsed = parseStructuredWorkflow(source);
  const root = options.root ?? await temporaryRoot();
  const project = options.project ?? path.join(root, `project-${Math.random().toString(16).slice(2)}`);
  await fs.promises.mkdir(project, { recursive: true });
  if (!await exists(path.join(project, "input.txt"))) await fs.promises.writeFile(path.join(project, "input.txt"), "project\n");
  const runId = `flow_${stableHash({ source, nonce: Math.random() }).slice(7, 39)}`;
  const runDir = path.join(root, runId);
  await fs.promises.mkdir(path.join(runDir, "context"), { recursive: true, mode: 0o700 });
  for (const directory of ["sessions", "outputs", "artifacts", "workspaces/candidates", "workspaces/checkpoints", "workspaces/overlays"]) {
    await fs.promises.mkdir(path.join(runDir, directory), { recursive: true, mode: 0o700 });
  }
  const manifest = await captureProjectSnapshot(project, project, path.join(runDir, "context", "project"));
  await fs.promises.writeFile(path.join(runDir, "context", "project-manifest.json"), `${stableJson(manifest)}\n`);
  const definitionHash = stableHash({ sourceHash: parsed.sourceHash, metadata: parsed.metadata });
  const invocation: SemanticEngineInvocation = {
    workflowId: "builtin:semantic-agent-fixture", definitionHash, input: {}, inputHash: stableHash({}),
  };
  const tools = options.tools ?? [];
  const resources = resourcesFor(parsed, executor.describe(), tools, project);
  const at = new Date().toISOString();
  const run: RunRecord = {
    runId,
    revision: 1,
    workflow: {
      id: "builtin:semantic-agent-fixture",
      name: parsed.metadata.name,
      sourceHash: parsed.sourceHash,
      definitionHash,
      capabilities: parsed.metadata.capabilities,
    },
    invocationHash: semanticInvocationHash(invocation),
    projectSnapshotHash: manifest.treeHash,
    routeSnapshotHash: resources.routeSnapshotHash,
    contextIdentityHash: sha256("semantic-agent-context"),
    status: "queued",
    safety: {
      concurrency: options.concurrency ?? 1,
      maximumAgentLaunches: 100,
      memoryBytes: 512 * 1024 * 1024,
      tasks: 64,
      cpuQuotaPercent: 100,
      cpuWeight: 100,
      outputBytes: 8 * 1024 * 1024,
      commandTimeoutMs: 60_000,
    },
    usage: zeroUsage(),
    ...(options.replay ? {
      replay: {
        mode: "cross-revision-prefix",
        sourceRunId: options.replay.sourceRunId,
        matchedCalls: 0,
        fresh: false,
      },
    } : {}),
    createdAt: at,
    updatedAt: at,
  };
  const database = RunDatabase.create(path.join(runDir, "run.sqlite"), { run });
  databases.push(database);
  const adapterOptions: ConstructorParameters<typeof SemanticAgentAdapter>[0] = {
    runDir, database, resources, executor,
  };
  return {
    root, project, runId, runDir, database, adapterOptions,
    execute: async (snapshot?: unknown, engineOptions: SequentialSemanticEngineOptions = {}) => {
      const adapter = new SemanticAgentAdapter(adapterOptions);
      return await executeSequentialSemanticRun(runDir, database, parsed, invocation, [adapter], {
        controlPollIntervalMs: 5,
        ...(snapshot !== undefined ? { snapshot } : {}),
        ...engineOptions,
      });
    },
  };
}

function resourcesFor(
  parsed: ReturnType<typeof parseStructuredWorkflow>,
  descriptor: AgentExecutorDescriptor,
  tools: AgentToolDescriptor[],
  project: string,
): PreparedWorkflowExecutionResources {
  const profile: AgentProfileSnapshot = {
    id: "builtin:test", name: "test", description: "Test worker", instructions: "Complete the exact task.",
    allowedTools: tools.map((tool) => tool.name), hash: sha256("test-profile"), sourcePath: "<builtin:test>",
  };
  const route: AgentRouteSnapshot = {
    id: "route:test", profileId: profile.id, provider: "test", model: "test/model", thinking: "off", hash: sha256("test-route"),
  };
  const selections = parsed.agentSelections.map((selection) => {
    const provenance = {
      ...agentCallProvenance(profile, route, tools),
      workspace: selection.workspace,
      network: selection.network,
      resultMode: selection.resultMode,
    };
    return {
      operationId: selection.id,
      profileId: profile.id,
      profileHash: profile.hash,
      routeId: route.id,
      routeHash: route.hash,
      workspace: selection.workspace,
      network: selection.network,
      resultMode: selection.resultMode,
      tools,
      authorityHash: stableHash(provenance),
    };
  });
  const contextBundle = { entries: [], hash: stableHash([]) };
  const body = {
    formatVersion: 1 as const,
    definitionSourceHash: parsed.sourceHash,
    projectRoot: project,
    projectCwd: project,
    profiles: [profile],
    profileSelectors: { "builtin:test": profile.id },
    routes: [route],
    routeSnapshotHash: stableHash([route]),
    agentSelections: selections,
    contextBundle,
    executor: descriptor,
    commands: [],
    measurements: [],
    verifications: [],
    candidateCapable: parsed.metadata.capabilities.includes("candidate-write"),
  };
  return { ...body, hash: stableHash(body) };
}

function scripted(
  run: (request: AgentExecutionRequest) => Promise<AgentExecutionResult>,
  descriptor = executorDescriptor([]),
): ScriptedAgentExecutor {
  return new ScriptedAgentExecutor({ descriptor, run: async (request) => await run(request) });
}

function executorDescriptor(tools: AgentToolDescriptor[]): AgentExecutorDescriptor {
  return {
    id: "semantic-agent-test",
    protocolVersion: 1,
    capabilities: {
      persistentSessions: true,
      candidateWorkspace: true,
      mediatedNetwork: true,
      liveProgress: true,
      artifactPublication: true,
    },
    toolCatalog: tools,
  };
}

async function committedFinish(
  request: AgentExecutionRequest,
  payload: JsonValue,
  options: { artifact?: { name: string; contents: string; format: "text" | "file" | "json" }; assistantText?: string } = {},
): Promise<AgentExecutionResult> {
  const client = await connect(request);
  try {
    await client.emit(event(request, 1, { type: "execution-start" }));
    if (options.assistantText) await client.emit(event(request, 2, { type: "assistant-text", text: options.assistantText }));
    if (options.artifact) {
      const output = path.join(path.dirname(request.protocol.socketPath), "outputs", request.executionId);
      await fs.promises.mkdir(output, { recursive: true });
      await fs.promises.writeFile(path.join(output, "artifact.txt"), options.artifact.contents);
      await client.request("publish_artifact", "tool-publish", {
        path: "artifact.txt", name: options.artifact.name, format: options.artifact.format,
      });
    }
    return finishResult(await client.request("finish_work", "tool-finish", payload));
  } finally { await client.close(); }
}

function finishResult(response: JsonValue): AgentExecutionResult {
  return {
    outcome: "finished",
    finish: (response as unknown as { finish: AgentExecutionResult & { finish: never } }).finish as never,
    usage: { ...zeroUsage(), inputTokens: 7, outputTokens: 3, providerRequests: 1, elapsedMs: 10 },
    transcriptComplete: true,
  };
}

async function connect(request: AgentExecutionRequest): Promise<AgentProtocolClient> {
  return await AgentProtocolClient.connect({
    socketPath: request.protocol.socketPath,
    executionId: request.executionId,
    executionToken: request.protocol.executionToken,
  });
}

function event(request: AgentExecutionRequest, sequence: number, body: Record<string, unknown>) {
  return {
    ...body,
    executionId: request.executionId,
    operationId: request.operationId,
    attemptId: request.attemptId,
    sequence,
    at: new Date().toISOString(),
  } as any;
}

function workflow(
  body: string,
  outputSchema: string,
  maxParallelism = 1,
  capabilities = ["read-project"],
): string {
  return `export default defineWorkflow({
    name: "semantic-agent-fixture",
    description: "Semantic agent fixture.",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: ${outputSchema},
    capabilities: ${JSON.stringify(capabilities)},
    modelVisible: false,
    maxParallelism: ${maxParallelism},
    async run(flow, args) { void args; ${body} },
  });`;
}

async function temporaryRoot(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(process.env.HOME ?? process.cwd(), "wf-a-"));
  roots.push(root);
  return root;
}

async function exists(target: string): Promise<boolean> {
  try { await fs.promises.access(target); return true; } catch { return false; }
}

async function makeWritable(target: string): Promise<void> {
  let stat: fs.Stats;
  try { stat = await fs.promises.lstat(target); } catch { return; }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.promises.chmod(target, 0o700);
    for (const name of await fs.promises.readdir(target)) await makeWritable(path.join(target, name));
  } else await fs.promises.chmod(target, 0o600);
}

function zeroUsage() {
  return {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    providerRequests: 0, cost: 0, elapsedMs: 0, complete: true,
  };
}
