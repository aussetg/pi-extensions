import fs from "node:fs";
import path from "node:path";
import { Ajv } from "ajv";
import { canonicalJsonValue, deepFreezeJson } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import { WORKFLOW_RUNTIME_API_HASH } from "../definition/workflow-language.js";
import type { WorkflowInvocationSnapshot } from "./workflow-invocation.js";
import { assertWorkflowInvocationSnapshot } from "./workflow-invocation.js";
import type { JsonObject, JsonSchema, JsonValue } from "../types.js";
import type { SafetyConfiguration } from "../runtime/durable-types.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import {
  applyMetricCohortDeltaToSnapshot,
  applyMetricDispositionToSnapshot,
  normalizeMetricCohortDelta,
  type PersistedMetricState,
} from "../measurements/metrics.js";
import { normalizeMeasurementProfile } from "../measurements/profiles.js";
import {
  WORKFLOW_ROOT_SCOPE_SEED,
  workflowFreshCallKey,
  workflowLaneSeed,
  workflowOperationIdentity,
  workflowStructuralJoinKey,
} from "../runtime/causal-identity.js";
import {
  assertHash,
  assertIdentifier,
  assertIsoDate,
  assertNonNegativeInteger,
  assertPositiveInteger,
  assertSafety,
  assertText,
  optionalString,
  requiredNumber,
  requiredString,
  type SqlRow,
} from "./run-database-codec.js";
import { DatabaseSync } from "./sqlite.js";
import {
  WORKFLOW_RUN_DATABASE_BUSY_TIMEOUT_MS,
  WORKFLOW_RUN_DATABASE_SCHEMA_SQL,
  WORKFLOW_RUN_DATABASE_SCHEMA_VERSION,
} from "./run-database-schema.js";
import type {
  ClaimWorkflowOperationInput,
  CompleteWorkflowCallInput,
  CompleteWorkflowStructuralFailureInput,
  CompleteWorkflowStructuralJoinInput,
  CreateWorkflowChildScopeSpec,
  SettleWorkflowEffectInput,
  WorkflowArtifactRecord,
  WorkflowAttemptRecord,
  WorkflowCandidateApplyRecord,
  WorkflowCandidateDispositionRecord,
  WorkflowCandidateMeasurementRecord,
  WorkflowCandidateRecord,
  WorkflowCandidateVerificationRecord,
  WorkflowCandidateWorkspaceRecord,
  WorkflowEffectSettlementRecord,
  WorkflowControlRequestRecord,
  WorkflowHumanInteractionRecord,
  WorkflowInvocationResourceRecord,
  WorkflowExperimentRecord,
  WorkflowMeasurementRecord,
  WorkflowMeasurementSampleRecord,
  WorkflowMetricSetRecord,
  WorkflowOperationKind,
  WorkflowOperationArtifactRecord,
  WorkflowOperationRecord,
  WorkflowOperationStatus,
  WorkflowRunEvent,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowScopeCallRecord,
  WorkflowScopeRecord,
  WorkflowStructuralJoinLaneRecord,
  WorkflowStructuralJoinRecord,
  WorkflowWorkspaceCheckpointRecord,
} from "./run-database-types.js";

export { WORKFLOW_RUN_DATABASE_SCHEMA_VERSION } from "./run-database-schema.js";
export type * from "./run-database-types.js";

export { WORKFLOW_ROOT_SCOPE_SEED } from "../runtime/causal-identity.js";

const SOURCE_SITE = /^[a-z][a-z0-9-]{0,127}$/u;
const LANE_KEY = /^[a-z][a-z0-9_-]{0,63}$/u;
const TERMINAL_RUN_STATUSES = new Set<WorkflowRunStatus>(["completed", "failed", "stopped"]);
const STRUCTURAL_KINDS = new Set<WorkflowOperationKind>(["parallel", "map", "candidate"]);

export interface WorkflowRunDatabaseOpenOptions {
  busyTimeoutMs?: number;
}

export interface CreateWorkflowRunDatabaseOptions {
  runId: string;
  snapshot: WorkflowInvocationSnapshot;
  projectSnapshotHash: string;
  routeSnapshotHash: string;
  /** Exact reviewed descriptor/profile authority. */
  staticResourcesHash: string;
  contextIdentityHash: string;
  safety: SafetyConfiguration;
  createdAt: string;
}

export interface TransitionWorkflowRunInput {
  status: WorkflowRunStatus;
  reason?: JsonObject;
  currentOperationId?: string | null;
  rootTerminalKey?: string;
  result?: JsonValue;
  at: string;
}

export interface CompleteWorkflowScopeInput {
  expectedRevision: number;
  scopeId: string;
  status: "completed" | "failed" | "cancelled";
  terminalKey: string;
  failure?: JsonObject;
  at: string;
}

export interface CancelWorkflowScopeTreeInput {
  expectedRevision: number;
  scopeId: string;
  failure: JsonObject;
  at: string;
}

export interface CreateCandidateWorkspaceInput {
  expectedRevision: number;
  workspaceId: string;
  candidateOperationId: string;
  bodyScopeId: string;
  parentCandidateId?: string;
  initialTreeHash: string;
  baseLineageHash: string;
  writeScope: JsonValue;
  writeScopeHash: string;
  rootPath: string;
  at: string;
}

export interface FreezeCandidateInput {
  expectedRevision: number;
  workspaceId: string;
  bodyTerminalKey: string;
  treeHash: string;
  lineageHash: string;
  output: JsonValue;
  changedPaths: string[];
  manifestArtifactDigest: string;
  diffArtifactDigest: string;
  at: string;
}

export type DisposeCandidateInput = {
  expectedRevision: number;
  candidateId: string;
  operationId?: string;
  measurementId?: string;
  at: string;
} & (
  | { disposition: "accepted"; verificationId: string }
  | { disposition: "rejected"; verificationId?: string; reason: JsonObject }
  | { disposition: "discarded"; reason: JsonObject }
  | { disposition: "abandoned"; reason: JsonObject }
);

export interface WorkflowRunDatabaseConfiguration {
  schemaVersion: number;
  journalMode: string;
  foreignKeys: boolean;
  synchronous: number;
  busyTimeoutMs: number;
}

export interface CompleteWorkflowAttemptInput {
  expectedRevision: number;
  attemptId: string;
  status: "completed" | "failed" | "stopped" | "cancelled";
  usage: JsonObject;
  resources?: JsonObject;
  at: string;
}

export class WorkflowRunDatabaseVersionError extends Error {
  constructor(readonly actual: number) {
    super(actual === 3
      ? "Legacy workflow run database schema 3 cannot be opened by runtime v17"
      : `Unsupported workflow run database schema ${actual}; expected ${WORKFLOW_RUN_DATABASE_SCHEMA_VERSION}`);
    this.name = "WorkflowRunDatabaseVersionError";
  }
}

export class WorkflowRunDatabaseRevisionConflictError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`Workflow run revision changed: expected ${expected}, found ${actual}`);
    this.name = "WorkflowRunDatabaseRevisionConflictError";
  }
}

export class WorkflowRunDatabaseAdmissionError extends Error {
  constructor(
    readonly limit: "operations" | "agents",
    message: string,
  ) {
    super(message);
    this.name = "WorkflowRunDatabaseAdmissionError";
  }
}

export class WorkflowRunDatabaseStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowRunDatabaseStateError";
  }
}

export class WorkflowRunDatabaseCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowRunDatabaseCorruptionError";
  }
}

export function workflowScopeId(runId: string, scopePath: string): string {
  assertIdentifier(runId, "workflow v17 run id");
  assertScopePath(scopePath);
  return `scope_${stableHash({ formatVersion: 1, runId, scopePath }).slice(7, 39)}`;
}

export function workflowOperationId(runId: string, operationPath: string): string {
  assertIdentifier(runId, "workflow v17 run id");
  assertOperationPath(operationPath);
  return `operation_${stableHash({ formatVersion: 1, runId, operationPath }).slice(7, 39)}`;
}

export function workflowResourceId(inputPath: string, bindingHash: string): string {
  assertJsonPointer(inputPath, "workflow v17 resource input path");
  assertHash(bindingHash, "workflow v17 resource binding hash");
  return `resource_${stableHash({ formatVersion: 1, inputPath, bindingHash }).slice(7, 39)}`;
}

export function workflowInvocationIdentityHash(snapshot: WorkflowInvocationSnapshot): string {
  assertWorkflowInvocationSnapshot(snapshot);
  return stableHash({
    formatVersion: 1,
    workflowId: snapshot.workflowId,
    definitionHash: snapshot.definitionHash,
    inputHash: snapshot.inputHash,
    resourcesHash: snapshot.resourcesHash,
    runtimeApiHash: snapshot.runtimeApiHash,
  });
}

export class WorkflowRunDatabaseReader implements Disposable {
  protected closed = false;

  protected constructor(
    protected readonly database: DatabaseSync,
    readonly databasePath: string,
  ) {}

  static open(
    databasePathInput: string,
    options: WorkflowRunDatabaseOpenOptions = {},
  ): WorkflowRunDatabaseReader {
    const databasePath = path.resolve(databasePathInput);
    const database = openConnection(databasePath, true, options);
    const reader = new WorkflowRunDatabaseReader(database, databasePath);
    try {
      reader.assertBasicIdentity();
      return reader;
    } catch (error) {
      reader.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  [Symbol.dispose](): void { this.close(); }

  configuration(): WorkflowRunDatabaseConfiguration {
    this.assertOpen();
    return {
      schemaVersion: pragmaNumber(this.database, "user_version"),
      journalMode: pragmaText(this.database, "journal_mode"),
      foreignKeys: pragmaNumber(this.database, "foreign_keys") === 1,
      synchronous: pragmaNumber(this.database, "synchronous"),
      busyTimeoutMs: pragmaNumber(this.database, "busy_timeout"),
    };
  }

  readSnapshot<T>(read: (reader: this) => T): T {
    this.assertOpen();
    this.database.exec("BEGIN");
    try {
      const value = read(this);
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
  }

  readRun(): WorkflowRunRecord {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM runs WHERE singleton = 1").get() as SqlRow | undefined;
    if (!row) throw corrupt("Workflow v17 database has no run row");
    const runId = requiredString(row, "run_id");
    const capabilities = (this.database.prepare(
      "SELECT capability FROM run_capabilities WHERE run_id = ? ORDER BY ordinal",
    ).all(runId) as SqlRow[]).map((entry) => requiredString(entry, "capability"));
    const reason = jsonColumn<JsonObject>(row, "reason_json");
    const run: WorkflowRunRecord = {
      runId,
      revision: requiredNumber(row, "revision"),
      workflow: {
        id: requiredString(row, "workflow_id") as WorkflowRunRecord["workflow"]["id"],
        name: requiredString(row, "workflow_name"),
        sourceHash: requiredString(row, "workflow_source_hash"),
        definitionHash: requiredString(row, "workflow_definition_hash"),
        snapshotHash: requiredString(row, "invocation_snapshot_hash"),
        runtimeApiHash: requiredString(row, "runtime_api_hash"),
      },
      invocationHash: requiredString(row, "invocation_hash"),
      resourcesHash: requiredString(row, "resources_hash"),
      projectSnapshotHash: requiredString(row, "project_snapshot_hash"),
      routeSnapshotHash: requiredString(row, "route_snapshot_hash"),
      staticResourcesHash: requiredString(row, "static_resources_hash"),
      contextIdentityHash: requiredString(row, "context_identity_hash"),
      launch: {
        authority: requiredString(row, "launch_authority") as WorkflowRunRecord["launch"]["authority"],
        exposure: requiredString(row, "exposure") as WorkflowRunRecord["launch"]["exposure"],
        policyHash: requiredString(row, "policy_hash"),
        projectTrusted: requiredNumber(row, "project_trusted") === 1,
      },
      capabilities,
      safety: safetyFromRow(row),
      status: requiredString(row, "status") as WorkflowRunStatus,
      ...(reason ? { reason } : {}),
      rootScopeId: requiredString(row, "root_scope_id"),
      ...(optionalString(row, "current_operation_id") ? {
        currentOperationId: optionalString(row, "current_operation_id")!,
      } : {}),
      ...(optionalString(row, "root_terminal_key") ? {
        rootTerminalKey: optionalString(row, "root_terminal_key")!,
      } : {}),
      ...(requiredNumber(row, "result_present") === 1 ? {
        result: jsonColumnRequired<JsonValue>(row, "result_json"),
      } : {}),
      createdAt: requiredString(row, "created_at"),
      ...(optionalString(row, "started_at") ? { startedAt: optionalString(row, "started_at")! } : {}),
      updatedAt: requiredString(row, "updated_at"),
      ...(optionalString(row, "ended_at") ? { endedAt: optionalString(row, "ended_at")! } : {}),
    };
    assertRunRecord(run);
    return run;
  }

  listInvocationResources(): WorkflowInvocationResourceRecord[] {
    this.assertOpen();
    return (this.database.prepare(
      "SELECT * FROM invocation_resources ORDER BY input_path",
    ).all() as SqlRow[]).map(resourceFromRow);
  }

  listEvents(options: { afterSequence?: number; limit?: number } = {}): WorkflowRunEvent[] {
    this.assertOpen();
    const after = options.afterSequence ?? 0;
    const limit = pageLimit(options.limit);
    assertNonNegativeInteger(after, "workflow v17 event cursor");
    return (this.database.prepare(
      "SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?",
    ).all(after, limit) as SqlRow[]).map(eventFromRow);
  }

  latestEventSequence(): number {
    this.assertOpen();
    return requiredNumber(
      this.database.prepare("SELECT coalesce(max(sequence), 0) AS value FROM events").get() as SqlRow,
      "value",
    );
  }

  readHumanInteraction(interactionId: string): WorkflowHumanInteractionRecord | undefined {
    this.assertOpen();
    assertIdentifier(interactionId, "workflow v17 human interaction id");
    const row = this.database.prepare(
      "SELECT * FROM human_interactions WHERE interaction_id = ?",
    ).get(interactionId) as SqlRow | undefined;
    return row ? humanInteractionFromRow(row) : undefined;
  }

  readHumanInteractionByOperation(operationId: string): WorkflowHumanInteractionRecord | undefined {
    this.assertOpen();
    assertIdentifier(operationId, "workflow v17 human operation id");
    const row = this.database.prepare(
      "SELECT * FROM human_interactions WHERE operation_id = ?",
    ).get(operationId) as SqlRow | undefined;
    return row ? humanInteractionFromRow(row) : undefined;
  }

  listWaitingHumanInteractions(): WorkflowHumanInteractionRecord[] {
    this.assertOpen();
    return (this.database.prepare(
      "SELECT * FROM human_interactions WHERE status = 'waiting' ORDER BY requested_at, interaction_id",
    ).all() as SqlRow[]).map(humanInteractionFromRow);
  }

  readControlRequest(requestId: string): WorkflowControlRequestRecord | undefined {
    this.assertOpen();
    assertIdentifier(requestId, "workflow v17 control request id");
    const row = this.database.prepare(
      "SELECT * FROM control_requests WHERE request_id = ?",
    ).get(requestId) as SqlRow | undefined;
    return row ? controlRequestFromRow(row) : undefined;
  }

  listPendingControlRequests(limit = 64): WorkflowControlRequestRecord[] {
    this.assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new TypeError("Workflow v17 control request limit is invalid");
    }
    return (this.database.prepare(
      "SELECT * FROM control_requests WHERE status = 'pending' ORDER BY requested_at, request_id LIMIT ?",
    ).all(limit) as SqlRow[]).map(controlRequestFromRow);
  }

  readScope(scopeId: string): WorkflowScopeRecord | undefined {
    this.assertOpen();
    assertIdentifier(scopeId, "workflow v17 scope id");
    const row = this.database.prepare("SELECT * FROM scopes WHERE scope_id = ?").get(scopeId) as SqlRow | undefined;
    return row ? scopeFromRow(row) : undefined;
  }

  readScopeByPath(scopePath: string): WorkflowScopeRecord | undefined {
    this.assertOpen();
    assertScopePath(scopePath);
    const row = this.database.prepare("SELECT * FROM scopes WHERE path = ?").get(scopePath) as SqlRow | undefined;
    return row ? scopeFromRow(row) : undefined;
  }

  listScopes(): WorkflowScopeRecord[] {
    this.assertOpen();
    return (this.database.prepare("SELECT * FROM scopes ORDER BY path").all() as SqlRow[]).map(scopeFromRow);
  }

  listChildScopes(ownerOperationId: string): WorkflowScopeRecord[] {
    this.assertOpen();
    assertIdentifier(ownerOperationId, "workflow v17 owner operation id");
    return (this.database.prepare(
      "SELECT * FROM scopes WHERE owner_operation_id = ? ORDER BY sibling_ordinal",
    ).all(ownerOperationId) as SqlRow[]).map(scopeFromRow);
  }

  readOperation(operationId: string): WorkflowOperationRecord | undefined {
    this.assertOpen();
    assertIdentifier(operationId, "workflow v17 operation id");
    const row = this.database.prepare("SELECT * FROM operations WHERE operation_id = ?").get(operationId) as SqlRow | undefined;
    return row ? operationFromRow(row) : undefined;
  }

  readOperationAt(scopeId: string, cursor: number): WorkflowOperationRecord | undefined {
    this.assertOpen();
    assertIdentifier(scopeId, "workflow v17 scope id");
    assertNonNegativeInteger(cursor, "workflow v17 scope cursor");
    const row = this.database.prepare(
      "SELECT * FROM operations WHERE scope_id = ? AND cursor = ?",
    ).get(scopeId, cursor) as SqlRow | undefined;
    return row ? operationFromRow(row) : undefined;
  }

  listOperations(options: { afterOrdinal?: number; limit?: number } = {}): WorkflowOperationRecord[] {
    this.assertOpen();
    const after = options.afterOrdinal ?? -1;
    const limit = pageLimit(options.limit);
    if (!Number.isSafeInteger(after) || after < -1) throw new TypeError("Invalid workflow v17 operation cursor");
    return (this.database.prepare(
      "SELECT * FROM operations WHERE ordinal > ? ORDER BY ordinal LIMIT ?",
    ).all(after, limit) as SqlRow[]).map(operationFromRow);
  }

  countOperations(): number {
    this.assertOpen();
    return requiredNumber(this.database.prepare("SELECT count(*) AS value FROM operations").get() as SqlRow, "value");
  }

  readOperationCounts(): Partial<Record<WorkflowOperationStatus, number>> {
    this.assertOpen();
    const result: Partial<Record<WorkflowOperationStatus, number>> = {};
    for (const row of this.database.prepare(
      "SELECT status, count(*) AS value FROM operations GROUP BY status ORDER BY status",
    ).all() as SqlRow[]) {
      result[requiredString(row, "status") as WorkflowOperationStatus] = requiredNumber(row, "value");
    }
    return result;
  }

  readScopeCall(operationId: string): WorkflowScopeCallRecord | undefined {
    this.assertOpen();
    assertIdentifier(operationId, "workflow v17 operation id");
    const row = this.database.prepare("SELECT * FROM scope_calls WHERE operation_id = ?").get(operationId) as SqlRow | undefined;
    return row ? scopeCallFromRow(row) : undefined;
  }

  readEffectSettlement(operationId: string): WorkflowEffectSettlementRecord | undefined {
    this.assertOpen();
    assertIdentifier(operationId, "workflow v17 operation id");
    const row = this.database.prepare(
      "SELECT * FROM effect_settlements WHERE operation_id = ?",
    ).get(operationId) as SqlRow | undefined;
    return row ? effectSettlementFromRow(row) : undefined;
  }

  listScopeCalls(scopeId: string): WorkflowScopeCallRecord[] {
    this.assertOpen();
    assertIdentifier(scopeId, "workflow v17 scope id");
    return (this.database.prepare(
      "SELECT * FROM scope_calls WHERE scope_id = ? ORDER BY cursor",
    ).all(scopeId) as SqlRow[]).map(scopeCallFromRow);
  }

  readStructuralJoin(operationId: string): WorkflowStructuralJoinRecord | undefined {
    this.assertOpen();
    assertIdentifier(operationId, "workflow v17 operation id");
    const row = this.database.prepare("SELECT * FROM structural_joins WHERE operation_id = ?").get(operationId) as SqlRow | undefined;
    if (!row) return undefined;
    const lanes = (this.database.prepare(
      "SELECT * FROM structural_join_lanes WHERE operation_id = ? ORDER BY ordinal",
    ).all(operationId) as SqlRow[]).map(joinLaneFromRow);
    return structuralJoinFromRow(row, lanes);
  }

  readArtifact(digest: string): WorkflowArtifactRecord | undefined {
    this.assertOpen();
    assertHash(digest, "workflow v17 artifact digest");
    const row = this.database.prepare("SELECT * FROM artifacts WHERE digest = ?").get(digest) as SqlRow | undefined;
    return row ? artifactFromRow(row) : undefined;
  }

  listArtifacts(options: {
    after?: { createdAt: string; digest: string };
    limit?: number;
  } = {}): WorkflowArtifactRecord[] {
    this.assertOpen();
    const limit = pageLimit(options.limit);
    if (!options.after) {
      return (this.database.prepare(
        "SELECT * FROM artifacts ORDER BY created_at, digest LIMIT ?",
      ).all(limit) as SqlRow[]).map(artifactFromRow);
    }
    assertIsoDate(options.after.createdAt, "workflow v17 artifact cursor time");
    assertHash(options.after.digest, "workflow v17 artifact cursor digest");
    return (this.database.prepare(`
      SELECT * FROM artifacts
      WHERE created_at > ? OR (created_at = ? AND digest > ?)
      ORDER BY created_at, digest LIMIT ?
    `).all(options.after.createdAt, options.after.createdAt, options.after.digest, limit) as SqlRow[])
      .map(artifactFromRow);
  }

  listOperationArtifacts(operationId: string): WorkflowOperationArtifactRecord[] {
    this.assertOpen();
    assertIdentifier(operationId, "workflow v17 operation id");
    return (this.database.prepare(`
      SELECT link.operation_id, link.role, link.name, link.ordinal, artifact.*
      FROM operation_artifacts link
      JOIN artifacts artifact ON artifact.digest = link.artifact_digest
      WHERE link.operation_id = ?
      ORDER BY link.role, link.ordinal
    `).all(operationId) as SqlRow[]).map((row) => ({
      operationId: requiredString(row, "operation_id"),
      role: requiredString(row, "role") as WorkflowOperationArtifactRecord["role"],
      ...(optionalString(row, "name") ? { name: optionalString(row, "name")! } : {}),
      ordinal: requiredNumber(row, "ordinal"),
      artifact: artifactFromRow(row),
    }));
  }

  readWorkspaceCheckpoint(checkpointId: string): WorkflowWorkspaceCheckpointRecord | undefined {
    this.assertOpen();
    assertIdentifier(checkpointId, "workflow v17 checkpoint id");
    const row = this.database.prepare(
      "SELECT * FROM workspace_checkpoints WHERE checkpoint_id = ?",
    ).get(checkpointId) as SqlRow | undefined;
    return row ? workspaceCheckpointFromRow(row) : undefined;
  }

  readAttempt(attemptId: string): WorkflowAttemptRecord | undefined {
    this.assertOpen();
    assertIdentifier(attemptId, "workflow v17 attempt id");
    const row = this.database.prepare("SELECT * FROM attempts WHERE attempt_id = ?").get(attemptId) as SqlRow | undefined;
    return row ? attemptFromRow(row) : undefined;
  }

  listAttempts(options: {
    after?: { createdAt: string; attemptId: string };
    limit?: number;
  } = {}): WorkflowAttemptRecord[] {
    this.assertOpen();
    const limit = pageLimit(options.limit);
    if (!options.after) {
      return (this.database.prepare(
        "SELECT * FROM attempts ORDER BY created_at, attempt_id LIMIT ?",
      ).all(limit) as SqlRow[]).map(attemptFromRow);
    }
    assertIsoDate(options.after.createdAt, "workflow v17 attempt cursor time");
    assertIdentifier(options.after.attemptId, "workflow v17 attempt cursor id");
    return (this.database.prepare(`
      SELECT * FROM attempts
      WHERE created_at > ? OR (created_at = ? AND attempt_id > ?)
      ORDER BY created_at, attempt_id LIMIT ?
    `).all(options.after.createdAt, options.after.createdAt, options.after.attemptId, limit) as SqlRow[])
      .map(attemptFromRow);
  }

  listWorkspaceCheckpoints(options: {
    after?: { createdAt: string; checkpointId: string };
    limit?: number;
  } = {}): WorkflowWorkspaceCheckpointRecord[] {
    this.assertOpen();
    const limit = pageLimit(options.limit);
    if (!options.after) {
      return (this.database.prepare(
        "SELECT * FROM workspace_checkpoints ORDER BY created_at, checkpoint_id LIMIT ?",
      ).all(limit) as SqlRow[]).map(workspaceCheckpointFromRow);
    }
    assertIsoDate(options.after.createdAt, "workflow v17 checkpoint cursor time");
    assertIdentifier(options.after.checkpointId, "workflow v17 checkpoint cursor id");
    return (this.database.prepare(`
      SELECT * FROM workspace_checkpoints
      WHERE created_at > ? OR (created_at = ? AND checkpoint_id > ?)
      ORDER BY created_at, checkpoint_id LIMIT ?
    `).all(options.after.createdAt, options.after.createdAt, options.after.checkpointId, limit) as SqlRow[])
      .map(workspaceCheckpointFromRow);
  }

  readCandidateWorkspace(workspaceId: string): WorkflowCandidateWorkspaceRecord | undefined {
    this.assertOpen();
    assertIdentifier(workspaceId, "workflow v17 candidate workspace id");
    const row = this.database.prepare(
      "SELECT * FROM candidate_workspaces WHERE workspace_id = ?",
    ).get(workspaceId) as SqlRow | undefined;
    return row ? candidateWorkspaceFromRow(row) : undefined;
  }

  readCandidateWorkspaceByOperation(operationId: string): WorkflowCandidateWorkspaceRecord | undefined {
    this.assertOpen();
    assertIdentifier(operationId, "workflow v17 candidate operation id");
    const row = this.database.prepare(
      "SELECT * FROM candidate_workspaces WHERE candidate_operation_id = ?",
    ).get(operationId) as SqlRow | undefined;
    return row ? candidateWorkspaceFromRow(row) : undefined;
  }

  readCandidate(candidateId: string): WorkflowCandidateRecord | undefined {
    this.assertOpen();
    assertIdentifier(candidateId, "workflow v17 candidate id");
    const row = this.database.prepare("SELECT * FROM candidates WHERE candidate_id = ?").get(candidateId) as SqlRow | undefined;
    return row ? this.candidateFromRow(row) : undefined;
  }

  readCandidateByOperation(operationId: string): WorkflowCandidateRecord | undefined {
    this.assertOpen();
    assertIdentifier(operationId, "workflow v17 candidate operation id");
    const row = this.database.prepare(
      "SELECT * FROM candidates WHERE operation_id = ?",
    ).get(operationId) as SqlRow | undefined;
    return row ? this.candidateFromRow(row) : undefined;
  }

  readCandidateVerification(verificationId: string): WorkflowCandidateVerificationRecord | undefined {
    this.assertOpen();
    assertIdentifier(verificationId, "workflow v17 verification id");
    const row = this.database.prepare(
      "SELECT * FROM candidate_verifications WHERE verification_id = ?",
    ).get(verificationId) as SqlRow | undefined;
    return row ? candidateVerificationFromRow(row) : undefined;
  }

  readCandidateVerificationByOperation(operationId: string): WorkflowCandidateVerificationRecord | undefined {
    this.assertOpen();
    assertIdentifier(operationId, "workflow v17 verification operation id");
    const row = this.database.prepare(
      "SELECT * FROM candidate_verifications WHERE operation_id = ?",
    ).get(operationId) as SqlRow | undefined;
    return row ? candidateVerificationFromRow(row) : undefined;
  }

  listCandidateVerifications(candidateId?: string): WorkflowCandidateVerificationRecord[] {
    this.assertOpen();
    if (candidateId !== undefined) {
      assertIdentifier(candidateId, "workflow v17 verification candidate id");
      return (this.database.prepare(
        "SELECT * FROM candidate_verifications WHERE candidate_id = ? ORDER BY created_at, verification_id",
      ).all(candidateId) as SqlRow[]).map(candidateVerificationFromRow);
    }
    return (this.database.prepare(
      "SELECT * FROM candidate_verifications ORDER BY created_at, verification_id",
    ).all() as SqlRow[]).map(candidateVerificationFromRow);
  }

  readCandidateApply(candidateId: string): WorkflowCandidateApplyRecord | undefined {
    this.assertOpen();
    assertIdentifier(candidateId, "workflow v17 candidate id");
    const row = this.database.prepare(
      "SELECT * FROM candidate_applies WHERE candidate_id = ?",
    ).get(candidateId) as SqlRow | undefined;
    return row ? candidateApplyFromRow(row) : undefined;
  }

  listCandidates(): WorkflowCandidateRecord[] {
    this.assertOpen();
    return (this.database.prepare("SELECT * FROM candidates ORDER BY frozen_at, candidate_id").all() as SqlRow[])
      .map((row) => this.candidateFromRow(row));
  }

  listCandidatesPage(options: {
    after?: { frozenAt: string; candidateId: string };
    limit?: number;
  } = {}): WorkflowCandidateRecord[] {
    this.assertOpen();
    const limit = pageLimit(options.limit);
    if (!options.after) {
      return (this.database.prepare(
        "SELECT * FROM candidates ORDER BY frozen_at, candidate_id LIMIT ?",
      ).all(limit) as SqlRow[]).map(row => this.candidateFromRow(row));
    }
    assertIsoDate(options.after.frozenAt, "workflow v17 candidate cursor time");
    assertIdentifier(options.after.candidateId, "workflow v17 candidate cursor id");
    return (this.database.prepare(`
      SELECT * FROM candidates
      WHERE frozen_at > ? OR (frozen_at = ? AND candidate_id > ?)
      ORDER BY frozen_at, candidate_id LIMIT ?
    `).all(options.after.frozenAt, options.after.frozenAt, options.after.candidateId, limit) as SqlRow[])
      .map(row => this.candidateFromRow(row));
  }

  validateIntegrity(): void {
    this.assertOpen();
    const quick = this.database.prepare("PRAGMA quick_check").get() as SqlRow | undefined;
    if (!quick || Object.values(quick)[0] !== "ok") throw corrupt("Workflow v17 SQLite quick_check failed");
    const foreign = this.database.prepare("PRAGMA foreign_key_check").all();
    if (foreign.length > 0) throw corrupt("Workflow v17 database has broken foreign keys");
    const run = this.readRun();
    const scopes = this.listScopes();
    const root = scopes.filter((scope) => scope.kind === "root");
    if (root.length !== 1 || root[0]!.scopeId !== run.rootScopeId || root[0]!.path !== "run"
      || root[0]!.seedKey !== WORKFLOW_ROOT_SCOPE_SEED) {
      throw corrupt("Workflow v17 database has an invalid root scope");
    }
    const resources = this.listInvocationResources();
    if (stableHash(resources.map((resource) => resource.resource)) !== run.resourcesHash) {
      throw corrupt("Workflow v17 invocation resources differ from the run identity");
    }
    for (const resource of resources) assertResourceRecord(resource, run.runId);
    for (const scope of scopes) this.assertScopeIntegrity(scope, run.runId);
    for (const candidate of this.listCandidates()) this.assertCandidateIntegrity(candidate);
    for (const metricSet of this.listMetricSets()) this.assertMetricSetIntegrity(metricSet, run.runId);
    for (const measurement of this.listMeasurements()) this.assertMeasurementIntegrity(measurement, run.runId);
    for (const experiment of this.listExperiments()) this.assertExperimentIntegrity(experiment, run.runId);
    const interactions = (this.database.prepare(
      "SELECT * FROM human_interactions ORDER BY requested_at, interaction_id",
    ).all() as SqlRow[]).map(humanInteractionFromRow);
    for (const interaction of interactions) {
      const operation = this.readOperation(interaction.operationId);
      if (interaction.runId !== run.runId || !operation || operation.kind !== interaction.kind
        || interaction.challengeHash !== stableHash(interaction.request)) {
        throw corrupt(`Workflow v17 human interaction ${interaction.interactionId} is corrupt`);
      }
      if (interaction.status === "waiting" && (run.status !== "waiting" || operation.status !== "waiting")) {
        throw corrupt(`Workflow v17 waiting interaction ${interaction.interactionId} differs from run state`);
      }
    }
    const controls = (this.database.prepare(
      "SELECT * FROM control_requests ORDER BY requested_at, request_id",
    ).all() as SqlRow[]).map(controlRequestFromRow);
    for (const control of controls) {
      assertControlRequestRecord(control);
      if (control.runId !== run.runId) throw corrupt(`Workflow v17 control request ${control.requestId} belongs to another run`);
    }
    if (run.status === "completed") {
      const rootScope = this.readScope(run.rootScopeId)!;
      if (rootScope.status !== "completed" || rootScope.terminalKey !== run.rootTerminalKey) {
        throw corrupt("Completed workflow v17 run differs from its root scope terminal key");
      }
      const pending = this.listCandidates().filter((candidate) => candidate.state === "pending");
      if (pending.length > 0) throw corrupt("Completed workflow v17 run has pending candidates");
      const interrupted = requiredNumber(this.database.prepare(`
        SELECT
          (SELECT count(*) FROM operations operation
            JOIN scopes scope ON scope.scope_id = operation.scope_id
            WHERE operation.status IN ('running', 'waiting', 'stopped')
              OR (operation.status = 'cancelled' AND scope.status <> 'cancelled'))
          + (SELECT count(*) FROM attempts WHERE status IN ('running', 'waiting')) AS value
      `).get() as SqlRow, "value");
      if (interrupted !== 0) throw corrupt("Completed workflow v17 run has interrupted execution records");
    } else if (run.status === "failed" || run.status === "stopped") {
      const live = requiredNumber(this.database.prepare(`
        SELECT
          (SELECT count(*) FROM operations WHERE status IN ('running', 'waiting'))
          + (SELECT count(*) FROM attempts WHERE status IN ('running', 'waiting'))
          + (SELECT count(*) FROM scopes WHERE status = 'active') AS value
      `).get() as SqlRow, "value");
      if (live !== 0) throw corrupt("Terminal workflow v17 run has live execution records");
    }
  }

  protected assertOpen(): void {
    if (this.closed) throw new Error("Workflow v17 run database connection is closed");
  }

  protected expectedPreviousCallKey(scope: WorkflowScopeRecord, cursor?: number): string {
    const target = cursor ?? requiredNumber(this.database.prepare(
      "SELECT coalesce(max(cursor), -1) + 1 AS value FROM scope_calls WHERE scope_id = ?",
    ).get(scope.scopeId) as SqlRow, "value");
    if (target === 0) return scope.seedKey;
    const row = this.database.prepare(
      "SELECT call_key FROM scope_calls WHERE scope_id = ? AND cursor = ?",
    ).get(scope.scopeId, target - 1) as SqlRow | undefined;
    if (!row) throw state(`Scope ${scope.path} is missing call cursor ${target - 1}`);
    return requiredString(row, "call_key");
  }

  private assertBasicIdentity(): void {
    const run = this.readRun();
    const root = this.readScope(run.rootScopeId);
    if (!root || root.kind !== "root" || root.path !== "run" || root.runId !== run.runId) {
      throw corrupt("Workflow v17 database root identity is corrupt");
    }
  }

  private assertScopeIntegrity(scope: WorkflowScopeRecord, runId: string): void {
    if (scope.runId !== runId || scope.scopeId !== workflowScopeId(runId, scope.path)) {
      throw corrupt(`Workflow v17 scope ${scope.path} identity is corrupt`);
    }
    if (scope.kind !== "root") {
      const owner = scope.ownerOperationId ? this.readOperation(scope.ownerOperationId) : undefined;
      const parent = scope.parentScopeId ? this.readScope(scope.parentScopeId) : undefined;
      if (!owner || !parent || owner.scopeId !== parent.scopeId
        || (owner.kind !== "parallel" && owner.kind !== "map" && owner.kind !== "candidate")) {
        throw corrupt(`Workflow v17 scope ${scope.path} owner identity is corrupt`);
      }
      const expectedSeed = workflowLaneSeed({
        parentPreviousCallKey: this.expectedPreviousCallKey(parent, owner.cursor),
        ownerOperationPath: owner.path,
        ownerKind: owner.kind,
        childKind: scope.kind,
        ...(scope.laneKey !== undefined ? { laneKey: scope.laneKey } : {}),
      });
      if (scope.seedKey !== expectedSeed) {
        throw corrupt(`Workflow v17 scope ${scope.path} causal seed is corrupt`);
      }
    }
    const operations = (this.database.prepare(
      "SELECT * FROM operations WHERE scope_id = ? ORDER BY cursor",
    ).all(scope.scopeId) as SqlRow[]).map(operationFromRow);
    let previous = scope.seedKey;
    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index]!;
      if (operation.cursor !== index || operation.path !== operationPath(scope.path, index)
        || operation.operationId !== workflowOperationId(runId, operation.path)) {
        throw corrupt(`Workflow v17 scope ${scope.path} has a cursor or operation identity gap`);
      }
      assertHash(operation.semanticInputHash, `workflow v17 operation ${operation.path} semantic input hash`);
      assertSourceSite(operation.sourceSite);
      if (operation.descriptorSourceSite) assertSourceSite(operation.descriptorSourceSite);
      const settlement = this.readEffectSettlement(operation.operationId);
      if (settlement) {
        if (settlement.runId !== runId || STRUCTURAL_KINDS.has(operation.kind)) {
          throw corrupt(`Workflow v17 operation ${operation.path} has an invalid effect settlement`);
        }
        assertHash(settlement.semanticKey, `workflow v17 operation ${operation.path} settlement semantic key`);
        const settledTerminal = settlement.outcome === "success" ? settlement.result : settlement.failure;
        if (settledTerminal === undefined || (settlement.outcome === "failure" && settlement.replayPolicy !== "never")) {
          throw corrupt(`Workflow v17 operation ${operation.path} settlement outcome is corrupt`);
        }
        const settlementCheckpoint = settlement.postWorkspaceCheckpointId
          ? this.readWorkspaceCheckpoint(settlement.postWorkspaceCheckpointId)
          : undefined;
        if ((settlement.replayPolicy === "workspace") !== Boolean(settlementCheckpoint)
          || (settlementCheckpoint && settlementCheckpoint.operationId !== operation.operationId)) {
          throw corrupt(`Workflow v17 operation ${operation.path} settlement checkpoint is corrupt`);
        }
      }
      const call = this.readScopeCall(operation.operationId);
      if (call) {
        if (call.scopeId !== scope.scopeId || call.cursor !== index || call.previousCallKey !== previous
          || call.callKey !== operation.callKey
          || (call.outcome === "success") !== (operation.status === "completed")) {
          throw corrupt(`Workflow v17 scope ${scope.path} call chain is corrupt at cursor ${index}`);
        }
        for (const [label, value] of [
          ["previous", call.previousCallKey], ["semantic", call.semanticKey],
          ["call", call.callKey], ["result", call.resultHash],
        ] as const) assertHash(value, `workflow v17 ${label} call hash`);
        const terminal = call.outcome === "success" ? operation.result : operation.failure;
        if (terminal === undefined || stableHash(terminal) !== call.resultHash) {
          throw corrupt(`Workflow v17 scope ${scope.path} call result hash is corrupt at cursor ${index}`);
        }
        if (call.replay && (call.replay.sourceRunId === runId
          || call.replay.sourceCallKey !== call.callKey || call.replayPolicy === "never")) {
          throw corrupt(`Workflow v17 scope ${scope.path} has invalid replay evidence at cursor ${index}`);
        }
        if ((call.replayPolicy === "workspace") !== Boolean(call.postWorkspaceCheckpointId)) {
          throw corrupt(`Workflow v17 scope ${scope.path} has invalid workspace replay evidence at cursor ${index}`);
        }
        if (call.postWorkspaceCheckpointId) {
          const checkpoint = this.readWorkspaceCheckpoint(call.postWorkspaceCheckpointId);
          if (!checkpoint || checkpoint.operationId !== operation.operationId
            || checkpoint.runId !== runId) {
            throw corrupt(`Workflow v17 scope ${scope.path} checkpoint is corrupt at cursor ${index}`);
          }
        }
        if (!call.replay && call.completionAuthority !== "structural-join") {
          const expectedCallKey = workflowFreshCallKey({
            runId,
            previousCallKey: call.previousCallKey,
            operation: workflowOperationIdentity(operation),
            semanticKey: call.semanticKey,
            outcome: call.outcome,
            completionAuthority: call.completionAuthority,
            replayPolicy: call.replayPolicy,
            result: terminal,
          });
          if (call.callKey !== expectedCallKey) {
            throw corrupt(`Workflow v17 scope ${scope.path} causal call key is corrupt at cursor ${index}`);
          }
        }
        if (settlement && (
          call.replay !== undefined
          || call.semanticKey !== settlement.semanticKey
          || call.outcome !== settlement.outcome
          || call.completionAuthority !== settlement.completionAuthority
          || call.replayPolicy !== settlement.replayPolicy
          || stableHash(settlement.outcome === "success" ? settlement.result! : settlement.failure!)
            !== call.resultHash
        )) {
          throw corrupt(`Workflow v17 scope ${scope.path} call differs from its effect settlement at cursor ${index}`);
        }
        for (const link of this.listOperationArtifacts(operation.operationId)) {
          if (link.operationId !== operation.operationId || link.artifact.runId !== runId) {
            throw corrupt(`Workflow v17 operation ${operation.path} artifact evidence is corrupt`);
          }
        }
        previous = call.callKey;
      } else if (index !== operations.length - 1 || !["running", "waiting", "stopped", "cancelled"].includes(operation.status)) {
        throw corrupt(`Workflow v17 scope ${scope.path} has an uncommitted operation before its tail`);
      }
      const join = this.readStructuralJoin(operation.operationId);
      if (join) this.assertJoinIntegrity(join, operation);
    }
    if (scope.status === "completed" && scope.terminalKey !== previous) {
      throw corrupt(`Workflow v17 scope ${scope.path} terminal key differs from its local call chain`);
    }
  }

