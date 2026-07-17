import type {
  WorkflowV17DescriptorIdentity,
  WorkflowV17ProductIdentity,
  WorkflowV17ReferenceIdentity,
} from "../definition/workflow-language-v17.js";
import {
  assertDescriptorIdentity,
  assertProductIdentity,
  assertReferenceIdentity,
} from "./control-authority-v17.js";

export const WORKFLOW_V17_CONTROL_PROTOCOL_VERSION = 17 as const;

export const WORKFLOW_V17_ASYNC_FLOW_METHODS = Object.freeze([
  "parallel",
  "map",
  "agent",
  "command",
  "ask",
  "measure",
  "candidate",
  "verify",
  "accept",
  "reject",
  "recordExperiment",
  "apply",
] as const);

export const WORKFLOW_V17_SYNC_FLOW_METHODS = Object.freeze(["metrics"] as const);

export type WorkflowV17AsyncFlowMethod = (typeof WORKFLOW_V17_ASYNC_FLOW_METHODS)[number];
export type WorkflowV17SyncFlowMethod = (typeof WORKFLOW_V17_SYNC_FLOW_METHODS)[number];
export type WorkflowV17FlowMethod = WorkflowV17AsyncFlowMethod | WorkflowV17SyncFlowMethod;

const ASYNC_METHODS = new Set<string>(WORKFLOW_V17_ASYNC_FLOW_METHODS);
const SYNC_METHODS = new Set<string>(WORKFLOW_V17_SYNC_FLOW_METHODS);

export type WorkflowV17WireValue =
  | { type: "undefined" }
  | { type: "primitive"; value: null | boolean | number | string }
  | { type: "array"; values: WorkflowV17WireValue[] }
  | { type: "object"; entries: Array<[string, WorkflowV17WireValue]> }
  | { type: "callback"; id: string }
  | { type: "source-site"; sourceSite: string }
  | { type: "descriptor-ref"; id: string; identity: WorkflowV17DescriptorIdentity }
  | {
      type: "product";
      id: string;
      identity: WorkflowV17ProductIdentity;
      fields: Array<[string, WorkflowV17WireValue]>;
    }
  | { type: "product-ref"; id: string; identity: WorkflowV17ProductIdentity }
  | {
      type: "reference";
      id: string;
      identity: WorkflowV17ReferenceIdentity;
      fields: Array<[string, WorkflowV17WireValue]>;
    }
  | { type: "reference-ref"; id: string; identity: WorkflowV17ReferenceIdentity };

export interface WorkflowV17SerializedError {
  name: string;
  message: string;
  stack?: string;
  hostErrorId?: string;
  properties?: Record<string, null | boolean | number | string>;
}

export interface WorkflowV17ControlDescriptorBinding {
  identity: WorkflowV17DescriptorIdentity;
  definition: WorkflowV17WireValue;
}

export interface WorkflowV17ControlOperationSite {
  sourceSite: string;
  method: WorkflowV17FlowMethod;
}

type MessageOutcome =
  | { value: WorkflowV17WireValue; error?: never }
  | { value?: never; error: WorkflowV17SerializedError };

export type WorkflowV17ControlProcessMessage =
  | { type: "initialized"; protocolVersion: 17 }
  | {
      type: "host-call";
      requestId: string;
      invocationId: string;
      method: WorkflowV17AsyncFlowMethod;
      args: WorkflowV17WireValue;
    }
  | {
      type: "sync-call";
      requestId: string;
      invocationId: string;
      method: WorkflowV17SyncFlowMethod;
      args: WorkflowV17WireValue;
    }
  | ({ type: "callback-result"; invocationId: string } & MessageOutcome)
  | ({ type: "done" } & MessageOutcome);

export type WorkflowV17HostProcessMessage =
  | {
      type: "initialize";
      protocolVersion: 17;
      runtimeApiHash: string;
      executableSource: string;
      workflowName: string;
      metadata: WorkflowV17WireValue;
      descriptors: WorkflowV17ControlDescriptorBinding[];
      operationSites: WorkflowV17ControlOperationSite[];
      args: WorkflowV17WireValue;
      snapshot?: WorkflowV17WireValue;
      segmentTimeoutMs: number;
      definitionOnly: boolean;
    }
  | ({ type: "host-response"; requestId: string } & MessageOutcome)
  | {
      type: "invoke-callback";
      invocationId: string;
      callbackId: string;
      args: WorkflowV17WireValue;
    };

export type WorkflowV17SyncResponseMessage = {
  type: "sync-response";
  requestId: string;
} & MessageOutcome;

export class WorkflowV17ControlProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowV17ControlProtocolError";
  }
}

