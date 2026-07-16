import { fork, type ChildProcess } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseStructuredWorkflow } from "../src/definition/workflow-definition.js";
import { createMetricHandle } from "../src/measurements/metrics.js";
import {
  ControlExecutionLimitError,
  evaluateControlDefinition,
} from "../src/runtime/control-worker-host.js";

const children = new Set<ChildProcess>();

afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
});

describe("workflow control process", () => {
  it("completes normally with frozen arguments, globals, and only the final Flow API", async () => {
    const result = await execute(controlSource("ambient-control", `
      let codeGeneration;
      try { Function("return 1")(); } catch (error) { codeGeneration = error.name; }
      return {
        value: args.value,
        argsFrozen: Object.isFrozen(args) && Object.isFrozen(args.nested),
        globalsFrozen: Object.isFrozen(Object.prototype) && Object.isFrozen(Array.prototype) && Object.isFrozen(Math),
        ambient: {
          process: typeof process,
          require: typeof require,
          fs: typeof fs,
          fetch: typeof fetch,
          websocket: typeof WebSocket,
          timer: typeof setTimeout,
          clock: typeof Date,
          intl: typeof Intl,
          random: typeof Math.random,
        },
        codeGeneration,
        methods: Object.keys(flow).sort(),
        subflow: typeof flow.subflow,
        genericEffect: typeof flow.effect,
      };
    `), {}, { value: 7, nested: { ok: true } });

    expect(result).toEqual({
      value: 7,
      argsFrozen: true,
      globalsFrozen: true,
      ambient: {
        process: "undefined",
        require: "undefined",
        fs: "undefined",
        fetch: "undefined",
        websocket: "undefined",
        timer: "undefined",
        clock: "undefined",
        intl: "undefined",
        random: "undefined",
      },
      codeGeneration: "EvalError",
      methods: [
        "accept", "agent", "apply", "candidate", "checkpoint", "command", "fanOut", "loop", "measure",
        "metric", "parallel", "recordExperiment", "reject", "snapshot", "stage", "verify",
      ],
      subflow: "undefined",
      genericEffect: "undefined",
    });
  });

  it("never exposes a host-realm constructor through control values or bridges", async () => {
    const hostError = new Error("host failure");
    const result = await execute(controlSource("realm-control", `
      const key = "constructor";
      const escape = value => {
        try {
          const OuterConstructor = value[key];
          const OuterFunction = OuterConstructor[key];
          OuterFunction("return process")();
          return "escaped";
        } catch (error) {
          return error.name;
        }
      };
      const response = await flow.stage("response", async () => null);
      const callback = await flow.stage("callback", async value => escape(value));
      let failure;
      try { await flow.stage("failure", async () => null); }
      catch (error) { failure = escape(error); }
      const metric = flow.metric("throughput", { direction: "maximize", primary: true });
      return {
        args: escape(args.items),
        response: escape(response.items),
        callback,
        failure,
        metricMethod: escape(metric.summary),
        flowMethod: escape(__flowHostApi.stage),
      };
    `), {
      stage: async (id: string, body: (value?: unknown) => Promise<unknown>) => {
        if (id === "response") return { items: ["host"] };
        if (id === "callback") return await body(["callback"]);
        throw hostError;
      },
      metric: (id: unknown, definition: unknown) => createMetricHandle(id, definition),
    }, { items: ["argument"] });

    expect(result).toEqual({
      args: "EvalError",
      response: "EvalError",
      callback: "EvalError",
      failure: "EvalError",
      metricMethod: "EvalError",
      flowMethod: "EvalError",
    });
  });

  it("contains computed constructor access accepted by the workflow language", async () => {
    const parsed = parseStructuredWorkflow(`
      export default defineWorkflow({
        name: "computed-constructor",
        description: "Control-realm isolation regression.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["items"],
          properties: { items: { type: "array", maxItems: 4, items: { type: "integer" } } },
        },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["blocked"],
          properties: { blocked: { type: "string", enum: ["EvalError"] } },
        },
        capabilities: [],
        modelVisible: false,
        async run(flow, args) {
          const key = "constructor";
          try {
            const OuterArray = args.items[key];
            const OuterFunction = OuterArray[key];
            OuterFunction("return process")();
            return { blocked: "escaped" };
          } catch (error) {
            return { blocked: error.name };
          }
        },
      });
    `);

    await expect(execute(parsed.executableSource, {}, { items: [1] })).resolves.toEqual({ blocked: "EvalError" });
  });

  it("propagates callback scope through stage and parallel branches", async () => {
    const storage = new AsyncLocalStorage<string>();
    const flow = {
      stage: async (id: string, body: () => Promise<unknown>) => await storage.run(`stage:${id}`, body),
      parallel: async (_id: string, branches: Record<string, () => Promise<unknown>>) => Object.fromEntries(
        await Promise.all(Object.entries(branches).map(async ([key, body]) => [key, await storage.run(`branch:${key}`, body)])),
      ),
      agent: async (id: string) => ({ id, context: storage.getStore() }),
    };
    const result = await evaluateControlDefinition({
      executableSource: controlSource("callback-control", `
        const staged = await flow.stage("outer", async () => await flow.agent("inside-stage", { profile: "x", prompt: "x" }));
        const parallel = await flow.parallel("branches", {
          alpha: async () => await flow.agent("alpha", { profile: "x", prompt: "x" }),
          beta: async () => await flow.agent("beta", { profile: "x", prompt: "x" }),
        });
        return { staged, parallel };
      `),
      workflowName: "callback-control",
      flow,
      args: {},
      signal: new AbortController().signal,
      rootContext: "root",
      currentContext: () => storage.getStore() ?? "missing",
      runInContext: (context, body) => storage.run(context, body),
    });
    expect(result).toEqual({
      staged: { id: "inside-stage", context: "stage:outer" },
      parallel: {
        alpha: { id: "alpha", context: "branch:alpha" },
        beta: { id: "beta", context: "branch:beta" },
      },
    });
  });

  it("mirrors synchronous metric handles without exposing host objects", async () => {
    const result = await execute(controlSource("metric-control", `
      const metric = flow.metric("throughput", { direction: "maximize", primary: true });
      return { baseline: metric.baseline, summary: metric.summary() };
    `), {
      metric: (id: unknown, definition: unknown) => createMetricHandle(id, definition),
    });
    expect(result).toEqual({
      baseline: null,
      summary: { baseline: null, current: null, best: null, relativeGain: null, observationCount: 0 },
    });
  });

  it("preserves thrown control errors and exact host errors", async () => {
    await expect(execute(controlSource("throw-control", `throw new TypeError("control failed");`), {}))
      .rejects.toMatchObject({ name: "TypeError", message: "control failed" });

    const hostError = new Error("host failed");
    const execution = execute(controlSource("host-throw-control", `
      try { await flow.stage("fail", async () => null); }
      catch (error) { throw error; }
    `), { stage: async () => { throw hostError; } });
    await expect(execution).rejects.toBe(hostError);
  });

  it("uses one initialization handshake and rejects malformed messages without an unknown-message race", async () => {
    const child = spawnWorker();
    const messages: any[] = [];
    const done = new Promise<any>((resolve, reject) => {
      child.on("error", reject);
      child.on("message", (message: any) => {
        messages.push(message);
        if (message.type === "host-call") {
          child.send({
            type: "host-response",
            requestId: message.requestId,
            metricStates: [],
            value: { type: "undefined" },
            unexpected: true,
          });
        }
        if (message.type === "done") resolve(message);
      });
    });
    child.send(initializeMessage("malformed-control", `await flow.stage("wait", async () => null);`));
    const terminal = await done;

    expect(messages.filter((message) => message.type === "initialized")).toEqual([
      { type: "initialized", protocolVersion: 1 },
    ]);
    expect(terminal.error.message).toMatch(/unexpected fields/);
  });

  it("terminates a synchronous infinite loop without blocking the host", async () => {
    let hostTimerFired = false;
    const hostTimer = setTimeout(() => { hostTimerFired = true; }, 20);
    try {
      const execution = execute(controlSource("stuck-control", `
        await flow.stage("start", async () => null);
        for (;;) {}
      `), { stage: async (_id: string, body: () => Promise<unknown>) => await body() }, {}, { segmentTimeoutMs: 75 });
      await expect(execution).rejects.toBeInstanceOf(ControlExecutionLimitError);
      expect(hostTimerFired).toBe(true);
    } finally {
      clearTimeout(hostTimer);
    }
  }, 5_000);

  it("contains control heap exhaustion inside the child process", async () => {
    let hostTimerFired = false;
    const hostTimer = setTimeout(() => { hostTimerFired = true; }, 20);
    try {
      const execution = execute(controlSource("memory-control", `
        await flow.stage("start", async () => null);
        return new Array(50_000_000).fill(1);
      `), { stage: async (_id: string, body: () => Promise<unknown>) => await body() }, {}, { segmentTimeoutMs: 2_000 });
      await expect(execution).rejects.toBeInstanceOf(ControlExecutionLimitError);
      expect(hostTimerFired).toBe(true);
    } finally {
      clearTimeout(hostTimer);
    }
  }, 10_000);

  it("aborts promptly while a host call is still pending", async () => {
    const controller = new AbortController();
    const execution = evaluateControlDefinition({
      executableSource: controlSource("abort-control", `await flow.stage("pending", async () => null);`),
      workflowName: "abort-control",
      flow: { stage: async () => await new Promise(() => {}) },
      args: {},
      signal: controller.signal,
      rootContext: "root",
      currentContext: () => "root",
      runInContext: (_context, body) => body(),
    });
    const reason = new Error("cancelled by test");
    setTimeout(() => controller.abort(reason), 20);
    await expect(execution).rejects.toBe(reason);
  });

  it("reports a worker crash while a host operation is active", async () => {
    const execution = execute(controlSource("crash-control", `await flow.stage("pending", async () => null);`), {
      stage: async () => await new Promise((resolve) => setTimeout(resolve, 1_000)),
    }, {}, {
      onControlStart: (pid) => setImmediate(() => process.kill(pid, "SIGKILL")),
    });
    await expect(execution).rejects.toMatchObject({
      name: "ControlExecutionError",
      message: expect.stringMatching(/exited before completion/),
    });
  });
});

