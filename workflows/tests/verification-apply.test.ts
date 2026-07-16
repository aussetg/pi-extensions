import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { VerifiedApplyService, ApplyConflictError, ApplyStaleError } from "../src/apply/verified-apply.js";
import { CandidateWorkspaceManager } from "../src/candidates/store.js";
import { RunDatabase } from "../src/persistence/run-database.js";
import type {
  AgentSessionRecord,
  AttemptRecord,
  CandidateRecord,
  OperationRecord,
  RunRecord,
} from "../src/runtime/durable-types.js";
import { VerificationProfileRegistry, type VerificationProfileDefinition } from "../src/verification/profiles.js";
import {
  VerificationService,
  type VerificationCommandEvidence,
} from "../src/verification/receipts.js";
import { captureProjectSnapshot } from "../src/workspaces/project-snapshot.js";
import { sha256 } from "../src/utils/hashes.js";
import { stableJson } from "../src/utils/stable-json.js";

const roots: string[] = [];
const NOW = "2026-04-11T12:00:00.000Z";

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await makeWritable(root);
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

describe("SQLite verification evidence", () => {
  it("records pass, fail, and block verdicts against the exact candidate authority", async () => {
    const fixture = await verificationFixture("verdicts-");
    const passed = await recordVerification(fixture, "passed", 0);
    expect(passed.status).toBe("passed");
    expect(passed.gates.map((gate) => [gate.kind, gate.status])).toEqual([
      ["tests", "passed"],
      ["diagnostics", "passed"],
      ["diff-inspection", "passed"],
      ["adversarial-review", "not-applicable"],
      ["contamination", "passed"],
    ]);
    expect(fixture.database.readVerification(passed.verificationId)).toEqual(passed);

    const failed = await recordVerification(fixture, "failed", 1);
    expect(failed.status).toBe("failed");
    expect(failed.gates.find((gate) => gate.kind === "tests")?.status).toBe("failed");

    const blocked = await recordVerification(fixture, "blocked", 2);
    expect(blocked.status).toBe("blocked");
    expect(blocked.gates.find((gate) => gate.kind === "tests")?.status).toBe("blocked");
    fixture.database.close();
  });

  it("rejects a stale candidate and accepts adversarial evidence only from committed finish_work", async () => {
    const stale = await verificationFixture("stale-candidate-");
    const operation = insertVerificationAttempt(stale.database, stale.candidate, 0);
    await fs.promises.writeFile(path.join(stale.candidateRoot, "change.txt"), "changed again\n");
    await expect(stale.verifier.record({
      operationId: operation.operationId,
      attemptId: operation.attemptId,
      candidateId: stale.candidate.candidateId,
      profile: stale.profile,
      evidence: commandEvidence("passed"),
      createdAt: later(10),
    })).rejects.toThrow(/stale candidate/i);
    stale.database.close();

    const reviewed = await verificationFixture("finish-review-", true);
    const verify = insertVerificationAttempt(reviewed.database, reviewed.candidate, 0);
    await expect(reviewed.verifier.record({
      operationId: verify.operationId,
      attemptId: verify.attemptId,
      candidateId: reviewed.candidate.candidateId,
      profile: reviewed.profile,
      evidence: commandEvidence("passed"),
      createdAt: later(11),
    })).rejects.toThrow(/finish_work/i);

    const session = insertReviewerSession(reviewed.database, reviewed.candidate, 1);
    const receipt = await reviewed.verifier.record({
      operationId: verify.operationId,
      attemptId: verify.attemptId,
      candidateId: reviewed.candidate.candidateId,
      profile: reviewed.profile,
      evidence: {
        ...commandEvidence("passed"),
        adversarialReview: {
          agentSessionId: session.agentSessionId,
          finish: session.finish!,
          environmentHash: sha256("review-environment"),
        },
      },
      createdAt: later(12),
    });
    expect(receipt.status).toBe("passed");
    expect(receipt.gates.find((gate) => gate.kind === "adversarial-review")).toMatchObject({
      status: "passed",
      agentSessionId: session.agentSessionId,
      finishToolCallId: session.finish!.toolCallId,
    });
    reviewed.database.close();
  });
});