  private assertJoinIntegrity(
    join: WorkflowStructuralJoinRecord,
    operation: WorkflowOperationRecord,
  ): void {
    const call = this.readScopeCall(operation.operationId);
    if (!call || call.completionAuthority !== "structural-join" || call.callKey !== join.joinKey
      || join.kind !== operation.kind || join.previousCallKey !== call.previousCallKey) {
      throw corrupt(`Workflow v17 structural join ${operation.path} differs from its scope call`);
    }
    const expectedJoinKey = workflowStructuralJoinKey({
      previousCallKey: join.previousCallKey,
      operation: workflowOperationIdentity(operation),
      semanticKey: call.semanticKey,
      policyHash: join.policyHash,
      outputOrder: join.outputOrder,
      lanes: join.lanes,
      ...(call.outcome === "success"
        ? { outcome: "success" as const, result: operation.result! }
        : { outcome: "failure" as const, failure: operation.failure! }),
    });
    if (join.joinKey !== expectedJoinKey) {
      throw corrupt(`Workflow v17 structural join ${operation.path} causal key is corrupt`);
    }
    const children = this.listChildScopes(operation.operationId);
    if (children.length !== join.lanes.length) {
      throw corrupt(`Workflow v17 structural join ${operation.path} omits child scopes`);
    }
    const childIds = new Set(children.map((child) => child.scopeId));
    for (const lane of join.lanes) {
      const child = this.readScope(lane.scopeId);
      if (!child || !childIds.has(child.scopeId) || child.terminalKey !== lane.terminalKey
        || laneOutcome(child.status) !== lane.outcome) {
        throw corrupt(`Workflow v17 structural join ${operation.path} has invalid lane ${lane.laneKey}`);
      }
    }
    if (join.kind === "candidate" && call.outcome === "success") {
      const row = this.database.prepare(
        "SELECT body_scope_id FROM candidates WHERE operation_id = ?",
      ).get(operation.operationId) as SqlRow | undefined;
      if (!row || join.lanes.length !== 1
        || requiredString(row, "body_scope_id") !== join.lanes[0]!.scopeId) {
        throw corrupt(`Workflow v17 candidate join ${operation.path} lacks exact frozen candidate authority`);
      }
    }
  }

  private assertCandidateIntegrity(candidate: WorkflowCandidateRecord): void {
    const workspace = this.readCandidateWorkspace(candidate.workspaceId);
    if (!workspace || workspace.state !== "frozen" || workspace.bodyScopeId !== candidate.bodyScopeId
      || workspace.candidateOperationId !== candidate.operationId
      || workspace.writeScopeHash !== candidate.writeScopeHash
      || stableHash(candidate.output) !== candidate.outputHash) {
      throw corrupt(`Workflow v17 candidate ${candidate.candidateId} authority is corrupt`);
    }
    const sorted = [...candidate.changedPaths].sort();
    if (sorted.some((entry, index) => entry !== candidate.changedPaths[index])) {
      throw corrupt(`Workflow v17 candidate ${candidate.candidateId} changed paths are not canonical`);
    }
    const measurement = this.readCandidateMeasurement(candidate.candidateId);
    if (candidate.state === "pending" && measurement && measurement.status !== "pending") {
      throw corrupt(`Pending workflow v17 candidate ${candidate.candidateId} has finalized measurement state`);
    }
    if (candidate.state !== "pending" && measurement?.status === "pending") {
      throw corrupt(`Disposed workflow v17 candidate ${candidate.candidateId} has pending measurement state`);
    }
    const disposition = candidate.disposition;
    if (disposition) {
      let verification: WorkflowCandidateVerificationRecord | undefined;
      if (disposition.verificationId) {
        const row = this.database.prepare(
          "SELECT * FROM candidate_verifications WHERE verification_id = ?",
        ).get(disposition.verificationId) as SqlRow | undefined;
        if (!row) throw corrupt(`Workflow v17 candidate ${candidate.candidateId} is missing disposition verification`);
        verification = candidateVerificationFromRow(row);
      }
      if (verification && verification.candidateId !== candidate.candidateId) {
        throw corrupt(`Workflow v17 candidate ${candidate.candidateId} verification belongs elsewhere`);
      }
      if (disposition.disposition === "accepted" && verification?.status !== "passed") {
        throw corrupt(`Workflow v17 candidate ${candidate.candidateId} acceptance lacks passed verification`);
      }
      if (Boolean(measurement) !== Boolean(disposition.measurementId)
        || (measurement && disposition.measurementId !== measurement.measurementId)
        || (measurement && measurement.status !== (disposition.disposition === "accepted" ? "accepted" : "rejected"))) {
        throw corrupt(`Workflow v17 candidate ${candidate.candidateId} measurement disposition is inconsistent`);
      }
      const expectedAuthority = stableHash(candidateDispositionSemantic(
        candidate,
        disposition.disposition,
        disposition.reason,
        verification,
        measurement,
      ));
      if (disposition.authorityHash !== expectedAuthority) {
        throw corrupt(`Workflow v17 candidate ${candidate.candidateId} disposition authority is corrupt`);
      }
      if (candidate.state === "applied" && disposition.disposition !== "accepted") {
        throw corrupt(`Workflow v17 applied candidate ${candidate.candidateId} was not accepted`);
      }
    }
    const apply = this.readCandidateApply(candidate.candidateId);
    if ((candidate.state === "applied") !== Boolean(apply)) {
      throw corrupt(`Workflow v17 candidate ${candidate.candidateId} apply state is inconsistent`);
    }
    if (apply && apply.authorityHash !== candidateApplyAuthority(candidate, apply)) {
      throw corrupt(`Workflow v17 candidate ${candidate.candidateId} apply authority is corrupt`);
    }
  }

  private assertMetricSetIntegrity(metricSet: WorkflowMetricSetRecord, runId: string): void {
    if (metricSet.runId !== runId || stableHash(metricSet.policy) !== metricSet.policyHash
      || stableHash(metricSet.sampling) !== metricSet.samplingHash
      || stableHash(metricSet.states) !== metricSet.stateHash) {
      throw corrupt(`Workflow v17 metric set ${metricSet.metricSetId} identity is corrupt`);
    }
    let states: PersistedMetricState[] = [];
    const measurements = this.listMeasurements().filter(value => value.metricSetId === metricSet.metricSetId);
    for (const measurement of measurements) {
      states = applyMetricCohortDeltaToSnapshot(states, measurement.delta);
      if (measurement.candidateId) {
        const disposition = this.readCandidateMeasurement(measurement.candidateId);
        if (!disposition || disposition.measurementId !== measurement.measurementId) {
          throw corrupt(`Workflow v17 candidate measurement ${measurement.measurementId} lacks disposition state`);
        }
        if (disposition.status !== "pending") {
          states = applyMetricDispositionToSnapshot(states, measurement.delta, disposition.status);
        }
      }
    }
    if (stableJson(states) !== stableJson(metricSet.states)) {
      throw corrupt(`Workflow v17 metric set ${metricSet.metricSetId} state is not reconstructable`);
    }
  }

  private assertMeasurementIntegrity(measurement: WorkflowMeasurementRecord, runId: string): void {
    if (measurement.runId !== runId) throw corrupt(`Workflow v17 measurement ${measurement.measurementId} belongs elsewhere`);
    try { assertWorkflowMeasurement(measurement); }
    catch (error) { throw corrupt(`Workflow v17 measurement ${measurement.measurementId} is corrupt: ${errorMessage(error)}`); }
    const operation = this.readOperation(measurement.operationId);
    const metricSet = this.readMetricSet(measurement.metricSetId);
    if (!operation || operation.kind !== "measure" || !metricSet
      || !this.readArtifact(measurement.artifactDigest)
      || (measurement.diagnosticsArtifactDigest && !this.readArtifact(measurement.diagnosticsArtifactDigest))) {
      throw corrupt(`Workflow v17 measurement ${measurement.measurementId} evidence is incomplete`);
    }
    if (measurement.candidateId) {
      const candidate = this.readCandidate(measurement.candidateId);
      const pending = this.readCandidateMeasurement(measurement.candidateId);
      if (!candidate || !pending || pending.measurementId !== measurement.measurementId
        || pending.bindingHash !== measurement.bindingHash) {
        throw corrupt(`Workflow v17 measurement ${measurement.measurementId} candidate binding is corrupt`);
      }
    }
  }

  private assertExperimentIntegrity(experiment: WorkflowExperimentRecord, runId: string): void {
    if (experiment.runId !== runId) throw corrupt(`Workflow v17 experiment ${experiment.experimentId} belongs elsewhere`);
    try { assertWorkflowExperiment(experiment); }
    catch (error) { throw corrupt(`Workflow v17 experiment ${experiment.experimentId} is corrupt: ${errorMessage(error)}`); }
    const candidate = this.readCandidate(experiment.candidateId);
    const measurement = this.readMeasurement(experiment.measurementId);
    const operation = this.readOperation(experiment.operationId);
    if (!candidate?.disposition || !measurement || operation?.kind !== "record-experiment"
      || candidate.disposition.disposition !== experiment.disposition
      || candidate.disposition.measurementId !== measurement.measurementId
      || !this.readArtifact(experiment.artifactDigest)) {
      throw corrupt(`Workflow v17 experiment ${experiment.experimentId} evidence is incomplete`);
    }
  }

