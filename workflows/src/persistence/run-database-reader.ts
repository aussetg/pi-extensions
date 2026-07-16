import { DatabaseSync } from "./sqlite.js";
import path from "node:path";
import type {
  AgentLiveProgressProjection,
  AgentMediatedToolIntentRecord,
  AgentProgress,
  AgentProgressRecord,
  AgentRecentProgress,
  AgentSessionRecord,
  AgentToolReceiptRecord,
  ApplyPlanRecord,
  ApplyReceiptRecord,
  ApprovalRecord,
  ArtifactRecord,
  ArtifactRef,
  AttemptRecord,
  CandidateRecord,
  CandidateWorkspaceRecord,
  ControlAcknowledgement,
  ControlRequest,
  HumanCheckpointRecord,
  OperationRecord,
  OperationResult,
  OperationStatus,
  RunEvent,
  RunRecord,
  StructuredReason,
  VerificationRecord,
  WorkflowCallRecord,
  WorkspaceCheckpointRecord,
} from "../runtime/durable-types.js";
import { AGENT_PROGRESS_LIMITS } from "../runtime/agent-progress-limits.js";
import type { JsonValue } from "../types.js";
import type { ExperimentRecord } from "../experiments/records.js";
import type { PersistedMetricState } from "../measurements/metrics.js";
import type { MeasurementRecord } from "../measurements/records.js";
import {
  assertAgentToolCallId,
  assertArtifactRecord,
  assertHash,
  assertIdentifier,
  assertIsoDate,
  assertRunRecord,
  assertStructuredReason,
  assertWorkspace,
  decodeCanonicalJson,
  optionalNumber,
  optionalString,
  requiredNumber,
  requiredString,
  rowReason,
  rowResources,
  rowUsage,
  rowWorkspace,
  RunDatabaseCorruptionError,
  type SqlRow,
} from "./run-database-codec.js";
import { stableHash } from "../utils/hashes.js";
import { RUN_DATABASE_BUSY_TIMEOUT_MS, RUN_DATABASE_SCHEMA_VERSION } from "./run-database-schema.js";
import { assertAgentSession, assertAttempt, assertControlRequest, assertOperation } from "./run-database-validation.js";
import {
  readApplyPlan as readApplyPlanRow,
  readApplyPlanByOperation as readApplyPlanByOperationRow,
  readApplyReceipt as readApplyReceiptRow,
  readApproval as readApprovalRow,
  readVerification as readVerificationRow,
  readVerificationByOperation as readVerificationByOperationRow,
} from "./run-database-evidence.js";
import {
  listExperiments as listExperimentRows,
  listMeasurements as listMeasurementRows,
  listMetrics as listMetricRows,
  listMetricsPage as listMetricPageRows,
  readExperiment as readExperimentRow,
  readExperimentByOperation as readExperimentByOperationRow,
  readMeasurement as readMeasurementRow,
  readMeasurementByOperation as readMeasurementByOperationRow,
  readMetric as readMetricRow,
} from "./run-database-measurements.js";

const PAGE_LIMIT = 256;

export interface RunDatabaseOpenOptions {
  busyTimeoutMs?: number;
}

export interface RunDatabaseConfiguration {
  schemaVersion: number;
  journalMode: string;
  foreignKeys: boolean;
  synchronous: number;
  busyTimeoutMs: number;
}

export interface StructuredQueueProjection {
  operation: OperationRecord;
  children: OperationRecord[];
  counts: Partial<Record<OperationStatus, number>>;
}

export class RunDatabaseVersionError extends Error {
  readonly actual: number;

  constructor(actual: number) {
    super(`Unsupported run database schema version ${actual}; expected ${RUN_DATABASE_SCHEMA_VERSION}`);
    this.name = "RunDatabaseVersionError";
    this.actual = actual;
  }
}

export class RunDatabaseReader implements Disposable {
  readonly databasePath: string;
  protected readonly database: DatabaseSync;
  protected closed = false;

  protected constructor(database: DatabaseSync, databasePath: string) {
    this.database = database;
    this.databasePath = databasePath;
  }

  static open(databasePath: string, options: RunDatabaseOpenOptions = {}): RunDatabaseReader {
    const resolved = path.resolve(databasePath);
    const database = openRunDatabaseConnection(resolved, true, options);
    return new RunDatabaseReader(database, resolved);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  configuration(): RunDatabaseConfiguration {
    this.assertOpen();
    return {
      schemaVersion: pragmaNumber(this.database, "user_version"),
      journalMode: pragmaText(this.database, "journal_mode"),
      foreignKeys: pragmaNumber(this.database, "foreign_keys") === 1,
      synchronous: pragmaNumber(this.database, "synchronous"),
      busyTimeoutMs: pragmaNumber(this.database, "busy_timeout"),
    };
  }

  /** Hold one WAL snapshot across several bounded projection reads. */
  readSnapshot<T>(read: (reader: this) => T): T {
    this.assertOpen();
    this.database.exec("BEGIN");
    try {
      const result = read(this);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve the original read error */ }
      throw error;
    }
  }

  readRun(): RunRecord {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM runs WHERE singleton = 1").get() as SqlRow | undefined;
    if (!row) throw new RunDatabaseCorruptionError("Run database has no run row");
    const runId = requiredString(row, "run_id");
    const capabilities = (this.database.prepare(
      "SELECT capability FROM run_capabilities WHERE run_id = ? ORDER BY ordinal",
    ).all(runId) as SqlRow[]).map((entry) => requiredString(entry, "capability"));
    const resultDigest = optionalString(row, "result_artifact_digest");
    const errorDigest = optionalString(row, "error_artifact_digest");
    const replayRow = this.database.prepare("SELECT * FROM run_replay WHERE run_id = ?").get(runId) as SqlRow | undefined;
    const run: RunRecord = {
      runId,
      revision: requiredNumber(row, "revision"),
      workflow: {
        id: requiredString(row, "workflow_id") as RunRecord["workflow"]["id"],
        name: requiredString(row, "workflow_name"),
        sourceHash: requiredString(row, "workflow_source_hash"),
        definitionHash: requiredString(row, "workflow_definition_hash"),
        capabilities: capabilities as RunRecord["workflow"]["capabilities"],
      },
      invocationHash: requiredString(row, "invocation_hash"),
      projectSnapshotHash: requiredString(row, "project_snapshot_hash"),
      routeSnapshotHash: requiredString(row, "route_snapshot_hash"),
      contextIdentityHash: requiredString(row, "context_identity_hash"),
      status: requiredString(row, "status") as RunRecord["status"],
      ...(rowReason(row) ? { reason: rowReason(row)! } : {}),
      safety: {
        concurrency: requiredNumber(row, "safety_concurrency"),
        maximumAgentLaunches: requiredNumber(row, "safety_maximum_agent_launches"),
        memoryBytes: requiredNumber(row, "safety_memory_bytes"),
        tasks: requiredNumber(row, "safety_tasks"),
        cpuQuotaPercent: requiredNumber(row, "safety_cpu_quota_percent"),
        cpuWeight: requiredNumber(row, "safety_cpu_weight"),
        outputBytes: requiredNumber(row, "safety_output_bytes"),
        commandTimeoutMs: requiredNumber(row, "safety_command_timeout_ms"),
      },
      usage: rowUsage(row),
      ...(optionalString(row, "current_operation_id") ? { currentOperationId: optionalString(row, "current_operation_id")! } : {}),
      ...(resultDigest ? { result: this.requiredArtifactRef(resultDigest) } : {}),
      ...(errorDigest ? { error: this.requiredArtifactRef(errorDigest) } : {}),
      ...(replayRow ? {
        replay: {
          mode: requiredString(replayRow, "mode") as NonNullable<RunRecord["replay"]>["mode"],
          sourceRunId: requiredString(replayRow, "source_run_id"),
          matchedCalls: requiredNumber(replayRow, "matched_calls"),
          ...(optionalNumber(replayRow, "first_miss_ordinal") !== undefined ? { firstMissOrdinal: optionalNumber(replayRow, "first_miss_ordinal")! } : {}),
          ...(optionalString(replayRow, "first_miss_reason") ? { firstMissReason: optionalString(replayRow, "first_miss_reason")! } : {}),
          fresh: requiredNumber(replayRow, "fresh") === 1,
        },
      } : {}),
      createdAt: requiredString(row, "created_at"),
      ...(optionalString(row, "started_at") ? { startedAt: optionalString(row, "started_at")! } : {}),
      updatedAt: requiredString(row, "updated_at"),
      ...(optionalString(row, "ended_at") ? { endedAt: optionalString(row, "ended_at")! } : {}),
    };
    assertRunRecord(run);
    return run;
  }

