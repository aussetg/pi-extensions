import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseWorkflowV17 } from "../src/definition/workflow-v17-frontend.js";
import { createWorkflowV17InvocationSnapshot } from "../src/persistence/workflow-v17-invocation.js";
import { WorkflowRunDatabaseV17 } from "../src/persistence/run-database-v17.js";
import { defaultWorkflowV17RegistryPolicy } from "../src/registry/workflow-v17-policy.js";
import {
  workflowV17DefinitionHash,
  type WorkflowV17DefinitionRef,
} from "../src/registry/structured-workflows-v17.js";
import { WorkflowV17CausalReplay } from "../src/runtime/causal-replay-v17.js";
import {
  WorkflowV17RecordedStructuralError,
  WorkflowV17SemanticDriftError,
  WorkflowV17SemanticEngine,
  WorkflowV17SemanticEngineCrashError,
  type WorkflowV17EffectAdapterContext,
  type WorkflowV17EffectIdentity,
  type WorkflowV17SemanticEffectAdapter,
  type WorkflowV17SemanticEngineFaultPoint,
  type WorkflowV17SequentialFlow,
} from "../src/runtime/semantic-engine-v17.js";
import type { JsonObject, JsonValue } from "../src/types.js";
import { sha256, stableHash } from "../src/utils/hashes.js";

const API = path.resolve("workflow-api.d.ts");
const BASE_TIME = Date.parse("2026-09-01T12:00:00.000Z");
const roots: string[] = [];
const closeables = new Set<{ close(): void }>();

const SOURCE = `
import { schema as s, workflow } from "pi/workflows";
export default workflow({
  description: "Exercise keyed structured concurrency.",
  input: s.object({ value: s.string() }),
  output: s.json(),
  async run(_flow, _args) { return {}; },
});
`;
const PARSED = parseWorkflowV17(SOURCE, {
  fileName: "/virtual/structured.flow.ts",
  apiPath: API,
});