export function parseWorkflowV17ControlProcessMessage(value: unknown): WorkflowV17ControlProcessMessage {
  const message = requireRecord(value, "workflow v17 control message");
  if (message.type === "initialized") {
    assertKeys(message, ["type", "protocolVersion"], "initialized message");
    if (message.protocolVersion !== WORKFLOW_V17_CONTROL_PROTOCOL_VERSION) {
      throw new WorkflowV17ControlProtocolError("Workflow v17 control protocol version is invalid");
    }
    return { type: "initialized", protocolVersion: WORKFLOW_V17_CONTROL_PROTOCOL_VERSION };
  }
  if (message.type === "host-call") {
    assertKeys(message, ["type", "requestId", "invocationId", "method", "args"], "host-call message");
    if (typeof message.method !== "string" || !ASYNC_METHODS.has(message.method)) {
      throw new WorkflowV17ControlProtocolError(`Unknown workflow v17 async method ${String(message.method)}`);
    }
    return {
      type: "host-call",
      requestId: requireId(message.requestId, "host request"),
      invocationId: requireId(message.invocationId, "control invocation"),
      method: message.method as WorkflowV17AsyncFlowMethod,
      args: requireWire(message.args),
    };
  }
  if (message.type === "sync-call") {
    assertKeys(message, ["type", "requestId", "invocationId", "method", "args"], "sync-call message");
    if (typeof message.method !== "string" || !SYNC_METHODS.has(message.method)) {
      throw new WorkflowV17ControlProtocolError(`Unknown workflow v17 synchronous method ${String(message.method)}`);
    }
    return {
      type: "sync-call",
      requestId: requireId(message.requestId, "synchronous request"),
      invocationId: requireId(message.invocationId, "control invocation"),
      method: message.method as WorkflowV17SyncFlowMethod,
      args: requireWire(message.args),
    };
  }
  if (message.type === "callback-result") {
    assertOutcomeKeys(message, ["type", "invocationId"], "callback-result message");
    const base = {
      type: "callback-result" as const,
      invocationId: requireId(message.invocationId, "callback invocation"),
    };
    return hasOwn(message, "error")
      ? { ...base, error: parseSerializedError(message.error) }
      : { ...base, value: requireWire(message.value) };
  }
  if (message.type === "done") {
    assertOutcomeKeys(message, ["type"], "done message");
    return hasOwn(message, "error")
      ? { type: "done", error: parseSerializedError(message.error) }
      : { type: "done", value: requireWire(message.value) };
  }
  throw new WorkflowV17ControlProtocolError(`Unknown workflow v17 control message ${String(message.type)}`);
}

export function parseWorkflowV17DescriptorIdentity(value: unknown): WorkflowV17DescriptorIdentity {
  try {
    assertDescriptorIdentity(value as WorkflowV17DescriptorIdentity);
    return structuredClone(value) as WorkflowV17DescriptorIdentity;
  } catch {
    throw new WorkflowV17ControlProtocolError("Workflow v17 descriptor wire identity is invalid");
  }
}

export function parseWorkflowV17ProductIdentity(value: unknown): WorkflowV17ProductIdentity {
  try {
    assertProductIdentity(value as WorkflowV17ProductIdentity);
    return structuredClone(value) as WorkflowV17ProductIdentity;
  } catch {
    throw new WorkflowV17ControlProtocolError("Workflow v17 product wire identity is invalid");
  }
}

export function parseWorkflowV17ReferenceIdentity(value: unknown): WorkflowV17ReferenceIdentity {
  try {
    assertReferenceIdentity(value as WorkflowV17ReferenceIdentity);
    return structuredClone(value) as WorkflowV17ReferenceIdentity;
  } catch {
    throw new WorkflowV17ControlProtocolError("Workflow v17 reference wire identity is invalid");
  }
}

export function sameWorkflowV17WireIdentity(left: unknown, right: unknown): boolean {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  return Object.keys(leftRecord).length === Object.keys(rightRecord).length
    && Object.entries(leftRecord).every(([key, value]) => rightRecord[key] === value);
}

function parseSerializedError(value: unknown): WorkflowV17SerializedError {
  const error = requireRecord(value, "workflow v17 control error");
  const allowed = new Set(["name", "message", "stack", "hostErrorId", "properties"]);
  for (const key of Object.keys(error)) {
    if (!allowed.has(key)) throw new WorkflowV17ControlProtocolError(`Workflow v17 control error has unknown field ${key}`);
  }
  const name = boundedString(error.name, "control error name", 256);
  const message = boundedString(error.message, "control error message", 16_000, true);
  const stack = error.stack === undefined ? undefined : boundedString(error.stack, "control error stack", 32_000, true);
  const hostErrorId = error.hostErrorId === undefined ? undefined : requireId(error.hostErrorId, "host error");
  let properties: WorkflowV17SerializedError["properties"];
  if (error.properties !== undefined) {
    const raw = requireRecord(error.properties, "workflow v17 control error properties");
    properties = {};
    for (const [key, property] of Object.entries(raw)) {
      if (!["status", "operationPath", "expected", "actual", "attentionKind", "branchFailureKind", "point", "classification"].includes(key)) {
        throw new WorkflowV17ControlProtocolError(`Workflow v17 control error property ${key} is unavailable`);
      }
      if (property !== null && typeof property !== "boolean" && typeof property !== "string"
        && (typeof property !== "number" || !Number.isFinite(property) || Object.is(property, -0))) {
        throw new WorkflowV17ControlProtocolError(`Workflow v17 control error property ${key} is invalid`);
      }
      properties[key] = typeof property === "string"
        ? boundedString(property, `control error property ${key}`, 16_000, true)
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

function assertOutcomeKeys(message: Record<string, unknown>, base: string[], label: string): void {
  const hasValue = hasOwn(message, "value");
  const hasError = hasOwn(message, "error");
  if (hasValue === hasError) throw new WorkflowV17ControlProtocolError(`${label} requires exactly one outcome`);
  assertKeys(message, [...base, hasError ? "error" : "value"], label);
}

function assertKeys(value: object, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new WorkflowV17ControlProtocolError(`${label} has unexpected fields`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowV17ControlProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireWire(value: unknown): WorkflowV17WireValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowV17ControlProtocolError("Workflow v17 wire value is invalid");
  }
  return value as WorkflowV17WireValue;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[a-z][a-z0-9-]{0,127}$/u.test(value)) {
    throw new WorkflowV17ControlProtocolError(`Invalid workflow v17 ${label} id`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maximum: number, empty = false): string {
  if (typeof value !== "string" || (!empty && value.length === 0) || Buffer.byteLength(value) > maximum) {
    throw new WorkflowV17ControlProtocolError(`Workflow v17 ${label} is invalid`);
  }
  return value;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