  readOperation(operationId: string): OperationRecord | undefined {
    this.assertOpen();
    assertIdentifier(operationId, "operation id");
    const row = this.database.prepare("SELECT * FROM operations WHERE operation_id = ?").get(operationId) as SqlRow | undefined;
    return row ? this.operationFromRow(row) : undefined;
  }

  /** Indexed deterministic-path lookup used by the semantic engine on replay. */
  readOperationByPath(operationPath: string): OperationRecord | undefined {
    this.assertOpen();
    if (typeof operationPath !== "string" || operationPath.length < 1 || operationPath.length > 4_096) {
      throw new TypeError("Invalid operation path");
    }
    const row = this.database.prepare(
      "SELECT * FROM operations WHERE run_id = (SELECT run_id FROM runs WHERE singleton = 1) AND path = ?",
    ).get(operationPath) as SqlRow | undefined;
    return row ? this.operationFromRow(row) : undefined;
  }

  /** The next structural ordinal; this does not materialize operation history. */
  nextOperationOrdinal(): number {
    this.assertOpen();
    return requiredNumber(
      this.database.prepare("SELECT coalesce(max(ordinal), -1) + 1 AS value FROM operations").get() as SqlRow,
      "value",
    );
  }

  listOperations(options: { afterOrdinal?: number; limit?: number } = {}): OperationRecord[] {
    this.assertOpen();
    const limit = pageLimit(options.limit);
    const after = options.afterOrdinal ?? -1;
    if (!Number.isSafeInteger(after) || after < -1) throw new TypeError("Invalid operation cursor");
    return (this.database.prepare(
      "SELECT * FROM operations WHERE run_id = (SELECT run_id FROM runs WHERE singleton = 1) AND ordinal > ? ORDER BY ordinal LIMIT ?",
    ).all(after, limit) as SqlRow[]).map((row) => this.operationFromRow(row));
  }

  countOperations(): number {
    this.assertOpen();
    return requiredNumber(this.database.prepare("SELECT count(*) AS value FROM operations").get() as SqlRow, "value");
  }

  readOperationCounts(): Partial<Record<OperationStatus, number>> {
    this.assertOpen();
    const result: Partial<Record<OperationStatus, number>> = {};
    const rows = this.database.prepare(
      "SELECT status, count(*) AS count FROM operations GROUP BY status ORDER BY status",
    ).all() as SqlRow[];
    for (const row of rows) result[requiredString(row, "status") as OperationStatus] = requiredNumber(row, "count");
    return result;
  }

  /**
   * Bounded phase tree source: structural nodes, live work, the current
   * ancestry, and recent terminal leaves. It does not scan event history.
   */
  listProjectionOperations(limitValue = 128): OperationRecord[] {
    this.assertOpen();
    const limit = pageLimit(limitValue);
    const rows = this.database.prepare(`
      WITH RECURSIVE current_chain(operation_id, parent_operation_id, ordinal) AS (
        SELECT operation_id, parent_operation_id, ordinal FROM operations
        WHERE operation_id = (SELECT current_operation_id FROM runs WHERE singleton = 1)
        UNION ALL
        SELECT parent.operation_id, parent.parent_operation_id, parent.ordinal
        FROM operations parent JOIN current_chain child ON parent.operation_id = child.parent_operation_id
      ), selected(operation_id, ordinal) AS (
        SELECT operation_id, ordinal FROM operations WHERE kind IN ('stage', 'loop', 'parallel', 'fan-out')
        UNION
        SELECT operation_id, ordinal FROM operations WHERE status IN ('queued', 'running', 'waiting', 'paused')
        UNION
        SELECT operation_id, ordinal FROM current_chain
        UNION
        SELECT operation_id, ordinal FROM (
          SELECT operation_id, ordinal FROM operations
          WHERE status IN ('completed', 'failed', 'stopped') ORDER BY ordinal DESC LIMIT 16
        )
      )
      SELECT operation_id FROM selected ORDER BY ordinal LIMIT ?
    `).all(limit) as SqlRow[];
    return rows.map((row) => this.readOperation(requiredString(row, "operation_id"))!);
  }

  /** Direct loop/branch queue state; no event or operation-history scan. */
  readStructuredQueue(operationId: string): StructuredQueueProjection | undefined {
    this.assertOpen();
    const operation = this.readOperation(operationId);
    if (!operation) return undefined;
    if (operation.kind !== "loop" && operation.kind !== "parallel" && operation.kind !== "fan-out") {
      throw new TypeError(`Operation ${operationId} is not a structured queue`);
    }
    const rows = this.database.prepare(
      "SELECT * FROM operations WHERE parent_operation_id = ? ORDER BY ordinal",
    ).all(operationId) as SqlRow[];
    const children = rows.map((row) => this.operationFromRow(row));
    const counts: Partial<Record<OperationStatus, number>> = {};
    for (const child of children) counts[child.status] = (counts[child.status] ?? 0) + 1;
    return { operation, children, counts };
  }

  readAttempt(attemptId: string): AttemptRecord | undefined {
    this.assertOpen();
    assertIdentifier(attemptId, "attempt id");
    const row = this.database.prepare("SELECT * FROM attempts WHERE attempt_id = ?").get(attemptId) as SqlRow | undefined;
    if (!row) return undefined;
    const outputArtifacts = this.edgeArtifactRefs("attempt_artifacts", "attempt_id", attemptId, "output");
    const attempt: AttemptRecord = {
      attemptId,
      runId: requiredString(row, "run_id"),
      operationId: requiredString(row, "operation_id"),
      number: requiredNumber(row, "number"),
      effect: requiredString(row, "effect") as AttemptRecord["effect"],
      ...(optionalString(row, "execution_id") ? { executionId: optionalString(row, "execution_id")! } : {}),
      status: requiredString(row, "status") as AttemptRecord["status"],
      ...(rowReason(row) ? { reason: rowReason(row)! } : {}),
      ...(rowWorkspace(row, "pre_workspace") ? { preWorkspace: rowWorkspace(row, "pre_workspace")! } : {}),
      ...(optionalString(row, "post_workspace_checkpoint_id") ? { postWorkspaceCheckpointId: optionalString(row, "post_workspace_checkpoint_id")! } : {}),
      usage: rowUsage(row),
      ...(rowResources(row) ? { resources: rowResources(row)! } : {}),
      outputArtifacts,
      ...(optionalString(row, "started_at") ? { startedAt: optionalString(row, "started_at")! } : {}),
      updatedAt: requiredString(row, "updated_at"),
      ...(optionalString(row, "ended_at") ? { endedAt: optionalString(row, "ended_at")! } : {}),
    };
    assertAttempt(attempt);
    return attempt;
  }

  readCandidateWorkspace(workspaceId: string): CandidateWorkspaceRecord | undefined {
    this.assertOpen();
    assertIdentifier(workspaceId, "candidate workspace id");
    const row = this.database.prepare(
      "SELECT * FROM candidate_workspaces WHERE workspace_id = ?",
    ).get(workspaceId) as SqlRow | undefined;
    if (!row) return undefined;
    const writeScope = decodeCanonicalJson(requiredString(row, "write_scope_json")) as CandidateWorkspaceRecord["writeScope"];
    const lineageHash = requiredString(row, "lineage_hash");
    const writeScopeHash = requiredString(row, "write_scope_hash");
    const rootPath = requiredString(row, "root_path");
    const createdAt = requiredString(row, "created_at");
    assertHash(lineageHash, "candidate workspace lineage hash");
    assertHash(writeScopeHash, "candidate workspace write-scope hash");
    if (
      writeScope !== "all-semantic-project-paths"
      && (!writeScope || !Array.isArray(writeScope.allow) || writeScope.allow.some((rule) => typeof rule !== "string")
        || (writeScope.deny !== undefined && (!Array.isArray(writeScope.deny) || writeScope.deny.some((rule) => typeof rule !== "string"))))
    ) throw new RunDatabaseCorruptionError(`Candidate workspace ${workspaceId} has an invalid write scope`);
    if (stableHash(writeScope) !== writeScopeHash) throw new RunDatabaseCorruptionError(`Candidate workspace ${workspaceId} has a corrupt write scope`);
    if (rootPath !== `workspaces/candidates/${workspaceId}/project`) throw new RunDatabaseCorruptionError(`Candidate workspace ${workspaceId} has a noncanonical path`);
    assertIsoDate(createdAt, "candidate workspace createdAt");
    const record: CandidateWorkspaceRecord = {
      workspaceId,
      runId: requiredString(row, "run_id"),
      logicalId: requiredString(row, "logical_id"),
      ...(optionalString(row, "parent_candidate_id")
        ? { parentCandidateId: optionalString(row, "parent_candidate_id")! }
        : {}),
      workspace: {
        kind: "candidate",
        workspaceId,
        treeHash: requiredString(row, "initial_tree_hash"),
        lineageHash,
        writeScopeHash,
      },
      writeScope,
      rootPath,
      createdAt,
    };
    assertWorkspace(record.workspace);
    return record;
  }

