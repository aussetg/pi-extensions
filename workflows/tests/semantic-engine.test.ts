import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseStructuredWorkflow } from "../src/definition/workflow-definition.js";
import { RunDatabase } from "../src/persistence/run-database.js";
import { readWorkflowRunProjection } from "../src/projection/run-projection.js";
import { createOpaqueCandidateWorkspace } from "../src/candidates/refs.js";
import { CandidateConcurrencyGuard } from "../src/runtime/semantic-engine-concurrency.js";
import type { RunRecord } from "../src/runtime/durable-types.js";
import {
  executeSequentialSemanticRun,
  semanticInvocationHash,
  SemanticEngineCrashError,
  type SemanticEffectAdapter,
  type SemanticEffectRequest,
  type SemanticEngineInvocation,
  type SequentialSemanticEngineOptions,
} from "../src/runtime/semantic-engine.js";
import type { JsonValue } from "../src/types.js";
import { sha256, stableHash } from "../src/utils/hashes.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("sequential semantic engine", () => {
  it("executes effects sequentially through root and nested stage scopes", async () => {
    const fixture = createFixture(`
      const nested = await flow.stage("outer", async () => {
        const one = await flow.agent("one", { profile: "builtin:researcher", prompt: "one" });
        return await flow.stage("inner", async () => {
          const two = await flow.agent("two", { profile: "builtin:researcher", prompt: "two" });
          return one + two;
        });
      });
      const final = await flow.agent("final", { profile: "builtin:researcher", prompt: "final" });
      return { nested, final };
    `);
    const calls: string[] = [];
    const adapter = agentAdapter(async (request) => {
      calls.push(request.sourceId);
      return valueResult({ one: 1, two: 2, final: 4 }[request.sourceId]!);
    });

    const outcome = await fixture.execute(adapter);
    expect(outcome).toMatchObject({ status: "completed", result: { nested: 3, final: 4 } });
    expect(calls).toEqual(["one", "two", "final"]);
    const operations = fixture.database.listOperations({ limit: 32 });
    expect(operations.map((operation) => [operation.ordinal, operation.path, operation.status])).toEqual([
      [0, "run/stage:outer", "completed"],
      [1, "run/stage:outer/agent:one", "completed"],
      [2, "run/stage:outer/stage:inner", "completed"],
      [3, "run/stage:outer/stage:inner/agent:two", "completed"],
      [4, "run/agent:final", "completed"],
    ]);
    expect(operations[1]!.parentOperationId).toBe(operations[0]!.operationId);
    expect(operations[3]!.parentOperationId).toBe(operations[2]!.operationId);
    expect(readWorkflowRunProjection(fixture.database)).toMatchObject({
      status: "completed",
      operationCounts: { completed: 5 },
    });
    expect(readWorkflowRunProjection(fixture.database).currentOperationId).toBeUndefined();
  });

  it("records effect, enclosing-stage, and run failures without dispatching later work", async () => {
    const fixture = createFixture(`
      await flow.stage("work", async () => {
        await flow.agent("first", { profile: "builtin:researcher", prompt: "first" });
        await flow.agent("broken", { profile: "builtin:researcher", prompt: "broken" });
        await flow.agent("never", { profile: "builtin:researcher", prompt: "never" });
      });
      return { ok: true };
    `);
    const calls: string[] = [];
    const outcome = await fixture.execute(agentAdapter(async (request) => {
      calls.push(request.sourceId);
      if (request.sourceId === "broken") throw new Error("provider exploded");
      return valueResult(true);
    }));

    expect(outcome).toMatchObject({ status: "failed", error: "provider exploded" });
    expect(calls).toEqual(["first", "broken"]);
    expect(fixture.database.listOperations({ limit: 16 }).map((operation) => [operation.path, operation.status])).toEqual([
      ["run/stage:work", "failed"],
      ["run/stage:work/agent:first", "completed"],
      ["run/stage:work/agent:broken", "failed"],
    ]);
    expect(fixture.database.readRun()).toMatchObject({
      status: "failed",
      reason: { category: "workflow", code: "workflow-failed", summary: "provider exploded" },
      error: { kind: "workflow-error" },
    });
  });

  it("waits at a durable checkpoint and resumes from its exact response", async () => {
    const fixture = createFixture(`
      const before = await flow.agent("before", { profile: "builtin:researcher", prompt: "before" });
      const approved = await flow.checkpoint("review", { kind: "confirm", prompt: "Continue?" });
      const after = await flow.agent("after", { profile: "builtin:researcher", prompt: "after" });
      return { before, approved, after };
    `, ["read-project", "human-input"]);
    const calls: string[] = [];
    const adapter = agentAdapter(async (request) => {
      calls.push(request.sourceId);
      return valueResult(request.sourceId);
    });

    const waiting = await fixture.execute(adapter);
    expect(waiting.status).toBe("waiting");
    const projection = readWorkflowRunProjection(fixture.database);
    expect(projection).toMatchObject({
      status: "waiting",
      phaseTree: expect.arrayContaining([
        expect.objectContaining({ path: "run/checkpoint:review", status: "waiting" }),
      ]),
      checkpoints: [expect.objectContaining({ status: "waiting" })],
    });
    const checkpoint = fixture.database.readHumanCheckpoint(
      fixture.database.listOperations({ limit: 16 }).find((operation) => operation.kind === "checkpoint")!
        .operationId.replace(/^operation_/, "checkpoint_"),
    );
    // Checkpoint ids and operation ids use the same deterministic digest body.
    expect(checkpoint).toBeDefined();
    respondToCheckpoint(fixture.database, checkpoint!.checkpointId, checkpoint!.challengeHash, true);

    const completed = await fixture.execute(adapter);
    expect(completed).toMatchObject({
      status: "completed",
      result: { before: "before", approved: true, after: "after" },
    });
    expect(calls).toEqual(["before", "after"]);
    expect(fixture.database.readHumanCheckpoint(checkpoint!.checkpointId)).toMatchObject({
      status: "completed",
      response: true,
    });
  });

  it("propagates pause cancellation to the one active effect and resumes it", async () => {
    const fixture = createFixture(`
      const value = await flow.agent("slow", { profile: "builtin:researcher", prompt: "slow" });
      return { value };
    `);
    let announce!: () => void;
    const started = new Promise<void>((resolve) => { announce = resolve; });
    let cancelled = false;
    const blocking = agentAdapter(async (request) => {
      announce();
      return await new Promise<never>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => {
          cancelled = true;
          reject(request.signal.reason);
        }, { once: true });
      });
    });
    const active = fixture.execute(blocking);
    await started;
    consumeControl(fixture.database, { kind: "pause", reason: "inspect it" });
    await expect(active).resolves.toMatchObject({ status: "paused" });
    expect(cancelled).toBe(true);
    expect(fixture.database.listOperations({ limit: 4 })[0]).toMatchObject({ status: "paused" });

    consumeControl(fixture.database, { kind: "resume" }, "request_resume");
    const completed = await fixture.execute(agentAdapter(async () => valueResult(9)));
    expect(completed).toMatchObject({ status: "completed", result: { value: 9 } });
    expect(fixture.database.listOperations({ limit: 4 })[0]).toMatchObject({ status: "completed" });
  });

  it("propagates a full stop to the active effect and settles the run", async () => {
    const fixture = createFixture(`
      await flow.agent("slow", { profile: "builtin:researcher", prompt: "slow" });
      return { unreachable: true };
    `);
    let announce!: () => void;
    const started = new Promise<void>((resolve) => { announce = resolve; });
    let cancelled = false;
    const active = fixture.execute(agentAdapter(async (request) => {
      announce();
      return await new Promise<never>((_resolve, reject) => request.signal.addEventListener("abort", () => {
        cancelled = true;
        reject(request.signal.reason);
      }, { once: true }));
    }));
    await started;
    consumeControl(fixture.database, { kind: "stop", reason: "cancel the run" });
    expect(await active).toMatchObject({ status: "stopped", run: { reason: { code: "stopped" } } });
    expect(cancelled).toBe(true);
  });

  it("turns targeted active-effect cancellation into a stopped sequential run", async () => {
    const fixture = createFixture(`
      await flow.agent("target", { profile: "builtin:researcher", prompt: "target" });
      return { unreachable: true };
    `);
    let announce!: (operationId: string) => void;
    const started = new Promise<string>((resolve) => { announce = resolve; });
    const active = fixture.execute(agentAdapter(async (request) => {
      announce(request.operation.operationId);
      return await new Promise<never>((_resolve, reject) => request.signal.addEventListener("abort", () => {
        reject(request.signal.reason);
      }, { once: true }));
    }));
    const operationId = await started;
    consumeControl(fixture.database, { kind: "stop-effect", operationId, reason: "replace this effect" });

    expect(await active).toMatchObject({ status: "stopped" });
    expect(fixture.database.readOperation(operationId)).toMatchObject({
      status: "stopped",
      reason: { code: "effect-stopped" },
    });
  });

  it("replays committed effects after a crash instead of dispatching them twice", async () => {
    const fixture = createFixture(`
      const value = await flow.agent("once", { profile: "builtin:researcher", prompt: "once" });
      return { value };
    `);
    let calls = 0;
    let crash = true;
    await expect(fixture.execute(agentAdapter(async () => {
      calls++;
      return valueResult(42);
    }), {
      faultInjector: (point) => {
        if (point === "after-operation-completion" && crash) {
          crash = false;
          throw new SemanticEngineCrashError("power loss after commit");
        }
      },
    })).rejects.toBeInstanceOf(SemanticEngineCrashError);
    expect(fixture.database.readRun().status).toBe("running");
    expect(fixture.database.listOperations({ limit: 4 })[0]).toMatchObject({ status: "completed", result: { value: 42 } });

    const completed = await fixture.execute(agentAdapter(async () => {
      calls++;
      return valueResult(99);
    }));
    expect(completed).toMatchObject({ status: "completed", result: { value: 42 } });
    expect(calls).toBe(1);

    const idempotent = await fixture.execute(agentAdapter(async () => {
      calls++;
      return valueResult(100);
    }));
    expect(idempotent).toMatchObject({ status: "completed", result: { value: 42 } });
    expect(calls).toBe(1);
  });

  it("re-dispatches an uncommitted effect after a crash at its running boundary", async () => {
    const fixture = createFixture(`
      const value = await flow.agent("retry", { profile: "builtin:researcher", prompt: "retry" });
      return { value };
    `);
    let calls = 0;
    await expect(fixture.execute(agentAdapter(async () => {
      calls++;
      throw new SemanticEngineCrashError("worker and coordinator died");
    }))).rejects.toBeInstanceOf(SemanticEngineCrashError);
    expect(fixture.database.readRun().status).toBe("running");
    expect(fixture.database.listOperations({ limit: 4 })[0]).toMatchObject({ status: "running" });

    const completed = await fixture.execute(agentAdapter(async () => {
      calls++;
      return valueResult("recovered");
    }));
    expect(completed).toMatchObject({ status: "completed", result: { value: "recovered" } });
    expect(calls).toBe(2);
    expect(fixture.database.listOperations({ limit: 4 })[0]!.path).toBe("run/agent:retry");
  });

  it("preclaims parallel branches, enforces the machine ceiling, and normalizes replay ordinals", async () => {
    const body = `
      const values = await flow.parallel("work", {
        alpha: async () => {
          const first = await flow.agent("first", { profile: "builtin:researcher", prompt: "alpha first" });
          const second = await flow.agent("second", { profile: "builtin:researcher", prompt: "alpha second" });
          return first + second;
        },
        beta: async () => {
          const first = await flow.agent("first", { profile: "builtin:researcher", prompt: "beta first" });
          const second = await flow.agent("second", { profile: "builtin:researcher", prompt: "beta second" });
          return first + second;
        },
      }, { concurrency: 4 });
      return values;
    `;
    const execute = async (delays: Record<string, number>) => {
      const fixture = createFixture(body, ["read-project"], { concurrency: 2, maxParallelism: 4 });
      let active = 0;
      let maximum = 0;
      const outcome = await fixture.execute(agentAdapter(async (request) => {
        active++;
        maximum = Math.max(maximum, active);
        await sleep(delays[request.path] ?? 0);
        active--;
        return valueResult(request.sourceId);
      }));
      expect(outcome.status).toBe("completed");
      expect(maximum).toBe(2);
      return fixture.database.listOperations({ limit: 32 }).map((operation) => [operation.ordinal, operation.path]);
    };

    const alphaSlow = await execute({
      "run/parallel:work/branch:alpha/agent:first": 30,
      "run/parallel:work/branch:beta/agent:first": 1,
    });
    const betaSlow = await execute({
      "run/parallel:work/branch:alpha/agent:first": 1,
      "run/parallel:work/branch:beta/agent:first": 30,
    });
    expect(alphaSlow).toEqual(betaSlow);
    expect(alphaSlow).toEqual([
      [0, "run/parallel:work"],
      [1, "run/parallel:work/branch:alpha"],
      [2, "run/parallel:work/branch:alpha/agent:first"],
      [3, "run/parallel:work/branch:alpha/agent:second"],
      [4, "run/parallel:work/branch:beta"],
      [5, "run/parallel:work/branch:beta/agent:first"],
      [6, "run/parallel:work/branch:beta/agent:second"],
    ]);
  });

  it("keeps collect failures branch-local and fail-fast cancellation structured", async () => {
    const collected = createFixture(`
      const values = await flow.parallel("checks", {
        broken: async () => flow.agent("inspect", { profile: "builtin:researcher", prompt: "broken" }),
        good: async () => flow.agent("inspect", { profile: "builtin:researcher", prompt: "good" }),
      }, { concurrency: 2, failure: "collect" });
      return values;
    `, ["read-project"], { concurrency: 2, maxParallelism: 2 });
    const collectedOutcome = await collected.execute(agentAdapter(async (request) => {
      if (request.path.includes("branch:broken")) throw new Error("bad branch");
      return valueResult("ok");
    }));
    expect(collectedOutcome).toMatchObject({
      status: "completed",
      result: {
        broken: { ok: false, failure: { operationPath: "run/parallel:checks/branch:broken/agent:inspect", kind: "agent", summary: "bad branch" } },
        good: { ok: true, value: "ok" },
      },
    });
    expect(collected.database.readStructuredQueue(
      collected.database.listOperations({ limit: 16 }).find((operation) => operation.kind === "parallel")!.operationId,
    )).toMatchObject({ counts: { completed: 1, failed: 1 } });

    const failFast = createFixture(`
      await flow.parallel("checks", {
        broken: async () => flow.agent("inspect", { profile: "builtin:researcher", prompt: "broken" }),
        slow: async () => flow.agent("inspect", { profile: "builtin:researcher", prompt: "slow" }),
      }, { concurrency: 2, failure: "fail-fast" });
      return { unreachable: true };
    `, ["read-project"], { concurrency: 2, maxParallelism: 2 });
    let starts = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });
    let slowCancelled = false;
    const failed = await failFast.execute(agentAdapter(async (request) => {
      starts++;
      if (starts === 2) release();
      await bothStarted;
      if (request.path.includes("branch:broken")) throw new Error("stop siblings");
      return await new Promise<never>((_resolve, reject) => request.signal.addEventListener("abort", () => {
        slowCancelled = true;
        reject(request.signal.reason);
      }, { once: true }));
    }));
    expect(failed).toMatchObject({ status: "failed", error: "stop siblings" });
    expect(slowCancelled).toBe(true);
  });

  it("runs keyed fan-out in input order while projecting a deterministic item queue", async () => {
    const fixture = createFixture(`
      const values = await flow.fanOut("packages", [
        { id: "zeta", value: 3 },
        { id: "alpha", value: 1 },
        { id: "middle", value: 2 },
      ], {
        key: item => item.id,
        concurrency: 3,
        failure: "collect",
      }, async item => flow.agent("inspect", {
        profile: "builtin:researcher",
        prompt: item.id,
      }));
      return { values };
    `, ["read-project"], { concurrency: 2, maxParallelism: 3 });
    const outcome = await fixture.execute(agentAdapter(async (request) => {
      if (request.path.includes("item:middle")) throw new Error("middle failed");
      return valueResult(request.path.includes("item:zeta") ? "z" : "a");
    }));
    expect(outcome).toMatchObject({
      status: "completed",
      result: { values: [{ ok: true, value: "z" }, { ok: true, value: "a" }, { ok: false }] },
    });
    const fanOut = fixture.database.listOperations({ limit: 16 }).find((operation) => operation.kind === "fan-out")!;
    expect(fixture.database.readStructuredQueue(fanOut.operationId)?.children.map((child) => child.path)).toEqual([
      "run/fan-out:packages/item:zeta",
      "run/fan-out:packages/item:alpha",
      "run/fan-out:packages/item:middle",
    ]);
  });

  it("replays loop iterations after a crash and evaluates the condition at the durable frontier", async () => {
    const fixture = createFixture(`
      let count = 0;
      const loop = await flow.loop("repeat", {
        maxIterations: 5,
        while: () => ({ result: count < 3, label: "need three" }),
      }, async ({ iteration }) => {
        await flow.agent("step", { profile: "builtin:researcher", prompt: String(iteration) });
        count += 1;
        return count;
      });
      return { count, loop };
    `);
    let calls = 0;
    let crash = true;
    await expect(fixture.execute(agentAdapter(async () => {
      calls++;
      return valueResult(true);
    }), {
      faultInjector: (point, operation) => {
        if (crash && point === "after-operation-completion" && operation?.kind === "agent") {
          crash = false;
          throw new SemanticEngineCrashError("crash in loop");
        }
      },
    })).rejects.toBeInstanceOf(SemanticEngineCrashError);

    const outcome = await fixture.execute(agentAdapter(async () => {
      calls++;
      return valueResult(true);
    }));
    expect(outcome).toMatchObject({
      status: "completed",
      result: { count: 3, loop: { iterations: 3, last: 3, stoppedBy: "condition" } },
    });
    expect(calls).toBe(3);
    const loop = fixture.database.listOperations({ limit: 32 }).find((operation) => operation.kind === "loop")!;
    const projection = fixture.database.readStructuredQueue(loop.operationId)!;
    expect(projection.counts).toEqual({ completed: 3 });
    expect(projection.children[0]).toMatchObject({ path: "run/loop:repeat/iteration:000000" });
  });

  it("pauses runaway admission without cancelling an already-launched effect", async () => {
    const fixture = createFixture(`
      await flow.parallel("agents", {
        alpha: async () => flow.agent("work", { profile: "builtin:researcher", prompt: "alpha" }),
        beta: async () => flow.agent("work", { profile: "builtin:researcher", prompt: "beta" }),
      }, { concurrency: 2 });
      return { unreachable: true };
    `, ["read-project"], { concurrency: 2, maxParallelism: 2, maximumAgentLaunches: 1 });
    let calls = 0;
    let activeWasCancelled = false;
    const outcome = await fixture.execute(agentAdapter(async (request) => {
      calls++;
      request.signal.addEventListener("abort", () => { activeWasCancelled = true; }, { once: true });
      await sleep(25);
      return valueResult("settled");
    }));
    expect(outcome).toMatchObject({
      status: "paused",
      run: { reason: { category: "safety", code: "agent-launch-runaway" } },
    });
    expect(calls).toBe(1);
    expect(activeWasCancelled).toBe(false);
    expect(fixture.database.listOperations({ limit: 16 }).find((operation) => operation.kind === "agent")).toMatchObject({
      status: "completed",
    });
  });

  it("pauses at the operation guard and rejects shared mutable workspaces across branches", async () => {
    const runaway = createFixture(`
      await flow.loop("many", {
        maxIterations: 3,
        while: () => ({ result: true, label: "continue" }),
      }, async () => flow.agent("step", { profile: "builtin:researcher", prompt: "step" }));
      return { unreachable: true };
    `);
    const paused = await runaway.execute(agentAdapter(async () => valueResult(true)), { operationAdmissionLimit: 2 });
    expect(paused).toMatchObject({ status: "paused", run: { reason: { code: "operation-runaway" } } });

    const runId = "flow_workspace_guard";
    const descriptor = createOpaqueCandidateWorkspace(createWorkspaceDescriptor(runId));
    const guard = new CandidateConcurrencyGuard(runId);
    guard.assertSafe({ workspace: descriptor }, new Map([["parallel_test", "alpha"]]));
    expect(() => guard.assertSafe(
      { workspace: descriptor },
      new Map([["parallel_test", "beta"]]),
    )).toThrow("cannot be shared by concurrent branches");
  });

  it("settles parallel cancellation races before returning the paused projection", async () => {
    const fixture = createFixture(`
      await flow.parallel("slow", {
        alpha: async () => flow.agent("wait", { profile: "builtin:researcher", prompt: "alpha" }),
        beta: async () => flow.agent("wait", { profile: "builtin:researcher", prompt: "beta" }),
      }, { concurrency: 2 });
      return { unreachable: true };
    `, ["read-project"], { concurrency: 2, maxParallelism: 2 });
    let starts = 0;
    let announce!: () => void;
    const started = new Promise<void>((resolve) => { announce = resolve; });
    let cancellations = 0;
    const active = fixture.execute(agentAdapter(async (request) => {
      starts++;
      if (starts === 2) announce();
      return await new Promise<never>((_resolve, reject) => request.signal.addEventListener("abort", () => {
        cancellations++;
        reject(request.signal.reason);
      }, { once: true }));
    }));
    await started;
    consumeControl(fixture.database, { kind: "pause", reason: "hold" });
    expect(await active).toMatchObject({ status: "paused" });
    expect(cancellations).toBe(2);
    expect(fixture.database.listOperations({ limit: 16 }).filter((operation) => operation.status === "running")).toEqual([]);
  });
});

