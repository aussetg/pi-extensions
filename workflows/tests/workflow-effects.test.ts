import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseWorkflow } from "../src/definition/workflow-frontend.js";
import { createWorkflowInvocationSnapshot } from "../src/persistence/workflow-invocation.js";
import { WorkflowRunDatabase } from "../src/persistence/run-database.js";
import { defaultWorkflowRegistryPolicy } from "../src/registry/workflow-policy.js";
import {
  workflowDefinitionHash,
  type WorkflowDefinitionRef,
} from "../src/registry/structured-workflows.js";
import { WorkflowArtifactStore } from "../src/artifacts/store.js";
import { WorkflowEffectProductFactory } from "../src/artifacts/products.js";
import { WorkflowControlAuthorityRegistry } from "../src/runtime/control-authority.js";
import {
  WorkflowCandidateRuntime,
  type WorkflowCandidateWorkspaceDriver,
  type WorkflowFrozenCandidateWorkspace,
  type WorkflowPreparedCandidateWorkspace,
} from "../src/candidates/runtime.js";
import {
  workflowStaticEffectResources,
  workflowVerificationRecord,
  type WorkflowAgentEffectExecutor,
  type WorkflowApplyExecutor,
  type WorkflowAskExecutor,
  type WorkflowCommandEffectExecutor,
  type WorkflowVerificationExecutor,
} from "../src/runtime/effect-adapters.js";
import { WorkflowExecutableRuntime } from "../src/runtime/executable-runtime.js";
import {
  WorkflowSemanticEngineCrashError,
  type WorkflowSemanticEngineFaultPoint,
} from "../src/runtime/semantic-engine.js";
import type {
  WorkflowCandidateRecord,
  WorkflowCandidateWorkspaceRecord,
  WorkflowOperationRecord,
  WorkflowRunRecord,
  WorkflowScopeRecord,
  WorkflowWorkspaceCheckpointRecord,
} from "../src/persistence/run-database-types.js";
import type { CandidateWriteScope } from "../src/runtime/durable-types.js";
import type { JsonObject, JsonValue } from "../src/types.js";
import { sha256, stableHash } from "../src/utils/hashes.js";

const roots: string[] = [];
const databases = new Set<WorkflowRunDatabase>();
const BASE_TIME = Date.parse("2026-08-01T12:00:00.000Z");

const ACCEPT_SOURCE = `
import { agent, command, schema as s, workflow } from "pi/workflows";
const inspect = command({ profile: "builtin:inspect", output: "json" });
const implement = agent({
  profile: "builtin:implementer",
  workspace: "candidate",
  output: s.object({ summary: s.string() }),
});
export default workflow({
  description: "Exercise descriptor effects and accepted candidate authority.",
  input: s.object({}),
  output: s.object({ applied: s.boolean(), summary: s.string(), changedPaths: s.array(s.safePath()) }),
  async run(flow, _args) {
    const proceed = await flow.ask({ prompt: "Proceed?", response: s.boolean() });
    const context = await flow.command(inspect, { args: { mode: "brief" } });
    const candidate = await flow.candidate(async workspace => {
      const result = await flow.agent(implement, {
        workspace,
        prompt: proceed ? "implement" : "stop",
        artifacts: { context },
      });
      return result.output;
    }, { writes: ["src/index.ts"] });
    const verification = await flow.verify(candidate, "builtin:coding");
    if (!verification.passed) {
      await flow.reject(candidate, { verification, reason: verification.status });
      return { applied: false, summary: candidate.output.summary, changedPaths: candidate.changedPaths };
    }
    const accepted = await flow.accept(candidate, { verification });
    const applied = await flow.apply(accepted);
    return { applied: true, summary: accepted.output.summary, changedPaths: applied.changedPaths };
  },
});
`;

const UNCHANGED_SOURCE = `
import { schema as s, workflow } from "pi/workflows";
export default workflow({
  description: "Discard one unchanged candidate.",
  input: s.object({}),
  output: s.object({ changed: s.boolean() }),
  async run(flow, _args) {
    const candidate = await flow.candidate(async _workspace => ({ ok: true }), { writes: ["src/index.ts"] });
    return { changed: candidate.changedPaths.length > 0 };
  },
});
`;

