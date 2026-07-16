import type { DatabaseSync } from "./sqlite.js";
import type {
  ApplyPathImage,
  ApplyPathPlan,
  ApplyPlanRecord,
  ApplyReceiptRecord,
  ApprovalRecord,
  ArtifactRef,
  VerificationGateRecord,
  VerificationRecord,
} from "../runtime/durable-types.js";
import type { JsonValue } from "../types.js";
import {
  assertArtifactRef,
  assertHash,
  assertIdentifier,
  assertIsoDate,
  assertText,
  decodeCanonicalJson,
  encodeCanonicalJson,
  optionalString,
  requiredNumber,
  requiredString,
  type SqlRow,
} from "./run-database-codec.js";
import { RunDatabaseCorruptionError } from "./run-database-codec.js";
import { RunDatabaseStateError } from "./run-database-errors.js";
import { requiredArtifactRef, requiredOperation } from "./run-database-records.js";

const GATE_KINDS = ["tests", "diagnostics", "diff-inspection", "adversarial-review", "contamination"] as const;

export function insertVerification(
  database: DatabaseSync,
  record: VerificationRecord,
  runId: string,
): void {
  assertVerification(record);
  if (record.runId !== runId) throw new TypeError("Verification belongs to another run");
  const operation = requiredOperation(database, record.operationId, runId);
  if (requiredString(operation, "kind") !== "verify") throw new RunDatabaseStateError("Verification operation has the wrong kind");
  const attempt = database.prepare(
    "SELECT * FROM attempts WHERE attempt_id = ? AND operation_id = ? AND run_id = ?",
  ).get(record.attemptId, record.operationId, runId) as SqlRow | undefined;
  if (!attempt || requiredString(attempt, "effect") !== "verification" || requiredNumber(attempt, "number") !== record.attemptNumber) {
    throw new RunDatabaseStateError("Verification attempt binding is invalid");
  }
  const candidate = database.prepare("SELECT * FROM candidates WHERE candidate_id = ? AND run_id = ?")
    .get(record.candidateId, runId) as SqlRow | undefined;
  if (!candidate) throw new RunDatabaseStateError(`Unknown candidate ${record.candidateId}`);
  if (
    requiredString(candidate, "tree_hash") !== record.candidateTreeHash
    || requiredString(candidate, "lineage_hash") !== record.candidateLineageHash
    || requiredString(candidate, "write_scope_hash") !== record.candidateWriteScopeHash
  ) throw new RunDatabaseStateError("Verification candidate authority is stale");
  requiredArtifactRef(database, record.evidence);
  database.prepare(`
    INSERT INTO verifications(
      verification_id, run_id, operation_id, attempt_id, attempt_number, status,
      candidate_id, candidate_tree_hash, candidate_lineage_hash, candidate_write_scope_hash,
      project_snapshot_hash, live_project_tree_hash, profile_id, profile_hash,
      gate_environment_hash, evidence_artifact_digest, evidence_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.verificationId, runId, record.operationId, record.attemptId, record.attemptNumber, record.status,
    record.candidateId, record.candidateTreeHash, record.candidateLineageHash, record.candidateWriteScopeHash,
    record.projectSnapshotHash, record.liveProjectTreeHash, record.profileId, record.profileHash,
    record.gateEnvironmentHash, record.evidence.digest, record.evidenceHash, record.createdAt,
  );
  for (const gate of record.gates) {
    database.prepare(`
      INSERT INTO verification_gates(
        verification_id, ordinal, kind, status, summary, environment_hash, evidence_hash,
        agent_session_id, finish_tool_call_id, finish_schema_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.verificationId, gate.ordinal, gate.kind, gate.status, gate.summary, gate.environmentHash,
      gate.evidenceHash, gate.agentSessionId ?? null, gate.finishToolCallId ?? null, gate.finishSchemaHash ?? null,
    );
  }
}

