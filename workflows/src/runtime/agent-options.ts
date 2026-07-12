import { WORKFLOW_AGENT_OPTION_LIMITS } from "../constants.js";
import { isThinkingLevel } from "../thinking.js";
import type { AgentOptions, JsonObject, JsonValue } from "../types.js";
import { byteLength } from "../utils/truncate.js";

const AGENT_OPTION_KEYS = new Set(["label", "phase", "schema", "model", "thinking", "workspace", "agentType", "stallMs"]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export function normalizeAgentOptions(input: unknown): AgentOptions {
  if (!isPlainObject(input)) throw new Error("agent(prompt, opts?) options must be an object");

  const descriptors = Object.getOwnPropertyDescriptors(input) as Record<string, PropertyDescriptor>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") throw new Error("agent opts must not contain symbol keys");
    const descriptor = descriptors[key]!;
    if (descriptor.get || descriptor.set) throw new Error(`agent opts.${key} must be a data property`);
    if (!descriptor.enumerable) throw new Error(`agent opts.${key} must be enumerable`);
    if (!AGENT_OPTION_KEYS.has(key)) throw new Error(`agent opts.${key} is not supported`);
    if (descriptor.value === undefined) throw new Error(`agent opts.${key} must not be undefined`);
  }

  const opts = input as Record<string, unknown>;
  const out: AgentOptions = {};

  if (opts.label !== undefined) out.label = validateStringOption(opts.label, "label", WORKFLOW_AGENT_OPTION_LIMITS.labelBytes);
  if (opts.phase !== undefined) out.phase = validateStringOption(opts.phase, "phase", WORKFLOW_AGENT_OPTION_LIMITS.phaseBytes);
  if (opts.model !== undefined) out.model = validateStringOption(opts.model, "model", WORKFLOW_AGENT_OPTION_LIMITS.modelBytes);
  if (opts.agentType !== undefined) out.agentType = validateStringOption(opts.agentType, "agentType", WORKFLOW_AGENT_OPTION_LIMITS.agentTypeBytes);

  if (opts.thinking !== undefined) {
    if (!isThinkingLevel(opts.thinking)) throw new Error("agent opts.thinking must be one of: off, minimal, low, medium, high, xhigh");
    out.thinking = opts.thinking;
  }

  if (opts.workspace !== undefined) {
    if (opts.workspace !== "shared" && opts.workspace !== "readOnly" && opts.workspace !== "patch") throw new Error("agent opts.workspace must be one of: shared, readOnly, patch");
    out.workspace = opts.workspace;
  }

  if (opts.stallMs !== undefined) {
    const stallMs = opts.stallMs;
    if (typeof stallMs !== "number" || !Number.isInteger(stallMs) || stallMs < WORKFLOW_AGENT_OPTION_LIMITS.stallMsMin || stallMs > WORKFLOW_AGENT_OPTION_LIMITS.stallMsMax) {
      throw new Error(`agent opts.stallMs must be an integer from ${WORKFLOW_AGENT_OPTION_LIMITS.stallMsMin} to ${WORKFLOW_AGENT_OPTION_LIMITS.stallMsMax}`);
    }
    out.stallMs = stallMs;
  }

  if (opts.schema !== undefined) out.schema = validateSchemaOption(opts.schema);
  return out;
}

function validateStringOption(value: unknown, key: "label" | "phase" | "model" | "agentType", maxBytes: number): string {
  if (typeof value !== "string") throw new Error(`agent opts.${key} must be a string`);
  if (value.trim() === "") throw new Error(`agent opts.${key} must be a non-empty string`);
  if (CONTROL_CHARS.test(value)) throw new Error(`agent opts.${key} must not contain control characters`);
  if (byteLength(value) > maxBytes) throw new Error(`agent opts.${key} exceeds ${maxBytes} bytes`);
  return value;
}

function validateSchemaOption(value: unknown): JsonObject {
  const state = { nodes: 0, seen: new WeakSet<object>() };
  const schema = cloneJsonValue(value, "agent opts.schema", 0, state);
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("agent opts.schema must be a JSON object");
  const text = JSON.stringify(schema);
  if (byteLength(text) > WORKFLOW_AGENT_OPTION_LIMITS.schemaBytes) throw new Error(`agent opts.schema exceeds ${WORKFLOW_AGENT_OPTION_LIMITS.schemaBytes} bytes`);
  return schema as JsonObject;
}

function cloneJsonValue(value: unknown, label: string, depth: number, state: { nodes: number; seen: WeakSet<object> }): JsonValue {
  state.nodes++;
  if (state.nodes > WORKFLOW_AGENT_OPTION_LIMITS.schemaNodes) throw new Error(`agent opts.schema exceeds ${WORKFLOW_AGENT_OPTION_LIMITS.schemaNodes} JSON nodes`);
  if (depth > WORKFLOW_AGENT_OPTION_LIMITS.schemaDepth) throw new Error(`agent opts.schema exceeds depth ${WORKFLOW_AGENT_OPTION_LIMITS.schemaDepth}`);

  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value as JsonValue;
  if (t === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return value as number;
  }
  if (t === "undefined" || t === "function" || t === "symbol" || t === "bigint") throw new Error(`${label} must be JSON-serializable`);

  if (Array.isArray(value)) {
    if (state.seen.has(value)) throw new Error("agent opts.schema must not contain cycles");
    state.seen.add(value);
    validateArrayShape(value, label);
    const out: JsonValue[] = [];
    for (let index = 0; index < value.length; index++) out.push(cloneJsonValue(value[index], `${label}[${index}]`, depth + 1, state));
    state.seen.delete(value);
    return out;
  }

  if (t === "object") {
    if (!isPlainObject(value)) throw new Error(`${label} must contain only plain JSON objects`);
    const object = value as Record<string, unknown>;
    if (state.seen.has(object)) throw new Error("agent opts.schema must not contain cycles");
    state.seen.add(object);
    const descriptors = Object.getOwnPropertyDescriptors(object) as Record<string, PropertyDescriptor>;
    const out: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(descriptors).sort(comparePropertyKeys)) {
      if (typeof key !== "string") throw new Error(`${label} must not contain symbol keys`);
      const descriptor = descriptors[key]!;
      if (descriptor.get || descriptor.set) throw new Error(`${label}.${key} must be a data property`);
      if (!descriptor.enumerable) throw new Error(`${label}.${key} must be enumerable`);
      Object.defineProperty(out, key, {
        value: cloneJsonValue(descriptor.value, `${label}.${key}`, depth + 1, state),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    state.seen.delete(object);
    return out;
  }

  throw new Error(`${label} contains an unsupported value type`);
}

function comparePropertyKeys(a: string | symbol, b: string | symbol): number {
  return String(a).localeCompare(String(b));
}

function validateArrayShape(value: unknown[], label: string): void {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error(`${label} must not contain sparse arrays`);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (typeof key === "string" && /^\d+$/.test(key)) {
      const descriptor = descriptors[key]!;
      if (descriptor.get || descriptor.set) throw new Error(`${label}[${key}] must be a data property`);
      if (!descriptor.enumerable) throw new Error(`${label}[${key}] must be enumerable`);
      continue;
    }
    throw new Error(`${label} arrays must not contain extra properties`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
