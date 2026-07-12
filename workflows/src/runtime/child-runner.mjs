import vm from "node:vm";
import readline from "node:readline";
import { AsyncLocalStorage } from "node:async_hooks";

const BRIDGE_GLOBAL = "__piWorkflowBridge";
const START_GLOBAL = "__piWorkflowStart";
const FANOUT_AGENT_DEFAULT_WORKSPACE = "readOnly";

const waiters = new Map();
const fanoutGroups = new Map();
const fanoutContext = new AsyncLocalStorage();

let nextRpcId = 1;
let nextFanoutGroupId = 1;
let aborted = false;
let heartbeat;
let budgetTotal = null;
let budgetSpent = 0;
let pipelineLimit = 50;

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

void main();

async function main() {
  const start = await waitForStart();
  budgetTotal = typeof start.budgetTotal === "number" ? start.budgetTotal : null;
  budgetSpent = typeof start.budgetSpent === "number" && Number.isFinite(start.budgetSpent) ? start.budgetSpent : 0;
  pipelineLimit = Number.isInteger(start.pipelineLimit) && start.pipelineLimit > 0 ? start.pipelineLimit : 50;

  heartbeat = setInterval(() => send({ type: "heartbeat" }), Math.max(250, Number(start.heartbeatMs) || 1000));
  heartbeat.unref?.();

  try {
    const result = await runWorkflow(String(start.source ?? ""), {
      args: start.args ?? {},
      cwd: String(start.cwd ?? ""),
    });
    send({ type: "done", result: toJsonValue(result) });
    shutdown(0);
  } catch (err) {
    send({ type: "failed", name: err?.name ?? "Error", error: err?.message ?? String(err), stack: err?.stack });
    shutdown(1);
  }
}

function waitForStart() {
  return new Promise((resolve, reject) => {
    const onLine = (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        cleanup();
        reject(new Error(`Invalid workflow runner start message: ${err.message}`));
        return;
      }
      if (msg.type !== "start") return;
      cleanup();
      rl.on("line", handleParentLine);
      resolve(msg);
    };
    const cleanup = () => rl.off("line", onLine);
    rl.on("line", onLine);
  });
}

function handleParentLine(line) {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "abort") {
    aborted = true;
    rejectAll(new Error(String(msg.reason ?? "Workflow aborted")));
    shutdown(1);
    return;
  }
  if (msg.type !== "reply") return;
  const waiter = waiters.get(msg.id);
  if (!waiter) return;
  if (msg.ok) waiter.resolve(msg.result);
  else {
    const err = new Error(msg.error?.message ?? "Workflow RPC failed");
    err.name = msg.error?.name ?? "WorkflowRpcError";
    waiter.reject(err);
  }
}

async function runWorkflow(source, startGlobals) {
  const timers = new Map();
  const timerErrors = [];
  const bridge = createBridge(timers, timerErrors);
  const sandbox = Object.create(null);

  Object.defineProperty(sandbox, BRIDGE_GLOBAL, { value: bridge, configurable: true });
  Object.defineProperty(sandbox, START_GLOBAL, {
    value: JSON.stringify({
      args: toJsonValue(startGlobals.args),
      cwd: startGlobals.cwd,
      budgetTotal,
      budgetSpent,
      pipelineLimit,
    }),
    configurable: true,
  });

  const context = vm.createContext(sandbox, {
    name: "pi-workflow-child",
    codeGeneration: { strings: false, wasm: false },
  });

  const runtime = new vm.Script(BOOTSTRAP_SOURCE, { filename: "workflow-bootstrap.js" }).runInContext(context, { timeout: 1000 });
  const script = new vm.Script(`"use strict";\n(async () => {\n${source}\n})()`, { filename: "workflow.js" });
  const result = await script.runInContext(context, { timeout: 1000 });

  await drainNonCritical();
  runtime.assertNoUnhandledCriticalOperations();

  const critical = [...waiters.values()].filter((waiter) => waiter.critical);
  if (critical.length > 0) {
    throw new Error(`Workflow returned with ${critical.length} pending critical operation(s). Await agent(), apply(), and workflow() calls before returning.`);
  }

  if (timerErrors.length > 0) {
    const first = timerErrors[0];
    throw new Error(`Workflow timer callback failed: ${first.message}`);
  }

  if (timers.size > 0) {
    const pendingTimerCount = timers.size;
    clearAllTimers(timers);
    throw new Error(`Workflow returned with ${pendingTimerCount} pending timer(s). Await explicit promises instead of leaving timers behind.`);
  }

  return result;
}