interface FixtureOptions {
  concurrency?: number;
  maxParallelism?: number;
  maximumAgentLaunches?: number;
}

function createFixture(
  body: string,
  capabilities = ["read-project"] as RunRecord["workflow"]["capabilities"],
  options: FixtureOptions = {},
) {
  const source = workflowSource(body, capabilities, options.maxParallelism ?? 1);
  const parsed = parseStructuredWorkflow(source);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-engine-"));
  roots.push(root);
  const runId = `flow_${crypto.randomBytes(16).toString("hex")}`;
  const runDir = path.join(root, runId);
  fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true, mode: 0o700 });
  const definitionHash = stableHash({ sourceHash: parsed.sourceHash, metadata: parsed.metadata });
  const invocation: SemanticEngineInvocation = {
    workflowId: "builtin:fixture",
    definitionHash,
    input: {},
    inputHash: stableHash({}),
  };
  const createdAt = new Date().toISOString();
  const run: RunRecord = {
    runId,
    revision: 1,
    workflow: {
      id: "builtin:fixture",
      name: parsed.metadata.name,
      sourceHash: parsed.sourceHash,
      definitionHash,
      capabilities: parsed.metadata.capabilities,
    },
    invocationHash: semanticInvocationHash(invocation),
    projectSnapshotHash: sha256("project"),
    routeSnapshotHash: sha256("routes"),
    contextIdentityHash: sha256("context"),
    status: "queued",
    safety: {
      concurrency: options.concurrency ?? 1,
      maximumAgentLaunches: options.maximumAgentLaunches ?? 100,
      memoryBytes: 512 * 1024 * 1024,
      tasks: 64,
      cpuQuotaPercent: 100,
      cpuWeight: 100,
      outputBytes: 4 * 1024 * 1024,
      commandTimeoutMs: 60_000,
    },
    usage: zeroUsage(),
    createdAt,
    updatedAt: createdAt,
  };
  const database = RunDatabase.create(path.join(runDir, "run.sqlite"), { run });
  return {
    runDir,
    database,
    execute: (adapter: SemanticEffectAdapter, options: SequentialSemanticEngineOptions = {}) => executeSequentialSemanticRun(
      runDir, database, parsed, invocation, [adapter], { controlPollIntervalMs: 5, ...options },
    ),
  };
}

