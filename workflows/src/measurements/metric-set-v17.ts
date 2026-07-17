import { canonicalJsonObject, deepFreezeJson } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS, FLOW_NAME_PATTERN } from "../definition/limits.js";
import type { ParsedWorkflowV17 } from "../definition/workflow-v17-types.js";
import { WorkflowV17EffectProductFactory } from "../artifacts/products-v17.js";
import {
  WorkflowRunDatabaseV17,
  WorkflowRunDatabaseV17RevisionConflictError,
} from "../persistence/run-database-v17.js";
import type {
  WorkflowCandidateMeasurementV17Record,
  WorkflowCandidateV17Record,
  WorkflowMeasurementV17Record,
  WorkflowMetricSetV17Record,
} from "../persistence/run-database-v17-types.js";
import type { JsonObject, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import {
  metricRole,
  normalizeMetricDefinition,
  type NormalizedMetricDefinition,
} from "./metric-definition.js";
import {
  applyMetricCohortDeltaToSnapshot,
  applyMetricDispositionToSnapshot,
  evaluateMeasurementPolicy,
  metricSummary,
  reachesTarget,
  type PersistedMetricState,
} from "./metrics.js";
import type { WorkflowV17MeasurementAuthorityResolver } from "../runtime/effect-adapters-v17.js";

const MAX_REVISION_RETRIES = 16;
const METRIC_KEYS = ["output", "title", "direction", "unit", "format", "aggregate"] as const;
const PRIMARY_KEYS = [...METRIC_KEYS, "target", "improvement"] as const;
const GUARDRAIL_KEYS = [
  ...METRIC_KEYS,
  "reference",
  "maximumAbsoluteRegression",
  "maximumRelativeRegression",
] as const;

export interface WorkflowV17NormalizedMetricSet {
  policy: JsonObject;
  policyHash: string;
  sampling: JsonObject & { warmups: number; samples: number };
  samplingHash: string;
  definitions: Array<{
    output: string;
    definition: NormalizedMetricDefinition;
    definitionHash: string;
  }>;
}

interface MetricSetPrivateAuthority {
  formatVersion: 1;
  runId: string;
  metricSetId: string;
  policyHash: string;
  samplingHash: string;
  authorityHash: string;
}

/** Run-local metric-set references and their synchronous control methods. */
export class WorkflowV17MetricSetRuntime implements WorkflowV17MeasurementAuthorityResolver {
  private readonly occurrences = new Map<string, number>();
  private readonly references = new Map<string, object>();
  private readonly executionStates = new Map<string, PersistedMetricState[]>();
  private readonly observedMeasurements = new Set<string>();
  private readonly observedDispositions = new Set<string>();
  private readonly now: () => Date;

  constructor(
    readonly database: WorkflowRunDatabaseV17,
    readonly products: WorkflowV17EffectProductFactory,
    readonly workflow: ParsedWorkflowV17,
    now: () => Date = () => new Date(),
  ) {
    if (products.store.database !== database || products.authority.scopeId.length < 1) {
      throw new Error("Workflow v17 metric runtime authority differs from its database");
    }
    this.now = now;
  }

  beginExecution(): void {
    this.occurrences.clear();
    this.executionStates.clear();
    this.observedMeasurements.clear();
    this.observedDispositions.clear();
  }

  create(sourceSite: string, policyValue: unknown, samplingValue?: unknown): object {
    const reviewed = this.workflow.operations.find(site => site.sourceSite === sourceSite);
    if (reviewed?.method !== "metrics") throw new TypeError(`Unknown workflow v17 metrics site ${sourceSite}`);
    const occurrence = this.occurrences.get(sourceSite) ?? 0;
    this.occurrences.set(sourceSite, occurrence + 1);
    const normalized = normalizeWorkflowV17MetricSet(policyValue, samplingValue);
    const run = this.database.readRun();
    const metricSetId = `metric_set_${stableHash({
      formatVersion: 1,
      runId: run.runId,
      sourceSite,
      occurrence,
    }).slice(7, 39)}`;
    const authorityId = `metric-set-${metricSetId.slice(-32)}`;
    let record: WorkflowMetricSetV17Record | undefined;
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      try {
        record = this.database.registerMetricSet(this.database.readRun().revision, {
          metricSetId,
          authorityId,
          sourceSite,
          occurrence,
          policy: normalized.policy,
          policyHash: normalized.policyHash,
          sampling: normalized.sampling,
          samplingHash: normalized.samplingHash,
          createdAt: this.database.readMetricSetBySite(sourceSite, occurrence)?.createdAt
            ?? this.timestamp(),
        });
        break;
      } catch (error) {
        if (error instanceof WorkflowRunDatabaseV17RevisionConflictError) continue;
        throw error;
      }
    }
    if (!record) throw new Error(`Could not register workflow v17 metric set ${sourceSite}`);
    this.executionStates.set(record.metricSetId, []);
    const existing = this.references.get(record.metricSetId);
    if (existing) return existing;
    const authorityHash = metricSetAuthorityHash(record);
    const privateAuthority: MetricSetPrivateAuthority = Object.freeze({
      formatVersion: 1,
      runId: record.runId,
      metricSetId: record.metricSetId,
      policyHash: record.policyHash,
      samplingHash: record.samplingHash,
      authorityHash,
    });
    const value = this.products.authority.reference({
      formatVersion: 1,
      kind: "metric-set",
      authorityId: record.authorityId,
      authorityHash,
    }, {}, privateAuthority);
    this.references.set(record.metricSetId, value);
    return value;
  }

  call(value: unknown, method: string, args: unknown[]): unknown {
    const metricSet = this.metricSet(value);
    if (!Array.isArray(args)) throw new TypeError("Workflow v17 metric-set method arguments are invalid");
    if (method === "policy") {
      noArguments(args, method);
      return structuredClone(metricSet.policy);
    }
    if (method === "summary") {
      noArguments(args, method);
      return metricSetSummary(metricSet.states);
    }
    if (method === "reachedTarget") {
      noArguments(args, method);
      const primary = requirePrimary(metricSet.states);
      return reachesTarget(primary).result;
    }
    if (method === "evaluate") {
      if (args.length !== 1) throw new TypeError("Workflow v17 metric-set evaluate requires one measurement");
      const measurement = this.measurement(args[0]);
      if (measurement.metricSetId !== metricSet.metricSetId) {
        throw new TypeError("Workflow v17 measurement belongs to another metric set");
      }
      const evaluated = evaluateMeasurementPolicy(metricSet.states, measurement.observations);
      const violations = [...evaluated.violations];
      return deepFreezeJson(canonicalJsonObject({
        acceptable: evaluated.eligible,
        summary: evaluated.eligible
          ? "primary improvement and guardrails passed"
          : `measurement policy failed: ${violations.join(", ")}`,
        violations,
      }, limits()));
    }
    throw new TypeError(`Unknown workflow v17 metric-set method ${method}`);
  }

  metricSet(value: unknown): WorkflowMetricSetV17Record {
    const description = this.products.authority.describe(value);
    const identity = description?.family === "reference" ? description.identity : undefined;
    const privateAuthority = description?.privateAuthority;
    if (!description || identity?.kind !== "metric-set" || !plainRecord(privateAuthority)
      || privateAuthority.formatVersion !== 1 || privateAuthority.runId !== this.database.readRun().runId
      || typeof privateAuthority.metricSetId !== "string") {
      throw new TypeError("Value has no workflow v17 metric-set authority");
    }
    const record = this.database.readMetricSet(privateAuthority.metricSetId);
    if (!record || record.authorityId !== identity.authorityId
      || record.policyHash !== privateAuthority.policyHash
      || record.samplingHash !== privateAuthority.samplingHash
      || metricSetAuthorityHash(record) !== identity.authorityHash
      || privateAuthority.authorityHash !== identity.authorityHash) {
      throw new TypeError("Workflow v17 metric-set authority is stale or corrupt");
    }
    return {
      ...record,
      states: structuredClone(this.executionStates.get(record.metricSetId) ?? []),
    };
  }

  observeMeasurement(record: WorkflowMeasurementV17Record): void {
    if (this.observedMeasurements.has(record.measurementId)) return;
    const states = this.executionStates.get(record.metricSetId);
    if (!states) throw new Error(`Workflow v17 metric set ${record.metricSetId} is not active in this execution`);
    this.executionStates.set(
      record.metricSetId,
      applyMetricCohortDeltaToSnapshot(states, record.delta),
    );
    this.observedMeasurements.add(record.measurementId);
  }

  observeDisposition(candidate: WorkflowCandidateV17Record, disposition: "accepted" | "rejected"): void {
    const binding = this.database.readCandidateMeasurement(candidate.candidateId);
    if (!binding) return;
    const key = `${candidate.candidateId}:${disposition}`;
    if (this.observedDispositions.has(key)) return;
    const measurement = this.database.readMeasurement(binding.measurementId);
    if (!measurement) throw new Error(`Workflow v17 candidate measurement ${binding.measurementId} is unavailable`);
    const states = this.executionStates.get(measurement.metricSetId);
    if (!states) throw new Error(`Workflow v17 metric set ${measurement.metricSetId} is not active in this execution`);
    this.executionStates.set(
      measurement.metricSetId,
      applyMetricDispositionToSnapshot(states, measurement.delta, disposition),
    );
    this.observedDispositions.add(key);
  }

  measurement(value: unknown): WorkflowMeasurementV17Record {
    const attached = this.products.attachableArtifact(value);
    const description = this.products.authority.describe(value);
    if (attached.productKind !== "measurement" || description?.family !== "product"
      || description.identity.kind !== "measurement") {
      throw new TypeError("Value has no workflow v17 measurement authority");
    }
    const measurementId = description.fields.measurementId;
    if (typeof measurementId !== "string") throw new TypeError("Workflow v17 measurement identity is unavailable");
    const record = this.database.readMeasurement(measurementId);
    if (!record || record.artifactDigest !== attached.artifact.digest
      || stableJson(record.observations) !== stableJson(description.fields.observations)) {
      throw new TypeError("Workflow v17 measurement authority differs from durable evidence");
    }
    return record;
  }

  resolve(value: unknown, candidate: WorkflowCandidateV17Record): WorkflowCandidateMeasurementV17Record {
    const measurement = this.measurement(value);
    if (measurement.candidateId !== candidate.candidateId) {
      throw new TypeError("Workflow v17 measurement belongs to another candidate");
    }
    const record = this.database.readCandidateMeasurement(candidate.candidateId);
    if (!record || record.measurementId !== measurement.measurementId
      || record.bindingHash !== measurement.bindingHash) {
      throw new TypeError("Workflow v17 candidate measurement is not registered");
    }
    return record;
  }

  normalized(record: WorkflowMetricSetV17Record): WorkflowV17NormalizedMetricSet {
    const normalized = normalizeWorkflowV17MetricSet(record.policy, record.sampling);
    if (normalized.policyHash !== record.policyHash || normalized.samplingHash !== record.samplingHash) {
      throw new Error(`Workflow v17 metric set ${record.metricSetId} is not canonical`);
    }
    return normalized;
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Workflow v17 metric clock is invalid");
    return value.toISOString();
  }
}

