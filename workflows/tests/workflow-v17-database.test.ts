import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync as NativeDatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { parseWorkflowV17 } from "../src/definition/workflow-v17-frontend.js";
import { createWorkflowV17InvocationSnapshot } from "../src/persistence/workflow-v17-invocation.js";
import {
  WORKFLOW_V17_ROOT_SCOPE_SEED,
  WorkflowRunDatabaseV17,
  WorkflowRunDatabaseV17CorruptionError,
  WorkflowRunDatabaseV17Reader,
  WorkflowRunDatabaseV17RevisionConflictError,
  WorkflowRunDatabaseV17VersionError,
} from "../src/persistence/run-database-v17.js";
import { RunDatabase, RunDatabaseVersionError } from "../src/persistence/run-database.js";
import {
  workflowV17DefinitionHash,
  type WorkflowV17DefinitionRef,
} from "../src/registry/structured-workflows-v17.js";
import { defaultWorkflowV17RegistryPolicy } from "../src/registry/workflow-v17-policy.js";
import { sha256, stableHash } from "../src/utils/hashes.js";
import type { MeasurementProfileSnapshot } from "../src/measurements/profiles.js";
import type { JsonValue } from "../src/types.js";
import {
  workflowV17FreshCallKey,
  workflowV17LaneSeed,
  workflowV17OperationIdentity,
  workflowV17StructuralJoinKey,
} from "../src/runtime/causal-identity-v17.js";
import type {
  WorkflowOperationV17Record,
  WorkflowScopeCallV17Record,
  WorkflowScopeV17Kind,
  WorkflowStructuralJoinLaneV17Record,
} from "../src/persistence/run-database-v17-types.js";

const roots: string[] = [];
const open = new Set<{ close(): void }>();
const API = path.resolve("workflow-api.d.ts");
const NOW = "2026-06-01T12:00:00.000Z";

const SIMPLE_SOURCE = `
import { schema as s, workflow } from "pi/workflows";

export default workflow({
  description: "Echo one value.",
  input: s.object({ value: s.string({ minLength: 1, maxLength: 100 }) }),
  output: s.object({ value: s.string() }),
  async run(_flow, args) { return { value: args.value }; },
});
`;

const SIMPLE_PARSED = parseWorkflowV17(SIMPLE_SOURCE, {
  fileName: "/virtual/simple.flow.ts",
  apiPath: API,
});

const OPTIMIZE_SOURCE = fs.readFileSync(
  path.resolve("tests/conformance/v17/typecheck/corpus/optimize.flow.ts"),
  "utf8",
);
const OPTIMIZE_PARSED = parseWorkflowV17(OPTIMIZE_SOURCE, {
  fileName: "/virtual/optimize.flow.ts",
  apiPath: API,
});

