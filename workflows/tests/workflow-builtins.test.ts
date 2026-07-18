import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowRegistry, type WorkflowDefinitionRef } from "../src/registry/structured-workflows.js";
import { createWorkflowInvocationSnapshot } from "../src/persistence/workflow-invocation.js";
import { WorkflowRunDatabase } from "../src/persistence/run-database.js";
import type {
  WorkflowCandidateRecord,
  WorkflowCandidateWorkspaceRecord,
  WorkflowOperationRecord,
  WorkflowRunRecord,
  WorkflowScopeRecord,
  WorkflowWorkspaceCheckpointRecord,
} from "../src/persistence/run-database-types.js";
import { WorkflowArtifactStore } from "../src/artifacts/store.js";
import { WorkflowEffectProductFactory } from "../src/artifacts/products.js";
import { WorkflowControlAuthorityRegistry } from "../src/runtime/control-authority.js";
import {
  WorkflowCandidateRuntime,
  workflowCheckpointId,
  type WorkflowCandidateWorkspaceDriver,
  type WorkflowCandidateWorkspaceHandle,
  type WorkflowFrozenCandidateWorkspace,
  type WorkflowPreparedCandidateWorkspace,
} from "../src/candidates/runtime.js";
import {
  workflowStaticEffectResources,
  type WorkflowAgentEffectExecutor,
  type WorkflowAgentExecutionRequest,
  type WorkflowApplyExecutor,
  type WorkflowAskExecutor,
  type WorkflowCommandEffectExecutor,
  type WorkflowVerificationExecutor,
} from "../src/runtime/effect-adapters.js";
import { WorkflowExecutableRuntime } from "../src/runtime/executable-runtime.js";
import {
  WorkflowSemanticEngineCrashError,
  type WorkflowSemanticEngineFaultPoint,
} from "../src/runtime/semantic-engine.js";
import { WorkflowMetricSetRuntime } from "../src/measurements/metric-set.js";
import { StaticMeasurementEnvironmentProvider } from "../src/measurements/environment.js";
import {
  normalizeMeasurementProfile,
  type MeasurementProfileSnapshot,
} from "../src/measurements/profiles.js";
import { resolveCommandInvocation } from "../src/commands/profiles.js";
import type {
  HostCommandExecutor,
  HostCommandRequest,
  HostCommandResult,
} from "../src/commands/executor.js";
import type { CandidateWriteScope } from "../src/runtime/durable-types.js";
import type { JsonObject, JsonValue } from "../src/types.js";
import { canonicalJsonObject } from "../src/definition/canonical-json.js";
import { sha256, stableHash } from "../src/utils/hashes.js";
import { readWorkflowRunProjection } from "../src/projection/run-projection.js";
import { renderWorkflowRunProjectionText } from "../src/projection/render.js";
import { projectWorkflowDefinitionReview } from "../src/projection/run-projection.js";
import { readWorkflowInspectorPage } from "../src/projection/inspector-pages.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BUILTINS = path.join(ROOT, "src", "builtins");
const CORPUS = path.join(ROOT, "tests", "conformance", "v17", "typecheck", "corpus");
const BUILTIN_NAMES = ["coding", "execute-plan", "goal", "optimize", "package-audit", "research"] as const;
const BASE_TIME = Date.parse("2026-10-01T12:00:00.000Z");
const roots: string[] = [];
const databases = new Set<WorkflowRunDatabase>();

interface AgentReply {
  output: unknown;
  change?: { path: string; contents: string };
}