  readWorkspaceCheckpoint(checkpointId: string): WorkspaceCheckpointRecord | undefined {
    this.assertOpen();
    assertIdentifier(checkpointId, "workspace checkpoint id");
    const row = this.database.prepare(
      "SELECT * FROM workspace_checkpoints WHERE checkpoint_id = ?",
    ).get(checkpointId) as SqlRow | undefined;
    if (!row) return undefined;
    const storagePath = requiredString(row, "storage_path");
    const createdAt = requiredString(row, "created_at");
    if (storagePath !== `workspaces/checkpoints/${checkpointId}`) throw new RunDatabaseCorruptionError(`Workspace checkpoint ${checkpointId} has a noncanonical path`);
    assertIsoDate(createdAt, "workspace checkpoint createdAt");
    const checkpoint: WorkspaceCheckpointRecord = {
      checkpointId,
      runId: requiredString(row, "run_id"),
      operationId: requiredString(row, "operation_id"),
      workspace: {
        kind: "candidate",
        workspaceId: requiredString(row, "workspace_id"),
        treeHash: requiredString(row, "tree_hash"),
        ...(optionalString(row, "lineage_hash") ? { lineageHash: optionalString(row, "lineage_hash")! } : {}),
        ...(optionalString(row, "write_scope_hash") ? { writeScopeHash: optionalString(row, "write_scope_hash")! } : {}),
      },
      storagePath,
      createdAt,
    };
    assertWorkspace(checkpoint.workspace);
    return checkpoint;
  }

  listWorkspaceCheckpoints(limitValue = 256): WorkspaceCheckpointRecord[] {
    this.assertOpen();
    const limit = pageLimit(limitValue);
    const rows = this.database.prepare(
      "SELECT checkpoint_id FROM workspace_checkpoints ORDER BY created_at, checkpoint_id LIMIT ?",
    ).all(limit) as SqlRow[];
    return rows.map((row) => this.readWorkspaceCheckpoint(requiredString(row, "checkpoint_id"))!);
  }

  listWorkspaceCheckpointIds(): string[] {
    this.assertOpen();
    const rows = this.database.prepare(
      "SELECT checkpoint_id FROM workspace_checkpoints ORDER BY checkpoint_id LIMIT 10001",
    ).all() as SqlRow[];
    if (rows.length > 10_000) throw new RunDatabaseCorruptionError("Workspace checkpoint count exceeds its safety bound");
    return rows.map((row) => requiredString(row, "checkpoint_id"));
  }

  readCandidate(candidateId: string): CandidateRecord | undefined {
    this.assertOpen();
    assertIdentifier(candidateId, "candidate id");
    const row = this.database.prepare("SELECT * FROM candidates WHERE candidate_id = ?").get(candidateId) as SqlRow | undefined;
    if (!row) return undefined;
    const changedPaths = (this.database.prepare(
      "SELECT path FROM candidate_changed_paths WHERE candidate_id = ? ORDER BY ordinal",
    ).all(candidateId) as SqlRow[]).map((entry) => requiredString(entry, "path"));
    let previous: string | undefined;
    for (const changedPath of changedPaths) {
      if (changedPath.startsWith("/") || changedPath.split("/").some((part) => !part || part === "." || part === "..")) {
        throw new RunDatabaseCorruptionError(`Candidate ${candidateId} has an unsafe changed path`);
      }
      if (previous !== undefined && Buffer.compare(Buffer.from(previous), Buffer.from(changedPath)) >= 0) {
        throw new RunDatabaseCorruptionError(`Candidate ${candidateId} paths are not uniquely sorted`);
      }
      previous = changedPath;
    }
    const frozenAt = requiredString(row, "frozen_at");
    assertIsoDate(frozenAt, "candidate frozenAt");
    const candidate: CandidateRecord = {
      candidateId,
      runId: requiredString(row, "run_id"),
      ...(optionalString(row, "parent_candidate_id")
        ? { parentCandidateId: optionalString(row, "parent_candidate_id")! }
        : {}),
      workspace: {
        kind: "candidate",
        workspaceId: requiredString(row, "workspace_id"),
        treeHash: requiredString(row, "tree_hash"),
        ...(optionalString(row, "lineage_hash") ? { lineageHash: optionalString(row, "lineage_hash")! } : {}),
        ...(optionalString(row, "write_scope_hash") ? { writeScopeHash: optionalString(row, "write_scope_hash")! } : {}),
      },
      changedPaths,
      manifest: this.requiredArtifactRef(requiredString(row, "manifest_artifact_digest")),
      diff: this.requiredArtifactRef(requiredString(row, "diff_artifact_digest")),
      frozenAt,
    };
    assertWorkspace(candidate.workspace);
    if (!candidate.workspace.lineageHash || !candidate.workspace.writeScopeHash) {
      throw new RunDatabaseCorruptionError(`Candidate ${candidateId} lacks apply authority`);
    }
    return candidate;
  }

  readMeasurement(measurementId: string): MeasurementRecord | undefined {
    this.assertOpen();
    return readMeasurementRow(this.database, measurementId);
  }

  readMeasurementByOperation(operationId: string): MeasurementRecord | undefined {
    this.assertOpen();
    return readMeasurementByOperationRow(this.database, operationId);
  }

  listMeasurements(limitValue = 256): MeasurementRecord[] {
    this.assertOpen();
    return listMeasurementRows(this.database, limitValue);
  }

  /** Keyset page backed by measurements_run_ended. */
  listMeasurementsPage(options: {
    after?: { endedAt: string; measurementId: string };
    limit?: number;
  } = {}): MeasurementRecord[] {
    this.assertOpen();
    const limit = pageLimit(options.limit);
    const rows = options.after
      ? this.database.prepare(`
          SELECT measurement_id FROM measurements
          WHERE run_id = (SELECT run_id FROM runs WHERE singleton = 1)
            AND ((ended_at > ?) OR (ended_at = ? AND measurement_id > ?))
          ORDER BY ended_at, measurement_id LIMIT ?
        `).all(options.after.endedAt, options.after.endedAt, options.after.measurementId, limit) as SqlRow[]
      : this.database.prepare(
          "SELECT measurement_id FROM measurements WHERE run_id = (SELECT run_id FROM runs WHERE singleton = 1) ORDER BY ended_at, measurement_id LIMIT ?",
        ).all(limit) as SqlRow[];
    return rows.map((row) => this.readMeasurement(requiredString(row, "measurement_id"))!);
  }

  readMetric(metricId: string): PersistedMetricState | undefined {
    this.assertOpen();
    return readMetricRow(this.database, this.readRun().runId, metricId);
  }

  listMetrics(): PersistedMetricState[] {
    this.assertOpen();
    return listMetricRows(this.database, this.readRun().runId);
  }

  listMetricsPage(options: { afterMetricId?: string; limit?: number } = {}): PersistedMetricState[] {
    this.assertOpen();
    return listMetricPageRows(
      this.database,
      this.readRun().runId,
      options.afterMetricId ?? "",
      pageLimit(options.limit),
    );
  }

  readExperiment(experimentId: string): ExperimentRecord | undefined {
    this.assertOpen();
    return readExperimentRow(this.database, experimentId);
  }

  readExperimentByOperation(operationId: string): ExperimentRecord | undefined {
    this.assertOpen();
    return readExperimentByOperationRow(this.database, operationId);
  }

  listExperiments(limitValue = 256): ExperimentRecord[] {
    this.assertOpen();
    return listExperimentRows(this.database, limitValue);
  }

  readVerification(verificationId: string): VerificationRecord | undefined {
    this.assertOpen();
    return readVerificationRow(this.database, verificationId);
  }

  readVerificationByOperation(operationId: string): VerificationRecord | undefined {
    this.assertOpen();
    return readVerificationByOperationRow(this.database, operationId);
  }

  readApplyPlan(planId: string): ApplyPlanRecord | undefined {
    this.assertOpen();
    return readApplyPlanRow(this.database, planId);
  }

  readApplyPlanByOperation(operationId: string): ApplyPlanRecord | undefined {
    this.assertOpen();
    return readApplyPlanByOperationRow(this.database, operationId);
  }

  readApplyReceipt(planId: string): ApplyReceiptRecord | undefined {
    this.assertOpen();
    return readApplyReceiptRow(this.database, planId);
  }

  readApproval(approvalId: string): ApprovalRecord | undefined {
    this.assertOpen();
    return readApprovalRow(this.database, approvalId);
  }