function createBridge(timers, timerErrors) {
  let nextTimerId = 1;

  return Object.freeze({
    async rpcJson(method, paramsJson, critical) {
      try {
        const params = JSON.parse(String(paramsJson ?? "{}"));
        const result = await rpc(String(method), params, { critical: Boolean(critical) });
        return JSON.stringify({ ok: true, result: toJsonValue(result) });
      } catch (err) {
        return JSON.stringify({ ok: false, error: serializeError(err) });
      }
    },

    currentWorkspace() {
      return fanoutContext.getStore()?.defaultWorkspace;
    },

    createFanoutGroup(kind) {
      return createFanoutGroup(String(kind ?? "fanout"));
    },

    cancelFanoutGroup(groupId, reason) {
      return cancelFanoutGroup(groupId, reason);
    },

    closeFanoutGroup(groupId) {
      closeFanoutGroup(groupId);
    },

    withFanoutWorkspace(groupId, fn) {
      const current = fanoutContext.getStore() ?? {};
      const fanoutGroupIds = Number.isSafeInteger(groupId) ? [...(Array.isArray(current.fanoutGroupIds) ? current.fanoutGroupIds : []), groupId] : Array.isArray(current.fanoutGroupIds) ? current.fanoutGroupIds : [];
      return fanoutContext.run({ ...current, defaultWorkspace: FANOUT_AGENT_DEFAULT_WORKSPACE, fanoutGroupIds }, fn);
    },

    withoutFanoutWorkspace(fn) {
      return fanoutContext.run({}, fn);
    },

    setTimer(fn, ms, rest) {
      const id = nextTimerId++;
      const delay = Math.min(Math.max(Number(ms) || 0, 0), 60_000);
      const timer = setTimeout(() => {
        timers.delete(id);
        Promise.resolve()
          .then(() => fn(...rest))
          .catch((err) => timerErrors.push(serializeError(err)));
      }, delay);
      timer.unref?.();
      timers.set(id, timer);
      return id;
    },

    clearTimer(id) {
      const timer = timers.get(Number(id));
      if (!timer) return false;
      clearTimeout(timer);
      timers.delete(Number(id));
      return true;
    },
  });
}

