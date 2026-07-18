import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseWorkflow } from "../src/definition/workflow-frontend.js";
import { createWorkflowInvocationSnapshot } from "../src/persistence/workflow-invocation.js";
import { WorkflowRunDatabase } from "../src/persistence/run-database.js";
import { defaultWorkflowRegistryPolicy } from "../src/registry/workflow-policy.js";
import {
  workflowDefinitionHash,
  type WorkflowDefinitionRef,
} from "../src/registry/structured-workflows.js";
import { WorkflowArtifactStore } from "../src/artifacts/store.js";
import { WorkflowEffectProductFactory } from "../src/artifacts/products.js";
import { WorkflowControlAuthorityRegistry } from "../src/runtime/control-authority.js";
import {
  WorkflowCandidateRuntime,
  type WorkflowCandidateWorkspaceDriver,
  type WorkflowFrozenCandidateWorkspace,
  type WorkflowPreparedCandidateWorkspace,
} from "../src/candidates/runtime.js";
import {
  workflowStaticEffectResources,
  type WorkflowVerificationExecutor,
} from "../src/runtime/effect-adapters.js";
import { WorkflowExecutableRuntime } from "../src/runtime/executable-runtime.js";
import { WorkflowCausalReplay } from "../src/runtime/causal-replay.js";
import {
  WorkflowSemanticEngineCrashError,
  type WorkflowSemanticEngineFaultPoint,
} from "../src/runtime/semantic-engine.js";
import { WorkflowMetricSetRuntime } from "../src/measurements/metric-set.js";
import { WorkflowMeasurementEffectAdapter } from "../src/measurements/adapter.js";
import {
  StaticMeasurementEnvironmentProvider,
} from "../src/measurements/environment.js";
import {
  normalizeMeasurementProfile,
  type MeasurementProfileDefinition,
  type MeasurementProfileSnapshot,
} from "../src/measurements/profiles.js";
import { resolveCommandInvocation } from "../src/commands/profiles.js";
import type {
  HostCommandExecutor,
  HostCommandRequest,
  HostCommandResult,
} from "../src/commands/executor.js";
import type {
  WorkflowCandidateRecord,
  WorkflowCandidateWorkspaceRecord,
  WorkflowOperationRecord,
  WorkflowRunRecord,
  WorkflowScopeRecord,
  WorkflowWorkspaceCheckpointRecord,
} from "../src/persistence/run-database-types.js";
import type { CandidateWriteScope } from "../src/runtime/durable-types.js";
import type { JsonObject, JsonValue } from "../src/types.js";
import { sha256, stableHash } from "../src/utils/hashes.js";

const roots: string[] = [];
const databases = new Set<WorkflowRunDatabase>();
const BASE_TIME = Date.parse("2026-09-01T12:00:00.000Z");