function workflowSource(
  body: string,
  capabilities: RunRecord["workflow"]["capabilities"],
  maxParallelism: number,
): string {
  return `
export default defineWorkflow({
  name: "fixture",
  description: "Sequential semantic engine fixture.",
  inputSchema: { type: "object", additionalProperties: false },
  outputSchema: { type: "object" },
  capabilities: ${JSON.stringify(capabilities)},
  modelVisible: false,
  maxParallelism: ${maxParallelism},
  async run(flow, args) {
    void args;
    ${body}
  },
});
`;
}

function agentAdapter(execute: (request: SemanticEffectRequest) => Promise<ReturnType<typeof valueResult>>): SemanticEffectAdapter {
  return {
    kind: "agent",
    semanticInput: ({ input }) => input as JsonValue,
    journalIdentity: ({ input, run }) => ({
      semanticKey: stableHash({ input, contextIdentityHash: run.contextIdentityHash }),
      completionAuthority: "finish-work",
      replayPolicy: "immutable",
    }),
    execute,
  };
}

function valueResult(value: JsonValue) {
  return { result: { value, artifacts: [] }, usage: zeroUsage(), completionAuthority: "finish-work" as const };
}

function zeroUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    providerRequests: 0,
    cost: 0,
    elapsedMs: 0,
    complete: true,
  };
}

