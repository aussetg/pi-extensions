import type {
  WorkflowDescriptorIdentity,
  WorkflowProductIdentity,
  WorkflowReferenceIdentity,
} from "../definition/workflow-language.js";
import {
  assertDescriptorIdentity,
  assertProductIdentity,
  assertReferenceIdentity,
} from "./control-authority.js";

export const WORKFLOW_CONTROL_PROTOCOL_VERSION = 17 as const;

export const WORKFLOW_ASYNC_FLOW_METHODS = Object.freeze([
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

export const WORKFLOW_SYNC_FLOW_METHODS = Object.freeze(["metrics"] as const);

export type WorkflowAsyncFlowMethod = (typeof WORKFLOW_ASYNC_FLOW_METHODS)[number];
export type WorkflowSyncFlowMethod = (typeof WORKFLOW_SYNC_FLOW_METHODS)[number];
export type WorkflowFlowMethod = WorkflowAsyncFlowMethod | WorkflowSyncFlowMethod;

const ASYNC_METHODS = new Set<string>(WORKFLOW_ASYNC_FLOW_METHODS);
const SYNC_METHODS = new Set<string>(WORKFLOW_SYNC_FLOW_METHODS);

export type WorkflowWireValue =
  | { type: "undefined" }
  | { type: "primitive"; value: null | boolean | number | string }
  | { type: "array"; values: WorkflowWireValue[] }
  | { type: "object"; entries: Array<[string, WorkflowWireValue]> }
  | { type: "callback"; id: string }
  | { type: "source-site"; sourceSite: string }
  | { type: "descriptor-ref"; id: string; identity: WorkflowDescriptorIdentity }
  | {
      type: "product";
      id: string;
      identity: WorkflowProductIdentity;
      fields: Array<[string, WorkflowWireValue]>;
    }
  | { type: "product-ref"; id: string; identity: WorkflowProductIdentity }
  | {
      type: "reference";
      id: string;
      identity: WorkflowReferenceIdentity;
      fields: Array<[string, WorkflowWireValue]>;
    }
  | { type: "reference-ref"; id: string; identity: WorkflowReferenceIdentity };

export interface WorkflowSerializedError {
  name: string;
  message: string;
  stack?: string;
  hostErrorId?: string;
  properties?: Record<string, null | boolean | number | string>;
}

export interface WorkflowControlDescriptorBinding {
  identity: WorkflowDescriptorIdentity;
  definition: WorkflowWireValue;
}

export interface WorkflowControlOperationSite {
  sourceSite: string;
  method: WorkflowFlowMethod;
}

type MessageOutcome =
  | { value: WorkflowWireValue; error?: never }
  | { value?: never; error: WorkflowSerializedError };

export type WorkflowControlProcessMessage =
  | { type: "initialized"; protocolVersion: 17 }
  | {
      type: "host-call";
      requestId: string;
      invocationId: string;
      method: WorkflowAsyncFlowMethod;
      args: WorkflowWireValue;
    }
  | {
      type: "sync-call";
      requestId: string;
      invocationId: string;
      method: WorkflowSyncFlowMethod;
      args: WorkflowWireValue;
    }
  | {
      type: "metric-call";
      requestId: string;
      invocationId: string;
      referenceId: string;
      method: "policy" | "summary" | "reachedTarget" | "evaluate";
      args: WorkflowWireValue;
    }
  | ({ type: "callback-result"; invocationId: string } & MessageOutcome)
  | ({ type: "done" } & MessageOutcome);

export type WorkflowHostProcessMessage =
  | {
      type: "initialize";
      protocolVersion: 17;
      runtimeApiHash: string;
      executableSource: string;
      workflowName: string;
      metadata: WorkflowWireValue;
      descriptors: WorkflowControlDescriptorBinding[];
      operationSites: WorkflowControlOperationSite[];
      args: WorkflowWireValue;
      snapshot?: WorkflowWireValue;
      segmentTimeoutMs: number;
      definitionOnly: boolean;
    }
  | ({ type: "host-response"; requestId: string } & MessageOutcome)
  | {
      type: "invoke-callback";
      invocationId: string;
      callbackId: string;
      args: WorkflowWireValue;
    };

export type WorkflowSyncResponseMessage = {
  type: "sync-response";
  requestId: string;
} & MessageOutcome;

export type WorkflowMetricResponseMessage = {
  type: "metric-response";
  requestId: string;
} & MessageOutcome;

export class WorkflowControlProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowControlProtocolError";
  }
}