  readHumanCheckpoint(checkpointId: string): HumanCheckpointRecord | undefined {
    this.assertOpen();
    assertIdentifier(checkpointId, "human checkpoint id");
    const row = this.database.prepare(
      "SELECT * FROM human_checkpoints WHERE checkpoint_id = ?",
    ).get(checkpointId) as SqlRow | undefined;
    return row ? humanCheckpointFromRow(row) : undefined;
  }

  listHumanCheckpoints(options: {
    status?: HumanCheckpointRecord["status"];
    after?: { requestedAt: string; checkpointId: string };
    limit?: number;
  } = {}): HumanCheckpointRecord[] {
    this.assertOpen();
    const limit = pageLimit(options.limit);
    const status = options.status;
    const after = options.after;
    const clauses = ["run_id = (SELECT run_id FROM runs WHERE singleton = 1)"];
    const values: Array<string | number> = [];
    if (status) { clauses.push("status = ?"); values.push(status); }
    if (after) {
      clauses.push("((requested_at > ?) OR (requested_at = ? AND checkpoint_id > ?))");
      values.push(after.requestedAt, after.requestedAt, after.checkpointId);
    }
    const rows = this.database.prepare(`
      SELECT * FROM human_checkpoints WHERE ${clauses.join(" AND ")}
      ORDER BY requested_at, checkpoint_id LIMIT ?
    `).all(...values, limit) as SqlRow[];
    return rows.map(humanCheckpointFromRow);
  }

  listApprovals(options: {
    status?: ApprovalRecord["status"];
    after?: { requestedAt: string; approvalId: string };
    limit?: number;
  } = {}): ApprovalRecord[] {
    this.assertOpen();
    const limit = pageLimit(options.limit);
    const status = options.status;
    const after = options.after;
    const clauses = ["run_id = (SELECT run_id FROM runs WHERE singleton = 1)"];
    const values: Array<string | number> = [];
    if (status) { clauses.push("status = ?"); values.push(status); }
    if (after) {
      clauses.push("((requested_at > ?) OR (requested_at = ? AND approval_id > ?))");
      values.push(after.requestedAt, after.requestedAt, after.approvalId);
    }
    const rows = this.database.prepare(`
      SELECT approval_id FROM approvals WHERE ${clauses.join(" AND ")}
      ORDER BY requested_at, approval_id LIMIT ?
    `).all(...values, limit) as SqlRow[];
    return rows.map((row) => this.readApproval(requiredString(row, "approval_id"))!);
  }