export function normalizeWorkflowV17MetricSet(
  policyValue: unknown,
  samplingValue?: unknown,
): WorkflowV17NormalizedMetricSet {
  const policy = canonicalJsonObject(policyValue, limits());
  exactKeys(policy, ["primary", "guardrails", "observe"], ["primary"], "metric policy");
  const sampling = normalizeSampling(samplingValue);
  const definitions: WorkflowV17NormalizedMetricSet["definitions"] = [];
  const primary = metricRecord(policy.primary, "metric policy primary");
  exactKeys(primary, PRIMARY_KEYS, ["output", "direction"], "metric policy primary");
  definitions.push(definition(primary, "primary", sampling));
  for (const [field, role] of [["guardrails", "guardrail"], ["observe", "observe"]] as const) {
    const values = policy[field];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.length > DEFINITION_LIMITS.measurementOutputs) {
      throw new TypeError(`Metric policy ${field} must be a bounded array`);
    }
    for (let index = 0; index < values.length; index++) {
      const value = metricRecord(values[index], `metric policy ${field}[${index}]`);
      exactKeys(
        value,
        role === "guardrail" ? GUARDRAIL_KEYS : METRIC_KEYS,
        role === "guardrail" ? ["output", "direction", "reference"] : ["output", "direction"],
        `metric policy ${field}[${index}]`,
      );
      definitions.push(definition(value, role, sampling));
    }
  }
  if (definitions.length > DEFINITION_LIMITS.measurementOutputs) {
    throw new TypeError(`Metric policy exceeds ${DEFINITION_LIMITS.measurementOutputs} outputs`);
  }
  const seen = new Set<string>();
  for (const entry of definitions) {
    if (seen.has(entry.output)) throw new TypeError(`Duplicate optimization output ${entry.output}`);
    seen.add(entry.output);
  }
  const canonicalPolicy = canonicalJsonObject(policy, limits());
  return deepFreezeJson({
    policy: canonicalPolicy,
    policyHash: stableHash(canonicalPolicy),
    sampling,
    samplingHash: stableHash(sampling),
    definitions,
  } as unknown as JsonValue) as unknown as WorkflowV17NormalizedMetricSet;
}