afterEach(() => {
  for (const database of open) database.close();
  open.clear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("workflow v17 run database", () => {
  it("creates and reopens one immutable-identity schema-4 WAL run", () => {
    const fixture = createDatabase();
    expect(fixture.database.configuration()).toEqual({
      schemaVersion: 4,
      journalMode: "wal",
      foreignKeys: true,
      synchronous: 2,
      busyTimeoutMs: 5_000,
    });
    expect(fixture.database.readRun()).toMatchObject({
      runId: "flow_v17_test",
      revision: 1,
      workflow: {
        id: "user:simple",
        name: "simple",
        snapshotHash: fixture.snapshot.snapshotHash,
      },
      launch: { authority: "user", exposure: "human", projectTrusted: false },
      status: "queued",
      rootScopeId: expect.stringMatching(/^scope_[a-f0-9]{32}$/),
    });
    const root = fixture.database.readScope(fixture.database.readRun().rootScopeId)!;
    expect(root).toMatchObject({
      path: "run",
      kind: "root",
      siblingOrdinal: 0,
      seedKey: WORKFLOW_V17_ROOT_SCOPE_SEED,
      status: "active",
    });
    expect(fixture.database.listInvocationResources()).toEqual([]);
    expect(fixture.database.listEvents()).toEqual([expect.objectContaining({
      sequence: 1,
      revision: 1,
      type: "run-created",
      scopeId: root.scopeId,
    })]);
    fixture.database.validateIntegrity();

    fixture.database.close();
    open.delete(fixture.database);
    const reader = track(WorkflowRunDatabaseV17Reader.open(fixture.databasePath));
    expect(reader.readRun().workflow.snapshotHash).toBe(fixture.snapshot.snapshotHash);
    reader.validateIntegrity();
  });

  it("rejects v16 and unknown schemas without modifying them", () => {
    const root = temporaryRoot();
    for (const version of [0, 1, 2, 3, 99]) {
      const databasePath = path.join(root, `version-${version}.sqlite`);
      const raw = new NativeDatabaseSync(databasePath);
      raw.exec(`PRAGMA user_version = ${version}`);
      raw.close();
      expect(() => WorkflowRunDatabaseV17.open(databasePath)).toThrow(WorkflowRunDatabaseV17VersionError);
      const check = new NativeDatabaseSync(databasePath, { readOnly: true });
      expect((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(version);
      check.close();
    }

    const fixture = createDatabase();
    expect(() => RunDatabase.open(fixture.databasePath)).toThrow(RunDatabaseVersionError);
    expect(fixture.database.readRun().revision).toBe(1);
  });

  it("serializes revisions across independent WAL connections", () => {
    const fixture = createDatabase();
    const contender = track(WorkflowRunDatabaseV17.open(fixture.databasePath));
    const running = fixture.database.transitionRun(1, { status: "running", at: later(1) });
    expect(running).toMatchObject({ revision: 2, status: "running", startedAt: later(1) });
    expect(() => contender.transitionRun(1, { status: "paused", at: later(2) }))
      .toThrow(WorkflowRunDatabaseV17RevisionConflictError);
    expect(contender.readRun()).toMatchObject({ revision: 2, status: "running" });
  });

  it("uses scope-local cursors and restores caught failures into the causal chain", () => {
    const fixture = createRunningDatabase();
    const root = fixture.database.readRun().rootScopeId;
    const first = fixture.database.claimOperation({
      expectedRevision: 2,
      scopeId: root,
      cursor: 0,
      kind: "agent",
      sourceSite: "site-agent-one",
      descriptorSourceSite: "descriptor-agent",
      title: "First display title",
      semanticInputHash: hash("first-input"),
      at: later(2),
    });
    expect(first.claimed).toBe(true);
    expect(first.operation.path).toBe("run/000000");
    expect(fixture.database.claimOperation({
      expectedRevision: 3,
      scopeId: root,
      cursor: 0,
      kind: "agent",
      sourceSite: "site-agent-one",
      descriptorSourceSite: "descriptor-agent",
      title: "Changed display only",
      semanticInputHash: hash("first-input"),
      at: later(3),
    })).toMatchObject({ claimed: false, operation: { title: "First display title" } });
    expect(() => fixture.database.claimOperation({
      expectedRevision: 3,
      scopeId: root,
      cursor: 1,
      kind: "command",
      sourceSite: "site-command",
      semanticInputHash: hash("second-input"),
      at: later(3),
    })).toThrow(/unsettled cursor/);

    const firstFailure = { category: "effect", code: "expected", summary: "caught", retryable: false };
    const firstCallKey = causalCallKey(fixture.database, first.operation, {
      previousCallKey: WORKFLOW_V17_ROOT_SCOPE_SEED,
      semanticKey: hash("first-semantic"),
      outcome: "failure",
      completionAuthority: "host-effect",
      replayPolicy: "never",
      result: firstFailure,
    });
    fixture.database.completeCall({
      expectedRevision: 3,
      operationId: first.operation.operationId,
      previousCallKey: WORKFLOW_V17_ROOT_SCOPE_SEED,
      semanticKey: hash("first-semantic"),
      callKey: firstCallKey,
      outcome: "failure",
      completionAuthority: "host-effect",
      replayPolicy: "never",
      failure: firstFailure,
      at: later(4),
    });
    const second = fixture.database.claimOperation({
      expectedRevision: 4,
      scopeId: root,
      cursor: 1,
      kind: "command",
      sourceSite: "site-command",
      semanticInputHash: hash("second-input"),
      at: later(5),
    }).operation;
    const secondCallKey = causalCallKey(fixture.database, second, {
      previousCallKey: firstCallKey,
      semanticKey: hash("second-semantic"),
      outcome: "success",
      completionAuthority: "host-effect",
      replayPolicy: "immutable",
      result: { ok: true },
    });
    fixture.database.completeCall({
      expectedRevision: 5,
      operationId: second.operationId,
      previousCallKey: firstCallKey,
      semanticKey: hash("second-semantic"),
      callKey: secondCallKey,
      outcome: "success",
      completionAuthority: "host-effect",
      replayPolicy: "immutable",
      result: { ok: true },
      at: later(6),
    });
    expect(fixture.database.listScopeCalls(root)).toEqual([
      expect.objectContaining({ cursor: 0, outcome: "failure", replayPolicy: "never" }),
      expect.objectContaining({ cursor: 1, previousCallKey: firstCallKey, outcome: "success" }),
    ]);
    fixture.database.completeScope({
      expectedRevision: 6,
      scopeId: root,
      status: "completed",
      terminalKey: secondCallKey,
      at: later(7),
    });
    fixture.database.transitionRun(7, {
      status: "completed",
      rootTerminalKey: secondCallKey,
      at: later(8),
    });
    fixture.database.validateIntegrity();
    expect(fixture.database.readRun()).toMatchObject({ status: "completed", revision: 8 });
  });

  it("preclaims keyed child scopes atomically and commits a completion-order-independent join", () => {
    const fixture = createRunningDatabase();
    const database = fixture.database;
    const root = database.readRun().rootScopeId;
    const group = database.claimOperation({
      expectedRevision: 2,
      scopeId: root,
      cursor: 0,
      kind: "parallel",
      sourceSite: "site-parallel",
      semanticInputHash: hash("parallel-input"),
      at: later(2),
    }).operation;
    const alphaSeed = causalLaneSeed(database, group, {
      childKind: "parallel-branch", laneKey: "alpha",
    });
    const betaSeed = causalLaneSeed(database, group, {
      childKind: "parallel-branch", laneKey: "beta",
    });
    const created = database.createChildScopes(3, group.operationId, [
      { kind: "parallel-branch", laneKey: "alpha", seedKey: alphaSeed },
      { kind: "parallel-branch", laneKey: "beta", seedKey: betaSeed },
    ], later(3));
    expect(created).toMatchObject({
      created: true,
      scopes: [
        { path: "run/000000/branch:alpha", siblingOrdinal: 0, laneKey: "alpha" },
        { path: "run/000000/branch:beta", siblingOrdinal: 1, laneKey: "beta" },
      ],
    });
    expect(database.createChildScopes(4, group.operationId, [
      { kind: "parallel-branch", laneKey: "alpha", seedKey: alphaSeed },
      { kind: "parallel-branch", laneKey: "beta", seedKey: betaSeed },
    ], later(4))).toMatchObject({ created: false });
    expect(database.readRun().revision).toBe(4);

    const alpha = database.claimOperation({
      expectedRevision: 4,
      scopeId: created.scopes[0]!.scopeId,
      cursor: 0,
      kind: "agent",
      sourceSite: "site-alpha-agent",
      semanticInputHash: hash("alpha-input"),
      at: later(5),
    }).operation;
    const beta = database.claimOperation({
      expectedRevision: 5,
      scopeId: created.scopes[1]!.scopeId,
      cursor: 0,
      kind: "agent",
      sourceSite: "site-beta-agent",
      semanticInputHash: hash("beta-input"),
      at: later(6),
    }).operation;

    // Beta settles first. Its local chain is still betaSeed → betaCall.
    const betaCallKey = causalCallKey(database, beta, {
      previousCallKey: betaSeed,
      semanticKey: hash("beta-semantic"),
      outcome: "success",
      completionAuthority: "finish-work",
      replayPolicy: "immutable",
      result: { lane: "beta" },
    });
    database.completeCall({
      expectedRevision: 6,
      operationId: beta.operationId,
      previousCallKey: betaSeed,
      semanticKey: hash("beta-semantic"),
      callKey: betaCallKey,
      outcome: "success",
      completionAuthority: "finish-work",
      replayPolicy: "immutable",
      result: { lane: "beta" },
      at: later(7),
    });
    database.completeScope({
      expectedRevision: 7,
      scopeId: created.scopes[1]!.scopeId,
      status: "completed",
      terminalKey: betaCallKey,
      at: later(8),
    });
    const alphaCallKey = causalCallKey(database, alpha, {
      previousCallKey: alphaSeed,
      semanticKey: hash("alpha-semantic"),
      outcome: "success",
      completionAuthority: "finish-work",
      replayPolicy: "immutable",
      result: { lane: "alpha" },
    });
    database.completeCall({
      expectedRevision: 8,
      operationId: alpha.operationId,
      previousCallKey: alphaSeed,
      semanticKey: hash("alpha-semantic"),
      callKey: alphaCallKey,
      outcome: "success",
      completionAuthority: "finish-work",
      replayPolicy: "immutable",
      result: { lane: "alpha" },
      at: later(9),
    });
    database.completeScope({
      expectedRevision: 9,
      scopeId: created.scopes[0]!.scopeId,
      status: "completed",
      terminalKey: alphaCallKey,
      at: later(10),
    });

    const revisionBeforeRejectedJoin = database.readRun().revision;
    const rejectedLanes = [{
      laneKey: "alpha",
      scopeId: created.scopes[0]!.scopeId,
      terminalKey: alphaCallKey,
      outcome: "success" as const,
    }];
    const rejectedResult = { alpha: { lane: "alpha" } };
    const rejectedJoinKey = causalJoinKey(group, {
      previousCallKey: WORKFLOW_V17_ROOT_SCOPE_SEED,
      semanticKey: hash("parallel-semantic"),
      policyHash: hash("parallel-policy"),
      outputOrder: ["alpha"],
      lanes: rejectedLanes,
      result: rejectedResult,
    });
    expect(() => database.completeStructuralJoin({
      expectedRevision: revisionBeforeRejectedJoin,
      operationId: group.operationId,
      previousCallKey: WORKFLOW_V17_ROOT_SCOPE_SEED,
      semanticKey: hash("parallel-semantic"),
      callKey: rejectedJoinKey,
      joinKey: rejectedJoinKey,
      kind: "parallel",
      policyHash: hash("parallel-policy"),
      outputOrder: ["alpha"],
      lanes: rejectedLanes,
      result: rejectedResult,
      at: later(11),
    })).toThrow(/does not settle every child scope/);
    expect(database.readRun().revision).toBe(revisionBeforeRejectedJoin);
    expect(database.readStructuralJoin(group.operationId)).toBeUndefined();

    const joinedLanes = [
      {
        laneKey: "alpha", scopeId: created.scopes[0]!.scopeId,
        terminalKey: alphaCallKey, outcome: "success" as const,
      },
      {
        laneKey: "beta", scopeId: created.scopes[1]!.scopeId,
        terminalKey: betaCallKey, outcome: "success" as const,
      },
    ];
    const joinedResult = { alpha: { lane: "alpha" }, beta: { lane: "beta" } };
    const parallelJoinKey = causalJoinKey(group, {
      previousCallKey: WORKFLOW_V17_ROOT_SCOPE_SEED,
      semanticKey: hash("parallel-semantic"),
      policyHash: hash("parallel-policy"),
      outputOrder: ["alpha", "beta"],
      lanes: joinedLanes,
      result: joinedResult,
    });
    database.completeStructuralJoin({
      expectedRevision: revisionBeforeRejectedJoin,
      operationId: group.operationId,
      previousCallKey: WORKFLOW_V17_ROOT_SCOPE_SEED,
      semanticKey: hash("parallel-semantic"),
      callKey: parallelJoinKey,
      joinKey: parallelJoinKey,
      kind: "parallel",
      policyHash: hash("parallel-policy"),
      outputOrder: ["alpha", "beta"],
      lanes: joinedLanes,
      result: joinedResult,
      at: later(12),
    });
    expect(database.readStructuralJoin(group.operationId)).toEqual(expect.objectContaining({
      kind: "parallel",
      outputOrder: ["alpha", "beta"],
      joinKey: parallelJoinKey,
      lanes: [
        expect.objectContaining({ laneKey: "alpha", terminalKey: alphaCallKey }),
        expect.objectContaining({ laneKey: "beta", terminalKey: betaCallKey }),
      ],
    }));
    expect(database.listOperations().map((operation) => operation.path)).toEqual([
      "run/000000",
      "run/000000/branch:alpha/000000",
      "run/000000/branch:beta/000000",
    ]);
    database.validateIntegrity();
  });

  it("persists exact invocation-selected resources and detects post-launch corruption", () => {
    const root = temporaryRoot();
    const profile = measurementProfile(root);
    const policy = defaultWorkflowV17RegistryPolicy(root, "user");
    const ref: WorkflowV17DefinitionRef = {
      formatVersion: 1,
      id: "user:optimize",
      namespace: "user",
      name: "optimize",
      description: OPTIMIZE_PARSED.metadata.description,
      input: OPTIMIZE_PARSED.metadata.input,
      output: OPTIMIZE_PARSED.metadata.output,
      exposure: "human",
      policy,
      path: path.join(root, "optimize.flow.ts"),
      source: OPTIMIZE_SOURCE,
      sourceHash: OPTIMIZE_PARSED.sourceHash,
      definitionHash: workflowV17DefinitionHash("user:optimize", OPTIMIZE_PARSED),
      parsed: OPTIMIZE_PARSED,
    };
    const snapshot = createWorkflowV17InvocationSnapshot(ref, {
      objective: "reduce latency",
      writePaths: ["src/parser.ts"],
      evaluator: profile.id,
      metrics: {
        primary: { output: "latency", direction: "minimize" },
        guardrails: [{
          output: "memory",
          direction: "minimize",
          reference: "baseline",
          maximumRelativeRegression: 0.05,
        }],
      },
      sampling: { warmups: 1, samples: 3 },
      maxIterations: 2,
    }, {
      authority: "user",
      projectTrusted: false,
      measurementProfiles: { resolve: () => structuredClone(profile) },
    });
    const databasePath = path.join(root, "resource-run.sqlite");
    const database = track(WorkflowRunDatabaseV17.create(databasePath, {
      runId: "flow_v17_resource",
      snapshot,
      projectSnapshotHash: hash("resource-project"),
      routeSnapshotHash: hash("resource-routes"),
      contextIdentityHash: hash("resource-context"),
      safety: safety(),
      createdAt: NOW,
    }));
    expect(database.listInvocationResources()).toEqual([expect.objectContaining({
      kind: "measurement-profile",
      inputPath: "/evaluator",
      selector: "user:bench",
      snapshotHash: profile.hash,
      bindingHash: snapshot.resources[0]!.bindingHash,
      resource: snapshot.resources[0],
    })]);
    database.validateIntegrity();

    database.close();
    open.delete(database);
    const raw = new NativeDatabaseSync(databasePath);
    raw.prepare("UPDATE invocation_resources SET snapshot_hash = ?").run(hash("forged-profile"));
    raw.close();
    const corrupted = track(WorkflowRunDatabaseV17.open(databasePath));
    expect(() => corrupted.validateIntegrity()).toThrow(WorkflowRunDatabaseV17CorruptionError);
  });

  it("detects cursor-chain and canonical-JSON corruption rather than repairing it", () => {
    const fixture = createRunningDatabase();
    const rootScope = fixture.database.readRun().rootScopeId;
    completeRootEffect(fixture.database, rootScope, 0, "command", WORKFLOW_V17_ROOT_SCOPE_SEED, "corrupt", { ok: true });
    fixture.database.close();
    open.delete(fixture.database);

    const raw = new NativeDatabaseSync(fixture.databasePath);
    raw.prepare("UPDATE scope_calls SET previous_call_key = ?").run(hash("wrong-previous"));
    raw.prepare("UPDATE events SET payload_json = ? WHERE sequence = 1").run('{"z":1,"a":2}');
    raw.close();
    const database = track(WorkflowRunDatabaseV17.open(fixture.databasePath));
    expect(() => database.listEvents()).toThrow(WorkflowRunDatabaseV17CorruptionError);
    expect(() => database.validateIntegrity()).toThrow(WorkflowRunDatabaseV17CorruptionError);
  });

  it("binds candidate measurement and passed verification into one acceptance and apply", () => {
    const frozen = createFrozenCandidate(["src/parser.ts"]);
    const { database, candidate, rootScopeId } = frozen;
    const measurement = completeRootEffect(
      database,
      rootScopeId,
      1,
      "measure",
      frozen.candidateCallKey,
      "candidate-measure",
      { measurementId: "measurement_candidate" },
    );
    database.registerCandidateMeasurement(database.readRun().revision, {
      measurementId: "measurement_candidate",
      candidateId: candidate.candidateId,
      operationId: measurement.operation.operationId,
      bindingHash: hash("measurement-binding"),
      createdAt: later(database.readRun().revision + 1),
    });
    const verificationArtifact = storeArtifact(database, "verification-evidence");
    const verification = completeRootEffect(
      database,
      rootScopeId,
      2,
      "verify",
      measurement.callKey,
      "candidate-verify",
      { status: "passed" },
    );
    database.registerCandidateVerification(database.readRun().revision, {
      verificationId: "verification_candidate",
      candidateId: candidate.candidateId,
      operationId: verification.operation.operationId,
      status: "passed",
      bindingHash: hash("verification-binding"),
      evidenceHash: hash("verification-evidence-hash"),
      artifactDigest: verificationArtifact.digest,
      createdAt: later(database.readRun().revision + 1),
    });
    const acceptance = completeRootEffect(
      database,
      rootScopeId,
      3,
      "accept",
      verification.callKey,
      "candidate-accept",
      { accepted: true },
    );

    const revisionBeforeMissingMeasurement = database.readRun().revision;
    expect(() => database.disposeCandidate({
      expectedRevision: revisionBeforeMissingMeasurement,
      candidateId: candidate.candidateId,
      operationId: acceptance.operation.operationId,
      disposition: "accepted",
      verificationId: "verification_candidate",
      at: later(revisionBeforeMissingMeasurement + 1),
    })).toThrow(/exact disposition evidence/);
    expect(database.readRun().revision).toBe(revisionBeforeMissingMeasurement);

    const accepted = database.disposeCandidate({
      expectedRevision: revisionBeforeMissingMeasurement,
      candidateId: candidate.candidateId,
      operationId: acceptance.operation.operationId,
      disposition: "accepted",
      verificationId: "verification_candidate",
      measurementId: "measurement_candidate",
      at: later(revisionBeforeMissingMeasurement + 1),
    });
    expect(accepted).toMatchObject({
      state: "accepted",
      disposition: {
        disposition: "accepted",
        verificationId: "verification_candidate",
        measurementId: "measurement_candidate",
        authorityHash: expect.stringMatching(/^sha256:/),
      },
    });
    expect(database.readCandidateMeasurement(candidate.candidateId)).toMatchObject({ status: "accepted" });
    expect(() => database.disposeCandidate({
      expectedRevision: database.readRun().revision,
      candidateId: candidate.candidateId,
      disposition: "abandoned",
      reason: { category: "workflow", code: "again", summary: "again", retryable: false },
      at: later(database.readRun().revision + 1),
    })).toThrow(/is accepted/);

    const appliedEffect = completeRootEffect(
      database,
      rootScopeId,
      4,
      "apply",
      acceptance.callKey,
      "candidate-apply",
      { applied: true },
    );
    const applied = database.recordCandidateApply(database.readRun().revision, {
      receiptId: "apply_receipt_candidate",
      candidateId: candidate.candidateId,
      operationId: appliedEffect.operation.operationId,
      approvalId: "approval_candidate",
      verificationBindingHash: hash("verification-binding"),
      authorityHash: hash("apply-authority"),
      appliedAt: later(database.readRun().revision + 1),
    });
    expect(applied).toMatchObject({ state: "applied", appliedReceiptId: "apply_receipt_candidate" });
    database.completeScope({
      expectedRevision: database.readRun().revision,
      scopeId: rootScopeId,
      status: "completed",
      terminalKey: appliedEffect.callKey,
      at: later(database.readRun().revision + 1),
    });
    database.transitionRun(database.readRun().revision, {
      status: "completed",
      rootTerminalKey: appliedEffect.callKey,
      at: later(database.readRun().revision + 1),
    });
    database.validateIntegrity();
  });

  it("auto-discards unchanged candidates but refuses successful completion with changed pending work", () => {
    const unchanged = createFrozenCandidate([]);
    unchanged.database.completeScope({
      expectedRevision: unchanged.database.readRun().revision,
      scopeId: unchanged.rootScopeId,
      status: "completed",
      terminalKey: unchanged.candidateCallKey,
      at: later(unchanged.database.readRun().revision + 1),
    });
    unchanged.database.transitionRun(unchanged.database.readRun().revision, {
      status: "completed",
      rootTerminalKey: unchanged.candidateCallKey,
      at: later(unchanged.database.readRun().revision + 1),
    });
    expect(unchanged.database.readCandidate(unchanged.candidate.candidateId)).toMatchObject({
      state: "discarded",
      disposition: {
        disposition: "discarded",
        reason: expect.objectContaining({ code: "unchanged-candidate" }),
      },
    });
    unchanged.database.validateIntegrity();

    const changed = createFrozenCandidate(["src/changed.ts"]);
    changed.database.completeScope({
      expectedRevision: changed.database.readRun().revision,
      scopeId: changed.rootScopeId,
      status: "completed",
      terminalKey: changed.candidateCallKey,
      at: later(changed.database.readRun().revision + 1),
    });
    const before = changed.database.readRun().revision;
    expect(() => changed.database.transitionRun(before, {
      status: "completed",
      rootTerminalKey: changed.candidateCallKey,
      at: later(before + 1),
    })).toThrow(/undisposed nonempty candidate/);
    expect(changed.database.readRun()).toMatchObject({ revision: before, status: "running" });
    expect(changed.database.readCandidate(changed.candidate.candidateId)?.state).toBe("pending");
  });

  it("records rejection with optional failed verification and permits successful completion", () => {
    const frozen = createFrozenCandidate(["src/rejected.ts"]);
    const artifact = storeArtifact(frozen.database, "failed-verification-evidence");
    const verification = completeRootEffect(
      frozen.database,
      frozen.rootScopeId,
      1,
      "verify",
      frozen.candidateCallKey,
      "rejected-verify",
      { status: "failed" },
    );
    frozen.database.registerCandidateVerification(frozen.database.readRun().revision, {
      verificationId: "verification_rejected",
      candidateId: frozen.candidate.candidateId,
      operationId: verification.operation.operationId,
      status: "failed",
      bindingHash: hash("rejected-verification-binding"),
      evidenceHash: hash("rejected-verification-evidence"),
      artifactDigest: artifact.digest,
      createdAt: later(frozen.database.readRun().revision + 1),
    });
    const rejection = completeRootEffect(
      frozen.database,
      frozen.rootScopeId,
      2,
      "reject",
      verification.callKey,
      "candidate-reject",
      { rejected: true },
    );
    expect(frozen.database.disposeCandidate({
      expectedRevision: frozen.database.readRun().revision,
      candidateId: frozen.candidate.candidateId,
      operationId: rejection.operation.operationId,
      disposition: "rejected",
      verificationId: "verification_rejected",
      reason: { category: "workflow", code: "verification-failed", summary: "Verification failed", retryable: false },
      at: later(frozen.database.readRun().revision + 1),
    })).toMatchObject({
      state: "rejected",
      disposition: { disposition: "rejected", verificationId: "verification_rejected" },
    });
    frozen.database.completeScope({
      expectedRevision: frozen.database.readRun().revision,
      scopeId: frozen.rootScopeId,
      status: "completed",
      terminalKey: rejection.callKey,
      at: later(frozen.database.readRun().revision + 1),
    });
    frozen.database.transitionRun(frozen.database.readRun().revision, {
      status: "completed",
      rootTerminalKey: rejection.callKey,
      at: later(frozen.database.readRun().revision + 1),
    });
    frozen.database.validateIntegrity();
  });

  it("preserves candidates on pause and atomically abandons work and pending measurements on termination", () => {
    const frozen = createFrozenCandidate(["src/changed.ts"]);
    frozen.database.transitionRun(frozen.database.readRun().revision, {
      status: "paused",
      at: later(frozen.database.readRun().revision + 1),
    });
    expect(frozen.database.readCandidate(frozen.candidate.candidateId)?.state).toBe("pending");
    frozen.database.transitionRun(frozen.database.readRun().revision, {
      status: "running",
      at: later(frozen.database.readRun().revision + 1),
    });
    const measured = completeRootEffect(
      frozen.database,
      frozen.rootScopeId,
      1,
      "measure",
      frozen.candidateCallKey,
      "termination-measure",
      { measurementId: "measurement_termination" },
    );
    frozen.database.registerCandidateMeasurement(frozen.database.readRun().revision, {
      measurementId: "measurement_termination",
      candidateId: frozen.candidate.candidateId,
      operationId: measured.operation.operationId,
      bindingHash: hash("termination-measurement-binding"),
      createdAt: later(frozen.database.readRun().revision + 1),
    });
    frozen.database.transitionRun(frozen.database.readRun().revision, {
      status: "failed",
      reason: { category: "workflow", code: "test-failure", summary: "failed", retryable: false },
      at: later(frozen.database.readRun().revision + 1),
    });
    expect(frozen.database.readCandidate(frozen.candidate.candidateId)).toMatchObject({
      state: "abandoned",
      disposition: { disposition: "abandoned" },
    });
    expect(frozen.database.readCandidateMeasurement(frozen.candidate.candidateId)).toMatchObject({
      status: "rejected",
    });
    expect(frozen.database.readRun()).toMatchObject({ status: "failed" });
    expect(frozen.database.readRun().currentOperationId).toBeUndefined();
    frozen.database.validateIntegrity();
  });

  it("abandons a mutable candidate callback workspace on failure", () => {
    const fixture = createRunningDatabase();
    const database = fixture.database;
    const rootScopeId = database.readRun().rootScopeId;
    const candidate = database.claimOperation({
      expectedRevision: database.readRun().revision,
      scopeId: rootScopeId,
      cursor: 0,
      kind: "candidate",
      sourceSite: "site-mutable-candidate",
      semanticInputHash: hash("mutable-candidate-input"),
      at: later(database.readRun().revision + 1),
    }).operation;
    const body = database.createChildScopes(database.readRun().revision, candidate.operationId, [{
      kind: "candidate-body",
      seedKey: causalLaneSeed(database, candidate, { childKind: "candidate-body" }),
    }], later(database.readRun().revision + 1)).scopes[0]!;
    database.createCandidateWorkspace({
      expectedRevision: database.readRun().revision,
      workspaceId: "candidate_workspace_mutable",
      candidateOperationId: candidate.operationId,
      bodyScopeId: body.scopeId,
      initialTreeHash: hash("mutable-initial-tree"),
      baseLineageHash: hash("mutable-base-lineage"),
      writeScope: { allow: ["src"] },
      writeScopeHash: hash("mutable-write-scope"),
      rootPath: "workspaces/candidate-workspace-mutable/project",
      at: later(database.readRun().revision + 1),
    });
    database.transitionRun(database.readRun().revision, {
      status: "failed",
      reason: { category: "workflow", code: "callback-failed", summary: "callback failed", retryable: false },
      at: later(database.readRun().revision + 1),
    });
    expect(database.readCandidateWorkspace("candidate_workspace_mutable")).toMatchObject({
      state: "abandoned",
      failure: expect.objectContaining({ code: "callback-failed" }),
    });
    expect(database.readOperation(candidate.operationId)?.status).toBe("cancelled");
    expect(database.readScope(body.scopeId)?.status).toBe("cancelled");
    database.validateIntegrity();
  });

  it("binds one mutable workspace to one lane per concurrency group", () => {
    const fixture = createRunningDatabase();
    const database = fixture.database;
    const rootScopeId = database.readRun().rootScopeId;
    const group = database.claimOperation({
      expectedRevision: database.readRun().revision,
      scopeId: rootScopeId,
      cursor: 0,
      kind: "parallel",
      sourceSite: "site-workspace-parallel",
      semanticInputHash: hash("workspace-parallel-input"),
      at: later(database.readRun().revision + 1),
    }).operation;
    const lanes = database.createChildScopes(database.readRun().revision, group.operationId, [
      {
        kind: "parallel-branch", laneKey: "left",
        seedKey: causalLaneSeed(database, group, { childKind: "parallel-branch", laneKey: "left" }),
      },
      {
        kind: "parallel-branch", laneKey: "right",
        seedKey: causalLaneSeed(database, group, { childKind: "parallel-branch", laneKey: "right" }),
      },
    ], later(database.readRun().revision + 1)).scopes;
    const candidate = database.claimOperation({
      expectedRevision: database.readRun().revision,
      scopeId: lanes[0]!.scopeId,
      cursor: 0,
      kind: "candidate",
      sourceSite: "site-lane-candidate",
      semanticInputHash: hash("lane-candidate-input"),
      at: later(database.readRun().revision + 1),
    }).operation;
    const body = database.createChildScopes(database.readRun().revision, candidate.operationId, [{
      kind: "candidate-body",
      seedKey: causalLaneSeed(database, candidate, { childKind: "candidate-body" }),
    }], later(database.readRun().revision + 1)).scopes[0]!;
    database.createCandidateWorkspace({
      expectedRevision: database.readRun().revision,
      workspaceId: "candidate_workspace_lane",
      candidateOperationId: candidate.operationId,
      bodyScopeId: body.scopeId,
      initialTreeHash: hash("lane-initial-tree"),
      baseLineageHash: hash("lane-base-lineage"),
      writeScope: { allow: ["src"] },
      writeScopeHash: hash("lane-write-scope"),
      rootPath: "workspaces/candidate-workspace-lane/project",
      at: later(database.readRun().revision + 1),
    });
    database.bindCandidateWorkspaceLane(database.readRun().revision, {
      workspaceId: "candidate_workspace_lane",
      groupOperationId: group.operationId,
      laneKey: "left",
      at: later(database.readRun().revision + 1),
    });
    const revision = database.readRun().revision;
    database.bindCandidateWorkspaceLane(revision, {
      workspaceId: "candidate_workspace_lane",
      groupOperationId: group.operationId,
      laneKey: "left",
      at: later(revision + 1),
    });
    expect(database.readRun().revision).toBe(revision);
    expect(() => database.bindCandidateWorkspaceLane(revision, {
      workspaceId: "candidate_workspace_lane",
      groupOperationId: group.operationId,
      laneKey: "right",
      at: later(revision + 1),
    })).toThrow(/shared by sibling lanes left and right/);
    expect(database.readRun().revision).toBe(revision);
  });

  it("persists attempt and exact workspace-checkpoint authority and settles live attempts on stop", () => {
    const fixture = createRunningDatabase();
    const database = fixture.database;
    const rootScopeId = database.readRun().rootScopeId;
    const operation = database.claimOperation({
      expectedRevision: database.readRun().revision,
      scopeId: rootScopeId,
      cursor: 0,
      kind: "command",
      sourceSite: "site-checkpoint-command",
      semanticInputHash: hash("checkpoint-command-input"),
      at: later(database.readRun().revision + 1),
    }).operation;
    database.insertAttempt(database.readRun().revision, {
      attemptId: "attempt_checkpoint",
      runId: database.readRun().runId,
      operationId: operation.operationId,
      number: 1,
      effect: "command",
      executionId: "execution_checkpoint",
      status: "running",
      usage: {},
      createdAt: later(database.readRun().revision + 1),
      updatedAt: later(database.readRun().revision + 1),
    });
    const checkpoint = database.insertWorkspaceCheckpoint(database.readRun().revision, {
      checkpointId: "checkpoint_command",
      runId: database.readRun().runId,
      operationId: operation.operationId,
      workspaceId: "candidate_workspace_authority",
      treeHash: hash("checkpoint-tree"),
      lineageHash: hash("checkpoint-lineage"),
      writeScopeHash: hash("checkpoint-write-scope"),
      storagePath: "workspaces/checkpoints/checkpoint-command",
      createdAt: later(database.readRun().revision + 1),
    });
    expect(checkpoint).toMatchObject({ checkpointId: "checkpoint_command", treeHash: hash("checkpoint-tree") });
    expect(database.completeAttempt({
      expectedRevision: database.readRun().revision,
      attemptId: "attempt_checkpoint",
      status: "completed",
      usage: { elapsedMs: 12 },
      resources: { cpuUsec: 4 },
      at: later(database.readRun().revision + 1),
    })).toMatchObject({
      status: "completed",
      usage: { elapsedMs: 12 },
      resources: { cpuUsec: 4 },
    });
    const checkpointResult = { checkpointId: checkpoint.checkpointId };
    const checkpointCallKey = causalCallKey(database, operation, {
      previousCallKey: WORKFLOW_V17_ROOT_SCOPE_SEED,
      semanticKey: hash("checkpoint-semantic"),
      outcome: "success",
      completionAuthority: "host-effect",
      replayPolicy: "workspace",
      result: checkpointResult,
    });
    database.completeCall({
      expectedRevision: database.readRun().revision,
      operationId: operation.operationId,
      previousCallKey: WORKFLOW_V17_ROOT_SCOPE_SEED,
      semanticKey: hash("checkpoint-semantic"),
      callKey: checkpointCallKey,
      outcome: "success",
      completionAuthority: "host-effect",
      replayPolicy: "workspace",
      result: checkpointResult,
      postWorkspaceCheckpointId: checkpoint.checkpointId,
      at: later(database.readRun().revision + 1),
    });
    database.completeScope({
      expectedRevision: database.readRun().revision,
      scopeId: rootScopeId,
      status: "completed",
      terminalKey: checkpointCallKey,
      at: later(database.readRun().revision + 1),
    });
    database.transitionRun(database.readRun().revision, {
      status: "completed",
      rootTerminalKey: checkpointCallKey,
      at: later(database.readRun().revision + 1),
    });
    database.validateIntegrity();

    const stopped = createRunningDatabase();
    const stoppedOperation = stopped.database.claimOperation({
      expectedRevision: stopped.database.readRun().revision,
      scopeId: stopped.database.readRun().rootScopeId,
      cursor: 0,
      kind: "agent",
      sourceSite: "site-stopped-agent",
      semanticInputHash: hash("stopped-agent-input"),
      at: later(stopped.database.readRun().revision + 1),
    }).operation;
    stopped.database.insertAttempt(stopped.database.readRun().revision, {
      attemptId: "attempt_stopped",
      runId: stopped.database.readRun().runId,
      operationId: stoppedOperation.operationId,
      number: 1,
      effect: "agent",
      status: "running",
      usage: {},
      createdAt: later(stopped.database.readRun().revision + 1),
      updatedAt: later(stopped.database.readRun().revision + 1),
    });
    stopped.database.transitionRun(stopped.database.readRun().revision, {
      status: "stopped",
      at: later(stopped.database.readRun().revision + 1),
    });
    expect(stopped.database.readAttempt("attempt_stopped")?.status).toBe("stopped");
    expect(stopped.database.readOperation(stoppedOperation.operationId)?.status).toBe("stopped");
    stopped.database.validateIntegrity();
  });
});

function createDatabase() {
  const root = temporaryRoot();
  const policy = defaultWorkflowV17RegistryPolicy(root, "user");
  const ref: WorkflowV17DefinitionRef = {
    formatVersion: 1,
    id: "user:simple",
    namespace: "user",
    name: "simple",
    description: SIMPLE_PARSED.metadata.description,
    input: SIMPLE_PARSED.metadata.input,
    output: SIMPLE_PARSED.metadata.output,
    exposure: "human",
    policy,
    path: path.join(root, "simple.flow.ts"),
    source: SIMPLE_SOURCE,
    sourceHash: SIMPLE_PARSED.sourceHash,
    definitionHash: workflowV17DefinitionHash("user:simple", SIMPLE_PARSED),
    parsed: SIMPLE_PARSED,
  };
  const snapshot = createWorkflowV17InvocationSnapshot(ref, { value: "hello" }, {
    authority: "user",
    projectTrusted: false,
  });
  const databasePath = path.join(root, "run.sqlite");
  const database = track(WorkflowRunDatabaseV17.create(databasePath, {
    runId: "flow_v17_test",
    snapshot,
    projectSnapshotHash: hash("project"),
    routeSnapshotHash: hash("routes"),
    contextIdentityHash: hash("context"),
    safety: safety(),
    createdAt: NOW,
  }));
  return { root, databasePath, database, snapshot };
}

function createRunningDatabase() {
  const fixture = createDatabase();
  fixture.database.transitionRun(1, { status: "running", at: later(1) });
  return fixture;
}

function causalLaneSeed(
  database: WorkflowRunDatabaseV17,
  owner: WorkflowOperationV17Record,
  spec: { childKind: Exclude<WorkflowScopeV17Kind, "root">; laneKey?: string },
) {
  const scope = database.readScope(owner.scopeId)!;
  const previous = owner.cursor === 0
    ? scope.seedKey
    : database.listScopeCalls(scope.scopeId)[owner.cursor - 1]!.callKey;
  return workflowV17LaneSeed({
    parentPreviousCallKey: previous,
    ownerOperationPath: owner.path,
    ownerKind: owner.kind as "parallel" | "map" | "candidate",
    childKind: spec.childKind,
    ...(spec.laneKey !== undefined ? { laneKey: spec.laneKey } : {}),
  });
}

function causalCallKey(
  database: WorkflowRunDatabaseV17,
  operation: WorkflowOperationV17Record,
  input: {
    previousCallKey: string;
    semanticKey: string;
    outcome: WorkflowScopeCallV17Record["outcome"];
    completionAuthority: Exclude<WorkflowScopeCallV17Record["completionAuthority"], "structural-join">;
    replayPolicy: WorkflowScopeCallV17Record["replayPolicy"];
    result: JsonValue;
  },
) {
  return workflowV17FreshCallKey({
    runId: database.readRun().runId,
    previousCallKey: input.previousCallKey,
    operation: workflowV17OperationIdentity(operation),
    semanticKey: input.semanticKey,
    outcome: input.outcome,
    completionAuthority: input.completionAuthority,
    replayPolicy: input.replayPolicy,
    result: input.result,
  });
}

function causalJoinKey(
  operation: WorkflowOperationV17Record,
  input: {
    previousCallKey: string;
    semanticKey: string;
    policyHash: string;
    outputOrder: string[];
    lanes: Array<Pick<WorkflowStructuralJoinLaneV17Record, "laneKey" | "terminalKey" | "outcome">>;
    result: JsonValue;
  },
) {
  return workflowV17StructuralJoinKey({
    ...input,
    operation: workflowV17OperationIdentity(operation),
  });
}

function completeRootEffect(
  database: WorkflowRunDatabaseV17,
  scopeId: string,
  cursor: number,
  kind: "agent" | "command" | "measure" | "verify" | "accept" | "reject" | "apply",
  previousCallKey: string,
  label: string,
  result: JsonValue,
) {
  const claimed = database.claimOperation({
    expectedRevision: database.readRun().revision,
    scopeId,
    cursor,
    kind,
    sourceSite: `site-${label}`,
    semanticInputHash: hash(`${label}-input`),
    at: later(database.readRun().revision + 1),
  }).operation;
  const semanticKey = hash(`${label}-semantic`);
  const completionAuthority = kind === "agent" ? "finish-work" as const : "host-effect" as const;
  const replayPolicy = kind === "apply" ? "never" as const : "immutable" as const;
  const callKey = causalCallKey(database, claimed, {
    previousCallKey,
    semanticKey,
    outcome: "success",
    completionAuthority,
    replayPolicy,
    result,
  });
  database.completeCall({
    expectedRevision: database.readRun().revision,
    operationId: claimed.operationId,
    previousCallKey,
    semanticKey,
    callKey,
    outcome: "success",
    completionAuthority,
    replayPolicy,
    result,
    at: later(database.readRun().revision + 1),
  });
  return { operation: database.readOperation(claimed.operationId)!, callKey };
}

function createFrozenCandidate(changedPaths: string[]) {
  const fixture = createRunningDatabase();
  const database = fixture.database;
  const rootScopeId = database.readRun().rootScopeId;
  const operation = database.claimOperation({
    expectedRevision: database.readRun().revision,
    scopeId: rootScopeId,
    cursor: 0,
    kind: "candidate",
    sourceSite: "site-candidate",
    semanticInputHash: hash("candidate-input"),
    at: later(database.readRun().revision + 1),
  }).operation;
  const bodySeed = causalLaneSeed(database, operation, { childKind: "candidate-body" });
  const body = database.createChildScopes(database.readRun().revision, operation.operationId, [{
    kind: "candidate-body",
    seedKey: bodySeed,
  }], later(database.readRun().revision + 1)).scopes[0]!;
  database.createCandidateWorkspace({
    expectedRevision: database.readRun().revision,
    workspaceId: "candidate_workspace_test",
    candidateOperationId: operation.operationId,
    bodyScopeId: body.scopeId,
    initialTreeHash: hash("candidate-initial-tree"),
    baseLineageHash: hash("candidate-base-lineage"),
    writeScope: { allow: ["src"] },
    writeScopeHash: hash("candidate-write-scope"),
    rootPath: "workspaces/candidate-workspace-test/project",
    at: later(database.readRun().revision + 1),
  });
  database.completeScope({
    expectedRevision: database.readRun().revision,
    scopeId: body.scopeId,
    status: "completed",
    terminalKey: bodySeed,
    at: later(database.readRun().revision + 1),
  });
  const manifest = storeArtifact(database, "candidate-manifest");
  const diff = storeArtifact(database, "candidate-diff");
  const candidate = database.freezeCandidate({
    expectedRevision: database.readRun().revision,
    workspaceId: "candidate_workspace_test",
    treeHash: hash(changedPaths.length > 0 ? "candidate-changed-tree" : "candidate-initial-tree"),
    lineageHash: hash("candidate-lineage"),
    output: { summary: "candidate output" },
    changedPaths,
    manifestArtifactDigest: manifest.digest,
    diffArtifactDigest: diff.digest,
    at: later(database.readRun().revision + 1),
  });
  const candidateLanes = [{
    laneKey: "candidate",
    scopeId: body.scopeId,
    terminalKey: bodySeed,
    outcome: "success" as const,
  }];
  const candidateResult = { candidateId: candidate.candidateId, changedPaths };
  const candidateCallKey = causalJoinKey(operation, {
    previousCallKey: WORKFLOW_V17_ROOT_SCOPE_SEED,
    semanticKey: hash("candidate-semantic"),
    policyHash: hash("candidate-policy"),
    outputOrder: ["candidate"],
    lanes: candidateLanes,
    result: candidateResult,
  });
  database.completeStructuralJoin({
    expectedRevision: database.readRun().revision,
    operationId: operation.operationId,
    previousCallKey: WORKFLOW_V17_ROOT_SCOPE_SEED,
    semanticKey: hash("candidate-semantic"),
    callKey: candidateCallKey,
    joinKey: candidateCallKey,
    kind: "candidate",
    policyHash: hash("candidate-policy"),
    outputOrder: ["candidate"],
    lanes: candidateLanes,
    result: candidateResult,
    at: later(database.readRun().revision + 1),
  });
  database.validateIntegrity();
  return { ...fixture, rootScopeId, candidate, candidateCallKey };
}

function storeArtifact(database: WorkflowRunDatabaseV17, label: string) {
  const digest = hash(`artifact-${label}`);
  return database.insertArtifact(database.readRun().revision, {
    digest,
    runId: database.readRun().runId,
    kind: label,
    mediaType: "application/json",
    bytes: 2,
    bodyPath: `artifacts/${digest.slice(7)}`,
    metadata: {},
    createdAt: later(database.readRun().revision + 1),
  });
}

function measurementProfile(root: string): MeasurementProfileSnapshot {
  const definition = {
    name: "bench",
    description: "Measure parser latency and peak memory.",
    argv: ["/usr/bin/true"],
    timeoutMs: 30_000,
    outputs: {
      latency: { extract: { kind: "json-path" as const, path: "$.latency" } },
      memory: { extract: { kind: "json-path" as const, path: "$.memory" } },
    },
  };
  return {
    ...definition,
    id: "user:bench",
    namespace: "user",
    path: path.join(root, "bench.json"),
    hash: stableHash({ namespace: "user", definition }),
  };
}

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v17-database-"));
  roots.push(root);
  return root;
}

function track<T extends { close(): void }>(database: T): T {
  open.add(database);
  return database;
}

function hash(value: string): string { return sha256(value); }

function later(seconds: number): string {
  return new Date(Date.parse(NOW) + seconds * 1_000).toISOString();
}

function safety() {
  return {
    concurrency: 4,
    maximumAgentLaunches: 100,
    memoryBytes: 1024 * 1024 * 1024,
    tasks: 128,
    cpuQuotaPercent: 400,
    cpuWeight: 100,
    outputBytes: 64 * 1024 * 1024,
    commandTimeoutMs: 60_000,
  };
}
