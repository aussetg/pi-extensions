import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";
import { buildAgentSemanticKey } from "../src/agents/call-identity.js";
import type {
  AgentProfileSnapshot,
  AgentRouteSnapshot,
  AgentToolDescriptor,
} from "../src/agents/executor.js";
import { parseStructuredWorkflow } from "../src/definition/workflow-definition.js";
import { RunDatabase } from "../src/persistence/run-database.js";
import type { RunRecord } from "../src/runtime/durable-types.js";
import {
  executeSequentialSemanticRun,
  semanticInvocationHash,
  SemanticEngineCrashError,
  type SemanticEffectAdapter,
  type SemanticEffectRequest,
  type SemanticEngineInvocation,
} from "../src/runtime/semantic-engine.js";
import type { JsonValue } from "../src/types.js";
import { sha256, stableHash } from "../src/utils/hashes.js";

const roots: string[] = [];
const databases: RunDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("journal-prefix replay", () => {
  it("reuses a full explicit prefix and records a first-call miss without consulting another run globally", async () => {
    const root = temporaryRoot();
    const body = threeCalls();
    const source = createRun(root, body);
    const sourceCalls: string[] = [];
    expect((await source.execute(agentAdapter(source, { calls: sourceCalls }))).status).toBe("completed");
    expect(sourceCalls).toEqual(["one", "two", "three"]);

    const full = createRun(root, body, { replaySource: source });
    const fullCalls: string[] = [];
    expect(await full.execute(agentAdapter(full, { calls: fullCalls }))).toMatchObject({
      status: "completed",
      result: { one: "one", two: "two", three: "three" },
    });
    expect(fullCalls).toEqual([]);
    expect(full.database.readRun().replay).toEqual({
      mode: "cross-revision-prefix",
      sourceRunId: source.runId,
      matchedCalls: 3,
      fresh: false,
    });
    expect(full.database.listOperations({ limit: 16 }).filter((operation) => operation.kind === "agent")
      .every((operation) => operation.replay?.sourceRunId === source.runId)).toBe(true);

    const firstMiss = createRun(root, body, { replaySource: source });
    const missCalls: string[] = [];
    await firstMiss.execute(agentAdapter(firstMiss, { calls: missCalls, routeByCall: { one: "provider/new-model" } }));
    expect(missCalls).toEqual(["one", "two", "three"]);
    expect(firstMiss.database.readRun().replay).toMatchObject({
      matchedCalls: 0,
      firstMissOrdinal: 0,
      firstMissReason: expect.stringContaining("semantic call key changed"),
    });

    const unrelated = createRun(root, body);
    const unrelatedCalls: string[] = [];
    await unrelated.execute(agentAdapter(unrelated, { calls: unrelatedCalls }), source.runDir);
    expect(unrelatedCalls).toEqual(["one", "two", "three"]);
    expect(unrelated.database.readRun().replay).toBeUndefined();
  });

  it("invalidates every later call after a middle mismatch while preserving an edited-later prefix", async () => {
    const root = temporaryRoot();
    const source = createRun(root, threeCalls());
    await source.execute(agentAdapter(source));

    const middle = createRun(root, threeCalls(), { replaySource: source });
    const middleCalls: string[] = [];
    await middle.execute(agentAdapter(middle, {
      calls: middleCalls,
      routeByCall: { two: "provider/revised" },
    }));
    expect(middleCalls).toEqual(["two", "three"]);
    expect(middle.database.readRun().replay).toMatchObject({ matchedCalls: 1, firstMissOrdinal: 1 });
    expect(middle.database.listOperations({ limit: 8 }).find((operation) => operation.sourceId === "one")?.replay)
      .toMatchObject({ sourceRunId: source.runId });
    expect(middle.database.listOperations({ limit: 8 }).find((operation) => operation.sourceId === "three")?.replay)
      .toBeUndefined();

    const edited = createRun(root, threeCalls("edited later prompt"), { replaySource: source });
    const editedCalls: string[] = [];
    const outcome = await edited.execute(agentAdapter(edited, { calls: editedCalls }));
    expect(outcome).toMatchObject({ status: "completed", result: { one: "one", two: "two", three: "three" } });
    expect(editedCalls).toEqual(["three"]);
    expect(edited.database.readRun().replay).toMatchObject({ matchedCalls: 2, firstMissOrdinal: 2 });
  });

  it("binds route, project tree, and explicit input artifacts but permits explicit network-call replay", async () => {
    const root = temporaryRoot();
    const body = `
      const value = await flow.agent("network", {
        profile: "builtin:researcher",
        prompt: "research",
        inputs: [{ id: "prior", artifactDigest: "${sha256("artifact-a")}" }],
        network: "research",
      });
      return { value };
    `;
    const source = createRun(root, body);
    await source.execute(agentAdapter(source));

    const networkHit = createRun(root, body, { replaySource: source });
    const hitCalls: string[] = [];
    await networkHit.execute(agentAdapter(networkHit, { calls: hitCalls }));
    expect(hitCalls).toEqual([]);
    expect(networkHit.database.readRun().replay?.matchedCalls).toBe(1);

    const changedRoute = createRun(root, body, { replaySource: source, routeHash: sha256("route-b") });
    const routeCalls: string[] = [];
    await changedRoute.execute(agentAdapter(changedRoute, { calls: routeCalls }));
    expect(routeCalls).toEqual(["network"]);

    const changedProject = createRun(root, body, { replaySource: source, projectHash: sha256("project-b") });
    const projectCalls: string[] = [];
    await changedProject.execute(agentAdapter(changedProject, { calls: projectCalls }));
    expect(projectCalls).toEqual(["network"]);

    const changedArtifactBody = body.replace(sha256("artifact-a"), sha256("artifact-b"));
    const changedArtifact = createRun(root, changedArtifactBody, { replaySource: source });
    const artifactCalls: string[] = [];
    await changedArtifact.execute(agentAdapter(changedArtifact, { calls: artifactCalls }));
    expect(artifactCalls).toEqual(["network"]);
  });

  it("links output artifacts into the target and deliberately bypasses replay for fresh runs", async () => {
    const root = temporaryRoot();
    const body = `
      const value = await flow.agent("publish", { profile: "builtin:researcher", prompt: "publish" });
      return { value };
    `;
    const source = createRun(root, body);
    await source.execute(agentAdapter(source, { publishArtifact: true }));
    const sourceOperation = source.database.listOperations({ limit: 8 }).find((operation) => operation.kind === "agent")!;
    const digest = sourceOperation.result!.artifacts[0]!.digest;

    const replay = createRun(root, body, { replaySource: source });
    const replayCalls: string[] = [];
    await replay.execute(agentAdapter(replay, { calls: replayCalls }));
    expect(replayCalls).toEqual([]);
    const replayOperation = replay.database.listOperations({ limit: 8 }).find((operation) => operation.kind === "agent")!;
    expect(replayOperation.result?.artifacts[0]?.digest).toBe(digest);
    const stored = await new ArtifactStore(replay.runDir, replay.database).read(digest);
    expect(await fs.promises.readFile(stored.bodyPath, "utf8")).toBe("published evidence\n");
    expect(stored.record.runId).toBe(replay.runId);

    const fresh = createRun(root, body, { replaySource: source, fresh: true });
    const freshCalls: string[] = [];
    await fresh.execute(agentAdapter(fresh, { calls: freshCalls }));
    expect(freshCalls).toEqual(["publish"]);
    expect(fresh.database.readRun().replay).toMatchObject({ fresh: true, matchedCalls: 0 });
    expect(fresh.database.readRun().replay?.firstMissOrdinal).toBeUndefined();
  });

  it("never reuses incomplete or receiptless agent calls", async () => {
    const root = temporaryRoot();
    const body = `
      const value = await flow.agent("unfinished", { profile: "builtin:researcher", prompt: "unfinished" });
      return { value };
    `;
    const incomplete = createRun(root, body);
    const crashing = agentAdapter(incomplete);
    crashing.execute = async () => { throw new SemanticEngineCrashError("worker died before finish_work"); };
    await expect(incomplete.execute(crashing)).rejects.toBeInstanceOf(SemanticEngineCrashError);
    expect(incomplete.database.listWorkflowCalls({ limit: 8 })).toEqual([]);
    expect(incomplete.database.listOperations({ limit: 8 })[0]).toMatchObject({ status: "running" });

    const target = createRun(root, body, { replaySource: incomplete });
    const calls: string[] = [];
    await target.execute(agentAdapter(target, { calls }));
    expect(calls).toEqual(["unfinished"]);
    expect(target.database.readRun().replay).toMatchObject({ matchedCalls: 0, firstMissOrdinal: 0 });

    const receiptless = createRun(root, body);
    const wrongAuthority = agentAdapter(receiptless);
    wrongAuthority.execute = async () => ({
      result: { value: "prose-only", artifacts: [] },
      usage: zeroUsage(),
      completionAuthority: "host-effect",
    });
    expect(await receiptless.execute(wrongAuthority)).toMatchObject({ status: "failed" });
    expect(receiptless.database.listWorkflowCalls({ limit: 8 })).toEqual([]);
  });

  it("journals apply evidence but never replays stale approval effects", async () => {
    const root = temporaryRoot();
    const body = `
      const value = await flow.apply("live", { candidate: { id: "candidate" }, verification: { id: "verification" } });
      return { value };
    `;
    const source = createRun(root, body);
    let sourceCalls = 0;
    await source.execute(applyAdapter(() => { sourceCalls++; }));
    expect(sourceCalls).toBe(1);
    expect(source.database.listWorkflowCalls({ limit: 8 })[0]).toMatchObject({ replayPolicy: "never" });

    const target = createRun(root, body, { replaySource: source });
    let targetCalls = 0;
    await target.execute(applyAdapter(() => { targetCalls++; }));
    expect(targetCalls).toBe(1);
    expect(target.database.readRun().replay).toMatchObject({
      matchedCalls: 0,
      firstMissReason: expect.stringContaining("not replayable"),
    });
  });

  it("normalizes parallel journal order independently of effect completion timing", async () => {
    const root = temporaryRoot();
    const body = `
      const values = await flow.parallel("work", {
        alpha: async () => flow.agent("inspect", { profile: "builtin:researcher", prompt: "alpha" }),
        beta: async () => flow.agent("inspect", { profile: "builtin:researcher", prompt: "beta" }),
      }, { concurrency: 2 });
      return values;
    `;
    const slowAlpha = createRun(root, body, { concurrency: 2, maxParallelism: 2 });
    await slowAlpha.execute(agentAdapter(slowAlpha, {
      delays: { "run/parallel:work/branch:alpha/agent:inspect": 30 },
    }));
    const slowBeta = createRun(root, body, { concurrency: 2, maxParallelism: 2 });
    await slowBeta.execute(agentAdapter(slowBeta, {
      delays: { "run/parallel:work/branch:beta/agent:inspect": 30 },
    }));
    const journal = (run: TestRun) => run.database.listWorkflowCalls({ limit: 16 }).map((call) => ({
      ordinal: call.ordinal,
      path: run.database.readOperation(call.operationId)!.path,
      previousJournalKey: call.previousJournalKey,
      callKey: call.callKey,
    }));
    expect(journal(slowAlpha)).toEqual(journal(slowBeta));
    expect(journal(slowAlpha).map((entry) => entry.path)).toEqual([
      "run/parallel:work/branch:alpha/agent:inspect",
      "run/parallel:work/branch:beta/agent:inspect",
    ]);

    const replay = createRun(root, body, {
      replaySource: slowAlpha,
      concurrency: 2,
      maxParallelism: 2,
    });
    const calls: string[] = [];
    await replay.execute(agentAdapter(replay, { calls }));
    expect(calls).toEqual([]);
    expect(replay.database.readRun().replay?.matchedCalls).toBe(2);

    const multiBody = `
      const values = await flow.parallel("work", {
        alpha: async () => {
          const first = await flow.agent("first", { profile: "builtin:researcher", prompt: "alpha first" });
          const second = await flow.agent("second", { profile: "builtin:researcher", prompt: "alpha second" });
          return [first, second];
        },
        beta: async () => {
          const first = await flow.agent("first", { profile: "builtin:researcher", prompt: "beta first" });
          const second = await flow.agent("second", { profile: "builtin:researcher", prompt: "beta second" });
          return [first, second];
        },
      }, { concurrency: 2 });
      return values;
    `;
    const multi = createRun(root, multiBody, { concurrency: 2, maxParallelism: 2 });
    await multi.execute(agentAdapter(multi, {
      delays: { "run/parallel:work/branch:alpha/agent:first": 30 },
    }));
    expect(journal(multi).map((entry) => entry.path)).toEqual([
      "run/parallel:work/branch:alpha/agent:first",
      "run/parallel:work/branch:alpha/agent:second",
      "run/parallel:work/branch:beta/agent:first",
      "run/parallel:work/branch:beta/agent:second",
    ]);
    const multiReplay = createRun(root, multiBody, {
      replaySource: multi,
      concurrency: 2,
      maxParallelism: 2,
    });
    const multiCalls: string[] = [];
    await multiReplay.execute(agentAdapter(multiReplay, { calls: multiCalls }));
    expect(multiCalls).toEqual([]);
    expect(multiReplay.database.readRun().replay?.matchedCalls).toBe(4);

    const removedEarlierCall = multiBody.replace(
      'const second = await flow.agent("second", { profile: "builtin:researcher", prompt: "alpha second" });',
      'const second = "removed";',
    );
    const changed = createRun(root, removedEarlierCall, {
      replaySource: multi,
      concurrency: 2,
      maxParallelism: 2,
    });
    const changedCalls: string[] = [];
    await changed.execute(agentAdapter(changed, { calls: changedCalls }));
    expect(changedCalls).toEqual(["first", "second"]);
    expect(changed.database.readRun().replay).toMatchObject({ matchedCalls: 1, firstMissOrdinal: 3 });
  });

  it("keeps credentials, executable policy, temporary paths, and time outside agent semantic keys", () => {
    const profile = testProfile("Research exactly.");
    const route = testRoute("provider/model");
    const base = {
      semanticInputHash: sha256("prompt"),
      finishSchemaHash: sha256("finish"),
      inputArtifactDigests: [sha256("artifact")],
      network: "research" as const,
      preWorkspaceHash: sha256("workspace"),
      profile,
      route,
      tools: TEST_TOOLS,
    };
    const key = buildAgentSemanticKey(base);
    expect(buildAgentSemanticKey({
      ...base,
      credentials: { token: "secret" },
      executableBytes: sha256("/usr/bin/bwrap"),
      cgroup: { MemoryMax: 1 },
      temporaryPath: "/tmp/agent-123",
      currentTime: "2099-01-01T00:00:00.000Z",
    } as Parameters<typeof buildAgentSemanticKey>[0])).toBe(key);
    expect(buildAgentSemanticKey({
      ...base,
      profile: { ...profile, sourcePath: "/tmp/refreshed-token-profile.md" },
      route: { ...route, apiKey: "secret" } as AgentRouteSnapshot,
      tools: TEST_TOOLS.map((tool) => ({ ...tool, executablePath: "/new/bwrap" })) as AgentToolDescriptor[],
    })).toBe(key);
    expect(buildAgentSemanticKey({ ...base, route: testRoute("provider/other") })).not.toBe(key);
    expect(buildAgentSemanticKey({ ...base, profile: testProfile("Different profile prompt.") })).not.toBe(key);
    expect(buildAgentSemanticKey({
      ...base,
      tools: [{ ...TEST_TOOLS[0]!, schemaHash: sha256("changed-tool-schema") }],
    })).not.toBe(key);
    expect(buildAgentSemanticKey({ ...base, finishSchemaHash: sha256("other-finish") })).not.toBe(key);
    expect(buildAgentSemanticKey({ ...base, semanticInputHash: sha256("other-prompt") })).not.toBe(key);
    expect(buildAgentSemanticKey({ ...base, network: "none" })).not.toBe(key);
    expect(buildAgentSemanticKey({ ...base, preWorkspaceHash: sha256("other-tree") })).not.toBe(key);
    expect(buildAgentSemanticKey({ ...base, inputArtifactDigests: [sha256("other-artifact")] })).not.toBe(key);
  });
});