const SOURCE = `
import { schema as s, workflow } from "pi/workflows";
const Metric = s.object({
  output: s.id(),
  direction: s.enum(["minimize", "maximize"]),
});
export default workflow({
  description: "Exercise generic trusted optimization measurements.",
  input: s.object({
    evaluator: s.measurementProfile(),
    metrics: s.object({
      primary: s.object({
        output: s.id(),
        direction: s.enum(["minimize", "maximize"]),
        target: s.optional(s.object({ kind: s.enum(["value", "relativeGain", "absoluteGain"]), value: s.number() })),
        improvement: s.optional(s.object({ minimumRelative: s.number() })),
      }),
      guardrails: s.optional(s.array(s.object({
        output: s.id(),
        direction: s.enum(["minimize", "maximize"]),
        reference: s.enum(["baseline", "best"]),
        maximumRelativeRegression: s.number(),
      }))),
    }),
    sampling: s.object({ warmups: s.integer(), samples: s.integer() }),
  }),
  output: s.object({
    acceptable: s.boolean(),
    best: s.number(),
    targetReached: s.boolean(),
    experiments: s.array(s.object({
      experimentId: s.string(),
      disposition: s.enum(["accepted", "rejected"]),
      learned: s.string(),
    })),
  }),
  async run(flow, args) {
    const metrics = flow.metrics(args.metrics, args.sampling);
    await flow.measure(args.evaluator, metrics);
    const candidate = await flow.candidate(async _workspace => ({
      hypothesis: "cache normalized tokens",
      changeSummary: "cache parser normalization",
      expectedEffect: "lower latency",
      nextFocus: "allocation count",
    }), { writes: ["src/parser.ts"] });
    const measurement = await flow.measure(args.evaluator, metrics, { candidate });
    const policy = metrics.evaluate(measurement);
    let learned;
    if (!policy.acceptable) {
      await flow.reject(candidate, { measurement, reason: policy.summary });
      learned = "rejected by metric policy";
    } else {
      const verification = await flow.verify(candidate, "builtin:coding");
      if (!verification.passed) {
        await flow.reject(candidate, { measurement, verification, reason: verification.status });
        learned = "rejected by verification";
      } else {
        await flow.accept(candidate, { measurement, verification });
        learned = "accepted improvement";
      }
    }
    const experiment = await flow.recordExperiment({ candidate, measurement, learned });
    const latency = metrics.summary().latency;
    if (!latency) throw new Error("latency summary missing");
    return {
      acceptable: policy.acceptable,
      best: latency.best,
      targetReached: metrics.primary.reachedTarget(),
      experiments: [experiment],
    };
  },
});
`;

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("workflow v17 metric sets and invocation-selected evaluators", () => {
  it("accepts a primary improvement within guardrails and commits one experiment", async () => {
    const fixture = createFixture("metric-accept", [protocol(100, 100), protocol(80, 103)]);
    const outcome = await fixture.runtime().run();
    expect(outcome).toMatchObject({
      status: "completed",
      result: {
        acceptable: true,
        best: 80,
        targetReached: true,
        experiments: [{ disposition: "accepted", learned: "accepted improvement" }],
      },
    });
    expect(fixture.executor.requests).toHaveLength(2);
    expect(fixture.database.listMetricSets()[0]).toMatchObject({
      policy: { primary: { output: "latency" } },
      states: expect.arrayContaining([
        expect.objectContaining({ metricId: "latency", baseline: 100, current: 80, best: 80, relativeGain: 0.2 }),
        expect.objectContaining({ metricId: "rss", baseline: 100, current: 103, best: 103 }),
      ]),
    });
    const measurement = fixture.database.listMeasurements().at(-1)!;
    expect(fixture.database.readCandidateMeasurement(measurement.candidateId!)).toMatchObject({ status: "accepted" });
    expect(fixture.database.listExperiments()).toHaveLength(1);
    fixture.database.validateIntegrity();
  });

  it("rejects a candidate that violates a guardrail without advancing accepted metric state", async () => {
    const fixture = createFixture("metric-reject", [protocol(100, 100), protocol(80, 120)]);
    const outcome = await fixture.runtime().run();
    expect(outcome).toMatchObject({
      status: "completed",
      result: {
        acceptable: false,
        best: 100,
        targetReached: false,
        experiments: [{ disposition: "rejected", learned: "rejected by metric policy" }],
      },
    });
    expect(fixture.verificationCalls.value).toBe(0);
    expect(fixture.database.listCandidates()[0]).toMatchObject({ state: "rejected" });
    expect(fixture.database.readCandidateMeasurement(fixture.database.listCandidates()[0]!.candidateId))
      .toMatchObject({ status: "rejected" });
    fixture.database.validateIntegrity();
  });

  it("fails before candidate execution when the measurement environment drifts from baseline", async () => {
    const fixture = createFixture("metric-environment", [protocol(100, 100), protocol(80, 103)]);
    fixture.executor.afterExecute = count => {
      if (count === 1) fixture.environment.set({ host: "changed" });
    };
    const outcome = await fixture.runtime().run();
    expect(outcome).toMatchObject({
      status: "failed",
      failure: { summary: expect.stringContaining("environment differs from its baseline") },
    });
    expect(fixture.executor.requests).toHaveLength(1);
    expect(fixture.database.listCandidates()[0]).toMatchObject({ state: "abandoned" });
  });

  it("restores a durably recorded baseline after a crash without executing it twice", async () => {
    const fixture = createFixture("metric-crash", [protocol(100, 100), protocol(80, 103)]);
    let crashed = false;
    await expect(fixture.runtime({
      faultInjector: point => {
        if (!crashed && point === "after-effect-settled") {
          crashed = true;
          throw new WorkflowSemanticEngineCrashError(point);
        }
      },
    }).run()).rejects.toBeInstanceOf(WorkflowSemanticEngineCrashError);
    expect(fixture.executor.requests).toHaveLength(1);
    const recovered = await fixture.runtime().run();
    expect(recovered).toMatchObject({ status: "completed", result: { acceptable: true, best: 80 } });
    expect(fixture.executor.requests).toHaveLength(2);
    fixture.database.validateIntegrity();
  });

  it("atomically binds a settled candidate measurement before disposition recovery", async () => {
    const fixture = createFixture("metric-candidate-crash", [protocol(100, 100), protocol(80, 103)]);
    let settlements = 0;
    await expect(fixture.runtime({
      faultInjector: point => {
        if (point === "after-effect-settled" && ++settlements === 2) {
          throw new WorkflowSemanticEngineCrashError(point);
        }
      },
    }).run()).rejects.toBeInstanceOf(WorkflowSemanticEngineCrashError);
    expect(fixture.executor.requests).toHaveLength(2);
    const candidate = fixture.database.listCandidates()[0]!;
    expect(fixture.database.readCandidateMeasurement(candidate.candidateId)).toMatchObject({ status: "pending" });
    fixture.database.validateIntegrity();

    const recovered = await fixture.runtime().run();
    expect(recovered).toMatchObject({ status: "completed", result: { acceptable: true, best: 80 } });
    expect(fixture.executor.requests).toHaveLength(2);
    expect(fixture.database.readCandidateMeasurement(candidate.candidateId)).toMatchObject({ status: "accepted" });
    fixture.database.validateIntegrity();
  });

  it("rejects runtime profile switching and structural measurement lookalikes", () => {
    const fixture = createFixture("metric-authority", [protocol(100, 100), protocol(80, 103)]);
    fixture.metrics.beginExecution();
    const metricsSite = fixture.parsed.operations.find(site => site.method === "metrics")!.sourceSite;
    const measureSite = fixture.parsed.operations.find(site => site.method === "measure")!.sourceSite;
    const set = fixture.metrics.create(metricsSite, fixture.args.metrics, fixture.args.sampling);
    const adapter = new WorkflowMeasurementEffectAdapter({
      database: fixture.database,
      workflow: fixture.parsed,
      invocation: fixture.snapshot,
      resources: fixture.resources,
      products: fixture.products,
      candidates: fixture.candidates,
      metrics: fixture.metrics,
      executor: fixture.executor,
      environment: fixture.environment,
      launchWorkspace: fixture.launchWorkspace,
      now: fixture.now,
    });
    expect(() => adapter.semanticInput({
      run: fixture.database.readRun(),
      input: { operationSite: measureSite, profile: "builtin:other", metrics: set },
      signal: new AbortController().signal,
    })).toThrow("cannot switch from pinned profile project:bench");
    expect(() => fixture.metrics.call(set, "evaluate", [{}])).toThrow("attachable authority");
  });

  it("binds profile revisions and metric policy into measurement semantic identity", async () => {
    const first = createFixture("metric-identity-a", [protocol(100, 100), protocol(80, 103)]);
    const second = createFixture("metric-identity-b", [protocol(100, 100), protocol(80, 103)], {
      argv: ["/usr/bin/bench", "--revision-2"],
    });
    await first.runtime().run();
    await second.runtime().run();
    const firstCall = first.database.readScopeCall(first.database.listOperations().find(value => value.kind === "measure")!.operationId)!;
    const secondCall = second.database.readScopeCall(second.database.listOperations().find(value => value.kind === "measure")!.operationId)!;
    expect(first.snapshot.resources[0]!.profile.hash).not.toBe(second.snapshot.resources[0]!.profile.hash);
    expect(firstCall.semanticKey).not.toBe(secondCall.semanticKey);
  });

  it("materializes a replayed baseline into the target metric set without running its evaluator", async () => {
    const source = createFixture("metric-replay", [protocol(100, 100), protocol(80, 103)], {}, "flow_v17_metric_replay_source");
    await source.runtime().run();
    const target = createFixture("metric-replay", [protocol(80, 103)], {}, "flow_v17_metric_replay_target");
    const replay = await WorkflowCausalReplay.open({
      targetRunDir: target.root,
      target: target.database,
      sourceRunDir: source.root,
    });
    try {
      const outcome = await target.runtime({ replay }).run();
      expect(outcome).toMatchObject({ status: "completed", result: { acceptable: true, best: 80 } });
      expect(target.executor.requests).toHaveLength(1);
      const baseline = target.database.listOperations().find(value => value.kind === "measure")!;
      expect(target.database.readScopeCall(baseline.operationId)?.replay).toMatchObject({
        sourceRunId: "flow_v17_metric_replay_source",
      });
      expect(metricValues(target.database)).toEqual(metricValues(source.database));
      target.database.validateIntegrity();
    } finally {
      replay.close();
    }
  });
});