function definition(
  policy: Record<string, unknown>,
  role: "primary" | "guardrail" | "observe",
  sampling: { warmups: number; samples: number },
) {
  const output = policy.output;
  if (typeof output !== "string" || !FLOW_NAME_PATTERN.test(output)) {
    throw new TypeError(`Metric output ${String(output)} is invalid`);
  }
  const aggregate = policy.aggregate ?? "median";
  if (!["median", "mean", "min", "max"].includes(String(aggregate))) {
    throw new TypeError(`Metric ${output} aggregate is invalid`);
  }
  const raw: Record<string, unknown> = {
    ...(policy.title !== undefined ? { title: policy.title } : {}),
    direction: policy.direction,
    ...(policy.unit !== undefined ? { unit: policy.unit } : {}),
    primary: role === "primary",
    ...(policy.format !== undefined ? { format: policy.format } : {}),
    ...(policy.target !== undefined ? { target: policy.target } : {}),
    sampling: { ...sampling, aggregate },
    ...(policy.improvement !== undefined ? { improvement: policy.improvement } : {}),
    ...(role === "guardrail" ? {
      guardrail: {
        reference: policy.reference,
        ...(policy.maximumAbsoluteRegression !== undefined
          ? { maximumAbsoluteRegression: policy.maximumAbsoluteRegression } : {}),
        ...(policy.maximumRelativeRegression !== undefined
          ? { maximumRelativeRegression: policy.maximumRelativeRegression } : {}),
      },
    } : {}),
  };
  const normalized = normalizeMetricDefinition(raw, output);
  if ((role === "guardrail") !== (metricRole(normalized) === "guardrail")) {
    throw new TypeError(`Metric ${output} role is invalid`);
  }
  return { output, definition: normalized, definitionHash: stableHash(normalized) };
}