interface TestRun {
  runId: string;
  runDir: string;
  database: RunDatabase;
  parsed: ReturnType<typeof parseStructuredWorkflow>;
  invocation: SemanticEngineInvocation;
  execute(adapter: SemanticEffectAdapter, explicitSourceDir?: string): ReturnType<typeof executeSequentialSemanticRun>;
}

interface CreateOptions {
  replaySource?: TestRun;
  fresh?: boolean;
  projectHash?: string;
  routeHash?: string;
  concurrency?: number;
  maxParallelism?: number;
}

function createRun(root: string, body: string, options: CreateOptions = {}): TestRun {
  const source = workflowSource(body, options.maxParallelism ?? 1);
  const parsed = parseStructuredWorkflow(source);
  const runId = `flow_${crypto.randomBytes(16).toString("hex")}`;
  const runDir = path.join(root, runId);
  for (const directory of ["artifacts", "workspaces/checkpoints", "workspaces/candidates"]) {
    fs.mkdirSync(path.join(runDir, directory), { recursive: true, mode: 0o700 });
  }
  const definitionHash = stableHash({ sourceHash: parsed.sourceHash, metadata: parsed.metadata });
  const invocation: SemanticEngineInvocation = {
    workflowId: "builtin:journal-fixture",
    definitionHash,
    input: {},
    inputHash: stableHash({}),
  };
  const createdAt = new Date().toISOString();
  const run: RunRecord = {
    runId,
    revision: 1,
    workflow: {
      id: "builtin:journal-fixture",
      name: parsed.metadata.name,
      sourceHash: parsed.sourceHash,
      definitionHash,
      capabilities: parsed.metadata.capabilities,
    },
    invocationHash: semanticInvocationHash(invocation),
    projectSnapshotHash: options.projectHash ?? sha256("project-a"),
    routeSnapshotHash: options.routeHash ?? sha256("route-a"),
    contextIdentityHash: stableHash({ project: options.projectHash ?? sha256("project-a") }),
    status: "queued",
    safety: {
      concurrency: options.concurrency ?? 1,
      maximumAgentLaunches: 100,
      memoryBytes: 512 * 1024 * 1024,
      tasks: 64,
      cpuQuotaPercent: 100,
      cpuWeight: 100,
      outputBytes: 4 * 1024 * 1024,
      commandTimeoutMs: 60_000,
    },
    usage: zeroUsage(),
    ...(options.replaySource ? {
      replay: {
        mode: "cross-revision-prefix",
        sourceRunId: options.replaySource.runId,
        matchedCalls: 0,
        fresh: options.fresh === true,
      },
    } : {}),
    createdAt,
    updatedAt: createdAt,
  };
  const database = RunDatabase.create(path.join(runDir, "run.sqlite"), { run });
  databases.push(database);
  const fixture: TestRun = {
    runId,
    runDir,
    database,
    parsed,
    invocation,
    execute: (adapter, explicitSourceDir) => executeSequentialSemanticRun(
      runDir,
      database,
      parsed,
      invocation,
      [adapter],
      {
        controlPollIntervalMs: 5,
        ...(options.replaySource && !options.fresh
          ? { replaySourceRunDir: explicitSourceDir ?? options.replaySource.runDir }
          : explicitSourceDir ? { replaySourceRunDir: explicitSourceDir } : {}),
      },
    ),
  };
  return fixture;
}

