import fs from "node:fs";
import vm from "node:vm";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  isImprovement,
  isWithinGuardrail,
  metricSummary,
  needsImprovement,
  normalizeMetricState,
  reachesTarget,
} from "./control-worker-metrics.js";
import { createControlRealm } from "./control-realm.js";

const CONTROL_PROTOCOL_VERSION = 1;
const CONTROL_WIRE_BYTES = 4 * 1024 * 1024;
const CONTROL_WIRE_DEPTH = 48;
const CONTROL_WIRE_NODES = 50_000;
const CONTROL_SOURCE_BYTES = CONTROL_WIRE_BYTES;
const ASYNC_FLOW_METHODS = Object.freeze([
  "stage", "loop", "parallel", "fanOut", "agent", "command", "checkpoint", "measure", "candidate",
  "verify", "accept", "reject", "recordExperiment", "apply",
]);

const callbacks = new Map();
const callbackIds = new WeakMap();
const pendingHostCalls = new Map();
const remoteReferences = new Map();
const remoteReferenceIds = new WeakMap();
const metricStates = new Map();
const metricHandles = new Map();
const metricHandleIds = new WeakMap();
const invocation = new AsyncLocalStorage();
let nextCallback = 1;
let nextRequest = 1;
let configuration;
let controlRealm;
let syncBuffer = "";
let phase = "awaiting-initialize";
let finished = false;

process.on("message", (message) => {
  if (finished) return;
  try {
    if (phase === "awaiting-initialize") {
      configuration = parseInitializeMessage(message);
      phase = "running";
      send({ type: "initialized", protocolVersion: CONTROL_PROTOCOL_VERSION });
      startControl();
      return;
    }
    const parsed = parseRunningMessage(message);
    if (parsed.type === "host-response") {
      applyMetricStates(parsed.metricStates);
      const pending = pendingHostCalls.get(parsed.requestId);
      if (!pending) throw new Error(`Unknown workflow host response ${parsed.requestId}`);
      pendingHostCalls.delete(parsed.requestId);
      if (parsed.error !== undefined) pending.reject(deserializeError(parsed.error));
      else pending.resolve(decodeWire(parsed.value));
      return;
    }
    void invokeCallback(parsed);
  } catch (error) {
    finish({ type: "done", error: serializeError(error) });
  }
});

process.on("uncaughtException", (error) => finish({ type: "done", error: serializeError(error) }));
process.on("unhandledRejection", (error) => finish({ type: "done", error: serializeError(error) }));

function parseInitializeMessage(value) {
  const message = requireRecord(value, "workflow initialize message");
  if (message.type !== "initialize") throw new Error(`Expected one workflow initialize message, received ${String(message.type)}`);
  const keys = ["type", "protocolVersion", "executableSource", "workflowName", "args", "segmentTimeoutMs", "definitionOnly"];
  if (message.snapshot !== undefined) keys.push("snapshot");
  assertExactKeys(message, keys, "workflow initialize message");
  if (message.protocolVersion !== CONTROL_PROTOCOL_VERSION) throw new Error("Workflow control protocol version is invalid");
  if (
    typeof message.executableSource !== "string" || Buffer.byteLength(message.executableSource) < 1 ||
    Buffer.byteLength(message.executableSource) > CONTROL_SOURCE_BYTES
  ) throw new Error("Workflow control source exceeds its structural limit");
  if (typeof message.workflowName !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(message.workflowName)) {
    throw new Error("Workflow control name is invalid");
  }
  if (!Number.isSafeInteger(message.segmentTimeoutMs) || message.segmentTimeoutMs < 25 || message.segmentTimeoutMs > 10_000) {
    throw new Error("Workflow control segment timeout is invalid");
  }
  if (typeof message.definitionOnly !== "boolean") throw new Error("Workflow definition-only flag is invalid");
  requireWire(message.args);
  if (message.snapshot !== undefined) requireWire(message.snapshot);
  return Object.freeze({
    executableSource: message.executableSource,
    workflowName: message.workflowName,
    args: message.args,
    ...(message.snapshot !== undefined ? { snapshot: message.snapshot } : {}),
    segmentTimeoutMs: message.segmentTimeoutMs,
    definitionOnly: message.definitionOnly,
  });
}