function execute(
  executableSource: string,
  flow: Record<string, unknown>,
  args: Record<string, unknown> = {},
  options: { segmentTimeoutMs?: number; onControlStart?: (pid: number) => void } = {},
): Promise<unknown> {
  const controller = new AbortController();
  const name = executableSource.match(/name:\s*"([a-z0-9_-]+)"/)?.[1];
  if (!name) throw new Error("Control test source has no name");
  return evaluateControlDefinition({
    executableSource,
    workflowName: name,
    flow,
    args,
    signal: controller.signal,
    rootContext: "root",
    currentContext: () => "root",
    runInContext: (_context, body) => body(),
    ...options,
  });
}

function controlSource(name: string, body: string): string {
  return `
    const __flowDefinition = defineWorkflow({
      name: ${JSON.stringify(name)},
      async run(flow, args) {
        ${body}
      },
    });
  `;
}

function spawnWorker(): ChildProcess {
  const child = fork(fileURLToPath(new URL("../src/runtime/control-worker.js", import.meta.url)), [], {
    stdio: ["ignore", "ignore", "pipe", "ipc", "pipe"],
    serialization: "advanced",
  });
  child.stderr?.resume();
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function initializeMessage(name: string, body: string): Record<string, unknown> {
  return {
    type: "initialize",
    protocolVersion: 1,
    executableSource: controlSource(name, body),
    workflowName: name,
    args: { type: "object", entries: [] },
    segmentTimeoutMs: 1_000,
    definitionOnly: false,
  };
}