  private candidateFromRow(row: SqlRow): WorkflowCandidateRecord {
    const candidateId = requiredString(row, "candidate_id");
    const paths = (this.database.prepare(
      "SELECT path FROM candidate_changed_paths WHERE candidate_id = ? ORDER BY ordinal",
    ).all(candidateId) as SqlRow[]).map((entry) => requiredString(entry, "path"));
    const dispositionRow = this.database.prepare(
      "SELECT * FROM candidate_dispositions WHERE candidate_id = ?",
    ).get(candidateId) as SqlRow | undefined;
    const disposition = dispositionRow ? candidateDispositionFromRow(dispositionRow) : undefined;
    const applyRow = this.database.prepare(
      "SELECT receipt_id FROM candidate_applies WHERE candidate_id = ?",
    ).get(candidateId) as SqlRow | undefined;
    const state = applyRow
      ? "applied"
      : disposition?.disposition ?? "pending";
    return {
      candidateId,
      runId: requiredString(row, "run_id"),
      operationId: requiredString(row, "operation_id"),
      workspaceId: requiredString(row, "workspace_id"),
      bodyScopeId: requiredString(row, "body_scope_id"),
      ...(optionalString(row, "parent_candidate_id") ? { parentCandidateId: optionalString(row, "parent_candidate_id")! } : {}),
      treeHash: requiredString(row, "tree_hash"),
      lineageHash: requiredString(row, "lineage_hash"),
      writeScopeHash: requiredString(row, "write_scope_hash"),
      output: jsonColumnRequired<JsonValue>(row, "output_json"),
      outputHash: requiredString(row, "output_hash"),
      changedPaths: paths,
      manifestArtifactDigest: requiredString(row, "manifest_artifact_digest"),
      diffArtifactDigest: requiredString(row, "diff_artifact_digest"),
      state,
      ...(disposition ? { disposition } : {}),
      ...(applyRow ? { appliedReceiptId: requiredString(applyRow, "receipt_id") } : {}),
      frozenAt: requiredString(row, "frozen_at"),
    };
  }

  readCandidateMeasurement(candidateId: string): WorkflowCandidateMeasurementRecord | undefined {
    this.assertOpen();
    assertIdentifier(candidateId, "workflow v17 candidate id");
    const row = this.database.prepare(
      "SELECT * FROM candidate_measurements WHERE candidate_id = ?",
    ).get(candidateId) as SqlRow | undefined;
    return row ? candidateMeasurementFromRow(row) : undefined;
  }

  readMetricSet(metricSetId: string): WorkflowMetricSetRecord | undefined {
    this.assertOpen();
    assertIdentifier(metricSetId, "workflow v17 metric-set id");
    const row = this.database.prepare("SELECT * FROM metric_sets WHERE metric_set_id = ?")
      .get(metricSetId) as SqlRow | undefined;
    return row ? metricSetFromRow(row) : undefined;
  }

  readMetricSetBySite(sourceSite: string, occurrence: number): WorkflowMetricSetRecord | undefined {
    this.assertOpen();
    assertSourceSite(sourceSite);
    assertNonNegativeInteger(occurrence, "workflow v17 metric-set occurrence");
    const row = this.database.prepare(
      "SELECT * FROM metric_sets WHERE run_id = ? AND source_site = ? AND occurrence = ?",
    ).get(this.readRun().runId, sourceSite, occurrence) as SqlRow | undefined;
    return row ? metricSetFromRow(row) : undefined;
  }

  listMetricSets(): WorkflowMetricSetRecord[] {
    this.assertOpen();
    return (this.database.prepare(
      "SELECT * FROM metric_sets ORDER BY source_site, occurrence",
    ).all() as SqlRow[]).map(metricSetFromRow);
  }

  readMeasurement(measurementId: string): WorkflowMeasurementRecord | undefined {
    this.assertOpen();
    assertIdentifier(measurementId, "workflow v17 measurement id");
    const row = this.database.prepare(
      "SELECT * FROM workflow_measurements WHERE measurement_id = ?",
    ).get(measurementId) as SqlRow | undefined;
    return row ? measurementFromRow(row) : undefined;
  }

  readMeasurementByOperation(operationId: string): WorkflowMeasurementRecord | undefined {
    this.assertOpen();
    assertIdentifier(operationId, "workflow v17 measurement operation id");
    const row = this.database.prepare(
      "SELECT * FROM workflow_measurements WHERE operation_id = ?",
    ).get(operationId) as SqlRow | undefined;
    return row ? measurementFromRow(row) : undefined;
  }

  listMeasurements(): WorkflowMeasurementRecord[] {
    this.assertOpen();
    return (this.database.prepare(
      `SELECT measurement.* FROM workflow_measurements measurement
       JOIN operations operation ON operation.operation_id = measurement.operation_id
       ORDER BY operation.ordinal, measurement.measurement_id`,
    ).all() as SqlRow[]).map(measurementFromRow);
  }

  listMeasurementsPage(options: {
    after?: { createdAt: string; measurementId: string };
    limit?: number;
  } = {}): WorkflowMeasurementRecord[] {
    this.assertOpen();
    const limit = pageLimit(options.limit);
    if (!options.after) {
      return (this.database.prepare(
        "SELECT * FROM workflow_measurements ORDER BY created_at, measurement_id LIMIT ?",
      ).all(limit) as SqlRow[]).map(measurementFromRow);
    }
    assertIsoDate(options.after.createdAt, "workflow v17 measurement cursor time");
    assertIdentifier(options.after.measurementId, "workflow v17 measurement cursor id");
    return (this.database.prepare(`
      SELECT * FROM workflow_measurements
      WHERE created_at > ? OR (created_at = ? AND measurement_id > ?)
      ORDER BY created_at, measurement_id LIMIT ?
    `).all(options.after.createdAt, options.after.createdAt, options.after.measurementId, limit) as SqlRow[])
      .map(measurementFromRow);
  }

  readExperiment(experimentId: string): WorkflowExperimentRecord | undefined {
    this.assertOpen();
    assertIdentifier(experimentId, "workflow v17 experiment id");
    const row = this.database.prepare(
      "SELECT * FROM workflow_experiments WHERE experiment_id = ?",
    ).get(experimentId) as SqlRow | undefined;
    return row ? experimentFromRow(row) : undefined;
  }

  readExperimentByOperation(operationId: string): WorkflowExperimentRecord | undefined {
    this.assertOpen();
    assertIdentifier(operationId, "workflow v17 experiment operation id");
    const row = this.database.prepare(
      "SELECT * FROM workflow_experiments WHERE operation_id = ?",
    ).get(operationId) as SqlRow | undefined;
    return row ? experimentFromRow(row) : undefined;
  }

  listExperiments(): WorkflowExperimentRecord[] {
    this.assertOpen();
    return (this.database.prepare(
      `SELECT experiment.* FROM workflow_experiments experiment
       JOIN operations operation ON operation.operation_id = experiment.operation_id
       ORDER BY operation.ordinal, experiment.experiment_id`,
    ).all() as SqlRow[]).map(experimentFromRow);
  }

  listExperimentsPage(options: {
    after?: { createdAt: string; experimentId: string };
    limit?: number;
  } = {}): WorkflowExperimentRecord[] {
    this.assertOpen();
    const limit = pageLimit(options.limit);
    if (!options.after) {
      return (this.database.prepare(
        "SELECT * FROM workflow_experiments ORDER BY created_at, experiment_id LIMIT ?",
      ).all(limit) as SqlRow[]).map(experimentFromRow);
    }
    assertIsoDate(options.after.createdAt, "workflow v17 experiment cursor time");
    assertIdentifier(options.after.experimentId, "workflow v17 experiment cursor id");
    return (this.database.prepare(`
      SELECT * FROM workflow_experiments
      WHERE created_at > ? OR (created_at = ? AND experiment_id > ?)
      ORDER BY created_at, experiment_id LIMIT ?
    `).all(options.after.createdAt, options.after.createdAt, options.after.experimentId, limit) as SqlRow[])
      .map(experimentFromRow);
  }
}

export class WorkflowRunDatabase extends WorkflowRunDatabaseReader {
  private constructor(database: DatabaseSync, databasePath: string) {
    super(database, databasePath);
  }