function parseRunningMessage(value) {
  const message = requireRecord(value, "workflow host message");
  if (message.type === "host-response") {
    assertOutcomeKeys(message, ["type", "requestId", "metricStates"], "host-response message");
    if (!Array.isArray(message.metricStates)) throw new Error("Workflow metric state updates are invalid");
    const base = {
      type: "host-response",
      requestId: requireId(message.requestId, "host request"),
      metricStates: message.metricStates,
    };
    return Object.prototype.hasOwnProperty.call(message, "error")
      ? { ...base, error: parseSerializedError(message.error) }
      : { ...base, value: requireWire(message.value) };
  }
  if (message.type === "invoke-callback") {
    assertExactKeys(message, ["type", "invocationId", "callbackId", "args"], "invoke-callback message");
    return {
      type: "invoke-callback",
      invocationId: requireId(message.invocationId, "callback invocation"),
      callbackId: requireId(message.callbackId, "callback"),
      args: requireWire(message.args),
    };
  }
  throw new Error(`Unknown workflow host message ${String(message.type)}`);
}

function hardenContext(context) {
  const lockdown = new vm.Script(`
    (() => {
      "use strict";
      Object.defineProperty(Math, "random", { value: undefined, writable: false, configurable: false });
      for (const name of [
        "Date", "Intl", "Temporal", "performance", "fetch", "XMLHttpRequest", "WebSocket", "EventSource",
        "navigator", "crypto", "console", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
        "setImmediate", "clearImmediate", "queueMicrotask", "Proxy", "Reflect", "WeakRef", "FinalizationRegistry",
        "Atomics", "ArrayBuffer", "SharedArrayBuffer", "DataView", "Uint8Array", "Uint8ClampedArray", "Uint16Array",
        "Uint32Array", "Int8Array", "Int16Array", "Int32Array", "Float32Array", "Float64Array", "BigInt64Array",
        "BigUint64Array", "WebAssembly", "Blob", "File", "structuredClone",
      ]) Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
      const freeze = Object.freeze;
      const values = [
        Object, Function, Array, Boolean, Number, String, BigInt, Symbol, RegExp,
        Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError,
        Map, Set, WeakMap, WeakSet, Promise,
        Object.prototype, Function.prototype, Array.prototype, Boolean.prototype, Number.prototype,
        String.prototype, BigInt.prototype, Symbol.prototype, RegExp.prototype, Error.prototype,
        Map.prototype, Set.prototype, WeakMap.prototype, WeakSet.prototype, Promise.prototype,
        Object.getPrototypeOf(async function () {}), Math, JSON,
      ];
      for (const value of values) if (value && !Object.isFrozen(value)) freeze(value);
    })();
  `, { filename: "workflow-control-lockdown.js" });
  lockdown.runInContext(context, { timeout: 1_000 });
}

