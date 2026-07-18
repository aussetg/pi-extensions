import fs from "node:fs";
import vm from "node:vm";
import { AsyncLocalStorage } from "node:async_hooks";
import { createWorkflowControlRealm } from "./control-realm.js";

const PROTOCOL_VERSION = 17;
const RUNTIME_API_HASH = "sha256:3ea83475c353de4c9479b0f27664cabd3aa6413e956c27ce0ad9a39ce91cd612";
const WIRE_BYTES = 4 * 1024 * 1024;
const WIRE_DEPTH = 48;
const WIRE_NODES = 50_000;
const SOURCE_BYTES = WIRE_BYTES;
const ASYNC_METHODS = Object.freeze([
  "parallel", "map", "agent", "command", "ask", "measure", "candidate", "verify", "accept",
  "reject", "recordExperiment", "apply",
]);
const SYNC_METHODS = Object.freeze(["metrics"]);
const DESCRIPTOR_KINDS = new Set(["agent-task", "command-task"]);
const PRODUCT_KINDS = new Set([
  "artifact", "agent-result", "command-result", "candidate", "accepted-candidate", "verification", "measurement",
]);
const REFERENCE_KINDS = new Set(["launch-snapshot", "candidate-workspace", "metric-set"]);
const HASH = /^sha256:[a-f0-9]{64}$/u;
const ID = /^[a-z][a-z0-9-]{0,127}$/u;

const callbacks = new Map();
const callbackIds = new WeakMap();
const pendingHostCalls = new Map();
const invocation = new AsyncLocalStorage();
let nextCallback = 1;
let nextRequest = 1;
let configuration;
let controlRealm;
let syncBuffer = "";
let phase = "awaiting-initialize";
let finished = false;

