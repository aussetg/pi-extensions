import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseWorkflowV17 } from "../src/definition/workflow-v17-frontend.js";
import { createWorkflowV17InvocationSnapshot } from "../src/persistence/workflow-v17-invocation.js";
import {
  WorkflowRunDatabaseV17,
  type WorkflowOperationV17Record,
} from "../src/persistence/run-database-v17.js";
import { defaultWorkflowV17RegistryPolicy } from "../src/registry/workflow-v17-policy.js";
import {
  workflowV17DefinitionHash,
  type WorkflowV17DefinitionRef,
} from "../src/registry/structured-workflows-v17.js";
import { WorkflowV17CausalReplay } from "../src/runtime/causal-replay-v17.js";
import {
  WorkflowV17SemanticDriftError,
  WorkflowV17SemanticEngine,
  WorkflowV17SemanticEngineCrashError,
  WorkflowV17RecordedEffectError,
  type WorkflowV17EffectAdapterContext,
  type WorkflowV17EffectIdentity,
  type WorkflowV17SemanticEffectAdapter,
  type WorkflowV17SemanticEngineFaultPoint,
  type WorkflowV17SequentialFlow,
} from "../src/runtime/semantic-engine-v17.js";
import type { JsonValue } from "../src/types.js";
import { sha256, stableHash } from "../src/utils/hashes.js";

const API = path.resolve("workflow-api.d.ts");
const BASE_TIME = Date.parse("2026-08-01T12:00:00.000Z");
const roots: string[] = [];
const closeables = new Set<{ close(): void }>();

const SOURCE = `
import { schema as s, workflow } from "pi/workflows";
export default workflow({
  description: "Exercise sequential effects.",
  input: s.object({ value: s.string() }),
  output: s.object({ total: s.integer() }),
  async run(_flow, _args) { return { total: 0 }; },
});
`;
const PARSED = parseWorkflowV17(SOURCE, {
  fileName: "/virtual/sequential.flow.ts",
  apiPath: API,
});