function startControl() {
  const sandbox = Object.create(null);
  const context = vm.createContext(sandbox, {
    name: "pi-structured-workflow-control",
    codeGeneration: { strings: false, wasm: false },
  });
  hardenContext(context);
  controlRealm = createControlRealm(context, {
    asyncMethods: ASYNC_FLOW_METHODS,
    hostCall: bridgeHostCall,
    hostMetric: bridgeHostMetric,
    metricCall: bridgeMetricCall,
  });
  const args = deepFreeze(decodeWire(configuration.args));
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Workflow control arguments must be an object");
  const snapshot = configuration.snapshot === undefined ? undefined : deepFreeze(decodeWire(configuration.snapshot));
  const flow = controlRealm.createFlow(snapshot !== undefined, snapshot);
  Object.defineProperties(sandbox, {
    __flowHostApi: { value: flow, writable: false, enumerable: false },
    __flowHostArgs: { value: args, writable: false, enumerable: false },
    __flowHostSnapshot: { value: snapshot, writable: false, enumerable: false },
  });
  const wrapper = `
(async () => {
  "use strict";
  const __flowDeepFreeze = (value, seen = new Set()) => {
    if (!value || typeof value !== "object" || seen.has(value)) return value;
    seen.add(value);
    for (const key of Object.keys(value)) __flowDeepFreeze(value[key], seen);
    return Object.freeze(value);
  };
  const defineWorkflow = (definition) => __flowDeepFreeze(definition);
  const globalThis = undefined;
  const global = undefined;
  const process = undefined;
  const require = undefined;
  const module = undefined;
  const exports = undefined;
  const Buffer = undefined;
  const fetch = undefined;
  const XMLHttpRequest = undefined;
  const WebSocket = undefined;
  const EventSource = undefined;
  const navigator = undefined;
  const crypto = undefined;
  const console = undefined;
  const performance = undefined;
  const Date = undefined;
  const Intl = undefined;
  const Temporal = undefined;
  const setTimeout = undefined;
  const clearTimeout = undefined;
  const setInterval = undefined;
  const clearInterval = undefined;
  const setImmediate = undefined;
  const clearImmediate = undefined;
  const queueMicrotask = undefined;
  const Proxy = undefined;
  const Reflect = undefined;
  const WeakRef = undefined;
  const FinalizationRegistry = undefined;
  const Atomics = undefined;
  const ArrayBuffer = undefined;
  const SharedArrayBuffer = undefined;
  const DataView = undefined;
  const Uint8Array = undefined;
  const Uint8ClampedArray = undefined;
  const Uint16Array = undefined;
  const Uint32Array = undefined;
  const Int8Array = undefined;
  const Int16Array = undefined;
  const Int32Array = undefined;
  const Float32Array = undefined;
  const Float64Array = undefined;
  const BigInt64Array = undefined;
  const BigUint64Array = undefined;
  const WebAssembly = undefined;
  const Blob = undefined;
  const File = undefined;
  const structuredClone = undefined;
  ${configuration.executableSource}
  if (!__flowDefinition || typeof __flowDefinition.run !== "function") throw new Error("Invalid defineWorkflow result");
  if (__flowDefinition.name !== ${JSON.stringify(configuration.workflowName)}) throw new Error("Loaded workflow name does not match its binding");
  if (${configuration.definitionOnly === true ? "true" : "false"}) {
    return { loaded: true, name: __flowDefinition.name };
  }
  return await (0, __flowDefinition.run)(__flowHostApi, __flowHostArgs);
})()
`;
  try {
    const script = new vm.Script(wrapper, { filename: `${configuration.workflowName}.flow.js` });
    const execution = invocation.run("root", () => script.runInContext(context, { timeout: configuration.segmentTimeoutMs }));
    Promise.resolve(execution).then(
      (value) => finish({ type: "done", value: encodeWire(value) }),
      (error) => finish({ type: "done", error: serializeError(error) }),
    );
  } catch (error) {
    finish({ type: "done", error: serializeError(error) });
  }
}

function callHost(method, args) {
  const invocationId = currentInvocation();
  const requestId = `request-${nextRequest++}`;
  const result = new Promise((resolve, reject) => pendingHostCalls.set(requestId, { resolve, reject }));
  send({ type: "host-call", requestId, invocationId, method, args: encodeWire(args) });
  return result;
}

async function bridgeHostCall(method, args) {
  try {
    if (!ASYNC_FLOW_METHODS.includes(method) || !Array.isArray(args)) throw new Error("Invalid workflow host call");
    return await callHost(method, args);
  } catch (error) {
    throw controlRealm.createError(serializeError(error));
  }
}

function callMetric(args) {
  const invocationId = currentInvocation();
  const requestId = `request-${nextRequest++}`;
  send({ type: "metric-call", requestId, invocationId, args: encodeWire(args) });
  const received = parseMetricResponse(readSyncResponse());
  if (received.requestId !== requestId) throw new Error("Synchronous metric response request is invalid");
  if (received.error !== undefined) throw deserializeError(received.error);
  return decodeWire(received.value);
}

function bridgeHostMetric(args) {
  try {
    if (!Array.isArray(args)) throw new Error("Invalid workflow metric call");
    return callMetric(args);
  } catch (error) {
    throw controlRealm.createError(serializeError(error));
  }
}

function bridgeMetricCall(id, method, args) {
  try {
    const state = metricStates.get(id);
    if (!state) throw new Error("Metric state is unavailable");
    if (!Array.isArray(args)) throw new Error("Invalid metric method arguments");
    let value;
    switch (method) {
      case "baseline":
      case "current":
      case "best":
      case "relativeGain":
        if (args.length !== 0) throw new Error(`Metric ${method} does not accept arguments`);
        value = state[method];
        break;
      case "reachesTarget":
        if (args.length !== 0) throw new Error("Metric reachesTarget does not accept arguments");
        value = reachesTarget(state);
        break;
      case "needsImprovement":
        if (args.length !== 0) throw new Error("Metric needsImprovement does not accept arguments");
        value = needsImprovement(state);
        break;
      case "isImprovement":
        if (args.length !== 1) throw new Error("Metric isImprovement requires one observation");
        value = isImprovement(state, args[0]);
        break;
      case "isWithinGuardrail":
        if (args.length !== 1) throw new Error("Metric isWithinGuardrail requires one observation");
        value = isWithinGuardrail(state, args[0]);
        break;
      case "summary":
        if (args.length !== 0) throw new Error("Metric summary does not accept arguments");
        value = metricSummary(state);
        break;
      default:
        throw new Error(`Unknown metric method ${String(method)}`);
    }
    return decodeWire(encodeWire(value));
  } catch (error) {
    throw controlRealm.createError(serializeError(error));
  }
}