interface AdapterOptions {
  calls?: string[];
  routeByCall?: Record<string, string>;
  delays?: Record<string, number>;
  publishArtifact?: boolean;
}

function agentAdapter(fixture: TestRun, options: AdapterOptions = {}): SemanticEffectAdapter {
  return {
    kind: "agent",
    semanticInput: ({ input }) => input as JsonValue,
    journalIdentity: ({ input, sourceId, run }) => {
      const normalized = input as Record<string, unknown>;
      const routeModel = options.routeByCall?.[sourceId]
        ?? (run.routeSnapshotHash === sha256("route-a") ? "provider/model" : `provider/${run.routeSnapshotHash.slice(-8)}`);
      return {
        semanticKey: buildAgentSemanticKey({
          semanticInputHash: stableHash(input),
          finishSchemaHash: sha256("finish-schema"),
          inputArtifactDigests: collectArtifactDigests(input),
          network: normalized.network === "research" ? "research" : "none",
          preWorkspaceHash: run.projectSnapshotHash,
          profile: testProfile("Research exactly."),
          route: testRoute(routeModel),
          tools: TEST_TOOLS,
        }),
        completionAuthority: "finish-work",
        replayPolicy: "immutable",
      };
    },
    execute: async (request: SemanticEffectRequest) => {
      options.calls?.push(request.sourceId);
      const delay = options.delays?.[request.path] ?? 0;
      if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      const artifacts = [];
      if (options.publishArtifact) {
        const stored = await new ArtifactStore(fixture.runDir, request.database).putText({
          expectedRevision: request.database.readRun().revision,
          kind: "agent-evidence",
          text: "published evidence\n",
          metadata: { sourceId: request.sourceId },
        });
        artifacts.push(stored.artifact);
      }
      return {
        result: { value: request.sourceId, artifacts },
        usage: zeroUsage(),
        completionAuthority: "finish-work",
      };
    },
  };
}