export function readVerification(database: DatabaseSync, verificationId: string): VerificationRecord | undefined {
  assertIdentifier(verificationId, "verification id");
  const row = database.prepare("SELECT * FROM verifications WHERE verification_id = ?").get(verificationId) as SqlRow | undefined;
  if (!row) return undefined;
  const gates = (database.prepare("SELECT * FROM verification_gates WHERE verification_id = ? ORDER BY ordinal")
    .all(verificationId) as SqlRow[]).map(gateFromRow);
  const record: VerificationRecord = {
    verificationId,
    runId: requiredString(row, "run_id"),
    operationId: requiredString(row, "operation_id"),
    attemptId: requiredString(row, "attempt_id"),
    attemptNumber: requiredNumber(row, "attempt_number"),
    status: requiredString(row, "status") as VerificationRecord["status"],
    candidateId: requiredString(row, "candidate_id"),
    candidateTreeHash: requiredString(row, "candidate_tree_hash"),
    candidateLineageHash: requiredString(row, "candidate_lineage_hash"),
    candidateWriteScopeHash: requiredString(row, "candidate_write_scope_hash"),
    projectSnapshotHash: requiredString(row, "project_snapshot_hash"),
    liveProjectTreeHash: requiredString(row, "live_project_tree_hash"),
    profileId: requiredString(row, "profile_id"),
    profileHash: requiredString(row, "profile_hash"),
    gateEnvironmentHash: requiredString(row, "gate_environment_hash"),
    evidence: artifactRef(database, requiredString(row, "evidence_artifact_digest")),
    evidenceHash: requiredString(row, "evidence_hash"),
    gates,
    createdAt: requiredString(row, "created_at"),
  };
  assertVerification(record);
  return record;
}

export function readVerificationByOperation(
  database: DatabaseSync,
  operationId: string,
): VerificationRecord | undefined {
  assertIdentifier(operationId, "verification operation id");
  const row = database.prepare(
    "SELECT verification_id FROM verifications WHERE operation_id = ?",
  ).get(operationId) as SqlRow | undefined;
  return row ? readVerification(database, requiredString(row, "verification_id")) : undefined;
}

export function insertApplyPlanAndApproval(
  database: DatabaseSync,
  plan: ApplyPlanRecord,
  approval: ApprovalRecord,
  runId: string,
): void {
  assertApplyPlan(plan);
  assertApproval(approval);
  if (plan.runId !== runId || approval.runId !== runId || approval.operationId !== plan.operationId) {
    throw new TypeError("Apply plan or approval belongs to another run");
  }
  if (approval.kind !== "apply" || approval.approvalId !== plan.approvalId
    || approval.challenge.challengeHash !== plan.challengeHash || approval.challenge.bindingHash !== plan.bindingHash) {
    throw new TypeError("Apply approval differs from its exact plan challenge");
  }
  const operation = requiredOperation(database, plan.operationId, runId);
  if (requiredString(operation, "kind") !== "apply") throw new RunDatabaseStateError("Apply operation has the wrong kind");
  const verification = database.prepare("SELECT * FROM verifications WHERE verification_id = ? AND run_id = ?")
    .get(plan.verificationId, runId) as SqlRow | undefined;
  if (!verification || requiredString(verification, "status") !== "passed") throw new RunDatabaseStateError("Apply requires passed verification");
  if (
    requiredString(verification, "candidate_id") !== plan.candidateId
    || requiredString(verification, "candidate_tree_hash") !== plan.candidateTreeHash
    || requiredString(verification, "candidate_lineage_hash") !== plan.candidateLineageHash
    || requiredString(verification, "candidate_write_scope_hash") !== plan.candidateWriteScopeHash
    || requiredString(verification, "profile_hash") !== plan.verificationProfileHash
    || requiredString(verification, "gate_environment_hash") !== plan.gateEnvironmentHash
    || requiredString(verification, "project_snapshot_hash") !== plan.projectSnapshotHash
    || requiredString(verification, "live_project_tree_hash") !== plan.liveProjectTreeHash
  ) throw new RunDatabaseStateError("Apply plan is stale relative to verification");
  requiredArtifactRef(database, plan.manifest);
  requiredArtifactRef(database, approval.challenge.summary);
  for (const entry of plan.paths) if (entry.content) requiredArtifactRef(database, entry.content);

  database.prepare(`
    INSERT INTO approvals(
      approval_id, run_id, operation_id, kind, status, challenge_hash, challenged_run_revision,
      binding_hash, summary_artifact_digest, decision, actor, requested_at, resolved_at
    ) VALUES (?, ?, ?, 'apply', 'waiting', ?, ?, ?, ?, NULL, NULL, ?, NULL)
  `).run(
    approval.approvalId, runId, approval.operationId, approval.challenge.challengeHash,
    approval.challenge.runRevision, approval.challenge.bindingHash, approval.challenge.summary.digest, approval.requestedAt,
  );
  database.prepare(`
    INSERT INTO apply_plans(
      plan_id, run_id, operation_id, candidate_id, candidate_tree_hash, candidate_lineage_hash,
      candidate_write_scope_hash, verification_id, verification_profile_hash, gate_environment_hash,
      project_snapshot_hash, live_project_tree_hash, unrelated_live_hash, binding_hash,
      manifest_artifact_digest, approval_id, challenge_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    plan.planId, runId, plan.operationId, plan.candidateId, plan.candidateTreeHash, plan.candidateLineageHash,
    plan.candidateWriteScopeHash, plan.verificationId, plan.verificationProfileHash, plan.gateEnvironmentHash,
    plan.projectSnapshotHash, plan.liveProjectTreeHash, plan.unrelatedLiveHash, plan.bindingHash,
    plan.manifest.digest, plan.approvalId, plan.challengeHash, plan.createdAt,
  );
  for (const [ordinal, entry] of plan.paths.entries()) {
    database.prepare(`
      INSERT INTO apply_plan_paths(plan_id, ordinal, path, preimage_json, postimage_json, content_artifact_digest)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      plan.planId, ordinal, entry.path,
      encodeCanonicalJson(entry.preimage as unknown as JsonValue),
      encodeCanonicalJson(entry.postimage as unknown as JsonValue),
      entry.content?.digest ?? null,
    );
  }
  database.prepare("UPDATE operations SET status = 'waiting', updated_at = ? WHERE operation_id = ?")
    .run(plan.createdAt, plan.operationId);
  database.prepare("UPDATE attempts SET status = 'waiting', updated_at = ? WHERE operation_id = ? AND status = 'running'")
    .run(plan.createdAt, plan.operationId);
  database.prepare("UPDATE runs SET status = 'waiting', current_operation_id = ? WHERE singleton = 1")
    .run(plan.operationId);
}