interface BuiltinScript {
  agent(request: WorkflowAgentExecutionRequest): AgentReply;
  command?(request: Parameters<WorkflowCommandEffectExecutor["execute"]>[0]): JsonValue;
  asks?: JsonValue[];
  verifications?: Array<"passed" | "failed" | "blocked">;
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
  for (const root of roots.splice(0)) {
    makeRemovable(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("workflow v17 builtins", () => {
  it("installs the exact six reviewed corpus definitions with explicit model exposure", async () => {
    const root = temporaryRoot("registry");
    const registry = await builtinRegistry(root);
    expect(registry.listInvalid()).toEqual([]);
    expect(registry.list().map(ref => [ref.name, ref.exposure])).toEqual(
      BUILTIN_NAMES.map(name => [name, "model"]),
    );
    for (const name of BUILTIN_NAMES) {
      expect(fs.readFileSync(path.join(BUILTINS, `${name}.flow.ts`), "utf8"))
        .toBe(fs.readFileSync(path.join(CORPUS, `${name}.flow.ts`), "utf8"));
    }
    expect(registry.resolve("builtin:research").parsed.review).toMatchObject({
      capabilities: ["mediated-network", "read-project"],
      dynamicResources: [],
      maximumConcurrency: 4,
    });
    expect(registry.resolve("builtin:optimize").parsed.review).toMatchObject({
      capabilities: expect.arrayContaining(["candidate-write", "host-command", "human-input"]),
      dynamicResources: [
        expect.objectContaining({ kind: "measurement-profile" }),
        expect.objectContaining({ kind: "measurement-profile" }),
      ],
    });
    expect(projectWorkflowDefinitionReview(registry.resolve("builtin:optimize"))).toMatchObject({
      exposure: "model",
      authority: {
        capabilities: expect.arrayContaining(["candidate-write", "host-command", "human-input"]),
        dynamicResources: [
          expect.objectContaining({ kind: "measurement-profile", inputPath: "/evaluator" }),
          expect.objectContaining({ kind: "measurement-profile", inputPath: "/evaluator" }),
        ],
      },
    });
  });

  it("runs and reconstructs research with keyed collected lanes and report revision", async () => {
    const fixture = await createFixture("research", {
      question: "Why did the release gate regress?",
    }, researchScript());
    const outcome = await recoverOnce(fixture, (point, operation) =>
      point === "after-structural-join" && operation?.kind === "map");
    expect(outcome).toMatchObject({
      status: "completed",
      result: { answer: "revised evidence-backed answer", openQuestions: [] },
    });
    expect(laneKeys(fixture, "map-item")).toEqual(["architecture", "evidence", "risks"]);
    expect(operationKinds(fixture)).toEqual({ agent: 6, map: 1 });
    expect(fixture.backends.agentCalls).toBe(6);
    fixture.database.validateIntegrity();
    expect(renderWorkflowRunProjectionText(
      readWorkflowRunProjection(fixture.database, fixture.snapshot),
    )).toMatchSnapshot();
  });

  it("runs and reconstructs package-audit through an effectful local helper per map lane", async () => {
    const fixture = await createFixture("package-audit", {
      packages: [
        { id: "core", path: "src/core" },
        { id: "ui", path: "src/ui" },
      ],
    }, packageAuditScript());
    const outcome = await recoverOnce(fixture, (point, operation) =>
      point === "after-structural-join" && operation?.kind === "map");
    expect(outcome).toMatchObject({
      status: "completed",
      result: { summary: "cross-package audit", priorities: ["core", "ui"] },
    });
    expect(laneKeys(fixture, "map-item")).toEqual(["core", "ui"]);
    expect(operationKinds(fixture)).toEqual({ agent: 7, command: 2, map: 1 });
    expect(fixture.backends.commandCalls).toBe(2);
    expect(fixture.backends.agentCalls).toBe(7);
    fixture.database.validateIntegrity();
  });

  it("runs coding through parallel inspection, candidate reconstruction, verification, and apply", async () => {
    const fixture = await createFixture("coding", {
      objective: "Add durable cache invalidation.",
    }, codingScript());
    const outcome = await recoverOnce(fixture, point => point === "after-candidate-frozen");
    expect(outcome).toMatchObject({
      status: "completed",
      result: { status: "applied", changedPaths: ["src/index.ts"] },
    });
    expect(laneKeys(fixture, "parallel-branch")).toEqual(["architecture", "risks", "tests"]);
    expect(fixture.database.listCandidates()).toEqual([
      expect.objectContaining({ state: "applied", changedPaths: ["src/index.ts"] }),
    ]);
    expect(operationKinds(fixture)).toEqual({
      accept: 1, agent: 4, apply: 1, candidate: 1, parallel: 1, verify: 1,
    });
    expect(fixture.backends.agentCalls).toBe(4);
    fixture.database.validateIntegrity();
  });

  it("runs generic optimize against a candidate-sensitive pinned evaluator", async () => {
    const profile = measurementProfile();
    const fixture = await createFixture("optimize", {
      objective: "Reduce parser latency without materially increasing memory.",
      writePaths: ["benchmark.json"],
      evaluator: profile.id,
      metrics: {
        primary: {
          output: "latency",
          direction: "minimize",
          target: { kind: "relativeGain", value: 0.15 },
          improvement: { minimumRelative: 0.05 },
        },
        guardrails: [{
          output: "rss",
          direction: "minimize",
          reference: "baseline",
          maximumRelativeRegression: 0.05,
        }],
      },
      sampling: { warmups: 0, samples: 1 },
      maxIterations: 4,
    }, optimizeScript(), { profile, benchmark: true });
    let measures = 0;
    const outcome = await recoverOnce(fixture, (point, operation) =>
      point === "after-effect-settled" && operation?.kind === "measure" && ++measures === 2);
    expect(outcome).toMatchObject({
      status: "completed",
      result: {
        changed: true,
        evaluator: "project:bench",
        experiments: 2,
        metrics: { latency: { baseline: 100, current: 80, best: 80, relativeGain: 0.2 } },
      },
    });
    expect(fixture.measurement?.observed).toEqual([
      { latency: 100, rss: 100 },
      { latency: 90, rss: 102 },
      { latency: 80, rss: 104 },
    ]);
    expect(fixture.database.listExperiments().map(value => value.disposition)).toEqual(["accepted", "accepted"]);
    expect(fixture.database.listCandidates().map(value => value.state)).toEqual(["accepted", "applied"]);
    expect(operationKinds(fixture)).toMatchObject({
      accept: 2, agent: 6, apply: 1, candidate: 2, measure: 3, "record-experiment": 2, verify: 2,
    });
    expect(projectWorkflowDefinitionReview(fixture.ref, fixture.snapshot)).toMatchObject({
      launchBinding: {
        authority: "model",
        projectTrusted: true,
        resources: [expect.objectContaining({ selector: "project:bench" })],
      },
    });
    const operationsPage = readWorkflowInspectorPage(fixture.database, "operations", { limit: 4 });
    expect(operationsPage.entries).toHaveLength(4);
    expect(readWorkflowInspectorPage(fixture.database, "operations", {
      limit: 4,
      cursor: operationsPage.nextCursor,
    }).entries).toHaveLength(4);
    expect(() => readWorkflowInspectorPage(fixture.database, "events", {
      cursor: operationsPage.nextCursor,
    })).toThrow(/another page/);
    expect(readWorkflowInspectorPage(fixture.database, "measurements", { limit: 2 })).toMatchObject({
      entries: [
        expect.objectContaining({ profileId: "project:bench", candidateId: null }),
        expect.objectContaining({ profileId: "project:bench" }),
      ],
      nextCursor: expect.any(String),
    });
    for (const kind of ["attempts", "artifacts", "experiments", "candidates", "resources"] as const) {
      const page = readWorkflowInspectorPage(fixture.database, kind, { limit: 3 });
      expect(page.entries.length, `${kind} page`).toBeGreaterThan(0);
      expect(page.bytes).toBeLessThanOrEqual(256 * 1024);
    }
    fixture.database.validateIntegrity();
    expect(renderWorkflowRunProjectionText(
      readWorkflowRunProjection(fixture.database, fixture.snapshot),
    )).toMatchSnapshot();
  });

  it("runs goal through a failed verification and a reconstructed corrected candidate", async () => {
    const fixture = await createFixture("goal", {
      objective: "Implement resilient cache invalidation.",
    }, goalScript());
    let verifications = 0;
    const outcome = await recoverOnce(fixture, (point, operation) =>
      point === "after-effect-settled" && operation?.kind === "verify" && ++verifications === 1);
    expect(outcome).toMatchObject({
      status: "completed",
      result: {
        status: "completed",
        summary: "candidate attempt 2 completed",
        changedPaths: ["src/goal.ts"],
        applied: true,
      },
    });
    expect(fixture.database.listCandidates().map(value => value.state)).toEqual(["rejected", "applied"]);
    expect(fixture.backends.verificationCalls).toBe(2);
    expect(operationKinds(fixture)).toMatchObject({
      accept: 1, agent: 3, apply: 1, candidate: 2, reject: 1, verify: 2,
    });
    fixture.database.validateIntegrity();
    expect(renderWorkflowRunProjectionText(
      readWorkflowRunProjection(fixture.database, fixture.snapshot),
    )).toMatchSnapshot();
  });

  it("runs execute-plan through durable points, replan, reconstruction, and final apply", async () => {
    const fixture = await createFixture("execute-plan", {
      objective: "Implement transactional cache invalidation.",
    }, executePlanScript());
    let agents = 0;
    const outcome = await recoverOnce(fixture, (point, operation) =>
      point === "after-effect-settled" && operation?.kind === "agent" && ++agents === 3);
    expect(outcome).toMatchObject({
      status: "completed",
      result: {
        status: "completed",
        summary: "transaction point completed",
        planRevision: 2,
        ledger: [
          expect.objectContaining({ pointId: "schema", outcome: "completed" }),
          expect.objectContaining({ pointId: "storage", outcome: "replan" }),
          expect.objectContaining({ pointId: "transaction", outcome: "completed" }),
        ],
        changedPaths: ["src/plan.ts"],
        applied: true,
      },
    });
    expect(fixture.database.listOperations().filter(value => value.kind === "agent")
      .map(value => value.title).filter(Boolean)).toEqual([
      "Point schema", "Point storage", "Replan 2", "Point transaction",
    ]);
    expect(fixture.backends.agentCalls).toBe(5);
    expect(fixture.database.listCandidates()).toEqual([
      expect.objectContaining({ state: "applied", changedPaths: ["src/plan.ts"] }),
    ]);
    fixture.database.validateIntegrity();
    expect(renderWorkflowRunProjectionText(
      readWorkflowRunProjection(fixture.database, fixture.snapshot),
    )).toMatchSnapshot();
  });
});

async function createFixture(
  name: typeof BUILTIN_NAMES[number],
  args: JsonObject,
  script: BuiltinScript,
  options: { profile?: MeasurementProfileSnapshot; benchmark?: boolean } = {},
) {
  const root = temporaryRoot(name);
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "README.md"), `${name} fixture\n`);
  if (options.benchmark) {
    fs.writeFileSync(path.join(project, "benchmark.json"), JSON.stringify({ latency: 100, rss: 100 }));
  }
  const registry = await builtinRegistry(root);
  const ref = registry.resolve(`builtin:${name}`);
  const snapshot = createWorkflowInvocationSnapshot(ref, args, {
    authority: "model",
    projectTrusted: true,
    ...(options.profile ? {
      measurementProfiles: {
        resolve: selector => {
          if (selector !== options.profile!.id) throw new Error(`Unknown test measurement profile ${selector}`);
          return structuredClone(options.profile!);
        },
      },
    } : {}),
  });
  const now = clock();
  const environment = new StaticMeasurementEnvironmentProvider({ host: "builtin-test" });
  const measurement = options.profile ? new CandidateSensitiveMeasurementExecutor() : undefined;
  const resources = staticResources(ref, snapshot.definitionHash, measurement, environment);
  const database = WorkflowRunDatabase.create(path.join(root, "run.sqlite"), {
    runId: `flow_v17_builtin_${name.replaceAll("-", "_")}_${stableHash(root).slice(7, 15)}`,
    snapshot,
    projectSnapshotHash: treeHash(project),
    routeSnapshotHash: sha256(`routes:${name}`),
    staticResourcesHash: resources.hash,
    contextIdentityHash: sha256(`context:${name}`),
    safety: {
      concurrency: 4,
      maximumAgentLaunches: 256,
      memoryBytes: 1024 * 1024 * 1024,
      tasks: 128,
      cpuQuotaPercent: 400,
      cpuWeight: 100,
      outputBytes: 64 * 1024 * 1024,
      commandTimeoutMs: 60_000,
    },
    createdAt: new Date(BASE_TIME).toISOString(),
  });
  databases.add(database);
  const store = new WorkflowArtifactStore(root, database, { now });
  const authority = new WorkflowControlAuthorityRegistry(`builtin:${name}:${database.readRun().runId}`);
  const products = new WorkflowEffectProductFactory(authority, store);
  const driver = new BuiltinCandidateDriver(store, database, project, now);
  const candidates = new WorkflowCandidateRuntime(database, authority, driver, now);
  const metrics = ref.parsed.operations.some(value => value.method === "metrics")
    ? new WorkflowMetricSetRuntime(database, products, ref.parsed, now)
    : undefined;
  const backends = new BuiltinBackends(script, driver);
  const runtime = (faultInjector?: (
    point: WorkflowSemanticEngineFaultPoint,
    operation?: WorkflowOperationRecord,
  ) => void) => new WorkflowExecutableRuntime({
    workflow: ref.parsed,
    invocation: snapshot,
    database,
    authority,
    products,
    candidates,
    resources,
    ...(ref.parsed.operations.some(value => value.method === "agent") ? { agent: backends.agent } : {}),
    ...(ref.parsed.operations.some(value => value.method === "command") ? { command: backends.command } : {}),
    ...(ref.parsed.operations.some(value => value.method === "ask") ? { ask: backends.ask } : {}),
    ...(ref.parsed.operations.some(value => value.method === "verify") ? { verification: backends.verification } : {}),
    ...(ref.parsed.operations.some(value => value.method === "apply") ? { apply: backends.apply } : {}),
    ...(metrics ? { metrics } : {}),
    ...(metrics && measurement ? {
      measurement: { executor: measurement, environment, launchWorkspace: {
        root: project, cwd: project, treeHash: database.readRun().projectSnapshotHash,
      } },
    } : {}),
    now,
    ...(faultInjector ? { faultInjector } : {}),
  });
  return {
    root, project, ref, snapshot, resources, database, store, authority, products, driver,
    candidates, metrics, measurement, environment, backends, runtime,
  };
}

class BuiltinBackends {
  agentCalls = 0;
  commandCalls = 0;
  askCalls = 0;
  verificationCalls = 0;
  applyCalls = 0;
  private askCursor = 0;
  private verificationCursor = 0;