function applyAdapter(called: () => void): SemanticEffectAdapter {
  return {
    kind: "apply",
    semanticInput: ({ input }) => input as JsonValue,
    journalIdentity: ({ input }) => ({
      semanticKey: stableHash({ input, approval: "exact-human-only" }),
      completionAuthority: "host-effect",
      replayPolicy: "never",
    }),
    execute: async () => {
      called();
      return {
        result: { value: { applied: true }, artifacts: [] },
        usage: zeroUsage(),
        completionAuthority: "host-effect",
      };
    },
  };
}

const TEST_TOOLS: AgentToolDescriptor[] = [{
  name: "read",
  schemaHash: sha256("read-schema"),
  mutatesWorkspace: false,
  usesMediatedNetwork: false,
}];

function testProfile(instructions: string): AgentProfileSnapshot {
  return {
    id: "builtin:researcher",
    name: "researcher",
    description: "Research",
    instructions,
    allowedTools: ["read"],
    hash: stableHash({ instructions }),
    sourcePath: "/profiles/researcher.md",
  };
}

function testRoute(model: string): AgentRouteSnapshot {
  const provider = model.slice(0, model.indexOf("/"));
  const body = { profileId: "builtin:researcher", provider, model, thinking: "medium" as const };
  const hash = stableHash(body);
  return { id: `route_${hash.slice(7, 39)}`, ...body, hash };
}