export function readApplyPlan(database: DatabaseSync, planId: string): ApplyPlanRecord | undefined {
  assertIdentifier(planId, "apply plan id");
  const row = database.prepare("SELECT * FROM apply_plans WHERE plan_id = ?").get(planId) as SqlRow | undefined;
  if (!row) return undefined;
  const paths = (database.prepare("SELECT * FROM apply_plan_paths WHERE plan_id = ? ORDER BY ordinal").all(planId) as SqlRow[])
    .map((pathRow): ApplyPathPlan => {
      const contentDigest = optionalString(pathRow, "content_artifact_digest");
      return {
        path: requiredString(pathRow, "path"),
        preimage: decodeCanonicalJson(requiredString(pathRow, "preimage_json")) as unknown as ApplyPathImage,
        postimage: decodeCanonicalJson(requiredString(pathRow, "postimage_json")) as unknown as ApplyPathImage,
        ...(contentDigest ? { content: artifactRef(database, contentDigest) } : {}),
      };
    });
  const plan: ApplyPlanRecord = {
    planId,
    runId: requiredString(row, "run_id"),
    operationId: requiredString(row, "operation_id"),
    candidateId: requiredString(row, "candidate_id"),
    candidateTreeHash: requiredString(row, "candidate_tree_hash"),
    candidateLineageHash: requiredString(row, "candidate_lineage_hash"),
    candidateWriteScopeHash: requiredString(row, "candidate_write_scope_hash"),
    verificationId: requiredString(row, "verification_id"),
    verificationProfileHash: requiredString(row, "verification_profile_hash"),
    gateEnvironmentHash: requiredString(row, "gate_environment_hash"),
    projectSnapshotHash: requiredString(row, "project_snapshot_hash"),
    liveProjectTreeHash: requiredString(row, "live_project_tree_hash"),
    unrelatedLiveHash: requiredString(row, "unrelated_live_hash"),
    bindingHash: requiredString(row, "binding_hash"),
    manifest: artifactRef(database, requiredString(row, "manifest_artifact_digest")),
    approvalId: requiredString(row, "approval_id"),
    challengeHash: requiredString(row, "challenge_hash"),
    paths,
    createdAt: requiredString(row, "created_at"),
  };
  assertApplyPlan(plan);
  return plan;
}