async function invokeCallback(message) {
  const callback = callbacks.get(message.callbackId);
  if (!callback) {
    send({
      type: "callback-result",
      invocationId: message.invocationId,
      error: serializeError(new Error(`Unknown workflow callback ${String(message.callbackId)}`)),
    });
    return;
  }
  try {
    const args = decodeWire(message.args);
    if (!Array.isArray(args)) throw new Error("Workflow callback arguments are invalid");
    const value = await invocation.run(message.invocationId, () => Promise.resolve(callback(...args)));
    send({ type: "callback-result", invocationId: message.invocationId, value: encodeWire(value) });
  } catch (error) {
    send({ type: "callback-result", invocationId: message.invocationId, error: serializeError(error) });
  }
}

function encodeWire(value) {
  const counter = { nodes: 0, bytes: 0 };
  const ancestors = new Set();
  const visit = (current, depth) => {
    consumeWire(counter, depth, typeof current === "string" ? current : undefined);
    if (current === undefined) return { type: "undefined" };
    if (current === null || typeof current === "boolean" || typeof current === "string") {
      return { type: "primitive", value: current };
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) throw new Error("Control values require finite JSON numbers");
      return { type: "primitive", value: current };
    }
    if (typeof current === "function") {
      let id = callbackIds.get(current);
      if (!id) {
        id = `function-${nextCallback++}`;
        callbackIds.set(current, id);
        callbacks.set(id, current);
      }
      return { type: "callback", id };
    }
    if (!current || typeof current !== "object") throw new Error(`Unsupported control value ${typeof current}`);
    const metricId = metricHandleIds.get(current);
    if (metricId) return { type: "metric-ref", id: metricId };
    const referenceId = remoteReferenceIds.get(current);
    if (referenceId) return { type: "host-ref", id: referenceId };
    if (ancestors.has(current)) throw new Error("Cyclic workflow control values are unavailable");
    ancestors.add(current);
    try {
      if (Array.isArray(current)) return { type: "array", values: current.map((entry) => visit(entry, depth + 1)) };
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== null && prototype !== Object.prototype) {
        const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor");
        if (
          Object.getPrototypeOf(prototype) !== null || !constructor || !("value" in constructor) ||
          typeof constructor.value !== "function" || constructor.value.name !== "Object"
        ) throw new Error("Workflow control objects must be plain data or host references");
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const entries = [];
      for (const key of Object.keys(descriptors).sort()) {
        consumeWire(counter, depth + 1, key);
        const property = descriptors[key];
        if (!property.enumerable || !("value" in property)) throw new Error(`Workflow control property ${key} must be enumerable data`);
        entries.push([key, visit(property.value, depth + 1)]);
      }
      return { type: "object", entries };
    } finally {
      ancestors.delete(current);
    }
  };
  return visit(value, 0);
}

