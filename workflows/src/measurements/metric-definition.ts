import { canonicalJsonObject, deepFreezeJson } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";

export type MetricDirection = "minimize" | "maximize";
export type MetricAggregate = "median" | "mean" | "min" | "max";

export interface MetricSampling {
  warmups: number;
  samples: number;
  aggregate: MetricAggregate;
}

export interface MetricTarget {
  kind: "value" | "relativeGain" | "absoluteGain";
  value: number;
}

export interface MetricImprovement {
  minimumAbsolute?: number;
  minimumRelative?: number;
}

export interface MetricGuardrail {
  reference: "baseline" | "best";
  maximumAbsoluteRegression?: number;
  maximumRelativeRegression?: number;
}

export interface NormalizedMetricDefinition {
  title: string;
  direction: MetricDirection;
  unit?: string;
  primary: boolean;
  format: "number" | "percent" | "duration" | "bytes";
  target?: MetricTarget;
  sampling: MetricSampling;
  improvement?: MetricImprovement;
  guardrail?: MetricGuardrail;
}

export function normalizeMetricDefinition(value: unknown, id: string): NormalizedMetricDefinition {
  const record = realmRecord(value, "metric definition");
  assertKeys(record, new Set(["title", "direction", "unit", "primary", "format", "target", "sampling", "improvement", "guardrail"]), "metric definition");
  const title = record.title === undefined ? humanize(id) : boundedString(record.title, "metric title", 192);
  const direction = record.direction;
  if (direction !== "minimize" && direction !== "maximize") throw new Error("Metric direction must be minimize or maximize");
  const unit = record.unit === undefined ? undefined : boundedString(record.unit, "metric unit", 192);
  const primary = record.primary ?? false;
  if (typeof primary !== "boolean") throw new Error("Metric primary must be boolean");
  const format = record.format ?? "number";
  if (!["number", "percent", "duration", "bytes"].includes(String(format))) throw new Error("Metric format is invalid");
  const target = record.target === undefined ? undefined : normalizeTarget(record.target);
  const sampling = normalizeSampling(record.sampling);
  const improvement = record.improvement === undefined ? undefined : normalizeImprovement(record.improvement);
  const guardrail = record.guardrail === undefined ? undefined : normalizeGuardrail(record.guardrail);
  if (primary && guardrail) throw new Error("A metric cannot be both primary and a guardrail");
  return deepFreezeJson(canonicalJsonObject({
    title,
    direction,
    ...(unit ? { unit } : {}),
    primary,
    format,
    ...(target ? { target } : {}),
    sampling,
    ...(improvement ? { improvement } : {}),
    ...(guardrail ? { guardrail } : {}),
  }, metricJsonLimits())) as unknown as NormalizedMetricDefinition;
}

export function aggregateMetricSamples(samples: readonly number[], aggregate: MetricAggregate): number {
  if (!Array.isArray(samples) || samples.length === 0 || samples.length > DEFINITION_LIMITS.measurementSamples) {
    throw new Error("Metric sample set is empty or exceeds its bound");
  }
  const normalized = samples.map((sample) => finiteMetricNumber(sample, "metric sample"));
  let value: number;
  if (aggregate === "min") value = Math.min(...normalized);
  else if (aggregate === "max") value = Math.max(...normalized);
  else if (aggregate === "mean") {
    value = 0;
    normalized.forEach((sample, index) => { value += (sample - value) / (index + 1); });
  } else if (aggregate === "median") {
    const sorted = [...normalized].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    value = sorted.length % 2 === 1 ? sorted[middle]! : sorted[middle - 1]! / 2 + sorted[middle]! / 2;
  } else throw new Error(`Unknown metric aggregation ${String(aggregate)}`);
  return finiteMetricNumber(value, "aggregated metric value");
}

export function metricRole(definition: NormalizedMetricDefinition): "primary" | "guardrail" | "secondary" {
  return definition.primary ? "primary" : definition.guardrail ? "guardrail" : "secondary";
}

export function finiteMetricNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}

export function metricJsonLimits() {
  return {
    maxBytes: DEFINITION_LIMITS.structuralValueBytes,
    maxDepth: DEFINITION_LIMITS.structuralValueDepth,
    maxNodes: DEFINITION_LIMITS.structuralValueNodes,
    maxStringScalars: DEFINITION_LIMITS.structuralStringScalars,
  };
}