export function readApplyPlanByOperation(
  database: DatabaseSync,
  operationId: string,
): ApplyPlanRecord | undefined {
  assertIdentifier(operationId, "apply operation id");
  const row = database.prepare(
    "SELECT plan_id FROM apply_plans WHERE operation_id = ?",
  ).get(operationId) as SqlRow | undefined;
  return row ? readApplyPlan(database, requiredString(row, "plan_id")) : undefined;
}

export function readApproval(database: DatabaseSync, approvalId: string): ApprovalRecord | undefined {
  assertIdentifier(approvalId, "approval id");
  const row = database.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(approvalId) as SqlRow | undefined;
  if (!row) return undefined;
  const decision = optionalString(row, "decision") as ApprovalRecord["decision"];
  const record: ApprovalRecord = {
    approvalId,
    runId: requiredString(row, "run_id"),
    operationId: requiredString(row, "operation_id"),
    kind: requiredString(row, "kind") as ApprovalRecord["kind"],
    status: requiredString(row, "status") as ApprovalRecord["status"],
    challenge: {
      challengeHash: requiredString(row, "challenge_hash"),
      runRevision: requiredNumber(row, "challenged_run_revision"),
      bindingHash: requiredString(row, "binding_hash"),
      summary: artifactRef(database, requiredString(row, "summary_artifact_digest")),
    },
    ...(decision ? { decision } : {}),
    ...(optionalString(row, "actor") ? { actor: optionalString(row, "actor")! } : {}),
    requestedAt: requiredString(row, "requested_at"),
    ...(optionalString(row, "resolved_at") ? { resolvedAt: optionalString(row, "resolved_at")! } : {}),
  };
  assertApproval(record);
  return record;
}