function decodeWire(wire) {
  const counter = { nodes: 0, bytes: 0 };
  const visit = (current, depth) => {
    if (!current || typeof current !== "object" || Array.isArray(current) || typeof current.type !== "string") throw new Error("Malformed workflow control value");
    consumeWire(counter, depth, current.type === "primitive" && typeof current.value === "string" ? current.value : undefined);
    if (current.type === "undefined") {
      assertExactKeys(current, ["type"], "undefined wire value");
      return undefined;
    }
    if (current.type === "primitive") {
      assertExactKeys(current, ["type", "value"], "primitive wire value");
      if (
        current.value !== null && typeof current.value !== "boolean" && typeof current.value !== "string" &&
        (typeof current.value !== "number" || !Number.isFinite(current.value) || Object.is(current.value, -0))
      ) throw new Error("Malformed workflow control primitive");
      return current.value;
    }
    if (current.type === "host-ref") {
      assertExactKeys(current, ["type", "id"], "host-ref wire value");
      return remoteReference(requireId(current.id, "host reference"));
    }
    if (current.type === "metric-ref") {
      assertExactKeys(current, current.state === undefined ? ["type", "id"] : ["type", "id", "state"], "metric-ref wire value");
      return remoteMetric(requireId(current.id, "metric reference"), current.state === undefined ? undefined : visit(current.state, depth + 1));
    }
    if (current.type === "array") {
      assertExactKeys(current, ["type", "values"], "array wire value");
      if (!Array.isArray(current.values)) throw new Error("Malformed workflow control array");
      return controlRealm.copyArray(current.values.map((entry) => visit(entry, depth + 1)));
    }
    if (current.type === "object") {
      assertExactKeys(current, ["type", "entries"], "object wire value");
      if (!Array.isArray(current.entries)) throw new Error("Malformed workflow control object");
      const entries = [];
      const seen = new Set();
      for (const entry of current.entries) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") throw new Error("Malformed workflow control object");
        if (seen.has(entry[0])) throw new Error(`Duplicate workflow control property ${entry[0]}`);
        seen.add(entry[0]);
        consumeWire(counter, depth + 1, entry[0]);
        entries.push([entry[0], visit(entry[1], depth + 1)]);
      }
      return controlRealm.copyObject(entries);
    }
    throw new Error(`Unsupported workflow control wire type ${current.type}`);
  };
  return visit(wire, 0);
}

function remoteReference(id) {
  if (typeof id !== "string") throw new Error("Invalid host reference");
  let value = remoteReferences.get(id);
  if (!value) {
    value = controlRealm.createReference();
    remoteReferences.set(id, value);
    remoteReferenceIds.set(value, id);
  }
  return value;
}

function remoteMetric(id, state) {
  if (state !== undefined) metricStates.set(id, normalizeMetricState(state));
  let handle = metricHandles.get(id);
  if (handle) return handle;
  handle = controlRealm.createMetric(id);
  metricHandles.set(id, handle);
  metricHandleIds.set(handle, id);
  return handle;
}

function applyMetricStates(values) {
  if (!Array.isArray(values)) throw new Error("Workflow metric state update is invalid");
  const seen = new Set();
  for (const entry of values) {
    const record = requireRecord(entry, "workflow metric state update");
    assertExactKeys(record, ["id", "state"], "workflow metric state update");
    const id = requireId(record.id, "metric reference");
    if (seen.has(id)) throw new Error(`Duplicate workflow metric state ${id}`);
    seen.add(id);
    metricStates.set(id, normalizeMetricState(decodeWire(record.state)));
  }
}

function currentInvocation() {
  const id = invocation.getStore();
  if (typeof id !== "string") throw new Error("Workflow host call escaped its control invocation");
  return id;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

function serializeError(error) {
  const record = error && typeof error === "object" ? error : undefined;
  const properties = {};
  for (const key of ["status", "operationPath", "expected", "actual", "attentionKind", "branchFailureKind", "point", "classification"]) {
    const value = record?.[key];
    if (value === null || typeof value === "boolean") properties[key] = value;
    else if (typeof value === "string") properties[key] = boundedText(value, 16_000);
    else if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) properties[key] = value;
  }
  return {
    name: typeof record?.name === "string" ? record.name : "Error",
    message: boundedText(typeof record?.message === "string" ? record.message : String(error), 16_000),
    ...(typeof record?.stack === "string" ? { stack: boundedText(record.stack, 32_000) } : {}),
    ...(typeof record?.__flowHostErrorId === "string" ? { hostErrorId: record.__flowHostErrorId } : {}),
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
  };
}