const BOOTSTRAP_SOURCE = String.raw`
(() => {
  "use strict";

  const bridge = globalThis.__piWorkflowBridge;
  const start = JSON.parse(globalThis.__piWorkflowStart);
  delete globalThis.__piWorkflowBridge;
  delete globalThis.__piWorkflowStart;

  let budgetSpent = typeof start.budgetSpent === "number" && Number.isFinite(start.budgetSpent) ? start.budgetSpent : 0;
  const budgetTotal = typeof start.budgetTotal === "number" ? start.budgetTotal : null;
  const pipelineLimit = Number.isInteger(start.pipelineLimit) && start.pipelineLimit > 0 ? start.pipelineLimit : 50;
  const criticalOperations = new Map();
  let nextCriticalOperationId = 1;

  function vmError(name, message) {
    const err = new Error(String(message ?? name ?? "Workflow error"));
    err.name = String(name ?? "Error");
    return err;
  }

  function errorFromHost(value) {
    if (value && typeof value === "object") return vmError(value.name ?? "Error", value.message ?? "Workflow RPC failed");
    return vmError("Error", String(value ?? "Workflow RPC failed"));
  }

  async function hostRpc(method, params, critical) {
    let raw;
    try {
      raw = await bridge.rpcJson(method, JSON.stringify(params ?? {}), critical === true);
    } catch (err) {
      throw errorFromHost(err);
    }

    let reply;
    try {
      reply = JSON.parse(raw);
    } catch (err) {
      throw vmError("WorkflowRpcError", "Workflow host returned invalid JSON");
    }

    if (!reply || typeof reply !== "object") throw vmError("WorkflowRpcError", "Workflow host returned an invalid envelope");
    if (!reply.ok) throw errorFromHost(reply.error);
    return reply.result;
  }

  function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function defaultWorkspace() {
    return bridge.currentWorkspace();
  }

  function trackCriticalOperation(method, promise) {
    const operation = { id: nextCriticalOperationId++, method, consumed: false, settled: false };
    criticalOperations.set(operation.id, operation);
    promise.then(
      () => {
        operation.settled = true;
      },
      () => {
        operation.settled = true;
      },
    );
    const markConsumed = () => {
      operation.consumed = true;
    };
    const handle = Object.create(null);
    Object.defineProperties(handle, {
      then: {
        value: (onFulfilled, onRejected) => {
          markConsumed();
          return promise.then(onFulfilled, onRejected);
        },
        enumerable: false,
        writable: false,
        configurable: false,
      },
      catch: {
        value: (onRejected) => {
          markConsumed();
          return promise.catch(onRejected);
        },
        enumerable: false,
        writable: false,
        configurable: false,
      },
      finally: {
        value: (onFinally) => {
          markConsumed();
          return promise.finally(onFinally);
        },
        enumerable: false,
        writable: false,
        configurable: false,
      },
    });
    return Object.freeze(handle);
  }

  function assertNoUnhandledCriticalOperations() {
    const unhandled = [...criticalOperations.values()].filter((operation) => !operation.consumed);
    if (unhandled.length === 0) return;
    const labels = unhandled.slice(0, 5).map((operation) => operation.method).join(", ");
    const suffix = unhandled.length > 5 ? ", ..." : "";
    throw new Error("Workflow returned with " + unhandled.length + " unawaited critical operation(s): " + labels + suffix + ". Await agent(), apply(), and workflow() calls before returning.");
  }

  function agent(prompt, opts = {}) {
    if (!isRecord(opts)) throw new Error("agent(prompt, opts?) options must be an object");
    const rawOpts = toStrictJsonValue(opts, "agent opts");
    const contextualWorkspace = defaultWorkspace();
    const effectiveOpts = rawOpts.workspace === undefined && contextualWorkspace ? { ...rawOpts, workspace: contextualWorkspace } : rawOpts;
    return trackCriticalOperation("agent", hostRpc("agent", { prompt, opts: effectiveOpts }, true).then((payload) => {
      if (payload && typeof payload === "object" && payload.__piWorkflowRpc === "agentResult") {
        if (typeof payload.budgetSpent === "number" && Number.isFinite(payload.budgetSpent)) budgetSpent = payload.budgetSpent;
        return payload.result;
      }
      return payload;
    }));
  }

  function apply(patch) {
    return trackCriticalOperation("apply", hostRpc("apply", { patch }, true));
  }

  function toStrictJsonValue(value, label, seen = new Set()) {
    if (value === null) return null;
    const t = typeof value;
    if (t === "string" || t === "boolean") return value;
    if (t === "number") {
      if (!Number.isFinite(value)) throw new Error(label + " contains a non-finite number");
      return value;
    }
    if (t === "undefined" || t === "function" || t === "symbol" || t === "bigint") throw new Error(label + " must be JSON-serializable");
    if (Array.isArray(value)) {
      if (seen.has(value)) throw new Error(label + " must not contain cycles");
      seen.add(value);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const out = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error(label + " must not contain sparse arrays");
        out.push(toStrictJsonValue(value[index], label + "[" + index + "]", seen));
      }
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === "length") continue;
        if (typeof key === "string" && /^\d+$/.test(key)) {
          const descriptor = descriptors[key];
          if (descriptor.get || descriptor.set) throw new Error(label + "[" + key + "] must be a data property");
          if (!descriptor.enumerable) throw new Error(label + "[" + key + "] must be enumerable");
          continue;
        }
        throw new Error(label + " arrays must not contain extra properties");
      }
      seen.delete(value);
      return out;
    }
    if (t === "object") {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new Error(label + " must contain only plain JSON objects");
      if (seen.has(value)) throw new Error(label + " must not contain cycles");
      seen.add(value);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const out = {};
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string") throw new Error(label + " must not contain symbol keys");
        const descriptor = descriptors[key];
        if (descriptor.get || descriptor.set) throw new Error(label + "." + key + " must be a data property");
        if (!descriptor.enumerable) throw new Error(label + "." + key + " must be enumerable");
        Object.defineProperty(out, key, {
          value: toStrictJsonValue(descriptor.value, label + "." + key, seen),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      seen.delete(value);
      return out;
    }
    throw new Error(label + " contains an unsupported value type");
  }

  async function parallel(thunks) {
    if (!Array.isArray(thunks) || thunks.some((thunk) => typeof thunk !== "function")) {
      throw new Error("parallel() expects an array of thunk functions, e.g. items.map(x => () => agent(...))");
    }
    const groupId = bridge.createFanoutGroup("parallel");
    let canceled = false;
    const cancelGroup = (err) => {
      if (canceled) return;
      canceled = true;
      bridge.cancelFanoutGroup(groupId, err);
    };
    const branches = thunks.map(async (thunk, index) => {
        try {
          return await bridge.withFanoutWorkspace(groupId, () => thunk());
        } catch (err) {
          cancelGroup(err);
          if (isBudgetOrAbortError(err)) throw err;
          void logFanoutFailure("parallel branch", index, err);
          throw fanoutError("parallel branch", index, err);
        }
      });
    try {
      const results = await Promise.all(branches);
      bridge.closeFanoutGroup(groupId);
      return results;
    } catch (err) {
      void Promise.allSettled(branches).then(() => bridge.closeFanoutGroup(groupId));
      throw err;
    }
  }

  async function pipeline(items, ...stages) {
    if (!Array.isArray(items)) throw new Error("pipeline(items, ...stages) expects items to be an array");
    if (stages.length === 0 || stages.some((stage) => typeof stage !== "function")) throw new Error("pipeline() expects one or more stage functions");
    const results = new Array(items.length);
    let next = 0;
    let failed = false;
    let canceled = false;
    const groupId = bridge.createFanoutGroup("pipeline");
    const cancelGroup = (err) => {
      if (canceled) return;
      canceled = true;
      bridge.cancelFanoutGroup(groupId, err);
    };

    async function worker() {
      while (!failed && next < items.length) {
        const index = next++;
        let current = items[index];
        try {
          for (const stage of stages) current = await bridge.withFanoutWorkspace(groupId, () => stage(current, index));
          results[index] = current;
        } catch (err) {
          failed = true;
          cancelGroup(err);
          if (isBudgetOrAbortError(err)) throw err;
          void logFanoutFailure("pipeline item", index, err);
          throw fanoutError("pipeline item", index, err);
        }
      }
    }

    const workers = Array.from({ length: Math.min(pipelineLimit, items.length) }, () => worker());
    try {
      await Promise.all(workers);
      bridge.closeFanoutGroup(groupId);
      return results;
    } catch (err) {
      void Promise.allSettled(workers).then(() => bridge.closeFanoutGroup(groupId));
      throw err;
    }
  }

  function phase(title) {
    void hostRpc("phase", { title: String(title) }, false).catch(() => undefined);
  }

  function log(message) {
    return hostRpc("log", { message: String(message) }, false);
  }

  function workflow(nameOrRef, args) {
    return trackCriticalOperation("workflow", hostRpc("workflow", { nameOrRef, args }, true).then((payload) => {
      if (payload && typeof payload === "object" && payload.__piWorkflowRpc === "workflowResult") {
        if (typeof payload.budgetSpent === "number" && Number.isFinite(payload.budgetSpent)) budgetSpent = payload.budgetSpent;
        return payload.result;
      }
      return payload;
    }));
  }

  function createBudgetGlobal() {
    return Object.freeze({
      total: budgetTotal,
      spent: () => budgetSpent,
      remaining: () => (budgetTotal === null ? Number.POSITIVE_INFINITY : Math.max(0, budgetTotal - budgetSpent)),
      assertCanStart: () => {
        if (budgetTotal !== null && budgetSpent >= budgetTotal) throw namedError("WorkflowBudgetExceededError", "Workflow token budget exhausted");
      },
    });
  }

  function createConsoleGlobal() {
    const write = (level, values) => {
      const text = values.map(consoleValue).join(" ");
      void hostRpc("log", { message: level === "log" || level === "info" ? text : level + ": " + text }, false).catch(() => undefined);
    };
    return Object.freeze({
      log: (...values) => write("log", values),
      info: (...values) => write("info", values),
      warn: (...values) => write("warn", values),
      error: (...values) => write("error", values),
    });
  }

  function setWorkflowTimeout(fn, ms = 0, ...rest) {
    if (typeof fn !== "function") throw new Error("String timers are not available in workflow scripts");
    return bridge.setTimer(fn, ms, rest);
  }

  function clearWorkflowTimeout(id) {
    bridge.clearTimer(id);
  }

  function consoleValue(value) {
    if (typeof value === "string") return value;
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) return json;
    } catch {
      // Fall through to String().
    }
    return String(value);
  }

  function errorMessage(err) {
    return err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
  }

  function isBudgetOrAbortError(err) {
    return ["WorkflowAbortError", "WorkflowBudgetExceededError", "WorkflowAgentCapError"].includes(err?.name);
  }

  async function logFanoutFailure(kind, index, err) {
    try {
      await bridge.withoutFanoutWorkspace(() => hostRpc("log", { message: kind + " " + index + " failed: " + errorMessage(err) }, false));
    } catch {
      // Preserve the branch/item failure as the primary error.
    }
  }

  function fanoutError(kind, index, err) {
    return namedError("WorkflowFanoutError", kind + " " + index + " failed: " + errorMessage(err));
  }

  function namedError(name, message) {
    const err = new Error(message);
    err.name = name;
    return err;
  }

  function deepFreeze(value, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return value;
    seen.add(value);
    for (const key of Object.keys(value)) deepFreeze(value[key], seen);
    return Object.freeze(value);
  }

  function installConstrainedIntrinsics() {
    const ForbiddenFunction = function ForbiddenFunction() {
      throw new Error("Function constructor is not available in workflow scripts");
    };
    const forbiddenEval = function forbiddenEval() {
      throw new Error("eval is not available in workflow scripts");
    };
    const poisonConstructor = (proto) => {
      try {
        Object.defineProperty(proto, "constructor", { value: ForbiddenFunction, writable: false, configurable: false });
      } catch {
        // Non-critical hardening only.
      }
    };

    poisonConstructor(Function.prototype);
    poisonConstructor(Object.getPrototypeOf(async function () {}));
    poisonConstructor(Object.getPrototypeOf(function* () {}));
    poisonConstructor(Object.getPrototypeOf(async function* () {}));
    Object.defineProperty(ForbiddenFunction, "constructor", { value: ForbiddenFunction, writable: false, configurable: false });

    const workflowMath = Object.create(null);
    for (const key of Reflect.ownKeys(Math)) {
      if (key === "random") continue;
      const descriptor = Object.getOwnPropertyDescriptor(Math, key);
      if (descriptor) Object.defineProperty(workflowMath, key, descriptor);
    }
    Object.defineProperty(workflowMath, "random", {
      value: () => {
        throw new Error("Math.random() is not available in workflow scripts");
      },
      writable: false,
      configurable: false,
    });

    const NativeDate = Date;
    function WorkflowDate(...args) {
      if (!new.target) throw new Error("Date() is not available in workflow scripts; use new Date(value) with explicit args");
      if (args.length === 0) throw new Error("argless new Date() is not available in workflow scripts");
      return Reflect.construct(NativeDate, args, new.target === WorkflowDate ? NativeDate : new.target);
    }
    for (const key of ["parse", "UTC"]) {
      const descriptor = Object.getOwnPropertyDescriptor(NativeDate, key);
      if (descriptor) Object.defineProperty(WorkflowDate, key, descriptor);
    }
    Object.defineProperties(WorkflowDate, {
      now: {
        value: () => {
          throw new Error("Date.now() is not available in workflow scripts");
        },
        writable: false,
        configurable: false,
      },
      prototype: {
        value: NativeDate.prototype,
        writable: false,
        configurable: false,
      },
    });
    try {
      Object.defineProperty(NativeDate.prototype, "constructor", {
        value: WorkflowDate,
        writable: false,
        configurable: false,
      });
    } catch {
      // Non-critical hardening only.
    }
    try {
      Object.setPrototypeOf(WorkflowDate, null);
    } catch {
      // Non-critical hardening only.
    }

    const frozenMath = Object.freeze(workflowMath);
    try {
      Object.setPrototypeOf(frozenMath, null);
    } catch {
      // Non-critical hardening only.
    }

    try {
      Object.freeze(WorkflowDate);
    } catch {
      // Non-critical hardening only.
    }

    Object.defineProperties(globalThis, {
      Date: { value: WorkflowDate, writable: false, configurable: false },
      Math: { value: frozenMath, writable: false, configurable: false },
      Function: { value: ForbiddenFunction, writable: false, configurable: false },
      eval: { value: forbiddenEval, writable: false, configurable: false },
    });
  }

  installConstrainedIntrinsics();

  const budget = createBudgetGlobal();
  const args = deepFreeze(start.args ?? {});

  Object.defineProperties(globalThis, {
    agent: { value: agent, writable: true, configurable: true },
    apply: { value: apply, writable: true, configurable: true },
    parallel: { value: parallel, writable: true, configurable: true },
    pipeline: { value: pipeline, writable: true, configurable: true },
    phase: { value: phase, writable: true, configurable: true },
    log: { value: log, writable: true, configurable: true },
    workflow: { value: workflow, writable: true, configurable: true },
    args: { value: args, writable: false, configurable: false },
    budget: { value: budget, writable: false, configurable: false },
    cwd: { value: String(start.cwd ?? ""), writable: false, configurable: false },
    console: { value: createConsoleGlobal(), writable: false, configurable: false },
    setTimeout: { value: setWorkflowTimeout, writable: false, configurable: false },
    clearTimeout: { value: clearWorkflowTimeout, writable: false, configurable: false },
  });

  return Object.freeze({ assertNoUnhandledCriticalOperations });
})()
`;

