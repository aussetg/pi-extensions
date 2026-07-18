import path from "node:path";
import { canonicalJsonObject, canonicalJsonValue } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import type { ParsedWorkflow } from "../definition/workflow-types.js";
import type { WorkflowInvocationSnapshot, WorkflowMeasurementResourceBinding } from "../persistence/workflow-invocation.js";
import {
  WorkflowRunDatabase,
  WorkflowRunDatabaseRevisionConflictError,
} from "../persistence/run-database.js";
import type {
  WorkflowAttemptRecord,
  WorkflowCallArtifactInput,
  WorkflowCandidateRecord,
  WorkflowMeasurementSampleRecord,
  WorkflowMeasurementRecord,
  WorkflowOperationRecord,
} from "../persistence/run-database-types.js";
import type { JsonObject, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import type { HostCommandExecutor, HostCommandResult } from "../commands/executor.js";
import { normalizeCommandProfile, type CommandProfileSnapshot } from "../commands/profiles.js";
import { zeroUsage } from "../runtime/durable-types.js";
import type {
  WorkflowEffectAdapterContext,
  WorkflowEffectIdentity,
  WorkflowEffectRestoreContext,
  WorkflowSemanticEffectAdapter,
} from "../runtime/semantic-engine.js";
import type { WorkflowStaticEffectResources } from "../runtime/effect-adapters.js";
import { WorkflowEffectProductFactory } from "../artifacts/products.js";
import { WorkflowCandidateRuntime } from "../candidates/runtime.js";
import {
  assertMeasurementEnvironmentDescriptor,
  normalizeMeasurementEnvironmentFingerprint,
  type MeasurementEnvironmentFingerprint,
  type MeasurementEnvironmentProvider,
} from "./environment.js";
import { extractMeasurementInvocation } from "./extractors.js";
import { aggregateMetricSamples } from "./metric-definition.js";
import { normalizeMetricCohortDelta, type MetricCohortDelta } from "./metrics.js";
import type { MeasurementProfileSnapshot } from "./profiles.js";
import { WorkflowMetricSetRuntime, type WorkflowNormalizedMetricSet } from "./metric-set.js";

const MAX_REVISION_RETRIES = 16;

export interface WorkflowMeasurementLaunchWorkspace {
  root: string;
  cwd: string;
  treeHash: string;
}

interface ResolvedMeasurement {
  operationSite: string;
  metricSet: ReturnType<WorkflowMetricSetRuntime["metricSet"]>;
  normalized: WorkflowNormalizedMetricSet;
  profile: MeasurementProfileSnapshot;
  resourceHash: string;
  command: { argv: string[]; env: Record<string, string>; timeoutMs: number };
  commandHash: string;
  commandProfile: CommandProfileSnapshot;
  workspaceRoot: string;
  cwd: string;
  workspaceTreeHash: string;
  candidate?: WorkflowCandidateRecord;
  environment?: MeasurementEnvironmentFingerprint;
  bindingHash?: string;
}

interface MeasurementInput {
  operationSite: string;
  profile: string;
  metrics: object;
  candidate?: object;
}

interface StoredMeasurementResult {
  formatVersion: 1;
  authorityId: string;
  measurementId: string;
  policyHash: string;
  samplingHash: string;
  profile: MeasurementProfileSnapshot;
  commandHash: string;
  environment: JsonObject;
  environmentHash: string;
  workspaceTreeHash: string;
  candidateId?: string;
  bindingHash: string;
  delta: MetricCohortDelta;
  observations: JsonObject;
  artifactDigest: string;
  diagnosticsArtifactDigest?: string;
  samples: WorkflowMeasurementSampleRecord[];
}

export interface WorkflowMeasurementAdapterOptions {
  database: WorkflowRunDatabase;
  workflow: ParsedWorkflow;
  invocation: WorkflowInvocationSnapshot;
  resources: WorkflowStaticEffectResources;
  products: WorkflowEffectProductFactory;
  candidates: WorkflowCandidateRuntime;
  metrics: WorkflowMetricSetRuntime;
  executor: HostCommandExecutor;
  environment: MeasurementEnvironmentProvider;
  launchWorkspace: WorkflowMeasurementLaunchWorkspace;
  now?: () => Date;
}

/** Trusted profile measurement execution over run-local metric sets. */
export class WorkflowMeasurementEffectAdapter implements WorkflowSemanticEffectAdapter {
  readonly kind = "measure" as const;
  private readonly now: () => Date;
  private readonly resolved = new Map<string, ResolvedMeasurement>();

  constructor(private readonly options: WorkflowMeasurementAdapterOptions) {
    this.now = options.now ?? (() => new Date());
    const runtime = options.resources.measurementRuntime;
    if (!runtime) throw new Error("Workflow v17 measurement runtime authority is unavailable");
    const executor = canonicalJsonObject(options.executor.describe() as unknown as JsonObject, limits());
    const environment = canonicalJsonObject(options.environment.describe() as unknown as JsonObject, limits());
    assertMeasurementEnvironmentDescriptor(options.environment.describe());
    if (stableHash(executor) !== runtime.executorHash || stableHash(environment) !== runtime.environmentHash
      || stableJson(executor) !== stableJson(runtime.executor)
      || stableJson(environment) !== stableJson(runtime.environment)) {
      throw new Error("Workflow v17 measurement executor or environment differs from pinned authority");
    }
    const root = path.resolve(options.launchWorkspace.root);
    const cwd = path.resolve(options.launchWorkspace.cwd);
    assertContained(root, cwd, true);
    if (!/^sha256:[a-f0-9]{64}$/u.test(options.launchWorkspace.treeHash)) {
      throw new TypeError("Workflow v17 launch measurement workspace tree is invalid");
    }
  }

  semanticInput(context: Omit<WorkflowEffectAdapterContext, "semanticInput" | "operation">): JsonValue {
    const resolved = this.resolve(context.input);
    return canonicalJsonValue({
      formatVersion: 1,
      operationSite: resolved.operationSite,
      policyHash: resolved.metricSet.policyHash,
      samplingHash: resolved.metricSet.samplingHash,
      profileId: resolved.profile.id,
      profileHash: resolved.profile.hash,
      resourceHash: resolved.resourceHash,
      commandHash: resolved.commandHash,
      workspaceTreeHash: resolved.workspaceTreeHash,
      ...(resolved.candidate ? { candidate: candidateAuthority(resolved.candidate) } : {}),
      measurementRuntimeHash: this.options.resources.measurementRuntime!.hash,
    }, limits());
  }

  async journalIdentity(
    context: WorkflowEffectAdapterContext & { operation: WorkflowOperationRecord },
  ): Promise<WorkflowEffectIdentity> {
    const resolved = this.resolve(context.input);
    const fingerprint = normalizeMeasurementEnvironmentFingerprint(await this.options.environment.capture({
      profile: resolved.profile,
      workspaceTreeHash: resolved.workspaceTreeHash,
      commandHash: resolved.commandHash,
    }));
    assertComparableBaseline(resolved.metricSet.states, resolved.profile.hash, fingerprint.hash);
    const bindingHash = stableHash({
      formatVersion: 1,
      policyHash: resolved.metricSet.policyHash,
      samplingHash: resolved.metricSet.samplingHash,
      profileHash: resolved.profile.hash,
      commandHash: resolved.commandHash,
      workspaceTreeHash: resolved.workspaceTreeHash,
      candidateId: resolved.candidate?.candidateId ?? null,
      cpuAffinity: resolved.profile.cpuAffinity ?? null,
      environmentHash: fingerprint.hash,
      measurementRuntimeHash: this.options.resources.measurementRuntime!.hash,
    });
    resolved.environment = fingerprint;
    resolved.bindingHash = bindingHash;
    this.resolved.set(context.operation.operationId, resolved);
    return {
      semanticKey: stableHash({
        formatVersion: 1,
        kind: "workflow-measurement",
        bindingHash,
        contextIdentityHash: context.run.contextIdentityHash,
      }),
      completionAuthority: "host-effect",
      replayPolicy: "immutable",
    };
  }

  async execute(
    context: WorkflowEffectAdapterContext & { operation: WorkflowOperationRecord },
  ): Promise<JsonValue> {
    const resolved = this.requireResolved(context.operation, context.input);
    const existing = this.options.database.readMeasurementByOperation(context.operation.operationId);
    if (existing) {
      if (existing.bindingHash !== resolved.bindingHash) {
        throw new Error("Workflow v17 measurement binding changed after durable execution");
      }
      const attempt = await admitAttempt(this.options.database, context.operation, this.now);
      await finishAttempt(this.options.database, attempt, "completed", this.now);
      return storedMeasurement(existing, undefined, resolved.metricSet) as unknown as JsonValue;
    }
    const attempt = await admitAttempt(this.options.database, context.operation, this.now);
    try {
      const values = new Map<string, number[]>();
      for (const definition of resolved.normalized.definitions) values.set(definition.output, []);
      const samples: WorkflowMeasurementSampleRecord[] = [];
      const diagnostics: Array<{ sample: number; data: JsonObject }> = [];
      const count = resolved.normalized.sampling.warmups + resolved.normalized.sampling.samples;
      for (let ordinal = 0; ordinal < count; ordinal++) {
        const kind = ordinal < resolved.normalized.sampling.warmups ? "warmup" as const : "sample" as const;
        const sampleIndex = kind === "warmup" ? ordinal : ordinal - resolved.normalized.sampling.warmups;
        const executionId = `measurement_${stableHash({
          runId: context.run.runId,
          operationId: context.operation.operationId,
          ordinal,
        }).slice(7, 39)}`;
        const result = await this.options.executor.execute({
          runId: context.run.runId,
          operationPath: context.operation.path,
          attempt: 1,
          executionId,
          runDir: this.options.products.store.runDir,
          workspaceRoot: resolved.workspaceRoot,
          cwd: resolved.cwd,
          profile: resolved.commandProfile,
          arguments: {},
          effect: "read-only",
          safety: context.run.safety,
          maximumOutputBytes: Math.min(context.run.safety.outputBytes, DEFINITION_LIMITS.measurementStreamBytes),
          inlineLimitBytes: DEFINITION_LIMITS.measurementStreamBytes,
          unitKind: "measurement",
          ...(resolved.profile.cpuAffinity
            ? { physicalCoreAffinity: resolved.profile.cpuAffinity.physicalCores } : {}),
        }, context.signal);
        assertMeasurementCommandResult(result, resolved.commandProfile, this.options.executor.describe());
        const extracted = extractMeasurementInvocation(
          resolved.profile,
          resolved.normalized.definitions.map(value => value.output),
          result.stdout,
        );
        const stdout = await this.options.products.store.putBytes({ kind: "measurement-stdout", bytes: result.stdout });
        const stderr = await this.options.products.store.putBytes({ kind: "measurement-stderr", bytes: result.stderr });
        samples.push({
          ordinal,
          kind,
          sampleIndex,
          executionId,
          status: result.status,
          exitCode: result.exitCode,
          ...(result.signal ? { signal: result.signal } : {}),
          timedOut: result.timedOut,
          stdoutArtifactDigest: stdout.record.digest,
          stderrArtifactDigest: stderr.record.digest,
          startedAt: result.startedAt,
          endedAt: result.endedAt,
        });
        if (kind === "sample") {
          for (const definition of resolved.normalized.definitions) {
            values.get(definition.output)!.push(extracted.values[definition.output]!);
          }
          if (extracted.diagnostic) diagnostics.push({ sample: sampleIndex, data: extracted.diagnostic });
        }
      }
      const measurementId = `measurement_${stableHash({
        formatVersion: 1,
        runId: context.run.runId,
        operationId: context.operation.operationId,
      }).slice(7, 39)}`;
      const delta = buildDelta(measurementId, context.operation.path, resolved, values);
      const observations = publicObservations(delta);
      const diagnosticsArtifact = diagnostics.length
        ? await this.options.products.store.putJson({ kind: "measurement-diagnostics", value: diagnostics })
        : undefined;
      const authorityId = `measurement-${measurementId.slice(-32)}`;
      const product = await this.options.products.measurement({
        authorityId,
        measurementId,
        observations,
        ...(diagnosticsArtifact ? { diagnostics: this.options.products.artifact(diagnosticsArtifact.record) } : {}),
      }) as { artifact: object };
      const artifactDigest = this.options.products.artifactRecord(product.artifact).digest;
      const record = await revisionRetry(async () => this.options.database.recordMeasurement(
        this.options.database.readRun().revision,
        {
          measurementId,
          operationId: context.operation.operationId,
          metricSetId: resolved.metricSet.metricSetId,
          profile: resolved.profile,
          profileHash: resolved.profile.hash,
          commandHash: resolved.commandHash,
          environment: resolved.environment!.data,
          environmentHash: resolved.environment!.hash,
          workspaceTreeHash: resolved.workspaceTreeHash,
          ...(resolved.candidate ? { candidateId: resolved.candidate.candidateId } : {}),
          bindingHash: resolved.bindingHash!,
          delta,
          observations,
          artifactDigest,
          ...(diagnosticsArtifact ? { diagnosticsArtifactDigest: diagnosticsArtifact.record.digest } : {}),
          samples,
          createdAt: timestamp(this.now),
        },
      ));
      await finishAttempt(this.options.database, attempt, "completed", this.now);
      return storedMeasurement(record, authorityId, resolved.metricSet) as unknown as JsonValue;
    } catch (error) {
      await finishAttempt(this.options.database, attempt, "failed", this.now).catch(() => undefined);
      throw error;
    }
  }

  evidence(context: WorkflowEffectAdapterContext & { result: JsonValue }): { artifacts: WorkflowCallArtifactInput[] } {
    const result = parseStoredMeasurement(context.result);
    const digests = [
      result.artifactDigest,
      ...(result.diagnosticsArtifactDigest ? [result.diagnosticsArtifactDigest] : []),
      ...result.samples.flatMap(sample => [sample.stdoutArtifactDigest, sample.stderrArtifactDigest]),
    ];
    const unique = [...new Set(digests)];
    return {
      artifacts: unique.map((digest, ordinal) => {
        const artifact = this.options.database.readArtifact(digest);
        if (!artifact) throw new Error(`Workflow v17 measurement artifact ${digest} is unavailable`);
        return { role: ordinal === 0 ? "output" as const : "evidence" as const, ordinal, artifact };
      }),
    };
  }

  async restore(context: WorkflowEffectRestoreContext): Promise<unknown> {
    const result = parseStoredMeasurement(context.result);
    const resolved = this.requireResolved(context.operation, context.input);
    const record = await this.ensureRecord(context.operation, resolved, result);
    if (record.candidateId) {
      await revisionRetry(async () => this.options.database.registerCandidateMeasurement(
        this.options.database.readRun().revision,
        {
          measurementId: record.measurementId,
          candidateId: record.candidateId!,
          operationId: context.operation.operationId,
          bindingHash: record.bindingHash,
          createdAt: context.operation.endedAt ?? context.operation.updatedAt,
        },
      ));
    }
    this.options.metrics.observeMeasurement(record);
    const diagnostics = record.diagnosticsArtifactDigest
      ? this.artifact(record.diagnosticsArtifactDigest) : undefined;
    return await this.options.products.measurement({
      authorityId: result.authorityId,
      measurementId: record.measurementId,
      observations: record.observations,
      ...(diagnostics ? { diagnostics } : {}),
    });
  }

  private async ensureRecord(
    operation: WorkflowOperationRecord,
    resolved: ResolvedMeasurement,
    result: StoredMeasurementResult,
  ): Promise<WorkflowMeasurementRecord> {
    const existing = this.options.database.readMeasurementByOperation(operation.operationId);
    if (existing) {
      if (existing.measurementId !== result.measurementId || existing.bindingHash !== result.bindingHash) {
        throw new Error("Workflow v17 restored measurement differs from durable evidence");
      }
      return existing;
    }
    if (result.policyHash !== resolved.metricSet.policyHash
      || result.samplingHash !== resolved.metricSet.samplingHash
      || result.profile.id !== resolved.profile.id || result.profile.hash !== resolved.profile.hash
      || result.commandHash !== resolved.commandHash || result.workspaceTreeHash !== resolved.workspaceTreeHash
      || result.candidateId !== resolved.candidate?.candidateId
      || result.environmentHash !== resolved.environment?.hash
      || result.bindingHash !== resolved.bindingHash) {
      throw new Error("Workflow v17 replayed measurement differs from target authority");
    }
    return await revisionRetry(async () => this.options.database.recordMeasurement(
      this.options.database.readRun().revision,
      {
        measurementId: result.measurementId,
        operationId: operation.operationId,
        metricSetId: resolved.metricSet.metricSetId,
        profile: result.profile,
        profileHash: result.profile.hash,
        commandHash: result.commandHash,
        environment: result.environment,
        environmentHash: result.environmentHash,
        workspaceTreeHash: result.workspaceTreeHash,
        ...(result.candidateId ? { candidateId: result.candidateId } : {}),
        bindingHash: result.bindingHash,
        delta: result.delta,
        observations: result.observations,
        artifactDigest: result.artifactDigest,
        ...(result.diagnosticsArtifactDigest ? {
          diagnosticsArtifactDigest: result.diagnosticsArtifactDigest,
        } : {}),
        samples: result.samples,
        createdAt: operation.endedAt ?? operation.updatedAt,
      },
    ));
  }

  private requireResolved(operation: WorkflowOperationRecord, input: unknown): ResolvedMeasurement {
    const resolved = this.resolved.get(operation.operationId) ?? this.resolve(input);
    if (!resolved.environment || !resolved.bindingHash) {
      throw new Error("Workflow v17 measurement environment was not admitted");
    }
    return resolved;
  }

  private resolve(value: unknown): ResolvedMeasurement {
    const input = plainRecord(value, "workflow v17 measurement input") as unknown as MeasurementInput;
    exactKeys(input as unknown as object, ["operationSite", "profile", "metrics", "candidate"], "workflow v17 measurement input", true);
    if (typeof input.operationSite !== "string" || typeof input.profile !== "string") {
      throw new TypeError("Workflow v17 measurement input is incomplete");
    }
    const site = this.options.workflow.operations.find(value => value.sourceSite === input.operationSite);
    if (site?.method !== "measure") throw new TypeError(`Unknown workflow v17 measurement site ${input.operationSite}`);
    const metricSet = this.options.metrics.metricSet(input.metrics);
    const normalized = this.options.metrics.normalized(metricSet);
    const resource = resolveProfile(
      this.options.invocation,
      this.options.resources,
      input.operationSite,
      input.profile,
      normalized,
    );
    const command = {
      argv: [...resource.profile.argv],
      env: Object.fromEntries(Object.entries(resource.profile.env ?? {}).sort(([left], [right]) => left.localeCompare(right))),
      timeoutMs: resource.profile.timeoutMs,
    };
    const commandHash = stableHash(command);
    const commandProfile = measurementCommandProfile(resource.profile, command);
    let candidate: WorkflowCandidateRecord | undefined;
    let workspaceRoot = path.resolve(this.options.launchWorkspace.root);
    let cwd = path.resolve(this.options.launchWorkspace.cwd);
    let workspaceTreeHash = this.options.launchWorkspace.treeHash;
    if (input.candidate !== undefined) {
      candidate = this.options.candidates.candidate(input.candidate);
      if (candidate.state !== "pending") throw new Error(`Candidate ${candidate.candidateId} is ${candidate.state}`);
      const record = this.options.database.readCandidateWorkspace(candidate.workspaceId);
      if (!record) throw new Error(`Candidate ${candidate.candidateId} has no workspace`);
      workspaceRoot = path.join(this.options.products.store.runDir, record.rootPath);
      cwd = workspaceRoot;
      assertContained(this.options.products.store.runDir, workspaceRoot);
      workspaceTreeHash = candidate.treeHash;
    }
    return {
      operationSite: input.operationSite,
      metricSet,
      normalized,
      profile: resource.profile,
      resourceHash: resource.hash,
      command,
      commandHash,
      commandProfile,
      workspaceRoot,
      cwd,
      workspaceTreeHash,
      ...(candidate ? { candidate } : {}),
    };
  }

  private artifact(digest: string): object {
    const record = this.options.database.readArtifact(digest);
    if (!record) throw new Error(`Workflow v17 measurement artifact ${digest} is unavailable`);
    return this.options.products.artifact(record);
  }
}

interface ExperimentInput { candidate: object; measurement: object; learned: string }
interface StoredExperiment {
  formatVersion: 1;
  experimentId: string;
  candidateId: string;
  measurementId: string;
  disposition: "accepted" | "rejected";
  learned: string;
  bindingHash: string;
  artifactDigest: string;
}

/** Durable experiment timeline records remain ordinary JSON at the language boundary. */
export class WorkflowExperimentEffectAdapter implements WorkflowSemanticEffectAdapter {
  readonly kind = "record-experiment" as const;
  private readonly now: () => Date;

  constructor(private readonly options: {
    database: WorkflowRunDatabase;
    products: WorkflowEffectProductFactory;
    candidates: WorkflowCandidateRuntime;
    metrics: WorkflowMetricSetRuntime;
    now?: () => Date;
  }) {
    this.now = options.now ?? (() => new Date());
  }

  semanticInput(context: Omit<WorkflowEffectAdapterContext, "semanticInput" | "operation">): JsonValue {
    const value = this.resolve(context.input);
    return canonicalJsonValue({
      formatVersion: 1,
      candidate: candidateAuthority(value.candidate),
      measurementId: value.measurement.measurementId,
      measurementBindingHash: value.measurement.bindingHash,
      dispositionAuthorityHash: value.candidate.disposition!.authorityHash,
      learned: value.learned,
    }, limits());
  }

  journalIdentity(context: WorkflowEffectAdapterContext & { operation: WorkflowOperationRecord }): WorkflowEffectIdentity {
    return {
      semanticKey: stableHash({
        formatVersion: 1,
        kind: "workflow-experiment",
        semanticInput: context.semanticInput,
        contextIdentityHash: context.run.contextIdentityHash,
      }),
      completionAuthority: "host-effect",
      replayPolicy: "immutable",
    };
  }

  async execute(context: WorkflowEffectAdapterContext & { operation: WorkflowOperationRecord }): Promise<JsonValue> {
    const value = this.resolve(context.input);
    const experimentId = `experiment_${stableHash({
      runId: context.run.runId,
      operationId: context.operation.operationId,
      candidateId: value.candidate.candidateId,
    }).slice(7, 39)}`;
    const bindingHash = stableHash({
      formatVersion: 1,
      candidateId: value.candidate.candidateId,
      measurementId: value.measurement.measurementId,
      disposition: value.disposition,
      dispositionAuthorityHash: value.candidate.disposition!.authorityHash,
      learned: value.learned,
    });
    const summary = { experimentId, disposition: value.disposition, learned: value.learned };
    const artifact = await this.options.products.experimentArtifact(summary);
    return {
      formatVersion: 1,
      ...summary,
      candidateId: value.candidate.candidateId,
      measurementId: value.measurement.measurementId,
      bindingHash,
      artifactDigest: this.options.products.artifactRecord(artifact).digest,
    } as unknown as JsonValue;
  }

  evidence(context: WorkflowEffectAdapterContext & { result: JsonValue }) {
    const result = parseExperiment(context.result);
    const artifact = this.options.database.readArtifact(result.artifactDigest);
    if (!artifact) throw new Error(`Workflow v17 experiment artifact ${result.artifactDigest} is unavailable`);
    return { artifacts: [{ role: "output" as const, ordinal: 0, artifact }] };
  }

  async restore(context: WorkflowEffectRestoreContext): Promise<JsonObject> {
    const result = parseExperiment(context.result);
    await revisionRetry(async () => this.options.database.registerExperiment(
      this.options.database.readRun().revision,
      {
        experimentId: result.experimentId,
        operationId: context.operation.operationId,
        candidateId: result.candidateId,
        measurementId: result.measurementId,
        disposition: result.disposition,
        learned: result.learned,
        bindingHash: result.bindingHash,
        artifactDigest: result.artifactDigest,
        createdAt: context.operation.endedAt ?? context.operation.updatedAt,
      },
    ));
    return { experimentId: result.experimentId, disposition: result.disposition, learned: result.learned };
  }

  private resolve(value: unknown) {
    const input = plainRecord(value, "workflow v17 experiment input") as unknown as ExperimentInput;
    exactKeys(input as unknown as object, ["candidate", "measurement", "learned"], "workflow v17 experiment input");
    const candidate = this.options.candidates.candidate(input.candidate);
    if (!candidate.disposition || !["accepted", "rejected"].includes(candidate.disposition.disposition)) {
      throw new Error(`Candidate ${candidate.candidateId} has no optimization disposition`);
    }
    const measurement = this.options.metrics.measurement(input.measurement);
    if (measurement.candidateId !== candidate.candidateId
      || candidate.disposition.measurementId !== measurement.measurementId) {
      throw new TypeError("Workflow v17 experiment measurement differs from candidate disposition");
    }
    const learned = boundedText(input.learned, "experiment lesson", 8_000);
    return {
      candidate,
      measurement,
      disposition: candidate.disposition.disposition as "accepted" | "rejected",
      learned,
    };
  }
}

function resolveProfile(
  invocation: WorkflowInvocationSnapshot,
  resources: WorkflowStaticEffectResources,
  operationSite: string,
  selector: string,
  metrics: WorkflowNormalizedMetricSet,
): { profile: MeasurementProfileSnapshot; hash: string } {
  const dynamicAtSite = invocation.resources.flatMap(resource => resource.uses.map(use => ({ resource, use })))
    .filter(value => value.use.operationSite === operationSite);
  const dynamic = dynamicAtSite.find(value => value.resource.identity.selector === selector);
  if (dynamic) {
    assertDynamicUse(dynamic.resource, dynamic.use, metrics);
    return { profile: structuredClone(dynamic.resource.profile), hash: dynamic.resource.bindingHash };
  }
  if (dynamicAtSite.length) {
    throw new Error(
      `Workflow v17 measurement site ${operationSite} cannot switch from pinned profile `
      + dynamicAtSite.map(value => value.resource.identity.selector).sort().join(", "),
    );
  }
  const pinned = resources.measurements[selector];
  if (!pinned) throw new Error(`Workflow v17 measurement profile ${selector} is not pinned`);
  return { profile: structuredClone(pinned.profile), hash: pinned.hash };
}

function assertDynamicUse(
  resource: WorkflowMeasurementResourceBinding,
  use: WorkflowMeasurementResourceBinding["uses"][number],
  metrics: WorkflowNormalizedMetricSet,
): void {
  const expected = new Map(use.outputs.map(value => [value.output, value.role]));
  const actual = new Map(metrics.definitions.map(value => [
    value.output,
    value.definition.primary ? "primary" : value.definition.guardrail ? "guardrail" : "observe",
  ]));
  if (stableJson(use.policy) !== stableJson(metrics.policy)
    || stableJson(use.sampling ?? { warmups: 0, samples: 1 }) !== stableJson(metrics.sampling)
    || stableJson(Object.fromEntries([...expected].sort())) !== stableJson(Object.fromEntries([...actual].sort()))) {
    throw new Error(`Workflow v17 invocation-selected profile ${resource.identity.selector} metric policy changed after launch`);
  }
}

function buildDelta(
  measurementId: string,
  operationPath: string,
  resolved: ResolvedMeasurement,
  values: ReadonlyMap<string, number[]>,
): MetricCohortDelta {
  const baseline = resolved.metricSet.states.length === 0;
  if (baseline && resolved.candidate) throw new Error("Workflow v17 candidate measurement requires a baseline");
  const delta: MetricCohortDelta = {
    formatVersion: 1,
    kind: "measurement-cohort",
    measurementId,
    operationPath,
    profileId: resolved.profile.id,
    profileHash: resolved.profile.hash,
    environmentHash: resolved.environment!.hash,
    ...(resolved.candidate ? {
      candidate: {
        candidateId: resolved.candidate.candidateId,
        treeHash: resolved.candidate.treeHash,
        lineageHash: resolved.candidate.lineageHash,
      },
    } : {}),
    definitions: resolved.normalized.definitions.map(value => ({
      metricId: value.output,
      definition: value.definition,
      definitionHash: value.definitionHash,
    })),
    observations: resolved.normalized.definitions.map(value => {
      const samples = values.get(value.output)!;
      return {
        observationId: `observation_${stableHash({
          measurementId,
          metricId: value.output,
          outputId: value.output,
        }).slice(7, 39)}`,
        metricId: value.output,
        outputId: value.output,
        value: aggregateMetricSamples(samples, value.definition.sampling.aggregate),
        samples,
        status: resolved.candidate ? "pending" as const : baseline ? "baseline" as const : "observational" as const,
      };
    }),
  };
  return normalizeMetricCohortDelta(delta);
}

function publicObservations(delta: MetricCohortDelta): JsonObject {
  return canonicalJsonObject(Object.fromEntries(delta.observations.map(({ status: _status, ...value }) => [
    value.outputId,
    value,
  ])), limits());
}

function storedMeasurement(
  record: WorkflowMeasurementRecord,
  authorityId?: string,
  metricSet?: Pick<ReturnType<WorkflowMetricSetRuntime["metricSet"]>, "policyHash" | "samplingHash">,
): StoredMeasurementResult {
  return {
    formatVersion: 1,
    authorityId: authorityId ?? `measurement-${record.measurementId.slice(-32)}`,
    measurementId: record.measurementId,
    policyHash: metricSet?.policyHash ?? "",
    samplingHash: metricSet?.samplingHash ?? "",
    profile: structuredClone(record.profile),
    commandHash: record.commandHash,
    environment: structuredClone(record.environment),
    environmentHash: record.environmentHash,
    workspaceTreeHash: record.workspaceTreeHash,
    ...(record.candidateId ? { candidateId: record.candidateId } : {}),
    bindingHash: record.bindingHash,
    delta: structuredClone(record.delta),
    observations: structuredClone(record.observations),
    artifactDigest: record.artifactDigest,
    ...(record.diagnosticsArtifactDigest ? { diagnosticsArtifactDigest: record.diagnosticsArtifactDigest } : {}),
    samples: structuredClone(record.samples),
  };
}

function parseStoredMeasurement(value: unknown): StoredMeasurementResult {
  const result = plainRecord(value, "workflow v17 stored measurement") as unknown as StoredMeasurementResult;
  if (result.formatVersion !== 1 || typeof result.authorityId !== "string"
    || typeof result.measurementId !== "string" || typeof result.bindingHash !== "string"
    || !result.profile || !Array.isArray(result.samples)) {
    throw new Error("Workflow v17 stored measurement is invalid");
  }
  return structuredClone(result);
}

function parseExperiment(value: unknown): StoredExperiment {
  const result = plainRecord(value, "workflow v17 stored experiment") as unknown as StoredExperiment;
  if (result.formatVersion !== 1 || typeof result.experimentId !== "string"
    || typeof result.candidateId !== "string" || typeof result.measurementId !== "string"
    || !["accepted", "rejected"].includes(result.disposition) || typeof result.learned !== "string"
    || typeof result.bindingHash !== "string" || typeof result.artifactDigest !== "string") {
    throw new Error("Workflow v17 stored experiment is invalid");
  }
  return structuredClone(result);
}

function measurementCommandProfile(
  profile: MeasurementProfileSnapshot,
  command: { argv: string[]; env: Record<string, string>; timeoutMs: number },
): CommandProfileSnapshot {
  const definition = normalizeCommandProfile({
    name: profile.name,
    ...(profile.title ? { title: profile.title } : {}),
    description: profile.description,
    argv: command.argv,
    env: command.env,
    timeoutMs: command.timeoutMs,
    outputLimitBytes: DEFINITION_LIMITS.measurementStreamBytes,
    effects: ["read-only"],
  }, profile.path);
  return {
    ...definition,
    id: profile.id,
    namespace: profile.namespace,
    path: profile.path,
    hash: stableHash({ namespace: profile.namespace, definition }),
  };
}

function assertMeasurementCommandResult(
  result: HostCommandResult,
  profile: CommandProfileSnapshot,
  executor: ReturnType<HostCommandExecutor["describe"]>,
): void {
  if (result.status !== "completed" || result.exitCode !== 0 || result.timedOut) {
    throw new Error(result.message ?? `Measurement command ${result.status}`);
  }
  if (stableJson(result.executor) !== stableJson(executor)
    || result.invocation.profileHash !== profile.hash
    || stableJson(result.invocation.argv) !== stableJson(profile.argv)
    || stableJson(result.invocation.env) !== stableJson(profile.env ?? {})) {
    throw new Error("Workflow v17 measurement executor ran a different command binding");
  }
}

function assertComparableBaseline(
  states: readonly import("./metrics.js").PersistedMetricState[],
  profileHash: string,
  environmentHash: string,
): void {
  for (const state of states) {
    if (state.baseline === null) continue;
    if (state.baselineProfileHash !== profileHash) {
      throw new Error(`Metric ${state.metricId} measurement profile differs from its baseline`);
    }
    if (state.baselineEnvironmentHash !== environmentHash) {
      throw new Error(`Metric ${state.metricId} measurement environment differs from its baseline`);
    }
  }
}

function candidateAuthority(candidate: WorkflowCandidateRecord): JsonObject {
  return {
    candidateId: candidate.candidateId,
    treeHash: candidate.treeHash,
    lineageHash: candidate.lineageHash,
    writeScopeHash: candidate.writeScopeHash,
    outputHash: candidate.outputHash,
    changedPathsHash: stableHash(candidate.changedPaths),
  };
}

async function admitAttempt(
  database: WorkflowRunDatabase,
  operation: WorkflowOperationRecord,
  now: () => Date,
): Promise<WorkflowAttemptRecord> {
  const attemptId = `attempt_${stableHash({
    runId: operation.runId,
    operationId: operation.operationId,
    effect: "measurement",
  }).slice(7, 39)}`;
  const existing = database.readAttempt(attemptId);
  if (existing) return existing;
  return await revisionRetry(async () => database.insertAttempt(database.readRun().revision, {
    attemptId,
    runId: operation.runId,
    operationId: operation.operationId,
    number: 1,
    effect: "measurement",
    executionId: `execution_${stableHash({ attemptId }).slice(7, 39)}`,
    status: "running",
    usage: zeroUsage() as unknown as JsonObject,
    createdAt: timestamp(now),
    updatedAt: timestamp(now),
  }));
}

async function finishAttempt(
  database: WorkflowRunDatabase,
  attempt: WorkflowAttemptRecord,
  status: "completed" | "failed",
  now: () => Date,
): Promise<WorkflowAttemptRecord> {
  const current = database.readAttempt(attempt.attemptId);
  if (!current) throw new Error(`Workflow v17 measurement attempt ${attempt.attemptId} disappeared`);
  if (current.status === status) return current;
  if (current.status !== "running" && current.status !== "waiting") {
    throw new Error(`Workflow v17 measurement attempt ${attempt.attemptId} is ${current.status}`);
  }
  return await revisionRetry(async () => database.completeAttempt({
    expectedRevision: database.readRun().revision,
    attemptId: attempt.attemptId,
    status,
    usage: zeroUsage() as unknown as JsonObject,
    at: timestamp(now),
  }));
}

async function revisionRetry<T>(body: () => T | Promise<T>): Promise<T> {
  for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
    try { return await body(); }
    catch (error) {
      if (error instanceof WorkflowRunDatabaseRevisionConflictError) continue;
      throw error;
    }
  }
  throw new Error("Workflow v17 measurement database revision did not settle");
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Workflow v17 ${label} is invalid`);
  }
  return value;
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Workflow v17 measurement clock is invalid");
  return value.toISOString();
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: object, allowed: readonly string[], label: string, optional = false): void {
  const extras = Object.keys(value).filter(key => !allowed.includes(key));
  if (extras.length) throw new TypeError(`${label} contains unknown fields: ${extras.sort().join(", ")}`);
  if (!optional && Object.keys(value).length !== allowed.length) {
    const missing = allowed.filter(key => !Object.hasOwn(value, key));
    if (missing.length) throw new TypeError(`${label} is missing ${missing.join(", ")}`);
  }
}

function assertContained(root: string, target: string, allowEqual = false): void {
  const relative = path.relative(root, target);
  if ((!allowEqual && relative === "") || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Workflow v17 measurement workspace escapes its root");
  }
}

function limits() {
  return {
    maxBytes: DEFINITION_LIMITS.structuralValueBytes,
    maxDepth: DEFINITION_LIMITS.structuralValueDepth,
    maxNodes: DEFINITION_LIMITS.structuralValueNodes,
    maxStringScalars: DEFINITION_LIMITS.structuralStringScalars,
  };
}