function createFixture(
  name: string,
  outputs: string[],
  profileChange: Partial<MeasurementProfileDefinition> = {},
  runId = `flow_v17_${name.replace(/-/gu, "_")}`,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `workflow-${name}-`));
  roots.push(root);
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "README.md"), "fixture\n");
  const parsed = parseWorkflow(SOURCE, { fileName: `${name}.flow.ts` });
  const policy = defaultWorkflowRegistryPolicy(root, "user");
  const ref: WorkflowDefinitionRef = {
    formatVersion: 1,
    id: `user:${name}`,
    namespace: "user",
    name,
    description: parsed.metadata.description,
    input: parsed.metadata.input,
    output: parsed.metadata.output,
    exposure: "human",
    policy,
    path: path.join(root, `${name}.flow.ts`),
    source: SOURCE,
    sourceHash: parsed.sourceHash,
    definitionHash: workflowDefinitionHash(`user:${name}`, parsed),
    parsed,
  };
  const profile = measurementProfile(root, profileChange);
  const args = {
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
  };
  const snapshot = createWorkflowInvocationSnapshot(ref, args, {
    authority: "user",
    projectTrusted: true,
    measurementProfiles: { resolve: selector => {
      if (selector !== profile.id) throw new Error(`Unknown profile ${selector}`);
      return structuredClone(profile);
    } },
  });
  const environment = new StaticMeasurementEnvironmentProvider({ host: "stable" });
  const executor = new ScriptedMeasurementExecutor(outputs);
  const verifications = {
    "builtin:coding": {
      selector: "builtin:coding",
      authority: {
        profileHash: sha256("builtin:coding"),
        environmentHash: sha256("verification-environment"),
      },
    },
  };
  const resources = workflowStaticEffectResources({
    workflow: parsed,
    definitionHash: snapshot.definitionHash,
    verifications,
    measurementRuntime: {
      executor: executor.describe() as unknown as JsonObject,
      environment: environment.describe() as unknown as JsonObject,
    },
  });
  const database = WorkflowRunDatabase.create(path.join(root, "run.sqlite"), {
    runId,
    snapshot,
    projectSnapshotHash: sha256(`project:${name}`),
    routeSnapshotHash: sha256(`routes:${name}`),
    staticResourcesHash: resources.hash,
    contextIdentityHash: sha256(`context:${name}`),
    safety: {
      concurrency: 4,
      maximumAgentLaunches: 100,
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
  const now = clock();
  const store = new WorkflowArtifactStore(root, database, { now });
  const authority = new WorkflowControlAuthorityRegistry(`run:${name}`);
  const products = new WorkflowEffectProductFactory(authority, store);
  const driver = new MeasurementCandidateDriver(store, now);
  const candidates = new WorkflowCandidateRuntime(database, authority, driver, now);
  const metrics = new WorkflowMetricSetRuntime(database, products, parsed, now);
  const verificationCalls = { value: 0 };
  const verification: WorkflowVerificationExecutor = {
    verify: async request => {
      verificationCalls.value++;
      return {
        status: "passed",
        environmentHash: request.binding.authority.environmentHash as string,
        evidence: { checks: 2 },
      };
    },
  };
  const launchWorkspace = { root: project, cwd: project, treeHash: database.readRun().projectSnapshotHash };
  const runtime = (options: {
    faultInjector?: (point: WorkflowSemanticEngineFaultPoint, operation?: WorkflowOperationRecord) => void;
    replay?: WorkflowCausalReplay;
  } = {}) => new WorkflowExecutableRuntime({
    workflow: parsed,
    invocation: snapshot,
    database,
    authority,
    products,
    candidates,
    resources,
    metrics,
    measurement: { executor, environment, launchWorkspace },
    verification,
    now,
    ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
    ...(options.replay ? { replay: options.replay } : {}),
  });
  return {
    root, parsed, snapshot, database, store, authority, products, driver, candidates,
    metrics, environment, executor, verificationCalls, resources, args, launchWorkspace, now, runtime,
  };
}

function measurementProfile(root: string, change: Partial<MeasurementProfileDefinition>): MeasurementProfileSnapshot {
  const definition = normalizeMeasurementProfile({
    name: "bench",
    description: "Measure parser latency and resident memory.",
    argv: ["/usr/bin/bench"],
    timeoutMs: 30_000,
    outputs: {
      latency: { extract: { kind: "protocol" } },
      rss: { extract: { kind: "protocol" } },
    },
    ...change,
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

function protocol(latency: number, rss: number): string {
  return [
    JSON.stringify({ type: "metric", id: "latency", value: latency }),
    JSON.stringify({ type: "metric", id: "rss", value: rss }),
    "",
  ].join("\n");
}

function metricValues(database: WorkflowRunDatabase) {
  return database.listMetricSets()[0]!.states.map(state => ({
    metricId: state.metricId,
    baseline: state.baseline,
    current: state.current,
    best: state.best,
    relativeGain: state.relativeGain,
    observationCount: state.observationCount,
  }));
}

class ScriptedMeasurementExecutor implements HostCommandExecutor {
  readonly requests: HostCommandRequest[] = [];
  afterExecute?: (count: number) => void;

  constructor(private readonly outputs: string[]) {}

  describe() { return { id: "workflow-measurement-test", protocolVersion: 1 as const, sandbox: "fake" as const }; }

  async execute(request: HostCommandRequest): Promise<HostCommandResult> {
    const output = this.outputs[this.requests.length];
    if (output === undefined) throw new Error(`No scripted output for measurement call ${this.requests.length}`);
    this.requests.push(request);
    const stdout = Buffer.from(output);
    const stderr = Buffer.alloc(0);
    const invocation = resolveCommandInvocation(request.profile, request.arguments, request.effect);
    const index = this.requests.length;
    this.afterExecute?.(index);
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
      startedAt: new Date(BASE_TIME + index * 10).toISOString(),
      endedAt: new Date(BASE_TIME + index * 10 + 1).toISOString(),
      unit: `pi-workflow-measurement-${"a".repeat(32)}.service`,
      unitCleaned: true,
    };
  }
}

class MeasurementCandidateDriver implements WorkflowCandidateWorkspaceDriver {
  constructor(private readonly store: WorkflowArtifactStore, private readonly now: () => Date) {}

  async prepare(input: {
    run: WorkflowRunRecord;
    operation: WorkflowOperationRecord;
    bodyScope: WorkflowScopeRecord;
    parent?: WorkflowCandidateRecord;
    writeScope: CandidateWriteScope;
  }): Promise<WorkflowPreparedCandidateWorkspace> {
    const workspaceId = `workspace_${stableHash(input.operation.operationId).slice(7, 39)}`;
    const rootPath = `workspaces/candidates/${workspaceId}/project`;
    fs.mkdirSync(path.join(this.store.runDir, rootPath), { recursive: true });
    return {
      workspaceId,
      initialTreeHash: input.parent?.treeHash ?? input.run.projectSnapshotHash,
      baseLineageHash: input.parent?.lineageHash ?? sha256("launch-lineage"),
      writeScope: input.writeScope,
      writeScopeHash: stableHash(input.writeScope),
      rootPath,
    };
  }

  async describe(record: WorkflowCandidateWorkspaceRecord) {
    return {
      record,
      root: path.join(this.store.runDir, record.rootPath),
      cwd: path.join(this.store.runDir, record.rootPath),
      currentTreeHash: record.state === "frozen" ? sha256(`changed:${record.workspaceId}`) : record.initialTreeHash,
    };
  }

  async freeze(input: {
    run: WorkflowRunRecord;
    operation: WorkflowOperationRecord;
    workspace: WorkflowCandidateWorkspaceRecord;
    output: JsonValue;
  }): Promise<WorkflowFrozenCandidateWorkspace> {
    const changedPaths = ["src/parser.ts"];
    const treeHash = sha256(`changed:${input.workspace.workspaceId}`);
    const manifest = await this.store.putJson({ kind: "candidate-manifest", value: { treeHash, changedPaths } });
    const diff = await this.store.putJson({ kind: "candidate-diff", value: { changedPaths } });
    return {
      treeHash,
      lineageHash: sha256(`lineage:${input.workspace.workspaceId}:${treeHash}`),
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
    return {
      checkpointId: `checkpoint_${stableHash(input.operation.operationId).slice(7, 39)}`,
      runId: input.run.runId,
      operationId: input.operation.operationId,
      workspaceId: input.workspace.workspaceId,
      treeHash: sha256(`changed:${input.workspace.workspaceId}`),
      lineageHash: input.workspace.baseLineageHash,
      writeScopeHash: input.workspace.writeScopeHash,
      storagePath: `workspaces/checkpoints/${input.operation.operationId}`,
      createdAt: this.now().toISOString(),
    };
  }
}

function clock(): () => Date {
  let tick = 0;
  return () => new Date(BASE_TIME + ++tick * 1_000);
}