  readLatestApproval(): ApprovalRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare(
      "SELECT approval_id FROM approvals ORDER BY requested_at DESC, approval_id DESC LIMIT 1",
    ).get() as SqlRow | undefined;
    return row ? this.readApproval(requiredString(row, "approval_id")) : undefined;
  }

  listCandidates(options: {
    after?: { frozenAt: string; candidateId: string };
    limit?: number;
  } = {}): CandidateRecord[] {
    this.assertOpen();
    const limit = pageLimit(options.limit);
    const rows = options.after
      ? this.database.prepare(`
          SELECT candidate_id FROM candidates
          WHERE (frozen_at > ?) OR (frozen_at = ? AND candidate_id > ?)
          ORDER BY frozen_at, candidate_id LIMIT ?
        `).all(options.after.frozenAt, options.after.frozenAt, options.after.candidateId, limit) as SqlRow[]
      : this.database.prepare(
          "SELECT candidate_id FROM candidates ORDER BY frozen_at, candidate_id LIMIT ?",
        ).all(limit) as SqlRow[];
    return rows.map((row) => this.readCandidate(requiredString(row, "candidate_id"))!);
  }

  readLatestCandidate(): CandidateRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare(
      "SELECT candidate_id FROM candidates ORDER BY frozen_at DESC, candidate_id DESC LIMIT 1",
    ).get() as SqlRow | undefined;
    return row ? this.readCandidate(requiredString(row, "candidate_id")) : undefined;
  }

  readWorkflowCall(operationId: string): WorkflowCallRecord | undefined {
    this.assertOpen();
    assertIdentifier(operationId, "operation id");
    const row = this.database.prepare("SELECT * FROM workflow_calls WHERE operation_id = ?").get(operationId) as SqlRow | undefined;
    if (!row) return undefined;
    const workspace = rowWorkspace(row, "result_workspace");
    const valueSource = optionalString(row, "result_value_json");
    const artifacts = (this.database.prepare(`
      SELECT artifact.* FROM workflow_call_artifacts edge
      JOIN artifacts artifact ON artifact.digest = edge.artifact_digest
      WHERE edge.operation_id = ? ORDER BY edge.ordinal
    `).all(operationId) as SqlRow[]).map((artifactRow) => {
      const artifact = artifactFromRow(artifactRow);
      return { digest: artifact.digest, kind: artifact.kind, mediaType: artifact.mediaType, bytes: artifact.bytes };
    });
    const result: OperationResult = {
      ...(valueSource !== undefined ? { value: decodeCanonicalJson<JsonValue>(valueSource, "value") } : {}),
      artifacts,
      ...(workspace ? { workspace } : {}),
    };
    const call: WorkflowCallRecord = {
      runId: requiredString(row, "run_id"),
      operationId,
      ordinal: requiredNumber(row, "ordinal"),
      previousJournalKey: requiredString(row, "previous_journal_key"),
      semanticKey: requiredString(row, "semantic_key"),
      callKey: requiredString(row, "call_key"),
      completionAuthority: requiredString(row, "completion_authority") as WorkflowCallRecord["completionAuthority"],
      replayPolicy: requiredString(row, "replay_policy") as WorkflowCallRecord["replayPolicy"],
      result,
      ...(optionalString(row, "post_workspace_checkpoint_id")
        ? { postWorkspaceCheckpointId: optionalString(row, "post_workspace_checkpoint_id")! }
        : {}),
      committedAt: requiredString(row, "committed_at"),
    };
    assertHash(call.previousJournalKey, "workflow call previous key");
    assertHash(call.semanticKey, "workflow call semantic key");
    assertHash(call.callKey, "workflow call key");
    assertIsoDate(call.committedAt, "workflow call commit time");
    if (call.completionAuthority !== "finish-work" && call.completionAuthority !== "host-effect") {
      throw new RunDatabaseCorruptionError(`Workflow call ${operationId} has invalid completion authority`);
    }
    if (call.replayPolicy !== "immutable" && call.replayPolicy !== "workspace" && call.replayPolicy !== "never") {
      throw new RunDatabaseCorruptionError(`Workflow call ${operationId} has invalid replay policy`);
    }
    if (call.replayPolicy === "workspace") {
      if (!call.postWorkspaceCheckpointId || call.result.workspace?.kind !== "candidate") {
        throw new RunDatabaseCorruptionError(`Workflow call ${operationId} has ambiguous workspace replay state`);
      }
    } else if (call.postWorkspaceCheckpointId || call.result.workspace) {
      throw new RunDatabaseCorruptionError(`Workflow call ${operationId} has undeclared workspace replay state`);
    }
    return call;
  }

  listWorkflowCalls(options: { afterOrdinal?: number; limit?: number } = {}): WorkflowCallRecord[] {
    this.assertOpen();
    const limit = pageLimit(options.limit);
    const after = options.afterOrdinal ?? -1;
    if (!Number.isSafeInteger(after) || after < -1) throw new TypeError("Invalid workflow journal cursor");
    const rows = this.database.prepare(
      "SELECT operation_id FROM workflow_calls WHERE ordinal > ? ORDER BY ordinal LIMIT ?",
    ).all(after, limit) as SqlRow[];
    return rows.map((row) => this.readWorkflowCall(requiredString(row, "operation_id"))!);
  }

  readLastWorkflowCall(): WorkflowCallRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare(
      "SELECT operation_id FROM workflow_calls ORDER BY ordinal DESC LIMIT 1",
    ).get() as SqlRow | undefined;
    return row ? this.readWorkflowCall(requiredString(row, "operation_id")) : undefined;
  }

  listEvents(options: { afterSequence?: number; limit?: number } = {}): RunEvent[] {
    this.assertOpen();
    const limit = pageLimit(options.limit);
    const after = options.afterSequence ?? 0;
    if (!Number.isSafeInteger(after) || after < 0) throw new TypeError("Invalid event cursor");
    return (this.database.prepare(
      "SELECT * FROM events WHERE run_id = (SELECT run_id FROM runs WHERE singleton = 1) AND sequence > ? ORDER BY sequence LIMIT ?",
    ).all(after, limit) as SqlRow[]).map((row) => ({
      runId: requiredString(row, "run_id"),
      sequence: requiredNumber(row, "sequence"),
      revision: requiredNumber(row, "revision"),
      type: requiredString(row, "type"),
      ...(optionalString(row, "operation_id") ? { operationId: optionalString(row, "operation_id")! } : {}),
      ...(optionalString(row, "attempt_id") ? { attemptId: optionalString(row, "attempt_id")! } : {}),
      payload: decodeCanonicalJson(requiredString(row, "payload_json")),
      at: requiredString(row, "at"),
    }));
  }

  listArtifacts(options: { afterDigest?: string; limit?: number } = {}): ArtifactRecord[] {
    this.assertOpen();
    const limit = pageLimit(options.limit);
    const after = options.afterDigest ?? "";
    return (this.database.prepare(
      "SELECT * FROM artifacts WHERE digest > ? ORDER BY digest LIMIT ?",
    ).all(after, limit) as SqlRow[]).map(artifactFromRow);
  }

  /** Chronological keyset page backed by artifacts_run_created. */
  listArtifactsPage(options: {
    after?: { createdAt: string; digest: string };
    limit?: number;
  } = {}): ArtifactRecord[] {
    this.assertOpen();
    const limit = pageLimit(options.limit);
    const rows = options.after
      ? this.database.prepare(`
          SELECT * FROM artifacts
          WHERE run_id = (SELECT run_id FROM runs WHERE singleton = 1)
            AND ((created_at > ?) OR (created_at = ? AND digest > ?))
          ORDER BY created_at, digest LIMIT ?
        `).all(options.after.createdAt, options.after.createdAt, options.after.digest, limit) as SqlRow[]
      : this.database.prepare(`
          SELECT * FROM artifacts
          WHERE run_id = (SELECT run_id FROM runs WHERE singleton = 1)
          ORDER BY created_at, digest LIMIT ?
        `).all(limit) as SqlRow[];
    return rows.map(artifactFromRow);
  }

  readArtifact(digest: string): ArtifactRecord | undefined {
    this.assertOpen();
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new TypeError("Invalid artifact digest");
    const row = this.database.prepare("SELECT * FROM artifacts WHERE digest = ?").get(digest) as SqlRow | undefined;
    return row ? artifactFromRow(row) : undefined;
  }

  readAgentSession(agentSessionId: string): AgentSessionRecord | undefined {
    this.assertOpen();
    assertIdentifier(agentSessionId, "agent session id");
    const row = this.database.prepare("SELECT * FROM agent_sessions WHERE agent_session_id = ?").get(agentSessionId) as SqlRow | undefined;
    return row ? this.agentSessionFromRow(row) : undefined;
  }

  readAgentSessionByOperation(operationId: string): AgentSessionRecord | undefined {
    this.assertOpen();
    assertIdentifier(operationId, "agent operation id");
    const row = this.database.prepare(
      "SELECT * FROM agent_sessions WHERE operation_id = ?",
    ).get(operationId) as SqlRow | undefined;
    return row ? this.agentSessionFromRow(row) : undefined;
  }

  readAgentToolReceipt(agentSessionId: string, toolCallId: string): AgentToolReceiptRecord | undefined {
    this.assertOpen();
    assertIdentifier(agentSessionId, "agent session id");
    assertAgentToolCallId(toolCallId);
    const row = this.database.prepare(
      "SELECT * FROM agent_tool_receipts WHERE agent_session_id = ? AND tool_call_id = ?",
    ).get(agentSessionId, toolCallId) as SqlRow | undefined;
    return row ? agentToolReceiptFromRow(row) : undefined;
  }

  readAgentMediatedToolIntent(
    agentSessionId: string,
    toolCallId: string,
  ): AgentMediatedToolIntentRecord | undefined {
    this.assertOpen();
    assertIdentifier(agentSessionId, "agent session id");
    assertAgentToolCallId(toolCallId);
    const row = this.database.prepare(
      "SELECT * FROM agent_mediated_tool_intents WHERE agent_session_id = ? AND tool_call_id = ?",
    ).get(agentSessionId, toolCallId) as SqlRow | undefined;
    return row ? agentMediatedToolIntentFromRow(row) : undefined;
  }

  readUnsettledAgentMediatedToolIntent(agentSessionId: string): AgentMediatedToolIntentRecord | undefined {
    this.assertOpen();
    assertIdentifier(agentSessionId, "agent session id");
    const row = this.database.prepare(`
      SELECT * FROM agent_mediated_tool_intents
      WHERE agent_session_id = ? AND status != 'completed'
      ORDER BY started_at, tool_call_id LIMIT 1
    `).get(agentSessionId) as SqlRow | undefined;
    return row ? agentMediatedToolIntentFromRow(row) : undefined;
  }

  listAgentToolReceipts(agentSessionId: string): AgentToolReceiptRecord[] {
    this.assertOpen();
    assertIdentifier(agentSessionId, "agent session id");
    return (this.database.prepare(
      "SELECT * FROM agent_tool_receipts WHERE agent_session_id = ? ORDER BY committed_at, tool_call_id",
    ).all(agentSessionId) as SqlRow[]).map(agentToolReceiptFromRow);
  }

  listAgentProgress(agentSessionId: string, options: { afterSequence?: number; limit?: number } = {}): AgentProgressRecord[] {
    this.assertOpen();
    assertIdentifier(agentSessionId, "agent session id");
    const limit = pageLimit(options.limit);
    const after = options.afterSequence ?? 0;
    if (!Number.isSafeInteger(after) || after < 0) throw new TypeError("Invalid progress cursor");
    return (this.database.prepare(
      "SELECT * FROM agent_progress_history WHERE agent_session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
    ).all(agentSessionId, after, limit) as SqlRow[]).map((row) => ({
      sequence: requiredNumber(row, "sequence"),
      runId: requiredString(row, "run_id"),
      operationId: requiredString(row, "operation_id"),
      agentSessionId: requiredString(row, "agent_session_id"),
      at: requiredString(row, "at"),
      event: decodeCanonicalJson(requiredString(row, "event_json"), "value") as unknown as AgentProgressRecord["event"],
    }));
  }

  /** Run-wide log page backed by the (run_id, sequence) primary key. */
  listAgentProgressHistory(options: { afterSequence?: number; limit?: number } = {}): AgentProgressRecord[] {
    this.assertOpen();
    const limit = pageLimit(options.limit);
    const after = options.afterSequence ?? 0;
    if (!Number.isSafeInteger(after) || after < 0) throw new TypeError("Invalid progress cursor");
    return (this.database.prepare(`
      SELECT * FROM agent_progress_history
      WHERE run_id = (SELECT run_id FROM runs WHERE singleton = 1) AND sequence > ?
      ORDER BY sequence LIMIT ?
    `).all(after, limit) as SqlRow[]).map((row) => ({
      sequence: requiredNumber(row, "sequence"),
      runId: requiredString(row, "run_id"),
      operationId: requiredString(row, "operation_id"),
      agentSessionId: requiredString(row, "agent_session_id"),
      at: requiredString(row, "at"),
      event: decodeCanonicalJson(requiredString(row, "event_json"), "value") as unknown as AgentProgressRecord["event"],
    }));
  }

  /** Small visible window backed by (session, visible, sequence), never transcript history. */
  listRecentAgentProgress(agentSessionId: string, limitValue: number = AGENT_PROGRESS_LIMITS.recentWindow): AgentRecentProgress[] {
    this.assertOpen();
    assertIdentifier(agentSessionId, "agent session id");
    const limit = recentProgressLimit(limitValue);
    const rows = this.database.prepare(`
      SELECT sequence, at, type, event_json
      FROM agent_progress_history
      WHERE agent_session_id = ? AND visible = 1
      ORDER BY sequence DESC
      LIMIT ?
    `).all(agentSessionId, limit) as SqlRow[];
    return rows.reverse().map(recentProgressFromRow);
  }

  projectActiveAgentProgress(options: {
    limit?: number;
    recentLimit?: number;
    now?: Date;
  } = {}): AgentLiveProgressProjection[] {
    const limit = activeAgentLimit(options.limit ?? 64);
    const recentLimit = recentProgressLimit(options.recentLimit ?? AGENT_PROGRESS_LIMITS.recentWindow);
    const now = projectionTime(options.now);
    return this.readSnapshot((reader) => reader.activeAgentProgressRows(limit, recentLimit, now));
  }

  /** Use inside readSnapshot when several projection queries must share one WAL snapshot. */
  readActiveAgentProgress(options: {
    limit?: number;
    recentLimit?: number;
    now?: Date;
  } = {}): AgentLiveProgressProjection[] {
    this.assertOpen();
    return this.activeAgentProgressRows(
      activeAgentLimit(options.limit ?? 64),
      recentProgressLimit(options.recentLimit ?? AGENT_PROGRESS_LIMITS.recentWindow),
      projectionTime(options.now),
    );
  }

  listOperationArtifacts(
    operationId: string,
    role: "input" | "output" | "evidence" | "progress",
  ): ArtifactRef[] {
    this.assertOpen();
    assertIdentifier(operationId, "operation id");
    return this.edgeArtifactRefs("operation_artifacts", "operation_id", operationId, role);
  }

  listPendingControlRequests(limitValue = 64): ControlRequest[] {
    this.assertOpen();
    const limit = pageLimit(limitValue);
    return (this.database.prepare(`
      SELECT request.* FROM control_requests request
      LEFT JOIN control_acknowledgements ack ON ack.request_id = request.request_id
      WHERE ack.request_id IS NULL
      ORDER BY request.inbox_sequence
      LIMIT ?
    `).all(limit) as SqlRow[]).map(controlRequestFromRow);
  }

  countPendingControlRequests(): number {
    this.assertOpen();
    return requiredNumber(this.database.prepare(`
      SELECT count(*) AS value FROM control_requests request
      LEFT JOIN control_acknowledgements ack ON ack.request_id = request.request_id
      WHERE ack.request_id IS NULL
    `).get() as SqlRow, "value");
  }

  latestEventSequence(): number {
    this.assertOpen();
    return requiredNumber(
      this.database.prepare("SELECT coalesce(max(sequence), 0) AS value FROM events").get() as SqlRow,
      "value",
    );
  }

  readControlRequest(requestId: string): ControlRequest | undefined {
    this.assertOpen();
    assertIdentifier(requestId, "control request id");
    const row = this.database.prepare(
      "SELECT * FROM control_requests WHERE request_id = ?",
    ).get(requestId) as SqlRow | undefined;
    return row ? controlRequestFromRow(row) : undefined;
  }

  readControlAcknowledgement(requestId: string): ControlAcknowledgement | undefined {
    this.assertOpen();
    assertIdentifier(requestId, "control request id");
    const row = this.database.prepare(
      "SELECT * FROM control_acknowledgements WHERE request_id = ?",
    ).get(requestId) as SqlRow | undefined;
    return row ? {
      requestId,
      runId: requiredString(row, "run_id"),
      accepted: requiredNumber(row, "accepted") === 1,
      revision: requiredNumber(row, "revision"),
      ...(rowReason(row) ? { reason: rowReason(row)! } : {}),
      acknowledgedAt: requiredString(row, "acknowledged_at"),
    } : undefined;
  }

  protected assertOpen(): void {
    if (this.closed) throw new Error("Run database connection is closed");
  }

  private activeAgentProgressRows(limit: number, recentLimit: number, now: Date): AgentLiveProgressProjection[] {
    const runId = this.readRun().runId;
    const rows = this.database.prepare(`
      SELECT * FROM agent_sessions
      WHERE run_id = ? AND status IN ('queued', 'running', 'waiting', 'paused')
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(runId, limit) as SqlRow[];
    return rows.map((row) => this.liveAgentProgressFromRow(row, recentLimit, now));
  }

  private liveAgentProgressFromRow(row: SqlRow, recentLimit: number, now: Date): AgentLiveProgressProjection {
    const session = this.agentSessionFromRow(row);
    const accrues = session.status === "queued" || session.status === "running" || session.status === "waiting";
    const end = accrues ? now.getTime() : Date.parse(session.updatedAt);
    const elapsedMs = Math.max(session.progress.usage.elapsedMs, Math.max(0, Math.floor(end - Date.parse(session.createdAt))));
    return {
      session,
      elapsedMs,
      automaticMetrics: automaticAgentMetrics(session.progress, elapsedMs),
      recent: this.listRecentAgentProgress(session.agentSessionId, recentLimit),
    };
  }

  private operationFromRow(row: SqlRow): OperationRecord {
    const operationId = requiredString(row, "operation_id");
    const artifacts = this.edgeArtifactRefs("operation_artifacts", "operation_id", operationId, "output");
    const workspace = rowWorkspace(row, "result_workspace");
    const valueSource = optionalString(row, "result_value_json");
    const hasResult = requiredNumber(row, "result_present") === 1;
    const result: OperationResult | undefined = hasResult ? {
      ...(valueSource !== undefined ? { value: decodeCanonicalJson<JsonValue>(valueSource, "value") } : {}),
      artifacts,
      ...(workspace ? { workspace } : {}),
    } : undefined;
    const replayRow = this.database.prepare("SELECT * FROM operation_replays WHERE operation_id = ?").get(operationId) as SqlRow | undefined;
    const operation: OperationRecord = {
      operationId,
      runId: requiredString(row, "run_id"),
      ...(optionalString(row, "parent_operation_id") ? { parentOperationId: optionalString(row, "parent_operation_id")! } : {}),
      path: requiredString(row, "path"),
      sourceId: requiredString(row, "source_id"),
      kind: requiredString(row, "kind") as OperationRecord["kind"],
      ordinal: requiredNumber(row, "ordinal"),
      status: requiredString(row, "status") as OperationRecord["status"],
      ...(rowReason(row) ? { reason: rowReason(row)! } : {}),
      semanticInputHash: requiredString(row, "semantic_input_hash"),
      ...(optionalString(row, "call_key") ? { callKey: optionalString(row, "call_key")! } : {}),
      attemptCount: requiredNumber(row, "attempt_count"),
      ...(result ? { result } : {}),
      ...(replayRow ? {
        replay: {
          sourceRunId: requiredString(replayRow, "source_run_id"),
          sourceOperationId: requiredString(replayRow, "source_operation_id"),
          ordinal: requiredNumber(replayRow, "ordinal"),
          callKey: requiredString(replayRow, "call_key"),
          ...(optionalString(replayRow, "restored_workspace_checkpoint_id")
            ? { restoredWorkspaceCheckpointId: optionalString(replayRow, "restored_workspace_checkpoint_id")! }
            : {}),
        },
      } : {}),
      createdAt: requiredString(row, "created_at"),
      ...(optionalString(row, "started_at") ? { startedAt: optionalString(row, "started_at")! } : {}),
      updatedAt: requiredString(row, "updated_at"),
      ...(optionalString(row, "ended_at") ? { endedAt: optionalString(row, "ended_at")! } : {}),
    };
    assertOperation(operation);
    return operation;
  }

  private requiredArtifactRef(digest: string): ArtifactRef {
    const row = this.database.prepare("SELECT * FROM artifacts WHERE digest = ?").get(digest) as SqlRow | undefined;
    if (!row) throw new RunDatabaseCorruptionError(`Missing artifact ${digest}`);
    const record = artifactFromRow(row);
    return { digest: record.digest, kind: record.kind, mediaType: record.mediaType, bytes: record.bytes };
  }

  private edgeArtifactRefs(table: "operation_artifacts" | "attempt_artifacts", key: "operation_id" | "attempt_id", id: string, role: string): ArtifactRef[] {
    const rows = this.database.prepare(`
      SELECT artifact.* FROM ${table} edge
      JOIN artifacts artifact ON artifact.digest = edge.artifact_digest
      WHERE edge.${key} = ? AND edge.role = ?
      ORDER BY edge.ordinal
    `).all(id, role) as SqlRow[];
    return rows.map((row) => {
      const artifact = artifactFromRow(row);
      return { digest: artifact.digest, kind: artifact.kind, mediaType: artifact.mediaType, bytes: artifact.bytes };
    });
  }

  private agentSessionFromRow(row: SqlRow): AgentSessionRecord {
    const agentSessionId = requiredString(row, "agent_session_id");
    const progressRow = this.database.prepare(
      "SELECT * FROM agent_progress_current WHERE agent_session_id = ?",
    ).get(agentSessionId) as SqlRow | undefined;
    if (!progressRow) throw new RunDatabaseCorruptionError(`Agent session ${agentSessionId} has no current progress row`);
    const metricRows = this.database.prepare(
      "SELECT * FROM agent_progress_current_metrics WHERE agent_session_id = ? ORDER BY ordinal",
    ).all(agentSessionId) as SqlRow[];
    const pathRows = this.database.prepare(
      "SELECT path FROM agent_progress_current_paths WHERE agent_session_id = ? ORDER BY ordinal",
    ).all(agentSessionId) as SqlRow[];
    const progress: AgentProgress = {
      ...(optionalString(progressRow, "message") ? { message: optionalString(progressRow, "message")! } : {}),
      ...(optionalNumber(progressRow, "current_value") !== undefined ? { current: optionalNumber(progressRow, "current_value")! } : {}),
      ...(optionalNumber(progressRow, "total_value") !== undefined ? { total: optionalNumber(progressRow, "total_value")! } : {}),
      metrics: metricRows.map((metric) => ({
        name: requiredString(metric, "name"),
        value: requiredNumber(metric, "value"),
        ...(optionalString(metric, "unit") ? { unit: optionalString(metric, "unit")! } : {}),
      })),
      usage: rowUsage(progressRow),
      modelTurn: requiredNumber(progressRow, "model_turn"),
      ...(optionalString(progressRow, "current_tool") ? { currentTool: optionalString(progressRow, "current_tool")! } : {}),
      toolCount: requiredNumber(progressRow, "tool_count"),
      retries: requiredNumber(progressRow, "retries"),
      workspaceChanged: requiredNumber(progressRow, "workspace_changed") === 1,
      workspaceChangeCount: requiredNumber(progressRow, "workspace_change_count"),
      recentWorkspaceChanges: pathRows.map((entry) => requiredString(entry, "path")),
      ...(rowResources(progressRow) ? { resources: rowResources(progressRow)! } : {}),
      updatedAt: requiredString(progressRow, "updated_at"),
    };
    const finishToolCallId = optionalString(row, "finish_tool_call_id");
    const finishValueSource = optionalString(row, "finish_value_json");
    const finishArtifacts = finishToolCallId
      ? (this.database.prepare(`
          SELECT artifact.* FROM agent_finish_artifacts edge
          JOIN artifacts artifact ON artifact.digest = edge.artifact_digest
          WHERE edge.agent_session_id = ? ORDER BY edge.ordinal
        `).all(agentSessionId) as SqlRow[]).map((artifactRow) => {
          const artifact = artifactFromRow(artifactRow);
          return { digest: artifact.digest, kind: artifact.kind, mediaType: artifact.mediaType, bytes: artifact.bytes };
        })
      : [];
    const session: AgentSessionRecord = {
      agentSessionId,
      runId: requiredString(row, "run_id"),
      operationId: requiredString(row, "operation_id"),
      profileId: requiredString(row, "profile_id"),
      routeId: requiredString(row, "route_id"),
      piSessionPath: requiredString(row, "pi_session_path"),
      workspace: rowWorkspace(row, "workspace")!,
      network: requiredString(row, "network") as AgentSessionRecord["network"],
      status: requiredString(row, "status") as AgentSessionRecord["status"],
      ...(rowReason(row) ? { reason: rowReason(row)! } : {}),
      receiptlessStrikes: requiredNumber(row, "receiptless_strikes"),
      ...(optionalString(row, "current_execution_id") ? { currentExecutionId: optionalString(row, "current_execution_id")! } : {}),
      progress,
      ...(finishToolCallId ? {
        finish: {
          toolCallId: finishToolCallId,
          schemaHash: requiredString(row, "finish_schema_hash"),
          ...(finishValueSource !== undefined ? { value: decodeCanonicalJson<JsonValue>(finishValueSource, "value") } : {}),
          artifacts: finishArtifacts,
          committedAt: requiredString(row, "finish_committed_at"),
        },
      } : {}),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
    };
    assertAgentSession(session);
    return session;
  }
}

export function openRunDatabaseConnection(
  databasePath: string,
  readOnly: boolean,
  options: RunDatabaseOpenOptions,
  creating = false,
): DatabaseSync {
  const busyTimeoutMs = options.busyTimeoutMs ?? RUN_DATABASE_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000) {
    throw new TypeError("Invalid SQLite busy timeout");
  }
  const database = new DatabaseSync(databasePath, {
    readOnly,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  });
  try {
    database.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${busyTimeoutMs}`);
    if (!creating) assertRunDatabaseSchemaVersion(database);
    if (!readOnly || !creating) {
      const mode = pragmaText(database, "journal_mode").toLowerCase();
      if (creating) {
        // The branch is retained for clarity even though create configures WAL below.
      } else if (mode !== "wal") {
        throw new RunDatabaseCorruptionError(`Run database journal mode is ${mode}, expected WAL`);
      }
    }
    database.exec("PRAGMA synchronous = FULL");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function configureNewRunDatabaseConnection(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA journal_mode = WAL").get() as SqlRow | undefined;
  if (!row || requiredString(row, "journal_mode").toLowerCase() !== "wal") {
    throw new RunDatabaseCorruptionError("SQLite refused WAL mode");
  }
  database.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL");
}

export function assertRunDatabaseSchemaVersion(database: DatabaseSync): void {
  const version = pragmaNumber(database, "user_version");
  if (version !== RUN_DATABASE_SCHEMA_VERSION) throw new RunDatabaseVersionError(version);
}

function artifactFromRow(row: SqlRow): ArtifactRecord {
  const artifact: ArtifactRecord = {
    digest: requiredString(row, "digest"),
    runId: requiredString(row, "run_id"),
    kind: requiredString(row, "kind"),
    mediaType: requiredString(row, "media_type") as ArtifactRecord["mediaType"],
    bytes: requiredNumber(row, "bytes"),
    bodyPath: requiredString(row, "body_path"),
    metadata: decodeCanonicalJson(requiredString(row, "metadata_json")),
    createdAt: requiredString(row, "created_at"),
  };
  assertArtifactRecord(artifact, artifact.runId);
  return artifact;
}

function agentToolReceiptFromRow(row: SqlRow): AgentToolReceiptRecord {
  const receipt: AgentToolReceiptRecord = {
    agentSessionId: requiredString(row, "agent_session_id"),
    executionId: requiredString(row, "execution_id"),
    toolCallId: requiredString(row, "tool_call_id"),
    toolName: requiredString(row, "tool_name") as AgentToolReceiptRecord["toolName"],
    requestHash: requiredString(row, "request_hash"),
    response: decodeCanonicalJson(requiredString(row, "response_json"), "value"),
    committedAt: requiredString(row, "committed_at"),
  };
  assertIdentifier(receipt.agentSessionId, "agent session id");
  assertIdentifier(receipt.executionId, "agent execution id");
  assertAgentToolCallId(receipt.toolCallId);
  assertHash(receipt.requestHash, "agent tool request hash");
  assertIsoDate(receipt.committedAt, "agent tool committedAt");
  if (!["finish_work", "report_progress", "log_result", "publish_artifact", "web_search", "web_fetch", "workspace_command"].includes(receipt.toolName)) {
    throw new RunDatabaseCorruptionError(`Invalid agent protocol tool ${receipt.toolName}`);
  }
  return receipt;
}

function agentMediatedToolIntentFromRow(row: SqlRow): AgentMediatedToolIntentRecord {
  const reasonSource = optionalString(row, "reason_json");
  const reason = reasonSource === undefined
    ? undefined
    : decodeCanonicalJson(reasonSource, "value") as unknown as StructuredReason;
  if (reason) assertStructuredReason(reason);
  const intent: AgentMediatedToolIntentRecord = {
    agentSessionId: requiredString(row, "agent_session_id"),
    executionId: requiredString(row, "execution_id"),
    toolCallId: requiredString(row, "tool_call_id"),
    toolName: requiredString(row, "tool_name") as AgentMediatedToolIntentRecord["toolName"],
    requestHash: requiredString(row, "request_hash"),
    status: requiredString(row, "status") as AgentMediatedToolIntentRecord["status"],
    startedAt: requiredString(row, "started_at"),
    updatedAt: requiredString(row, "updated_at"),
    ...(optionalString(row, "completed_at") ? { completedAt: optionalString(row, "completed_at")! } : {}),
    ...(reason ? { reason } : {}),
  };
  assertIdentifier(intent.agentSessionId, "agent session id");
  assertIdentifier(intent.executionId, "agent execution id");
  assertAgentToolCallId(intent.toolCallId);
  assertHash(intent.requestHash, "agent mediated tool request hash");
  assertIsoDate(intent.startedAt, "agent mediated tool startedAt");
  assertIsoDate(intent.updatedAt, "agent mediated tool updatedAt");
  if (intent.completedAt) assertIsoDate(intent.completedAt, "agent mediated tool completedAt");
  if (!["web_search", "web_fetch", "workspace_command"].includes(intent.toolName)) {
    throw new RunDatabaseCorruptionError(`Invalid mediated agent tool ${intent.toolName}`);
  }
  if (!["started", "uncertain", "completed"].includes(intent.status)) {
    throw new RunDatabaseCorruptionError(`Invalid mediated agent tool status ${intent.status}`);
  }
  if ((intent.status === "uncertain") !== Boolean(intent.reason)
    || (intent.status === "completed") !== Boolean(intent.completedAt)) {
    throw new RunDatabaseCorruptionError(`Inconsistent mediated agent tool intent ${intent.toolCallId}`);
  }
  return intent;
}

function recentProgressFromRow(row: SqlRow): AgentRecentProgress {
  const event = decodeCanonicalJson(requiredString(row, "event_json"), "value") as unknown as AgentProgressRecord["event"];
  if (event.type === "observed") throw new RunDatabaseCorruptionError("Observed agent progress is marked visible");
  if (event.type === "report") {
    return {
      sequence: requiredNumber(row, "sequence"),
      type: "report",
      at: requiredString(row, "at"),
      messagePreview: preview(event.message),
      ...(event.current !== undefined ? { current: event.current } : {}),
      ...(event.total !== undefined ? { total: event.total } : {}),
      ...(event.metrics ? { metrics: structuredClone(event.metrics) } : {}),
    };
  }
  if (event.type === "log") {
    return {
      sequence: requiredNumber(row, "sequence"),
      type: "log",
      at: requiredString(row, "at"),
      messagePreview: preview(event.message),
      ...(event.artifact ? { artifact: structuredClone(event.artifact) } : {}),
    };
  }
  if (event.type === "artifact") {
    return {
      sequence: requiredNumber(row, "sequence"),
      type: "artifact",
      at: requiredString(row, "at"),
      artifact: structuredClone(event.artifact),
      ...(event.name ? { name: preview(event.name) } : {}),
    };
  }
  throw new RunDatabaseCorruptionError("Unknown visible agent progress event");
}

function automaticAgentMetrics(progress: AgentProgress, elapsedMs: number): AgentLiveProgressProjection["automaticMetrics"] {
  const metrics: AgentLiveProgressProjection["automaticMetrics"] = [
    metric("elapsed_ms", elapsedMs, "ms"),
    metric("model_turn", progress.modelTurn),
    metric("tool_count", progress.toolCount),
    metric("retries", progress.retries),
    metric("workspace_changes", progress.workspaceChangeCount),
    metric("usage.input_tokens", progress.usage.inputTokens, "tokens"),
    metric("usage.output_tokens", progress.usage.outputTokens, "tokens"),
    metric("usage.cache_read_tokens", progress.usage.cacheReadTokens, "tokens"),
    metric("usage.cache_write_tokens", progress.usage.cacheWriteTokens, "tokens"),
    metric("usage.provider_requests", progress.usage.providerRequests),
    metric("usage.cost", progress.usage.cost),
  ];
  const resources = progress.resources;
  if (resources) {
    for (const [name, value, unit] of [
      ["cgroup.cpu_usec", resources.cpuUsec, "µs"],
      ["cgroup.io_read_bytes", resources.ioReadBytes, "bytes"],
      ["cgroup.io_write_bytes", resources.ioWriteBytes, "bytes"],
      ["cgroup.memory_current_bytes", resources.memoryCurrentBytes, "bytes"],
      ["cgroup.memory_peak_bytes", resources.memoryPeakBytes, "bytes"],
      ["cgroup.processes_current", resources.tasksCurrent, "processes"],
      ["cgroup.processes_peak", resources.tasksPeak, "processes"],
      ["cgroup.cpu_pressure", resources.cpuPressure, "%"],
      ["cgroup.io_pressure", resources.ioPressure, "%"],
      ["cgroup.memory_pressure", resources.memoryPressure, "%"],
    ] as const) {
      if (value !== undefined) metrics.push(metric(name, value, unit));
    }
  }
  return metrics;
}

function metric(name: string, value: number, unit?: string): AgentLiveProgressProjection["automaticMetrics"][number] {
  const bounded = Math.max(-AGENT_PROGRESS_LIMITS.metricAbsoluteValue, Math.min(AGENT_PROGRESS_LIMITS.metricAbsoluteValue, value));
  return { name, value: bounded, ...(unit ? { unit } : {}) };
}

function preview(value: string): string {
  return Array.from(value).slice(0, AGENT_PROGRESS_LIMITS.previewScalars).join("");
}

function recentProgressLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > AGENT_PROGRESS_LIMITS.maximumRecentPage) {
    throw new TypeError("Invalid recent agent progress limit");
  }
  return value;
}

function activeAgentLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) throw new TypeError("Invalid active agent limit");
  return value;
}

function projectionTime(value: Date | undefined): Date {
  const result = value ?? new Date();
  if (!(result instanceof Date) || !Number.isFinite(result.getTime())) throw new TypeError("Invalid agent progress projection time");
  return result;
}

export function controlRequestFromRow(row: SqlRow): ControlRequest {
  const base = {
    requestId: requiredString(row, "request_id"),
    runId: requiredString(row, "run_id"),
    expectedRevision: requiredNumber(row, "expected_revision"),
    requestedAt: requiredString(row, "requested_at"),
    actor: requiredString(row, "actor"),
  };
  const reason = optionalString(row, "reason");
  const challengeHash = optionalString(row, "challenge_hash");
  let request: ControlRequest;
  switch (requiredString(row, "kind")) {
    case "pause": request = { ...base, kind: "pause", ...(reason ? { reason } : {}) }; break;
    case "resume": request = { ...base, kind: "resume" }; break;
    case "stop": request = { ...base, kind: "stop", ...(reason ? { reason } : {}) }; break;
    case "stop-effect": request = {
      ...base,
      kind: "stop-effect",
      operationId: requiredString(row, "operation_id"),
      ...(reason ? { reason } : {}),
    }; break;
    case "checkpoint-response": request = {
      ...base,
      kind: "checkpoint-response",
      checkpointId: requiredString(row, "checkpoint_id"),
      challengeHash: challengeHash ?? missingControlField("challenge_hash"),
      value: decodeCanonicalJson(requiredString(row, "value_json"), "value"),
    }; break;
    case "approve": request = {
      ...base,
      kind: "approve",
      approvalId: requiredString(row, "approval_id"),
      challengeHash: challengeHash ?? missingControlField("challenge_hash"),
    }; break;
    case "reject": request = {
      ...base,
      kind: "reject",
      approvalId: requiredString(row, "approval_id"),
      challengeHash: challengeHash ?? missingControlField("challenge_hash"),
      ...(reason ? { reason } : {}),
    }; break;
    case "shutdown": request = { ...base, kind: "shutdown" }; break;
    default: throw new RunDatabaseCorruptionError("Unknown control request kind");
  }
  assertControlRequest(request);
  return request;
}

