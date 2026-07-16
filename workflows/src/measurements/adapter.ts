import path from "node:path";
import { ArtifactStore, createOpaqueArtifactRef } from "../artifacts/store.js";
import { describeOpaqueCandidateRef } from "../candidates/refs.js";
import { scanCandidateTree } from "../candidates/tree.js";
import type { HostCommandExecutor, HostCommandResult } from "../commands/executor.js";
import { normalizeCommandProfile, type CommandProfileSnapshot } from "../commands/profiles.js";
import { canonicalJsonObject } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import { RunDatabaseReader } from "../persistence/run-database.js";
import { zeroUsage, type AttemptRecord, type ArtifactRef, type WorkspaceRef } from "../runtime/durable-types.js";
import type {
  SemanticEffectAdapter,
  SemanticEffectAdmissionRequest,
  SemanticEffectJournalIdentity,
  SemanticEffectOutcome,
  SemanticEffectRequest,
  SemanticEffectRestoreRequest,
  SemanticReplayMaterialization,
  SemanticReplaySource,
} from "../runtime/semantic-engine-types.js";
import type { JsonObject, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { extractMeasurementInvocation } from "./extractors.js";
import {
  assertMeasurementIdentity,
  aggregateMetricSamples,
  applyMetricCohortDeltaToHandles,
  buildMetricCohortDelta,
  evaluateMeasurementPolicy,
  metricHandleIdentity,
  metricHandleState,
} from "./metrics.js";
import type { MeasurementEnvironmentProvider } from "./environment.js";
import { normalizeMeasurementEnvironmentFingerprint } from "./environment.js";
import type { HostPressureProvider } from "./pressure.js";
import { ProcHostPressureProvider } from "./pressure.js";
import type { MeasurementProfileSnapshot } from "./profiles.js";
import { resolveMeasurementProfile } from "./profiles.js";
import {
  aggregateMeasurementResources,
  measurementBindingHash,
  type MeasurementCommandBinding,
  type MeasurementRecord,
  type MeasurementSampleRecord,
  type MeasurementSamplingBinding,
  type MeasurementWorkflowResult,
} from "./records.js";

interface MeasurementLaunchWorkspace {
  root: string;
  cwd: string;
  workspace: WorkspaceRef & { kind: "snapshot" };
}

export interface SemanticMeasurementAdapterOptions {
  runDir: string;
  database: import("../persistence/run-database.js").RunDatabase;
  profiles: readonly MeasurementProfileSnapshot[];
  environment: MeasurementEnvironmentProvider;
  executor: HostCommandExecutor;
  launchWorkspace: MeasurementLaunchWorkspace;
  pressure?: HostPressureProvider;
  now?: () => Date;
}

interface MetricMapping {
  outputId: string;
  handle: unknown;
  metricId: string;
  definitionHash: string;
}

interface ResolvedMeasurement {
  profile: MeasurementProfileSnapshot;
  command: MeasurementCommandBinding;
  commandProfile: CommandProfileSnapshot;
  commandHash: string;
  workspace: WorkspaceRef;
  workspaceRoot: string;
  cwd: string;
  candidateId?: string;
  mappings: MetricMapping[];
  sampling: MeasurementSamplingBinding;
  samplingHash: string;
  environment: JsonObject;
  environmentHash: string;
  bindingHash: string;
  measurementId: string;
  semanticInput: JsonValue;
  single: boolean;
}

/** SQLite-backed flow.measure provider. Every comparison key is content/semantic policy, never ambient load. */
export class SemanticMeasurementAdapter implements SemanticEffectAdapter {
  readonly kind = "measure" as const;
  private readonly store: ArtifactStore;
  private readonly pressure: HostPressureProvider;
  private readonly now: () => Date;
  private readonly admissions = new Map<string, Promise<ResolvedMeasurement>>();

  constructor(private readonly options: SemanticMeasurementAdapterOptions) {
    this.now = options.now ?? (() => new Date());
    this.pressure = options.pressure ?? new ProcHostPressureProvider();
    this.store = new ArtifactStore(options.runDir, options.database, {
      maximumArtifactBytes: options.database.readRun().safety.outputBytes,
      now: this.now,
    });
    if (path.resolve(options.database.databasePath) !== path.join(path.resolve(options.runDir), "run.sqlite")) {
      throw new Error("Measurement adapter and run database directories differ");
    }
    assertContained(path.resolve(options.runDir), path.resolve(options.launchWorkspace.root));
    assertContained(path.resolve(options.launchWorkspace.root), path.resolve(options.launchWorkspace.cwd), true);
  }

  async semanticInput(request: SemanticEffectAdmissionRequest): Promise<JsonValue> {
    return (await this.resolve(request)).semanticInput;
  }

  async journalIdentity(request: SemanticEffectAdmissionRequest): Promise<SemanticEffectJournalIdentity> {
    const resolved = await this.resolve(request);
    return {
      semanticKey: stableHash({
        formatVersion: 1,
        kind: "measurement",
        bindingHash: resolved.bindingHash,
        contextIdentityHash: request.run.contextIdentityHash,
      }),
      completionAuthority: "host-effect",
      replayPolicy: "immutable",
    };
  }

  async execute(request: SemanticEffectRequest): Promise<SemanticEffectOutcome> {
    const resolved = await this.resolve(request);
    await this.assertWorkspaceTree(resolved);
    const attempt = this.admitAttempt(request, resolved);
    const startedAt = this.timestamp();
    const samples: MeasurementSampleRecord[] = [];
    const values = new Map<string, number[]>();
    const diagnostics: MeasurementRecord["diagnostics"] = [];
    for (const mapping of resolved.mappings) values.set(mapping.outputId, []);

    const invocationCount = resolved.sampling.warmups + resolved.sampling.samples;
    for (let ordinal = 0; ordinal < invocationCount; ordinal++) {
      if (request.signal.aborted) throw request.signal.reason;
      const kind = ordinal < resolved.sampling.warmups ? "warmup" as const : "sample" as const;
      const sampleIndex = kind === "warmup" ? ordinal : ordinal - resolved.sampling.warmups;
      const executionId = `command_${stableHash({
        runId: request.run.runId, operationId: request.operation.operationId, ordinal,
      }).slice(7, 39)}`;
      const result = await this.options.executor.execute({
        runId: request.run.runId,
        operationPath: request.path,
        attempt: 1,
        executionId,
        runDir: path.resolve(this.options.runDir),
        workspaceRoot: resolved.workspaceRoot,
        cwd: resolved.cwd,
        profile: resolved.commandProfile,
        arguments: {},
        effect: "read-only",
        safety: request.run.safety,
        maximumOutputBytes: Math.min(request.run.safety.outputBytes, DEFINITION_LIMITS.measurementStreamBytes),
        inlineLimitBytes: DEFINITION_LIMITS.measurementStreamBytes,
        unitKind: "measurement",
        ...(resolved.profile.cpuAffinity
          ? { physicalCoreAffinity: resolved.profile.cpuAffinity.physicalCores }
          : {}),
      }, request.signal);
      this.assertCommandResult(resolved, result);
      const extracted = extractMeasurementInvocation(
        resolved.profile,
        resolved.mappings.map((mapping) => mapping.outputId),
        result.stdout,
      );
      const pressure = this.capturePressure();
      const stdout = await this.putStream(result.stdout);
      const stderr = await this.putStream(result.stderr);
      const hostPressure = await pressure;
      samples.push({
        ordinal, kind, sampleIndex, executionId,
        status: result.status,
        exitCode: result.exitCode,
        ...(result.signal ? { signal: result.signal } : {}),
        timedOut: result.timedOut,
        stdout: stdout.artifact,
        stderr: stderr.artifact,
        ...(result.resources ? { cgroup: diagnosticJson(result.resources) } : {}),
        hostPressure,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
      });
      if (kind === "sample") {
        for (const mapping of resolved.mappings) values.get(mapping.outputId)!.push(extracted.values[mapping.outputId]!);
        if (extracted.diagnostic) diagnostics.push({ sample: sampleIndex, data: extracted.diagnostic });
      }
    }
    await this.assertWorkspaceTree(resolved);

    const delta = buildMetricCohortDelta({
      measurementId: resolved.measurementId,
      operationPath: request.path,
      profileId: resolved.profile.id,
      profileHash: resolved.profile.hash,
      environmentHash: resolved.environmentHash,
      ...(resolved.candidateId ? {
        candidate: {
          candidateId: resolved.candidateId,
          treeHash: resolved.workspace.treeHash,
          lineageHash: resolved.workspace.lineageHash!,
        },
      } : {}),
      mappings: resolved.mappings.map((mapping) => {
        const state = metricHandleState(mapping.handle);
        const metricSamples = values.get(mapping.outputId)!;
        return {
          outputId: mapping.outputId,
          handle: mapping.handle,
          samples: metricSamples,
          value: aggregateMetricSamples(metricSamples, state.definition.sampling.aggregate),
        };
      }),
    });
    const diagnosticsArtifact = diagnostics.length
      ? (await this.store.putJson({
          expectedRevision: this.options.database.readRun().revision,
          kind: "measurement-diagnostics",
          value: diagnostics as unknown as JsonValue,
          metadata: {},
        })).artifact
      : undefined;
    const cohortBody = {
      formatVersion: 1,
      measurementId: resolved.measurementId,
      operationPath: request.path,
      bindingHash: resolved.bindingHash,
      profileId: resolved.profile.id,
      profileHash: resolved.profile.hash,
      command: resolved.command,
      workspace: resolved.workspace,
      ...(resolved.candidateId ? { candidateId: resolved.candidateId } : {}),
      sampling: resolved.sampling,
      ...(resolved.profile.cpuAffinity ? { cpuAffinity: resolved.profile.cpuAffinity } : {}),
      environment: resolved.environment,
      environmentHash: resolved.environmentHash,
      samples,
      diagnostics,
      delta,
      startedAt,
      endedAt: this.timestamp(),
    };
    const cohortArtifact = (await this.store.putJson({
      expectedRevision: this.options.database.readRun().revision,
      kind: "measurement-cohort",
      value: cohortBody as unknown as JsonValue,
      metadata: {},
      maximumBytes: DEFINITION_LIMITS.measurementCohortBytes,
    })).artifact;
    const endedAt = this.timestamp();
    const record: MeasurementRecord = {
      measurementId: resolved.measurementId,
      runId: request.run.runId,
      operationId: request.operation.operationId,
      attemptId: attempt.attemptId,
      profileId: resolved.profile.id,
      profileHash: resolved.profile.hash,
      command: resolved.command,
      commandHash: resolved.commandHash,
      workspace: resolved.workspace,
      ...(resolved.candidateId ? { candidateId: resolved.candidateId } : {}),
      sampling: resolved.sampling,
      samplingHash: resolved.samplingHash,
      ...(resolved.profile.cpuAffinity ? { cpuAffinity: resolved.profile.cpuAffinity } : {}),
      environment: resolved.environment,
      environmentHash: resolved.environmentHash,
      bindingHash: resolved.bindingHash,
      cohortArtifact,
      ...(diagnosticsArtifact ? { diagnosticsArtifact } : {}),
      diagnostics,
      samples,
      delta,
      startedAt,
      endedAt,
    };
    const artifacts = uniqueArtifacts([
      cohortArtifact,
      ...(diagnosticsArtifact ? [diagnosticsArtifact] : []),
      ...samples.flatMap((sample) => [sample.stdout, sample.stderr]),
    ]);
    return {
      result: { value: { measurementId: resolved.measurementId }, artifacts },
      attemptId: attempt.attemptId,
      resources: aggregateMeasurementResources(samples),
      measurement: record,
      completionAuthority: "host-effect",
    };
  }

  async restore(request: SemanticEffectRestoreRequest): Promise<unknown> {
    const resolved = await this.resolve(request);
    const record = request.database.readMeasurementByOperation(request.operation.operationId);
    if (!record) throw new Error(`Completed measurement ${request.path} has no SQLite cohort`);
    if (record.bindingHash !== resolved.bindingHash) throw new Error(`Measurement ${request.path} binding changed`);
    const handles = new Map(resolved.mappings.map((mapping) => [mapping.metricId, mapping.handle]));
    applyMetricCohortDeltaToHandles(handles, record.delta);
    return measurementWorkflowValue(record, resolved.single);
  }

  async materializeImmutableReplay(
    request: SemanticEffectRequest,
    source: SemanticReplaySource,
  ): Promise<SemanticReplayMaterialization> {
    const resolved = await this.resolve(request);
    const reader = RunDatabaseReader.open(path.join(source.runDir, "run.sqlite"));
    try {
      const prior = reader.readMeasurementByOperation(source.operation.operationId);
      if (!prior || prior.bindingHash !== resolved.bindingHash) {
        throw new Error("Replay measurement does not have the exact candidate/profile/sampling binding");
      }
      const delta = {
        ...prior.delta,
        operationPath: request.path,
        ...(resolved.candidateId ? {
          candidate: {
            candidateId: resolved.candidateId,
            treeHash: resolved.workspace.treeHash,
            lineageHash: resolved.workspace.lineageHash!,
          },
        } : { candidate: undefined }),
      } as typeof prior.delta;
      if (!resolved.candidateId) delete (delta as { candidate?: unknown }).candidate;
      const measurement: MeasurementRecord = {
        ...prior,
        runId: request.run.runId,
        operationId: request.operation.operationId,
        attemptId: undefined,
        workspace: resolved.workspace,
        ...(resolved.candidateId ? { candidateId: resolved.candidateId } : {}),
        delta,
      };
      if (!resolved.candidateId) delete (measurement as { candidateId?: unknown }).candidateId;
      return { result: source.call.result, measurement };
    } finally {
      reader.close();
    }
  }

  private async resolve(request: SemanticEffectAdmissionRequest): Promise<ResolvedMeasurement> {
    let pending = this.admissions.get(request.path);
    if (!pending) {
      pending = this.resolveFresh(request);
      this.admissions.set(request.path, pending);
    }
    return await pending;
  }

  private async resolveFresh(request: SemanticEffectAdmissionRequest): Promise<ResolvedMeasurement> {
    const input = plainRecord(request.input, "flow.measure options");
    exactKeys(input, new Set(["title", "metric", "metrics", "measurement", "output", "workspace"]), "flow.measure options");
    if (typeof input.measurement !== "string") throw new TypeError("flow.measure measurement must be a profile selector");
    const profile = resolveMeasurementProfile(this.options.profiles, input.measurement);
    const { mappings, single } = normalizeMappings(input, profile);
    evaluateMeasurementPolicy(mappings.map((mapping) => mapping.handle), {});
    const samplingCounts = new Set(mappings.map((mapping) => {
      const sampling = metricHandleState(mapping.handle).definition.sampling;
      return `${sampling.warmups}:${sampling.samples}`;
    }));
    if (samplingCounts.size !== 1) throw new TypeError("Grouped metrics must share warmup and sample counts");
    const firstSampling = metricHandleState(mappings[0]!.handle).definition.sampling;
    const sampling: MeasurementSamplingBinding = {
      warmups: firstSampling.warmups,
      samples: firstSampling.samples,
      mappings: mappings.map(({ outputId, metricId, definitionHash }) => ({ outputId, metricId, definitionHash }))
        .sort((left, right) => left.metricId.localeCompare(right.metricId)),
    };
    const command: MeasurementCommandBinding = {
      argv: [...profile.argv],
      env: Object.fromEntries(Object.entries(profile.env ?? {}).sort(([left], [right]) => left.localeCompare(right))),
      timeoutMs: profile.timeoutMs,
    };
    const commandHash = stableHash(command);
    const commandProfile = measurementCommandProfile(profile, command);
    const workspace = this.resolveWorkspace(request, input.workspace);
    const fingerprint = normalizeMeasurementEnvironmentFingerprint(await this.options.environment.capture({
      profile,
      workspaceTreeHash: workspace.workspace.treeHash,
      commandHash,
    }));
    assertMeasurementIdentity(mappings.map((mapping) => mapping.handle), profile.id, profile.hash, fingerprint.hash);
    const samplingHash = stableHash(sampling);
    const bindingHash = measurementBindingHash({
      profileHash: profile.hash,
      commandHash,
      workspace: workspace.workspace,
      samplingHash,
      ...(profile.cpuAffinity ? { cpuAffinity: profile.cpuAffinity } : {}),
      environmentHash: fingerprint.hash,
    });
    const measurementId = `measurement_${stableHash({
      formatVersion: 1, runId: request.run.runId, path: request.path,
    }).slice(7, 39)}`;
    return {
      profile,
      command,
      commandProfile,
      commandHash,
      ...workspace,
      mappings,
      sampling,
      samplingHash,
      environment: fingerprint.data,
      environmentHash: fingerprint.hash,
      bindingHash,
      measurementId,
      semanticInput: {
        profileId: profile.id,
        profileHash: profile.hash,
        commandHash,
        workspace: workspace.workspace,
        ...(workspace.candidateId ? { candidateId: workspace.candidateId } : {}),
        sampling,
        ...(profile.cpuAffinity ? { cpuAffinity: profile.cpuAffinity } : {}),
        environmentHash: fingerprint.hash,
        bindingHash,
      } as unknown as JsonValue,
      single,
    };
  }

  private resolveWorkspace(request: SemanticEffectAdmissionRequest, value: unknown): {
    workspace: WorkspaceRef;
    workspaceRoot: string;
    cwd: string;
    candidateId?: string;
  } {
    if (value === undefined) return {
      workspace: { ...this.options.launchWorkspace.workspace },
      workspaceRoot: path.resolve(this.options.launchWorkspace.root),
      cwd: path.resolve(this.options.launchWorkspace.cwd),
    };
    const ref = describeOpaqueCandidateRef(value);
    if (!ref || ref.runId !== request.run.runId) throw new TypeError("flow.measure workspace is not a candidate from this run");
    const candidate = this.options.database.readCandidate(ref.candidateId);
    if (!candidate || candidate.workspace.treeHash !== ref.treeHash || candidate.workspace.lineageHash !== ref.lineageHash) {
      throw new TypeError("flow.measure candidate reference is stale");
    }
    const mutable = this.options.database.readCandidateWorkspace(candidate.workspace.workspaceId);
    if (!mutable) throw new Error(`Candidate ${candidate.candidateId} has no workspace`);
    const workspaceRoot = path.join(path.resolve(this.options.runDir), mutable.rootPath);
    const relativeCwd = path.relative(this.options.launchWorkspace.root, this.options.launchWorkspace.cwd);
    const cwd = path.resolve(workspaceRoot, relativeCwd);
    assertContained(workspaceRoot, cwd, true);
    return { workspace: { ...candidate.workspace }, workspaceRoot, cwd, candidateId: candidate.candidateId };
  }

  private admitAttempt(request: SemanticEffectRequest, resolved: ResolvedMeasurement): AttemptRecord {
    const attemptId = `attempt_${stableHash({
      formatVersion: 1, runId: request.run.runId, operationId: request.operation.operationId, effect: "measurement",
    }).slice(7, 39)}`;
    const existing = request.database.readAttempt(attemptId);
    if (existing) {
      if (existing.operationId !== request.operation.operationId || existing.effect !== "measurement") {
        throw new Error(`Measurement attempt collision ${attemptId}`);
      }
      return existing;
    }
    const at = this.timestamp();
    return request.database.insertAttempt(request.database.readRun().revision, {
      attemptId,
      runId: request.run.runId,
      operationId: request.operation.operationId,
      number: 1,
      effect: "measurement",
      executionId: `measurement_${attemptId.slice("attempt_".length)}`,
      status: "running",
      preWorkspace: resolved.workspace,
      usage: zeroUsage(),
      outputArtifacts: [],
      startedAt: at,
      updatedAt: at,
    }, {
      type: "measurement-attempt-started",
      operationId: request.operation.operationId,
      attemptId,
      payload: { measurementId: resolved.measurementId, bindingHash: resolved.bindingHash },
      at,
    });
  }

  private assertCommandResult(resolved: ResolvedMeasurement, result: HostCommandResult): void {
    if (result.status !== "completed" || result.exitCode !== 0 || result.timedOut) {
      throw new Error(result.message ?? `Measurement command ${result.status} with exit ${result.exitCode ?? "signal"}`);
    }
    const invocation = result.invocation;
    if (
      stableHash({ argv: invocation.argv, env: invocation.env, timeoutMs: invocation.timeoutMs }) !== resolved.commandHash ||
      invocation.profileId !== resolved.profile.id
    ) throw new Error("Measurement executor ran a different command binding");
  }

  private async putStream(bytes: Buffer) {
    return await this.store.putBytes({
      expectedRevision: this.options.database.readRun().revision,
      kind: "measurement-stream",
      bytes,
      metadata: {},
      maximumBytes: DEFINITION_LIMITS.measurementStreamBytes,
    });
  }

  private async capturePressure(): Promise<JsonObject> {
    try { return diagnosticJson(await this.pressure.capture()); }
    catch (error) {
      return { sampledAt: this.timestamp(), unavailable: boundedError(error) };
    }
  }

  private async assertWorkspaceTree(resolved: ResolvedMeasurement): Promise<void> {
    if (!resolved.candidateId) return;
    const actual = await scanCandidateTree(resolved.workspaceRoot);
    if (actual.treeHash !== resolved.workspace.treeHash) {
      throw new Error(`Candidate ${resolved.candidateId} changed before or during measurement`);
    }
  }

  private timestamp(): string { return this.now().toISOString(); }
}

function normalizeMappings(input: Record<string, unknown>, profile: MeasurementProfileSnapshot): {
  mappings: MetricMapping[];
  single: boolean;
} {
  if ((input.metric === undefined) === (input.metrics === undefined)) {
    throw new TypeError("flow.measure requires exactly one of metric or metrics");
  }
  if (input.metric !== undefined) {
    const outputs = Object.keys(profile.outputs).sort();
    const outputId = input.output === undefined
      ? (outputs.length === 1 ? outputs[0]! : undefined)
      : input.output;
    if (typeof outputId !== "string" || !profile.outputs[outputId]) {
      throw new TypeError("Single metric measurement requires one declared output");
    }
    const identity = metricHandleIdentity(input.metric);
    return { mappings: [{ outputId, handle: input.metric, ...identity }], single: true };
  }
  const metrics = plainRecord(input.metrics, "flow.measure metrics");
  const outputIds = Object.keys(metrics).sort();
  const expected = Object.keys(profile.outputs).sort();
  if (outputIds.length === 0 || outputIds.join("\0") !== expected.join("\0")) {
    throw new TypeError("Grouped measurement outputs must exactly match the profile outputs");
  }
  const seen = new Set<unknown>();
  const mappings = outputIds.map((outputId) => {
    const handle = metrics[outputId];
    if (seen.has(handle)) throw new TypeError("One metric handle cannot consume two measurement outputs");
    seen.add(handle);
    const identity = metricHandleIdentity(handle);
    return { outputId, handle, ...identity };
  }).sort((left, right) => left.metricId.localeCompare(right.metricId));
  return { mappings, single: false };
}

function measurementCommandProfile(
  profile: MeasurementProfileSnapshot,
  command: MeasurementCommandBinding,
): CommandProfileSnapshot {
  const definition = normalizeCommandProfile({
    name: profile.name,
    ...(profile.title ? { title: profile.title } : {}),
    description: profile.description,
    argv: command.argv,
    env: command.env,
    timeoutMs: command.timeoutMs,
    outputLimitBytes: DEFINITION_LIMITS.measurementStreamBytes,
    effects: ["read-only" as const],
  }, profile.path);
  const body = {
    ...definition,
    id: profile.id,
    namespace: profile.namespace,
    path: profile.path,
  };
  return { ...body, hash: stableHash({ namespace: profile.namespace, definition }) };
}

function measurementWorkflowValue(record: MeasurementRecord, single: boolean): MeasurementWorkflowResult {
  const base = {
    measurementId: record.measurementId,
    profile: record.profileId,
    profileHash: record.profileHash,
    environmentHash: record.environmentHash,
    diagnostics: structuredClone(record.diagnostics),
    ...(record.diagnosticsArtifact
      ? { diagnosticsArtifact: createOpaqueArtifactRef(record.diagnosticsArtifact) }
      : {}),
  };
  const observations = record.delta.observations.map(({ status: _status, ...observation }) => observation);
  if (single) return Object.freeze({ ...base, observation: structuredClone(observations[0]!) });
  return Object.freeze({
    ...base,
    observations: Object.fromEntries(observations.map((observation) => [
      observation.outputId, structuredClone(observation),
    ])),
  });
}

function uniqueArtifacts(values: readonly ArtifactRef[]): ArtifactRef[] {
  return [...new Map(values.map((artifact) => [artifact.digest, artifact])).values()];
}

function diagnosticJson(value: unknown): JsonObject {
  return canonicalJsonObject(value, {
    maxBytes: DEFINITION_LIMITS.measurementDiagnosticBytes,
    maxDepth: 24,
    maxNodes: 4_096,
    maxStringScalars: DEFINITION_LIMITS.structuralStringScalars,
  });
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length) throw new TypeError(`${label} contains unknown fields: ${extras.sort().join(", ")}`);
}

function assertContained(root: string, target: string, allowEqual = false): void {
  const relative = path.relative(root, target);
  if ((!allowEqual && !relative) || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Measurement workspace escapes its run or project root");
  }
}

function boundedError(error: unknown): string {
  return Array.from(error instanceof Error ? error.message : String(error)).slice(0, 1_000).join("");
}