const PENDING_SOURCE = `
import { schema as s, workflow } from "pi/workflows";
export default workflow({
  description: "Leave one changed candidate pending.",
  input: s.object({}),
  output: s.object({ done: s.boolean() }),
  async run(flow, _args) {
    await flow.candidate(async _workspace => ({ ok: true }), { writes: ["src/index.ts"] });
    return { done: true };
  },
});
`;

const CANDIDATE_FAILURE_SOURCE = `
import { schema as s, workflow } from "pi/workflows";
export default workflow({
  description: "Catch one failed candidate callback.",
  input: s.object({}),
  output: s.object({ caught: s.boolean() }),
  async run(flow, _args) {
    try {
      await flow.candidate(async _workspace => { throw new Error("candidate exploded"); }, {
        writes: ["src/index.ts"],
      });
      return { caught: false };
    } catch {
      return { caught: true };
    }
  },
});
`;

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
  for (const root of roots.splice(0)) {
    makeTreeRemovable(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("workflow v17 effect APIs and candidate lifecycle", () => {
  it("routes reviewed descriptors through canonical products and applies exact accepted authority", async () => {
    const fixture = createFixture(ACCEPT_SOURCE, "effects-accept");
    const backends = scriptedBackends(fixture);
    const outcome = await runtime(fixture, backends).run();
    expect(outcome).toMatchObject({
      status: "completed",
      result: { applied: true, summary: "implemented", changedPaths: ["src/index.ts"] },
    });
    expect(backends.calls).toEqual({ ask: 1, command: 1, agent: 1, verify: 1, apply: 1 });
    const candidate = fixture.database.listCandidates()[0]!;
    expect(candidate).toMatchObject({
      state: "applied",
      changedPaths: ["src/index.ts"],
      disposition: { disposition: "accepted", verificationId: expect.stringMatching(/^verification_/) },
      appliedReceiptId: expect.stringMatching(/^apply_receipt_/),
    });
    expect(fixture.database.readCandidateMeasurement(candidate.candidateId)).toBeUndefined();
    expect(fixture.database.listOperationArtifacts(candidate.operationId).map(link => link.artifact.kind).sort())
      .toEqual(["candidate-diff", "candidate-manifest"]);
    expect(fixture.database.listOperations().map(operation => operation.kind)).toEqual([
      "ask", "command", "candidate", "agent", "verify", "accept", "apply",
    ]);
    const agent = fixture.database.listOperations().find(operation => operation.kind === "agent")!;
    expect(fixture.database.readScopeCall(agent.operationId)).toMatchObject({
      completionAuthority: "finish-work",
      replayPolicy: "workspace",
      postWorkspaceCheckpointId: expect.stringMatching(/^checkpoint_/),
    });
    expect(fixture.database.listOperationArtifacts(agent.operationId).map(link => link.artifact.kind).sort()).toEqual([
      "agent-output", "command-result", "workspace-checkpoint",
    ]);
    fixture.database.validateIntegrity();
  });

  it("records failed verification and exact rejection without apply", async () => {
    const fixture = createFixture(ACCEPT_SOURCE, "effects-reject");
    const backends = scriptedBackends(fixture, { verification: "failed" });
    const outcome = await runtime(fixture, backends).run();
    expect(outcome).toMatchObject({
      status: "completed",
      result: { applied: false, summary: "implemented", changedPaths: ["src/index.ts"] },
    });
    expect(backends.calls.apply).toBe(0);
    expect(fixture.database.listCandidates()[0]).toMatchObject({
      state: "rejected",
      disposition: {
        disposition: "rejected",
        verificationId: expect.stringMatching(/^verification_/),
        reason: expect.objectContaining({ summary: "failed" }),
      },
    });
    fixture.database.validateIntegrity();
  });

  it("atomically discards an unchanged candidate and permits successful completion", async () => {
    const fixture = createFixture(UNCHANGED_SOURCE, "effects-unchanged");
    fixture.driver.changed = false;
    const outcome = await runtime(fixture, {}).run();
    expect(outcome).toMatchObject({ status: "completed", result: { changed: false } });
    expect(fixture.database.listCandidates()[0]).toMatchObject({
      state: "discarded",
      changedPaths: [],
      disposition: { disposition: "discarded" },
    });
    fixture.database.validateIntegrity();
  });

  it("restores a frozen candidate after a crash without re-entering its callback", async () => {
    const fixture = createFixture(ACCEPT_SOURCE, "effects-crash");
    const backends = scriptedBackends(fixture);
    let crashed = false;
    await expect(runtime(fixture, backends, {
      faultInjector: point => {
        if (!crashed && point === "after-candidate-frozen") {
          crashed = true;
          throw new WorkflowSemanticEngineCrashError(point);
        }
      },
    }).run()).rejects.toBeInstanceOf(WorkflowSemanticEngineCrashError);
    expect(backends.calls.agent).toBe(1);
    expect(fixture.database.readCandidateByOperation(
      fixture.database.listOperations().find(operation => operation.kind === "candidate")!.operationId,
    )).toBeDefined();

    const recovered = await runtime(fixture, backends).run();
    expect(recovered).toMatchObject({ status: "completed", result: { applied: true } });
    expect(backends.calls.agent).toBe(1);
    expect(backends.calls.command).toBe(1);
    fixture.database.validateIntegrity();
  });

  it("refuses verification when a frozen candidate workspace changes after freeze", async () => {
    const fixture = createFixture(ACCEPT_SOURCE, "effects-frozen-tamper");
    const backends = scriptedBackends(fixture);
    await expect(runtime(fixture, backends, {
      faultInjector: point => {
        if (point === "after-candidate-frozen") throw new WorkflowSemanticEngineCrashError(point);
      },
    }).run()).rejects.toBeInstanceOf(WorkflowSemanticEngineCrashError);
    fixture.driver.tampered = true;
    const outcome = await runtime(fixture, backends).run();
    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "execution-failed", effectKind: "verify" },
    });
    expect(backends.calls.verify).toBe(0);
  });

  it("rejects invalid human responses before they become durable results", async () => {
    const fixture = createFixture(ACCEPT_SOURCE, "effects-ask-schema");
    const backends = scriptedBackends(fixture);
    backends.ask.ask = async () => ({ response: "not-boolean", approvalId: "approval_bad" });
    const outcome = await runtime(fixture, backends).run();
    expect(outcome).toMatchObject({ status: "failed", failure: { code: "execution-failed", effectKind: "ask" } });
    const ask = fixture.database.listOperations()[0]!;
    expect(ask).toMatchObject({ kind: "ask", status: "failed" });
    expect(fixture.database.readScopeCall(ask.operationId)).toMatchObject({ replayPolicy: "never" });
  });

  it("fails closed when apply returns a stale verification binding", async () => {
    const fixture = createFixture(ACCEPT_SOURCE, "effects-stale-apply");
    const backends = scriptedBackends(fixture, { staleApply: true });
    const outcome = await runtime(fixture, backends).run();
    expect(outcome).toMatchObject({ status: "failed", failure: { code: "execution-failed", effectKind: "apply" } });
    expect(fixture.database.listCandidates()[0]).toMatchObject({ state: "accepted" });
    expect(fixture.database.listOperations().at(-1)).toMatchObject({ kind: "apply", status: "failed" });
  });

  it("fails successful control that leaves a changed candidate pending and abandons it atomically", async () => {
    const fixture = createFixture(PENDING_SOURCE, "effects-pending");
    fixture.driver.changed = true;
    const outcome = await runtime(fixture, {}).run();
    expect(outcome).toMatchObject({
      status: "failed",
      failure: { summary: "Workflow completed with 1 undisposed nonempty candidate" },
    });
    expect(fixture.database.listCandidates()[0]).toMatchObject({
      state: "abandoned",
      disposition: { disposition: "abandoned" },
    });
    fixture.database.validateIntegrity();
  });

  it("rejects missing static bindings and structural verification lookalikes", async () => {
    const fixture = createFixture(ACCEPT_SOURCE, "effects-authority");
    expect(() => workflowStaticEffectResources({
      workflow: fixture.parsed,
      definitionHash: fixture.database.readRun().workflow.definitionHash,
      agents: {},
      commands: {},
      verifications: {},
    })).toThrow("lacks exact pinned");
    expect(() => workflowVerificationRecord({
      database: fixture.database,
      products: fixture.products,
    }, {
      receiptId: "verification_fake",
      status: "passed",
      passed: true,
      artifact: {},
    })).toThrow("no workflow v17 verification authority");
  });

  it("abandons a failed candidate callback and restores its structural failure into catch", async () => {
    const fixture = createFixture(CANDIDATE_FAILURE_SOURCE, "effects-candidate-failure");
    const outcome = await runtime(fixture, {}).run();
    expect(outcome).toMatchObject({ status: "completed", result: { caught: true } });
    const operation = fixture.database.listOperations()[0]!;
    expect(operation).toMatchObject({ kind: "candidate", status: "failed" });
    expect(fixture.database.readCandidateWorkspaceByOperation(operation.operationId)).toMatchObject({
      state: "abandoned",
    });
    expect(fixture.database.readCandidateByOperation(operation.operationId)).toBeUndefined();
    fixture.database.validateIntegrity();
  });
});

