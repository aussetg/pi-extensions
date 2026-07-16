import { Ajv } from "ajv";
import type { HumanCheckpointRequest, StructuredReason } from "./durable-types.js";
import type { JsonObject, JsonValue } from "../types.js";
import { canonicalJsonObject, canonicalJsonValue, deepFreezeJson, scalarLength } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS, FLOW_NAME_PATTERN } from "../definition/limits.js";

const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });

export function canonicalInvocationInput(value: unknown): JsonObject {
  return deepFreezeJson(canonicalJsonObject(value, {
    maxBytes: DEFINITION_LIMITS.invocationBytes,
    maxDepth: DEFINITION_LIMITS.invocationDepth,
    maxNodes: DEFINITION_LIMITS.invocationNodes,
    maxStringScalars: DEFINITION_LIMITS.invocationStringScalars,
  }));
}

export function canonicalStructuralJson(value: unknown): JsonValue {
  return deepFreezeJson(canonicalJsonValue(value, {
    maxBytes: DEFINITION_LIMITS.structuralValueBytes,
    maxDepth: DEFINITION_LIMITS.structuralValueDepth,
    maxNodes: DEFINITION_LIMITS.structuralValueNodes,
    maxStringScalars: DEFINITION_LIMITS.structuralStringScalars,
  }));
}

export function validateJsonSchema(schema: JsonObject, value: unknown, label: string): void {
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new Error(`${label} is not a compilable JSON Schema: ${errorText(error)}`);
  }
  if (!validate(value)) throw new Error(`${label} rejected the value: ${ajv.errorsText(validate.errors)}`);
}

export function operationSourceId(value: unknown): string {
  if (typeof value !== "string" || !FLOW_NAME_PATTERN.test(value)) {
    throw new Error(`Flow operation id must match ${FLOW_NAME_PATTERN.source}`);
  }
  return value;
}

export function normalizeStageOptions(value: unknown): { title?: string } {
  if (value === undefined) return {};
  const record = plainRecord(value, "stage options");
  exactKeys(record, new Set(["title"]), "stage options");
  return record.title === undefined ? {} : { title: boundedTitle(record.title) };
}

export function normalizeCheckpointRequest(value: unknown): HumanCheckpointRequest {
  const record = plainRecord(value, "checkpoint options");
  const kind = record.kind;
  if (kind !== "confirm" && kind !== "choice" && kind !== "input") {
    throw new Error("checkpoint kind must be confirm, choice, or input");
  }
  const allowed = new Set(["kind", "title", "prompt"]);
  if (kind === "choice") allowed.add("choices");
  if (kind === "input") allowed.add("responseSchema");
  exactKeys(record, allowed, "checkpoint options");
  const prompt = boundedText(record.prompt, "checkpoint prompt", DEFINITION_LIMITS.checkpointPromptScalars);
  const title = record.title === undefined ? undefined : boundedTitle(record.title);
  if (kind === "confirm") return { kind, ...(title ? { title } : {}), prompt };
  if (kind === "choice") {
    if (!Array.isArray(record.choices) || record.choices.length < 1 || record.choices.length > DEFINITION_LIMITS.checkpointChoices) {
      throw new Error(`checkpoint choices must contain 1–${DEFINITION_LIMITS.checkpointChoices} entries`);
    }
    const seen = new Set<string>();
    const choices = record.choices.map((value, index) => {
      const choice = plainRecord(value, `checkpoint choice ${index}`);
      exactKeys(choice, new Set(["id", "label"]), `checkpoint choice ${index}`);
      const id = operationSourceId(choice.id);
      if (seen.has(id)) throw new Error(`Duplicate checkpoint choice id ${id}`);
      seen.add(id);
      return {
        id,
        label: boundedText(choice.label, `checkpoint choice ${id} label`, DEFINITION_LIMITS.checkpointChoiceLabelScalars),
      };
    });
    return { kind, ...(title ? { title } : {}), prompt, choices };
  }
  const responseSchema = canonicalStructuralJson(record.responseSchema);
  if (!responseSchema || typeof responseSchema !== "object" || Array.isArray(responseSchema)) {
    throw new Error("checkpoint responseSchema must be a JSON object");
  }
  try { ajv.compile(responseSchema); }
  catch (error) { throw new Error(`checkpoint responseSchema is invalid: ${errorText(error)}`); }
  return { kind, ...(title ? { title } : {}), prompt, responseSchema };
}

export function workflowFailureReason(error: unknown, operationId?: string): StructuredReason {
  return {
    category: "workflow",
    code: "workflow-failed",
    summary: boundedError(error),
    retryable: false,
    ...(operationId ? { operationId } : {}),
  };
}

export function effectFailureReason(error: unknown, operationId: string): StructuredReason {
  const supplied = error && typeof error === "object" ? (error as { reason?: unknown }).reason : undefined;
  if (isStructuredReason(supplied)) return { ...supplied, operationId };
  return {
    category: "effect",
    code: "effect-failed",
    summary: boundedError(error),
    retryable: false,
    operationId,
  };
}

function isStructuredReason(value: unknown): value is StructuredReason {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reason = value as Partial<StructuredReason>;
  return typeof reason.category === "string"
    && typeof reason.code === "string"
    && typeof reason.summary === "string"
    && typeof reason.retryable === "boolean";
}

export function boundedError(error: unknown): string {
  const source = error instanceof Error ? error.message : String(error);
  const clean = source.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  return Array.from(clean).slice(0, 4_000).join("") || "Workflow failed";
}

function boundedTitle(value: unknown): string {
  return boundedText(value, "operation title", DEFINITION_LIMITS.titleScalars);
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || scalarLength(value) > maximum) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} Unicode scalars`);
  }
  for (const scalar of value) {
    const code = scalar.codePointAt(0)!;
    if ((code >= 0 && code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      throw new Error(`${label} contains disallowed control characters`);
    }
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
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.sort().join(", ")}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