afterEach(() => {
  for (const value of closeables) value.close();
  closeables.clear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("workflow v17 cursor semantic engine", () => {
  it("reconstructs native loop locals after a crash at every durable engine boundary", async () => {
    const observed: WorkflowV17SemanticEngineFaultPoint[] = [];
    {
      const fixture = createFixture("flow_v17_boundaries");
      const adapter = new CountingAdapter("command");
      const outcome = await new WorkflowV17SemanticEngine(fixture.database, [adapter], {
        now: clock(),
        faultInjector: (point) => { observed.push(point); },
      }).run(loopProgram);
      expect(outcome).toMatchObject({ status: "completed", result: { total: 6 } });
      expect([...adapter.executions.values()]).toEqual([1, 1, 1]);
    }

    expect(observed).toEqual([
      "after-run-start",
      "after-operation-claim", "after-effect-settled", "after-operation-complete",
      "after-operation-claim", "after-effect-settled", "after-operation-complete",
      "after-operation-claim", "after-effect-settled", "after-operation-complete",
      "after-root-scope-complete",
    ]);

    for (let crashIndex = 0; crashIndex < observed.length; crashIndex++) {
      const fixture = createFixture(`flow_v17_crash_${crashIndex}`);
      const adapter = new CountingAdapter("command");
      let transition = 0;
      let crashed = false;
      const first = new WorkflowV17SemanticEngine(fixture.database, [adapter], {
        now: clock(),
        faultInjector: (point, operation) => {
          if (transition++ === crashIndex) {
            crashed = true;
            throw new WorkflowV17SemanticEngineCrashError(point, operation?.path);
          }
        },
      });
      await expect(first.run(loopProgram)).rejects.toBeInstanceOf(WorkflowV17SemanticEngineCrashError);
      expect(crashed).toBe(true);

      const outcome = await new WorkflowV17SemanticEngine(fixture.database, [adapter], {
        now: clock(100),
      }).run(loopProgram);
      expect(outcome).toMatchObject({ status: "completed", result: { total: 6 } });
      expect([...adapter.executions.entries()].sort()).toEqual([
        ["0", 1], ["1", 1], ["2", 1],
      ]);
      expect(fixture.database.listOperations().map((operation) => operation.cursor)).toEqual([0, 1, 2]);
      fixture.database.validateIntegrity();
    }
  });

  it("restores a durable failed settlement into ordinary catch control", async () => {
    const fixture = createFixture("flow_v17_caught_failure");
    const adapter = new CountingAdapter("command", { failures: new Set(["bad"]) });
    let crashed = false;
    const program = async (flow: WorkflowV17SequentialFlow) => {
      let caught = "";
      try {
        await call(flow, "bad", 0);
      } catch (error) {
        expect(error).toBeInstanceOf(WorkflowV17RecordedEffectError);
        caught = (error as Error).message;
      }
      const next = await call(flow, "good", 1);
      return { total: next.value, caught };
    };
    const first = new WorkflowV17SemanticEngine(fixture.database, [adapter], {
      now: clock(),
      faultInjector: (point) => {
        if (!crashed && point === "after-effect-settled") {
          crashed = true;
          throw new WorkflowV17SemanticEngineCrashError(point);
        }
      },
    });
    await expect(first.run(program)).rejects.toBeInstanceOf(WorkflowV17SemanticEngineCrashError);
    const pending = fixture.database.listOperations()[0]!;
    expect(fixture.database.readEffectSettlement(pending.operationId)).toMatchObject({
      outcome: "failure",
      replayPolicy: "never",
    });

    const outcome = await new WorkflowV17SemanticEngine(fixture.database, [adapter], {
      now: clock(100),
    }).run(program);
    expect(outcome).toMatchObject({
      status: "completed",
      result: { total: 2, caught: "physical failure bad" },
    });
    expect([...adapter.executions.entries()].sort()).toEqual([["bad", 1], ["good", 1]]);
    const calls = fixture.database.listScopeCalls(fixture.database.readRun().rootScopeId);
    expect(calls.map((entry) => [entry.cursor, entry.outcome, entry.replayPolicy])).toEqual([
      [0, "failure", "never"],
      [1, "success", "immutable"],
    ]);
    expect(calls[1]!.previousCallKey).toBe(calls[0]!.callKey);
    fixture.database.validateIntegrity();
  });

  it("reopens SQLite after settlement and does not execute the physical effect twice", async () => {
    const fixture = createFixture("flow_v17_reopen");
    const adapter = new CountingAdapter("command");
    const first = new WorkflowV17SemanticEngine(fixture.database, [adapter], {
      now: clock(),
      faultInjector: (point) => {
        if (point === "after-effect-settled") throw new WorkflowV17SemanticEngineCrashError(point);
      },
    });
    await expect(first.run(async (flow) => ({ total: (await call(flow, "only", 4)).value })))
      .rejects.toBeInstanceOf(WorkflowV17SemanticEngineCrashError);
    fixture.database.close();
    closeables.delete(fixture.database);
    const reopened = track(WorkflowRunDatabaseV17.open(path.join(fixture.root, "run.sqlite")));
    const outcome = await new WorkflowV17SemanticEngine(reopened, [adapter], {
      now: clock(100),
    }).run(async (flow) => ({ total: (await call(flow, "only", 4)).value }));
    expect(outcome).toMatchObject({ status: "completed", result: { total: 5 } });
    expect(adapter.executions.get("only")).toBe(1);
    reopened.validateIntegrity();
  });

  it("commits an uncaught effect failure as the root and run terminal state", async () => {
    const fixture = createFixture("flow_v17_uncaught_failure");
    const adapter = new CountingAdapter("command", { failures: new Set(["fatal"]) });
    const outcome = await new WorkflowV17SemanticEngine(fixture.database, [adapter], {
      now: clock(),
    }).run(async (flow) => ({ total: (await call(flow, "fatal", 0)).value }));
    expect(outcome).toMatchObject({
      status: "failed",
      failure: { category: "effect", code: "execution-failed", summary: "physical failure fatal" },
    });
    if (outcome.status !== "failed") throw new Error("Expected failed workflow outcome");
    expect(fixture.database.readRun()).toMatchObject({ status: "failed", reason: outcome.failure });
    expect(fixture.database.readScope(fixture.database.readRun().rootScopeId)).toMatchObject({
      status: "failed",
      failure: outcome.failure,
    });
    expect(fixture.database.listScopeCalls(fixture.database.readRun().rootScopeId)[0]).toMatchObject({
      outcome: "failure",
      replayPolicy: "never",
    });
    expect(adapter.executions.get("fatal")).toBe(1);
    fixture.database.validateIntegrity();
  });

  it("recovers an uncaught failure across every failed-effect boundary", async () => {
    for (const target of [
      "after-effect-settled",
      "after-operation-failure",
      "after-root-scope-failure",
    ] as const) {
      const fixture = createFixture(`flow_v17_failure_${target.replaceAll("-", "_")}`);
      const adapter = new CountingAdapter("command", { failures: new Set(["fatal"]) });
      let crashed = false;
      const program = async (flow: WorkflowV17SequentialFlow) => ({
        total: (await call(flow, "fatal", 0)).value,
      });
      await expect(new WorkflowV17SemanticEngine(fixture.database, [adapter], {
        now: clock(),
        faultInjector: (point) => {
          if (!crashed && point === target) {
            crashed = true;
            throw new WorkflowV17SemanticEngineCrashError(point);
          }
        },
      }).run(program)).rejects.toBeInstanceOf(WorkflowV17SemanticEngineCrashError);
      expect(crashed).toBe(true);
      expect(await new WorkflowV17SemanticEngine(fixture.database, [adapter], {
        now: clock(100),
      }).run(program)).toMatchObject({ status: "failed", failure: { summary: "physical failure fatal" } });
      expect(adapter.executions.get("fatal")).toBe(1);
      fixture.database.validateIntegrity();
    }
  });

  it("fails closed when adapter identity validation breaks after claim", async () => {
    const fixture = createFixture("flow_v17_bad_adapter");
    const adapter = new CountingAdapter("command");
    adapter.journalIdentity = () => ({
      semanticKey: "not-a-hash",
      completionAuthority: "host-effect",
      replayPolicy: "immutable",
    });
    const outcome = await new WorkflowV17SemanticEngine(fixture.database, [adapter], {
      now: clock(),
    }).run(async (flow) => ({ total: (await call(flow, "never-executed", 0)).value }));
    expect(outcome).toMatchObject({
      status: "failed",
      failure: { summary: "Workflow v17 command adapter returned an invalid semantic key" },
    });
    expect(adapter.executions.size).toBe(0);
    expect(fixture.database.readRun().status).toBe("failed");
    expect(fixture.database.listOperations()[0]?.status).toBe("cancelled");
    fixture.database.validateIntegrity();
  });

  it("rejects semantic input and effect-identity drift at the first cursor", async () => {
    const inputFixture = createFixture("flow_v17_input_drift");
    const original = new CountingAdapter("command");
    await expect(new WorkflowV17SemanticEngine(inputFixture.database, [original], {
      now: clock(),
      faultInjector: (point) => {
        if (point === "after-operation-claim") throw new WorkflowV17SemanticEngineCrashError(point);
      },
    }).run(async (flow) => ({ total: (await call(flow, "old", 0)).value })))
      .rejects.toBeInstanceOf(WorkflowV17SemanticEngineCrashError);
    await expect(new WorkflowV17SemanticEngine(inputFixture.database, [original], {
      now: clock(100),
    }).run(async (flow) => ({ total: (await call(flow, "new", 0)).value })))
      .rejects.toBeInstanceOf(WorkflowV17SemanticDriftError);
    expect(inputFixture.database.readRun().status).toBe("running");

    const keyFixture = createFixture("flow_v17_key_drift");
    await expect(new WorkflowV17SemanticEngine(keyFixture.database, [new CountingAdapter("command")], {
      now: clock(),
      faultInjector: (point) => {
        if (point === "after-effect-settled") throw new WorkflowV17SemanticEngineCrashError(point);
      },
    }).run(async (flow) => ({ total: (await call(flow, "same", 0)).value })))
      .rejects.toBeInstanceOf(WorkflowV17SemanticEngineCrashError);
    await expect(new WorkflowV17SemanticEngine(keyFixture.database, [new CountingAdapter("command", {
      identityVersion: 2,
    })], { now: clock(100) }).run(async (flow) => ({ total: (await call(flow, "same", 0)).value })))
      .rejects.toBeInstanceOf(WorkflowV17SemanticDriftError);
  });

  it("treats source sites and display titles as non-semantic during same-run restoration", async () => {
    const fixture = createFixture("flow_v17_display");
    const adapter = new CountingAdapter("command");
    await expect(new WorkflowV17SemanticEngine(fixture.database, [adapter], {
      now: clock(),
      faultInjector: (point) => {
        if (point === "after-operation-complete") throw new WorkflowV17SemanticEngineCrashError(point);
      },
    }).run(async (flow) => ({ total: (await call(flow, "same", 1, {
      sourceSite: "site-old", title: "Old title",
    })).value }))).rejects.toBeInstanceOf(WorkflowV17SemanticEngineCrashError);

    const outcome = await new WorkflowV17SemanticEngine(fixture.database, [adapter], {
      now: clock(100),
    }).run(async (flow) => ({ total: (await call(flow, "same", 1, {
      sourceSite: "site-new", title: "New title",
    })).value }));
    expect(outcome).toMatchObject({ status: "completed", result: { total: 2 } });
    expect(adapter.executions.get("same")).toBe(1);
  });

  it("pauses before admitting operation or agent runaway", async () => {
    const operations = createFixture("flow_v17_operation_limit");
    const command = new CountingAdapter("command");
    const operationOutcome = await new WorkflowV17SemanticEngine(operations.database, [command], {
      now: clock(), operationAdmissionLimit: 2,
    }).run(async (flow) => {
      for (let index = 0; index < 3; index++) await call(flow, String(index), index);
      return { total: 3 };
    });
    expect(operationOutcome).toMatchObject({
      status: "paused",
      failure: { code: "admission-operations", retryable: true },
    });
    expect(operations.database.listOperations()).toHaveLength(2);
    expect(command.executions.size).toBe(2);

    const agents = createFixture("flow_v17_agent_limit", 1);
    const agent = new CountingAdapter("agent");
    const agentOutcome = await new WorkflowV17SemanticEngine(agents.database, [agent], {
      now: clock(),
    }).run(async (flow) => {
      await call(flow, "first", 0, {}, "agent");
      await call(flow, "second", 1, {}, "agent");
      return { total: 2 };
    });
    expect(agentOutcome).toMatchObject({ status: "paused", failure: { code: "admission-agents" } });
    expect(agent.executions.size).toBe(1);
    agents.database.validateIntegrity();
  });

  it("uses the causal importer before fresh execution", async () => {
    const source = createFixture("flow_v17_replay_source");
    const sourceAdapter = new CountingAdapter("command");
    expect(await new WorkflowV17SemanticEngine(source.database, [sourceAdapter], {
      now: clock(),
    }).run(loopProgram)).toMatchObject({ status: "completed", result: { total: 6 } });

    const target = createFixture("flow_v17_replay_target");
    const replay = track(await WorkflowV17CausalReplay.open({
      sourceRunDir: source.root,
      targetRunDir: target.root,
      target: target.database,
    }));
    const targetAdapter = new CountingAdapter("command");
    const outcome = await new WorkflowV17SemanticEngine(target.database, [targetAdapter], {
      now: clock(100), replay,
    }).run(loopProgram);
    expect(outcome).toMatchObject({ status: "completed", result: { total: 6 } });
    expect(targetAdapter.executions.size).toBe(0);
    expect(target.database.listScopeCalls(target.database.readRun().rootScopeId)
      .every((entry) => entry.replay?.sourceRunId === source.database.readRun().runId)).toBe(true);
    target.database.validateIntegrity();
  });
});

class CountingAdapter implements WorkflowV17SemanticEffectAdapter {
  readonly executions = new Map<string, number>();
  readonly kind: "command" | "agent";
  private readonly failures: Set<string>;
  private readonly identityVersion: number;

  constructor(
    kind: "command" | "agent",
    options: { failures?: Set<string>; identityVersion?: number } = {},
  ) {
    this.kind = kind;
    this.failures = options.failures ?? new Set();
    this.identityVersion = options.identityVersion ?? 1;
  }

  semanticInput(context: Omit<WorkflowV17EffectAdapterContext, "semanticInput" | "operation">): JsonValue {
    return structuredClone(context.input as JsonValue);
  }

  journalIdentity(context: WorkflowV17EffectAdapterContext & { operation: WorkflowOperationV17Record }): WorkflowV17EffectIdentity {
    return {
      semanticKey: stableHash({
        formatVersion: this.identityVersion,
        kind: this.kind,
        semanticInput: context.semanticInput,
      }),
      completionAuthority: this.kind === "agent" ? "finish-work" : "host-effect",
      replayPolicy: "immutable",
    };
  }

  execute(context: WorkflowV17EffectAdapterContext & { operation: WorkflowOperationV17Record }): JsonValue {
    const input = context.semanticInput as { key: string; value: number };
    this.executions.set(input.key, (this.executions.get(input.key) ?? 0) + 1);
    if (this.failures.has(input.key)) throw new Error(`physical failure ${input.key}`);
    return { value: input.value + 1 };
  }
}

async function loopProgram(flow: WorkflowV17SequentialFlow) {
  let total = 0;
  for (let index = 0; index < 3; index++) total += (await call(flow, String(index), index)).value;
  return { total };
}

async function call(
  flow: WorkflowV17SequentialFlow,
  key: string,
  value: number,
  display: { sourceSite?: string; title?: string } = {},
  kind: "command" | "agent" = "command",
): Promise<{ value: number }> {
  return await flow.effect<{ value: number }>(kind, {
    sourceSite: display.sourceSite ?? "site-000000",
    ...(display.title ? { title: display.title } : {}),
    input: { key, value },
  });
}

function createFixture(runId: string, maximumAgentLaunches = 100) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v17-engine-"));
  roots.push(root);
  const policy = defaultWorkflowV17RegistryPolicy(root, "user");
  const ref: WorkflowV17DefinitionRef = {
    formatVersion: 1,
    id: "user:sequential",
    namespace: "user",
    name: "sequential",
    description: PARSED.metadata.description,
    input: PARSED.metadata.input,
    output: PARSED.metadata.output,
    exposure: "human",
    policy,
    path: path.join(root, "sequential.flow.ts"),
    source: SOURCE,
    sourceHash: PARSED.sourceHash,
    definitionHash: workflowV17DefinitionHash("user:sequential", PARSED),
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
    staticResourcesHash: sha256("static-resources"),
    contextIdentityHash: sha256("context"),
    safety: {
      concurrency: 4,
      maximumAgentLaunches,
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

function track<T extends { close(): void }>(value: T): T {
  closeables.add(value);
  return value;
}