function rpc(method, params, { critical }) {
  if (aborted) return Promise.reject(namedError("WorkflowAbortError", "Workflow aborted"));
  const fanoutGroupIds = currentFanoutGroupIds();
  const canceledGroup = firstCanceledFanoutGroup(fanoutGroupIds);
  if (canceledGroup) return Promise.reject(canceledGroup.error);
  const id = nextRpcId++;
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  waiters.set(id, { resolve, reject, critical, method, promise, fanoutGroupIds });
  promise.then(
    () => waiters.delete(id),
    () => waiters.delete(id),
  );
  send({ type: "request", id, method, critical, fanoutGroupIds, params: toJsonValue(params) });
  return promise;
}

function createFanoutGroup(kind) {
  const id = nextFanoutGroupId++;
  fanoutGroups.set(id, { id, kind, canceled: false, error: undefined });
  return id;
}

function cancelFanoutGroup(groupId, reason) {
  const group = fanoutGroups.get(Number(groupId));
  if (!group || group.canceled) return false;
  group.canceled = true;
  group.error = namedError("WorkflowAbortError", `Workflow ${group.kind} canceled: ${reason?.message ?? String(reason ?? "fanout failed")}`);
  for (const waiter of waiters.values()) {
    if (waiter.fanoutGroupIds?.includes(group.id)) waiter.reject(group.error);
  }
  send({ type: "cancel", fanoutGroupId: group.id, reason: serializeError(group.error) });
  return true;
}