function createFixture(source: string, name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `workflow-${name}-`));
  roots.push(root);
  const parsed = parseWorkflow(source, { fileName: `${name}.flow.ts` });
  const policy = defaultWorkflowRegistryPolicy(root, "user");
  const ref: WorkflowDefinitionRef = {
    formatVersion: 1,
    id: `user:${name}`,
    namespace: "user",
    name,
    description: parsed.metadata.description,
    input: parsed.metadata.input,
    output: parsed.metadata.output,
    exposure: "human",
    policy,
    path: path.join(root, `${name}.flow.ts`),
    source,
    sourceHash: parsed.sourceHash,
    definitionHash: workflowDefinitionHash(`user:${name}`, parsed),
    parsed,
  };
  const snapshot = createWorkflowInvocationSnapshot(ref, {}, { authority: "user", projectTrusted: false });
  const agents: Record<string, { selector: string; authority: JsonObject }> = {};
  const commands: Record<string, { selector: string; authority: JsonObject }> = {};
  for (const descriptor of parsed.descriptors) {
    (descriptor.kind === "agent-task" ? agents : commands)[descriptor.identity.sourceSite] = {
      selector: descriptor.profile,
      authority: descriptor.kind === "agent-task"
        ? { profileHash: sha256(descriptor.profile), routeHash: sha256(`route:${descriptor.profile}`) }
        : { profileHash: sha256(descriptor.profile), executorHash: sha256(`executor:${descriptor.profile}`) },
    };
  }
  const verifications = Object.fromEntries(parsed.review.verificationProfiles.map(selector => [
    selector,
    { selector, authority: { profileHash: sha256(selector), environmentHash: sha256(`environment:${selector}`) } },
  ]));
  const resources = workflowStaticEffectResources({
    workflow: parsed,
    definitionHash: snapshot.definitionHash,
    agents,
    commands,
    verifications,
  });
  const database = WorkflowRunDatabase.create(path.join(root, "run.sqlite"), {
    runId: `flow_v17_${name.replace(/-/gu, "_")}`,
    snapshot,
    projectSnapshotHash: sha256(`project:${name}`),
    routeSnapshotHash: sha256(`routes:${name}`),
    staticResourcesHash: resources.hash,
    contextIdentityHash: sha256(`context:${name}`),
    safety: {
      concurrency: 4,
      maximumAgentLaunches: 100,
      memoryBytes: 1024 * 1024 * 1024,
      tasks: 128,
      cpuQuotaPercent: 400,
      cpuWeight: 100,
      outputBytes: 64 * 1024 * 1024,
      commandTimeoutMs: 60_000,
    },
    createdAt: new Date(BASE_TIME).toISOString(),
  });
  databases.add(database);
  const now = clock();
  const store = new WorkflowArtifactStore(root, database, { now });
  const authority = new WorkflowControlAuthorityRegistry(`run:${name}`);
  const products = new WorkflowEffectProductFactory(authority, store);
  const driver = new FakeCandidateDriver(store, now);
  const candidates = new WorkflowCandidateRuntime(database, authority, driver, now);
  expect(resources.definitionHash).toBe(snapshot.definitionHash);
  return { root, parsed, snapshot, database, store, authority, products, driver, candidates, resources, now };
}