describe("human-approved verified apply", () => {
  it("requires an exact human challenge, preserves unrelated paths, and records an idempotent receipt", async () => {
    const fixture = await readyApplyFixture("approved-");
    expect(fixture.database.readOperation(fixture.applyOperation.operationId)?.status).toBe("waiting");
    expect(() => fixture.database.enqueueControlRequest({
      requestId: "request_model_approve",
      runId: fixture.database.readRun().runId,
      expectedRevision: fixture.database.readRun().revision,
      requestedAt: later(20),
      actor: "model:primary",
      kind: "approve",
      approvalId: fixture.approval.approvalId,
      challengeHash: fixture.approval.challenge.challengeHash,
    })).toThrow(/human actor/i);

    fixture.database.enqueueControlRequest({
      requestId: "request_wrong_challenge",
      runId: fixture.database.readRun().runId,
      expectedRevision: fixture.database.readRun().revision,
      requestedAt: later(21),
      actor: "human:test",
      kind: "approve",
      approvalId: fixture.approval.approvalId,
      challengeHash: sha256("changed challenge"),
    });
    const changed = fixture.database.resolveApprovalControlRequest(
      fixture.database.readRun().revision, "request_wrong_challenge", later(22),
    );
    expect(changed.acknowledgement).toMatchObject({ accepted: false, reason: { code: "challenge-mismatch" } });
    expect(fixture.database.readApproval(fixture.approval.approvalId)?.status).toBe("waiting");

    approve(fixture, "request_correct_challenge", 23);
    const receipt = await fixture.applier.apply({
      planId: fixture.plan.planId,
      verificationProfileHash: fixture.verification.profileHash,
      gateEnvironmentHash: fixture.verification.gateEnvironmentHash,
      startedAt: later(24),
    });
    expect(receipt.reconciled).toBe(false);
    expect(await fs.promises.readFile(path.join(fixture.project, "change.txt"), "utf8")).toBe("candidate\n");
    expect(await fs.promises.readFile(path.join(fixture.project, "added.txt"), "utf8")).toBe("added\n");
    await expect(fs.promises.lstat(path.join(fixture.project, "remove.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.promises.readFile(path.join(fixture.project, "keep.txt"), "utf8")).toBe("unrelated\n");
    expect(await fixture.applier.apply({
      planId: fixture.plan.planId,
      verificationProfileHash: fixture.verification.profileHash,
      gateEnvironmentHash: fixture.verification.gateEnvironmentHash,
    })).toEqual(receipt);
    fixture.database.close();
  });

  it("rejects stale verification, changed tool bindings, live drift, and touched-path conflicts", async () => {
    const stale = await verificationFixture("stale-live-");
    const verification = await recordVerification(stale, "passed", 0);
    const operation = insertOperation(stale.database, "apply", 10, "apply");
    const applier = new VerifiedApplyService(stale.runDir, stale.database, { now: () => new Date(later(30)) });
    await fs.promises.writeFile(path.join(stale.project, "keep.txt"), "drift\n");
    await expect(applier.prepare({
      operationId: operation.operationId,
      candidateId: stale.candidate.candidateId,
      verificationId: verification.verificationId,
      verificationProfileHash: verification.profileHash,
      gateEnvironmentHash: verification.gateEnvironmentHash,
    })).rejects.toBeInstanceOf(ApplyStaleError);
    stale.database.close();

    const environment = await readyApplyFixture("changed-environment-");
    approve(environment, "request_environment", 31);
    await expect(environment.applier.apply({
      planId: environment.plan.planId,
      verificationProfileHash: environment.verification.profileHash,
      gateEnvironmentHash: sha256("new tool environment"),
    })).rejects.toThrow(/tool environment/i);
    environment.database.close();

    const drift = await readyApplyFixture("post-challenge-drift-");
    approve(drift, "request_drift", 32);
    await fs.promises.writeFile(path.join(drift.project, "keep.txt"), "changed after challenge\n");
    await expect(execute(drift)).rejects.toThrow(/drift.*rerun affected gates/i);
    expect(await fs.promises.readFile(path.join(drift.project, "change.txt"), "utf8")).toBe("launch\n");
    drift.database.close();

    const conflict = await readyApplyFixture("conflict-");
    approve(conflict, "request_conflict", 34);
    await fs.promises.writeFile(path.join(conflict.project, "change.txt"), "human edit\n");
    await expect(conflict.applier.apply({
      planId: conflict.plan.planId,
      verificationProfileHash: conflict.verification.profileHash,
      gateEnvironmentHash: conflict.verification.gateEnvironmentHash,
    })).rejects.toBeInstanceOf(ApplyConflictError);
    expect(await fs.promises.readFile(path.join(conflict.project, "keep.txt"), "utf8")).toBe("unrelated\n");
    conflict.database.close();
  });

  it("recovers crashes before, during, and after mutation without widening the verified delta", async () => {
    const before = await readyApplyFixture("crash-before-", "before-mutation");
    approve(before, "request_before", 40);
    await expect(execute(before)).rejects.toThrow("simulated before-mutation crash");
    expect(await fs.promises.readFile(path.join(before.project, "change.txt"), "utf8")).toBe("launch\n");
    before.disableFault();
    expect((await execute(before)).reconciled).toBe(false);
    before.database.close();

    const during = await readyApplyFixture("crash-during-", "after-path-mutation");
    approve(during, "request_during", 41);
    await expect(execute(during)).rejects.toThrow("simulated after-path-mutation crash");
    during.disableFault();
    expect((await execute(during)).reconciled).toBe(true);
    expect(await fs.promises.readFile(path.join(during.project, "keep.txt"), "utf8")).toBe("unrelated\n");
    during.database.close();

    const after = await readyApplyFixture("crash-after-", "after-mutation-before-receipt");
    approve(after, "request_after", 42);
    await expect(execute(after)).rejects.toThrow("simulated after-mutation-before-receipt crash");
    expect(after.database.readApplyReceipt(after.plan.planId)).toBeUndefined();
    after.disableFault();
    const recovered = await execute(after);
    expect(recovered.reconciled).toBe(true);
    expect(after.database.readApplyReceipt(after.plan.planId)).toEqual(recovered);
    after.database.close();
  });

  it("honors explicit rejection without touching the live project", async () => {
    const fixture = await readyApplyFixture("rejected-");
    fixture.database.enqueueControlRequest({
      requestId: "request_reject",
      runId: fixture.database.readRun().runId,
      expectedRevision: fixture.database.readRun().revision,
      requestedAt: later(50),
      actor: "human:test",
      kind: "reject",
      approvalId: fixture.approval.approvalId,
      challengeHash: fixture.approval.challenge.challengeHash,
      reason: "not this change",
    });
    const resolution = fixture.database.resolveApprovalControlRequest(
      fixture.database.readRun().revision, "request_reject", later(51),
    );
    expect(resolution.approval).toMatchObject({ status: "completed", decision: "rejected" });
    await expect(execute(fixture)).rejects.toThrow(/human approval/i);
    expect(await fs.promises.readFile(path.join(fixture.project, "change.txt"), "utf8")).toBe("launch\n");
    expect(fixture.database.readApplyReceipt(fixture.plan.planId)).toBeUndefined();
    fixture.database.close();
  });
});

async function verificationFixture(prefix: string, adversarial = false) {
  const root = await btrfsTemporary(prefix);
  const project = path.join(root, "project");
  const runDir = path.join(root, "run");
  await fs.promises.mkdir(project, { recursive: true });
  await fs.promises.mkdir(path.join(runDir, "context"), { recursive: true });
  for (const directory of ["sessions", "workspaces/candidates", "workspaces/checkpoints", "workspaces/overlays", "artifacts", "outputs", "profiles"]) {
    await fs.promises.mkdir(path.join(runDir, directory), { recursive: true });
  }
  await fs.promises.writeFile(path.join(project, "change.txt"), "launch\n");
  await fs.promises.writeFile(path.join(project, "remove.txt"), "remove\n");
  await fs.promises.writeFile(path.join(project, "keep.txt"), "unrelated\n");
  const manifest = await captureProjectSnapshot(project, project, path.join(runDir, "context", "project"));
  await fs.promises.writeFile(path.join(runDir, "context", "project-manifest.json"), `${stableJson(manifest)}\n`);
  const database = RunDatabase.create(path.join(runDir, "run.sqlite"), { run: runRecord(manifest.treeHash) });
  const manager = await CandidateWorkspaceManager.open(runDir, database);
  const capability = await manager.create({ logicalId: `candidate:${prefix}`, createdAt: NOW });
  const candidateRoot = (await manager.describe(capability)).root;
  await fs.promises.writeFile(path.join(candidateRoot, "change.txt"), "candidate\n");
  await fs.promises.writeFile(path.join(candidateRoot, "added.txt"), "added\n");
  await fs.promises.rm(path.join(candidateRoot, "remove.txt"));
  const candidate = await manager.freeze({ workspace: capability, frozenAt: later(1) });
  const profileRegistry = new VerificationProfileRegistry();
  await profileRegistry.refresh(project, {
    userDir: path.join(runDir, "profiles"),
    builtins: [verificationProfile(adversarial)],
  });
  const profile = profileRegistry.resolve("builtin:phase11");
  const verifier = new VerificationService(runDir, database, () => new Date(later(10)));
  return { root, project, runDir, database, manager, capability, candidateRoot, candidate, profile, verifier };
}

async function readyApplyFixture(prefix: string, fault?: "before-mutation" | "after-path-mutation" | "after-mutation-before-receipt") {
  const fixture = await verificationFixture(prefix);
  const verification = await recordVerification(fixture, "passed", 0);
  const applyOperation = insertOperation(fixture.database, `apply_${prefix.replace(/[^a-z0-9]/g, "")}`, 10, "apply");
  let enabled = Boolean(fault);
  const applier = new VerifiedApplyService(fixture.runDir, fixture.database, {
    now: () => new Date(later(60)),
    faultInjector: (point) => {
      if (enabled && point === fault) { enabled = false; throw new Error(`simulated ${point} crash`); }
    },
  });
  const prepared = await applier.prepare({
    operationId: applyOperation.operationId,
    candidateId: fixture.candidate.candidateId,
    verificationId: verification.verificationId,
    verificationProfileHash: verification.profileHash,
    gateEnvironmentHash: verification.gateEnvironmentHash,
    createdAt: later(61),
  });
  return { ...fixture, verification, applyOperation, applier, ...prepared, disableFault: () => { enabled = false; } };
}

async function recordVerification(
  fixture: Awaited<ReturnType<typeof verificationFixture>>,
  verdict: "passed" | "failed" | "blocked",
  ordinal: number,
) {
  const attempt = insertVerificationAttempt(fixture.database, fixture.candidate, ordinal);
  return await fixture.verifier.record({
    operationId: attempt.operationId,
    attemptId: attempt.attemptId,
    candidateId: fixture.candidate.candidateId,
    profile: fixture.profile,
    evidence: commandEvidence(verdict),
    createdAt: later(10 + ordinal),
  });
}

function insertVerificationAttempt(database: RunDatabase, candidate: CandidateRecord, ordinal: number) {
  const operation = insertOperation(database, `verify_${ordinal}_${database.readRun().revision}`, ordinal, "verify");
  const attemptId = `attempt_${operation.operationId}`;
  const attempt: AttemptRecord = {
    attemptId,
    runId: database.readRun().runId,
    operationId: operation.operationId,
    number: 1,
    effect: "verification",
    status: "running",
    preWorkspace: candidate.workspace,
    usage: zeroUsage(),
    outputArtifacts: [],
    startedAt: later(2 + ordinal),
    updatedAt: later(2 + ordinal),
  };
  database.insertAttempt(database.readRun().revision, attempt, {
    type: "verification-attempt-started",
    operationId: operation.operationId,
    attemptId,
    payload: {},
    at: later(2 + ordinal),
  });
  return { operationId: operation.operationId, attemptId };
}

function insertOperation(database: RunDatabase, id: string, ordinal: number, kind: OperationRecord["kind"]): OperationRecord {
  const operation: OperationRecord = {
    operationId: `operation_${id}`,
    runId: database.readRun().runId,
    path: `run/${kind}:${id}`,
    sourceId: id,
    kind,
    ordinal,
    status: "running",
    semanticInputHash: sha256(`input:${id}`),
    attemptCount: 0,
    createdAt: later(2 + ordinal),
    startedAt: later(2 + ordinal),
    updatedAt: later(2 + ordinal),
  };
  return database.insertOperation(database.readRun().revision, operation, {
    type: "operation-started", operationId: operation.operationId, payload: {}, at: operation.createdAt,
  });
}

function insertReviewerSession(database: RunDatabase, candidate: CandidateRecord, ordinal: number): AgentSessionRecord {
  const operation = insertOperation(database, `reviewer_${ordinal}`, 20 + ordinal, "agent");
  const now = later(15 + ordinal);
  const session: AgentSessionRecord = {
    agentSessionId: `agent_session_reviewer_${ordinal}`,
    runId: database.readRun().runId,
    operationId: operation.operationId,
    profileId: "builtin:reviewer",
    routeId: "route:reviewer",
    piSessionPath: `sessions/reviewer-${ordinal}.jsonl`,
    workspace: candidate.workspace,
    network: "none",
    status: "completed",
    receiptlessStrikes: 0,
    progress: {
      metrics: [], usage: zeroUsage(), modelTurn: 1, toolCount: 1, retries: 0,
      workspaceChanged: false, workspaceChangeCount: 0, recentWorkspaceChanges: [], updatedAt: now,
    },
    finish: {
      toolCallId: `finish_reviewer_${ordinal}`,
      schemaHash: sha256("review-schema"),
      value: { status: "passed", summary: "No blocking issue found" },
      artifacts: [],
      committedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  };
  return database.createAgentSession(database.readRun().revision, session, {
    type: "reviewer-finished", operationId: operation.operationId, payload: {}, at: now,
  });
}

function commandEvidence(verdict: "passed" | "failed" | "blocked") {
  return {
    tests: [oneCommand("tests", verdict)],
    diagnostics: [oneCommand("diagnostics", "passed")],
  };
}

function oneCommand(id: string, verdict: "passed" | "failed" | "blocked"): VerificationCommandEvidence {
  return {
    commandId: id,
    status: verdict === "blocked" ? "infrastructure-failure" : "completed",
    exitCode: verdict === "blocked" ? null : verdict === "failed" ? 1 : 0,
    timedOut: false,
    stdoutDigest: sha256(`${id}:stdout:${verdict}`),
    stdoutBytes: 0,
    stderrDigest: sha256(`${id}:stderr:${verdict}`),
    stderrBytes: 0,
    environmentHash: sha256(`${id}:environment`),
    startedAt: later(4),
    completedAt: later(5),
  };
}

function verificationProfile(adversarial: boolean): VerificationProfileDefinition {
  const command = (id: string) => ({ id, argv: ["/usr/bin/true"], timeoutMs: 30_000 });
  return {
    name: "phase11",
    description: "Phase 11 deterministic verification fixture.",
    tests: [command("tests")],
    diagnostics: [command("diagnostics")],
    diffInspection: {
      requireChanges: true,
      maximumChangedPaths: 100,
      maximumFileBytes: 1024 * 1024,
      forbidSecrets: true,
      paths: "all-semantic-project-paths",
    },
    adversarialReview: adversarial ? { profile: "builtin:reviewer" } : { notApplicable: "fixture has deterministic gates only" },
  };
}

function approve(fixture: Awaited<ReturnType<typeof readyApplyFixture>>, requestId: string, second: number) {
  fixture.database.enqueueControlRequest({
    requestId,
    runId: fixture.database.readRun().runId,
    expectedRevision: fixture.database.readRun().revision,
    requestedAt: later(second),
    actor: "human:test",
    kind: "approve",
    approvalId: fixture.approval.approvalId,
    challengeHash: fixture.approval.challenge.challengeHash,
  });
  const resolution = fixture.database.resolveApprovalControlRequest(fixture.database.readRun().revision, requestId, later(second + 1));
  expect(resolution).toMatchObject({ approval: { decision: "approved" }, acknowledgement: { accepted: true } });
}

async function execute(fixture: Awaited<ReturnType<typeof readyApplyFixture>>) {
  return await fixture.applier.apply({
    planId: fixture.plan.planId,
    verificationProfileHash: fixture.verification.profileHash,
    gateEnvironmentHash: fixture.verification.gateEnvironmentHash,
  });
}

function runRecord(projectSnapshotHash: string): RunRecord {
  return {
    runId: `flow_${"1".repeat(32)}`,
    revision: 1,
    workflow: {
      id: "builtin:test", name: "test", sourceHash: sha256("source"), definitionHash: sha256("definition"),
      capabilities: ["read-project", "candidate-write", "host-command", "human-input"],
    },
    invocationHash: sha256("invocation"),
    projectSnapshotHash,
    routeSnapshotHash: sha256("routes"),
    contextIdentityHash: sha256("context"),
    status: "running",
    safety: {
      concurrency: 4, maximumAgentLaunches: 100, memoryBytes: 2 ** 30, tasks: 256,
      cpuQuotaPercent: 400, cpuWeight: 100, outputBytes: 64 * 1024 * 1024, commandTimeoutMs: 60_000,
    },
    usage: zeroUsage(),
    createdAt: NOW,
    startedAt: NOW,
    updatedAt: NOW,
  };
}

function zeroUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, providerRequests: 0, cost: 0, elapsedMs: 0, complete: true };
}
function later(seconds: number): string { return new Date(Date.parse(NOW) + seconds * 1000).toISOString(); }

async function btrfsTemporary(prefix: string): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(process.cwd(), `.phase11-${prefix}`));
  roots.push(root);
  const type = spawnSync("stat", ["-f", "-c", "%T", root], { encoding: "utf8" });
  if (type.status !== 0 || type.stdout.trim() !== "btrfs") throw new Error("Phase 11 tests require Btrfs");
  return root;
}

async function makeWritable(target: string): Promise<void> {
  let stat: fs.Stats;
  try { stat = await fs.promises.lstat(target); } catch { return; }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.promises.chmod(target, 0o700).catch(() => undefined);
    for (const name of await fs.promises.readdir(target)) await makeWritable(path.join(target, name));
  } else await fs.promises.chmod(target, 0o600).catch(() => undefined);
}