function parseSerializedError(value) {
  const serialized = requireRecord(value, "workflow host error");
  const allowed = ["name", "message", "stack", "hostErrorId", "properties"];
  for (const key of Object.keys(serialized)) if (!allowed.includes(key)) throw new Error(`Workflow host error contains unknown field ${key}`);
  const name = boundedProtocolString(serialized.name, "workflow host error name", 256);
  const message = boundedProtocolString(serialized.message, "workflow host error message", 16_000, true);
  const stack = serialized.stack === undefined ? undefined : boundedProtocolString(serialized.stack, "workflow host error stack", 32_000, true);
  const hostErrorId = serialized.hostErrorId === undefined ? undefined : requireId(serialized.hostErrorId, "host error");
  let properties;
  if (serialized.properties !== undefined) {
    const raw = requireRecord(serialized.properties, "workflow host error properties");
    properties = Object.create(null);
    for (const key of Object.keys(raw)) {
      if (!["status", "operationPath", "expected", "actual", "attentionKind", "branchFailureKind", "point", "classification"].includes(key)) {
        throw new Error(`Workflow host error property ${key} is unavailable`);
      }
      const property = raw[key];
      if (
        property !== null && typeof property !== "boolean" && typeof property !== "string" &&
        (typeof property !== "number" || !Number.isFinite(property) || Object.is(property, -0))
      ) throw new Error(`Workflow host error property ${key} is invalid`);
      properties[key] = typeof property === "string"
        ? boundedProtocolString(property, `workflow host error property ${key}`, 16_000, true)
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

function parseMetricResponse(value) {
  const message = requireRecord(value, "metric-response message");
  if (message.type !== "metric-response") throw new Error("Synchronous metric response type is invalid");
  assertOutcomeKeys(message, ["type", "requestId"], "metric-response message");
  const base = { type: "metric-response", requestId: requireId(message.requestId, "metric request") };
  return Object.prototype.hasOwnProperty.call(message, "error")
    ? { ...base, error: parseSerializedError(message.error) }
    : { ...base, value: requireWire(message.value) };
}

function assertOutcomeKeys(message, base, label) {
  const hasValue = Object.prototype.hasOwnProperty.call(message, "value");
  const hasError = Object.prototype.hasOwnProperty.call(message, "error");
  if (hasValue === hasError) throw new Error(`${label} requires exactly one outcome`);
  assertExactKeys(message, [...base, hasError ? "error" : "value"], label);
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireWire(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workflow control wire value is invalid");
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function requireId(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[a-z0-9-]+$/.test(value)) {
    throw new Error(`Invalid ${label} id`);
  }
  return value;
}

function boundedProtocolString(value, label, maximum, empty = false) {
  if (typeof value !== "string" || (!empty && value.length === 0) || Buffer.byteLength(value) > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function deserializeError(serialized) {
  if (!controlRealm) throw new Error("Workflow control realm is unavailable");
  return controlRealm.createError({
    name: typeof serialized?.name === "string" ? serialized.name : "Error",
    message: typeof serialized?.message === "string" ? serialized.message : "Workflow host operation failed",
    ...(typeof serialized?.stack === "string" ? { stack: serialized.stack } : {}),
    ...(serialized?.properties && typeof serialized.properties === "object" ? { properties: serialized.properties } : {}),
    ...(typeof serialized?.hostErrorId === "string" ? { hostErrorId: serialized.hostErrorId } : {}),
  });
}

function consumeWire(counter, depth, text) {
  counter.nodes++;
  if (text !== undefined) counter.bytes += Buffer.byteLength(text);
  if (depth > CONTROL_WIRE_DEPTH || counter.nodes > CONTROL_WIRE_NODES || counter.bytes > CONTROL_WIRE_BYTES) throw new Error("Workflow control message exceeds its structural limit");
}

function boundedText(value, maximum) {
  let bytes = 0;
  let result = "";
  for (const scalar of value) {
    const size = Buffer.byteLength(scalar);
    if (bytes + size > maximum) break;
    result += scalar;
    bytes += size;
  }
  return result;
}

function finish(message) {
  if (finished) return;
  finished = true;
  phase = "finished";
  if (!process.connected || !process.send) return;
  process.send(message, () => {
    try { fs.closeSync(4); } catch { /* already closed */ }
    process.disconnect();
  });
}

function send(message) {
  if (!process.connected || !process.send) throw new Error("Workflow control host is disconnected");
  process.send(message);
}

function readSyncResponse() {
  while (true) {
    const newline = syncBuffer.indexOf("\n");
    if (newline >= 0) {
      const line = syncBuffer.slice(0, newline);
      syncBuffer = syncBuffer.slice(newline + 1);
      return JSON.parse(line);
    }
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const bytes = fs.readSync(4, chunk, 0, chunk.length, null);
    if (bytes === 0) throw new Error("Workflow metric response pipe closed");
    syncBuffer += chunk.toString("utf8", 0, bytes);
    if (Buffer.byteLength(syncBuffer) > 4 * 1024 * 1024) throw new Error("Workflow metric response exceeds its structural limit");
  }
}
