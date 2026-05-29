import vm from "node:vm";
import readline from "node:readline";
import { inspect } from "node:util";

const waiters = new Map();
let nextId = 1;
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
    if (msg.error?.stack) err.stack = msg.error.stack;
    waiter.reject(err);
  }
}

async function runWorkflow(source, startGlobals) {
  const timers = new Set();
  const ui = createUiGlobal();
  const globals = {
    agent: (prompt, opts = {}) => agent(prompt, opts),
    parallel,
    pipeline,
    phase: (title) => {
      void rpc("phase", { title: String(title) }, { critical: false }).catch(() => undefined);
    },
    log: (message) => rpc("log", { message: String(message) }, { critical: false }),
    workflow: (nameOrRef, args) => rpc("workflow", { nameOrRef, args }, { critical: true }),
    ui,
    args: Object.freeze(toJsonValue(startGlobals.args)),
    budget: createBudgetGlobal(),
    cwd: startGlobals.cwd,
    console: createConsoleGlobal(),
    setTimeout: (fn, ms = 0, ...rest) => {
      if (typeof fn !== "function") throw new Error("String timers are not available in workflow scripts");
      const timer = setTimeout(() => {
        timers.delete(timer);
        fn(...rest);
      }, Math.min(Math.max(Number(ms) || 0, 0), 60_000));
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timers.delete(timer);
      clearTimeout(timer);
    },
  };

  const sandbox = Object.create(null);
  Object.assign(sandbox, globals);
  sandbox.Date = DeterministicDate;
  sandbox.Math = deterministicMath();
  sandbox.Function = function ForbiddenFunction() {
    throw new Error("Function constructor is not available in workflow scripts");
  };
  sandbox.eval = function forbiddenEval() {
    throw new Error("eval is not available in workflow scripts");
  };

  const context = vm.createContext(sandbox, {
    name: "pi-workflow-child",
    codeGeneration: { strings: false, wasm: false },
  });
  const script = new vm.Script(`"use strict";\n(async () => {\n${source}\n})()`, { filename: "workflow.js" });
  const result = await script.runInContext(context, { timeout: 1000 });

  await ui.__flush();
  await drainNonCritical();

  const critical = [...waiters.values()].filter((waiter) => waiter.critical);
  if (critical.length > 0) {
    throw new Error(`Workflow returned with ${critical.length} pending agent/workflow operation(s). Await agent() and workflow() calls before returning.`);
  }
  if (timers.size > 0) {
    for (const timer of timers) clearTimeout(timer);
    throw new Error(`Workflow returned with ${timers.size} pending timer(s). Await explicit promises instead of leaving timers behind.`);
  }

  return result;
}

async function agent(prompt, opts = {}) {
  const payload = await rpc("agent", { prompt, opts }, { critical: true });
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
        return await thunk();
      } catch (err) {
        if (isBudgetOrAbortError(err)) throw err;
        await rpc("log", { message: `parallel branch ${index} failed: ${err.message ?? String(err)}` }, { critical: false });
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
        for (const stage of stages) current = await stage(current, index);
        results[index] = current;
      } catch (err) {
        if (isBudgetOrAbortError(err)) throw err;
        await rpc("log", { message: `pipeline item ${index} failed: ${err.message ?? String(err)}` }, { critical: false });
        results[index] = null;
      }
    }
  }

  const workers = Array.from({ length: Math.min(pipelineLimit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
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
    observe(enqueue(() => rpc("ui.dashboard", { doc }, { critical: false })));
    return { id: "dashboard" };
  };

  return {
    define: (spec) => {
      if (isDashboardDefineInput(spec)) return dashboard(spec);
      const id = spec && typeof spec === "object" ? spec.id : undefined;
      observe(enqueue(() => rpc("ui.define", { spec }, { critical: false })));
      return { id };
    },
    update: (...updateArgs) => {
      const [viewId, state] = updateArgs;
      if (updateArgs.length === 1 && isRecord(viewId)) return dashboard(viewId);
      return observe(enqueue(() => rpc("ui.update", { viewId, state }, { critical: false })));
    },
    dashboard,
    help: () => "Prefer ui.dashboard({ title, progress, metrics, charts, tables, sections }); repeated calls update the same default dashboard. Strict API: ui.define({ version: 1, id, title, initialState, layout }); ui.update(id, state). Workflow scripts are top-level async JS; do not use export default, globalThis, Date.now(), or Math.random().",
    patch: (viewId, patch) => observe(enqueue(() => rpc("ui.patch", { viewId, patch }, { critical: false }))),
    close: (viewId) => {
      observe(enqueue(() => rpc("ui.close", { viewId }, { critical: false })));
      return { id: viewId };
    },
    __flush: () => chain,
  };
}

function isDashboardDefineInput(input) {
  if (!isRecord(input)) return false;
  if (hasOwn(input, "version")) return false;
  if (hasOwn(input, "layout")) return false;
  return ["title", "status", "summary", "progress", "metrics", "sections"].some((key) => hasOwn(input, key));
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
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
    const text = values.map((value) => (typeof value === "string" ? value : inspect(value, { depth: 4, colors: false }))).join(" ");
    void rpc("log", { message: level === "log" || level === "info" ? text : `${level}: ${text}` }, { critical: false }).catch(() => undefined);
  };
  return Object.freeze({
    log: (...values) => write("log", values),
    info: (...values) => write("info", values),
    warn: (...values) => write("warn", values),
    error: (...values) => write("error", values),
  });
}

function rpc(method, params, { critical }) {
  if (aborted) return Promise.reject(namedError("WorkflowAbortError", "Workflow aborted"));
  const id = nextId++;
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

function deterministicMath() {
  const math = Object.create(Math);
  Object.defineProperty(math, "random", {
    value: () => {
      throw new Error("Math.random() is not deterministic in workflow scripts");
    },
  });
  return math;
}

class DeterministicDate extends Date {
  constructor(...args) {
    if (args.length === 0) throw new Error("argless new Date() is not deterministic in workflow scripts");
    super(...args);
  }
  static now() {
    throw new Error("Date.now() is not deterministic in workflow scripts");
  }
}

function isBudgetOrAbortError(err) {
  return ["WorkflowAbortError", "WorkflowBudgetExceededError", "WorkflowAgentCapError"].includes(err?.name);
}

function namedError(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
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