function runtime(
  fixture: ReturnType<typeof createFixture>,
  backends: Partial<ReturnType<typeof scriptedBackends>>,
  options: { faultInjector?: (point: WorkflowSemanticEngineFaultPoint) => void } = {},
) {
  return new WorkflowExecutableRuntime({
    workflow: fixture.parsed,
    invocation: fixture.snapshot,
    database: fixture.database,
    authority: fixture.authority,
    products: fixture.products,
    candidates: fixture.candidates,
    resources: fixture.resources,
    ...(backends.agent ? { agent: backends.agent } : {}),
    ...(backends.command ? { command: backends.command } : {}),
    ...(backends.ask ? { ask: backends.ask } : {}),
    ...(backends.verification ? { verification: backends.verification } : {}),
    ...(backends.apply ? { apply: backends.apply } : {}),
    now: fixture.now,
    ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
  });
}

function scriptedBackends(
  fixture: ReturnType<typeof createFixture>,
  options: { verification?: "passed" | "failed" | "blocked"; staleApply?: boolean } = {},
) {
  const calls = { ask: 0, command: 0, agent: 0, verify: 0, apply: 0 };
  const ask: WorkflowAskExecutor = {
    ask: async () => { calls.ask++; return { response: true, approvalId: "approval_ask" }; },
  };
  const command: WorkflowCommandEffectExecutor = {
    execute: async request => {
      calls.command++;
      expect(request.binding.selector).toBe("builtin:inspect");
      return { ok: true, exitCode: 0, durationMs: 12, output: { context: "ready" } };
    },
  };
  const agent: WorkflowAgentEffectExecutor = {
    execute: async request => {
      calls.agent++;
      expect(request.binding.selector).toBe("builtin:implementer");
      expect(request.artifacts.entries.map(entry => entry.path)).toEqual(["context"]);
      expect(request.inputs.entries.map(entry => entry.id)).toEqual(["context"]);
      expect(JSON.parse(fs.readFileSync(request.inputs.entries[0]!.path, "utf8"))).toMatchObject({
        ok: true,
        output: { context: "ready" },
      });
      expect(request.workspace).toBeDefined();
      fixture.driver.changed = true;
      return {
        finish: {
          receiptId: `finish_${request.operation.operationId.slice(-16)}`,
          outputSchemaHash: stableHash(request.descriptor.output),
          output: { summary: "implemented" },
        },
      };
    },
  };
  const verification: WorkflowVerificationExecutor = {
    verify: async request => {
      calls.verify++;
      expect(request.workspace.record.state).toBe("frozen");
      return {
        status: options.verification ?? "passed",
        environmentHash: request.binding.authority.environmentHash as string,
        evidence: { checks: 3 },
      };
    },
  };
  const apply: WorkflowApplyExecutor = {
    apply: async request => {
      calls.apply++;
      expect(request.workspace.record.state).toBe("frozen");
      const receiptId = `apply_receipt_${request.candidate.candidateId.slice(-16)}`;
      const approvalId = "approval_apply_exact";
      const verificationBindingHash = options.staleApply
        ? sha256("stale") : request.verification.bindingHash;
      const changedPaths = [...request.candidate.changedPaths];
      return {
        receiptId,
        approvalId,
        candidateId: request.candidate.candidateId,
        verificationBindingHash,
        changedPaths,
        authorityHash: stableHash({
          formatVersion: 1,
          candidateId: request.candidate.candidateId,
          approvalId,
          receiptId,
          verificationBindingHash,
          changedPaths,
        }),
      };
    },
  };
  return { calls, ask, command, agent, verification, apply };
}