function collectArtifactDigests(value: unknown): string[] {
  const digests: string[] = [];
  const visit = (current: unknown): void => {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) return void current.forEach(visit);
    for (const [key, child] of Object.entries(current)) {
      if (key === "artifactDigest" && typeof child === "string") digests.push(child);
      else visit(child);
    }
  };
  visit(value);
  return digests;
}

function threeCalls(thirdPrompt = "three"): string {
  return `
    const one = await flow.agent("one", { profile: "builtin:researcher", prompt: "one" });
    const two = await flow.agent("two", { profile: "builtin:researcher", prompt: "two" });
    const three = await flow.agent("three", { profile: "builtin:researcher", prompt: ${JSON.stringify(thirdPrompt)} });
    return { one, two, three };
  `;
}

function workflowSource(body: string, maxParallelism: number): string {
  return `
export default defineWorkflow({
  name: "journal-fixture",
  description: "Journal replay fixture.",
  inputSchema: { type: "object", additionalProperties: false },
  outputSchema: { type: "object" },
  capabilities: ["read-project", "candidate-write", "mediated-network", "human-input"],
  modelVisible: false,
  maxParallelism: ${maxParallelism},
  async run(flow, args) {
    void args;
    ${body}
  },
});
`;
}

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "journal-replay-"));
  roots.push(root);
  return root;
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