function normalizeSampling(value: unknown): JsonObject & { warmups: number; samples: number } {
  if (value === undefined) return Object.freeze({ warmups: 0, samples: 1 });
  const sampling = canonicalJsonObject(value, limits());
  exactKeys(sampling, ["warmups", "samples"], ["warmups", "samples"], "metric sampling");
  if (!Number.isSafeInteger(sampling.warmups) || (sampling.warmups as number) < 0
    || (sampling.warmups as number) > DEFINITION_LIMITS.measurementWarmups
    || !Number.isSafeInteger(sampling.samples) || (sampling.samples as number) < 1
    || (sampling.samples as number) > DEFINITION_LIMITS.measurementSamples
    || (sampling.warmups as number) + (sampling.samples as number) > DEFINITION_LIMITS.measurementInvocations) {
    throw new TypeError("Metric sampling is outside workflow limits");
  }
  return Object.freeze({ warmups: sampling.warmups as number, samples: sampling.samples as number });
}

function metricSetSummary(states: readonly PersistedMetricState[]): JsonObject {
  const result: JsonObject = {};
  for (const state of states) {
    const summary = metricSummary(state);
    if (summary.baseline === null || summary.current === null || summary.best === null) {
      throw new Error(`Metric ${state.metricId} has no complete summary`);
    }
    result[state.metricId] = summary as unknown as JsonValue;
  }
  return deepFreezeJson(canonicalJsonObject(result, limits()));
}

function requirePrimary(states: readonly PersistedMetricState[]): PersistedMetricState {
  const primary = states.filter(state => state.role === "primary");
  if (primary.length !== 1) throw new Error("Workflow v17 metric set has no unique primary state");
  return primary[0]!;
}

function metricSetAuthorityHash(record: Pick<
  WorkflowMetricSetV17Record,
  "runId" | "metricSetId" | "authorityId" | "policyHash" | "samplingHash"
>): string {
  return stableHash({
    formatVersion: 1,
    kind: "workflow-v17-metric-set-authority",
    runId: record.runId,
    metricSetId: record.metricSetId,
    authorityId: record.authorityId,
    policyHash: record.policyHash,
    samplingHash: record.samplingHash,
  });
}

function noArguments(args: unknown[], method: string): void {
  if (args.length !== 0) throw new TypeError(`Workflow v17 metric-set ${method} accepts no arguments`);
}

function metricRecord(value: unknown, label: string): Record<string, unknown> {
  if (!plainRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${label} contains unknown field ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new TypeError(`${label} requires ${key}`);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function limits() {
  return {
    maxBytes: DEFINITION_LIMITS.structuralValueBytes,
    maxDepth: DEFINITION_LIMITS.structuralValueDepth,
    maxNodes: DEFINITION_LIMITS.structuralValueNodes,
    maxStringScalars: DEFINITION_LIMITS.structuralStringScalars,
  };
}