class FakeCandidateDriver implements WorkflowCandidateWorkspaceDriver {
  changed = false;
  tampered = false;

  constructor(
    private readonly store: WorkflowArtifactStore,
    private readonly now: () => Date,
  ) {}

  async prepare(input: {
    run: WorkflowRunRecord;
    operation: WorkflowOperationRecord;
    bodyScope: WorkflowScopeRecord;
    parent?: WorkflowCandidateRecord;
    writeScope: CandidateWriteScope;
  }): Promise<WorkflowPreparedCandidateWorkspace> {
    const workspaceId = `workspace_${stableHash(input.operation.operationId).slice(7, 39)}`;
    const prepared = {
      workspaceId,
      initialTreeHash: input.parent?.treeHash ?? input.run.projectSnapshotHash,
      baseLineageHash: input.parent?.lineageHash ?? sha256("launch-lineage"),
      writeScope: input.writeScope,
      writeScopeHash: stableHash(input.writeScope),
      rootPath: `workspaces/candidates/${workspaceId}/project`,
    };
    return prepared;
  }

  async describe(record: WorkflowCandidateWorkspaceRecord) {
    return {
      record,
      root: path.join(this.store.runDir, record.rootPath),
      cwd: path.join(this.store.runDir, record.rootPath),
      currentTreeHash: this.tampered
        ? sha256(`tampered:${record.workspaceId}`)
        : this.changed ? sha256(`changed:${record.workspaceId}`) : record.initialTreeHash,
    };
  }