function humanCheckpointFromRow(row: SqlRow): HumanCheckpointRecord {
  const checkpointId = requiredString(row, "checkpoint_id");
  const kind = requiredString(row, "request_kind") as HumanCheckpointRecord["request"]["kind"];
  const title = optionalString(row, "title");
  const prompt = requiredString(row, "prompt");
  const choicesSource = optionalString(row, "choices_json");
  const responseSchemaSource = optionalString(row, "response_schema_json");
  const responseSource = optionalString(row, "response_json");
  const request: HumanCheckpointRecord["request"] = kind === "confirm"
    ? { kind, ...(title ? { title } : {}), prompt }
    : kind === "choice"
      ? {
          kind,
          ...(title ? { title } : {}),
          prompt,
          choices: choicesSource
            ? decodeCanonicalJson(choicesSource, "value") as unknown as import("../runtime/durable-types.js").CheckpointChoice[]
            : missingCheckpointField("choices_json"),
        }
      : kind === "input"
        ? {
            kind,
            ...(title ? { title } : {}),
            prompt,
            responseSchema: responseSchemaSource
              ? decodeCanonicalJson(responseSchemaSource) as import("../types.js").JsonSchema
              : missingCheckpointField("response_schema_json"),
          }
        : missingCheckpointField("request_kind");
  return {
    checkpointId,
    runId: requiredString(row, "run_id"),
    operationId: requiredString(row, "operation_id"),
    status: requiredString(row, "status") as HumanCheckpointRecord["status"],
    request,
    challengeHash: requiredString(row, "challenge_hash"),
    requestedRevision: requiredNumber(row, "requested_revision"),
    ...(responseSource !== undefined ? { response: decodeCanonicalJson(responseSource, "value") } : {}),
    requestedAt: requiredString(row, "requested_at"),
    ...(optionalString(row, "resolved_at") ? { resolvedAt: optionalString(row, "resolved_at")! } : {}),
  };
}

function missingCheckpointField(field: string): never {
  throw new RunDatabaseCorruptionError(`Human checkpoint is missing ${field}`);
}

function missingControlField(field: string): never {
  throw new RunDatabaseCorruptionError(`Control request is missing ${field}`);
}

function pageLimit(value = 64): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > PAGE_LIMIT) throw new TypeError(`Page limit must be between 1 and ${PAGE_LIMIT}`);
  return value;
}

function pragmaNumber(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as SqlRow | undefined;
  if (!row) throw new RunDatabaseCorruptionError(`PRAGMA ${name} returned no value`);
  const value = Object.values(row)[0];
  if (typeof value !== "number") throw new RunDatabaseCorruptionError(`PRAGMA ${name} returned a non-number`);
  return value;
}

function pragmaText(database: DatabaseSync, name: string): string {
  const row = database.prepare(`PRAGMA ${name}`).get() as SqlRow | undefined;
  if (!row) throw new RunDatabaseCorruptionError(`PRAGMA ${name} returned no value`);
  const value = Object.values(row)[0];
  if (typeof value !== "string") throw new RunDatabaseCorruptionError(`PRAGMA ${name} returned non-text`);
  return value;
}
