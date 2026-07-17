import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseWorkflowV17 } from "../src/definition/workflow-v17-frontend.js";
import { createWorkflowV17InvocationSnapshot } from "../src/persistence/workflow-v17-invocation.js";
import { WorkflowRunDatabaseV17 } from "../src/persistence/run-database-v17.js";
import { defaultWorkflowV17RegistryPolicy } from "../src/registry/workflow-v17-policy.js";
import {
  workflowV17DefinitionHash,
  type WorkflowV17DefinitionRef,
} from "../src/registry/structured-workflows-v17.js";
import { WorkflowV17ArtifactStore } from "../src/artifacts/store-v17.js";
import { WorkflowV17EffectProductFactory } from "../src/artifacts/products-v17.js";
import { WorkflowV17ControlAuthorityRegistry } from "../src/runtime/control-authority-v17.js";
import {
  WorkflowV17CandidateRuntime,
  type WorkflowV17CandidateWorkspaceDriver,
  type WorkflowV17FrozenCandidateWorkspace,
  type WorkflowV17PreparedCandidateWorkspace,
} from "../src/candidates/runtime-v17.js";
import {
  workflowV17StaticEffectResources,
  type WorkflowV17VerificationExecutor,
} from "../src/runtime/effect-adapters-v17.js";
import { WorkflowV17ExecutableRuntime } from "../src/runtime/executable-runtime-v17.js";
import { WorkflowV17CausalReplay } from "../src/runtime/causal-replay-v17.js";
import {
  WorkflowV17SemanticEngineCrashError,
  type WorkflowV17SemanticEngineFaultPoint,
} from "../src/runtime/semantic-engine-v17.js";
import { WorkflowV17MetricSetRuntime } from "../src/measurements/metric-set-v17.js";
import { WorkflowV17MeasurementEffectAdapter } from "../src/measurements/adapter-v17.js";
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
  WorkflowCandidateV17Record,
  WorkflowCandidateWorkspaceV17Record,
  WorkflowOperationV17Record,
  WorkflowRunV17Record,
  WorkflowScopeV17Record,
  WorkflowWorkspaceCheckpointV17Record,
} from "../src/persistence/run-database-v17-types.js";
import type { CandidateWriteScope } from "../src/candidates/store.js";
import type { JsonObject, JsonValue } from "../src/types.js";
import { sha256, stableHash } from "../src/utils/hashes.js";

const roots: string[] = [];
const databases = new Set<WorkflowRunDatabaseV17>();
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
          throw new WorkflowV17SemanticEngineCrashError(point);
        }
      },
    }).run()).rejects.toBeInstanceOf(WorkflowV17SemanticEngineCrashError);
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
          throw new WorkflowV17SemanticEngineCrashError(point);
        }
      },
    }).run()).rejects.toBeInstanceOf(WorkflowV17SemanticEngineCrashError);
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
    const adapter = new WorkflowV17MeasurementEffectAdapter({
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
    const replay = await WorkflowV17CausalReplay.open({
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `workflow-v17-${name}-`));
  roots.push(root);
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "README.md"), "fixture\n");
  const parsed = parseWorkflowV17(SOURCE, { fileName: `${name}.flow.ts` });
  const policy = defaultWorkflowV17RegistryPolicy(root, "user");
  const ref: WorkflowV17DefinitionRef = {
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
    definitionHash: workflowV17DefinitionHash(`user:${name}`, parsed),
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
  const snapshot = createWorkflowV17InvocationSnapshot(ref, args, {
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
  const resources = workflowV17StaticEffectResources({
    workflow: parsed,
    definitionHash: snapshot.definitionHash,
    verifications,
    measurementRuntime: {
      executor: executor.describe() as unknown as JsonObject,
      environment: environment.describe() as unknown as JsonObject,
    },
  });
  const database = WorkflowRunDatabaseV17.create(path.join(root, "run.sqlite"), {
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
  const store = new WorkflowV17ArtifactStore(root, database, { now });
  const authority = new WorkflowV17ControlAuthorityRegistry(`run:${name}`);
  const products = new WorkflowV17EffectProductFactory(authority, store);
  const driver = new MeasurementCandidateDriver(store, now);
  const candidates = new WorkflowV17CandidateRuntime(database, authority, driver, now);
  const metrics = new WorkflowV17MetricSetRuntime(database, products, parsed, now);
  const verificationCalls = { value: 0 };
  const verification: WorkflowV17VerificationExecutor = {
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
    faultInjector?: (point: WorkflowV17SemanticEngineFaultPoint, operation?: WorkflowOperationV17Record) => void;
    replay?: WorkflowV17CausalReplay;
  } = {}) => new WorkflowV17ExecutableRuntime({
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

function metricValues(database: WorkflowRunDatabaseV17) {
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

  describe() { return { id: "workflow-v17-measurement-test", protocolVersion: 1 as const, sandbox: "fake" as const }; }

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

class MeasurementCandidateDriver implements WorkflowV17CandidateWorkspaceDriver {
  constructor(private readonly store: WorkflowV17ArtifactStore, private readonly now: () => Date) {}

  async prepare(input: {
    run: WorkflowRunV17Record;
    operation: WorkflowOperationV17Record;
    bodyScope: WorkflowScopeV17Record;
    parent?: WorkflowCandidateV17Record;
    writeScope: CandidateWriteScope;
  }): Promise<WorkflowV17PreparedCandidateWorkspace> {
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

  async describe(record: WorkflowCandidateWorkspaceV17Record) {
    return {
      record,
      root: path.join(this.store.runDir, record.rootPath),
      cwd: path.join(this.store.runDir, record.rootPath),
      currentTreeHash: record.state === "frozen" ? sha256(`changed:${record.workspaceId}`) : record.initialTreeHash,
    };
  }

  async freeze(input: {
    run: WorkflowRunV17Record;
    operation: WorkflowOperationV17Record;
    workspace: WorkflowCandidateWorkspaceV17Record;
    output: JsonValue;
  }): Promise<WorkflowV17FrozenCandidateWorkspace> {
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
    run: WorkflowRunV17Record;
    operation: WorkflowOperationV17Record;
    workspace: WorkflowCandidateWorkspaceV17Record;
  }): Promise<WorkflowWorkspaceCheckpointV17Record> {
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
