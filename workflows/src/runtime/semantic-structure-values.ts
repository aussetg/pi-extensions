import { DEFINITION_LIMITS, FLOW_NAME_PATTERN } from "../definition/limits.js";
import { scalarLength } from "../definition/canonical-json.js";
import type { JsonObject } from "../types.js";
import { canonicalStructuralJson } from "./semantic-engine-values.js";

export interface NormalizedLoopOptions {
  title?: string;
  maxIterations: number;
  mode: "while" | "until";
  condition: () => unknown;
}

export interface NormalizedParallelOptions {
  title?: string;
  concurrency?: number;
  failure: "fail-fast" | "collect";
}

export interface NormalizedFanOutOptions extends NormalizedParallelOptions {
  key: (item: unknown, index: number) => unknown;
}

export interface NormalizedConditionResult {
  result: boolean;
  label: string;
  operands?: JsonObject;
}

export function normalizeLoopOptions(value: unknown): NormalizedLoopOptions {
  const record = plainRecord(value, "loop options");
  exactKeys(record, new Set(["title", "maxIterations", "while", "until"]), "loop options");
  if (
    !Number.isSafeInteger(record.maxIterations)
    || (record.maxIterations as number) < 1
    || (record.maxIterations as number) > DEFINITION_LIMITS.loopIterations
  ) throw new Error(`loop maxIterations must be 1–${DEFINITION_LIMITS.loopIterations}`);
  const hasWhile = typeof record.while === "function";
  const hasUntil = typeof record.until === "function";
  if (hasWhile === hasUntil) throw new Error("loop requires exactly one while or until callback");
  return {
    ...(record.title === undefined ? {} : { title: title(record.title) }),
    maxIterations: record.maxIterations as number,
    mode: hasWhile ? "while" : "until",
    condition: (hasWhile ? record.while : record.until) as () => unknown,
  };
}

export function normalizeConditionResult(value: unknown): NormalizedConditionResult {
  const record = plainRecord(value, "loop condition result");
  exactKeys(record, new Set(["result", "label", "operands"]), "loop condition result");
  if (typeof record.result !== "boolean") throw new Error("loop condition result.result must be boolean");
  if (typeof record.label !== "string" || !record.label.trim() || scalarLength(record.label) > 512) {
    throw new Error("loop condition result.label must be a non-empty string of at most 512 Unicode scalars");
  }
  let operands: JsonObject | undefined;
  if (record.operands !== undefined) {
    const canonical = canonicalStructuralJson(record.operands);
    if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) {
      throw new Error("loop condition result.operands must be a JSON object");
    }
    operands = canonical;
  }
  return { result: record.result, label: record.label, ...(operands ? { operands } : {}) };
}

export function normalizeParallelBranches(value: unknown): Array<{ key: string; body: () => unknown }> {
  const record = plainRecord(value, "parallel branches");
  const keys = Object.keys(record).sort(compareTextBytes);
  if (keys.length < 1 || keys.length > DEFINITION_LIMITS.parallelBranches) {
    throw new Error(`parallel branches must contain 1–${DEFINITION_LIMITS.parallelBranches} callbacks`);
  }
  return keys.map((key) => {
    operationKey(key, "parallel branch");
    if (typeof record[key] !== "function") throw new Error(`parallel branch ${key} must be a callback`);
    return { key, body: record[key] as () => unknown };
  });
}

export function normalizeParallelOptions(value: unknown): NormalizedParallelOptions {
  if (value === undefined) return { failure: "fail-fast" };
  return normalizedParallelRecord(plainRecord(value, "parallel options"), "parallel options", false);
}

export function normalizeFanOut(
  itemsValue: unknown,
  optionsValue: unknown,
  bodyValue: unknown,
): { items: unknown[]; options: NormalizedFanOutOptions; body: (item: unknown, context: unknown) => unknown } {
  if (!Array.isArray(itemsValue) || itemsValue.length > DEFINITION_LIMITS.fanOutItems) {
    throw new Error(`fanOut items must be an array of at most ${DEFINITION_LIMITS.fanOutItems} entries`);
  }
  const record = plainRecord(optionsValue, "fanOut options");
  const common = normalizedParallelRecord(record, "fanOut options", true);
  if (typeof record.key !== "function") throw new Error("fanOut options.key must be a callback");
  if (typeof bodyValue !== "function") throw new Error("fanOut body must be a callback");
  return {
    items: [...itemsValue],
    options: { ...common, key: record.key as NormalizedFanOutOptions["key"] },
    body: bodyValue as (item: unknown, context: unknown) => unknown,
  };
}

export function operationKey(value: unknown, label: string): string {
  if (typeof value !== "string" || !FLOW_NAME_PATTERN.test(value)) {
    throw new Error(`${label} key must match ${FLOW_NAME_PATTERN.source}`);
  }
  return value;
}

function normalizedParallelRecord(
  record: Record<string, unknown>,
  label: string,
  keyAllowed: boolean,
): NormalizedParallelOptions {
  exactKeys(record, new Set([...(keyAllowed ? ["key"] : []), "title", "concurrency", "failure"]), label);
  if (
    record.concurrency !== undefined
    && (!Number.isSafeInteger(record.concurrency) || (record.concurrency as number) < 1
      || (record.concurrency as number) > DEFINITION_LIMITS.concurrency)
  ) throw new Error(`${label}.concurrency must be 1–${DEFINITION_LIMITS.concurrency}`);
  const failure = record.failure ?? "fail-fast";
  if (failure !== "fail-fast" && failure !== "collect") {
    throw new Error(`${label}.failure must be fail-fast or collect`);
  }
  return {
    ...(record.title === undefined ? {} : { title: title(record.title) }),
    ...(record.concurrency === undefined ? {} : { concurrency: record.concurrency as number }),
    failure,
  };
}

function title(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || scalarLength(value) > DEFINITION_LIMITS.titleScalars) {
    throw new Error(`operation title must contain 1–${DEFINITION_LIMITS.titleScalars} Unicode scalars`);
  }
  return value;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype && Object.getPrototypeOf(prototype) !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) throw new Error(`${label}.${key} must be enumerable data`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.sort(compareTextBytes).join(", ")}`);
}

function compareTextBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
