import { canonicalJsonObject, canonicalJsonValue, deepFreezeJson } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS, FLOW_NAME_PATTERN } from "../definition/limits.js";
import type { JsonObject, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import {
  aggregateMetricSamples,
  finiteMetricNumber as finite,
  metricJsonLimits as metricLimits,
  metricRole,
  normalizeMetricDefinition,
  type MetricDirection,
  type NormalizedMetricDefinition,
} from "./metric-definition.js";

export {
  aggregateMetricSamples,
  normalizeMetricDefinition,
} from "./metric-definition.js";
export type {
  MetricAggregate,
  MetricDirection,
  MetricGuardrail,
  MetricImprovement,
  MetricSampling,
  MetricTarget,
  NormalizedMetricDefinition,
} from "./metric-definition.js";

export type MetricRole = "primary" | "guardrail" | "secondary";

export interface MetricObservation {
  observationId: string;
  metricId: string;
  outputId: string;
  value: number;
  samples: number[];
}

export interface MetricDeltaObservation extends MetricObservation {
  status: "baseline" | "observational" | "pending";
}

export interface MetricCohortDelta {
  formatVersion: 1;
  kind: "measurement-cohort";
  measurementId: string;
  operationPath: string;
  profileId: string;
  profileHash: string;
  environmentHash: string;
  candidate?: { candidateId: string; treeHash: string; lineageHash: string };
  definitions: Array<{
    metricId: string;
    definition: NormalizedMetricDefinition;
    definitionHash: string;
  }>;
  observations: MetricDeltaObservation[];
}

export interface PersistedMetricObservation {
  sequence: number;
  measurementId: string;
  observationId: string;
  outputId: string;
  value: number;
  status: "baseline" | "observational" | "pending" | "accepted" | "rejected";
  improvementPassed: boolean | null;
  guardrailPassed: boolean | null;
}

export interface PersistedMetricState {
  metricId: string;
  definition: NormalizedMetricDefinition;
  definitionHash: string;
  role: MetricRole;
  baseline: number | null;
  current: number | null;
  best: number | null;
  relativeGain: number | null;
  observationCount: number;
  baselineProfileId?: string;
  baselineProfileHash?: string;
  baselineEnvironmentHash?: string;
  recentObservations: PersistedMetricObservation[];
}

export interface MetricSummary {
  baseline: number | null;
  current: number | null;
  best: number | null;
  relativeGain: number | null;
  observationCount: number;
}

export interface MetricConditionResult {
  result: boolean;
  label: string;
  operands?: JsonObject;
}

interface RuntimeMetricState extends PersistedMetricState {
  observations: PersistedMetricObservation[];
}

export interface MetricPolicyResult {
  eligible: boolean;
  primary?: { metricId: string; present: boolean; passed: boolean };
  guardrails: Array<{ metricId: string; present: boolean; passed: boolean }>;
  secondary: Array<{ metricId: string; present: boolean }>;
  violations: string[];
}

const METRIC_HANDLES = new WeakMap<object, RuntimeMetricState>();

export class MeasurementIdentityError extends Error {
  readonly attentionKind = "measurement-environment-changed" as const;
  readonly metricId: string;
  readonly expected: string;
  readonly actual: string;

  constructor(
    message: string,
    metricId: string,
    expected: string,
    actual: string,
  ) {
    super(message);
    this.name = "MeasurementIdentityError";
    this.metricId = metricId;
    this.expected = expected;
    this.actual = actual;
  }
}

export function createMetricHandle(idValue: unknown, definitionValue: unknown): object {
  if (typeof idValue !== "string" || !FLOW_NAME_PATTERN.test(idValue)) {
    throw new Error(`Metric id must match ${FLOW_NAME_PATTERN.source}`);
  }
  const definition = normalizeMetricDefinition(definitionValue, idValue);
  const state: RuntimeMetricState = {
    metricId: idValue,
    definition,
    definitionHash: stableHash(definition),
    role: metricRole(definition),
    baseline: null,
    current: null,
    best: null,
    relativeGain: null,
    observationCount: 0,
    recentObservations: [],
    observations: [],
  };
  const handle = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(handle, {
    baseline: { enumerable: true, get: () => state.baseline },
    current: { enumerable: true, get: () => state.current },
    best: { enumerable: true, get: () => state.best },
    relativeGain: { enumerable: true, get: () => state.relativeGain },
    reachesTarget: { enumerable: false, value: () => reachesTarget(state) },
    needsImprovement: { enumerable: false, value: () => needsImprovement(state) },
    isImprovement: { enumerable: false, value: (observation: unknown) => isMetricImprovement(state, normalizeObservation(observation)) },
    isWithinGuardrail: { enumerable: false, value: (observation: unknown) => isMetricWithinGuardrail(state, normalizeObservation(observation)) },
    summary: { enumerable: false, value: () => metricSummary(state) },
  });
  METRIC_HANDLES.set(handle, state);
  return Object.freeze(handle);
}

export function metricHandleState(value: unknown): Readonly<RuntimeMetricState> {
  if (!value || typeof value !== "object") throw new Error("Expected a metric handle");
  const state = METRIC_HANDLES.get(value as object);
  if (!state) throw new Error("Metric handle was not created by this workflow run");
  return state;
}

export function metricHandleIdentity(value: unknown): {
  metricId: string;
  definition: NormalizedMetricDefinition;
  definitionHash: string;
} {
  const state = metricHandleState(value);
  return {
    metricId: state.metricId,
    definition: structuredClone(state.definition),
    definitionHash: state.definitionHash,
  };
}

export function assertMeasurementIdentity(
  handles: readonly unknown[],
  profileId: string,
  profileHash: string,
  environmentHash: string,
): void {
  for (const handle of handles) {
    const state = metricHandleState(handle);
    if (state.baseline === null) continue;
    if (state.baselineProfileHash !== profileHash) {
      throw new MeasurementIdentityError(
        `Metric ${state.metricId} baseline uses ${state.baselineProfileId ?? "another profile"}; ${profileId} is not comparable`,
        state.metricId,
        state.baselineProfileHash ?? "<missing>",
        profileHash,
      );
    }
    if (state.baselineEnvironmentHash !== environmentHash) {
      throw new MeasurementIdentityError(
        `Metric ${state.metricId} measurement environment no longer matches its baseline`,
        state.metricId,
        state.baselineEnvironmentHash ?? "<missing>",
        environmentHash,
      );
    }
  }
}

export function buildMetricCohortDelta(options: {
  measurementId: string;
  operationPath: string;
  profileId: string;
  profileHash: string;
  environmentHash: string;
  candidate?: { candidateId: string; treeHash: string; lineageHash: string };
  mappings: readonly { outputId: string; handle: unknown; value: number; samples: number[] }[];
}): MetricCohortDelta {
  const metricIds = new Set<string>();
  const outputIds = new Set<string>();
  const definitions: MetricCohortDelta["definitions"] = [];
  const observations: MetricDeltaObservation[] = [];
  for (const mapping of [...options.mappings].sort((left, right) => metricHandleState(left.handle).metricId.localeCompare(metricHandleState(right.handle).metricId))) {
    const state = metricHandleState(mapping.handle);
    if (metricIds.has(state.metricId)) throw new Error(`Metric ${state.metricId} appears more than once in one measurement cohort`);
    if (outputIds.has(mapping.outputId)) throw new Error(`Measurement output ${mapping.outputId} appears more than once`);
    metricIds.add(state.metricId);
    outputIds.add(mapping.outputId);
    const samples = mapping.samples.map((sample) => finite(sample, "metric sample"));
    const value = finite(mapping.value, "metric observation");
    definitions.push({ metricId: state.metricId, definition: structuredClone(state.definition), definitionHash: state.definitionHash });
    observations.push({
      observationId: `observation_${stableHash({ measurementId: options.measurementId, metricId: state.metricId, outputId: mapping.outputId }).slice(7, 39)}`,
      metricId: state.metricId,
      outputId: mapping.outputId,
      value,
      samples,
      status: options.candidate ? "pending" : state.baseline === null ? "baseline" : "observational",
    });
  }
  return deepFreezeJson(canonicalJsonObject({
    formatVersion: 1,
    kind: "measurement-cohort",
    measurementId: options.measurementId,
    operationPath: options.operationPath,
    profileId: options.profileId,
    profileHash: options.profileHash,
    environmentHash: options.environmentHash,
    ...(options.candidate ? { candidate: options.candidate } : {}),
    definitions,
    observations,
  }, metricDeltaLimits())) as unknown as MetricCohortDelta;
}

export function applyMetricCohortDeltaToHandles(
  handles: ReadonlyMap<string, unknown>,
  deltaValue: unknown,
): void {
  const delta = normalizeMetricCohortDelta(deltaValue);
  const definitions = new Map(delta.definitions.map((entry) => [entry.metricId, entry]));
  for (const observation of [...delta.observations].sort((left, right) => left.metricId.localeCompare(right.metricId))) {
    const handle = handles.get(observation.metricId);
    if (!handle) throw new Error(`Measurement replay has no registered metric ${observation.metricId}`);
    const state = metricHandleState(handle) as RuntimeMetricState;
    const definition = definitions.get(observation.metricId)!;
    if (state.definitionHash !== definition.definitionHash) throw new Error(`Metric ${state.metricId} definition changed during replay`);
    applyObservation(state, delta, observation, state.observationCount + 1);
  }
}

export function applyMetricCohortDeltaToSnapshot(
  current: readonly PersistedMetricState[],
  deltaValue: unknown,
): PersistedMetricState[] {
  const delta = normalizeMetricCohortDelta(deltaValue);
  const states = new Map(current.map((state) => [state.metricId, clonePersistedState(state)]));
  const definitions = new Map(delta.definitions.map((entry) => [entry.metricId, entry]));
  for (const observation of [...delta.observations].sort((left, right) => left.metricId.localeCompare(right.metricId))) {
    const definition = definitions.get(observation.metricId)!;
    let state = states.get(observation.metricId);
    if (!state) {
      if (states.size >= DEFINITION_LIMITS.metrics) throw new Error(`Run exceeds ${DEFINITION_LIMITS.metrics} metrics`);
      state = {
        metricId: observation.metricId,
        definition: structuredClone(definition.definition),
        definitionHash: definition.definitionHash,
        role: metricRole(definition.definition),
        baseline: null,
        current: null,
        best: null,
        relativeGain: null,
        observationCount: 0,
        recentObservations: [],
      };
      states.set(state.metricId, state);
    }
    if (state.definitionHash !== definition.definitionHash) throw new Error(`Metric ${state.metricId} definition changed`);
    applyObservation(state as RuntimeMetricState, delta, observation, state.observationCount + 1);
    state.recentObservations = state.recentObservations.slice(-DEFINITION_LIMITS.measurementRecentObservations);
  }
  const result = [...states.values()].sort((left, right) => left.metricId.localeCompare(right.metricId));
  validateSinglePrimary(result);
  return result;
}

export function normalizeMetricCohortDelta(value: unknown): MetricCohortDelta {
  const canonical = canonicalJsonObject(value, metricDeltaLimits()) as unknown as MetricCohortDelta;
  if (canonical.formatVersion !== 1 || canonical.kind !== "measurement-cohort") throw new Error("Invalid metric cohort delta version");
  if (
    !/^measurement_[a-f0-9]{32}$/.test(canonical.measurementId) ||
    typeof canonical.operationPath !== "string" || !canonical.operationPath.startsWith("run/") ||
    !/^(?:builtin|user|project):[a-z][a-z0-9_-]{0,63}$/.test(canonical.profileId) ||
    !/^sha256:[a-f0-9]{64}$/.test(canonical.profileHash) ||
    !/^sha256:[a-f0-9]{64}$/.test(canonical.environmentHash)
  ) {
    throw new Error("Invalid measurement cohort identity");
  }
  if (canonical.candidate !== undefined && (
    !/^candidate_[a-f0-9]{32}$/.test(canonical.candidate.candidateId) ||
    !/^sha256:[a-f0-9]{64}$/.test(canonical.candidate.treeHash) ||
    !/^sha256:[a-f0-9]{64}$/.test(canonical.candidate.lineageHash)
  )) throw new Error("Invalid candidate-bound measurement identity");
  if (
    !Array.isArray(canonical.definitions) || canonical.definitions.length < 1 || canonical.definitions.length > DEFINITION_LIMITS.measurementOutputs ||
    !Array.isArray(canonical.observations) || canonical.observations.length === 0
  ) {
    throw new Error("Metric cohort delta is empty");
  }
  const definitions = new Map<string, MetricCohortDelta["definitions"][number]>();
  for (const entry of canonical.definitions) {
    if (!entry || !FLOW_NAME_PATTERN.test(entry.metricId) || entry.definitionHash !== stableHash(entry.definition)) {
      throw new Error("Metric cohort contains an invalid definition");
    }
    if (definitions.has(entry.metricId)) throw new Error(`Duplicate metric definition ${entry.metricId}`);
    const normalized = normalizeMetricDefinition(entry.definition, entry.metricId);
    if (stableHash(normalized) !== entry.definitionHash) throw new Error(`Metric definition ${entry.metricId} is not canonical`);
    definitions.set(entry.metricId, entry);
  }
  const observations = new Set<string>();
  for (const observation of canonical.observations) {
    if (!definitions.has(observation.metricId) || observations.has(observation.metricId)) throw new Error("Metric cohort observations do not match definitions");
    const normalized = normalizeObservation(observation);
    if (!["baseline", "observational", "pending"].includes(observation.status)) throw new Error("Metric observation status is invalid");
    if ((observation.status === "pending") !== Boolean(canonical.candidate)) throw new Error("Candidate measurement disposition is inconsistent");
    if (canonical.candidate && observation.status === "baseline") throw new Error("A candidate observation cannot establish a baseline");
    const expectedId = `observation_${stableHash({
      measurementId: canonical.measurementId,
      metricId: normalized.metricId,
      outputId: normalized.outputId,
    }).slice(7, 39)}`;
    const definition = definitions.get(normalized.metricId)!.definition;
    if (
      normalized.observationId !== expectedId ||
      aggregateMetricSamples(normalized.samples, definition.sampling.aggregate) !== normalized.value
    ) throw new Error(`Metric observation ${normalized.observationId} does not match its cohort evidence`);
    observations.add(observation.metricId);
  }
  if (observations.size !== definitions.size) throw new Error("Metric cohort is missing an observation");
  return deepFreezeJson(canonical as unknown as JsonValue) as unknown as MetricCohortDelta;
}

export function metricSummary(stateValue: unknown): MetricSummary {
  const state = isMetricState(stateValue) ? stateValue : metricHandleState(stateValue);
  return Object.freeze({
    baseline: state.baseline,
    current: state.current,
    best: state.best,
    relativeGain: state.relativeGain,
    observationCount: state.observationCount,
  });
}

export function reachesTarget(stateValue: unknown): MetricConditionResult {
  const state = isMetricState(stateValue) ? stateValue : metricHandleState(stateValue);
  requireBaseline(state);
  if (!state.definition.target) {
    return condition(false, `${state.definition.title} has no target`, { metricId: state.metricId, best: state.best! });
  }
  const target = state.definition.target;
  const best = state.best!;
  let reached: boolean;
  let effectiveValue: number;
  if (target.kind === "value") {
    effectiveValue = target.value;
    reached = state.definition.direction === "maximize" ? best >= target.value : best <= target.value;
  } else if (target.kind === "absoluteGain") {
    effectiveValue = finite(
      state.definition.direction === "maximize" ? state.baseline! + target.value : state.baseline! - target.value,
      "effective metric target",
    );
    reached = goodChange(state.definition.direction, best, state.baseline!) >= target.value;
  } else {
    const gain = relativeGoodChange(state.definition.direction, best, state.baseline!, "relative target");
    effectiveValue = finite(
      state.definition.direction === "maximize"
        ? state.baseline! + Math.abs(state.baseline!) * target.value
        : state.baseline! - Math.abs(state.baseline!) * target.value,
      "effective metric target",
    );
    reached = gain >= target.value;
  }
  return condition(reached, reached ? `${state.definition.title} target reached` : `${state.definition.title} target not reached`, {
    metricId: state.metricId,
    baseline: state.baseline!,
    best,
    targetKind: target.kind,
    target: target.value,
    effectiveValue,
  });
}

export function needsImprovement(stateValue: unknown): MetricConditionResult {
  const target = reachesTarget(stateValue);
  return Object.freeze({
    result: !target.result,
    label: target.result ? "metric target reached" : "metric still needs improvement",
    ...(target.operands ? { operands: target.operands } : {}),
  });
}

export function isMetricImprovement(stateValue: unknown, observationValue: unknown): boolean {
  const state = isMetricState(stateValue) ? stateValue : metricHandleState(stateValue);
  const observation = normalizeObservation(observationValue);
  assertObservationMetric(state, observation);
  requireBaseline(state);
  const reference = state.best!;
  const threshold = state.definition.improvement;
  if (threshold?.minimumRelative !== undefined && reference === 0) {
    throw new Error(`Metric ${state.metricId} cannot use relative minimum improvement with a zero reference`);
  }
  const change = goodChange(state.definition.direction, observation.value, reference);
  if (!(change > 0)) return false;
  if (!threshold) return true;
  if (threshold.minimumAbsolute !== undefined && change < threshold.minimumAbsolute) return false;
  if (threshold.minimumRelative !== undefined) {
    const relative = relativeGoodChange(state.definition.direction, observation.value, reference, "relative minimum improvement");
    if (relative < threshold.minimumRelative) return false;
  }
  return true;
}

export function isMetricWithinGuardrail(stateValue: unknown, observationValue: unknown): boolean {
  const state = isMetricState(stateValue) ? stateValue : metricHandleState(stateValue);
  const observation = normalizeObservation(observationValue);
  assertObservationMetric(state, observation);
  requireBaseline(state);
  const guardrail = state.definition.guardrail;
  if (!guardrail) return true;
  const reference = guardrail.reference === "baseline" ? state.baseline! : state.best ?? state.baseline!;
  if (guardrail.maximumRelativeRegression !== undefined && reference === 0) {
    throw new Error(`Metric ${state.metricId} cannot use a relative guardrail with a zero reference`);
  }
  const regression = -goodChange(state.definition.direction, observation.value, reference);
  if (guardrail.maximumAbsoluteRegression !== undefined && regression > guardrail.maximumAbsoluteRegression) return false;
  if (guardrail.maximumRelativeRegression !== undefined) {
    const relativeRegression = regression / Math.abs(reference);
    if (relativeRegression > guardrail.maximumRelativeRegression) return false;
  }
  return true;
}

/** Shared by helpers, projection fixtures, and the later acceptance authority. */
export function evaluateMeasurementPolicy(
  metrics: readonly unknown[],
  observationsByOutput: Record<string, unknown>,
): MetricPolicyResult {
  const states = metrics.map((metric) => isMetricState(metric) ? metric : metricHandleState(metric));
  validateSinglePrimary(states);
  const observations = Object.values(observationsByOutput).map(normalizeObservation);
  const byMetric = new Map(observations.map((observation) => [observation.metricId, observation]));
  const primaryState = states.find((state) => state.role === "primary");
  const primaryObservation = primaryState ? byMetric.get(primaryState.metricId) : undefined;
  const primary = primaryState ? {
    metricId: primaryState.metricId,
    present: Boolean(primaryObservation),
    passed: Boolean(primaryObservation && isMetricImprovement(primaryState, primaryObservation)),
  } : undefined;
  const guardrails = states.filter((state) => state.role === "guardrail").map((state) => {
    const observation = byMetric.get(state.metricId);
    return {
      metricId: state.metricId,
      present: Boolean(observation),
      passed: Boolean(observation && isMetricWithinGuardrail(state, observation)),
    };
  });
  const secondary = states.filter((state) => state.role === "secondary").map((state) => ({
    metricId: state.metricId,
    present: byMetric.has(state.metricId),
  }));
  const violations = [
    ...(primary && (!primary.present || !primary.passed) ? [`primary:${primary.metricId}`] : []),
    ...guardrails.filter((guardrail) => !guardrail.present || !guardrail.passed).map((guardrail) => `guardrail:${guardrail.metricId}`),
  ];
  return deepFreezeJson(canonicalJsonValue({
    eligible: violations.length === 0,
    ...(primary ? { primary } : {}),
    guardrails,
    secondary,
    violations,
  }, metricLimits())) as unknown as MetricPolicyResult;
}

function applyObservation(
  state: RuntimeMetricState,
  delta: MetricCohortDelta,
  observation: MetricDeltaObservation,
  sequence: number,
): void {
  if (state.observations?.some((entry) => entry.observationId === observation.observationId) ||
      state.recentObservations.some((entry) => entry.observationId === observation.observationId)) {
    throw new Error(`Duplicate metric observation ${observation.observationId}`);
  }
  const expectsBaseline = state.baseline === null;
  if ((observation.status === "baseline") !== expectsBaseline) throw new Error(`Metric ${state.metricId} observation chronology is invalid`);
  if (expectsBaseline) {
    state.baseline = observation.value;
    state.best = observation.value;
    state.baselineProfileId = delta.profileId;
    state.baselineProfileHash = delta.profileHash;
    state.baselineEnvironmentHash = delta.environmentHash;
  } else {
    if (state.baselineProfileHash !== delta.profileHash || state.baselineEnvironmentHash !== delta.environmentHash) {
      throw new Error(`Metric ${state.metricId} received a mismatched observation delta`);
    }
  }
  const improvementPassed = expectsBaseline ? null : isMetricImprovement(state, observation);
  const guardrailPassed = expectsBaseline || !state.definition.guardrail ? null : isMetricWithinGuardrail(state, observation);
  const persisted: PersistedMetricObservation = {
    sequence,
    measurementId: delta.measurementId,
    observationId: observation.observationId,
    outputId: observation.outputId,
    value: observation.value,
    status: observation.status,
    improvementPassed,
    guardrailPassed,
  };
  if (observation.status !== "pending") state.current = observation.value;
  state.observationCount++;
  state.relativeGain = state.baseline === null || state.best === null || state.baseline === 0
    ? null
    : goodChange(state.definition.direction, state.best, state.baseline) / Math.abs(state.baseline);
  if (state.observations) state.observations.push(persisted);
  state.recentObservations.push(persisted);
  if (state.recentObservations.length > DEFINITION_LIMITS.measurementRecentObservations) state.recentObservations.shift();
}

function normalizeObservation(value: unknown): MetricObservation {
  const record = canonicalJsonObject(value, metricLimits()) as unknown as MetricObservation;
  if (
    !/^observation_[a-f0-9]{32}$/.test(record.observationId) || !FLOW_NAME_PATTERN.test(record.metricId) ||
    !FLOW_NAME_PATTERN.test(record.outputId) || typeof record.value !== "number" || !Number.isFinite(record.value) ||
    !Array.isArray(record.samples) || record.samples.length < 1 || record.samples.length > DEFINITION_LIMITS.measurementSamples ||
    record.samples.some((sample) => typeof sample !== "number" || !Number.isFinite(sample))
  ) throw new Error("Metric observation is invalid");
  return deepFreezeJson(record as unknown as JsonValue) as unknown as MetricObservation;
}

function validateSinglePrimary(states: readonly Pick<PersistedMetricState, "metricId" | "role">[]): void {
  const primary = states.filter((state) => state.role === "primary");
  if (primary.length > 1) throw new Error(`Only one primary metric is allowed: ${primary.map((state) => state.metricId).join(", ")}`);
}

function requireBaseline(state: Pick<PersistedMetricState, "metricId" | "baseline" | "best">): void {
  if (state.baseline === null || state.best === null) throw new Error(`Metric ${state.metricId} has no baseline observation`);
}

function assertObservationMetric(state: Pick<PersistedMetricState, "metricId">, observation: MetricObservation): void {
  if (observation.metricId !== state.metricId) throw new Error(`Observation ${observation.observationId} belongs to metric ${observation.metricId}, not ${state.metricId}`);
}

function goodChange(direction: MetricDirection, candidate: number, reference: number): number {
  return direction === "maximize" ? candidate - reference : reference - candidate;
}

function relativeGoodChange(direction: MetricDirection, candidate: number, reference: number, label: string): number {
  if (reference === 0) throw new Error(`Cannot compute ${label} from a zero metric reference`);
  return goodChange(direction, candidate, reference) / Math.abs(reference);
}

function condition(result: boolean, label: string, operands: JsonObject): MetricConditionResult {
  return Object.freeze({ result, label, operands: deepFreezeJson(canonicalJsonObject(operands, metricLimits())) });
}

function isMetricState(value: unknown): value is RuntimeMetricState | PersistedMetricState {
  return Boolean(value && typeof value === "object" && typeof (value as PersistedMetricState).metricId === "string" && (value as PersistedMetricState).definition);
}

function clonePersistedState(value: PersistedMetricState): PersistedMetricState {
  return structuredClone(value);
}

function metricDeltaLimits() {
  return {
    ...metricLimits(),
    maxBytes: DEFINITION_LIMITS.structuralValueBytes,
  };
}