function closeFanoutGroup(groupId) {
  fanoutGroups.delete(Number(groupId));
}

function currentFanoutGroupIds() {
  const ids = fanoutContext.getStore()?.fanoutGroupIds;
  return Array.isArray(ids) ? ids.filter((id) => Number.isSafeInteger(id)) : [];
}

function firstCanceledFanoutGroup(groupIds) {
  for (const id of groupIds) {
    const group = fanoutGroups.get(id);
    if (group?.canceled) return group;
  }
  return undefined;
}

async function drainNonCritical() {
  const pending = [...waiters.values()].filter((waiter) => !waiter.critical).map((waiter) => waiter.promise);
  if (pending.length === 0) return;
  let timer;
  await Promise.race([
    Promise.allSettled(pending),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Workflow returned before non-critical log operations flushed")), 2_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

function rejectAll(err) {
  for (const waiter of waiters.values()) waiter.reject(err);
  waiters.clear();
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function shutdown(code) {
  clearInterval(heartbeat);
  rl.close();
  process.stdout.write("", () => process.exit(code));
  setTimeout(() => process.exit(code), 250).unref?.();
}

function clearAllTimers(timers) {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

function namedError(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}

function serializeError(err) {
  return {
    name: err?.name ?? "Error",
    message: err?.message ?? String(err),
  };
}

function toJsonValue(value, seen = new Set()) {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") {
    if (!Number.isFinite(value)) throw new Error(`Non-finite number is not JSON: ${value}`);
    return value;
  }
  if (t === "undefined") return null;
  if (t === "bigint" || t === "symbol" || t === "function") throw new Error(`Value is not JSON-serializable: ${t}`);
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("Cannot serialize cyclic arrays");
    seen.add(value);
    const out = value.map((item) => toJsonValue(item, seen));
    seen.delete(value);
    return out;
  }
  if (t === "object") {
    if (seen.has(value)) throw new Error("Cannot serialize cyclic objects");
    seen.add(value);
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child !== undefined) out[key] = toJsonValue(child, seen);
    }
    seen.delete(value);
    return out;
  }
  throw new Error(`Unsupported value type: ${t}`);
}