  constructor(private readonly script: BuiltinScript, private readonly driver: BuiltinCandidateDriver) {}

  readonly agent: WorkflowAgentEffectExecutor = {
    execute: async request => {
      this.agentCalls++;
      const reply = this.script.agent(request);
      if (reply.change) {
        if (!request.workspace) throw new Error("Scripted builtin change requires a candidate workspace");
        this.driver.write(request.workspace, reply.change.path, reply.change.contents);
      }
      return { finish: {
        receiptId: `finish_${request.operation.operationId.slice(-24)}`,
        outputSchemaHash: stableHash(request.descriptor.output),
        output: canonicalJsonObject(reply.output, {
          maxBytes: 1024 * 1024,
          maxDepth: 48,
          maxNodes: 50_000,
          maxStringScalars: 100_000,
        }),
      } };
    },
  };

  readonly command: WorkflowCommandEffectExecutor = {
    execute: async request => {
      this.commandCalls++;
      return {
        ok: true,
        exitCode: 0,
        durationMs: 5,
        output: this.script.command?.(request) ?? "",
      };
    },
  };

  readonly ask: WorkflowAskExecutor = {
    ask: async () => {
      this.askCalls++;
      const response = this.script.asks?.[this.askCursor++];
      if (response === undefined) throw new Error("No scripted builtin ask response");
      return { response, approvalId: `approval_ask_${this.askCursor}` };
    },
  };