process.on("message", message => {
  if (finished) return;
  try {
    if (phase === "awaiting-initialize") {
      configuration = parseInitialize(message);
      phase = "running";
      send({ type: "initialized", protocolVersion: PROTOCOL_VERSION });
      startControl();
      return;
    }
    const parsed = parseRunningMessage(message);
    if (parsed.type === "host-response") {
      const pending = pendingHostCalls.get(parsed.requestId);
      if (!pending) throw new Error(`Unknown workflow v17 host response ${parsed.requestId}`);
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

process.on("uncaughtException", error => finish({ type: "done", error: serializeError(error) }));
process.on("unhandledRejection", error => finish({ type: "done", error: serializeError(error) }));

function parseInitialize(value) {
  const message = requireRecord(value, "workflow v17 initialize message");
  if (message.type !== "initialize") throw new Error(`Expected workflow v17 initialize, received ${String(message.type)}`);
  const expected = [
    "type", "protocolVersion", "runtimeApiHash", "executableSource", "workflowName", "metadata",
    "descriptors", "operationSites", "args", "segmentTimeoutMs", "definitionOnly",
  ];
  if (message.snapshot !== undefined) expected.push("snapshot");
  assertExactKeys(message, expected, "workflow v17 initialize message");
  if (message.protocolVersion !== PROTOCOL_VERSION) throw new Error("Workflow v17 control protocol version is invalid");
  if (message.runtimeApiHash !== RUNTIME_API_HASH) throw new Error("Workflow v17 runtime API hash is invalid");
  if (typeof message.executableSource !== "string" || Buffer.byteLength(message.executableSource) < 1
    || Buffer.byteLength(message.executableSource) > SOURCE_BYTES) throw new Error("Workflow v17 source exceeds its limit");
  if (typeof message.workflowName !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(message.workflowName)) {
    throw new Error("Workflow v17 installed name is invalid");
  }
  if (!Number.isSafeInteger(message.segmentTimeoutMs) || message.segmentTimeoutMs < 25 || message.segmentTimeoutMs > 10_000) {
    throw new Error("Workflow v17 control segment timeout is invalid");
  }
  if (typeof message.definitionOnly !== "boolean") throw new Error("Workflow v17 definition-only flag is invalid");
  const metadataWire = requireWire(message.metadata);
  const args = requireWire(message.args);
  const snapshot = message.snapshot === undefined ? undefined : requireWire(message.snapshot);
  if (!Array.isArray(message.descriptors)) throw new Error("Workflow v17 descriptor configuration is invalid");
  const descriptors = message.descriptors.map((value, index) => {
    const descriptor = requireRecord(value, `workflow v17 descriptor ${index}`);
    assertExactKeys(descriptor, ["identity", "definition"], `workflow v17 descriptor ${index}`);
    return { identity: descriptorIdentity(descriptor.identity), definitionWire: requireWire(descriptor.definition) };
  });
  if (!Array.isArray(message.operationSites)) throw new Error("Workflow v17 operation sites are invalid");
  const operationSites = message.operationSites.map((value, index) => {
    const site = requireRecord(value, `workflow v17 operation site ${index}`);
    assertExactKeys(site, ["sourceSite", "method"], `workflow v17 operation site ${index}`);
    if (typeof site.sourceSite !== "string" || !ID.test(site.sourceSite)
      || typeof site.method !== "string" || (!ASYNC_METHODS.includes(site.method) && !SYNC_METHODS.includes(site.method))) {
      throw new Error(`Workflow v17 operation site ${index} is invalid`);
    }
    return { sourceSite: site.sourceSite, method: site.method };
  });
  return Object.freeze({
    executableSource: message.executableSource,
    workflowName: message.workflowName,
    metadataWire,
    descriptors,
    operationSites,
    args,
    ...(snapshot ? { snapshot } : {}),
    segmentTimeoutMs: message.segmentTimeoutMs,
    definitionOnly: message.definitionOnly,
  });
}

function parseRunningMessage(value) {
  const message = requireRecord(value, "workflow v17 host message");
  if (message.type === "host-response") {
    assertOutcomeKeys(message, ["type", "requestId"], "workflow v17 host-response");
    const base = { type: "host-response", requestId: requireId(message.requestId, "host request") };
    return Object.prototype.hasOwnProperty.call(message, "error")
      ? { ...base, error: parseSerializedError(message.error) }
      : { ...base, value: requireWire(message.value) };
  }
  if (message.type === "invoke-callback") {
    assertExactKeys(message, ["type", "invocationId", "callbackId", "args"], "workflow v17 invoke-callback");
    return {
      type: "invoke-callback",
      invocationId: requireId(message.invocationId, "callback invocation"),
      callbackId: requireId(message.callbackId, "callback"),
      args: requireWire(message.args),
    };
  }
  throw new Error(`Unknown workflow v17 host message ${String(message.type)}`);
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
    name: "pi-workflow-control",
    codeGeneration: { strings: false, wasm: false },
  });
  hardenContext(context);

  // Reviewed configuration is decoded as inert data before it is captured by the realm factory.
  const metadata = decodeOuterWire(configuration.metadataWire);
  const descriptors = configuration.descriptors.map(descriptor => ({
    identity: descriptor.identity,
    definition: decodeOuterWire(descriptor.definitionWire),
  }));
  controlRealm = createWorkflowControlRealm(context, {
    asyncMethods: ASYNC_METHODS,
    syncMethods: SYNC_METHODS,
    hostCall: bridgeHostCall,
    hostSyncCall: bridgeHostSyncCall,
    metricCall: bridgeMetricCall,
    metadata,
    descriptors,
    operationSites: configuration.operationSites,
  });
  const args = controlRealm.deepFreeze(decodeWire(configuration.args));
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Workflow v17 arguments must be an object");
  const snapshot = configuration.snapshot === undefined ? undefined : decodeWire(configuration.snapshot);
  const flow = controlRealm.createFlow(snapshot !== undefined, snapshot);
  Object.defineProperties(sandbox, {
    __flowDeepFreeze: { value: controlRealm.deepFreeze, writable: false, enumerable: false },
    __flowHostApi: { value: flow, writable: false, enumerable: false },
    __flowHostArgs: { value: args, writable: false, enumerable: false },
    __flowLanguage: { value: controlRealm.language, writable: false, enumerable: false },
    __flowSourceSite: { value: controlRealm.sourceSite, writable: false, enumerable: false },
  });
  const wrapper = `
(async () => {
  "use strict";
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
  if (!__flowDefinition || typeof __flowDefinition.run !== "function") throw new Error("Invalid workflow v17 definition");
  if (${configuration.definitionOnly === true ? "true" : "false"}) return { loaded: true, name: ${JSON.stringify(configuration.workflowName)} };
  return await (0, __flowDefinition.run)(__flowHostApi, __flowHostArgs);
})()
`;
  try {
    const script = new vm.Script(wrapper, { filename: `${configuration.workflowName}.flow.ts` });
    const execution = invocation.run("root", () => script.runInContext(context, { timeout: configuration.segmentTimeoutMs }));
    Promise.resolve(execution).then(
      value => finish({ type: "done", value: encodeWire(value) }),
      error => finish({ type: "done", error: serializeError(error) }),
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
    if (!ASYNC_METHODS.includes(method) || !Array.isArray(args)) throw new Error("Invalid workflow v17 host call");
    return await callHost(method, args);
  } catch (error) {
    throw controlRealm.createError(serializeError(error));
  }
}

function bridgeHostSyncCall(method, args) {
  try {
    if (!SYNC_METHODS.includes(method) || !Array.isArray(args)) throw new Error("Invalid workflow v17 synchronous call");
    const invocationId = currentInvocation();
    const requestId = `request-${nextRequest++}`;
    send({ type: "sync-call", requestId, invocationId, method, args: encodeWire(args) });
    const response = parseSyncResponse(readSyncResponse());
    if (response.requestId !== requestId) throw new Error("Workflow v17 synchronous response id changed");
    if (response.error !== undefined) throw deserializeError(response.error);
    return decodeWire(response.value);
  } catch (error) {
    throw controlRealm.createError(serializeError(error));
  }
}

function bridgeMetricCall(referenceId, method, args) {
  try {
    if (typeof referenceId !== "string" || !ID.test(referenceId)
      || !["policy", "summary", "reachedTarget", "evaluate"].includes(method)
      || !Array.isArray(args)) {
      throw new Error("Invalid workflow v17 metric-set call");
    }
    const invocationId = currentInvocation();
    const requestId = `request-${nextRequest++}`;
    send({
      type: "metric-call",
      requestId,
      invocationId,
      referenceId,
      method,
      args: encodeWire(args),
    });
    const response = parseMetricResponse(readSyncResponse());
    if (response.requestId !== requestId) throw new Error("Workflow v17 metric response id changed");
    if (response.error !== undefined) throw deserializeError(response.error);
    return decodeWire(response.value);
  } catch (error) {
    throw controlRealm.createError(serializeError(error));
  }
}

async function invokeCallback(message) {
  const callback = callbacks.get(message.callbackId);
  if (!callback) {
    send({
      type: "callback-result", invocationId: message.invocationId,
      error: serializeError(new Error(`Unknown workflow v17 callback ${message.callbackId}`)),
    });
    return;
  }
  try {
    const args = decodeWire(message.args);
    if (!Array.isArray(args)) throw new Error("Workflow v17 callback arguments are invalid");
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
    if (current === null || typeof current === "boolean" || typeof current === "string") return { type: "primitive", value: current };
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) throw new Error("Workflow v17 values require finite numbers");
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
    if (!current || typeof current !== "object") throw new Error(`Unsupported workflow v17 value ${typeof current}`);
    const sourceSite = controlRealm ? controlRealm.authority(current) : undefined;
    if (sourceSite) {
      if (sourceSite.family === "descriptor") return { type: "descriptor-ref", id: sourceSite.id, identity: sourceSite.identity };
      if (sourceSite.family === "product") return { type: "product-ref", id: sourceSite.id, identity: sourceSite.identity };
      if (sourceSite.family === "reference") return { type: "reference-ref", id: sourceSite.id, identity: sourceSite.identity };
    }
    const siteRecord = controlRealm && current ? sourceSiteRecord(current) : undefined;
    if (siteRecord) return { type: "source-site", sourceSite: siteRecord.sourceSite };
    if (ancestors.has(current)) throw new Error("Cyclic workflow v17 control values are unavailable");
    ancestors.add(current);
    try {
      if (Array.isArray(current)) return { type: "array", values: current.map(entry => visit(entry, depth + 1)) };
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== null && prototype !== Object.prototype) {
        const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor");
        if (Object.getPrototypeOf(prototype) !== null || !constructor || !("value" in constructor)
          || typeof constructor.value !== "function" || constructor.value.name !== "Object") {
          throw new Error("Workflow v17 control objects must be plain data or authority values");
        }
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const entries = [];
      for (const key of Object.keys(descriptors).sort()) {
        consumeWire(counter, depth + 1, key);
        const property = descriptors[key];
        if (!property.enumerable || property.get || property.set || !("value" in property)) {
          throw new Error(`Workflow v17 property ${key} must be enumerable data`);
        }
        entries.push([key, visit(property.value, depth + 1)]);
      }
      return { type: "object", entries };
    } finally {
      ancestors.delete(current);
    }
  };
  return visit(value, 0);
}

// Source-site records are deliberately separate from transport authorities.
function sourceSiteRecord(value) {
  return controlRealm.sourceSiteRecord(value);
}

function decodeWire(wire) {
  const counter = { nodes: 0, bytes: 0 };
  const visit = (current, depth) => {
    if (!current || typeof current !== "object" || Array.isArray(current) || typeof current.type !== "string") {
      throw new Error("Malformed workflow v17 control value");
    }
    consumeWire(counter, depth, current.type === "primitive" && typeof current.value === "string" ? current.value : undefined);
    if (current.type === "undefined") { assertExactKeys(current, ["type"], "undefined wire value"); return undefined; }
    if (current.type === "primitive") {
      assertExactKeys(current, ["type", "value"], "primitive wire value");
      if (current.value !== null && typeof current.value !== "boolean" && typeof current.value !== "string"
        && (typeof current.value !== "number" || !Number.isFinite(current.value) || Object.is(current.value, -0))) {
        throw new Error("Malformed workflow v17 primitive");
      }
      return current.value;
    }
    if (current.type === "array") {
      assertExactKeys(current, ["type", "values"], "array wire value");
      if (!Array.isArray(current.values)) throw new Error("Malformed workflow v17 array");
      return controlRealm.copyArray(current.values.map(entry => visit(entry, depth + 1)));
    }
    if (current.type === "object") {
      assertExactKeys(current, ["type", "entries"], "object wire value");
      return controlRealm.copyObject(decodeEntries(current.entries, depth, counter, visit));
    }
    if (current.type === "product" || current.type === "reference") {
      assertExactKeys(current, ["type", "id", "identity", "fields"], `${current.type} wire value`);
      const id = requireId(current.id, `${current.type} transport`);
      const identity = current.type === "product" ? productIdentity(current.identity) : referenceIdentity(current.identity);
      const fields = decodeEntries(current.fields, depth, counter, visit);
      return controlRealm.createRemoteAuthority(current.type, id, identity, fields);
    }
    throw new Error(`Host sent unavailable workflow v17 wire type ${current.type}`);
  };
  return visit(wire, 0);
}

function decodeOuterWire(wire) {
  const visit = current => {
    if (current.type === "undefined") return undefined;
    if (current.type === "primitive") return current.value;
    if (current.type === "array") return current.values.map(visit);
    if (current.type === "object") return Object.fromEntries(current.entries.map(entry => [entry[0], visit(entry[1])]));
    throw new Error("Reviewed workflow v17 configuration must be plain data");
  };
  return visit(wire);
}

function decodeEntries(value, depth, counter, visit) {
  if (!Array.isArray(value)) throw new Error("Malformed workflow v17 entries");
  const result = [];
  const seen = new Set();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") throw new Error("Malformed workflow v17 entry");
    if (seen.has(entry[0])) throw new Error(`Duplicate workflow v17 property ${entry[0]}`);
    seen.add(entry[0]);
    consumeWire(counter, depth + 1, entry[0]);
    result.push([entry[0], visit(entry[1], depth + 1)]);
  }
  return result;
}

function descriptorIdentity(value) {
  const identity = requireRecord(value, "workflow v17 descriptor identity");
  assertExactKeys(identity, ["formatVersion", "kind", "sourceSite", "definitionHash"], "workflow v17 descriptor identity");
  if (identity.formatVersion !== 1 || !DESCRIPTOR_KINDS.has(identity.kind) || typeof identity.sourceSite !== "string"
    || !ID.test(identity.sourceSite) || typeof identity.definitionHash !== "string" || !HASH.test(identity.definitionHash)) {
    throw new Error("Workflow v17 descriptor identity is invalid");
  }
  return identity;
}

function productIdentity(value) {
  return authorityIdentity(value, PRODUCT_KINDS, "product");
}

function referenceIdentity(value) {
  return authorityIdentity(value, REFERENCE_KINDS, "reference");
}

function authorityIdentity(value, kinds, label) {
  const identity = requireRecord(value, `workflow v17 ${label} identity`);
  assertExactKeys(identity, ["formatVersion", "kind", "authorityId", "authorityHash"], `workflow v17 ${label} identity`);
  if (identity.formatVersion !== 1 || !kinds.has(identity.kind) || typeof identity.authorityId !== "string"
    || !ID.test(identity.authorityId) || typeof identity.authorityHash !== "string" || !HASH.test(identity.authorityHash)) {
    throw new Error(`Workflow v17 ${label} identity is invalid`);
  }
  return identity;
}

function parseSyncResponse(value) {
  const message = requireRecord(value, "workflow v17 synchronous response");
  if (message.type !== "sync-response") throw new Error("Workflow v17 synchronous response type is invalid");
  assertOutcomeKeys(message, ["type", "requestId"], "workflow v17 synchronous response");
  const base = { type: "sync-response", requestId: requireId(message.requestId, "synchronous request") };
  return Object.prototype.hasOwnProperty.call(message, "error")
    ? { ...base, error: parseSerializedError(message.error) }
    : { ...base, value: requireWire(message.value) };
}

function parseMetricResponse(value) {
  const message = requireRecord(value, "workflow v17 metric response");
  if (message.type !== "metric-response") throw new Error("Workflow v17 metric response type is invalid");
  assertOutcomeKeys(message, ["type", "requestId"], "workflow v17 metric response");
  const base = { type: "metric-response", requestId: requireId(message.requestId, "metric request") };
  return Object.prototype.hasOwnProperty.call(message, "error")
    ? { ...base, error: parseSerializedError(message.error) }
    : { ...base, value: requireWire(message.value) };
}

function readSyncResponse() {
  while (true) {
    const newline = syncBuffer.indexOf("\n");
    if (newline >= 0) {
      const line = syncBuffer.slice(0, newline);
      syncBuffer = syncBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      return JSON.parse(line);
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const bytes = fs.readSync(4, buffer, 0, buffer.length, null);
    if (bytes === 0) throw new Error("Workflow v17 synchronous response pipe closed");
    syncBuffer += buffer.toString("utf8", 0, bytes);
    if (Buffer.byteLength(syncBuffer) > WIRE_BYTES) throw new Error("Workflow v17 synchronous response exceeds its limit");
  }
}

function currentInvocation() {
  const id = invocation.getStore();
  if (typeof id !== "string") throw new Error("Workflow v17 host call escaped its control invocation");
  return id;
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
    ...(Object.keys(properties).length ? { properties } : {}),
  };
}

function parseSerializedError(value) {
  const error = requireRecord(value, "workflow v17 host error");
  for (const key of Object.keys(error)) if (!["name", "message", "stack", "hostErrorId", "properties"].includes(key)) throw new Error(`Unknown error field ${key}`);
  return error;
}

function deserializeError(serialized) {
  return controlRealm.createError(serialized);
}

function send(message) {
  if (typeof process.send !== "function") throw new Error("Workflow v17 control IPC is unavailable");
  process.send(message);
}

function finish(message) {
  if (finished) return;
  finished = true;
  try { send(message); }
  finally { setImmediate(() => process.exit(message.error === undefined ? 0 : 1)); }
}

function assertOutcomeKeys(message, base, label) {
  const hasValue = Object.prototype.hasOwnProperty.call(message, "value");
  const hasError = Object.prototype.hasOwnProperty.call(message, "error");
  if (hasValue === hasError) throw new Error(`${label} requires exactly one outcome`);
  assertExactKeys(message, [...base, hasError ? "error" : "value"], label);
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} has unexpected fields`);
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireWire(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workflow v17 wire value is invalid");
  return value;
}

function requireId(value, label) {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`Invalid workflow v17 ${label} id`);
  return value;
}

function consumeWire(counter, depth, text) {
  counter.nodes++;
  if (text !== undefined) counter.bytes += Buffer.byteLength(text);
  if (depth > WIRE_DEPTH || counter.nodes > WIRE_NODES || counter.bytes > WIRE_BYTES) {
    throw new Error("Workflow v17 control message exceeds its structural limit");
  }
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