function normalizeSampling(value: unknown): MetricSampling {
  if (value === undefined) return { warmups: 0, samples: 1, aggregate: "median" };
  const record = realmRecord(value, "metric sampling");
  assertKeys(record, new Set(["warmups", "samples", "aggregate"]), "metric sampling");
  const warmups = boundedInteger(record.warmups ?? 0, "metric warmups", 0, DEFINITION_LIMITS.measurementWarmups);
  const samples = boundedInteger(record.samples, "metric samples", 1, DEFINITION_LIMITS.measurementSamples);
  if (warmups + samples > DEFINITION_LIMITS.measurementInvocations) throw new Error("Metric sampling exceeds the invocation bound");
  if (!["median", "mean", "min", "max"].includes(String(record.aggregate))) throw new Error("Metric aggregation is invalid");
  return { warmups, samples, aggregate: record.aggregate as MetricAggregate };
}

function normalizeTarget(value: unknown): MetricTarget {
  const record = realmRecord(value, "metric target");
  assertRequiredExactKeys(record, new Set(["kind", "value"]), "metric target");
  if (!["value", "relativeGain", "absoluteGain"].includes(String(record.kind))) throw new Error("Metric target kind is invalid");
  const target = finiteMetricNumber(record.value, "metric target value");
  if (record.kind !== "value" && target < 0) throw new Error("Metric gain targets must be non-negative");
  return { kind: record.kind as MetricTarget["kind"], value: target };
}

function normalizeImprovement(value: unknown): MetricImprovement {
  const record = realmRecord(value, "metric improvement");
  assertKeys(record, new Set(["minimumAbsolute", "minimumRelative"]), "metric improvement");
  if (record.minimumAbsolute === undefined && record.minimumRelative === undefined) throw new Error("Metric improvement must declare at least one threshold");
  const minimumAbsolute = record.minimumAbsolute === undefined ? undefined : nonNegative(record.minimumAbsolute, "minimum absolute improvement");
  const minimumRelative = record.minimumRelative === undefined ? undefined : nonNegative(record.minimumRelative, "minimum relative improvement");
  return { ...(minimumAbsolute !== undefined ? { minimumAbsolute } : {}), ...(minimumRelative !== undefined ? { minimumRelative } : {}) };
}

function normalizeGuardrail(value: unknown): MetricGuardrail {
  const record = realmRecord(value, "metric guardrail");
  assertKeys(record, new Set(["reference", "maximumAbsoluteRegression", "maximumRelativeRegression"]), "metric guardrail");
  if (record.reference !== "baseline" && record.reference !== "best") throw new Error("Metric guardrail reference must be baseline or best");
  if (record.maximumAbsoluteRegression === undefined && record.maximumRelativeRegression === undefined) {
    throw new Error("Metric guardrail must declare at least one maximum regression");
  }
  const maximumAbsoluteRegression = record.maximumAbsoluteRegression === undefined
    ? undefined : nonNegative(record.maximumAbsoluteRegression, "maximum absolute regression");
  const maximumRelativeRegression = record.maximumRelativeRegression === undefined
    ? undefined : nonNegative(record.maximumRelativeRegression, "maximum relative regression");
  return {
    reference: record.reference,
    ...(maximumAbsoluteRegression !== undefined ? { maximumAbsoluteRegression } : {}),
    ...(maximumRelativeRegression !== undefined ? { maximumRelativeRegression } : {}),
  };
}

function realmRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor");
    if (Object.getPrototypeOf(prototype) !== null || !constructor || !("value" in constructor) || constructor.value?.name !== "Object") {
      throw new Error(`${label} must be a plain object`);
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || descriptor.get || descriptor.set || !("value" in descriptor)) throw new Error(`${label}.${key} must be an enumerable data property`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(record: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`${label} contains unknown field ${key}`);
}

function assertRequiredExactKeys(record: Record<string, unknown>, expected: Set<string>, label: string): void {
  assertKeys(record, expected, label);
  for (const key of expected) if (!Object.prototype.hasOwnProperty.call(record, key)) throw new Error(`${label}.${key} is required`);
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "" || Array.from(value).length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must contain 1–${maximum} safe Unicode scalars`);
  }
  return value;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function nonNegative(value: unknown, label: string): number {
  const number = finiteMetricNumber(value, label);
  if (number < 0) throw new Error(`${label} must be non-negative`);
  return number;
}

function humanize(id: string): string {
  const value = id.replace(/[-_]+/g, " ");
  return value[0]!.toUpperCase() + value.slice(1);
}