  readonly verification: WorkflowVerificationExecutor = {
    verify: async request => {
      this.verificationCalls++;
      const status = this.script.verifications?.[this.verificationCursor++] ?? "passed";
      return {
        status,
        environmentHash: request.binding.authority.environmentHash as string,
        evidence: { checks: 4, status },
      };
    },
  };

  readonly apply: WorkflowApplyExecutor = {
    apply: async request => {
      this.applyCalls++;
      const receiptId = `apply_receipt_${request.candidate.candidateId.slice(-20)}`;
      const approvalId = `approval_${request.candidate.candidateId.slice(-20)}`;
      const changedPaths = [...request.candidate.changedPaths];
      return {
        receiptId,
        approvalId,
        candidateId: request.candidate.candidateId,
        verificationBindingHash: request.verification.bindingHash,
        changedPaths,
        authorityHash: stableHash({
          formatVersion: 1,
          candidateId: request.candidate.candidateId,
          approvalId,
          receiptId,
          verificationBindingHash: request.verification.bindingHash,
          changedPaths,
        }),
      };
    },
  };
}

class BuiltinCandidateDriver implements WorkflowCandidateWorkspaceDriver {
  private readonly changed = new Map<string, Set<string>>();

  constructor(
    private readonly store: WorkflowArtifactStore,
    private readonly database: WorkflowRunDatabase,
    private readonly launchProject: string,
    private readonly now: () => Date,
  ) {}