  static create(
    databasePathInput: string,
    options: CreateWorkflowRunDatabaseOptions,
  ): WorkflowRunDatabase {
    const databasePath = path.resolve(databasePathInput);
    assertCreateOptions(options);
    const rootScopeId = workflowScopeId(options.runId, "run");
    let placeholder: number | undefined;
    let database: DatabaseSync | undefined;
    let ownsPath = false;
    try {
      placeholder = fs.openSync(databasePath, "wx", 0o600);
      ownsPath = true;
      fs.closeSync(placeholder);
      placeholder = undefined;
      database = openConnection(databasePath, false, {}, true);
      configureNewConnection(database);
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(WORKFLOW_RUN_DATABASE_SCHEMA_SQL);
        insertInitialRun(database, options, rootScopeId);
        insertInitialRootScope(database, options, rootScopeId);
        insertInitialResources(database, options);
        insertEvent(database, {
          runId: options.runId,
          sequence: 1,
          revision: 1,
          type: "run-created",
          scopeId: rootScopeId,
          payload: {
            workflowId: options.snapshot.workflowId,
            snapshotHash: options.snapshot.snapshotHash,
          },
          at: options.createdAt,
        });
        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* preserve original error */ }
        throw error;
      }
      const result = new WorkflowRunDatabase(database, databasePath);
      result.validateIntegrity();
      return result;
    } catch (error) {
      if (placeholder !== undefined) fs.closeSync(placeholder);
      database?.close();
      if (ownsPath) removeDatabaseFiles(databasePath);
      throw error;
    }
  }

  static open(
    databasePathInput: string,
    options: WorkflowRunDatabaseOpenOptions = {},
  ): WorkflowRunDatabase {
    const databasePath = path.resolve(databasePathInput);
    const database = openConnection(databasePath, false, options);
    const result = new WorkflowRunDatabase(database, databasePath);
    try {
      result.assertBasicWritableIdentity();
      return result;
    } catch (error) {
      result.close();
      throw error;
    }
  }

  requestHumanInteraction(input: {
    expectedRevision: number;
    interactionId: string;
    operationId: string;
    kind: "ask" | "apply";
    challengeHash: string;
    request: JsonObject;
    at: string;
  }): WorkflowHumanInteractionRecord {
    assertPositiveRevision(input.expectedRevision);
    assertIdentifier(input.interactionId, "workflow v17 human interaction id");
    assertIdentifier(input.operationId, "workflow v17 human operation id");
    assertHash(input.challengeHash, "workflow v17 human challenge hash");
    canonicalJsonValue(input.request, jsonLimits());
    assertIsoDate(input.at, "workflow v17 human interaction time");
    const existing = this.readHumanInteraction(input.interactionId)
      ?? this.readHumanInteractionByOperation(input.operationId);
    if (existing) {
      if (existing.interactionId !== input.interactionId || existing.operationId !== input.operationId
        || existing.kind !== input.kind || existing.challengeHash !== input.challengeHash
        || stableJson(existing.request) !== stableJson(input.request)) {
        throw state("Workflow v17 human interaction changed identity");
      }
      return existing;
    }
    this.mutate(input.expectedRevision, {
      type: `${input.kind}-waiting`,
      operationId: input.operationId,
      payload: { interactionId: input.interactionId, challengeHash: input.challengeHash },
      at: input.at,
    }, (run, nextRevision) => {
      if (run.status !== "running") throw state(`Workflow v17 human interaction cannot start while run is ${run.status}`);
      const operation = this.requireOperation(input.operationId);
      if (operation.kind !== input.kind || operation.status !== "running") {
        throw state(`Workflow v17 ${input.kind} operation is not running`);
      }
      this.database.prepare(`
        INSERT INTO human_interactions(
          interaction_id, run_id, operation_id, kind, status, challenge_hash,
          request_json, requested_at
        ) VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?)
      `).run(
        input.interactionId, run.runId, operation.operationId, input.kind,
        input.challengeHash, json(input.request), input.at,
      );
      assertOneChange(this.database.prepare(`
        UPDATE operations SET status = 'waiting', updated_at = ?
        WHERE operation_id = ? AND status = 'running'
      `).run(input.at, operation.operationId), "workflow v17 waiting human operation");
      this.database.prepare(`
        UPDATE attempts SET status = 'waiting', updated_at = ?
        WHERE operation_id = ? AND status = 'running'
      `).run(input.at, operation.operationId);
      assertOneChange(this.database.prepare(`
        UPDATE runs SET status = 'waiting', reason_json = ?, current_operation_id = ?,
          revision = ?, updated_at = ? WHERE singleton = 1 AND revision = ?
      `).run(json({
        category: "human",
        code: `${input.kind}-waiting`,
        summary: input.kind === "ask" ? "Workflow is waiting for a human response" : "Workflow is waiting for apply approval",
        retryable: true,
        interactionId: input.interactionId,
      }), operation.operationId, nextRevision, input.at, run.revision), "workflow v17 waiting run");
      return { interactionId: input.interactionId };
    });
    return this.readHumanInteraction(input.interactionId)!;
  }

  enqueueControlRequest(request: WorkflowControlRequestRecord): WorkflowControlRequestRecord {
    assertControlRequestRecord(request);
    const run = this.readRun();
    if (request.runId !== run.runId || request.status !== "pending" || request.processedAt !== undefined
      || request.reason !== undefined) {
      throw new TypeError("Workflow v17 control request is not a pending request for this run");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.readControlRequest(request.requestId);
      if (existing) {
        if (stableJson(existing) !== stableJson(request)) throw state("Workflow v17 control request changed identity");
        this.database.exec("COMMIT");
        return existing;
      }
      this.database.prepare(`
        INSERT INTO control_requests(
          request_id, run_id, kind, target_id, challenge_hash, value_json,
          actor, status, requested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        request.requestId, request.runId, request.kind, request.targetId ?? null,
        request.challengeHash ?? null, request.value === undefined ? null : json(request.value),
        request.actor, request.requestedAt,
      );
      this.database.exec("COMMIT");
      return this.readControlRequest(request.requestId)!;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw normalizeConstraint(error);
    }
  }

  processControlRequest(requestId: string, at: string): WorkflowControlRequestRecord {
    assertIdentifier(requestId, "workflow v17 control request id");
    assertIsoDate(at, "workflow v17 control processing time");
    const selected = this.readControlRequest(requestId);
    if (!selected) throw state(`Unknown workflow v17 control request ${requestId}`);
    if (selected.status !== "pending") return selected;
    this.mutate(this.readRun().revision, {
      type: `control-${selected.kind}`,
      payload: { requestId },
      at,
    }, (run, nextRevision) => {
      const request = this.readControlRequest(requestId);
      if (!request || request.status !== "pending") throw state("Workflow v17 control request is no longer pending");
      let rejected: JsonObject | undefined;
      try {
        this.applyControlRequest(run, request, nextRevision, at);
      } catch (error) {
        rejected = {
          category: "control",
          code: "request-rejected",
          summary: error instanceof Error ? error.message : String(error),
          retryable: false,
        };
        this.setRunRevisionOnly(run.revision, nextRevision, at);
      }
      assertOneChange(this.database.prepare(`
        UPDATE control_requests SET status = ?, reason_json = ?, processed_at = ?
        WHERE request_id = ? AND status = 'pending'
      `).run(rejected ? "rejected" : "processed", rejected ? json(rejected) : null, at, requestId),
      "workflow v17 control request settlement");
      return rejected ? { rejected } : {} as JsonObject;
    });
    return this.readControlRequest(requestId)!;
  }

  transitionRun(expectedRevision: number, input: TransitionWorkflowRunInput): WorkflowRunRecord {
    assertRunTransitionInput(input);
    this.mutate(expectedRevision, {
      type: `run-${input.status}`,
      payload: input.reason ? { reason: input.reason } : {},
      at: input.at,
    }, (run, nextRevision) => {
      assertRunTransition(run.status, input.status);
      let eventPayload: JsonObject = input.reason ? { reason: input.reason } : {};
      if (input.status === "completed") {
        const root = this.readScope(run.rootScopeId);
        if (!root || root.status !== "completed" || root.terminalKey !== input.rootTerminalKey) {
          throw state("Workflow completion requires the exact completed root-scope terminal key");
        }
        const discarded = this.finishSuccessfulCandidates(run.runId, input.at);
        const activeScopes = requiredNumber(this.database.prepare(
          "SELECT count(*) AS value FROM scopes WHERE status = 'active'",
        ).get() as SqlRow, "value");
        if (activeScopes !== 0) throw state("Workflow completion has active semantic scopes");
        const interruptedOperations = requiredNumber(this.database.prepare(`
          SELECT count(*) AS value FROM operations operation
          JOIN scopes scope ON scope.scope_id = operation.scope_id
          WHERE operation.status IN ('running', 'waiting', 'stopped')
            OR (operation.status = 'cancelled' AND scope.status <> 'cancelled')
        `).get() as SqlRow, "value");
        const liveAttempts = requiredNumber(this.database.prepare(`
          SELECT count(*) AS value FROM attempts WHERE status IN ('running', 'waiting')
        `).get() as SqlRow, "value");
        if (interruptedOperations !== 0 || liveAttempts !== 0) {
          throw state("Workflow completion has interrupted operations or attempts");
        }
        eventPayload = { ...eventPayload, discardedCandidates: discarded };
      } else if (input.status === "failed" || input.status === "stopped") {
        const abandoned = this.terminateCandidates(run.runId, input.status, input.reason ?? {
          category: "workflow",
          code: input.status,
          summary: `Workflow ${input.status}`,
          retryable: false,
        }, input.at);
        this.terminateActiveExecution(run.runId, input.status, input.reason, input.at);
        eventPayload = { ...eventPayload, abandonedCandidates: abandoned };
      }
      const terminal = TERMINAL_RUN_STATUSES.has(input.status);
      const currentOperationId = input.currentOperationId === undefined
        ? terminal ? null : run.currentOperationId ?? null
        : input.currentOperationId;
      if (currentOperationId !== null) this.requireOperation(currentOperationId);
      const changed = this.database.prepare(`
        UPDATE runs SET status = ?, reason_json = ?, current_operation_id = ?, root_terminal_key = ?,
          result_present = ?, result_json = ?,
          revision = ?, updated_at = ?,
          started_at = CASE WHEN ? = 'running' THEN coalesce(started_at, ?) ELSE started_at END,
          ended_at = CASE WHEN ? IN ('completed', 'failed', 'stopped') THEN ? ELSE NULL END
        WHERE singleton = 1 AND revision = ?
      `).run(
        input.status,
        input.reason ? json(input.reason) : null,
        currentOperationId,
        input.status === "completed" ? input.rootTerminalKey! : null,
        input.status === "completed" ? 1 : 0,
        input.status === "completed" ? json(input.result ?? null) : null,
        nextRevision,
        input.at,
        input.status,
        input.at,
        input.status,
        input.at,
        expectedRevision,
      );
      assertOneChange(changed, "workflow run transition");
      return eventPayload;
    });
    return this.readRun();
  }

  claimOperation(input: ClaimWorkflowOperationInput): {
    operation: WorkflowOperationRecord;
    claimed: boolean;
  } {
    assertClaimInput(input);
    this.assertOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.readRun();
      assertExpectedRevision(run.revision, input.expectedRevision);
      const scope = this.requireScope(input.scopeId);
      const existing = this.readOperationAt(scope.scopeId, input.cursor);
      if (existing) {
        if (existing.kind !== input.kind || existing.semanticInputHash !== input.semanticInputHash) {
          throw state(`Semantic operation changed at ${existing.path}`);
        }
        this.database.exec("COMMIT");
        return { operation: existing, claimed: false };
      }
      if (scope.status !== "active") throw state(`Cannot claim a new operation in ${scope.status} scope ${scope.path}`);
      const nextCursor = requiredNumber(this.database.prepare(
        "SELECT coalesce(max(cursor), -1) + 1 AS value FROM operations WHERE scope_id = ?",
      ).get(scope.scopeId) as SqlRow, "value");
      if (input.cursor !== nextCursor) {
        throw state(`Scope ${scope.path} expected cursor ${nextCursor}, received ${input.cursor}`);
      }
      if (input.cursor > 0) {
        const previous = this.database.prepare(
          "SELECT call_key FROM scope_calls WHERE scope_id = ? AND cursor = ?",
        ).get(scope.scopeId, input.cursor - 1) as SqlRow | undefined;
        if (!previous) throw state(`Scope ${scope.path} cannot advance beyond an unsettled cursor`);
      }
      const operationCount = requiredNumber(this.database.prepare(
        "SELECT count(*) AS value FROM operations WHERE run_id = ?",
      ).get(run.runId) as SqlRow, "value");
      const maximumOperations = input.maximumOperations ?? DEFINITION_LIMITS.semanticOperations;
      const maximumAgentOperations = Math.min(
        input.maximumAgentOperations ?? run.safety.maximumAgentLaunches,
        run.safety.maximumAgentLaunches,
      );
      if (operationCount >= maximumOperations) {
        throw new WorkflowRunDatabaseAdmissionError(
          "operations",
          `Workflow v17 operation admission limit ${maximumOperations} was reached`,
        );
      }
      if (input.kind === "agent") {
        const agentCount = requiredNumber(this.database.prepare(
          "SELECT count(*) AS value FROM operations WHERE run_id = ? AND kind = 'agent'",
        ).get(run.runId) as SqlRow, "value");
        if (agentCount >= maximumAgentOperations) {
          throw new WorkflowRunDatabaseAdmissionError(
            "agents",
            `Workflow v17 agent admission limit ${maximumAgentOperations} was reached`,
          );
        }
      }
      const operationPathValue = operationPath(scope.path, input.cursor);
      const operationId = workflowOperationId(run.runId, operationPathValue);
      const ordinal = requiredNumber(this.database.prepare(
        "SELECT coalesce(max(ordinal), -1) + 1 AS value FROM operations",
      ).get() as SqlRow, "value");
      const nextRevision = input.expectedRevision + 1;
      this.database.prepare(`
        INSERT INTO operations(
          operation_id, run_id, scope_id, cursor, path, kind, ordinal, source_site,
          descriptor_source_site, title, semantic_input_hash, status, result_present,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, ?, ?)
      `).run(
        operationId, run.runId, scope.scopeId, input.cursor, operationPathValue, input.kind, ordinal,
        input.sourceSite, input.descriptorSourceSite ?? null, input.title ?? null,
        input.semanticInputHash, input.at, input.at,
      );
      this.bumpRunRevision(input.expectedRevision, nextRevision, input.at, operationId);
      insertEvent(this.database, {
        runId: run.runId,
        sequence: nextRevision,
        revision: nextRevision,
        type: "operation-claimed",
        operationId,
        scopeId: scope.scopeId,
        payload: { cursor: input.cursor, kind: input.kind },
        at: input.at,
      });
      this.database.exec("COMMIT");
      return { operation: this.readOperation(operationId)!, claimed: true };
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw normalizeConstraint(error);
    }
  }

  createChildScopes(
    expectedRevision: number,
    ownerOperationId: string,
    specs: readonly CreateWorkflowChildScopeSpec[],
    at: string,
  ): { scopes: WorkflowScopeRecord[]; created: boolean } {
    assertPositiveRevision(expectedRevision);
    assertIdentifier(ownerOperationId, "workflow v17 owner operation id");
    assertIsoDate(at, "workflow v17 child scopes time");
    assertChildScopeSpecs(specs);
    this.assertOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.readRun();
      assertExpectedRevision(run.revision, expectedRevision);
      const owner = this.requireOperation(ownerOperationId);
      if (!STRUCTURAL_KINDS.has(owner.kind) || owner.status !== "running") {
        throw state(`Operation ${owner.path} cannot own child scopes`);
      }
      assertChildKinds(owner.kind, specs);
      const parent = this.requireScope(owner.scopeId);
      const parentPreviousCallKey = this.expectedPreviousCallKey(parent, owner.cursor);
      for (const spec of specs) {
        const expectedSeed = workflowLaneSeed({
          parentPreviousCallKey,
          ownerOperationPath: owner.path,
          ownerKind: owner.kind as "parallel" | "map" | "candidate",
          childKind: spec.kind,
          ...(spec.laneKey !== undefined ? { laneKey: spec.laneKey } : {}),
        });
        if (spec.seedKey !== expectedSeed) {
          throw state(`Child scope ${childScopePath(owner, spec)} has an invalid causal seed`);
        }
      }
      const existing = this.listChildScopes(owner.operationId);
      if (existing.length > 0) {
        assertExistingChildScopes(existing, owner, specs);
        this.database.exec("COMMIT");
        return { scopes: existing, created: false };
      }
      if (specs.length === 0) {
        this.database.exec("COMMIT");
        return { scopes: [], created: false };
      }
      const created: WorkflowScopeRecord[] = [];
      for (let ordinal = 0; ordinal < specs.length; ordinal++) {
        const spec = specs[ordinal]!;
        const scopePathValue = childScopePath(owner, spec);
        const scopeId = workflowScopeId(run.runId, scopePathValue);
        this.database.prepare(`
          INSERT INTO scopes(
            scope_id, run_id, parent_scope_id, owner_operation_id, path, kind,
            sibling_ordinal, lane_key, seed_key, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
        `).run(
          scopeId, run.runId, parent.scopeId, owner.operationId, scopePathValue, spec.kind,
          ordinal, spec.laneKey ?? null, spec.seedKey, at,
        );
        created.push(scopeFromRow(this.database.prepare("SELECT * FROM scopes WHERE scope_id = ?").get(scopeId) as SqlRow));
      }
      const nextRevision = expectedRevision + 1;
      this.bumpRunRevision(expectedRevision, nextRevision, at, owner.operationId);
      insertEvent(this.database, {
        runId: run.runId,
        sequence: nextRevision,
        revision: nextRevision,
        type: "child-scopes-created",
        operationId: owner.operationId,
        scopeId: owner.scopeId,
        payload: { count: created.length, keys: created.map((scope) => scope.laneKey ?? "candidate") },
        at,
      });
      this.database.exec("COMMIT");
      return { scopes: created, created: true };
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw normalizeConstraint(error);
    }
  }

  settleEffect(input: SettleWorkflowEffectInput): WorkflowEffectSettlementRecord {
    assertSettleEffectInput(input);
    this.assertOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.readRun();
      assertExpectedRevision(run.revision, input.expectedRevision);
      const operation = this.requireOperation(input.operationId);
      if (STRUCTURAL_KINDS.has(operation.kind)) {
        throw state(`Operation ${operation.path} cannot have a host effect settlement`);
      }
      const existing = this.readEffectSettlement(operation.operationId);
      if (existing) {
        if (!sameEffectSettlement(existing, input)) {
          throw state(`Workflow v17 effect settlement ${operation.path} changed identity`);
        }
        this.database.exec("COMMIT");
        return existing;
      }
      if (operation.status !== "running" && operation.status !== "waiting") {
        throw state(`Operation ${operation.path} is ${operation.status}`);
      }
      if (operation.kind === "apply" && input.replayPolicy !== "never") {
        throw state("Apply settlements must never be replayable");
      }
      if (input.postWorkspaceCheckpointId) {
        const checkpoint = this.readWorkspaceCheckpoint(input.postWorkspaceCheckpointId);
        if (!checkpoint || checkpoint.operationId !== operation.operationId || checkpoint.runId !== run.runId) {
          throw state("Effect settlement workspace checkpoint differs from its operation");
        }
      }
      this.database.prepare(`
        INSERT INTO effect_settlements(
          operation_id, run_id, semantic_key, outcome, completion_authority,
          replay_policy, result_json, failure_json, post_workspace_checkpoint_id, settled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        operation.operationId,
        run.runId,
        input.semanticKey,
        input.outcome,
        input.completionAuthority,
        input.replayPolicy,
        input.outcome === "success" ? json(input.result!) : null,
        input.outcome === "failure" ? json(input.failure!) : null,
        input.postWorkspaceCheckpointId ?? null,
        input.at,
      );
      const nextRevision = input.expectedRevision + 1;
      this.bumpRunRevision(input.expectedRevision, nextRevision, input.at, operation.operationId);
      insertEvent(this.database, {
        runId: run.runId,
        sequence: nextRevision,
        revision: nextRevision,
        type: "effect-settled",
        operationId: operation.operationId,
        scopeId: operation.scopeId,
        payload: { outcome: input.outcome, replayPolicy: input.replayPolicy },
        at: input.at,
      });
      this.database.exec("COMMIT");
      return this.readEffectSettlement(operation.operationId)!;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw normalizeConstraint(error);
    }
  }

  completeScope(input: CompleteWorkflowScopeInput): WorkflowScopeRecord {
    assertPositiveRevision(input.expectedRevision);
    assertIdentifier(input.scopeId, "workflow v17 scope id");
    assertHash(input.terminalKey, "workflow v17 scope terminal key");
    assertIsoDate(input.at, "workflow v17 scope completion time");
    if (input.status === "completed" ? input.failure !== undefined : input.failure === undefined) {
      throw new TypeError("Workflow v17 failed/cancelled scope requires failure and completed scope forbids it");
    }
    this.mutate(input.expectedRevision, {
      type: `scope-${input.status}`,
      scopeId: input.scopeId,
      payload: {},
      at: input.at,
    }, (run, nextRevision) => {
      const scope = this.requireScope(input.scopeId);
      if (scope.status !== "active") throw state(`Scope ${scope.path} is already ${scope.status}`);
      const live = requiredNumber(this.database.prepare(`
        SELECT count(*) AS value FROM operations
        WHERE scope_id = ? AND status IN ('running', 'waiting')
      `).get(scope.scopeId) as SqlRow, "value");
      if (live !== 0) throw state(`Scope ${scope.path} has unsettled operations`);
      if (input.status === "completed" && input.terminalKey !== this.expectedPreviousCallKey(scope)) {
        throw state(`Scope ${scope.path} terminal key differs from its local call chain`);
      }
      const changed = this.database.prepare(`
        UPDATE scopes SET status = ?, terminal_key = ?, failure_json = ?, ended_at = ?
        WHERE scope_id = ? AND status = 'active'
      `).run(
        input.status, input.terminalKey, input.failure ? json(input.failure) : null, input.at, scope.scopeId,
      );
      assertOneChange(changed, "workflow v17 scope completion");
      this.setRunRevisionOnly(run.revision, nextRevision, input.at);
      return {};
    });
    return this.readScope(input.scopeId)!;
  }

  cancelScopeTree(input: CancelWorkflowScopeTreeInput): WorkflowScopeRecord {
    assertPositiveRevision(input.expectedRevision);
    assertIdentifier(input.scopeId, "workflow v17 cancelled scope id");
    canonicalJsonValue(input.failure, jsonLimits());
    assertIsoDate(input.at, "workflow v17 scope cancellation time");
    this.assertOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.readRun();
      assertExpectedRevision(run.revision, input.expectedRevision);
      const root = this.requireScope(input.scopeId);
      if (root.status !== "active") {
        this.database.exec("COMMIT");
        return root;
      }
      const rows = this.database.prepare(`
        WITH RECURSIVE tree(scope_id) AS (
          SELECT scope_id FROM scopes WHERE scope_id = ?
          UNION ALL
          SELECT child.scope_id FROM scopes child JOIN tree ON child.parent_scope_id = tree.scope_id
        )
        SELECT scope.* FROM scopes scope JOIN tree ON tree.scope_id = scope.scope_id
        ORDER BY length(scope.path) DESC, scope.path DESC
      `).all(root.scopeId) as SqlRow[];
      const scopes = rows.map(scopeFromRow);
      const scopeIds = scopes.map((scope) => scope.scopeId);
      const placeholders = scopeIds.map(() => "?").join(", ");
      this.database.prepare(`
        UPDATE attempts SET status = 'cancelled', updated_at = ?, ended_at = ?
        WHERE operation_id IN (
          SELECT operation_id FROM operations WHERE scope_id IN (${placeholders})
        ) AND status IN ('running', 'waiting')
      `).run(input.at, input.at, ...scopeIds);
      this.database.prepare(`
        UPDATE operations SET status = 'cancelled', updated_at = ?, ended_at = ?
        WHERE scope_id IN (${placeholders}) AND status IN ('running', 'waiting')
      `).run(input.at, input.at, ...scopeIds);
      let cancelled = 0;
      for (const scope of scopes) {
        if (scope.status !== "active") continue;
        const previousCallKey = this.expectedPreviousCallKey(scope);
        const terminalKey = stableHash({
          formatVersion: 1,
          kind: "workflow-scope-cancellation",
          previousCallKey,
          failure: input.failure,
        });
        this.database.prepare(`
          UPDATE scopes SET status = 'cancelled', terminal_key = ?, failure_json = ?, ended_at = ?
          WHERE scope_id = ? AND status = 'active'
        `).run(terminalKey, json(input.failure), input.at, scope.scopeId);
        cancelled++;
      }
      const nextRevision = input.expectedRevision + 1;
      this.bumpRunRevision(input.expectedRevision, nextRevision, input.at, null);
      insertEvent(this.database, {
        runId: run.runId,
        sequence: nextRevision,
        revision: nextRevision,
        type: "scope-tree-cancelled",
        scopeId: root.scopeId,
        payload: { scopes: cancelled, failure: input.failure },
        at: input.at,
      });
      this.database.exec("COMMIT");
      return this.readScope(root.scopeId)!;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw normalizeConstraint(error);
    }
  }

  completeCall(input: CompleteWorkflowCallInput): WorkflowOperationRecord {
    assertCompleteCallInput(input);
    return this.commitCallTransaction(input, undefined);
  }

  completeStructuralJoin(input: CompleteWorkflowStructuralJoinInput): WorkflowOperationRecord {
    assertCompleteStructuralJoinInput(input);
    return this.commitCallTransaction({
      ...input,
      outcome: "success",
      completionAuthority: "structural-join",
      replayPolicy: "immutable",
    }, input);
  }

  completeStructuralFailure(input: CompleteWorkflowStructuralFailureInput): WorkflowOperationRecord {
    assertCompleteStructuralFailureInput(input);
    return this.commitCallTransaction({
      ...input,
      outcome: "failure",
      completionAuthority: "structural-join",
      replayPolicy: "never",
    }, input);
  }

  insertArtifact(expectedRevision: number, artifact: WorkflowArtifactRecord): WorkflowArtifactRecord {
    assertArtifactRecord(artifact);
    this.mutate(expectedRevision, {
      type: "artifact-stored",
      payload: { digest: artifact.digest, kind: artifact.kind },
      at: artifact.createdAt,
    }, (run, nextRevision) => {
      if (artifact.runId !== run.runId) throw new TypeError("Workflow v17 artifact belongs to another run");
      const existing = this.readArtifact(artifact.digest);
      if (existing) {
        if (stableJson(existing) !== stableJson(artifact)) throw state(`Artifact ${artifact.digest} changed identity`);
        throw state(`Artifact ${artifact.digest} is already stored`);
      }
      this.database.prepare(`
        INSERT INTO artifacts(digest, run_id, kind, media_type, bytes, body_path, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifact.digest, artifact.runId, artifact.kind, artifact.mediaType, artifact.bytes,
        artifact.bodyPath, json(artifact.metadata), artifact.createdAt,
      );
      this.setRunRevisionOnly(run.revision, nextRevision, artifact.createdAt);
      return {};
    });
    return this.readArtifact(artifact.digest)!;
  }

  insertAttempt(expectedRevision: number, attempt: WorkflowAttemptRecord): WorkflowAttemptRecord {
    assertAttemptRecord(attempt);
    this.mutate(expectedRevision, {
      type: "attempt-started",
      operationId: attempt.operationId,
      payload: { attemptId: attempt.attemptId, effect: attempt.effect },
      at: attempt.createdAt,
    }, (run, nextRevision) => {
      if (attempt.runId !== run.runId) throw new TypeError("Workflow v17 attempt belongs to another run");
      this.requireOperation(attempt.operationId);
      this.database.prepare(`
        INSERT INTO attempts(
          attempt_id, run_id, operation_id, number, effect, execution_id, status,
          usage_json, resources_json, created_at, updated_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attempt.attemptId, attempt.runId, attempt.operationId, attempt.number, attempt.effect,
        attempt.executionId ?? null, attempt.status, json(attempt.usage),
        attempt.resources ? json(attempt.resources) : null, attempt.createdAt, attempt.updatedAt,
        attempt.endedAt ?? null,
      );
      this.setRunRevisionOnly(run.revision, nextRevision, attempt.createdAt);
      return {};
    });
    const row = this.database.prepare("SELECT * FROM attempts WHERE attempt_id = ?").get(attempt.attemptId) as SqlRow;
    return attemptFromRow(row);
  }

  completeAttempt(input: CompleteWorkflowAttemptInput): WorkflowAttemptRecord {
    assertPositiveRevision(input.expectedRevision);
    assertIdentifier(input.attemptId, "workflow v17 attempt id");
    if (!new Set(["completed", "failed", "stopped", "cancelled"]).has(input.status)) {
      throw new TypeError("Invalid workflow v17 attempt completion status");
    }
    canonicalJsonValue(input.usage, jsonLimits());
    if (input.resources) canonicalJsonValue(input.resources, jsonLimits());
    assertIsoDate(input.at, "workflow v17 attempt completion time");
    this.mutate(input.expectedRevision, {
      type: `attempt-${input.status}`,
      payload: { attemptId: input.attemptId },
      at: input.at,
    }, (run, nextRevision) => {
      const attempt = this.readAttempt(input.attemptId);
      if (!attempt) throw state(`Missing workflow v17 attempt ${input.attemptId}`);
      if (attempt.status !== "running" && attempt.status !== "waiting") {
        throw state(`Workflow v17 attempt ${input.attemptId} is ${attempt.status}`);
      }
      this.database.prepare(`
        UPDATE attempts SET status = ?, usage_json = ?, resources_json = ?, updated_at = ?, ended_at = ?
        WHERE attempt_id = ? AND status IN ('running', 'waiting')
      `).run(
        input.status, json(input.usage), input.resources ? json(input.resources) : null,
        input.at, input.at, input.attemptId,
      );
      this.setRunRevisionOnly(run.revision, nextRevision, input.at);
      return {};
    });
    return this.readAttempt(input.attemptId)!;
  }

  insertWorkspaceCheckpoint(
    expectedRevision: number,
    checkpoint: WorkflowWorkspaceCheckpointRecord,
  ): WorkflowWorkspaceCheckpointRecord {
    assertWorkspaceCheckpoint(checkpoint);
    this.mutate(expectedRevision, {
      type: "workspace-checkpoint-stored",
      operationId: checkpoint.operationId,
      payload: { checkpointId: checkpoint.checkpointId, treeHash: checkpoint.treeHash },
      at: checkpoint.createdAt,
    }, (run, nextRevision) => {
      if (checkpoint.runId !== run.runId) throw new TypeError("Workflow v17 checkpoint belongs to another run");
      this.requireOperation(checkpoint.operationId);
      this.database.prepare(`
        INSERT INTO workspace_checkpoints(
          checkpoint_id, run_id, operation_id, workspace_id, tree_hash, lineage_hash,
          write_scope_hash, storage_path, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        checkpoint.checkpointId, checkpoint.runId, checkpoint.operationId, checkpoint.workspaceId,
        checkpoint.treeHash, checkpoint.lineageHash ?? null, checkpoint.writeScopeHash ?? null,
        checkpoint.storagePath, checkpoint.createdAt,
      );
      this.setRunRevisionOnly(run.revision, nextRevision, checkpoint.createdAt);
      return {};
    });
    const row = this.database.prepare(
      "SELECT * FROM workspace_checkpoints WHERE checkpoint_id = ?",
    ).get(checkpoint.checkpointId) as SqlRow;
    return workspaceCheckpointFromRow(row);
  }

  createCandidateWorkspace(input: CreateCandidateWorkspaceInput): WorkflowCandidateWorkspaceRecord {
    assertCreateCandidateWorkspaceInput(input);
    this.mutate(input.expectedRevision, {
      type: "candidate-workspace-created",
      operationId: input.candidateOperationId,
      scopeId: input.bodyScopeId,
      payload: { workspaceId: input.workspaceId },
      at: input.at,
    }, (run, nextRevision) => {
      const operation = this.requireOperation(input.candidateOperationId);
      const body = this.requireScope(input.bodyScopeId);
      if (operation.kind !== "candidate" || operation.status !== "running"
        || body.kind !== "candidate-body" || body.ownerOperationId !== operation.operationId
        || body.status !== "active") {
        throw state("Candidate workspace requires its active candidate body scope");
      }
      if (input.parentCandidateId) {
        const parent = this.readCandidate(input.parentCandidateId);
        if (!parent || (parent.state !== "accepted" && parent.state !== "applied")) {
          throw state("Candidate workspace base must be an accepted candidate from this run");
        }
      }
      this.database.prepare(`
        INSERT INTO candidate_workspaces(
          workspace_id, run_id, candidate_operation_id, body_scope_id, parent_candidate_id,
          state, initial_tree_hash, base_lineage_hash, write_scope_json, write_scope_hash,
          root_path, created_at
        ) VALUES (?, ?, ?, ?, ?, 'mutable', ?, ?, ?, ?, ?, ?)
      `).run(
        input.workspaceId, run.runId, operation.operationId, body.scopeId, input.parentCandidateId ?? null,
        input.initialTreeHash, input.baseLineageHash, json(input.writeScope), input.writeScopeHash,
        input.rootPath, input.at,
      );
      this.setRunRevisionOnly(run.revision, nextRevision, input.at);
      return {};
    });
    return this.readCandidateWorkspace(input.workspaceId)!;
  }

  bindCandidateWorkspaceLane(
    expectedRevision: number,
    input: { workspaceId: string; groupOperationId: string; laneKey: string; at: string },
  ): WorkflowCandidateWorkspaceRecord {
    assertPositiveRevision(expectedRevision);
    assertIdentifier(input.workspaceId, "workflow v17 candidate workspace id");
    assertIdentifier(input.groupOperationId, "workflow v17 concurrency group operation id");
    assertLaneKey(input.laneKey);
    assertIsoDate(input.at, "workflow v17 workspace lane binding time");
    this.assertOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.readRun();
      assertExpectedRevision(run.revision, expectedRevision);
      const workspace = this.requireCandidateWorkspace(input.workspaceId);
      if (workspace.state !== "mutable") throw state(`Candidate workspace ${input.workspaceId} is ${workspace.state}`);
      const group = this.requireOperation(input.groupOperationId);
      if (group.kind !== "parallel" && group.kind !== "map") throw state("Workspace lane owner is not a concurrency group");
      const existing = this.database.prepare(`
        SELECT lane_key FROM candidate_workspace_lanes
        WHERE workspace_id = ? AND group_operation_id = ?
      `).get(input.workspaceId, input.groupOperationId) as SqlRow | undefined;
      if (existing) {
        const owner = requiredString(existing, "lane_key");
        if (owner !== input.laneKey) {
          throw state(`Candidate workspace ${input.workspaceId} is shared by sibling lanes ${owner} and ${input.laneKey}`);
        }
        this.database.exec("COMMIT");
        return workspace;
      }
      this.database.prepare(`
        INSERT INTO candidate_workspace_lanes(workspace_id, group_operation_id, lane_key, bound_at)
        VALUES (?, ?, ?, ?)
      `).run(input.workspaceId, input.groupOperationId, input.laneKey, input.at);
      const nextRevision = expectedRevision + 1;
      this.bumpRunRevision(expectedRevision, nextRevision, input.at, run.currentOperationId ?? null);
      insertEvent(this.database, {
        runId: run.runId,
        sequence: nextRevision,
        revision: nextRevision,
        type: "candidate-workspace-lane-bound",
        operationId: input.groupOperationId,
        payload: { workspaceId: input.workspaceId, laneKey: input.laneKey },
        at: input.at,
      });
      this.database.exec("COMMIT");
      return this.readCandidateWorkspace(input.workspaceId)!;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw normalizeConstraint(error);
    }
  }

  abandonCandidateWorkspace(
    expectedRevision: number,
    workspaceId: string,
    reason: JsonObject,
    at: string,
  ): WorkflowCandidateWorkspaceRecord {
    assertIdentifier(workspaceId, "workflow v17 candidate workspace id");
    assertIsoDate(at, "workflow v17 workspace abandonment time");
    this.mutate(expectedRevision, {
      type: "candidate-workspace-abandoned",
      payload: { workspaceId, reason },
      at,
    }, (run, nextRevision) => {
      const workspace = this.requireCandidateWorkspace(workspaceId);
      if (workspace.state !== "mutable") throw state(`Candidate workspace ${workspaceId} is ${workspace.state}`);
      this.database.prepare(`
        UPDATE candidate_workspaces SET state = 'abandoned', failure_json = ?, ended_at = ?
        WHERE workspace_id = ? AND state = 'mutable'
      `).run(json(reason), at, workspaceId);
      this.setRunRevisionOnly(run.revision, nextRevision, at);
      return {};
    });
    return this.readCandidateWorkspace(workspaceId)!;
  }

  freezeCandidate(input: FreezeCandidateInput): WorkflowCandidateRecord {
    assertFreezeCandidateInput(input);
    let candidateId = "";
    this.mutate(input.expectedRevision, {
      type: "candidate-frozen",
      payload: { workspaceId: input.workspaceId, treeHash: input.treeHash },
      at: input.at,
    }, (run, nextRevision) => {
      const workspace = this.requireCandidateWorkspace(input.workspaceId);
      const operation = this.requireOperation(workspace.candidateOperationId);
      const body = this.requireScope(workspace.bodyScopeId);
      if (workspace.state !== "mutable" || operation.kind !== "candidate" || operation.status !== "running"
        || (body.status !== "active" && body.status !== "completed")) {
        throw state("Candidate freeze requires an active candidate operation and mutable workspace");
      }
      const live = requiredNumber(this.database.prepare(`
        SELECT count(*) AS value FROM operations
        WHERE scope_id = ? AND status IN ('running', 'waiting')
      `).get(body.scopeId) as SqlRow, "value");
      if (live !== 0) throw state(`Scope ${body.path} has unsettled operations`);
      if (input.bodyTerminalKey !== this.expectedPreviousCallKey(body)
        || (body.status === "completed" && body.terminalKey !== input.bodyTerminalKey)) {
        throw state("Candidate body terminal key differs from its local call chain");
      }
      this.requireArtifact(input.manifestArtifactDigest);
      this.requireArtifact(input.diffArtifactDigest);
      const outputHash = stableHash(input.output);
      candidateId = `candidate_${stableHash({
        formatVersion: 1,
        runId: run.runId,
        operationId: operation.operationId,
        treeHash: input.treeHash,
        lineageHash: input.lineageHash,
        outputHash,
      }).slice(7, 39)}`;
      this.database.prepare(`
        INSERT INTO candidates(
          candidate_id, run_id, operation_id, workspace_id, body_scope_id, parent_candidate_id,
          tree_hash, lineage_hash, write_scope_hash, output_json, output_hash,
          manifest_artifact_digest, diff_artifact_digest, frozen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        candidateId, run.runId, operation.operationId, workspace.workspaceId, body.scopeId,
        workspace.parentCandidateId ?? null, input.treeHash, input.lineageHash, workspace.writeScopeHash,
        json(input.output), outputHash, input.manifestArtifactDigest, input.diffArtifactDigest, input.at,
      );
      for (let ordinal = 0; ordinal < input.changedPaths.length; ordinal++) {
        this.database.prepare(`
          INSERT INTO candidate_changed_paths(candidate_id, ordinal, path) VALUES (?, ?, ?)
        `).run(candidateId, ordinal, input.changedPaths[ordinal]!);
      }
      this.database.prepare(`
        UPDATE candidate_workspaces SET state = 'frozen', ended_at = ? WHERE workspace_id = ? AND state = 'mutable'
      `).run(input.at, workspace.workspaceId);
      if (body.status === "active") {
        this.database.prepare(`
          UPDATE scopes SET status = 'completed', terminal_key = ?, failure_json = NULL, ended_at = ?
          WHERE scope_id = ? AND status = 'active'
        `).run(input.bodyTerminalKey, input.at, body.scopeId);
      }
      this.setRunRevisionOnly(run.revision, nextRevision, input.at);
      return { candidateId };
    });
    return this.readCandidate(candidateId)!;
  }

  registerCandidateMeasurement(
    expectedRevision: number,
    measurement: Omit<WorkflowCandidateMeasurementRecord, "runId" | "status" | "finalizedAt">,
  ): WorkflowCandidateMeasurementRecord {
    assertIdentifier(measurement.measurementId, "workflow v17 measurement id");
    assertIdentifier(measurement.candidateId, "workflow v17 candidate id");
    assertIdentifier(measurement.operationId, "workflow v17 measurement operation id");
    assertHash(measurement.bindingHash, "workflow v17 measurement binding hash");
    assertIsoDate(measurement.createdAt, "workflow v17 measurement time");
    const existing = this.readCandidateMeasurement(measurement.candidateId);
    if (existing) {
      if (existing.measurementId !== measurement.measurementId
        || existing.operationId !== measurement.operationId
        || existing.bindingHash !== measurement.bindingHash) {
        throw state(`Candidate ${measurement.candidateId} measurement changed identity`);
      }
      return existing;
    }
    this.mutate(expectedRevision, {
      type: "candidate-measurement-pending",
      operationId: measurement.operationId,
      candidateId: measurement.candidateId,
      payload: { measurementId: measurement.measurementId },
      at: measurement.createdAt,
    }, (run, nextRevision) => {
      const candidate = this.requirePendingCandidate(measurement.candidateId);
      const operation = this.requireOperation(measurement.operationId);
      if (operation.kind !== "measure" || operation.status !== "completed") {
        throw state("Candidate measurement evidence requires a completed measure operation");
      }
      if (candidate.runId !== run.runId) throw state("Candidate belongs to another workflow run");
      const full = this.readMeasurement(measurement.measurementId);
      if (full && (full.operationId !== operation.operationId
        || full.candidateId !== candidate.candidateId
        || full.bindingHash !== measurement.bindingHash)) {
        throw state("Candidate measurement differs from its full cohort evidence");
      }
      this.database.prepare(`
        INSERT INTO candidate_measurements(
          measurement_id, run_id, candidate_id, operation_id, binding_hash, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        measurement.measurementId, run.runId, candidate.candidateId, operation.operationId,
        measurement.bindingHash, measurement.createdAt,
      );
      this.setRunRevisionOnly(run.revision, nextRevision, measurement.createdAt);
      return {};
    });
    return this.readCandidateMeasurement(measurement.candidateId)!;
  }

  registerMetricSet(
    expectedRevision: number,
    input: Omit<WorkflowMetricSetRecord, "runId" | "states" | "stateHash" | "updatedAt">,
  ): WorkflowMetricSetRecord {
    assertIdentifier(input.metricSetId, "workflow v17 metric-set id");
    assertIdentifier(input.authorityId, "workflow v17 metric-set authority id");
    assertSourceSite(input.sourceSite);
    assertNonNegativeInteger(input.occurrence, "workflow v17 metric-set occurrence");
    const policy = canonicalJsonValue(input.policy, jsonLimits()) as JsonObject;
    const sampling = canonicalJsonValue(input.sampling, jsonLimits()) as JsonObject;
    if (stableHash(policy) !== input.policyHash || stableHash(sampling) !== input.samplingHash) {
      throw new TypeError("Workflow v17 metric-set policy or sampling hash is invalid");
    }
    assertIsoDate(input.createdAt, "workflow v17 metric-set time");
    const existing = this.readMetricSetBySite(input.sourceSite, input.occurrence);
    const proposed = {
      ...input,
      runId: this.readRun().runId,
      policy,
      sampling,
      states: [] as PersistedMetricState[],
      stateHash: stableHash([]),
      updatedAt: input.createdAt,
    };
    if (existing) {
      if (existing.metricSetId !== proposed.metricSetId
        || existing.runId !== proposed.runId
        || existing.authorityId !== proposed.authorityId
        || existing.policyHash !== proposed.policyHash
        || existing.samplingHash !== proposed.samplingHash
        || stableJson(existing.policy) !== stableJson(proposed.policy)
        || stableJson(existing.sampling) !== stableJson(proposed.sampling)) {
        throw state(`Workflow v17 metric set ${input.sourceSite}/${input.occurrence} changed identity`);
      }
      return existing;
    }
    this.mutate(expectedRevision, {
      type: "metric-set-registered",
      payload: { metricSetId: input.metricSetId, sourceSite: input.sourceSite, occurrence: input.occurrence },
      at: input.createdAt,
    }, (run, nextRevision) => {
      this.database.prepare(`
        INSERT INTO metric_sets(
          metric_set_id, run_id, authority_id, source_site, occurrence,
          policy_json, policy_hash, sampling_json, sampling_hash,
          states_json, state_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.metricSetId, run.runId, input.authorityId, input.sourceSite, input.occurrence,
        json(policy), input.policyHash, json(sampling), input.samplingHash,
        json([]), stableHash([]), input.createdAt, input.createdAt,
      );
      this.setRunRevisionOnly(run.revision, nextRevision, input.createdAt);
      return {};
    });
    return this.readMetricSet(input.metricSetId)!;
  }

  recordMeasurement(
    expectedRevision: number,
    input: Omit<WorkflowMeasurementRecord, "runId">,
  ): WorkflowMeasurementRecord {
    assertWorkflowMeasurement(input);
    const existing = this.readMeasurementByOperation(input.operationId);
    const proposed = { ...input, runId: this.readRun().runId };
    if (existing) {
      if (stableJson(existing) !== stableJson(proposed)) {
        throw state(`Workflow v17 measurement ${input.operationId} changed identity`);
      }
      return existing;
    }
    this.mutate(expectedRevision, {
      type: "measurement-recorded",
      operationId: input.operationId,
      ...(input.candidateId ? { candidateId: input.candidateId } : {}),
      payload: { measurementId: input.measurementId, metricSetId: input.metricSetId },
      at: input.createdAt,
    }, (run, nextRevision) => {
      const operation = this.requireOperation(input.operationId);
      if (operation.kind !== "measure" || !["running", "completed"].includes(operation.status)) {
        throw state("Workflow v17 measurement requires its measure operation");
      }
      const metricSet = this.readMetricSet(input.metricSetId);
      if (!metricSet || metricSet.runId !== run.runId) throw state("Workflow v17 measurement metric set is unavailable");
      if (input.candidateId) {
        const candidate = this.requirePendingCandidate(input.candidateId);
        if (candidate.runId !== run.runId) throw state("Workflow v17 measurement candidate belongs elsewhere");
      }
      this.requireArtifact(input.artifactDigest);
      if (input.diagnosticsArtifactDigest) this.requireArtifact(input.diagnosticsArtifactDigest);
      for (const sample of input.samples) {
        this.requireArtifact(sample.stdoutArtifactDigest);
        this.requireArtifact(sample.stderrArtifactDigest);
      }
      const states = applyMetricCohortDeltaToSnapshot(metricSet.states, input.delta);
      const stateHash = stableHash(states);
      this.database.prepare(`
        INSERT INTO workflow_measurements(
          measurement_id, run_id, operation_id, metric_set_id, profile_json, profile_hash,
          command_hash, environment_json, environment_hash, workspace_tree_hash, candidate_id,
          binding_hash, delta_json, observations_json, artifact_digest,
          diagnostics_artifact_digest, samples_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.measurementId, run.runId, operation.operationId, metricSet.metricSetId,
        json(input.profile as unknown as JsonValue), input.profileHash, input.commandHash,
        json(input.environment), input.environmentHash, input.workspaceTreeHash,
        input.candidateId ?? null, input.bindingHash, json(input.delta as unknown as JsonValue),
        json(input.observations), input.artifactDigest, input.diagnosticsArtifactDigest ?? null,
        json(input.samples as unknown as JsonValue), input.createdAt,
      );
      if (input.candidateId) {
        this.database.prepare(`
          INSERT INTO candidate_measurements(
            measurement_id, run_id, candidate_id, operation_id, binding_hash, status, created_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
        `).run(
          input.measurementId, run.runId, input.candidateId, operation.operationId,
          input.bindingHash, input.createdAt,
        );
      }
      this.database.prepare(`
        UPDATE metric_sets SET states_json = ?, state_hash = ?, updated_at = ? WHERE metric_set_id = ?
      `).run(json(states as unknown as JsonValue), stateHash, input.createdAt, metricSet.metricSetId);
      this.setRunRevisionOnly(run.revision, nextRevision, input.createdAt);
      return {};
    });
    return this.readMeasurement(input.measurementId)!;
  }

  registerExperiment(
    expectedRevision: number,
    input: Omit<WorkflowExperimentRecord, "runId">,
  ): WorkflowExperimentRecord {
    assertWorkflowExperiment(input);
    const existing = this.readExperimentByOperation(input.operationId);
    const proposed = { ...input, runId: this.readRun().runId };
    if (existing) {
      if (stableJson(existing) !== stableJson(proposed)) {
        throw state(`Workflow v17 experiment ${input.operationId} changed identity`);
      }
      return existing;
    }
    this.mutate(expectedRevision, {
      type: "experiment-recorded",
      operationId: input.operationId,
      candidateId: input.candidateId,
      payload: { experimentId: input.experimentId, disposition: input.disposition },
      at: input.createdAt,
    }, (run, nextRevision) => {
      const operation = this.requireOperation(input.operationId);
      if (operation.kind !== "record-experiment" || operation.status !== "completed") {
        throw state("Workflow v17 experiment requires its completed operation");
      }
      const candidate = this.readCandidate(input.candidateId);
      const measurement = this.readMeasurement(input.measurementId);
      if (!candidate?.disposition || !measurement || measurement.candidateId !== candidate.candidateId) {
        throw state("Workflow v17 experiment evidence is incomplete");
      }
      if (candidate.disposition.disposition !== input.disposition
        || candidate.disposition.measurementId !== measurement.measurementId) {
        throw state("Workflow v17 experiment disposition differs from candidate evidence");
      }
      this.requireArtifact(input.artifactDigest);
      this.database.prepare(`
        INSERT INTO workflow_experiments(
          experiment_id, run_id, operation_id, candidate_id, measurement_id,
          disposition, learned, binding_hash, artifact_digest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.experimentId, run.runId, operation.operationId, candidate.candidateId,
        measurement.measurementId, input.disposition, input.learned, input.bindingHash,
        input.artifactDigest, input.createdAt,
      );
      this.setRunRevisionOnly(run.revision, nextRevision, input.createdAt);
      return {};
    });
    return this.readExperiment(input.experimentId)!;
  }

  registerCandidateVerification(
    expectedRevision: number,
    verification: Omit<WorkflowCandidateVerificationRecord, "runId">,
  ): WorkflowCandidateVerificationRecord {
    assertVerificationRecord(verification);
    const existing = this.readCandidateVerification(verification.verificationId);
    if (existing) {
      const proposed = { ...verification, runId: existing.runId };
      if (stableJson(existing) !== stableJson(proposed)) {
        throw state(`Candidate verification ${verification.verificationId} changed identity`);
      }
      return existing;
    }
    this.mutate(expectedRevision, {
      type: "candidate-verification-recorded",
      operationId: verification.operationId,
      candidateId: verification.candidateId,
      payload: { verificationId: verification.verificationId, status: verification.status },
      at: verification.createdAt,
    }, (run, nextRevision) => {
      const candidate = this.requirePendingCandidate(verification.candidateId);
      const operation = this.requireOperation(verification.operationId);
      if (operation.kind !== "verify" || operation.status !== "completed") {
        throw state("Candidate verification evidence requires a completed verify operation");
      }
      this.requireArtifact(verification.artifactDigest);
      this.database.prepare(`
        INSERT INTO candidate_verifications(
          verification_id, run_id, candidate_id, operation_id, status, binding_hash,
          evidence_hash, artifact_digest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        verification.verificationId, run.runId, candidate.candidateId, operation.operationId,
        verification.status, verification.bindingHash, verification.evidenceHash,
        verification.artifactDigest, verification.createdAt,
      );
      this.setRunRevisionOnly(run.revision, nextRevision, verification.createdAt);
      return {};
    });
    const row = this.database.prepare(
      "SELECT * FROM candidate_verifications WHERE verification_id = ?",
    ).get(verification.verificationId) as SqlRow;
    return candidateVerificationFromRow(row);
  }

  disposeCandidate(input: DisposeCandidateInput): WorkflowCandidateRecord {
    assertDisposeCandidateInput(input);
    const before = this.readCandidate(input.candidateId);
    if (before?.disposition) {
      const same = before.disposition.disposition === input.disposition
        && before.disposition.operationId === input.operationId
        && before.disposition.measurementId === input.measurementId
        && before.disposition.verificationId === ("verificationId" in input ? input.verificationId : undefined)
        && stableJson(before.disposition.reason ?? null) === stableJson("reason" in input ? input.reason : null);
      if (same) return before;
    }
    this.mutate(input.expectedRevision, {
      type: `candidate-${input.disposition}`,
      operationId: input.operationId,
      candidateId: input.candidateId,
      payload: { disposition: input.disposition },
      at: input.at,
    }, (run, nextRevision) => {
      const candidate = this.requirePendingCandidate(input.candidateId);
      const measurement = this.readCandidateMeasurement(candidate.candidateId);
      const changed = candidate.changedPaths.length > 0;
      let verification: WorkflowCandidateVerificationRecord | undefined;
      if ("verificationId" in input && input.verificationId) {
        const row = this.database.prepare(
          "SELECT * FROM candidate_verifications WHERE verification_id = ?",
        ).get(input.verificationId) as SqlRow | undefined;
        if (!row) throw state(`Missing candidate verification ${input.verificationId}`);
        verification = candidateVerificationFromRow(row);
        if (verification.candidateId !== candidate.candidateId) {
          throw state("Candidate disposition verification belongs to another candidate");
        }
      }
      if (input.disposition === "accepted") {
        if (!changed) throw state("Unchanged candidate cannot be accepted");
        if (!verification || verification.status !== "passed") {
          throw state("Candidate acceptance requires exact passed verification");
        }
      }
      if (input.disposition === "discarded" && changed) {
        throw state("Only an unchanged candidate may be discarded");
      }
      if (measurement) {
        if (input.measurementId !== measurement.measurementId) {
          throw state("Pending candidate measurement requires its exact disposition evidence");
        }
      } else if (input.measurementId !== undefined) {
        throw state("Candidate disposition names an unavailable measurement");
      }
      if (input.operationId) {
        const operation = this.requireOperation(input.operationId);
        const expectedKind = input.disposition === "accepted" ? "accept" : input.disposition === "rejected" ? "reject" : undefined;
        if (!expectedKind || operation.kind !== expectedKind || operation.status !== "completed") {
          throw state(`Candidate ${input.disposition} disposition has an invalid operation`);
        }
      } else if (input.disposition === "accepted" || input.disposition === "rejected") {
        throw state(`Candidate ${input.disposition} disposition requires its durable operation`);
      }
      const reason = "reason" in input ? input.reason : undefined;
      const authorityHash = stableHash(candidateDispositionSemantic(
        candidate,
        input.disposition,
        reason,
        verification,
        measurement,
      ));
      this.database.prepare(`
        INSERT INTO candidate_dispositions(
          candidate_id, run_id, operation_id, disposition, authority_hash,
          verification_id, measurement_id, reason_json, disposed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        candidate.candidateId, run.runId, input.operationId ?? null, input.disposition, authorityHash,
        verification?.verificationId ?? null, measurement?.measurementId ?? null,
        reason ? json(reason) : null, input.at,
      );
      if (measurement) {
        this.database.prepare(`
          UPDATE candidate_measurements SET status = ?, finalized_at = ?
          WHERE measurement_id = ? AND status = 'pending'
        `).run(input.disposition === "accepted" ? "accepted" : "rejected", input.at, measurement.measurementId);
        this.finalizeMeasurementMetricState(
          measurement.measurementId,
          input.disposition === "accepted" ? "accepted" : "rejected",
          input.at,
        );
      }
      this.setRunRevisionOnly(run.revision, nextRevision, input.at);
      return {};
    });
    return this.readCandidate(input.candidateId)!;
  }

  recordCandidateApply(
    expectedRevision: number,
    apply: Omit<WorkflowCandidateApplyRecord, "runId">,
  ): WorkflowCandidateRecord {
    assertCandidateApplyRecord(apply);
    const existing = this.readCandidateApply(apply.candidateId);
    if (existing) {
      const proposed = { ...apply, runId: existing.runId };
      if (stableJson(existing) !== stableJson(proposed)) {
        throw state(`Candidate apply ${apply.candidateId} changed identity`);
      }
      return this.readCandidate(apply.candidateId)!;
    }
    this.mutate(expectedRevision, {
      type: "candidate-applied",
      operationId: apply.operationId,
      candidateId: apply.candidateId,
      payload: { receiptId: apply.receiptId, approvalId: apply.approvalId },
      at: apply.appliedAt,
    }, (run, nextRevision) => {
      const candidate = this.readCandidate(apply.candidateId);
      if (!candidate || candidate.state !== "accepted" || candidate.disposition?.disposition !== "accepted") {
        throw state("Apply requires an accepted, unapplied candidate");
      }
      const operation = this.requireOperation(apply.operationId);
      if (operation.kind !== "apply" || operation.status !== "completed") {
        throw state("Candidate apply receipt requires a completed apply operation");
      }
      const verificationRow = this.database.prepare(`
        SELECT verification.binding_hash FROM candidate_dispositions disposition
        JOIN candidate_verifications verification ON verification.verification_id = disposition.verification_id
        WHERE disposition.candidate_id = ?
      `).get(candidate.candidateId) as SqlRow | undefined;
      if (!verificationRow || requiredString(verificationRow, "binding_hash") !== apply.verificationBindingHash) {
        throw state("Apply verification differs from accepted candidate authority");
      }
      if (apply.authorityHash !== candidateApplyAuthority(candidate, { ...apply, runId: run.runId })) {
        throw state("Apply receipt authority differs from its candidate and approval binding");
      }
      this.database.prepare(`
        INSERT INTO candidate_applies(
          receipt_id, run_id, candidate_id, operation_id, approval_id,
          verification_binding_hash, authority_hash, applied_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        apply.receiptId, run.runId, candidate.candidateId, operation.operationId, apply.approvalId,
        apply.verificationBindingHash, apply.authorityHash, apply.appliedAt,
      );
      this.setRunRevisionOnly(run.revision, nextRevision, apply.appliedAt);
      return {};
    });
    return this.readCandidate(apply.candidateId)!;
  }

  private commitCallTransaction(
    input: CompleteWorkflowCallInput,
    join: CompleteWorkflowStructuralJoinInput | CompleteWorkflowStructuralFailureInput | undefined,
  ): WorkflowOperationRecord {
    this.assertOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.readRun();
      assertExpectedRevision(run.revision, input.expectedRevision);
      const operation = this.requireOperation(input.operationId);
      if (operation.status !== "running" && operation.status !== "waiting") {
        throw state(`Operation ${operation.path} is ${operation.status}`);
      }
      const scope = this.requireScope(operation.scopeId);
      const expectedPrevious = this.expectedPreviousCallKey(scope, operation.cursor);
      if (input.previousCallKey !== expectedPrevious) {
        throw state(`Operation ${operation.path} previous call key differs from its scope chain`);
      }
      if (operation.kind === "apply" && input.replayPolicy !== "never") {
        throw state("Apply calls must never be replayable");
      }
      if (input.outcome === "failure" && input.replayPolicy !== "never") {
        throw state("Failed calls must execute fresh during cross-run replay");
      }
      if (input.replay && (
        input.outcome !== "success"
        || input.replayPolicy === "never"
        || input.replay.sourceRunId === run.runId
        || input.replay.sourceCallKey !== input.callKey
      )) {
        throw state("Cross-run replay evidence does not retain an eligible source call key");
      }
      const terminalValue = input.outcome === "success" ? input.result! : input.failure!;
      const settlement = this.readEffectSettlement(operation.operationId);
      if (settlement && (
        settlement.semanticKey !== input.semanticKey
        || settlement.outcome !== input.outcome
        || settlement.completionAuthority !== input.completionAuthority
        || settlement.replayPolicy !== input.replayPolicy
        || settlement.postWorkspaceCheckpointId !== input.postWorkspaceCheckpointId
        || stableHash(settlement.outcome === "success" ? settlement.result! : settlement.failure!)
          !== stableHash(terminalValue)
      )) {
        throw state(`Operation ${operation.path} differs from its durable effect settlement`);
      }
      const resultHash = stableHash(terminalValue);
      if (join) {
        const expectedJoinKey = workflowStructuralJoinKey({
          previousCallKey: input.previousCallKey,
          operation: workflowOperationIdentity(operation),
          semanticKey: input.semanticKey,
          policyHash: join.policyHash,
          outputOrder: join.outputOrder,
          lanes: join.lanes,
          ...(input.outcome === "success"
            ? { outcome: "success" as const, result: input.result! }
            : { outcome: "failure" as const, failure: input.failure! }),
        });
        if (input.callKey !== expectedJoinKey || join.joinKey !== expectedJoinKey) {
          throw state(`Structural join ${operation.path} has an invalid causal key`);
        }
      } else if (!input.replay) {
        const expectedCallKey = workflowFreshCallKey({
          runId: run.runId,
          previousCallKey: input.previousCallKey,
          operation: workflowOperationIdentity(operation),
          semanticKey: input.semanticKey,
          outcome: input.outcome,
          completionAuthority: input.completionAuthority,
          replayPolicy: input.replayPolicy,
          result: terminalValue,
        });
        if (input.callKey !== expectedCallKey) {
          throw state(`Operation ${operation.path} has an invalid fresh causal call key`);
        }
      }
      this.insertCallEvidence(run.runId, operation, input);
      if (join) this.insertStructuralJoin(operation, join);
      else if (STRUCTURAL_KINDS.has(operation.kind)) {
        throw state(`Structural operation ${operation.path} requires a structural join`);
      }
      if (!join && input.completionAuthority === "structural-join") {
        throw state("Non-structural call cannot use structural-join completion authority");
      }
      if (input.postWorkspaceCheckpointId) {
        const checkpoint = this.database.prepare(
          "SELECT operation_id FROM workspace_checkpoints WHERE checkpoint_id = ?",
        ).get(input.postWorkspaceCheckpointId) as SqlRow | undefined;
        if (!checkpoint || requiredString(checkpoint, "operation_id") !== operation.operationId) {
          throw state("Post-workspace checkpoint is not bound to this operation");
        }
      }
      this.database.prepare(`
        INSERT INTO scope_calls(
          operation_id, run_id, scope_id, cursor, previous_call_key, semantic_key, call_key,
          outcome, completion_authority, replay_policy, result_hash, post_workspace_checkpoint_id,
          source_run_id, source_operation_id, source_scope_path, source_cursor, source_call_key,
          committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        operation.operationId, run.runId, scope.scopeId, operation.cursor, input.previousCallKey,
        input.semanticKey, input.callKey, input.outcome, input.completionAuthority, input.replayPolicy,
        resultHash, input.postWorkspaceCheckpointId ?? null,
        input.replay?.sourceRunId ?? null, input.replay?.sourceOperationId ?? null,
        input.replay?.sourceScopePath ?? null, input.replay?.sourceCursor ?? null,
        input.replay?.sourceCallKey ?? null, input.at,
      );
      const status = input.outcome === "success" ? "completed" : "failed";
      this.database.prepare(`
        UPDATE operations SET status = ?, result_present = ?, result_json = ?, failure_json = ?,
          call_key = ?, updated_at = ?, ended_at = ?
        WHERE operation_id = ? AND status IN ('running', 'waiting')
      `).run(
        status,
        input.outcome === "success" ? 1 : 0,
        input.outcome === "success" ? json(input.result!) : null,
        input.outcome === "failure" ? json(input.failure!) : null,
        input.callKey, input.at, input.at, operation.operationId,
      );
      const nextRevision = input.expectedRevision + 1;
      this.bumpRunRevision(input.expectedRevision, nextRevision, input.at,
        run.currentOperationId === operation.operationId ? null : run.currentOperationId ?? null);
      insertEvent(this.database, {
        runId: run.runId,
        sequence: nextRevision,
        revision: nextRevision,
        type: input.outcome === "success" ? "operation-completed" : "operation-failed",
        operationId: operation.operationId,
        scopeId: scope.scopeId,
        payload: {
          callKey: input.callKey,
          replayPolicy: input.replayPolicy,
          ...(join ? { structuralJoin: join.kind } : {}),
        },
        at: input.at,
      });
      this.database.exec("COMMIT");
      return this.readOperation(operation.operationId)!;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw normalizeConstraint(error);
    }
  }

  private insertStructuralJoin(
    operation: WorkflowOperationRecord,
    input: CompleteWorkflowStructuralJoinInput | CompleteWorkflowStructuralFailureInput,
  ): void {
    if (operation.kind !== input.kind || input.callKey !== input.joinKey) {
      throw state(`Structural join identity differs from operation ${operation.path}`);
    }
    const children = this.listChildScopes(operation.operationId);
    if (children.length !== input.lanes.length) {
      throw state(`Structural join ${operation.path} does not settle every child scope`);
    }
    const byId = new Map(children.map((scope) => [scope.scopeId, scope]));
    const seenKeys = new Set<string>();
    for (let ordinal = 0; ordinal < input.lanes.length; ordinal++) {
      const lane = input.lanes[ordinal]!;
      const child = byId.get(lane.scopeId);
      if (!child || child.status === "active" || child.terminalKey !== lane.terminalKey
        || laneOutcome(child.status) !== lane.outcome) {
        throw state(`Structural join ${operation.path} has invalid lane ${lane.laneKey}`);
      }
      const expectedKey = child.laneKey ?? "candidate";
      if (lane.laneKey !== expectedKey || seenKeys.has(lane.laneKey)) {
        throw state(`Structural join ${operation.path} has duplicate or mismatched lane ${lane.laneKey}`);
      }
      seenKeys.add(lane.laneKey);
    }
    if (input.kind === "candidate" && !("failure" in input)) {
      const row = this.database.prepare(
        "SELECT body_scope_id FROM candidates WHERE operation_id = ?",
      ).get(operation.operationId) as SqlRow | undefined;
      if (!row || input.lanes.length !== 1
        || requiredString(row, "body_scope_id") !== input.lanes[0]!.scopeId) {
        throw state(`Candidate join ${operation.path} requires its exact frozen candidate authority`);
      }
    }
    if (input.outputOrder.length !== input.lanes.length
      || input.outputOrder.some((key, ordinal) => key !== input.lanes[ordinal]!.laneKey)) {
      throw state(`Structural join ${operation.path} output order differs from its lane order`);
    }
    this.database.prepare(`
      INSERT INTO structural_joins(
        operation_id, run_id, scope_id, cursor, kind, previous_call_key,
        policy_hash, output_order_json, join_key, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      operation.operationId, operation.runId, operation.scopeId, operation.cursor, input.kind,
      input.previousCallKey, input.policyHash, json(input.outputOrder), input.joinKey, input.at,
    );
    for (let ordinal = 0; ordinal < input.lanes.length; ordinal++) {
      const lane = input.lanes[ordinal]!;
      this.database.prepare(`
        INSERT INTO structural_join_lanes(
          operation_id, ordinal, lane_key, scope_id, terminal_key, outcome
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        operation.operationId, ordinal, lane.laneKey, lane.scopeId, lane.terminalKey, lane.outcome,
      );
    }
  }

  private insertCallEvidence(
    runId: string,
    operation: WorkflowOperationRecord,
    input: CompleteWorkflowCallInput,
  ): void {
    if (input.workspaceCheckpoint) {
      const checkpoint = input.workspaceCheckpoint;
      if (checkpoint.runId !== runId || checkpoint.operationId !== operation.operationId
        || checkpoint.checkpointId !== input.postWorkspaceCheckpointId) {
        throw state("Atomic workspace checkpoint differs from its completed operation");
      }
      const existing = this.readWorkspaceCheckpoint(checkpoint.checkpointId);
      if (existing) {
        if (stableJson(existing) !== stableJson(checkpoint)) {
          throw state(`Workspace checkpoint ${checkpoint.checkpointId} changed identity`);
        }
      } else {
        this.database.prepare(`
          INSERT INTO workspace_checkpoints(
            checkpoint_id, run_id, operation_id, workspace_id, tree_hash, lineage_hash,
            write_scope_hash, storage_path, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          checkpoint.checkpointId, checkpoint.runId, checkpoint.operationId, checkpoint.workspaceId,
          checkpoint.treeHash, checkpoint.lineageHash ?? null, checkpoint.writeScopeHash ?? null,
          checkpoint.storagePath, checkpoint.createdAt,
        );
      }
    }
    for (const link of input.artifacts ?? []) {
      const artifact = link.artifact;
      if (artifact.runId !== runId) throw state(`Artifact ${artifact.digest} belongs to another run`);
      const existing = this.readArtifact(artifact.digest);
      if (existing) {
        if (!sameArtifactIdentity(existing, artifact)) {
          throw state(`Artifact ${artifact.digest} changed identity`);
        }
      } else {
        this.database.prepare(`
          INSERT INTO artifacts(digest, run_id, kind, media_type, bytes, body_path, metadata_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          artifact.digest, artifact.runId, artifact.kind, artifact.mediaType, artifact.bytes,
          artifact.bodyPath, json(artifact.metadata), artifact.createdAt,
        );
      }
      this.database.prepare(`
        INSERT INTO operation_artifacts(operation_id, artifact_digest, role, name, ordinal)
        VALUES (?, ?, ?, ?, ?)
      `).run(operation.operationId, artifact.digest, link.role, link.name ?? null, link.ordinal);
    }
  }

  private applyControlRequest(
    run: WorkflowRunRecord,
    request: WorkflowControlRequestRecord,
    nextRevision: number,
    at: string,
  ): void {
    if (request.kind === "pause") {
      if (run.status !== "queued" && run.status !== "running") {
        throw state(`Workflow v17 run is ${run.status}, not active`);
      }
      this.updateControlledRun(run, nextRevision, "paused", {
        category: "control", code: "paused", summary: "Paused by the primary session", retryable: true,
      }, at, run.currentOperationId ?? null);
      return;
    }
    if (request.kind === "resume") {
      if (run.status !== "paused") throw state(`Workflow v17 run is ${run.status}, not paused`);
      if (this.listWaitingHumanInteractions().length) {
        throw state("Workflow v17 run has an unresolved human interaction");
      }
      this.updateControlledRun(run, nextRevision, "queued", undefined, at, run.currentOperationId ?? null);
      return;
    }
    if (request.kind === "stop" || request.kind === "stop-effect") {
      if (TERMINAL_RUN_STATUSES.has(run.status)) throw state(`Workflow v17 run is already ${run.status}`);
      if (request.kind === "stop-effect") {
        if (!request.targetId) throw state("Workflow v17 stop-effect request lacks an operation");
        const operation = this.requireOperation(request.targetId);
        if (!new Set(["running", "waiting"]).has(operation.status)) {
          throw state(`Workflow v17 operation ${operation.path} is ${operation.status}, not active`);
        }
      }
      const reason = {
        category: "control",
        code: request.kind,
        summary: request.kind === "stop" ? "Stopped by the primary session" : "Stopped with its selected active effect",
        retryable: false,
        ...(request.targetId ? { operationId: request.targetId } : {}),
      } as JsonObject;
      this.terminateCandidates(run.runId, "stopped", reason, at);
      this.terminateActiveExecution(run.runId, "stopped", reason, at);
      this.updateControlledRun(run, nextRevision, "stopped", reason, at, null);
      return;
    }
    if (!request.targetId || !request.challengeHash) {
      throw state(`Workflow v17 ${request.kind} request lacks target authority`);
    }
    const interaction = this.readHumanInteraction(request.targetId);
    if (!interaction || interaction.status !== "waiting" || interaction.challengeHash !== request.challengeHash) {
      throw state("Workflow v17 human interaction challenge is stale");
    }
    const expectedKind = request.kind === "ask-response" ? "ask" : "apply";
    if (interaction.kind !== expectedKind) throw state("Workflow v17 human interaction kind differs from its control request");
    if (request.kind === "ask-response" && request.value === undefined) {
      throw state("Workflow v17 ask response is missing its value");
    }
    if (request.kind === "ask-response") {
      const responseSchema = interaction.request.responseSchema;
      if (!responseSchema || typeof responseSchema !== "object" || Array.isArray(responseSchema)) {
        throw corrupt("Workflow v17 ask interaction lost its response schema");
      }
      let validate: ReturnType<Ajv["compile"]>;
      try { validate = new Ajv({ strict: true, allErrors: true }).compile(responseSchema as JsonSchema); }
      catch { throw corrupt("Workflow v17 ask interaction has an invalid response schema"); }
      if (!validate(request.value)) {
        throw state(`Workflow v17 ask response does not match its reviewed schema: ${new Ajv().errorsText(validate.errors).slice(0, 1_000)}`);
      }
    }
    const status = request.kind === "ask-response"
      ? "answered" : request.kind === "apply-approve" ? "approved" : "rejected";
    assertOneChange(this.database.prepare(`
      UPDATE human_interactions SET status = ?, response_json = ?, resolved_at = ?
      WHERE interaction_id = ? AND status = 'waiting'
    `).run(
      status,
      request.kind === "ask-response" ? json(request.value!) : null,
      at,
      interaction.interactionId,
    ), "workflow v17 human interaction resolution");
    assertOneChange(this.database.prepare(`
      UPDATE operations SET status = 'running', updated_at = ?
      WHERE operation_id = ? AND status = 'waiting'
    `).run(at, interaction.operationId), "workflow v17 resumed human operation");
    this.database.prepare(`
      UPDATE attempts SET status = 'running', updated_at = ?
      WHERE operation_id = ? AND status = 'waiting'
    `).run(at, interaction.operationId);
    this.updateControlledRun(run, nextRevision, "paused", {
      category: "human",
      code: `${interaction.kind}-${status}`,
      summary: interaction.kind === "ask"
        ? "Human response committed; workflow is ready to resume"
        : `Apply ${status}; workflow is ready to resume`,
      retryable: true,
      interactionId: interaction.interactionId,
    }, at, interaction.operationId);
  }

  private updateControlledRun(
    run: WorkflowRunRecord,
    nextRevision: number,
    status: WorkflowRunStatus,
    reason: JsonObject | undefined,
    at: string,
    currentOperationId: string | null,
  ): void {
    assertOneChange(this.database.prepare(`
      UPDATE runs SET status = ?, reason_json = ?, current_operation_id = ?, revision = ?,
        updated_at = ?, ended_at = CASE WHEN ? = 'stopped' THEN ? ELSE NULL END
      WHERE singleton = 1 AND revision = ?
    `).run(
      status, reason ? json(reason) : null, currentOperationId, nextRevision,
      at, status, at, run.revision,
    ), "workflow v17 controlled run transition");
  }

  private mutate(
    expectedRevision: number,
    event: Omit<WorkflowRunEvent, "runId" | "sequence" | "revision">,
    body: (run: WorkflowRunRecord, nextRevision: number) => JsonObject,
  ): void {
    assertPositiveRevision(expectedRevision);
    assertIsoDate(event.at, "workflow v17 event time");
    assertEventType(event.type);
    this.assertOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.readRun();
      assertExpectedRevision(run.revision, expectedRevision);
      const nextRevision = expectedRevision + 1;
      const payload = body(run, nextRevision);
      insertEvent(this.database, {
        runId: run.runId,
        sequence: nextRevision,
        revision: nextRevision,
        type: event.type,
        ...(event.operationId ? { operationId: event.operationId } : {}),
        ...(event.scopeId ? { scopeId: event.scopeId } : {}),
        ...(event.candidateId ? { candidateId: event.candidateId } : {}),
        payload: { ...event.payload, ...payload },
        at: event.at,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw normalizeConstraint(error);
    }
  }

  private setRunRevisionOnly(expected: number, next: number, at: string): void {
    this.bumpRunRevision(expected, next, at, this.readRun().currentOperationId ?? null);
  }

  private bumpRunRevision(
    expected: number,
    next: number,
    at: string,
    currentOperationId: string | null,
  ): void {
    const changed = this.database.prepare(`
      UPDATE runs SET revision = ?, updated_at = ?, current_operation_id = ?
      WHERE singleton = 1 AND revision = ?
    `).run(next, at, currentOperationId, expected);
    assertOneChange(changed, "workflow v17 run revision");
  }

  private finishSuccessfulCandidates(runId: string, at: string): number {
    const pending = (this.database.prepare(`
      SELECT candidate.candidate_id,
        (SELECT count(*) FROM candidate_changed_paths path WHERE path.candidate_id = candidate.candidate_id) AS changed
      FROM candidates candidate
      LEFT JOIN candidate_dispositions disposition ON disposition.candidate_id = candidate.candidate_id
      WHERE candidate.run_id = ? AND disposition.candidate_id IS NULL
      ORDER BY candidate.frozen_at, candidate.candidate_id
    `).all(runId) as SqlRow[]);
    const changed = pending.filter((row) => requiredNumber(row, "changed") > 0);
    if (changed.length > 0) {
      throw state(`Successful workflow completion has ${changed.length} undisposed nonempty candidate(s)`);
    }
    for (const row of pending) {
      const candidateId = requiredString(row, "candidate_id");
      this.insertSystemDisposition(candidateId, "discarded", {
        category: "workflow",
        code: "unchanged-candidate",
        summary: "Unchanged candidate discarded at successful workflow completion",
        retryable: false,
      }, at);
    }
    const mutable = requiredNumber(this.database.prepare(
      "SELECT count(*) AS value FROM candidate_workspaces WHERE run_id = ? AND state = 'mutable'",
    ).get(runId) as SqlRow, "value");
    if (mutable > 0) throw state("Successful workflow completion has mutable candidate workspaces");
    return pending.length;
  }

  private terminateCandidates(runId: string, status: "failed" | "stopped", reason: JsonObject, at: string): number {
    const mutable = this.database.prepare(`
      SELECT workspace_id FROM candidate_workspaces WHERE run_id = ? AND state = 'mutable' ORDER BY workspace_id
    `).all(runId) as SqlRow[];
    for (const row of mutable) {
      this.database.prepare(`
        UPDATE candidate_workspaces SET state = 'abandoned', failure_json = ?, ended_at = ?
        WHERE workspace_id = ? AND state = 'mutable'
      `).run(json(reason), at, requiredString(row, "workspace_id"));
    }
    const pending = this.database.prepare(`
      SELECT candidate.candidate_id FROM candidates candidate
      LEFT JOIN candidate_dispositions disposition ON disposition.candidate_id = candidate.candidate_id
      WHERE candidate.run_id = ? AND disposition.candidate_id IS NULL
      ORDER BY candidate.frozen_at, candidate.candidate_id
    `).all(runId) as SqlRow[];
    for (const row of pending) {
      this.insertSystemDisposition(requiredString(row, "candidate_id"), "abandoned", {
        ...reason,
        termination: status,
      }, at);
    }
    return mutable.length + pending.length;
  }

  private insertSystemDisposition(
    candidateId: string,
    disposition: "discarded" | "abandoned",
    reason: JsonObject,
    at: string,
  ): void {
    const candidate = this.readCandidate(candidateId);
    if (!candidate || candidate.state !== "pending") throw state(`Candidate ${candidateId} is not pending`);
    const measurement = this.readCandidateMeasurement(candidateId);
    const semantic = candidateDispositionSemantic(candidate, disposition, reason, undefined, measurement);
    this.database.prepare(`
      INSERT INTO candidate_dispositions(
        candidate_id, run_id, disposition, authority_hash, measurement_id, reason_json, disposed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidateId, candidate.runId, disposition, stableHash(semantic),
      measurement?.measurementId ?? null, json(reason), at,
    );
    if (measurement) {
      this.database.prepare(`
        UPDATE candidate_measurements SET status = 'rejected', finalized_at = ?
        WHERE measurement_id = ? AND status = 'pending'
      `).run(at, measurement.measurementId);
      this.finalizeMeasurementMetricState(measurement.measurementId, "rejected", at);
    }
  }

  private finalizeMeasurementMetricState(
    measurementId: string,
    disposition: "accepted" | "rejected",
    at: string,
  ): void {
    const measurement = this.readMeasurement(measurementId);
    if (!measurement) return; // Pre-metric test evidence has no full measurement cohort.
    const metricSet = this.readMetricSet(measurement.metricSetId);
    if (!metricSet) throw state(`Workflow v17 measurement ${measurementId} lost its metric set`);
    const states = applyMetricDispositionToSnapshot(metricSet.states, measurement.delta, disposition);
    this.database.prepare(`
      UPDATE metric_sets SET states_json = ?, state_hash = ?, updated_at = ? WHERE metric_set_id = ?
    `).run(json(states as unknown as JsonValue), stableHash(states), at, metricSet.metricSetId);
  }

  private terminateActiveExecution(
    runId: string,
    status: "failed" | "stopped",
    reason: JsonObject | undefined,
    at: string,
  ): void {
    this.database.prepare(`
      UPDATE operations SET status = ?, updated_at = ?, ended_at = ?
      WHERE run_id = ? AND status IN ('running', 'waiting')
    `).run(status === "failed" ? "cancelled" : "stopped", at, at, runId);
    this.database.prepare(`
      UPDATE attempts SET status = ?, updated_at = ?, ended_at = ?
      WHERE run_id = ? AND status IN ('running', 'waiting')
    `).run(status === "failed" ? "cancelled" : "stopped", at, at, runId);
    const scopes = this.database.prepare(
      "SELECT scope_id, seed_key FROM scopes WHERE run_id = ? AND status = 'active' ORDER BY path",
    ).all(runId) as SqlRow[];
    for (const row of scopes) {
      const scopeId = requiredString(row, "scope_id");
      const last = this.database.prepare(
        "SELECT call_key FROM scope_calls WHERE scope_id = ? ORDER BY cursor DESC LIMIT 1",
      ).get(scopeId) as SqlRow | undefined;
      const previous = last ? requiredString(last, "call_key") : requiredString(row, "seed_key");
      const failure = reason ?? {
        category: "workflow",
        code: status,
        summary: `Workflow ${status}`,
        retryable: false,
      };
      const terminal = stableHash({ formatVersion: 1, kind: "scope-termination", previous, status, failure });
      this.database.prepare(`
        UPDATE scopes SET status = 'cancelled', terminal_key = ?, failure_json = ?, ended_at = ?
        WHERE scope_id = ? AND status = 'active'
      `).run(terminal, json(failure), at, scopeId);
    }
  }

  private requireScope(scopeId: string): WorkflowScopeRecord {
    const scope = this.readScope(scopeId);
    if (!scope) throw state(`Missing workflow v17 scope ${scopeId}`);
    return scope;
  }

  private requireOperation(operationId: string): WorkflowOperationRecord {
    const operation = this.readOperation(operationId);
    if (!operation) throw state(`Missing workflow v17 operation ${operationId}`);
    return operation;
  }

  private requireArtifact(digest: string): WorkflowArtifactRecord {
    const artifact = this.readArtifact(digest);
    if (!artifact) throw state(`Missing workflow v17 artifact ${digest}`);
    return artifact;
  }

  private requireCandidateWorkspace(workspaceId: string): WorkflowCandidateWorkspaceRecord {
    const workspace = this.readCandidateWorkspace(workspaceId);
    if (!workspace) throw state(`Missing workflow v17 candidate workspace ${workspaceId}`);
    return workspace;
  }

  private requirePendingCandidate(candidateId: string): WorkflowCandidateRecord {
    const candidate = this.readCandidate(candidateId);
    if (!candidate) throw state(`Missing workflow v17 candidate ${candidateId}`);
    if (candidate.state !== "pending") throw state(`Candidate ${candidateId} is ${candidate.state}`);
    return candidate;
  }

  private assertBasicWritableIdentity(): void {
    const run = this.readRun();
    const root = this.readScope(run.rootScopeId);
    if (!root || root.kind !== "root" || root.path !== "run") throw corrupt("Workflow v17 database root is corrupt");
  }
}

function insertInitialRun(
  database: DatabaseSync,
  options: CreateWorkflowRunDatabaseOptions,
  rootScopeId: string,
): void {
  const snapshot = options.snapshot;
  database.prepare(`
    INSERT INTO runs(
      singleton, run_id, revision, workflow_id, workflow_name, workflow_source_hash,
      workflow_definition_hash, invocation_snapshot_hash, runtime_api_hash, invocation_hash,
      resources_hash, project_snapshot_hash, route_snapshot_hash, static_resources_hash, context_identity_hash,
      launch_authority, exposure, policy_hash, project_trusted, status,
      safety_concurrency, safety_maximum_agent_launches, safety_memory_bytes, safety_tasks,
      safety_cpu_quota_percent, safety_cpu_weight, safety_output_bytes, safety_command_timeout_ms,
      root_scope_id, result_present, created_at, updated_at
    ) VALUES (1, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    options.runId,
    snapshot.workflowId,
    snapshot.name,
    snapshot.sourceHash,
    snapshot.definitionHash,
    snapshot.snapshotHash,
    snapshot.runtimeApiHash,
    workflowInvocationIdentityHash(snapshot),
    snapshot.resourcesHash,
    options.projectSnapshotHash,
    options.routeSnapshotHash,
    options.staticResourcesHash,
    options.contextIdentityHash,
    snapshot.launch.authority,
    snapshot.exposure,
    snapshot.launch.policyHash,
    snapshot.launch.projectTrusted ? 1 : 0,
    options.safety.concurrency,
    options.safety.maximumAgentLaunches,
    options.safety.memoryBytes,
    options.safety.tasks,
    options.safety.cpuQuotaPercent,
    options.safety.cpuWeight,
    options.safety.outputBytes,
    options.safety.commandTimeoutMs,
    rootScopeId,
    options.createdAt,
    options.createdAt,
  );
  const capabilities = [...snapshot.review.capabilities].sort();
  for (let ordinal = 0; ordinal < capabilities.length; ordinal++) {
    database.prepare(`
      INSERT INTO run_capabilities(run_id, ordinal, capability) VALUES (?, ?, ?)
    `).run(options.runId, ordinal, capabilities[ordinal]!);
  }
}

function insertInitialRootScope(
  database: DatabaseSync,
  options: CreateWorkflowRunDatabaseOptions,
  rootScopeId: string,
): void {
  database.prepare(`
    INSERT INTO scopes(
      scope_id, run_id, path, kind, sibling_ordinal, seed_key, status, created_at
    ) VALUES (?, ?, 'run', 'root', 0, ?, 'active', ?)
  `).run(rootScopeId, options.runId, WORKFLOW_ROOT_SCOPE_SEED, options.createdAt);
}

function insertInitialResources(
  database: DatabaseSync,
  options: CreateWorkflowRunDatabaseOptions,
): void {
  for (const resource of options.snapshot.resources) {
    const resourceId = workflowResourceId(resource.inputPath, resource.bindingHash);
    database.prepare(`
      INSERT INTO invocation_resources(
        resource_id, run_id, kind, input_path, selector, snapshot_hash, binding_hash, resource_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      resourceId,
      options.runId,
      resource.identity.kind,
      resource.inputPath,
      resource.identity.selector,
      resource.identity.snapshotHash,
      resource.bindingHash,
      json(resource as unknown as JsonValue),
    );
  }
}

function insertEvent(database: DatabaseSync, event: WorkflowRunEvent): void {
  assertEvent(event);
  database.prepare(`
    INSERT INTO events(
      run_id, sequence, revision, type, operation_id, scope_id, candidate_id, payload_json, at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.runId,
    event.sequence,
    event.revision,
    event.type,
    event.operationId ?? null,
    event.scopeId ?? null,
    event.candidateId ?? null,
    json(event.payload),
    event.at,
  );
}

function resourceFromRow(row: SqlRow): WorkflowInvocationResourceRecord {
  const resource = (jsonColumnRequired<JsonValue>(row, "resource_json") as unknown) as WorkflowInvocationResourceRecord["resource"];
  return {
    resourceId: requiredString(row, "resource_id"),
    runId: requiredString(row, "run_id"),
    kind: requiredString(row, "kind") as "measurement-profile",
    inputPath: requiredString(row, "input_path"),
    selector: requiredString(row, "selector"),
    snapshotHash: requiredString(row, "snapshot_hash"),
    bindingHash: requiredString(row, "binding_hash"),
    resource,
  };
}

function eventFromRow(row: SqlRow): WorkflowRunEvent {
  return {
    runId: requiredString(row, "run_id"),
    sequence: requiredNumber(row, "sequence"),
    revision: requiredNumber(row, "revision"),
    type: requiredString(row, "type"),
    ...(optionalString(row, "operation_id") ? { operationId: optionalString(row, "operation_id")! } : {}),
    ...(optionalString(row, "scope_id") ? { scopeId: optionalString(row, "scope_id")! } : {}),
    ...(optionalString(row, "candidate_id") ? { candidateId: optionalString(row, "candidate_id")! } : {}),
    payload: jsonColumnRequired<JsonObject>(row, "payload_json"),
    at: requiredString(row, "at"),
  };
}

function humanInteractionFromRow(row: SqlRow): WorkflowHumanInteractionRecord {
  const response = jsonColumn<JsonValue>(row, "response_json");
  return {
    interactionId: requiredString(row, "interaction_id"),
    runId: requiredString(row, "run_id"),
    operationId: requiredString(row, "operation_id"),
    kind: requiredString(row, "kind") as WorkflowHumanInteractionRecord["kind"],
    status: requiredString(row, "status") as WorkflowHumanInteractionRecord["status"],
    challengeHash: requiredString(row, "challenge_hash"),
    request: jsonColumnRequired<JsonObject>(row, "request_json"),
    ...(response !== undefined ? { response } : {}),
    requestedAt: requiredString(row, "requested_at"),
    ...(optionalString(row, "resolved_at") ? { resolvedAt: optionalString(row, "resolved_at")! } : {}),
  };
}

function controlRequestFromRow(row: SqlRow): WorkflowControlRequestRecord {
  const value = jsonColumn<JsonValue>(row, "value_json");
  const reason = jsonColumn<JsonObject>(row, "reason_json");
  return {
    requestId: requiredString(row, "request_id"),
    runId: requiredString(row, "run_id"),
    kind: requiredString(row, "kind") as WorkflowControlRequestRecord["kind"],
    ...(optionalString(row, "target_id") ? { targetId: optionalString(row, "target_id")! } : {}),
    ...(optionalString(row, "challenge_hash") ? { challengeHash: optionalString(row, "challenge_hash")! } : {}),
    ...(value !== undefined ? { value } : {}),
    actor: requiredString(row, "actor"),
    status: requiredString(row, "status") as WorkflowControlRequestRecord["status"],
    ...(reason ? { reason } : {}),
    requestedAt: requiredString(row, "requested_at"),
    ...(optionalString(row, "processed_at") ? { processedAt: optionalString(row, "processed_at")! } : {}),
  };
}

function scopeFromRow(row: SqlRow): WorkflowScopeRecord {
  const failure = jsonColumn<JsonObject>(row, "failure_json");
  return {
    scopeId: requiredString(row, "scope_id"),
    runId: requiredString(row, "run_id"),
    ...(optionalString(row, "parent_scope_id") ? { parentScopeId: optionalString(row, "parent_scope_id")! } : {}),
    ...(optionalString(row, "owner_operation_id") ? { ownerOperationId: optionalString(row, "owner_operation_id")! } : {}),
    path: requiredString(row, "path"),
    kind: requiredString(row, "kind") as WorkflowScopeRecord["kind"],
    siblingOrdinal: requiredNumber(row, "sibling_ordinal"),
    ...(optionalString(row, "lane_key") ? { laneKey: optionalString(row, "lane_key")! } : {}),
    seedKey: requiredString(row, "seed_key"),
    status: requiredString(row, "status") as WorkflowScopeRecord["status"],
    ...(optionalString(row, "terminal_key") ? { terminalKey: optionalString(row, "terminal_key")! } : {}),
    ...(failure ? { failure } : {}),
    createdAt: requiredString(row, "created_at"),
    ...(optionalString(row, "ended_at") ? { endedAt: optionalString(row, "ended_at")! } : {}),
  };
}

function operationFromRow(row: SqlRow): WorkflowOperationRecord {
  const result = requiredNumber(row, "result_present") === 1
    ? jsonColumnRequired<JsonValue>(row, "result_json")
    : undefined;
  const failure = jsonColumn<JsonObject>(row, "failure_json");
  return {
    operationId: requiredString(row, "operation_id"),
    runId: requiredString(row, "run_id"),
    scopeId: requiredString(row, "scope_id"),
    cursor: requiredNumber(row, "cursor"),
    path: requiredString(row, "path"),
    kind: requiredString(row, "kind") as WorkflowOperationKind,
    ordinal: requiredNumber(row, "ordinal"),
    sourceSite: requiredString(row, "source_site"),
    ...(optionalString(row, "descriptor_source_site") ? {
      descriptorSourceSite: optionalString(row, "descriptor_source_site")!,
    } : {}),
    ...(optionalString(row, "title") ? { title: optionalString(row, "title")! } : {}),
    semanticInputHash: requiredString(row, "semantic_input_hash"),
    status: requiredString(row, "status") as WorkflowOperationRecord["status"],
    ...(result !== undefined ? { result } : {}),
    ...(failure ? { failure } : {}),
    ...(optionalString(row, "call_key") ? { callKey: optionalString(row, "call_key")! } : {}),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
    ...(optionalString(row, "ended_at") ? { endedAt: optionalString(row, "ended_at")! } : {}),
  };
}

function scopeCallFromRow(row: SqlRow): WorkflowScopeCallRecord {
  const sourceRunId = optionalString(row, "source_run_id");
  return {
    operationId: requiredString(row, "operation_id"),
    runId: requiredString(row, "run_id"),
    scopeId: requiredString(row, "scope_id"),
    cursor: requiredNumber(row, "cursor"),
    previousCallKey: requiredString(row, "previous_call_key"),
    semanticKey: requiredString(row, "semantic_key"),
    callKey: requiredString(row, "call_key"),
    outcome: requiredString(row, "outcome") as WorkflowScopeCallRecord["outcome"],
    completionAuthority: requiredString(row, "completion_authority") as WorkflowScopeCallRecord["completionAuthority"],
    replayPolicy: requiredString(row, "replay_policy") as WorkflowScopeCallRecord["replayPolicy"],
    resultHash: requiredString(row, "result_hash"),
    ...(optionalString(row, "post_workspace_checkpoint_id") ? {
      postWorkspaceCheckpointId: optionalString(row, "post_workspace_checkpoint_id")!,
    } : {}),
    ...(sourceRunId ? {
      replay: {
        sourceRunId,
        sourceOperationId: requiredString(row, "source_operation_id"),
        sourceScopePath: requiredString(row, "source_scope_path"),
        sourceCursor: requiredNumber(row, "source_cursor"),
        sourceCallKey: requiredString(row, "source_call_key"),
      },
    } : {}),
    committedAt: requiredString(row, "committed_at"),
  };
}

function effectSettlementFromRow(row: SqlRow): WorkflowEffectSettlementRecord {
  const outcome = requiredString(row, "outcome") as WorkflowEffectSettlementRecord["outcome"];
  return {
    operationId: requiredString(row, "operation_id"),
    runId: requiredString(row, "run_id"),
    semanticKey: requiredString(row, "semantic_key"),
    outcome,
    completionAuthority: requiredString(row, "completion_authority") as WorkflowEffectSettlementRecord["completionAuthority"],
    replayPolicy: requiredString(row, "replay_policy") as WorkflowEffectSettlementRecord["replayPolicy"],
    ...(outcome === "success" ? { result: jsonColumnRequired<JsonValue>(row, "result_json") } : {}),
    ...(outcome === "failure" ? { failure: jsonColumnRequired<JsonObject>(row, "failure_json") } : {}),
    ...(optionalString(row, "post_workspace_checkpoint_id") ? {
      postWorkspaceCheckpointId: optionalString(row, "post_workspace_checkpoint_id")!,
    } : {}),
    settledAt: requiredString(row, "settled_at"),
  };
}

function structuralJoinFromRow(
  row: SqlRow,
  lanes: WorkflowStructuralJoinLaneRecord[],
): WorkflowStructuralJoinRecord {
  return {
    operationId: requiredString(row, "operation_id"),
    runId: requiredString(row, "run_id"),
    scopeId: requiredString(row, "scope_id"),
    cursor: requiredNumber(row, "cursor"),
    kind: requiredString(row, "kind") as WorkflowStructuralJoinRecord["kind"],
    previousCallKey: requiredString(row, "previous_call_key"),
    policyHash: requiredString(row, "policy_hash"),
    outputOrder: jsonColumnRequired<string[]>(row, "output_order_json"),
    joinKey: requiredString(row, "join_key"),
    lanes,
    committedAt: requiredString(row, "committed_at"),
  };
}

function joinLaneFromRow(row: SqlRow): WorkflowStructuralJoinLaneRecord {
  return {
    ordinal: requiredNumber(row, "ordinal"),
    laneKey: requiredString(row, "lane_key"),
    scopeId: requiredString(row, "scope_id"),
    terminalKey: requiredString(row, "terminal_key"),
    outcome: requiredString(row, "outcome") as WorkflowStructuralJoinLaneRecord["outcome"],
  };
}

function artifactFromRow(row: SqlRow): WorkflowArtifactRecord {
  return {
    digest: requiredString(row, "digest"),
    runId: requiredString(row, "run_id"),
    kind: requiredString(row, "kind"),
    mediaType: requiredString(row, "media_type") as WorkflowArtifactRecord["mediaType"],
    bytes: requiredNumber(row, "bytes"),
    bodyPath: requiredString(row, "body_path"),
    metadata: jsonColumnRequired<JsonObject>(row, "metadata_json"),
    createdAt: requiredString(row, "created_at"),
  };
}

function attemptFromRow(row: SqlRow): WorkflowAttemptRecord {
  return {
    attemptId: requiredString(row, "attempt_id"),
    runId: requiredString(row, "run_id"),
    operationId: requiredString(row, "operation_id"),
    number: requiredNumber(row, "number"),
    effect: requiredString(row, "effect") as WorkflowAttemptRecord["effect"],
    ...(optionalString(row, "execution_id") ? { executionId: optionalString(row, "execution_id")! } : {}),
    status: requiredString(row, "status") as WorkflowAttemptRecord["status"],
    usage: jsonColumnRequired<JsonObject>(row, "usage_json"),
    ...(optionalString(row, "resources_json") ? {
      resources: jsonColumnRequired<JsonObject>(row, "resources_json"),
    } : {}),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
    ...(optionalString(row, "ended_at") ? { endedAt: optionalString(row, "ended_at")! } : {}),
  };
}

function workspaceCheckpointFromRow(row: SqlRow): WorkflowWorkspaceCheckpointRecord {
  return {
    checkpointId: requiredString(row, "checkpoint_id"),
    runId: requiredString(row, "run_id"),
    operationId: requiredString(row, "operation_id"),
    workspaceId: requiredString(row, "workspace_id"),
    treeHash: requiredString(row, "tree_hash"),
    ...(optionalString(row, "lineage_hash") ? { lineageHash: optionalString(row, "lineage_hash")! } : {}),
    ...(optionalString(row, "write_scope_hash") ? { writeScopeHash: optionalString(row, "write_scope_hash")! } : {}),
    storagePath: requiredString(row, "storage_path"),
    createdAt: requiredString(row, "created_at"),
  };
}

function candidateWorkspaceFromRow(row: SqlRow): WorkflowCandidateWorkspaceRecord {
  const failure = jsonColumn<JsonObject>(row, "failure_json");
  return {
    workspaceId: requiredString(row, "workspace_id"),
    runId: requiredString(row, "run_id"),
    candidateOperationId: requiredString(row, "candidate_operation_id"),
    bodyScopeId: requiredString(row, "body_scope_id"),
    ...(optionalString(row, "parent_candidate_id") ? { parentCandidateId: optionalString(row, "parent_candidate_id")! } : {}),
    state: requiredString(row, "state") as WorkflowCandidateWorkspaceRecord["state"],
    initialTreeHash: requiredString(row, "initial_tree_hash"),
    baseLineageHash: requiredString(row, "base_lineage_hash"),
    writeScope: jsonColumnRequired<JsonValue>(row, "write_scope_json"),
    writeScopeHash: requiredString(row, "write_scope_hash"),
    rootPath: requiredString(row, "root_path"),
    ...(failure ? { failure } : {}),
    createdAt: requiredString(row, "created_at"),
    ...(optionalString(row, "ended_at") ? { endedAt: optionalString(row, "ended_at")! } : {}),
  };
}

function candidateDispositionFromRow(row: SqlRow): WorkflowCandidateDispositionRecord {
  const reason = jsonColumn<JsonObject>(row, "reason_json");
  return {
    candidateId: requiredString(row, "candidate_id"),
    runId: requiredString(row, "run_id"),
    ...(optionalString(row, "operation_id") ? { operationId: optionalString(row, "operation_id")! } : {}),
    disposition: requiredString(row, "disposition") as WorkflowCandidateDispositionRecord["disposition"],
    authorityHash: requiredString(row, "authority_hash"),
    ...(optionalString(row, "verification_id") ? { verificationId: optionalString(row, "verification_id")! } : {}),
    ...(optionalString(row, "measurement_id") ? { measurementId: optionalString(row, "measurement_id")! } : {}),
    ...(reason ? { reason } : {}),
    disposedAt: requiredString(row, "disposed_at"),
  };
}

function candidateMeasurementFromRow(row: SqlRow): WorkflowCandidateMeasurementRecord {
  return {
    measurementId: requiredString(row, "measurement_id"),
    runId: requiredString(row, "run_id"),
    candidateId: requiredString(row, "candidate_id"),
    operationId: requiredString(row, "operation_id"),
    bindingHash: requiredString(row, "binding_hash"),
    status: requiredString(row, "status") as WorkflowCandidateMeasurementRecord["status"],
    createdAt: requiredString(row, "created_at"),
    ...(optionalString(row, "finalized_at") ? { finalizedAt: optionalString(row, "finalized_at")! } : {}),
  };
}

function metricSetFromRow(row: SqlRow): WorkflowMetricSetRecord {
  return {
    metricSetId: requiredString(row, "metric_set_id"),
    runId: requiredString(row, "run_id"),
    authorityId: requiredString(row, "authority_id"),
    sourceSite: requiredString(row, "source_site"),
    occurrence: requiredNumber(row, "occurrence"),
    policy: jsonColumnRequired<JsonObject>(row, "policy_json"),
    policyHash: requiredString(row, "policy_hash"),
    sampling: jsonColumnRequired<JsonObject>(row, "sampling_json"),
    samplingHash: requiredString(row, "sampling_hash"),
    states: jsonColumnRequired<JsonValue>(row, "states_json") as unknown as PersistedMetricState[],
    stateHash: requiredString(row, "state_hash"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function measurementFromRow(row: SqlRow): WorkflowMeasurementRecord {
  return {
    measurementId: requiredString(row, "measurement_id"),
    runId: requiredString(row, "run_id"),
    operationId: requiredString(row, "operation_id"),
    metricSetId: requiredString(row, "metric_set_id"),
    profile: jsonColumnRequired<JsonValue>(row, "profile_json") as unknown as WorkflowMeasurementRecord["profile"],
    profileHash: requiredString(row, "profile_hash"),
    commandHash: requiredString(row, "command_hash"),
    environment: jsonColumnRequired<JsonObject>(row, "environment_json"),
    environmentHash: requiredString(row, "environment_hash"),
    workspaceTreeHash: requiredString(row, "workspace_tree_hash"),
    ...(optionalString(row, "candidate_id") ? { candidateId: optionalString(row, "candidate_id")! } : {}),
    bindingHash: requiredString(row, "binding_hash"),
    delta: jsonColumnRequired<JsonValue>(row, "delta_json") as unknown as WorkflowMeasurementRecord["delta"],
    observations: jsonColumnRequired<JsonObject>(row, "observations_json"),
    artifactDigest: requiredString(row, "artifact_digest"),
    ...(optionalString(row, "diagnostics_artifact_digest") ? {
      diagnosticsArtifactDigest: optionalString(row, "diagnostics_artifact_digest")!,
    } : {}),
    samples: jsonColumnRequired<JsonValue>(row, "samples_json") as unknown as WorkflowMeasurementSampleRecord[],
    createdAt: requiredString(row, "created_at"),
  };
}

function experimentFromRow(row: SqlRow): WorkflowExperimentRecord {
  return {
    experimentId: requiredString(row, "experiment_id"),
    runId: requiredString(row, "run_id"),
    operationId: requiredString(row, "operation_id"),
    candidateId: requiredString(row, "candidate_id"),
    measurementId: requiredString(row, "measurement_id"),
    disposition: requiredString(row, "disposition") as WorkflowExperimentRecord["disposition"],
    learned: requiredString(row, "learned"),
    bindingHash: requiredString(row, "binding_hash"),
    artifactDigest: requiredString(row, "artifact_digest"),
    createdAt: requiredString(row, "created_at"),
  };
}

function candidateVerificationFromRow(row: SqlRow): WorkflowCandidateVerificationRecord {
  return {
    verificationId: requiredString(row, "verification_id"),
    runId: requiredString(row, "run_id"),
    candidateId: requiredString(row, "candidate_id"),
    operationId: requiredString(row, "operation_id"),
    status: requiredString(row, "status") as WorkflowCandidateVerificationRecord["status"],
    bindingHash: requiredString(row, "binding_hash"),
    evidenceHash: requiredString(row, "evidence_hash"),
    artifactDigest: requiredString(row, "artifact_digest"),
    createdAt: requiredString(row, "created_at"),
  };
}

function candidateApplyFromRow(row: SqlRow): WorkflowCandidateApplyRecord {
  return {
    receiptId: requiredString(row, "receipt_id"),
    runId: requiredString(row, "run_id"),
    candidateId: requiredString(row, "candidate_id"),
    operationId: requiredString(row, "operation_id"),
    approvalId: requiredString(row, "approval_id"),
    verificationBindingHash: requiredString(row, "verification_binding_hash"),
    authorityHash: requiredString(row, "authority_hash"),
    appliedAt: requiredString(row, "applied_at"),
  };
}

function candidateDispositionSemantic(
  candidate: WorkflowCandidateRecord,
  disposition: WorkflowCandidateDispositionRecord["disposition"],
  reason: JsonObject | undefined,
  verification: WorkflowCandidateVerificationRecord | undefined,
  measurement: WorkflowCandidateMeasurementRecord | undefined,
): JsonObject {
  return {
    formatVersion: 1,
    candidateId: candidate.candidateId,
    candidateTreeHash: candidate.treeHash,
    candidateLineageHash: candidate.lineageHash,
    candidateWriteScopeHash: candidate.writeScopeHash,
    disposition,
    ...(verification ? {
      verificationId: verification.verificationId,
      verificationBindingHash: verification.bindingHash,
    } : {}),
    ...(measurement ? {
      measurementId: measurement.measurementId,
      measurementBindingHash: measurement.bindingHash,
    } : {}),
    ...(reason ? { reason } : {}),
  };
}

function candidateApplyAuthority(
  candidate: WorkflowCandidateRecord,
  apply: WorkflowCandidateApplyRecord,
): string {
  return stableHash({
    formatVersion: 1,
    candidateId: candidate.candidateId,
    approvalId: apply.approvalId,
    receiptId: apply.receiptId,
    verificationBindingHash: apply.verificationBindingHash,
    changedPaths: candidate.changedPaths,
  });
}

function assertCreateOptions(options: CreateWorkflowRunDatabaseOptions): void {
  assertIdentifier(options.runId, "workflow v17 run id");
  assertWorkflowInvocationSnapshot(options.snapshot);
  if (options.snapshot.runtimeApiHash !== WORKFLOW_RUNTIME_API_HASH) {
    throw new TypeError("Workflow v17 invocation uses another runtime API");
  }
  assertHash(options.projectSnapshotHash, "workflow v17 project snapshot hash");
  assertHash(options.routeSnapshotHash, "workflow v17 route snapshot hash");
  assertHash(options.staticResourcesHash, "workflow v17 static resources hash");
  assertHash(options.contextIdentityHash, "workflow v17 context identity hash");
  assertSafety(options.safety);
  assertIsoDate(options.createdAt, "workflow v17 run createdAt");
}

function assertRunRecord(run: WorkflowRunRecord): void {
  assertIdentifier(run.runId, "workflow v17 run id");
  assertPositiveRevision(run.revision);
  if (!/^(?:builtin|user|project):[a-z][a-z0-9_-]{0,63}$/u.test(run.workflow.id)) {
    throw corrupt("Workflow v17 run has invalid workflow id");
  }
  assertText(run.workflow.name, "workflow v17 workflow name", 64);
  for (const [label, value] of [
    ["source", run.workflow.sourceHash],
    ["definition", run.workflow.definitionHash],
    ["snapshot", run.workflow.snapshotHash],
    ["runtime API", run.workflow.runtimeApiHash],
    ["invocation", run.invocationHash],
    ["resources", run.resourcesHash],
    ["project snapshot", run.projectSnapshotHash],
    ["route snapshot", run.routeSnapshotHash],
    ["static resources", run.staticResourcesHash],
    ["context identity", run.contextIdentityHash],
    ["policy", run.launch.policyHash],
  ] as const) assertHash(value, `workflow v17 ${label} hash`);
  if (run.workflow.runtimeApiHash !== WORKFLOW_RUNTIME_API_HASH) {
    throw corrupt("Workflow v17 run uses another runtime API hash");
  }
  if (!new Set(["model", "user", "rpc"]).has(run.launch.authority)
    || !new Set(["human", "model"]).has(run.launch.exposure)
    || (run.launch.authority === "model" && run.launch.exposure !== "model")
    || (run.workflow.id.startsWith("project:") && !run.launch.projectTrusted)) {
    throw corrupt("Workflow v17 run has invalid launch authority");
  }
  if (!new Set<WorkflowRunStatus>(["queued", "running", "waiting", "paused", "completed", "failed", "stopped"]).has(run.status)) {
    throw corrupt("Workflow v17 run has invalid status");
  }
  const sortedCapabilities = [...run.capabilities].sort();
  if (new Set(run.capabilities).size !== run.capabilities.length
    || sortedCapabilities.some((value, index) => value !== run.capabilities[index])) {
    throw corrupt("Workflow v17 run capabilities are not canonical");
  }
  assertSafety(run.safety);
  assertIdentifier(run.rootScopeId, "workflow v17 root scope id");
  if (run.currentOperationId) assertIdentifier(run.currentOperationId, "workflow v17 current operation id");
  if (run.rootTerminalKey) assertHash(run.rootTerminalKey, "workflow v17 root terminal key");
  if ((run.status === "completed") !== Boolean(run.rootTerminalKey)
    || TERMINAL_RUN_STATUSES.has(run.status) !== Boolean(run.endedAt)) {
    throw corrupt("Workflow v17 run terminal fields are inconsistent");
  }
  assertIsoDate(run.createdAt, "workflow v17 run createdAt");
  if (run.startedAt) assertIsoDate(run.startedAt, "workflow v17 run startedAt");
  assertIsoDate(run.updatedAt, "workflow v17 run updatedAt");
  if (run.endedAt) assertIsoDate(run.endedAt, "workflow v17 run endedAt");
}

function assertResourceRecord(resource: WorkflowInvocationResourceRecord, runId: string): void {
  if (resource.runId !== runId || resource.kind !== "measurement-profile"
    || resource.resourceId !== workflowResourceId(resource.inputPath, resource.bindingHash)
    || resource.resource.identity.kind !== resource.kind
    || resource.resource.inputPath !== resource.inputPath
    || resource.resource.identity.selector !== resource.selector
    || resource.resource.identity.snapshotHash !== resource.snapshotHash
    || resource.resource.bindingHash !== resource.bindingHash) {
    throw corrupt(`Workflow v17 resource ${resource.inputPath} identity is corrupt`);
  }
  const { bindingHash, ...body } = resource.resource;
  if (stableHash(body) !== bindingHash) throw corrupt(`Workflow v17 resource ${resource.inputPath} binding hash is corrupt`);
}

function assertClaimInput(input: ClaimWorkflowOperationInput): void {
  assertPositiveRevision(input.expectedRevision);
  assertIdentifier(input.scopeId, "workflow v17 operation scope id");
  assertNonNegativeInteger(input.cursor, "workflow v17 operation cursor");
  if (input.cursor > 999_999) throw new TypeError("Workflow v17 operation cursor exceeds path bound");
  if (!new Set<WorkflowOperationKind>([
    "parallel", "map", "agent", "command", "ask", "measure", "candidate",
    "verify", "accept", "reject", "record-experiment", "apply",
  ]).has(input.kind)) throw new TypeError("Invalid workflow v17 operation kind");
  assertSourceSite(input.sourceSite);
  if (input.descriptorSourceSite) assertSourceSite(input.descriptorSourceSite);
  if (input.title !== undefined) assertDisplayTitle(input.title);
  assertHash(input.semanticInputHash, "workflow v17 semantic input hash");
  if (input.maximumOperations !== undefined) {
    assertPositiveInteger(input.maximumOperations, "workflow v17 maximum operations");
    if (input.maximumOperations > DEFINITION_LIMITS.semanticOperations) {
      throw new TypeError(`Workflow v17 maximum operations exceeds ${DEFINITION_LIMITS.semanticOperations}`);
    }
  }
  if (input.maximumAgentOperations !== undefined) {
    assertPositiveInteger(input.maximumAgentOperations, "workflow v17 maximum agent operations");
  }
  assertIsoDate(input.at, "workflow v17 operation claim time");
}

function assertSettleEffectInput(input: SettleWorkflowEffectInput): void {
  assertPositiveRevision(input.expectedRevision);
  assertIdentifier(input.operationId, "workflow v17 operation id");
  assertHash(input.semanticKey, "workflow v17 settlement semantic key");
  if (!new Set(["success", "failure"]).has(input.outcome)
    || !new Set(["finish-work", "host-effect"]).has(input.completionAuthority)
    || !new Set(["immutable", "workspace", "never"]).has(input.replayPolicy)) {
    throw new TypeError("Invalid workflow v17 effect settlement policy");
  }
  if ((input.outcome === "success") !== Object.prototype.hasOwnProperty.call(input, "result")
    || (input.outcome === "failure") !== Object.prototype.hasOwnProperty.call(input, "failure")) {
    throw new TypeError("Workflow v17 settlement requires exactly its success result or failure");
  }
  if (input.outcome === "failure" && input.replayPolicy !== "never") {
    throw new TypeError("Failed workflow v17 settlements must never be replayable");
  }
  if ((input.replayPolicy === "workspace") !== Boolean(input.postWorkspaceCheckpointId)) {
    throw new TypeError("Workflow v17 workspace settlement requires exactly one post-workspace checkpoint");
  }
  if (input.postWorkspaceCheckpointId) {
    assertIdentifier(input.postWorkspaceCheckpointId, "workflow v17 settlement checkpoint id");
  }
  canonicalJsonValue(input.outcome === "success" ? input.result! : input.failure!, jsonLimits());
  assertIsoDate(input.at, "workflow v17 effect settlement time");
}

function sameEffectSettlement(
  current: WorkflowEffectSettlementRecord,
  input: SettleWorkflowEffectInput,
): boolean {
  return current.semanticKey === input.semanticKey
    && current.outcome === input.outcome
    && current.completionAuthority === input.completionAuthority
    && current.replayPolicy === input.replayPolicy
    && current.postWorkspaceCheckpointId === input.postWorkspaceCheckpointId
    && stableHash(current.outcome === "success" ? current.result! : current.failure!)
      === stableHash(input.outcome === "success" ? input.result! : input.failure!);
}

function assertCompleteCallInput(input: CompleteWorkflowCallInput): void {
  assertPositiveRevision(input.expectedRevision);
  assertIdentifier(input.operationId, "workflow v17 operation id");
  assertHash(input.previousCallKey, "workflow v17 previous call key");
  assertHash(input.semanticKey, "workflow v17 semantic key");
  assertHash(input.callKey, "workflow v17 call key");
  if (!new Set(["success", "failure"]).has(input.outcome)
    || !new Set(["finish-work", "host-effect", "structural-join"]).has(input.completionAuthority)
    || !new Set(["immutable", "workspace", "never"]).has(input.replayPolicy)) {
    throw new TypeError("Invalid workflow v17 call policy");
  }
  if ((input.outcome === "success") !== Object.prototype.hasOwnProperty.call(input, "result")
    || (input.outcome === "failure") !== Object.prototype.hasOwnProperty.call(input, "failure")) {
    throw new TypeError("Workflow v17 call requires exactly its success result or failure");
  }
  if (input.postWorkspaceCheckpointId) assertIdentifier(input.postWorkspaceCheckpointId, "workflow v17 checkpoint id");
  if (input.replayPolicy === "workspace" && !input.postWorkspaceCheckpointId) {
    throw new TypeError("Workflow v17 workspace call requires a post-workspace checkpoint");
  }
  if (input.replayPolicy !== "workspace" && input.postWorkspaceCheckpointId) {
    throw new TypeError("Only workflow v17 workspace calls may bind a post-workspace checkpoint");
  }
  if (input.workspaceCheckpoint) assertWorkspaceCheckpoint(input.workspaceCheckpoint);
  const artifactKeys = new Set<string>();
  for (const link of input.artifacts ?? []) {
    if (!new Set(["input", "output", "evidence", "progress"]).has(link.role)) {
      throw new TypeError("Invalid workflow v17 operation artifact role");
    }
    if (link.name !== undefined) assertText(link.name, "workflow v17 operation artifact name", 256);
    assertNonNegativeInteger(link.ordinal, "workflow v17 operation artifact ordinal");
    assertArtifactRecord(link.artifact);
    const key = `${link.role}\0${link.ordinal}`;
    if (artifactKeys.has(key)) throw new TypeError("Duplicate workflow v17 operation artifact ordinal");
    artifactKeys.add(key);
  }
  if (input.replay) {
    assertIdentifier(input.replay.sourceRunId, "workflow v17 replay source run id");
    assertIdentifier(input.replay.sourceOperationId, "workflow v17 replay source operation id");
    assertScopePath(input.replay.sourceScopePath);
    assertNonNegativeInteger(input.replay.sourceCursor, "workflow v17 replay source cursor");
    assertHash(input.replay.sourceCallKey, "workflow v17 replay source call key");
  }
  assertIsoDate(input.at, "workflow v17 call completion time");
}

function assertCompleteStructuralJoinInput(input: CompleteWorkflowStructuralJoinInput): void {
  assertCompleteCallInput({
    ...input,
    outcome: "success",
    completionAuthority: "structural-join",
    replayPolicy: "immutable",
  });
  if (!new Set(["parallel", "map", "candidate"]).has(input.kind)) throw new TypeError("Invalid workflow v17 join kind");
  assertHash(input.policyHash, "workflow v17 structural policy hash");
  assertHash(input.joinKey, "workflow v17 structural join key");
  if (!Array.isArray(input.outputOrder) || !Array.isArray(input.lanes)) throw new TypeError("Invalid workflow v17 structural lanes");
  for (const key of input.outputOrder) assertLaneOrCandidateKey(key);
  for (const lane of input.lanes) {
    assertLaneOrCandidateKey(lane.laneKey);
    assertIdentifier(lane.scopeId, "workflow v17 structural lane scope id");
    assertHash(lane.terminalKey, "workflow v17 structural lane terminal key");
    if (!new Set(["success", "failure", "cancelled"]).has(lane.outcome)) throw new TypeError("Invalid structural lane outcome");
  }
}

function assertCompleteStructuralFailureInput(input: CompleteWorkflowStructuralFailureInput): void {
  assertCompleteCallInput({
    ...input,
    outcome: "failure",
    completionAuthority: "structural-join",
    replayPolicy: "never",
  });
  if (!new Set(["parallel", "map", "candidate"]).has(input.kind)) {
    throw new TypeError("Invalid workflow v17 failed join kind");
  }
  assertHash(input.policyHash, "workflow v17 failed structural policy hash");
  assertHash(input.joinKey, "workflow v17 failed structural join key");
  if (!Array.isArray(input.outputOrder) || !Array.isArray(input.lanes)) {
    throw new TypeError("Invalid workflow v17 failed structural lanes");
  }
  for (const key of input.outputOrder) assertLaneOrCandidateKey(key);
  for (const lane of input.lanes) {
    assertLaneOrCandidateKey(lane.laneKey);
    assertIdentifier(lane.scopeId, "workflow v17 failed structural lane scope id");
    assertHash(lane.terminalKey, "workflow v17 failed structural lane terminal key");
    if (!new Set(["success", "failure", "cancelled"]).has(lane.outcome)) {
      throw new TypeError("Invalid failed structural lane outcome");
    }
  }
}

function assertChildScopeSpecs(specs: readonly CreateWorkflowChildScopeSpec[]): void {
  if (!Array.isArray(specs) || specs.length > 1_024) throw new TypeError("Invalid workflow v17 child scope count");
  const keys = new Set<string>();
  for (const spec of specs) {
    if (!new Set(["parallel-branch", "map-item", "candidate-body"]).has(spec.kind)) {
      throw new TypeError("Invalid workflow v17 child scope kind");
    }
    if (spec.kind === "candidate-body") {
      if (spec.laneKey !== undefined) throw new TypeError("Candidate body scope cannot have a lane key");
    } else {
      if (spec.laneKey === undefined) throw new TypeError("Concurrent child scope requires a lane key");
      assertLaneKey(spec.laneKey);
      if (keys.has(spec.laneKey)) throw new TypeError(`Duplicate workflow v17 child lane ${spec.laneKey}`);
      keys.add(spec.laneKey);
    }
    assertHash(spec.seedKey, "workflow v17 child scope seed");
  }
}

function assertChildKinds(
  ownerKind: WorkflowOperationKind,
  specs: readonly CreateWorkflowChildScopeSpec[],
): void {
  const expected = ownerKind === "parallel"
    ? "parallel-branch"
    : ownerKind === "map"
      ? "map-item"
      : "candidate-body";
  if (specs.some((spec) => spec.kind !== expected)
    || (ownerKind === "candidate" && specs.length !== 1)) {
    throw state(`${ownerKind} operation received incompatible child scopes`);
  }
}

function assertExistingChildScopes(
  existing: readonly WorkflowScopeRecord[],
  owner: WorkflowOperationRecord,
  specs: readonly CreateWorkflowChildScopeSpec[],
): void {
  if (existing.length !== specs.length) throw state(`Child scopes for ${owner.path} changed after preclaim`);
  for (let index = 0; index < existing.length; index++) {
    const scope = existing[index]!;
    const spec = specs[index]!;
    if (scope.kind !== spec.kind || scope.laneKey !== spec.laneKey || scope.seedKey !== spec.seedKey
      || scope.path !== childScopePath(owner, spec)) {
      throw state(`Child scope ${index} for ${owner.path} changed identity`);
    }
  }
}

function assertCreateCandidateWorkspaceInput(input: CreateCandidateWorkspaceInput): void {
  assertPositiveRevision(input.expectedRevision);
  assertIdentifier(input.workspaceId, "workflow v17 candidate workspace id");
  assertIdentifier(input.candidateOperationId, "workflow v17 candidate operation id");
  assertIdentifier(input.bodyScopeId, "workflow v17 candidate body scope id");
  if (input.parentCandidateId) assertIdentifier(input.parentCandidateId, "workflow v17 parent candidate id");
  assertHash(input.initialTreeHash, "workflow v17 candidate initial tree hash");
  assertHash(input.baseLineageHash, "workflow v17 candidate base lineage hash");
  canonicalJsonValue(input.writeScope, jsonLimits());
  assertHash(input.writeScopeHash, "workflow v17 candidate write scope hash");
  assertRelativeStoragePath(input.rootPath, "workflow v17 candidate workspace root path");
  assertIsoDate(input.at, "workflow v17 candidate workspace time");
}

function assertFreezeCandidateInput(input: FreezeCandidateInput): void {
  assertPositiveRevision(input.expectedRevision);
  assertIdentifier(input.workspaceId, "workflow v17 candidate workspace id");
  assertHash(input.bodyTerminalKey, "workflow v17 candidate body terminal key");
  assertHash(input.treeHash, "workflow v17 candidate tree hash");
  assertHash(input.lineageHash, "workflow v17 candidate lineage hash");
  canonicalJsonValue(input.output, jsonLimits());
  assertHash(input.manifestArtifactDigest, "workflow v17 candidate manifest digest");
  assertHash(input.diffArtifactDigest, "workflow v17 candidate diff digest");
  if (!Array.isArray(input.changedPaths) || input.changedPaths.length > 10_000) {
    throw new TypeError("Invalid workflow v17 candidate changed paths");
  }
  const sorted = [...input.changedPaths].sort();
  if (new Set(sorted).size !== sorted.length
    || sorted.some((entry, index) => entry !== input.changedPaths[index])) {
    throw new TypeError("Workflow v17 candidate changed paths must be unique and sorted");
  }
  for (const changedPath of input.changedPaths) assertSemanticPath(changedPath);
  assertIsoDate(input.at, "workflow v17 candidate freeze time");
}

function assertDisposeCandidateInput(input: DisposeCandidateInput): void {
  assertPositiveRevision(input.expectedRevision);
  assertIdentifier(input.candidateId, "workflow v17 candidate id");
  if (input.operationId) assertIdentifier(input.operationId, "workflow v17 disposition operation id");
  if (input.measurementId) assertIdentifier(input.measurementId, "workflow v17 disposition measurement id");
  if ("verificationId" in input && input.verificationId) {
    assertIdentifier(input.verificationId, "workflow v17 disposition verification id");
  }
  if ("reason" in input) canonicalJsonValue(input.reason, jsonLimits());
  assertIsoDate(input.at, "workflow v17 candidate disposition time");
}

function assertVerificationRecord(
  verification: Omit<WorkflowCandidateVerificationRecord, "runId">,
): void {
  assertIdentifier(verification.verificationId, "workflow v17 verification id");
  assertIdentifier(verification.candidateId, "workflow v17 candidate id");
  assertIdentifier(verification.operationId, "workflow v17 verification operation id");
  if (!new Set(["passed", "failed", "blocked"]).has(verification.status)) {
    throw new TypeError("Invalid workflow v17 verification status");
  }
  assertHash(verification.bindingHash, "workflow v17 verification binding hash");
  assertHash(verification.evidenceHash, "workflow v17 verification evidence hash");
  assertHash(verification.artifactDigest, "workflow v17 verification artifact digest");
  assertIsoDate(verification.createdAt, "workflow v17 verification time");
}

function assertCandidateApplyRecord(apply: Omit<WorkflowCandidateApplyRecord, "runId">): void {
  assertIdentifier(apply.receiptId, "workflow v17 apply receipt id");
  assertIdentifier(apply.candidateId, "workflow v17 apply candidate id");
  assertIdentifier(apply.operationId, "workflow v17 apply operation id");
  assertIdentifier(apply.approvalId, "workflow v17 approval id");
  assertHash(apply.verificationBindingHash, "workflow v17 apply verification binding hash");
  assertHash(apply.authorityHash, "workflow v17 apply authority hash");
  assertIsoDate(apply.appliedAt, "workflow v17 apply time");
}

function assertArtifactRecord(artifact: WorkflowArtifactRecord): void {
  assertHash(artifact.digest, "workflow v17 artifact digest");
  assertIdentifier(artifact.runId, "workflow v17 artifact run id");
  assertText(artifact.kind, "workflow v17 artifact kind", 128);
  if (!new Set(["text/plain; charset=utf-8", "application/json", "application/octet-stream"]).has(artifact.mediaType)) {
    throw new TypeError("Invalid workflow v17 artifact media type");
  }
  assertNonNegativeInteger(artifact.bytes, "workflow v17 artifact bytes");
  assertRelativeStoragePath(artifact.bodyPath, "workflow v17 artifact body path");
  canonicalJsonValue(artifact.metadata, jsonLimits());
  assertIsoDate(artifact.createdAt, "workflow v17 artifact time");
}

function sameArtifactIdentity(
  left: WorkflowArtifactRecord,
  right: WorkflowArtifactRecord,
): boolean {
  return left.runId === right.runId
    && left.digest === right.digest
    && left.kind === right.kind
    && left.mediaType === right.mediaType
    && left.bytes === right.bytes
    && left.bodyPath === right.bodyPath
    && stableJson(left.metadata) === stableJson(right.metadata);
}

function assertAttemptRecord(attempt: WorkflowAttemptRecord): void {
  assertIdentifier(attempt.attemptId, "workflow v17 attempt id");
  assertIdentifier(attempt.runId, "workflow v17 attempt run id");
  assertIdentifier(attempt.operationId, "workflow v17 attempt operation id");
  assertPositiveInteger(attempt.number, "workflow v17 attempt number");
  if (!new Set(["agent", "command", "measurement", "verification", "apply"]).has(attempt.effect)
    || !new Set(["running", "waiting", "completed", "failed", "stopped", "cancelled"]).has(attempt.status)) {
    throw new TypeError("Invalid workflow v17 attempt kind or status");
  }
  if (attempt.executionId) assertIdentifier(attempt.executionId, "workflow v17 attempt execution id");
  canonicalJsonValue(attempt.usage, jsonLimits());
  if (attempt.resources) canonicalJsonValue(attempt.resources, jsonLimits());
  assertIsoDate(attempt.createdAt, "workflow v17 attempt createdAt");
  assertIsoDate(attempt.updatedAt, "workflow v17 attempt updatedAt");
  if (attempt.endedAt) assertIsoDate(attempt.endedAt, "workflow v17 attempt endedAt");
  if (["running", "waiting"].includes(attempt.status) === Boolean(attempt.endedAt)) {
    throw new TypeError("Workflow v17 attempt terminal fields are inconsistent");
  }
}

function assertControlRequestRecord(request: WorkflowControlRequestRecord): void {
  assertIdentifier(request.requestId, "workflow v17 control request id");
  assertIdentifier(request.runId, "workflow v17 control request run id");
  if (!new Set([
    "pause", "resume", "stop", "stop-effect", "ask-response", "apply-approve", "apply-reject",
  ]).has(request.kind)) throw new TypeError("Workflow v17 control request kind is invalid");
  if (request.targetId) assertIdentifier(request.targetId, "workflow v17 control target id");
  if (request.challengeHash) assertHash(request.challengeHash, "workflow v17 control challenge hash");
  if (request.value !== undefined) canonicalJsonValue(request.value, jsonLimits());
  assertText(request.actor, "workflow v17 control actor", 512);
  if (!new Set(["pending", "processed", "rejected"]).has(request.status)) {
    throw new TypeError("Workflow v17 control request status is invalid");
  }
  if (request.reason) canonicalJsonValue(request.reason, jsonLimits());
  assertIsoDate(request.requestedAt, "workflow v17 control request time");
  if (request.processedAt) assertIsoDate(request.processedAt, "workflow v17 control processed time");
}

function assertWorkspaceCheckpoint(checkpoint: WorkflowWorkspaceCheckpointRecord): void {
  assertIdentifier(checkpoint.checkpointId, "workflow v17 checkpoint id");
  assertIdentifier(checkpoint.runId, "workflow v17 checkpoint run id");
  assertIdentifier(checkpoint.operationId, "workflow v17 checkpoint operation id");
  assertIdentifier(checkpoint.workspaceId, "workflow v17 checkpoint workspace id");
  assertHash(checkpoint.treeHash, "workflow v17 checkpoint tree hash");
  if (checkpoint.lineageHash) assertHash(checkpoint.lineageHash, "workflow v17 checkpoint lineage hash");
  if (checkpoint.writeScopeHash) assertHash(checkpoint.writeScopeHash, "workflow v17 checkpoint write scope hash");
  assertRelativeStoragePath(checkpoint.storagePath, "workflow v17 checkpoint storage path");
  assertIsoDate(checkpoint.createdAt, "workflow v17 checkpoint time");
}

function assertRunTransitionInput(input: TransitionWorkflowRunInput): void {
  if (!new Set<WorkflowRunStatus>(["queued", "running", "waiting", "paused", "completed", "failed", "stopped"]).has(input.status)) {
    throw new TypeError("Invalid workflow v17 run transition status");
  }
  if (input.reason) canonicalJsonValue(input.reason, jsonLimits());
  if (input.currentOperationId) assertIdentifier(input.currentOperationId, "workflow v17 current operation id");
  if (input.status === "completed") {
    if (!input.rootTerminalKey) throw new TypeError("Completed workflow v17 run requires root terminal key");
    assertHash(input.rootTerminalKey, "workflow v17 root terminal key");
    canonicalJsonValue(input.result ?? null, jsonLimits());
  } else if (input.rootTerminalKey !== undefined) {
    throw new TypeError("Only completed workflow v17 run accepts root terminal key");
  } else if (input.result !== undefined) {
    throw new TypeError("Only completed workflow v17 run accepts a result");
  }
  assertIsoDate(input.at, "workflow v17 run transition time");
}

function assertRunTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): void {
  const allowed: Record<WorkflowRunStatus, readonly WorkflowRunStatus[]> = {
    queued: ["running", "failed", "stopped"],
    running: ["waiting", "paused", "completed", "failed", "stopped"],
    waiting: ["running", "paused", "failed", "stopped"],
    paused: ["running", "stopped"],
    completed: [],
    failed: [],
    stopped: [],
  };
  if (!allowed[from].includes(to)) throw state(`Workflow v17 run cannot transition from ${from} to ${to}`);
}

function childScopePath(
  owner: WorkflowOperationRecord,
  spec: CreateWorkflowChildScopeSpec,
): string {
  if (spec.kind === "candidate-body") return `${owner.path}/candidate`;
  return `${owner.path}/${spec.kind === "parallel-branch" ? "branch" : "item"}:${spec.laneKey!}`;
}

function operationPath(scopePath: string, cursor: number): string {
  assertScopePath(scopePath);
  assertNonNegativeInteger(cursor, "workflow v17 operation cursor");
  if (cursor > 999_999) throw new TypeError("Workflow v17 operation cursor exceeds path bound");
  return `${scopePath}/${String(cursor).padStart(6, "0")}`;
}

function assertScopePath(value: string): void {
  if (typeof value !== "string" || value.length < 3 || value.length > 4_096) {
    throw new TypeError("Invalid workflow v17 scope path");
  }
  const segments = value.split("/");
  if (segments[0] !== "run" || segments.some((segment, index) => {
    if (index === 0) return false;
    return !/^\d{6}$/u.test(segment)
      && segment !== "candidate"
      && !/^(?:branch|item):[a-z][a-z0-9_-]{0,63}$/u.test(segment);
  })) throw new TypeError("Invalid workflow v17 scope path");
  const tail = segments.at(-1)!;
  if (value !== "run" && /^\d{6}$/u.test(tail)) throw new TypeError("Workflow v17 scope path ends in an operation cursor");
}

function assertOperationPath(value: string): void {
  if (typeof value !== "string" || value.length > 4_096 || !/\/\d{6}$/u.test(value)) {
    throw new TypeError("Invalid workflow v17 operation path");
  }
  const scope = value.slice(0, value.lastIndexOf("/"));
  assertScopePath(scope);
}

function assertJsonPointer(value: string, label: string): void {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 4_096
    || /(?:^|\/)\.\.?($|\/)/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function assertLaneKey(value: string): void {
  if (typeof value !== "string" || !LANE_KEY.test(value)) throw new TypeError("Invalid workflow v17 lane key");
}

function assertLaneOrCandidateKey(value: string): void {
  if (value !== "candidate") assertLaneKey(value);
}

function assertSourceSite(value: string): void {
  if (typeof value !== "string" || !SOURCE_SITE.test(value)) throw new TypeError("Invalid workflow v17 source site");
}

function assertWorkflowMeasurement(input: Omit<WorkflowMeasurementRecord, "runId">): void {
  assertIdentifier(input.measurementId, "workflow v17 measurement id");
  assertIdentifier(input.operationId, "workflow v17 measurement operation id");
  assertIdentifier(input.metricSetId, "workflow v17 measurement metric-set id");
  assertHash(input.profileHash, "workflow v17 measurement profile hash");
  assertHash(input.commandHash, "workflow v17 measurement command hash");
  assertHash(input.environmentHash, "workflow v17 measurement environment hash");
  assertHash(input.workspaceTreeHash, "workflow v17 measurement workspace tree hash");
  assertHash(input.bindingHash, "workflow v17 measurement binding hash");
  assertHash(input.artifactDigest, "workflow v17 measurement artifact digest");
  if (input.diagnosticsArtifactDigest) {
    assertHash(input.diagnosticsArtifactDigest, "workflow v17 measurement diagnostics artifact digest");
  }
  if (input.candidateId) assertIdentifier(input.candidateId, "workflow v17 measurement candidate id");
  const profile = input.profile;
  if (!profile || profile.id !== `${profile.namespace}:${profile.name}` || profile.hash !== input.profileHash) {
    throw new TypeError("Workflow v17 measurement profile identity is invalid");
  }
  const { id: _id, namespace, path: _path, hash, ...definition } = profile;
  const normalized = normalizeMeasurementProfile(definition);
  if (stableJson(normalized) !== stableJson(definition)
    || stableHash({ namespace, definition }) !== hash) {
    throw new TypeError("Workflow v17 measurement profile snapshot is corrupt");
  }
  const environment = canonicalJsonValue(input.environment, jsonLimits()) as JsonObject;
  if (stableHash(environment) !== input.environmentHash) {
    throw new TypeError("Workflow v17 measurement environment fingerprint is invalid");
  }
  const delta = normalizeMetricCohortDelta(input.delta);
  const observations = canonicalJsonValue(input.observations, jsonLimits()) as JsonObject;
  const expectedObservations = Object.fromEntries(delta.observations.map(value => [value.outputId, {
    observationId: value.observationId,
    metricId: value.metricId,
    outputId: value.outputId,
    value: value.value,
    samples: value.samples,
  }]));
  if (stableJson(observations) !== stableJson(expectedObservations)) {
    throw new TypeError("Workflow v17 measurement observations differ from their cohort");
  }
  if (!Array.isArray(input.samples) || input.samples.length < 1) {
    throw new TypeError("Workflow v17 measurement samples are empty");
  }
  for (let ordinal = 0; ordinal < input.samples.length; ordinal++) {
    const sample = input.samples[ordinal]!;
    if (sample.ordinal !== ordinal || !["warmup", "sample"].includes(sample.kind)
      || !Number.isSafeInteger(sample.sampleIndex) || sample.sampleIndex < 0
      || !["completed", "timed-out", "output-limited", "infrastructure-failure", "cancelled"].includes(sample.status)
      || (sample.exitCode !== null && !Number.isSafeInteger(sample.exitCode))
      || typeof sample.timedOut !== "boolean") {
      throw new TypeError(`Workflow v17 measurement sample ${ordinal} is invalid`);
    }
    assertIdentifier(sample.executionId, `workflow v17 measurement sample ${ordinal} execution id`);
    assertHash(sample.stdoutArtifactDigest, `workflow v17 measurement sample ${ordinal} stdout artifact`);
    assertHash(sample.stderrArtifactDigest, `workflow v17 measurement sample ${ordinal} stderr artifact`);
    assertIsoDate(sample.startedAt, `workflow v17 measurement sample ${ordinal} start`);
    assertIsoDate(sample.endedAt, `workflow v17 measurement sample ${ordinal} end`);
    if (sample.resources) canonicalJsonValue(sample.resources, jsonLimits());
  }
  assertIsoDate(input.createdAt, "workflow v17 measurement time");
}

function assertWorkflowExperiment(input: Omit<WorkflowExperimentRecord, "runId">): void {
  assertIdentifier(input.experimentId, "workflow v17 experiment id");
  assertIdentifier(input.operationId, "workflow v17 experiment operation id");
  assertIdentifier(input.candidateId, "workflow v17 experiment candidate id");
  assertIdentifier(input.measurementId, "workflow v17 experiment measurement id");
  if (input.disposition !== "accepted" && input.disposition !== "rejected") {
    throw new TypeError("Workflow v17 experiment disposition is invalid");
  }
  assertText(input.learned, "workflow v17 experiment lesson", 8_000);
  if (!input.learned.trim()) throw new TypeError("Workflow v17 experiment lesson is empty");
  assertHash(input.bindingHash, "workflow v17 experiment binding hash");
  assertHash(input.artifactDigest, "workflow v17 experiment artifact digest");
  assertIsoDate(input.createdAt, "workflow v17 experiment time");
}

function assertDisplayTitle(value: string): void {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > 192
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("Invalid workflow v17 operation title");
  }
}

function assertSemanticPath(value: string): void {
  if (typeof value !== "string" || !value || value.length > 4_096 || path.isAbsolute(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("Invalid workflow v17 semantic project path");
  }
}

function assertRelativeStoragePath(value: string, label: string): void {
  if (typeof value !== "string" || !value || value.length > 4_096 || path.isAbsolute(value)
    || value.split(/[\\/]/u).some((part) => !part || part === "." || part === "..")
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function laneOutcome(status: WorkflowScopeRecord["status"]): WorkflowStructuralJoinLaneRecord["outcome"] {
  if (status === "completed") return "success";
  if (status === "failed") return "failure";
  if (status === "cancelled") return "cancelled";
  throw state("Active scope has no structural lane outcome");
}

function assertEvent(event: WorkflowRunEvent): void {
  assertIdentifier(event.runId, "workflow v17 event run id");
  assertPositiveInteger(event.sequence, "workflow v17 event sequence");
  assertPositiveRevision(event.revision);
  assertEventType(event.type);
  if (event.operationId) assertIdentifier(event.operationId, "workflow v17 event operation id");
  if (event.scopeId) assertIdentifier(event.scopeId, "workflow v17 event scope id");
  if (event.candidateId) assertIdentifier(event.candidateId, "workflow v17 event candidate id");
  canonicalJsonValue(event.payload, jsonLimits());
  assertIsoDate(event.at, "workflow v17 event time");
}

function assertEventType(value: string): void {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,127}$/u.test(value)) {
    throw new TypeError("Invalid workflow v17 event type");
  }
}

function assertPositiveRevision(value: number): void {
  assertPositiveInteger(value, "workflow v17 revision");
}

function assertExpectedRevision(actual: number, expected: number): void {
  assertPositiveRevision(expected);
  if (actual !== expected) throw new WorkflowRunDatabaseRevisionConflictError(expected, actual);
}

function assertOneChange(result: { changes: number | bigint }, label: string): void {
  if (Number(result.changes) !== 1) throw state(`Could not commit ${label}`);
}

function safetyFromRow(row: SqlRow): SafetyConfiguration {
  return {
    concurrency: requiredNumber(row, "safety_concurrency"),
    maximumAgentLaunches: requiredNumber(row, "safety_maximum_agent_launches"),
    memoryBytes: requiredNumber(row, "safety_memory_bytes"),
    tasks: requiredNumber(row, "safety_tasks"),
    cpuQuotaPercent: requiredNumber(row, "safety_cpu_quota_percent"),
    cpuWeight: requiredNumber(row, "safety_cpu_weight"),
    outputBytes: requiredNumber(row, "safety_output_bytes"),
    commandTimeoutMs: requiredNumber(row, "safety_command_timeout_ms"),
  };
}

function json(value: JsonValue): string {
  const canonical = canonicalJsonValue(value, jsonLimits());
  return stableJson(canonical);
}

function jsonColumn<T extends JsonValue>(row: SqlRow, key: string): T | undefined {
  const source = optionalString(row, key);
  return source === undefined ? undefined : parseCanonicalJson<T>(source, key);
}

function jsonColumnRequired<T extends JsonValue>(row: SqlRow, key: string): T {
  return parseCanonicalJson<T>(requiredString(row, key), key);
}

function parseCanonicalJson<T extends JsonValue>(source: string, label: string): T {
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch { throw corrupt(`Workflow v17 column ${label} contains invalid JSON`); }
  const canonical = canonicalJsonValue(parsed, jsonLimits());
  if (stableJson(canonical) !== source) throw corrupt(`Workflow v17 column ${label} is not canonical JSON`);
  return deepFreezeJson(canonical) as T;
}

function jsonLimits() {
  return {
    maxBytes: 512 * 1024,
    maxDepth: 48,
    maxNodes: 50_000,
    maxStringScalars: 200_000,
  };
}

function pageLimit(value = 256): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_024) throw new TypeError("Invalid workflow v17 page limit");
  return value;
}

function openConnection(
  databasePath: string,
  readOnly: boolean,
  options: WorkflowRunDatabaseOpenOptions,
  creating = false,
): DatabaseSync {
  const busyTimeoutMs = options.busyTimeoutMs ?? WORKFLOW_RUN_DATABASE_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000) {
    throw new TypeError("Invalid workflow v17 SQLite busy timeout");
  }
  const database = new DatabaseSync(databasePath, {
    readOnly,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  });
  try {
    database.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA synchronous = FULL`);
    if (!creating) {
      const version = pragmaNumber(database, "user_version");
      if (version !== WORKFLOW_RUN_DATABASE_SCHEMA_VERSION) {
        throw new WorkflowRunDatabaseVersionError(version);
      }
      const mode = pragmaText(database, "journal_mode").toLowerCase();
      if (mode !== "wal") throw corrupt(`Workflow v17 database journal mode is ${mode}, expected WAL`);
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function configureNewConnection(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA journal_mode = WAL").get() as SqlRow | undefined;
  if (!row || requiredString(row, "journal_mode").toLowerCase() !== "wal") {
    throw corrupt("SQLite refused workflow v17 WAL mode");
  }
  database.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL");
}

function pragmaNumber(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as SqlRow | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) throw corrupt(`Workflow v17 PRAGMA ${name} is invalid`);
  return number;
}

function pragmaText(database: DatabaseSync, name: string): string {
  const row = database.prepare(`PRAGMA ${name}`).get() as SqlRow | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  if (typeof value !== "string") throw corrupt(`Workflow v17 PRAGMA ${name} is invalid`);
  return value;
}

function removeDatabaseFiles(databasePath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.rmSync(`${databasePath}${suffix}`, { force: true }); } catch { /* preserve create failure */ }
  }
}

function normalizeConstraint(error: unknown): unknown {
  if (error instanceof WorkflowRunDatabaseStateError
    || error instanceof WorkflowRunDatabaseRevisionConflictError
    || error instanceof WorkflowRunDatabaseAdmissionError
    || error instanceof WorkflowRunDatabaseCorruptionError
    || error instanceof TypeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/constraint|foreign key|unique/iu.test(message)) return state(`Workflow v17 database rejected state: ${message}`);
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function state(message: string): WorkflowRunDatabaseStateError {
  return new WorkflowRunDatabaseStateError(message);
}

function corrupt(message: string): WorkflowRunDatabaseCorruptionError {
  return new WorkflowRunDatabaseCorruptionError(message);
}