export function insertApplyReceipt(database: DatabaseSync, receipt: ApplyReceiptRecord, runId: string): void {
  assertApplyReceipt(receipt);
  if (receipt.runId !== runId) throw new TypeError("Apply receipt belongs to another run");
  const plan = database.prepare("SELECT * FROM apply_plans WHERE plan_id = ? AND run_id = ?")
    .get(receipt.planId, runId) as SqlRow | undefined;
  if (!plan) throw new RunDatabaseStateError("Apply receipt has no plan");
  const approval = database.prepare("SELECT * FROM approvals WHERE approval_id = ? AND run_id = ?")
    .get(receipt.approvalId, runId) as SqlRow | undefined;
  if (!approval || requiredString(approval, "decision") !== "approved") throw new RunDatabaseStateError("Apply receipt lacks human approval");
  if (
    requiredString(plan, "operation_id") !== receipt.operationId
    || requiredString(plan, "candidate_id") !== receipt.candidateId
    || requiredString(plan, "verification_id") !== receipt.verificationId
    || requiredString(plan, "approval_id") !== receipt.approvalId
    || requiredString(plan, "challenge_hash") !== receipt.challengeHash
    || requiredString(approval, "challenge_hash") !== receipt.challengeHash
  ) throw new RunDatabaseStateError("Apply receipt binding differs from its plan or approval");
  database.prepare(`
    INSERT INTO apply_receipts(
      receipt_id, run_id, operation_id, plan_id, approval_id, challenge_hash, candidate_id,
      verification_id, mutation_id, changed_paths_json, reconciled, observed_postimage_hash,
      started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    receipt.receiptId, runId, receipt.operationId, receipt.planId, receipt.approvalId, receipt.challengeHash,
    receipt.candidateId, receipt.verificationId, receipt.mutationId,
    encodeCanonicalJson(receipt.changedPaths as unknown as JsonValue), receipt.reconciled ? 1 : 0,
    receipt.observedPostimageHash, receipt.startedAt, receipt.completedAt,
  );
}

export function readApplyReceipt(database: DatabaseSync, planId: string): ApplyReceiptRecord | undefined {
  assertIdentifier(planId, "apply plan id");
  const row = database.prepare("SELECT * FROM apply_receipts WHERE plan_id = ?").get(planId) as SqlRow | undefined;
  if (!row) return undefined;
  const receipt: ApplyReceiptRecord = {
    receiptId: requiredString(row, "receipt_id"),
    runId: requiredString(row, "run_id"),
    operationId: requiredString(row, "operation_id"),
    planId: requiredString(row, "plan_id"),
    approvalId: requiredString(row, "approval_id"),
    challengeHash: requiredString(row, "challenge_hash"),
    candidateId: requiredString(row, "candidate_id"),
    verificationId: requiredString(row, "verification_id"),
    mutationId: requiredString(row, "mutation_id"),
    changedPaths: decodeCanonicalJson(requiredString(row, "changed_paths_json")) as unknown as string[],
    reconciled: requiredNumber(row, "reconciled") === 1,
    observedPostimageHash: requiredString(row, "observed_postimage_hash"),
    startedAt: requiredString(row, "started_at"),
    completedAt: requiredString(row, "completed_at"),
  };
  assertApplyReceipt(receipt);
  return receipt;
}

function gateFromRow(row: SqlRow): VerificationGateRecord {
  return {
    verificationId: requiredString(row, "verification_id"),
    ordinal: requiredNumber(row, "ordinal"),
    kind: requiredString(row, "kind") as VerificationGateRecord["kind"],
    status: requiredString(row, "status") as VerificationGateRecord["status"],
    summary: requiredString(row, "summary"),
    environmentHash: requiredString(row, "environment_hash"),
    evidenceHash: requiredString(row, "evidence_hash"),
    ...(optionalString(row, "agent_session_id") ? { agentSessionId: optionalString(row, "agent_session_id")! } : {}),
    ...(optionalString(row, "finish_tool_call_id") ? { finishToolCallId: optionalString(row, "finish_tool_call_id")! } : {}),
    ...(optionalString(row, "finish_schema_hash") ? { finishSchemaHash: optionalString(row, "finish_schema_hash")! } : {}),
  };
}

function artifactRef(database: DatabaseSync, digest: string): ArtifactRef {
  const row = database.prepare("SELECT kind, media_type, bytes FROM artifacts WHERE digest = ?").get(digest) as SqlRow | undefined;
  if (!row) throw new RunDatabaseCorruptionError(`Missing artifact ${digest}`);
  return {
    digest,
    kind: requiredString(row, "kind"),
    mediaType: requiredString(row, "media_type") as ArtifactRef["mediaType"],
    bytes: requiredNumber(row, "bytes"),
  };
}

function assertVerification(record: VerificationRecord): void {
  assertIdentifier(record.verificationId, "verification id");
  assertIdentifier(record.runId, "verification run id");
  assertIdentifier(record.operationId, "verification operation id");
  assertIdentifier(record.attemptId, "verification attempt id");
  if (!Number.isSafeInteger(record.attemptNumber) || record.attemptNumber < 1) throw new TypeError("Invalid verification attempt number");
  if (!['passed', 'failed', 'blocked'].includes(record.status)) throw new TypeError("Invalid verification status");
  assertIdentifier(record.candidateId, "verification candidate id");
  for (const hash of [record.candidateTreeHash, record.candidateLineageHash, record.candidateWriteScopeHash,
    record.projectSnapshotHash, record.liveProjectTreeHash, record.profileHash, record.gateEnvironmentHash, record.evidenceHash]) assertHash(hash, "verification hash");
  assertIdentifier(record.profileId, "verification profile id");
  assertArtifactRef(record.evidence);
  assertIsoDate(record.createdAt, "verification createdAt");
  if (record.gates.length !== GATE_KINDS.length) throw new TypeError("Verification must contain all five gates");
  for (const [ordinal, gate] of record.gates.entries()) {
    if (gate.verificationId !== record.verificationId || gate.ordinal !== ordinal || gate.kind !== GATE_KINDS[ordinal]) {
      throw new TypeError("Verification gates are not canonical");
    }
    if (!['passed', 'failed', 'blocked', 'not-applicable'].includes(gate.status)) throw new TypeError("Invalid verification gate status");
    assertText(gate.summary, "verification gate summary", 8_000);
    assertHash(gate.environmentHash, "gate environment hash"); assertHash(gate.evidenceHash, "gate evidence hash");
    if ((gate.agentSessionId === undefined) !== (gate.finishToolCallId === undefined)
      || (gate.agentSessionId === undefined) !== (gate.finishSchemaHash === undefined)) throw new TypeError("Incomplete verification finish binding");
  }
}

function assertApplyPlan(plan: ApplyPlanRecord): void {
  for (const id of [plan.planId, plan.runId, plan.operationId, plan.candidateId, plan.verificationId, plan.approvalId]) assertIdentifier(id, "apply identity");
  for (const hash of [plan.candidateTreeHash, plan.candidateLineageHash, plan.candidateWriteScopeHash,
    plan.verificationProfileHash, plan.gateEnvironmentHash, plan.projectSnapshotHash, plan.liveProjectTreeHash,
    plan.unrelatedLiveHash, plan.bindingHash, plan.challengeHash]) assertHash(hash, "apply plan hash");
  assertArtifactRef(plan.manifest);
  assertIsoDate(plan.createdAt, "apply plan createdAt");
  if (plan.paths.length < 1 || plan.paths.length > 10_000) throw new TypeError("Apply plan path count is invalid");
  let previous: string | undefined;
  for (const entry of plan.paths) {
    assertText(entry.path, "apply path", 4_096);
    if (entry.path.startsWith("/") || entry.path.split("/").some((part) => !part || part === "." || part === "..")) throw new TypeError("Unsafe apply path");
    if (previous !== undefined && Buffer.compare(Buffer.from(previous), Buffer.from(entry.path)) >= 0) throw new TypeError("Apply paths are not uniquely sorted");
    previous = entry.path;
    assertImage(entry.preimage); assertImage(entry.postimage);
    if ((entry.postimage.type === "file") !== Boolean(entry.content)) throw new TypeError("Apply file postimage has no immutable content");
    if (entry.content) {
      assertArtifactRef(entry.content);
      if (entry.postimage.type !== "file" || entry.content.digest !== entry.postimage.digest || entry.content.bytes !== entry.postimage.bytes) {
        throw new TypeError("Apply content differs from its postimage");
      }
    }
  }
}

function assertImage(image: ApplyPathImage): void {
  if (!image || !['absent', 'directory', 'file', 'symlink'].includes(image.type)) throw new TypeError("Invalid apply path image");
  if (image.type === "absent") return;
  if (!Number.isSafeInteger(image.mode) || image.mode < 0 || image.mode > 0o777) throw new TypeError("Invalid apply path mode");
  if (image.type === "file") {
    if (!Number.isSafeInteger(image.bytes) || image.bytes < 0) throw new TypeError("Invalid apply file bytes");
    assertHash(image.digest, "apply file digest");
  }
  if (image.type === "symlink" && (typeof image.target !== "string" || !image.target)) throw new TypeError("Invalid apply symlink target");
}

function assertApproval(record: ApprovalRecord): void {
  assertIdentifier(record.approvalId, "approval id"); assertIdentifier(record.runId, "approval run id"); assertIdentifier(record.operationId, "approval operation id");
  if (!['apply', 'draft-promotion'].includes(record.kind) || !['waiting', 'completed', 'stopped'].includes(record.status)) throw new TypeError("Invalid approval state");
  assertHash(record.challenge.challengeHash, "approval challenge hash"); assertHash(record.challenge.bindingHash, "approval binding hash"); assertArtifactRef(record.challenge.summary);
  if (!Number.isSafeInteger(record.challenge.runRevision) || record.challenge.runRevision < 1) throw new TypeError("Invalid challenged revision");
  assertIsoDate(record.requestedAt, "approval requestedAt"); if (record.resolvedAt) assertIsoDate(record.resolvedAt, "approval resolvedAt");
}

function assertApplyReceipt(receipt: ApplyReceiptRecord): void {
  for (const id of [receipt.receiptId, receipt.runId, receipt.operationId, receipt.planId, receipt.approvalId,
    receipt.candidateId, receipt.verificationId, receipt.mutationId]) assertIdentifier(id, "apply receipt identity");
  assertHash(receipt.challengeHash, "apply receipt challenge hash"); assertHash(receipt.observedPostimageHash, "apply receipt postimage hash");
  if (!Array.isArray(receipt.changedPaths) || receipt.changedPaths.length > 10_000) throw new TypeError("Invalid apply receipt paths");
  assertIsoDate(receipt.startedAt, "apply receipt startedAt"); assertIsoDate(receipt.completedAt, "apply receipt completedAt");
}