  async prepare(input: {
    run: WorkflowRunRecord;
    operation: WorkflowOperationRecord;
    bodyScope: WorkflowScopeRecord;
    parent?: WorkflowCandidateRecord;
    writeScope: CandidateWriteScope;
  }): Promise<WorkflowPreparedCandidateWorkspace> {
    const workspaceId = `workspace_${stableHash(input.operation.operationId).slice(7, 39)}`;
    const rootPath = `workspaces/candidates/${workspaceId}/project`;
    const target = path.join(this.store.runDir, rootPath);
    const source = input.parent
      ? path.join(this.store.runDir, this.database.readCandidateWorkspace(input.parent.workspaceId)!.rootPath)
      : this.launchProject;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
    this.changed.set(workspaceId, new Set(input.parent?.changedPaths ?? []));
    return {
      workspaceId,
      initialTreeHash: input.parent?.treeHash ?? input.run.projectSnapshotHash,
      baseLineageHash: input.parent?.lineageHash ?? sha256("builtin-launch-lineage"),
      writeScope: input.writeScope,
      writeScopeHash: stableHash(input.writeScope),
      rootPath,
    };
  }

  async describe(record: WorkflowCandidateWorkspaceRecord) {
    const root = path.join(this.store.runDir, record.rootPath);
    return { record, root, cwd: root, currentTreeHash: treeHash(root) };
  }

