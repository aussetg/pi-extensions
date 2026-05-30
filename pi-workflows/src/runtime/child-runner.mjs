import vm from "node:vm";
import readline from "node:readline";
import { AsyncLocalStorage } from "node:async_hooks";

const BRIDGE_GLOBAL = "__piWorkflowBridge";
const START_GLOBAL = "__piWorkflowStart";
const FANOUT_AGENT_DEFAULT_ISOLATION = "worktree";

const waiters = new Map();
const isolationContext = new AsyncLocalStorage();

let nextRpcId = 1;
let aborted = false;
let heartbeat;
let budgetTotal = null;
let pipelineLimit = 50;

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

void main();

async function main() {
  const start = await waitForStart();
  budgetTotal = typeof start.budgetTotal === "number" ? start.budgetTotal : null;
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

  await runtime.flush();
  await drainNonCritical();

  const critical = [...waiters.values()].filter((waiter) => waiter.critical);
  if (critical.length > 0) {
    throw new Error(`Workflow returned with ${critical.length} pending agent/workflow operation(s). Await agent() and workflow() calls before returning.`);
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

    currentIsolation() {
      return isolationContext.getStore()?.defaultIsolation;
    },

    withFanoutIsolation(fn) {
      return isolationContext.run({ defaultIsolation: FANOUT_AGENT_DEFAULT_ISOLATION }, fn);
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

  let budgetSpent = 0;
  const budgetTotal = typeof start.budgetTotal === "number" ? start.budgetTotal : null;
  const pipelineLimit = Number.isInteger(start.pipelineLimit) && start.pipelineLimit > 0 ? start.pipelineLimit : 50;

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

  function defaultIsolation() {
    return bridge.currentIsolation();
  }

  async function agent(prompt, opts = {}) {
    const rawOpts = isRecord(opts) ? opts : {};
    const contextualIsolation = defaultIsolation();
    const effectiveOpts = rawOpts.isolation === undefined && contextualIsolation ? { ...rawOpts, isolation: contextualIsolation } : rawOpts;
    const payload = await hostRpc("agent", { prompt, opts: effectiveOpts }, true);
    if (payload && typeof payload === "object" && payload.__piWorkflowRpc === "agentResult") {
      if (typeof payload.budgetSpent === "number" && Number.isFinite(payload.budgetSpent)) budgetSpent = payload.budgetSpent;
      return payload.result;
    }
    return payload;
  }

  async function parallel(thunks) {
    if (!Array.isArray(thunks) || thunks.some((thunk) => typeof thunk !== "function")) {
      throw new Error("parallel() expects an array of thunk functions, e.g. items.map(x => () => agent(...))");
    }
    return await Promise.all(
      thunks.map(async (thunk, index) => {
        try {
          return await bridge.withFanoutIsolation(() => thunk());
        } catch (err) {
          if (isBudgetOrAbortError(err)) throw err;
          await hostRpc("log", { message: "parallel branch " + index + " failed: " + errorMessage(err) }, false);
          return null;
        }
      }),
    );
  }

  async function pipeline(items, ...stages) {
    if (!Array.isArray(items)) throw new Error("pipeline(items, ...stages) expects items to be an array");
    if (stages.length === 0 || stages.some((stage) => typeof stage !== "function")) throw new Error("pipeline() expects one or more stage functions");
    const results = new Array(items.length);
    let next = 0;

    async function worker() {
      while (next < items.length) {
        const index = next++;
        let current = items[index];
        try {
          for (const stage of stages) current = await bridge.withFanoutIsolation(() => stage(current, index));
          results[index] = current;
        } catch (err) {
          if (isBudgetOrAbortError(err)) throw err;
          await hostRpc("log", { message: "pipeline item " + index + " failed: " + errorMessage(err) }, false);
          results[index] = null;
        }
      }
    }

    const workers = Array.from({ length: Math.min(pipelineLimit, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  function phase(title) {
    void hostRpc("phase", { title: String(title) }, false).catch(() => undefined);
  }

  function log(message) {
    return hostRpc("log", { message: String(message) }, false);
  }

  function workflow(nameOrRef, args) {
    return hostRpc("workflow", { nameOrRef, args }, true);
  }

  function createUiGlobal() {
    let chain = Promise.resolve();
    const enqueue = (work) => {
      chain = chain.then(work);
      return chain;
    };
    const observe = (promise) => {
      promise.catch(() => undefined);
      return promise;
    };
    const dashboard = (doc) => {
      observe(enqueue(() => hostRpc("ui.dashboard", { doc }, false)));
      return { id: "dashboard" };
    };

    return Object.freeze({
      define: (spec) => {
        if (isDashboardDefineInput(spec)) return dashboard(spec);
        const id = spec && typeof spec === "object" ? spec.id : undefined;
        observe(enqueue(() => hostRpc("ui.define", { spec }, false)));
        return { id };
      },
      update: (...updateArgs) => {
        const [viewId, state] = updateArgs;
        if (updateArgs.length === 1 && isRecord(viewId)) return dashboard(viewId);
        return observe(enqueue(() => hostRpc("ui.update", { viewId, state }, false)));
      },
      dashboard,
      help: () => "Prefer ui.dashboard({ title, progress, metrics, charts, tables, sections }); repeated calls update the same default dashboard. Strict API: ui.define({ version: 1, id, title, initialState, layout }); ui.update(id, state). Workflow scripts are top-level async JS; do not use export default, globalThis, Date.now(), or Math.random().",
      patch: (viewId, patch) => observe(enqueue(() => hostRpc("ui.patch", { viewId, patch }, false))),
      close: (viewId) => {
        observe(enqueue(() => hostRpc("ui.close", { viewId }, false)));
        return { id: viewId };
      },
      __flush: () => chain,
    });
  }

  function isDashboardDefineInput(input) {
    if (!isRecord(input)) return false;
    if (hasOwn(input, "version")) return false;
    if (hasOwn(input, "layout")) return false;
    return ["title", "status", "summary", "progress", "metrics", "sections", "charts", "tables"].some((key) => hasOwn(input, key));
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

  function installDeterministicIntrinsics() {
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

    const deterministicMath = Object.create(Math);
    Object.defineProperty(deterministicMath, "random", {
      value: () => {
        throw new Error("Math.random() is not deterministic in workflow scripts");
      },
      writable: false,
      configurable: false,
    });

    class DeterministicDate extends Date {
      constructor(...args) {
        if (args.length === 0) throw new Error("argless new Date() is not deterministic in workflow scripts");
        super(...args);
      }
      static now() {
        throw new Error("Date.now() is not deterministic in workflow scripts");
      }
    }

    Object.defineProperties(globalThis, {
      Date: { value: DeterministicDate, writable: false, configurable: false },
      Math: { value: Object.freeze(deterministicMath), writable: false, configurable: false },
      Function: { value: ForbiddenFunction, writable: false, configurable: false },
      eval: { value: forbiddenEval, writable: false, configurable: false },
    });
  }

  installDeterministicIntrinsics();

  const ui = createUiGlobal();
  const budget = createBudgetGlobal();
  const args = deepFreeze(start.args ?? {});

  Object.defineProperties(globalThis, {
    agent: { value: agent, writable: true, configurable: true },
    parallel: { value: parallel, writable: true, configurable: true },
    pipeline: { value: pipeline, writable: true, configurable: true },
    phase: { value: phase, writable: true, configurable: true },
    log: { value: log, writable: true, configurable: true },
    workflow: { value: workflow, writable: true, configurable: true },
    ui: { value: ui, writable: false, configurable: false },
    args: { value: args, writable: false, configurable: false },
    budget: { value: budget, writable: false, configurable: false },
    cwd: { value: String(start.cwd ?? ""), writable: false, configurable: false },
    console: { value: createConsoleGlobal(), writable: false, configurable: false },
    setTimeout: { value: setWorkflowTimeout, writable: false, configurable: false },
    clearTimeout: { value: clearWorkflowTimeout, writable: false, configurable: false },
  });

  return Object.freeze({
    flush: () => ui.__flush(),
  });
})()
`;

function rpc(method, params, { critical }) {
  if (aborted) return Promise.reject(namedError("WorkflowAbortError", "Workflow aborted"));
  const id = nextRpcId++;
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  waiters.set(id, { resolve, reject, critical, method, promise });
  promise.then(
    () => waiters.delete(id),
    () => waiters.delete(id),
  );
  send({ type: "request", id, method, critical, params: toJsonValue(params) });
  return promise;
}

async function drainNonCritical() {
  const pending = [...waiters.values()].filter((waiter) => !waiter.critical).map((waiter) => waiter.promise);
  if (pending.length === 0) return;
  let timer;
  await Promise.race([
    Promise.allSettled(pending),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Workflow returned before non-critical log/UI operations flushed")), 2_000);
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