afterEach(() => {
  for (const value of closeables) value.close();
  closeables.clear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("workflow v17 structured concurrency", () => {
  it("runs fixed parallel lanes with stable keyed scopes and output order", async () => {
    const fixture = createFixture("flow_v17_parallel");
    const adapter = new StructuredAdapter();
    const outcome = await new WorkflowV17SemanticEngine(fixture.database, [adapter], {
      now: clock(),
    }).run(async (flow) => await flow.parallel({
      architecture: async () => await call(flow, "architecture", 1, 15),
      tests: async () => await call(flow, "tests", 2, 1),
    }, { sourceSite: "site-parallel", concurrency: 2 }));

    expect(outcome).toMatchObject({
      status: "completed",
      result: { architecture: { value: 2 }, tests: { value: 3 } },
    });
    const group = fixture.database.listOperations().find((operation) => operation.kind === "parallel")!;
    expect(fixture.database.listChildScopes(group.operationId).map((scope) => [scope.laneKey, scope.status]))
      .toEqual([["architecture", "completed"], ["tests", "completed"]]);
    expect(fixture.database.readStructuralJoin(group.operationId)?.outputOrder)
      .toEqual(["architecture", "tests"]);
    expect(adapter.maximumActive).toBe(2);
    fixture.database.validateIntegrity();
  });

  it("persists the same keyed structure under both sibling completion permutations", async () => {
    const shapes: JsonValue[] = [];
    for (const [leftDelay, rightDelay] of [[20, 1], [1, 20]] as const) {
      const fixture = createFixture(`flow_v17_permutation_${leftDelay}`);
      const outcome = await new WorkflowV17SemanticEngine(fixture.database, [new StructuredAdapter()], {
        now: clock(),
      }).run(async flow => await flow.parallel({
        left: async () => await call(flow, "left", 1, leftDelay),
        right: async () => await call(flow, "right", 2, rightDelay),
      }, { sourceSite: "site-permutations", concurrency: 2 }));
      expect(outcome).toMatchObject({
        status: "completed",
        result: { left: { value: 2 }, right: { value: 3 } },
      });
      const group = fixture.database.listOperations().find((operation) => operation.kind === "parallel")!;
      shapes.push({
        scopes: fixture.database.listChildScopes(group.operationId).map(scope => ({
          path: scope.path.replace(fixture.database.readRun().runId, "<run>"),
          key: scope.laneKey!,
          status: scope.status,
        })),
        order: fixture.database.readStructuralJoin(group.operationId)!.outputOrder,
        outcomes: fixture.database.readStructuralJoin(group.operationId)!.lanes.map(lane => ({
          key: lane.laneKey,
          outcome: lane.outcome,
        })),
      });
      fixture.database.validateIntegrity();
    }
    expect(shapes[1]).toEqual(shapes[0]);
  });

  it("maps with bounded execution while preserving item output order", async () => {
    const fixture = createFixture("flow_v17_map");
    const adapter = new StructuredAdapter();
    const items = [
      { key: "a", value: 1, delay: 20 },
      { key: "b", value: 2, delay: 1 },
      { key: "c", value: 3, delay: 10 },
      { key: "d", value: 4, delay: 1 },
    ];
    const outcome = await new WorkflowV17SemanticEngine(fixture.database, [adapter], {
      now: clock(),
    }).run(async (flow) => ({
      values: await flow.map(items, async item => await call(
        flow,
        (item as JsonObject).key as string,
        (item as JsonObject).value as number,
        (item as JsonObject).delay as number,
      ), {
        sourceSite: "site-map",
        key: item => (item as JsonObject).key as string,
        concurrency: 2,
      }),
    }));

    expect(outcome).toMatchObject({
      status: "completed",
      result: { values: [{ value: 2 }, { value: 3 }, { value: 4 }, { value: 5 }] },
    });
    expect(adapter.maximumActive).toBe(2);
    const group = fixture.database.listOperations().find((operation) => operation.kind === "map")!;
    expect(fixture.database.readStructuralJoin(group.operationId)?.outputOrder).toEqual(["a", "b", "c", "d"]);
    fixture.database.validateIntegrity();
  });

  it("collects failed lanes as typed results and preserves successful siblings", async () => {
    const fixture = createFixture("flow_v17_collect");
    const adapter = new StructuredAdapter({ failures: new Set(["bad"]) });
    const outcome = await new WorkflowV17SemanticEngine(fixture.database, [adapter], {
      now: clock(),
    }).run(async (flow) => await flow.parallel({
      good: async () => await call(flow, "good", 2),
      bad: async () => await call(flow, "bad", 0),
    }, { sourceSite: "site-collect", errors: "collect", concurrency: 2 }));

    expect(outcome).toMatchObject({
      status: "completed",
      result: {
        good: { ok: true, value: { value: 3 } },
        bad: { ok: false, error: { kind: "command", summary: "physical failure bad", evidence: [] } },
      },
    });
    const group = fixture.database.listOperations().find((operation) => operation.kind === "parallel")!;
    expect(fixture.database.readStructuralJoin(group.operationId)?.lanes.map((lane) => [lane.laneKey, lane.outcome]))
      .toEqual([["good", "success"], ["bad", "failure"]]);
    expect(adapter.executions.get("good")).toBe(1);
    fixture.database.validateIntegrity();
  });

  it("durably fails fail-fast structures, cancels siblings, and continues through ordinary catch", async () => {
    const fixture = createFixture("flow_v17_fail_fast");
    const adapter = new StructuredAdapter({ failures: new Set(["bad"]) });
    const outcome = await new WorkflowV17SemanticEngine(fixture.database, [adapter], {
      now: clock(),
    }).run(failFastProgram);

    expect(outcome).toMatchObject({ status: "completed", result: { caught: true, after: 10 } });
    const operations = fixture.database.listOperations();
    const group = operations.find((operation) => operation.kind === "parallel")!;
    expect(group.status).toBe("failed");
    expect(fixture.database.readScopeCall(group.operationId)).toMatchObject({
      outcome: "failure",
      completionAuthority: "structural-join",
      replayPolicy: "never",
    });
    expect(fixture.database.readStructuralJoin(group.operationId)?.lanes.map((lane) => lane.outcome))
      .toEqual(["failure", "cancelled"]);
    const downstream = operations.find((operation) => operation.scopeId === fixture.database.readRun().rootScopeId
      && operation.cursor === 1)!;
    expect(fixture.database.readScopeCall(downstream.operationId)?.previousCallKey).toBe(group.callKey);
    fixture.database.validateIntegrity();
  });

  it("retains a sibling effect settlement that finishes while its lane is being cancelled", async () => {
    const fixture = createFixture("flow_v17_cancelled_settlement");
    const adapter = new StructuredAdapter({
      failures: new Set(["bad"]),
      ignoreAbort: new Set(["settled"]),
    });
    const outcome = await new WorkflowV17SemanticEngine(fixture.database, [adapter], {
      now: clock(),
    }).run(async flow => {
      let caught = false;
      try {
        await flow.parallel({
          sibling: async () => await call(flow, "settled", 1, 20),
          bad: async () => await call(flow, "bad", 0),
        }, { sourceSite: "site-cancelled-settlement", concurrency: 2 });
      } catch (error) {
        if (!(error instanceof WorkflowV17RecordedStructuralError)) throw error;
        caught = true;
      }
      return { caught };
    });

    expect(outcome).toMatchObject({ status: "completed", result: { caught: true } });
    const settled = fixture.database.listOperations().find(operation => operation.path.includes("branch:sibling"))!;
    expect(settled.status).toBe("completed");
    expect(fixture.database.readEffectSettlement(settled.operationId)?.outcome).toBe("success");
    expect(fixture.database.readScopeCall(settled.operationId)?.outcome).toBe("success");
    expect(fixture.database.readScope(settled.scopeId)?.status).toBe("cancelled");
    expect(adapter.executions.get("settled")).toBe(1);
    fixture.database.validateIntegrity();
  });

  it("reconstructs successful structures after a crash at every durable boundary", async () => {
    const points: WorkflowV17SemanticEngineFaultPoint[] = [];
    {
      const fixture = createFixture("flow_v17_structure_points");
      await new WorkflowV17SemanticEngine(fixture.database, [new StructuredAdapter()], {
        now: clock(),
        faultInjector: (point) => { points.push(point); },
      }).run(successfulParallelProgram);
    }
    expect(points).toContain("after-child-scopes-preclaimed");
    expect(points).toContain("after-lane-scope-complete");
    expect(points).toContain("after-structural-join");

    for (let crashIndex = 0; crashIndex < points.length; crashIndex++) {
      const fixture = createFixture(`flow_v17_structure_crash_${crashIndex}`);
      const adapter = new StructuredAdapter();
      let transition = 0;
      await expect(new WorkflowV17SemanticEngine(fixture.database, [adapter], {
        now: clock(),
        faultInjector: (point, operation) => {
          if (transition++ === crashIndex) throw new WorkflowV17SemanticEngineCrashError(point, operation?.path);
        },
      }).run(successfulParallelProgram)).rejects.toBeInstanceOf(WorkflowV17SemanticEngineCrashError);
      expect(await new WorkflowV17SemanticEngine(fixture.database, [adapter], {
        now: clock(200),
      }).run(successfulParallelProgram)).toMatchObject({
        status: "completed",
        result: { left: { value: 2 }, right: { value: 3 } },
      });
      expect([...adapter.executions.entries()].sort()).toEqual([["left", 1], ["right", 1]]);
      fixture.database.validateIntegrity();
    }
  });

  it("recovers failed and cancelled lanes at every fail-fast structural boundary", async () => {
    for (const target of [
      "after-lane-scope-failure",
      "after-lane-scope-cancelled",
      "after-structural-join",
    ] as const) {
      const fixture = createFixture(`flow_v17_fail_fast_${target.replaceAll("-", "_")}`);
      const adapter = new StructuredAdapter({ failures: new Set(["bad"]) });
      let crashed = false;
      await expect(new WorkflowV17SemanticEngine(fixture.database, [adapter], {
        now: clock(),
        faultInjector: (point) => {
          if (!crashed && point === target) {
            crashed = true;
            throw new WorkflowV17SemanticEngineCrashError(point);
          }
        },
      }).run(failFastProgram)).rejects.toBeInstanceOf(WorkflowV17SemanticEngineCrashError);
      expect(crashed).toBe(true);
      expect(await new WorkflowV17SemanticEngine(fixture.database, [adapter], {
        now: clock(200),
      }).run(failFastProgram)).toMatchObject({ status: "completed", result: { caught: true, after: 10 } });
      expect(adapter.executions.get("bad")).toBe(1);
      expect(adapter.executions.get("after")).toBe(1);
      fixture.database.validateIntegrity();
    }
  });

  it("causally reuses an unchanged sibling while a changed lane and downstream call execute fresh", async () => {
    const source = createFixture("flow_v17_parallel_replay_source");
    await new WorkflowV17SemanticEngine(source.database, [new StructuredAdapter()], {
      now: clock(),
    }).run(flow => replayProgram(flow, 1));

    const target = createFixture("flow_v17_parallel_replay_target");
    const replay = track(await WorkflowV17CausalReplay.open({
      sourceRunDir: source.root,
      targetRunDir: target.root,
      target: target.database,
    }));
    const adapter = new StructuredAdapter();
    const outcome = await new WorkflowV17SemanticEngine(target.database, [adapter], {
      now: clock(200), replay,
    }).run(flow => replayProgram(flow, 20));

    expect(outcome).toMatchObject({
      status: "completed",
      result: { lanes: { changed: { value: 21 }, stable: { value: 3 } }, after: 10 },
    });
    expect([...adapter.executions.entries()].sort()).toEqual([["after", 1], ["changed", 1]]);
    const stable = target.database.listOperations().find((operation) => operation.path.includes("branch:stable"))!;
    expect(target.database.readScopeCall(stable.operationId)?.replay?.sourceRunId)
      .toBe(source.database.readRun().runId);
    fixtureIntegrity(source, target);
  });

  it("executes failed structural joins fresh and ends downstream replay eligibility", async () => {
    const source = createFixture("flow_v17_failed_join_source");
    await new WorkflowV17SemanticEngine(source.database, [new StructuredAdapter({
      failures: new Set(["bad"]),
    })], { now: clock() }).run(failFastProgram);

    const target = createFixture("flow_v17_failed_join_target");
    const replay = track(await WorkflowV17CausalReplay.open({
      sourceRunDir: source.root,
      targetRunDir: target.root,
      target: target.database,
    }));
    const adapter = new StructuredAdapter({ failures: new Set(["bad"]) });
    expect(await new WorkflowV17SemanticEngine(target.database, [adapter], {
      now: clock(200), replay,
    }).run(failFastProgram)).toMatchObject({ status: "completed", result: { caught: true, after: 10 } });
    expect(adapter.executions.get("bad")).toBe(1);
    expect(adapter.executions.get("after")).toBe(1);
    const group = target.database.listOperations().find(operation => operation.kind === "parallel")!;
    const groupCall = target.database.readScopeCall(group.operationId)!;
    expect(groupCall).toMatchObject({
      outcome: "failure",
      replayPolicy: "never",
    });
    expect(groupCall.replay).toBeUndefined();
    fixtureIntegrity(source, target);
  });

  it("reuses keyed map lanes across reorder/removal while recomputing the parent join", async () => {
    const source = createFixture("flow_v17_map_replay_source");
    await new WorkflowV17SemanticEngine(source.database, [new StructuredAdapter()], {
      now: clock(),
    }).run(flow => mapReplayProgram(flow, ["a", "b", "c"]));

    const target = createFixture("flow_v17_map_replay_target");
    const replay = track(await WorkflowV17CausalReplay.open({
      sourceRunDir: source.root,
      targetRunDir: target.root,
      target: target.database,
    }));
    const adapter = new StructuredAdapter();
    const outcome = await new WorkflowV17SemanticEngine(target.database, [adapter], {
      now: clock(200), replay,
    }).run(flow => mapReplayProgram(flow, ["b", "a"]));

    expect(outcome).toMatchObject({
      status: "completed",
      result: { lanes: [{ value: 3 }, { value: 2 }], after: 10 },
    });
    expect([...adapter.executions.entries()]).toEqual([["after", 1]]);
    const group = target.database.listOperations().find((operation) => operation.kind === "map")!;
    expect(target.database.readStructuralJoin(group.operationId)?.outputOrder).toEqual(["b", "a"]);
    fixtureIntegrity(source, target);
  });

  it("supports nested keyed structures without deadlocking the host effect ceiling", async () => {
    const fixture = createFixture("flow_v17_nested", 2);
    const adapter = new StructuredAdapter();
    const outcome = await new WorkflowV17SemanticEngine(fixture.database, [adapter], {
      now: clock(),
    }).run(async flow => await flow.parallel({
      left: async () => await flow.map([
        { key: "a", value: 1 }, { key: "b", value: 2 },
      ], async item => await call(flow, (item as JsonObject).key as string, (item as JsonObject).value as number), {
        sourceSite: "site-nested-map",
        key: item => (item as JsonObject).key as string,
        concurrency: 2,
      }),
      right: async () => await call(flow, "right", 3),
    }, { sourceSite: "site-nested-parallel", concurrency: 2 }));

    expect(outcome).toMatchObject({
      status: "completed",
      result: { left: [{ value: 2 }, { value: 3 }], right: { value: 4 } },
    });
    expect(adapter.maximumActive).toBeLessThanOrEqual(2);
    expect(fixture.database.listScopes().filter((scope) => scope.kind !== "root")).toHaveLength(4);
    fixture.database.validateIntegrity();
  });

  it("rejects duplicate map keys and same-run structural policy drift before effects execute", async () => {
    const duplicate = createFixture("flow_v17_duplicate_keys");
    const duplicateAdapter = new StructuredAdapter();
    expect(await new WorkflowV17SemanticEngine(duplicate.database, [duplicateAdapter], {
      now: clock(),
    }).run(async flow => await flow.map(["a", "a"], async item => item, {
      sourceSite: "site-duplicate-map",
      key: item => item as string,
    }))).toMatchObject({ status: "failed", failure: { summary: "Duplicate workflow v17 map lane a" } });
    expect(duplicate.database.listOperations()).toHaveLength(0);

    const drift = createFixture("flow_v17_structure_drift");
    const adapter = new StructuredAdapter();
    await expect(new WorkflowV17SemanticEngine(drift.database, [adapter], {
      now: clock(),
      faultInjector: (point) => {
        if (point === "after-child-scopes-preclaimed") throw new WorkflowV17SemanticEngineCrashError(point);
      },
    }).run(successfulParallelProgram)).rejects.toBeInstanceOf(WorkflowV17SemanticEngineCrashError);
    await expect(new WorkflowV17SemanticEngine(drift.database, [adapter], {
      now: clock(200),
    }).run(async flow => await flow.parallel({
      left: async () => await call(flow, "left", 1),
      right: async () => await call(flow, "right", 2),
    }, { sourceSite: "site-success-parallel", concurrency: 1, errors: "collect" })))
      .rejects.toBeInstanceOf(WorkflowV17SemanticDriftError);
  });
});

class StructuredAdapter implements WorkflowV17SemanticEffectAdapter {
  readonly kind = "command" as const;
  readonly executions = new Map<string, number>();
  readonly failures: Set<string>;
  readonly ignoreAbort: Set<string>;
  active = 0;
  maximumActive = 0;

  constructor(options: { failures?: Set<string>; ignoreAbort?: Set<string> } = {}) {
    this.failures = options.failures ?? new Set();
    this.ignoreAbort = options.ignoreAbort ?? new Set();
  }

  semanticInput(context: Omit<WorkflowV17EffectAdapterContext, "semanticInput" | "operation">): JsonValue {
    return structuredClone(context.input as JsonValue);
  }

  journalIdentity(context: WorkflowV17EffectAdapterContext): WorkflowV17EffectIdentity {
    return {
      semanticKey: stableHash({ formatVersion: 1, kind: "structured-command", input: context.semanticInput }),
      completionAuthority: "host-effect",
      replayPolicy: "immutable",
    };
  }

  async execute(context: WorkflowV17EffectAdapterContext): Promise<JsonValue> {
    const input = context.semanticInput as JsonObject;
    const key = input.key as string;
    this.executions.set(key, (this.executions.get(key) ?? 0) + 1);
    this.active++;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      if (this.failures.has(key)) throw new Error(`physical failure ${key}`);
      await wait(
        (input.delay as number | undefined) ?? 0,
        this.ignoreAbort.has(key) ? new AbortController().signal : context.signal,
      );
      return { value: (input.value as number) + 1 };
    } finally {
      this.active--;
    }
  }
}

async function successfulParallelProgram(flow: WorkflowV17SequentialFlow): Promise<JsonObject> {
  return await flow.parallel({
    left: async () => await call(flow, "left", 1),
    right: async () => await call(flow, "right", 2),
  }, { sourceSite: "site-success-parallel", concurrency: 1 });
}

async function failFastProgram(flow: WorkflowV17SequentialFlow): Promise<JsonObject> {
  let caught = false;
  try {
    await flow.parallel({
      bad: async () => await call(flow, "bad", 0),
      sibling: async () => await call(flow, "sibling", 1, 100),
    }, { sourceSite: "site-fail-fast", concurrency: 2 });
  } catch (error) {
    if (!(error instanceof WorkflowV17RecordedStructuralError)) throw error;
    caught = true;
  }
  return { caught, after: (await call(flow, "after", 9)).value };
}

async function replayProgram(flow: WorkflowV17SequentialFlow, changed: number): Promise<JsonObject> {
  const lanes = await flow.parallel({
    changed: async () => await call(flow, "changed", changed),
    stable: async () => await call(flow, "stable", 2),
  }, { sourceSite: "site-replay-parallel", concurrency: 2 });
  return { lanes, after: (await call(flow, "after", 9)).value };
}

async function mapReplayProgram(flow: WorkflowV17SequentialFlow, order: string[]): Promise<JsonObject> {
  const values: Record<string, number> = { a: 1, b: 2, c: 3 };
  const lanes = await flow.map(order, async item => await call(flow, item as string, values[item as string]!), {
    sourceSite: "site-replay-map",
    key: item => item as string,
    concurrency: 2,
  });
  return { lanes, after: (await call(flow, "after", 9)).value };
}

async function call(
  flow: WorkflowV17SequentialFlow,
  key: string,
  value: number,
  delay = 0,
): Promise<{ value: number }> {
  return await flow.effect("command", {
    sourceSite: "site-command",
    input: { key, value, delay },
  });
}

function createFixture(runId: string, concurrency = 4) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v17-structured-"));
  roots.push(root);
  const policy = defaultWorkflowV17RegistryPolicy(root, "user");
  const ref: WorkflowV17DefinitionRef = {
    formatVersion: 1,
    id: "user:structured",
    namespace: "user",
    name: "structured",
    description: PARSED.metadata.description,
    input: PARSED.metadata.input,
    output: PARSED.metadata.output,
    exposure: "human",
    policy,
    path: path.join(root, "structured.flow.ts"),
    source: SOURCE,
    sourceHash: PARSED.sourceHash,
    definitionHash: workflowV17DefinitionHash("user:structured", PARSED),
    parsed: PARSED,
  };
  const snapshot = createWorkflowV17InvocationSnapshot(ref, { value: "test" }, {
    authority: "user",
    projectTrusted: false,
  });
  const database = track(WorkflowRunDatabaseV17.create(path.join(root, "run.sqlite"), {
    runId,
    snapshot,
    projectSnapshotHash: sha256("project"),
    routeSnapshotHash: sha256("routes"),
    contextIdentityHash: sha256("context"),
    safety: {
      concurrency,
      maximumAgentLaunches: 100,
      memoryBytes: 1024 * 1024 * 1024,
      tasks: 128,
      cpuQuotaPercent: 400,
      cpuWeight: 100,
      outputBytes: 64 * 1024 * 1024,
      commandTimeoutMs: 60_000,
    },
    createdAt: new Date(BASE_TIME).toISOString(),
  }));
  return { root, database };
}

function clock(offset = 0): () => Date {
  let tick = offset;
  return () => new Date(BASE_TIME + ++tick * 1_000);
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds === 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => done(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    function done(error?: unknown) {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolve();
    }
  });
}

function track<T extends { close(): void }>(value: T): T {
  closeables.add(value);
  return value;
}

function fixtureIntegrity(...fixtures: Array<ReturnType<typeof createFixture>>): void {
  for (const fixture of fixtures) fixture.database.validateIntegrity();
}