  write(workspace: WorkflowCandidateWorkspaceHandle, relativePath: string, contents: string): void {
    const target = path.join(workspace.root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    this.changed.get(workspace.record.workspaceId)?.add(relativePath);
  }

  async freeze(input: {
    run: WorkflowRunRecord;
    operation: WorkflowOperationRecord;
    workspace: WorkflowCandidateWorkspaceRecord;
    output: JsonValue;
  }): Promise<WorkflowFrozenCandidateWorkspace> {
    const root = path.join(this.store.runDir, input.workspace.rootPath);
    const changedPaths = [...(this.changed.get(input.workspace.workspaceId) ?? [])].sort();
    const hash = treeHash(root);
    const manifest = await this.store.putJson({
      kind: "candidate-manifest",
      value: { formatVersion: 1, treeHash: hash, changedPaths },
    });
    const diff = await this.store.putJson({
      kind: "candidate-diff",
      value: { formatVersion: 1, changedPaths },
    });
    return {
      treeHash: hash,
      lineageHash: sha256(`lineage:${input.workspace.workspaceId}:${hash}`),
      changedPaths,
      manifestArtifact: manifest.record,
      diffArtifact: diff.record,
    };
  }

  async checkpoint(input: {
    run: WorkflowRunRecord;
    operation: WorkflowOperationRecord;
    workspace: WorkflowCandidateWorkspaceRecord;
  }): Promise<WorkflowWorkspaceCheckpointRecord> {
    const checkpointId = workflowCheckpointId(
      input.run.runId,
      input.operation.operationId,
      input.workspace.workspaceId,
    );
    const storagePath = `workspaces/checkpoints/${checkpointId}`;
    const source = path.join(this.store.runDir, input.workspace.rootPath);
    const target = path.join(this.store.runDir, storagePath);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
    return {
      checkpointId,
      runId: input.run.runId,
      operationId: input.operation.operationId,
      workspaceId: input.workspace.workspaceId,
      treeHash: treeHash(source),
      lineageHash: input.workspace.baseLineageHash,
      writeScopeHash: input.workspace.writeScopeHash,
      storagePath,
      createdAt: this.now().toISOString(),
    };
  }
}

class CandidateSensitiveMeasurementExecutor implements HostCommandExecutor {
  readonly observed: Array<{ latency: number; rss: number }> = [];

  describe() {
    return { id: "workflow-builtin-benchmark", protocolVersion: 1 as const, sandbox: "fake" as const };
  }

