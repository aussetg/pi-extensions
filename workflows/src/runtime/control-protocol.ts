export const CONTROL_PROTOCOL_VERSION = 1 as const;

export const ASYNC_FLOW_METHODS = [
  "stage",
  "loop",
  "parallel",
  "fanOut",
  "agent",
  "command",
  "checkpoint",
  "measure",
  "candidate",
  "verify",
  "accept",
  "reject",
  "recordExperiment",
  "apply",
] as const;

export type AsyncFlowMethod = (typeof ASYNC_FLOW_METHODS)[number];
const ASYNC_FLOW_METHOD_SET = new Set<string>(ASYNC_FLOW_METHODS);

export type WireValue =
  | { type: "undefined" }
  | { type: "primitive"; value: null | boolean | number | string }
  | { type: "array"; values: WireValue[] }
  | { type: "object"; entries: Array<[string, WireValue]> }
  | { type: "host-ref"; id: string }
  | { type: "metric-ref"; id: string; state?: WireValue }
  | { type: "callback"; id: string };

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  hostErrorId?: string;
  properties?: Record<string, null | boolean | number | string>;
}

export type MetricStateUpdate = { id: string; state: WireValue };

type MessageOutcome =
  | { value: WireValue; error?: never }
  | { value?: never; error: SerializedError };

export type ControlProcessMessage =
  | { type: "initialized"; protocolVersion: 1 }
  | { type: "host-call"; requestId: string; invocationId: string; method: AsyncFlowMethod; args: WireValue }
  | { type: "metric-call"; requestId: string; invocationId: string; args: WireValue }
  | ({ type: "callback-result"; invocationId: string } & MessageOutcome)
  | ({ type: "done" } & MessageOutcome);

export type HostProcessMessage =
  | {
      type: "initialize";
      protocolVersion: 1;
      executableSource: string;
      workflowName: string;
      args: WireValue;
      snapshot?: WireValue;
      segmentTimeoutMs: number;
      definitionOnly: boolean;
    }
  | ({ type: "host-response"; requestId: string; metricStates: MetricStateUpdate[] } & MessageOutcome)
  | { type: "invoke-callback"; invocationId: string; callbackId: string; args: WireValue };

export type MetricResponseMessage = { type: "metric-response"; requestId: string } & MessageOutcome;

export class ControlProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlProtocolError";
  }
}

export function parseControlProcessMessage(value: unknown): ControlProcessMessage {
  const message = requireRecord(value, "workflow control message");
  const type = message.type;
  if (type === "initialized") {
    assertProtocolKeys(message, ["type", "protocolVersion"], "initialized message");
    if (message.protocolVersion !== CONTROL_PROTOCOL_VERSION) throw new ControlProtocolError("Workflow control protocol version is invalid");
    return { type, protocolVersion: CONTROL_PROTOCOL_VERSION };
  }
  if (type === "host-call") {
    assertProtocolKeys(message, ["type", "requestId", "invocationId", "method", "args"], "host-call message");
    const method = message.method;
    if (typeof method !== "string" || !ASYNC_FLOW_METHOD_SET.has(method)) {
      throw new ControlProtocolError(`Unknown workflow host method ${String(method)}`);
    }
    return {
      type,
      requestId: requireProtocolId(message.requestId, "host request"),
      invocationId: requireProtocolId(message.invocationId, "control invocation"),
      method: method as AsyncFlowMethod,
      args: requireWire(message.args),
    };
  }
  if (type === "metric-call") {
    assertProtocolKeys(message, ["type", "requestId", "invocationId", "args"], "metric-call message");
    return {
      type,
      requestId: requireProtocolId(message.requestId, "metric request"),
      invocationId: requireProtocolId(message.invocationId, "control invocation"),
      args: requireWire(message.args),
    };
  }
  if (type === "callback-result") {
    assertOutcomeKeys(message, ["type", "invocationId"], "callback-result message");
    const base = { type, invocationId: requireProtocolId(message.invocationId, "callback invocation") } as const;
    return hasOwn(message, "error")
      ? { ...base, error: parseSerializedError(message.error) }
      : { ...base, value: requireWire(message.value) };
  }
  if (type === "done") {
    assertOutcomeKeys(message, ["type"], "done message");
    return hasOwn(message, "error")
      ? { type, error: parseSerializedError(message.error) }
      : { type, value: requireWire(message.value) };
  }
  throw new ControlProtocolError(`Unknown workflow control message ${String(type)}`);
}

export function assertProtocolKeys(value: object, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ControlProtocolError(`${label} has unexpected fields`);
  }
}

export function requireProtocolId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[a-z0-9-]+$/.test(value)) {
    throw new ControlProtocolError(`Invalid ${label} id`);
  }
  return value;
}

function assertOutcomeKeys(message: Record<string, unknown>, base: string[], label: string): void {
  const hasValue = hasOwn(message, "value");
  const hasError = hasOwn(message, "error");
  if (hasValue === hasError) throw new ControlProtocolError(`${label} requires exactly one outcome`);
  assertProtocolKeys(message, [...base, hasError ? "error" : "value"], label);
}

function parseSerializedError(value: unknown): SerializedError {
  const error = requireRecord(value, "workflow control error");
  const allowed = ["name", "message", "stack", "hostErrorId", "properties"];
  for (const key of Object.keys(error)) {
    if (!allowed.includes(key)) throw new ControlProtocolError(`Workflow control error contains unknown field ${key}`);
  }
  const name = boundedString(error.name, "workflow control error name", 256);
  const message = boundedString(error.message, "workflow control error message", 16_000, true);
  const stack = error.stack === undefined ? undefined : boundedString(error.stack, "workflow control error stack", 32_000, true);
  const hostErrorId = error.hostErrorId === undefined ? undefined : requireProtocolId(error.hostErrorId, "host error");
  let properties: SerializedError["properties"];
  if (error.properties !== undefined) {
    const raw = requireRecord(error.properties, "workflow control error properties");
    properties = Object.create(null) as NonNullable<SerializedError["properties"]>;
    for (const key of Object.keys(raw)) {
      if (!["status", "operationPath", "expected", "actual", "attentionKind", "branchFailureKind", "point", "classification"].includes(key)) {
        throw new ControlProtocolError(`Workflow control error property ${key} is unavailable`);
      }
      const property = raw[key];
      if (
        property !== null && typeof property !== "boolean" && typeof property !== "string" &&
        (typeof property !== "number" || !Number.isFinite(property) || Object.is(property, -0))
      ) throw new ControlProtocolError(`Workflow control error property ${key} is invalid`);
      properties[key] = typeof property === "string"
        ? boundedString(property, `workflow control error property ${key}`, 16_000, true)
        : property;
    }
  }
  return {
    name,
    message,
    ...(stack !== undefined ? { stack } : {}),
    ...(hostErrorId !== undefined ? { hostErrorId } : {}),
    ...(properties !== undefined ? { properties } : {}),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControlProtocolError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireWire(value: unknown): WireValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControlProtocolError("Workflow control wire value is invalid");
  return value as WireValue;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function boundedString(value: unknown, label: string, maximum: number, empty = false): string {
  if (typeof value !== "string" || (!empty && value.length === 0) || Buffer.byteLength(value) > maximum) {
    throw new ControlProtocolError(`${label} is invalid`);
  }
  return value;
}