export function parseWorkflowControlProcessMessage(value: unknown): WorkflowControlProcessMessage {
  const message = requireRecord(value, "workflow v17 control message");
  if (message.type === "initialized") {
    assertKeys(message, ["type", "protocolVersion"], "initialized message");
    if (message.protocolVersion !== WORKFLOW_CONTROL_PROTOCOL_VERSION) {
      throw new WorkflowControlProtocolError("Workflow v17 control protocol version is invalid");
    }
    return { type: "initialized", protocolVersion: WORKFLOW_CONTROL_PROTOCOL_VERSION };
  }
  if (message.type === "host-call") {
    assertKeys(message, ["type", "requestId", "invocationId", "method", "args"], "host-call message");
    if (typeof message.method !== "string" || !ASYNC_METHODS.has(message.method)) {
      throw new WorkflowControlProtocolError(`Unknown workflow v17 async method ${String(message.method)}`);
    }
    return {
      type: "host-call",
      requestId: requireId(message.requestId, "host request"),
      invocationId: requireId(message.invocationId, "control invocation"),
      method: message.method as WorkflowAsyncFlowMethod,
      args: requireWire(message.args),
    };
  }
  if (message.type === "sync-call") {
    assertKeys(message, ["type", "requestId", "invocationId", "method", "args"], "sync-call message");
    if (typeof message.method !== "string" || !SYNC_METHODS.has(message.method)) {
      throw new WorkflowControlProtocolError(`Unknown workflow v17 synchronous method ${String(message.method)}`);
    }
    return {
      type: "sync-call",
      requestId: requireId(message.requestId, "synchronous request"),
      invocationId: requireId(message.invocationId, "control invocation"),
      method: message.method as WorkflowSyncFlowMethod,
      args: requireWire(message.args),
    };
  }
  if (message.type === "metric-call") {
    assertKeys(
      message,
      ["type", "requestId", "invocationId", "referenceId", "method", "args"],
      "metric-call message",
    );
    if (typeof message.method !== "string"
      || !["policy", "summary", "reachedTarget", "evaluate"].includes(message.method)) {
      throw new WorkflowControlProtocolError(`Unknown workflow v17 metric-set method ${String(message.method)}`);
    }
    return {
      type: "metric-call",
      requestId: requireId(message.requestId, "metric request"),
      invocationId: requireId(message.invocationId, "control invocation"),
      referenceId: requireId(message.referenceId, "metric reference"),
      method: message.method as "policy" | "summary" | "reachedTarget" | "evaluate",
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
  throw new WorkflowControlProtocolError(`Unknown workflow v17 control message ${String(message.type)}`);
}

export function parseWorkflowDescriptorIdentity(value: unknown): WorkflowDescriptorIdentity {
  try {
    assertDescriptorIdentity(value as WorkflowDescriptorIdentity);
    return structuredClone(value) as WorkflowDescriptorIdentity;
  } catch {
    throw new WorkflowControlProtocolError("Workflow v17 descriptor wire identity is invalid");
  }
}

export function parseWorkflowProductIdentity(value: unknown): WorkflowProductIdentity {
  try {
    assertProductIdentity(value as WorkflowProductIdentity);
    return structuredClone(value) as WorkflowProductIdentity;
  } catch {
    throw new WorkflowControlProtocolError("Workflow v17 product wire identity is invalid");
  }
}

export function parseWorkflowReferenceIdentity(value: unknown): WorkflowReferenceIdentity {
  try {
    assertReferenceIdentity(value as WorkflowReferenceIdentity);
    return structuredClone(value) as WorkflowReferenceIdentity;
  } catch {
    throw new WorkflowControlProtocolError("Workflow v17 reference wire identity is invalid");
  }
}

export function sameWorkflowWireIdentity(left: unknown, right: unknown): boolean {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  return Object.keys(leftRecord).length === Object.keys(rightRecord).length
    && Object.entries(leftRecord).every(([key, value]) => rightRecord[key] === value);
}

function parseSerializedError(value: unknown): WorkflowSerializedError {
  const error = requireRecord(value, "workflow v17 control error");
  const allowed = new Set(["name", "message", "stack", "hostErrorId", "properties"]);
  for (const key of Object.keys(error)) {
    if (!allowed.has(key)) throw new WorkflowControlProtocolError(`Workflow v17 control error has unknown field ${key}`);
  }
  const name = boundedString(error.name, "control error name", 256);
  const message = boundedString(error.message, "control error message", 16_000, true);
  const stack = error.stack === undefined ? undefined : boundedString(error.stack, "control error stack", 32_000, true);
  const hostErrorId = error.hostErrorId === undefined ? undefined : requireId(error.hostErrorId, "host error");
  let properties: WorkflowSerializedError["properties"];
  if (error.properties !== undefined) {
    const raw = requireRecord(error.properties, "workflow v17 control error properties");
    properties = {};
    for (const [key, property] of Object.entries(raw)) {
      if (!["status", "operationPath", "expected", "actual", "attentionKind", "branchFailureKind", "point", "classification"].includes(key)) {
        throw new WorkflowControlProtocolError(`Workflow v17 control error property ${key} is unavailable`);
      }
      if (property !== null && typeof property !== "boolean" && typeof property !== "string"
        && (typeof property !== "number" || !Number.isFinite(property) || Object.is(property, -0))) {
        throw new WorkflowControlProtocolError(`Workflow v17 control error property ${key} is invalid`);
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
  if (hasValue === hasError) throw new WorkflowControlProtocolError(`${label} requires exactly one outcome`);
  assertKeys(message, [...base, hasError ? "error" : "value"], label);
}

function assertKeys(value: object, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new WorkflowControlProtocolError(`${label} has unexpected fields`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowControlProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireWire(value: unknown): WorkflowWireValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowControlProtocolError("Workflow v17 wire value is invalid");
  }
  return value as WorkflowWireValue;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[a-z][a-z0-9-]{0,127}$/u.test(value)) {
    throw new WorkflowControlProtocolError(`Invalid workflow v17 ${label} id`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maximum: number, empty = false): string {
  if (typeof value !== "string" || (!empty && value.length === 0) || Buffer.byteLength(value) > maximum) {
    throw new WorkflowControlProtocolError(`Workflow v17 ${label} is invalid`);
  }
  return value;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