  async execute(request: HostCommandRequest): Promise<HostCommandResult> {
    const values = JSON.parse(fs.readFileSync(path.join(request.cwd, "benchmark.json"), "utf8")) as {
      latency: number;
      rss: number;
    };
    this.observed.push(values);
    const text = [
      JSON.stringify({ type: "metric", id: "latency", value: values.latency }),
      JSON.stringify({ type: "metric", id: "rss", value: values.rss }),
      "",
    ].join("\n");
    const stdout = Buffer.from(text);
    const stderr = Buffer.alloc(0);
    const invocation = resolveCommandInvocation(request.profile, request.arguments, request.effect);
    const ordinal = this.observed.length;
    return {
      status: "completed",
      exitCode: 0,
      timedOut: false,
      stdout,
      stderr,
      stdoutEvidence: { bytes: stdout.length, digest: sha256(stdout), inlineBytes: stdout.length, truncated: false },
      stderrEvidence: { bytes: 0, digest: sha256(stderr), inlineBytes: 0, truncated: false },
      exitEvidence: { kind: "exit", code: 0 },
      invocation,
      executor: this.describe(),
      startedAt: new Date(BASE_TIME + ordinal * 10).toISOString(),
      endedAt: new Date(BASE_TIME + ordinal * 10 + 1).toISOString(),
      unit: `pi-workflow-benchmark-${"a".repeat(32)}.service`,
      unitCleaned: true,
    };
  }
}

async function recoverOnce(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  predicate: (point: WorkflowSemanticEngineFaultPoint, operation?: WorkflowOperationRecord) => boolean,
) {
  let crashed = false;
  try {
    const unexpected = await fixture.runtime((point, operation) => {
      if (!crashed && predicate(point, operation)) {
        crashed = true;
        throw new WorkflowSemanticEngineCrashError(point);
      }
    }).run();
    throw new Error(`Expected simulated crash, received ${JSON.stringify(unexpected)}; operations ${JSON.stringify(
      fixture.database.listOperations().map(value => ({
        kind: value.kind, path: value.path, status: value.status, failure: value.failure,
      })),
    )}`);
  } catch (error) {
    if (!(error instanceof WorkflowSemanticEngineCrashError)) throw error;
  }
  expect(crashed).toBe(true);
  return await fixture.runtime().run();
}

function staticResources(
  ref: WorkflowDefinitionRef,
  definitionHash: string,
  measurement: CandidateSensitiveMeasurementExecutor | undefined,
  environment: StaticMeasurementEnvironmentProvider,
) {
  const agents: Record<string, { selector: string; authority: JsonObject }> = {};
  const commands: Record<string, { selector: string; authority: JsonObject }> = {};
  for (const descriptor of ref.parsed.descriptors) {
    (descriptor.kind === "agent-task" ? agents : commands)[descriptor.identity.sourceSite] = {
      selector: descriptor.profile,
      authority: descriptor.kind === "agent-task"
        ? { profileHash: sha256(descriptor.profile), routeHash: sha256(`route:${descriptor.profile}`) }
        : { profileHash: sha256(descriptor.profile), executorHash: sha256(`executor:${descriptor.profile}`) },
    };
  }
  const verifications = Object.fromEntries(ref.parsed.review.verificationProfiles.map(selector => [
    selector,
    { selector, authority: {
      profileHash: sha256(selector),
      environmentHash: sha256(`verification-environment:${selector}`),
    } },
  ]));
  return workflowStaticEffectResources({
    workflow: ref.parsed,
    definitionHash,
    agents,
    commands,
    verifications,
    ...(measurement ? { measurementRuntime: {
      executor: measurement.describe() as unknown as JsonObject,
      environment: environment.describe() as unknown as JsonObject,
    } } : {}),
  });
}

function researchScript(): BuiltinScript {
  return { agent: request => {
    if (request.binding.selector === "builtin:researcher") {
      const title = /Research angle: ([^\n]+)/u.exec(request.prompt)?.[1] ?? "unknown";
      return { output: {
        summary: `${title} finding`,
        evidence: [{ claim: `${title} claim`, source: `https://example.test/${title.replaceAll(" ", "-")}` }],
      } };
    }
    if (request.binding.selector === "builtin:reviewer") {
      return { output: { passed: false, problems: ["tighten the causal claim"] } };
    }
    return { output: {
      answer: request.prompt.startsWith("Revise") ? "revised evidence-backed answer" : "draft answer",
      claims: [{ claim: "causal claim", sources: ["https://example.test/evidence"] }],
      openQuestions: [],
    } };
  } };
}

function packageAuditScript(): BuiltinScript {
  return {
    command: request => `tracked:${String(request.args.path)}`,
    agent: request => {
      const packageId = /package ([a-z][a-z0-9_-]*)/u.exec(request.prompt)?.[1] ?? "unknown";
      if (request.prompt.startsWith("Inspect package")) return { output: {
        packageId, summary: `${packageId} inventory`, files: [`src/${packageId}/index.ts`], observations: ["small surface"],
      } };
      if (request.prompt.startsWith("Analyze failure")) return { output: {
        packageId, summary: `${packageId} risks`, risks: ["stale state"],
      } };
      if (request.prompt.startsWith("Propose high-value")) return { output: {
        packageId, summary: `${packageId} tests`, tests: ["restart recovery"],
      } };
      return { output: { summary: "cross-package audit", priorities: ["core", "ui"] } };
    },
  };
}

function codingScript(): BuiltinScript {
  return { agent: request => request.workspace
    ? { output: {
        summary: "cache invalidation implemented",
        changedPaths: ["src/index.ts"],
        checks: ["unit tests"],
      }, change: { path: "src/index.ts", contents: "export const cacheVersion = 2;\n" } }
    : { output: { summary: "inspection complete", findings: ["one relevant boundary"] } },
  };
}

function optimizeScript(): BuiltinScript {
  return {
    verifications: ["passed", "passed"],
    agent: request => {
      const attempt = Number(/attempt (\d+)/iu.exec(request.prompt)?.[1] ?? "1");
      if (request.binding.selector === "builtin:synthesizer") {
        return { output: { learned: `attempt ${attempt} improved latency`, nextFocus: "remaining allocations" } };
      }
      const experiment = {
        hypothesis: `optimization attempt ${attempt}`,
        changeSummary: `reduce parser work in attempt ${attempt}`,
        expectedEffect: "lower latency",
        nextFocus: "allocation count",
      };
      if (!request.workspace) return { output: experiment };
      const values = attempt === 1 ? { latency: 90, rss: 102 } : { latency: 80, rss: 104 };
      return {
        output: experiment,
        change: { path: "benchmark.json", contents: JSON.stringify(values) },
      };
    },
  };
}

function goalScript(): BuiltinScript {
  return {
    verifications: ["failed", "passed"],
    agent: request => {
      if (!request.workspace) return { output: {
        outcome: "handoff",
        summary: "project mutation is required",
        outputs: [{ id: "inspection", kind: "finding", summary: "cache boundary located" }],
        nextWork: ["implement invalidation"],
        workspace: "candidate",
        blocker: null,
      } };
      const attempt = Number(/Candidate attempt (\d+)/u.exec(request.prompt)?.[1] ?? "1");
      return {
        output: {
          outcome: "completed",
          summary: `candidate attempt ${attempt} completed`,
          outputs: [{ id: `change-${attempt}`, kind: "change", summary: "invalidation implemented" }],
          nextWork: [],
          workspace: "candidate",
          blocker: null,
        },
        change: { path: "src/goal.ts", contents: `export const attempt = ${attempt};\n` },
      };
    },
  };
}

function executePlanScript(): BuiltinScript {
  return { agent: request => {
    if (!request.workspace) return { output: {
      summary: "initial plan",
      points: [
        { id: "schema", objective: "define schema", checks: ["schema check"] },
        { id: "storage", objective: "implement storage", checks: ["storage check"] },
      ],
      finalChecks: ["full test"],
    } };
    if (request.prompt.includes("Current plan revision:")) return {
      output: {
        summary: "revised transaction plan",
        points: [{ id: "transaction", objective: "add atomic transaction", checks: ["transaction check"] }],
        finalChecks: ["full test", "restart test"],
      },
      change: { path: "src/plan.ts", contents: "export const revision = 2;\n" },
    };
    const pointId = /Stable point ID: ([a-z][a-z0-9_-]*)/u.exec(request.prompt)?.[1] ?? "unknown";
    if (pointId === "storage") return {
      output: {
        outcome: "replan",
        pointId,
        summary: "storage needs a transaction",
        evidence: [{ id: "storage-evidence", summary: "atomicity gap found" }],
        nextWork: ["replace storage point with transaction point"],
        blocker: null,
      },
      change: { path: "src/plan.ts", contents: "export const schemaReady = true;\n" },
    };
    return {
      output: {
        outcome: "completed",
        pointId,
        summary: `${pointId} point completed`,
        evidence: [{ id: `${pointId}-evidence`, summary: `${pointId} check passed` }],
        nextWork: [],
        blocker: null,
      },
      change: {
        path: "src/plan.ts",
        contents: pointId === "transaction"
          ? "export const transactionReady = true;\n"
          : "export const schemaReady = true;\n",
      },
    };
  } };
}

function measurementProfile(): MeasurementProfileSnapshot {
  const definition = normalizeMeasurementProfile({
    name: "bench",
    description: "Read a candidate-local benchmark fixture.",
    argv: ["/usr/bin/workflow-benchmark"],
    timeoutMs: 30_000,
    outputs: {
      latency: { extract: { kind: "protocol" } },
      rss: { extract: { kind: "protocol" } },
    },
  });
  const namespace = "project" as const;
  return {
    ...definition,
    id: `${namespace}:${definition.name}`,
    namespace,
    path: `/trusted-profiles/${definition.name}.json`,
    hash: stableHash({ namespace, definition }),
  };
}

async function builtinRegistry(root: string): Promise<WorkflowRegistry> {
  const registry = new WorkflowRegistry();
  await registry.refresh(root, {
    builtinDir: BUILTINS,
    userDir: path.join(root, "missing-user-workflows"),
    includeProject: false,
  });
  return registry;
}

function laneKeys(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  kind: "parallel-branch" | "map-item",
): string[] {
  return fixture.database.listScopes().filter(scope => scope.kind === kind)
    .map(scope => scope.laneKey!).sort();
}

function operationKinds(fixture: Awaited<ReturnType<typeof createFixture>>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const operation of fixture.database.listOperations()) {
    result[operation.kind] = (result[operation.kind] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function temporaryRoot(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `workflow-builtin-${name}-`));
  roots.push(root);
  return root;
}

function clock(): () => Date {
  let tick = 0;
  return () => new Date(BASE_TIME + ++tick * 1_000);
}

function treeHash(root: string): string {
  const files: Array<{ path: string; digest: string }> = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Unexpected symlink in builtin fixture ${relative}`);
      if (stat.isDirectory()) visit(absolute);
      else files.push({ path: relative, digest: sha256(fs.readFileSync(absolute)) });
    }
  };
  visit(root);
  return stableHash(files);
}

function makeRemovable(root: string): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(root); } catch { return; }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.chmodSync(root, 0o700);
    for (const name of fs.readdirSync(root)) makeRemovable(path.join(root, name));
  } else {
    fs.chmodSync(root, 0o600);
  }
}