function createWorkspaceDescriptor(runId: string) {
  return {
    runId,
    logicalPath: "run/candidate:shared",
    attempt: 1,
    root: "/tmp/shared",
    cwd: "/tmp/shared",
    base: "launch-snapshot" as const,
    baseTreeHash: sha256("tree"),
    baseLineageHash: sha256("lineage"),
    writeScopeHash: sha256("scope"),
  };
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

type Control =
  | { kind: "pause"; reason?: string }
  | { kind: "resume" }
  | { kind: "stop"; reason?: string }
  | { kind: "stop-effect"; operationId: string; reason?: string };

function consumeControl(database: RunDatabase, control: Control, requestId = `request_${control.kind}`): void {
  const run = database.readRun();
  database.enqueueControlRequest({
    requestId,
    runId: run.runId,
    expectedRevision: run.revision,
    requestedAt: new Date().toISOString(),
    actor: "human:test",
    ...control,
  });
  database.processCoordinatorControlRequest(database.readRun().revision, requestId, new Date().toISOString());
}

function respondToCheckpoint(
  database: RunDatabase,
  checkpointId: string,
  challengeHash: string,
  value: JsonValue,
): void {
  const run = database.readRun();
  const requestId = "request_checkpoint_response";
  database.enqueueControlRequest({
    requestId,
    runId: run.runId,
    expectedRevision: run.revision,
    requestedAt: new Date().toISOString(),
    actor: "human:test",
    kind: "checkpoint-response",
    checkpointId,
    challengeHash,
    value,
  });
  database.processCoordinatorControlRequest(database.readRun().revision, requestId, new Date().toISOString());
}