  async freeze(input: {
    run: WorkflowRunRecord;
    operation: WorkflowOperationRecord;
    workspace: WorkflowCandidateWorkspaceRecord;
    output: JsonValue;
  }): Promise<WorkflowFrozenCandidateWorkspace> {
    const changedPaths = this.changed ? ["src/index.ts"] : [];
    const treeHash = this.changed ? sha256(`changed:${input.workspace.workspaceId}`) : input.workspace.initialTreeHash;
    const manifest = await this.store.putJson({
      kind: "candidate-manifest",
      value: { formatVersion: 1, treeHash, changedPaths },
    });
    const diff = await this.store.putJson({
      kind: "candidate-diff",
      value: { formatVersion: 1, changedPaths },
    });
    return {
      treeHash,
      lineageHash: sha256(`lineage:${input.workspace.workspaceId}:${treeHash}`),
      changedPaths,
      manifestArtifact: manifest.record,
      diffArtifact: diff.record,
    };
  }

  async checkpoint(input: {
    run: WorkflowRunRecord;
    operation: WorkflowOperationRecord;
    workspace: WorkflowCandidateWorkspaceRecord;
  }): Promise<WorkflowWorkspaceCheckpointRecord> {
    return {
      checkpointId: `checkpoint_${stableHash({
        formatVersion: 1,
        kind: "workflow-workspace-checkpoint",
        runId: input.run.runId,
        operationId: input.operation.operationId,
        workspaceId: input.workspace.workspaceId,
      }).slice(7, 39)}`,
      runId: input.run.runId,
      operationId: input.operation.operationId,
      workspaceId: input.workspace.workspaceId,
      treeHash: this.changed ? sha256(`changed:${input.workspace.workspaceId}`) : input.workspace.initialTreeHash,
      lineageHash: input.workspace.baseLineageHash,
      writeScopeHash: input.workspace.writeScopeHash,
      storagePath: `workspaces/checkpoints/checkpoint_${input.operation.operationId.slice(-16)}`,
      createdAt: this.now().toISOString(),
    };
  }
}

function clock(): () => Date {
  let tick = 0;
  return () => new Date(BASE_TIME + ++tick * 1_000);
}

function makeTreeRemovable(root: string): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(root); } catch { return; }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.chmodSync(root, 0o700);
    for (const name of fs.readdirSync(root)) makeTreeRemovable(path.join(root, name));
  } else fs.chmodSync(root, 0o600);
}
