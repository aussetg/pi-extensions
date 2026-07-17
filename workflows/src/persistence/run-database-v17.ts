import fs from "node:fs";
import path from "node:path";
import { canonicalJsonValue, deepFreezeJson } from "../definition/canonical-json.js";
import { WORKFLOW_V17_RUNTIME_API_HASH } from "../definition/workflow-language-v17.js";
import type { WorkflowV17InvocationSnapshot } from "./workflow-v17-invocation.js";
import { assertWorkflowV17InvocationSnapshot } from "./workflow-v17-invocation.js";
import type { JsonObject, JsonValue } from "../types.js";
import type { SafetyConfiguration } from "../runtime/durable-types.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
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
  WORKFLOW_RUN_DATABASE_V17_BUSY_TIMEOUT_MS,
  WORKFLOW_RUN_DATABASE_V17_SCHEMA_SQL,
  WORKFLOW_RUN_DATABASE_V17_SCHEMA_VERSION,
} from "./run-database-v17-schema.js";
import type {
  ClaimWorkflowOperationV17Input,
  CompleteWorkflowCallV17Input,
  CompleteWorkflowStructuralJoinV17Input,
  CreateWorkflowChildScopeV17Spec,
  WorkflowArtifactV17Record,
  WorkflowAttemptV17Record,
  WorkflowCandidateApplyV17Record,
  WorkflowCandidateDispositionV17Record,
  WorkflowCandidateMeasurementV17Record,
  WorkflowCandidateV17Record,
  WorkflowCandidateVerificationV17Record,
  WorkflowCandidateWorkspaceV17Record,
  WorkflowInvocationResourceV17Record,
  WorkflowOperationV17Kind,
  WorkflowOperationV17Record,
  WorkflowRunV17Event,
  WorkflowRunV17Record,
  WorkflowRunV17Status,
  WorkflowScopeCallV17Record,
  WorkflowScopeV17Record,
  WorkflowStructuralJoinLaneV17Record,
  WorkflowStructuralJoinV17Record,
  WorkflowWorkspaceCheckpointV17Record,
} from "./run-database-v17-types.js";

export { WORKFLOW_RUN_DATABASE_V17_SCHEMA_VERSION } from "./run-database-v17-schema.js";
export type * from "./run-database-v17-types.js";

export const WORKFLOW_V17_ROOT_SCOPE_SEED = stableHash({
  formatVersion: 1,
  kind: "workflow-v17-root-scope",
});

const SOURCE_SITE = /^[a-z][a-z0-9-]{0,127}$/u;
const LANE_KEY = /^[a-z][a-z0-9_-]{0,63}$/u;
const TERMINAL_RUN_STATUSES = new Set<WorkflowRunV17Status>(["completed", "failed", "stopped"]);
const STRUCTURAL_KINDS = new Set<WorkflowOperationV17Kind>(["parallel", "map", "candidate"]);

export interface WorkflowRunDatabaseV17OpenOptions {
  busyTimeoutMs?: number;
}

export interface CreateWorkflowRunDatabaseV17Options {
  runId: string;
  snapshot: WorkflowV17InvocationSnapshot;
  projectSnapshotHash: string;
  routeSnapshotHash: string;
  contextIdentityHash: string;
  safety: SafetyConfiguration;
  createdAt: string;
}

export interface TransitionWorkflowRunV17Input {
  status: WorkflowRunV17Status;
  reason?: JsonObject;
  currentOperationId?: string | null;
  rootTerminalKey?: string;
  at: string;
}

export interface CompleteWorkflowScopeV17Input {
  expectedRevision: number;
  scopeId: string;
  status: "completed" | "failed" | "cancelled";
  terminalKey: string;
  failure?: JsonObject;
  at: string;
}

export interface CreateCandidateWorkspaceV17Input {
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

export interface FreezeCandidateV17Input {
  expectedRevision: number;
  workspaceId: string;
  treeHash: string;
  lineageHash: string;
  output: JsonValue;
  changedPaths: string[];
  manifestArtifactDigest: string;
  diffArtifactDigest: string;
  at: string;
}

export type DisposeCandidateV17Input = {
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

export interface WorkflowRunDatabaseV17Configuration {
  schemaVersion: number;
  journalMode: string;
  foreignKeys: boolean;
  synchronous: number;
  busyTimeoutMs: number;
}

export interface CompleteWorkflowAttemptV17Input {
  expectedRevision: number;
  attemptId: string;
  status: "completed" | "failed" | "stopped" | "cancelled";
  usage: JsonObject;
  resources?: JsonObject;
  at: string;
}

export class WorkflowRunDatabaseV17VersionError extends Error {
  constructor(readonly actual: number) {
    super(actual === 3
      ? "Legacy workflow run database schema 3 cannot be opened by runtime v17"
      : `Unsupported workflow run database schema ${actual}; expected ${WORKFLOW_RUN_DATABASE_V17_SCHEMA_VERSION}`);
    this.name = "WorkflowRunDatabaseV17VersionError";
  }
}

export class WorkflowRunDatabaseV17RevisionConflictError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`Workflow run revision changed: expected ${expected}, found ${actual}`);
    this.name = "WorkflowRunDatabaseV17RevisionConflictError";
  }
}

export class WorkflowRunDatabaseV17StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowRunDatabaseV17StateError";
  }
}

export class WorkflowRunDatabaseV17CorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowRunDatabaseV17CorruptionError";
  }
}

export function workflowV17ScopeId(runId: string, scopePath: string): string {
  assertIdentifier(runId, "workflow v17 run id");
  assertScopePath(scopePath);
  return `scope_${stableHash({ formatVersion: 1, runId, scopePath }).slice(7, 39)}`;
}

export function workflowV17OperationId(runId: string, operationPath: string): string {
  assertIdentifier(runId, "workflow v17 run id");
  assertOperationPath(operationPath);
  return `operation_${stableHash({ formatVersion: 1, runId, operationPath }).slice(7, 39)}`;
}

export function workflowV17ResourceId(inputPath: string, bindingHash: string): string {
  assertJsonPointer(inputPath, "workflow v17 resource input path");
  assertHash(bindingHash, "workflow v17 resource binding hash");
  return `resource_${stableHash({ formatVersion: 1, inputPath, bindingHash }).slice(7, 39)}`;
}

export function workflowV17InvocationIdentityHash(snapshot: WorkflowV17InvocationSnapshot): string {
  assertWorkflowV17InvocationSnapshot(snapshot);
  return stableHash({
    formatVersion: 1,
    workflowId: snapshot.workflowId,
    definitionHash: snapshot.definitionHash,
    inputHash: snapshot.inputHash,
    resourcesHash: snapshot.resourcesHash,
    runtimeApiHash: snapshot.runtimeApiHash,
  });
}

export class WorkflowRunDatabaseV17Reader implements Disposable {
  protected closed = false;

  protected constructor(
    protected readonly database: DatabaseSync,
    readonly databasePath: string,
  ) {}

  static open(
    databasePathInput: string,
    options: WorkflowRunDatabaseV17OpenOptions = {},
  ): WorkflowRunDatabaseV17Reader {
    const databasePath = path.resolve(databasePathInput);
    const database = openConnection(databasePath, true, options);
    const reader = new WorkflowRunDatabaseV17Reader(database, databasePath);
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

  configuration(): WorkflowRunDatabaseV17Configuration {
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

  readRun(): WorkflowRunV17Record {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM runs WHERE singleton = 1").get() as SqlRow | undefined;
    if (!row) throw corrupt("Workflow v17 database has no run row");
    const runId = requiredString(row, "run_id");
    const capabilities = (this.database.prepare(
      "SELECT capability FROM run_capabilities WHERE run_id = ? ORDER BY ordinal",
    ).all(runId) as SqlRow[]).map((entry) => requiredString(entry, "capability"));
    const reason = jsonColumn<JsonObject>(row, "reason_json");
    const run: WorkflowRunV17Record = {
      runId,
      revision: requiredNumber(row, "revision"),
      workflow: {
        id: requiredString(row, "workflow_id") as WorkflowRunV17Record["workflow"]["id"],
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
      contextIdentityHash: requiredString(row, "context_identity_hash"),
      launch: {
        authority: requiredString(row, "launch_authority") as WorkflowRunV17Record["launch"]["authority"],
        exposure: requiredString(row, "exposure") as WorkflowRunV17Record["launch"]["exposure"],
        policyHash: requiredString(row, "policy_hash"),
        projectTrusted: requiredNumber(row, "project_trusted") === 1,
      },
      capabilities,
      safety: safetyFromRow(row),
      status: requiredString(row, "status") as WorkflowRunV17Status,
      ...(reason ? { reason } : {}),
      rootScopeId: requiredString(row, "root_scope_id"),
      ...(optionalString(row, "current_operation_id") ? {
        currentOperationId: optionalString(row, "current_operation_id")!,
      } : {}),
      ...(optionalString(row, "root_terminal_key") ? {
        rootTerminalKey: optionalString(row, "root_terminal_key")!,
      } : {}),
      createdAt: requiredString(row, "created_at"),
      ...(optionalString(row, "started_at") ? { startedAt: optionalString(row, "started_at")! } : {}),
      updatedAt: requiredString(row, "updated_at"),
      ...(optionalString(row, "ended_at") ? { endedAt: optionalString(row, "ended_at")! } : {}),
    };
    assertRunRecord(run);
    return run;
  }

  listInvocationResources(): WorkflowInvocationResourceV17Record[] {
    this.assertOpen();
    return (this.database.prepare(
      "SELECT * FROM invocation_resources ORDER BY input_path",
    ).all() as SqlRow[]).map(resourceFromRow);
  }

  listEvents(options: { afterSequence?: number; limit?: number } = {}): WorkflowRunV17Event[] {
    this.assertOpen();
    const after = options.afterSequence ?? 0;
    const limit = pageLimit(options.limit);
    assertNonNegativeInteger(after, "workflow v17 event cursor");
    return (this.database.prepare(
      "SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?",
    ).all(after, limit) as SqlRow[]).map(eventFromRow);
  }

  readScope(scopeId: string): WorkflowScopeV17Record | undefined {
    this.assertOpen();
    assertIdentifier(scopeId, "workflow v17 scope id");
    const row = this.database.prepare("SELECT * FROM scopes WHERE scope_id = ?").get(scopeId) as SqlRow | undefined;
    return row ? scopeFromRow(row) : undefined;
  }

  readScopeByPath(scopePath: string): WorkflowScopeV17Record | undefined {
    this.assertOpen();
    assertScopePath(scopePath);
    const row = this.database.prepare("SELECT * FROM scopes WHERE path = ?").get(scopePath) as SqlRow | undefined;
    return row ? scopeFromRow(row) : undefined;
  }

  listScopes(): WorkflowScopeV17Record[] {
    this.assertOpen();
    return (this.database.prepare("SELECT * FROM scopes ORDER BY path").all() as SqlRow[]).map(scopeFromRow);
  }

  listChildScopes(ownerOperationId: string): WorkflowScopeV17Record[] {
    this.assertOpen();
    assertIdentifier(ownerOperationId, "workflow v17 owner operation id");
    return (this.database.prepare(
      "SELECT * FROM scopes WHERE owner_operation_id = ? ORDER BY sibling_ordinal",
    ).all(ownerOperationId) as SqlRow[]).map(scopeFromRow);
  }

  readOperation(operationId: string): WorkflowOperationV17Record | undefined {
    this.assertOpen();
    assertIdentifier(operationId, "workflow v17 operation id");
    const row = this.database.prepare("SELECT * FROM operations WHERE operation_id = ?").get(operationId) as SqlRow | undefined;
    return row ? operationFromRow(row) : undefined;
  }

  readOperationAt(scopeId: string, cursor: number): WorkflowOperationV17Record | undefined {
    this.assertOpen();
    assertIdentifier(scopeId, "workflow v17 scope id");
    assertNonNegativeInteger(cursor, "workflow v17 scope cursor");
    const row = this.database.prepare(
      "SELECT * FROM operations WHERE scope_id = ? AND cursor = ?",
    ).get(scopeId, cursor) as SqlRow | undefined;
    return row ? operationFromRow(row) : undefined;
  }

  listOperations(options: { afterOrdinal?: number; limit?: number } = {}): WorkflowOperationV17Record[] {
    this.assertOpen();
    const after = options.afterOrdinal ?? -1;
    const limit = pageLimit(options.limit);
    if (!Number.isSafeInteger(after) || after < -1) throw new TypeError("Invalid workflow v17 operation cursor");
    return (this.database.prepare(
      "SELECT * FROM operations WHERE ordinal > ? ORDER BY ordinal LIMIT ?",
    ).all(after, limit) as SqlRow[]).map(operationFromRow);
  }

  readScopeCall(operationId: string): WorkflowScopeCallV17Record | undefined {
    this.assertOpen();
    assertIdentifier(operationId, "workflow v17 operation id");
    const row = this.database.prepare("SELECT * FROM scope_calls WHERE operation_id = ?").get(operationId) as SqlRow | undefined;
    return row ? scopeCallFromRow(row) : undefined;
  }

  listScopeCalls(scopeId: string): WorkflowScopeCallV17Record[] {
    this.assertOpen();
    assertIdentifier(scopeId, "workflow v17 scope id");
    return (this.database.prepare(
      "SELECT * FROM scope_calls WHERE scope_id = ? ORDER BY cursor",
    ).all(scopeId) as SqlRow[]).map(scopeCallFromRow);
  }

  readStructuralJoin(operationId: string): WorkflowStructuralJoinV17Record | undefined {
    this.assertOpen();
    assertIdentifier(operationId, "workflow v17 operation id");
    const row = this.database.prepare("SELECT * FROM structural_joins WHERE operation_id = ?").get(operationId) as SqlRow | undefined;
    if (!row) return undefined;
    const lanes = (this.database.prepare(
      "SELECT * FROM structural_join_lanes WHERE operation_id = ? ORDER BY ordinal",
    ).all(operationId) as SqlRow[]).map(joinLaneFromRow);
    return structuralJoinFromRow(row, lanes);
  }

  readArtifact(digest: string): WorkflowArtifactV17Record | undefined {
    this.assertOpen();
    assertHash(digest, "workflow v17 artifact digest");
    const row = this.database.prepare("SELECT * FROM artifacts WHERE digest = ?").get(digest) as SqlRow | undefined;
    return row ? artifactFromRow(row) : undefined;
  }

  readAttempt(attemptId: string): WorkflowAttemptV17Record | undefined {
    this.assertOpen();
    assertIdentifier(attemptId, "workflow v17 attempt id");
    const row = this.database.prepare("SELECT * FROM attempts WHERE attempt_id = ?").get(attemptId) as SqlRow | undefined;
    return row ? attemptFromRow(row) : undefined;
  }

  readCandidateWorkspace(workspaceId: string): WorkflowCandidateWorkspaceV17Record | undefined {
    this.assertOpen();
    assertIdentifier(workspaceId, "workflow v17 candidate workspace id");
    const row = this.database.prepare(
      "SELECT * FROM candidate_workspaces WHERE workspace_id = ?",
    ).get(workspaceId) as SqlRow | undefined;
    return row ? candidateWorkspaceFromRow(row) : undefined;
  }

  readCandidate(candidateId: string): WorkflowCandidateV17Record | undefined {
    this.assertOpen();
    assertIdentifier(candidateId, "workflow v17 candidate id");
    const row = this.database.prepare("SELECT * FROM candidates WHERE candidate_id = ?").get(candidateId) as SqlRow | undefined;
    return row ? this.candidateFromRow(row) : undefined;
  }

  listCandidates(): WorkflowCandidateV17Record[] {
    this.assertOpen();
    return (this.database.prepare("SELECT * FROM candidates ORDER BY frozen_at, candidate_id").all() as SqlRow[])
      .map((row) => this.candidateFromRow(row));
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
      || root[0]!.seedKey !== WORKFLOW_V17_ROOT_SCOPE_SEED) {
      throw corrupt("Workflow v17 database has an invalid root scope");
    }
    const resources = this.listInvocationResources();
    if (stableHash(resources.map((resource) => resource.resource)) !== run.resourcesHash) {
      throw corrupt("Workflow v17 invocation resources differ from the run identity");
    }
    for (const resource of resources) assertResourceRecord(resource, run.runId);
    for (const scope of scopes) this.assertScopeIntegrity(scope, run.runId);
    for (const candidate of this.listCandidates()) this.assertCandidateIntegrity(candidate);
    if (run.status === "completed") {
      const rootScope = this.readScope(run.rootScopeId)!;
      if (rootScope.status !== "completed" || rootScope.terminalKey !== run.rootTerminalKey) {
        throw corrupt("Completed workflow v17 run differs from its root scope terminal key");
      }
      const pending = this.listCandidates().filter((candidate) => candidate.state === "pending");
      if (pending.length > 0) throw corrupt("Completed workflow v17 run has pending candidates");
      const interrupted = requiredNumber(this.database.prepare(`
        SELECT
          (SELECT count(*) FROM operations WHERE status IN ('running', 'waiting', 'stopped', 'cancelled'))
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

  private assertBasicIdentity(): void {
    const run = this.readRun();
    const root = this.readScope(run.rootScopeId);
    if (!root || root.kind !== "root" || root.path !== "run" || root.runId !== run.runId) {
      throw corrupt("Workflow v17 database root identity is corrupt");
    }
  }

  private assertScopeIntegrity(scope: WorkflowScopeV17Record, runId: string): void {
    if (scope.runId !== runId || scope.scopeId !== workflowV17ScopeId(runId, scope.path)) {
      throw corrupt(`Workflow v17 scope ${scope.path} identity is corrupt`);
    }
    const operations = (this.database.prepare(
      "SELECT * FROM operations WHERE scope_id = ? ORDER BY cursor",
    ).all(scope.scopeId) as SqlRow[]).map(operationFromRow);
    let previous = scope.seedKey;
    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index]!;
      if (operation.cursor !== index || operation.path !== operationPath(scope.path, index)
        || operation.operationId !== workflowV17OperationId(runId, operation.path)) {
        throw corrupt(`Workflow v17 scope ${scope.path} has a cursor or operation identity gap`);
      }
      assertHash(operation.semanticInputHash, `workflow v17 operation ${operation.path} semantic input hash`);
      assertSourceSite(operation.sourceSite);
      if (operation.descriptorSourceSite) assertSourceSite(operation.descriptorSourceSite);
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
    join: WorkflowStructuralJoinV17Record,
    operation: WorkflowOperationV17Record,
  ): void {
    const call = this.readScopeCall(operation.operationId);
    if (!call || call.completionAuthority !== "structural-join" || call.callKey !== join.joinKey
      || join.kind !== operation.kind || join.previousCallKey !== call.previousCallKey) {
      throw corrupt(`Workflow v17 structural join ${operation.path} differs from its scope call`);
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
    if (join.kind === "candidate") {
      const row = this.database.prepare(
        "SELECT body_scope_id FROM candidates WHERE operation_id = ?",
      ).get(operation.operationId) as SqlRow | undefined;
      if (!row || join.lanes.length !== 1
        || requiredString(row, "body_scope_id") !== join.lanes[0]!.scopeId) {
        throw corrupt(`Workflow v17 candidate join ${operation.path} lacks exact frozen candidate authority`);
      }
    }
  }

  private assertCandidateIntegrity(candidate: WorkflowCandidateV17Record): void {
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
      let verification: WorkflowCandidateVerificationV17Record | undefined;
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
  }

  private candidateFromRow(row: SqlRow): WorkflowCandidateV17Record {
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

  readCandidateMeasurement(candidateId: string): WorkflowCandidateMeasurementV17Record | undefined {
    this.assertOpen();
    assertIdentifier(candidateId, "workflow v17 candidate id");
    const row = this.database.prepare(
      "SELECT * FROM candidate_measurements WHERE candidate_id = ?",
    ).get(candidateId) as SqlRow | undefined;
    return row ? candidateMeasurementFromRow(row) : undefined;
  }
}

export class WorkflowRunDatabaseV17 extends WorkflowRunDatabaseV17Reader {
  private constructor(database: DatabaseSync, databasePath: string) {
    super(database, databasePath);
  }

  static create(
    databasePathInput: string,
    options: CreateWorkflowRunDatabaseV17Options,
  ): WorkflowRunDatabaseV17 {
    const databasePath = path.resolve(databasePathInput);
    assertCreateOptions(options);
    const rootScopeId = workflowV17ScopeId(options.runId, "run");
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
        database.exec(WORKFLOW_RUN_DATABASE_V17_SCHEMA_SQL);
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
      const result = new WorkflowRunDatabaseV17(database, databasePath);
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
    options: WorkflowRunDatabaseV17OpenOptions = {},
  ): WorkflowRunDatabaseV17 {
    const databasePath = path.resolve(databasePathInput);
    const database = openConnection(databasePath, false, options);
    const result = new WorkflowRunDatabaseV17(database, databasePath);
    try {
      result.assertBasicWritableIdentity();
      return result;
    } catch (error) {
      result.close();
      throw error;
    }
  }

  transitionRun(expectedRevision: number, input: TransitionWorkflowRunV17Input): WorkflowRunV17Record {
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
          SELECT count(*) AS value FROM operations WHERE status IN ('running', 'waiting', 'stopped', 'cancelled')
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
          revision = ?, updated_at = ?,
          started_at = CASE WHEN ? = 'running' THEN coalesce(started_at, ?) ELSE started_at END,
          ended_at = CASE WHEN ? IN ('completed', 'failed', 'stopped') THEN ? ELSE NULL END
        WHERE singleton = 1 AND revision = ?
      `).run(
        input.status,
        input.reason ? json(input.reason) : null,
        currentOperationId,
        input.status === "completed" ? input.rootTerminalKey! : null,
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

  claimOperation(input: ClaimWorkflowOperationV17Input): {
    operation: WorkflowOperationV17Record;
    claimed: boolean;
  } {
    assertClaimInput(input);
    this.assertOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.readRun();
      assertExpectedRevision(run.revision, input.expectedRevision);
      const scope = this.requireScope(input.scopeId);
      if (scope.status !== "active") throw state(`Cannot claim an operation in ${scope.status} scope ${scope.path}`);
      const existing = this.readOperationAt(scope.scopeId, input.cursor);
      if (existing) {
        if (existing.kind !== input.kind || existing.semanticInputHash !== input.semanticInputHash) {
          throw state(`Semantic operation changed at ${existing.path}`);
        }
        this.database.exec("COMMIT");
        return { operation: existing, claimed: false };
      }
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
      const operationPathValue = operationPath(scope.path, input.cursor);
      const operationId = workflowV17OperationId(run.runId, operationPathValue);
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
    specs: readonly CreateWorkflowChildScopeV17Spec[],
    at: string,
  ): { scopes: WorkflowScopeV17Record[]; created: boolean } {
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
      const parent = this.requireScope(owner.scopeId);
      const created: WorkflowScopeV17Record[] = [];
      for (let ordinal = 0; ordinal < specs.length; ordinal++) {
        const spec = specs[ordinal]!;
        const scopePathValue = childScopePath(owner, spec);
        const scopeId = workflowV17ScopeId(run.runId, scopePathValue);
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

  completeScope(input: CompleteWorkflowScopeV17Input): WorkflowScopeV17Record {
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

  completeCall(input: CompleteWorkflowCallV17Input): WorkflowOperationV17Record {
    assertCompleteCallInput(input);
    return this.commitCallTransaction(input, undefined);
  }

  completeStructuralJoin(input: CompleteWorkflowStructuralJoinV17Input): WorkflowOperationV17Record {
    assertCompleteStructuralJoinInput(input);
    return this.commitCallTransaction({
      ...input,
      outcome: "success",
      completionAuthority: "structural-join",
      replayPolicy: "immutable",
    }, input);
  }

  insertArtifact(expectedRevision: number, artifact: WorkflowArtifactV17Record): WorkflowArtifactV17Record {
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

  insertAttempt(expectedRevision: number, attempt: WorkflowAttemptV17Record): WorkflowAttemptV17Record {
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

  completeAttempt(input: CompleteWorkflowAttemptV17Input): WorkflowAttemptV17Record {
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
    checkpoint: WorkflowWorkspaceCheckpointV17Record,
  ): WorkflowWorkspaceCheckpointV17Record {
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

  createCandidateWorkspace(input: CreateCandidateWorkspaceV17Input): WorkflowCandidateWorkspaceV17Record {
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
  ): WorkflowCandidateWorkspaceV17Record {
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
  ): WorkflowCandidateWorkspaceV17Record {
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

  freezeCandidate(input: FreezeCandidateV17Input): WorkflowCandidateV17Record {
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
        || body.status !== "completed") {
        throw state("Candidate freeze requires a completed body and mutable workspace");
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
      this.setRunRevisionOnly(run.revision, nextRevision, input.at);
      return { candidateId };
    });
    return this.readCandidate(candidateId)!;
  }

  registerCandidateMeasurement(
    expectedRevision: number,
    measurement: Omit<WorkflowCandidateMeasurementV17Record, "runId" | "status" | "finalizedAt">,
  ): WorkflowCandidateMeasurementV17Record {
    assertIdentifier(measurement.measurementId, "workflow v17 measurement id");
    assertIdentifier(measurement.candidateId, "workflow v17 candidate id");
    assertIdentifier(measurement.operationId, "workflow v17 measurement operation id");
    assertHash(measurement.bindingHash, "workflow v17 measurement binding hash");
    assertIsoDate(measurement.createdAt, "workflow v17 measurement time");
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

  registerCandidateVerification(
    expectedRevision: number,
    verification: Omit<WorkflowCandidateVerificationV17Record, "runId">,
  ): WorkflowCandidateVerificationV17Record {
    assertVerificationRecord(verification);
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

  disposeCandidate(input: DisposeCandidateV17Input): WorkflowCandidateV17Record {
    assertDisposeCandidateInput(input);
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
      let verification: WorkflowCandidateVerificationV17Record | undefined;
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
      }
      this.setRunRevisionOnly(run.revision, nextRevision, input.at);
      return {};
    });
    return this.readCandidate(input.candidateId)!;
  }

  recordCandidateApply(
    expectedRevision: number,
    apply: Omit<WorkflowCandidateApplyV17Record, "runId">,
  ): WorkflowCandidateV17Record {
    assertCandidateApplyRecord(apply);
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
    input: CompleteWorkflowCallV17Input,
    join: CompleteWorkflowStructuralJoinV17Input | undefined,
  ): WorkflowOperationV17Record {
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
      if (join) this.insertStructuralJoin(operation, join);
      else if (STRUCTURAL_KINDS.has(operation.kind) && input.outcome === "success") {
        throw state(`Successful structural operation ${operation.path} requires a structural join`);
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
      const terminalValue = input.outcome === "success" ? input.result! : input.failure!;
      const resultHash = stableHash(terminalValue);
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
    operation: WorkflowOperationV17Record,
    input: CompleteWorkflowStructuralJoinV17Input,
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
    if (input.kind === "candidate") {
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

  private mutate(
    expectedRevision: number,
    event: Omit<WorkflowRunV17Event, "runId" | "sequence" | "revision">,
    body: (run: WorkflowRunV17Record, nextRevision: number) => JsonObject,
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

  private expectedPreviousCallKey(scope: WorkflowScopeV17Record, cursor?: number): string {
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
    }
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

  private requireScope(scopeId: string): WorkflowScopeV17Record {
    const scope = this.readScope(scopeId);
    if (!scope) throw state(`Missing workflow v17 scope ${scopeId}`);
    return scope;
  }

  private requireOperation(operationId: string): WorkflowOperationV17Record {
    const operation = this.readOperation(operationId);
    if (!operation) throw state(`Missing workflow v17 operation ${operationId}`);
    return operation;
  }

  private requireArtifact(digest: string): WorkflowArtifactV17Record {
    const artifact = this.readArtifact(digest);
    if (!artifact) throw state(`Missing workflow v17 artifact ${digest}`);
    return artifact;
  }

  private requireCandidateWorkspace(workspaceId: string): WorkflowCandidateWorkspaceV17Record {
    const workspace = this.readCandidateWorkspace(workspaceId);
    if (!workspace) throw state(`Missing workflow v17 candidate workspace ${workspaceId}`);
    return workspace;
  }

  private requirePendingCandidate(candidateId: string): WorkflowCandidateV17Record {
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
  options: CreateWorkflowRunDatabaseV17Options,
  rootScopeId: string,
): void {
  const snapshot = options.snapshot;
  database.prepare(`
    INSERT INTO runs(
      singleton, run_id, revision, workflow_id, workflow_name, workflow_source_hash,
      workflow_definition_hash, invocation_snapshot_hash, runtime_api_hash, invocation_hash,
      resources_hash, project_snapshot_hash, route_snapshot_hash, context_identity_hash,
      launch_authority, exposure, policy_hash, project_trusted, status,
      safety_concurrency, safety_maximum_agent_launches, safety_memory_bytes, safety_tasks,
      safety_cpu_quota_percent, safety_cpu_weight, safety_output_bytes, safety_command_timeout_ms,
      root_scope_id, created_at, updated_at
    ) VALUES (1, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    options.runId,
    snapshot.workflowId,
    snapshot.name,
    snapshot.sourceHash,
    snapshot.definitionHash,
    snapshot.snapshotHash,
    snapshot.runtimeApiHash,
    workflowV17InvocationIdentityHash(snapshot),
    snapshot.resourcesHash,
    options.projectSnapshotHash,
    options.routeSnapshotHash,
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
  options: CreateWorkflowRunDatabaseV17Options,
  rootScopeId: string,
): void {
  database.prepare(`
    INSERT INTO scopes(
      scope_id, run_id, path, kind, sibling_ordinal, seed_key, status, created_at
    ) VALUES (?, ?, 'run', 'root', 0, ?, 'active', ?)
  `).run(rootScopeId, options.runId, WORKFLOW_V17_ROOT_SCOPE_SEED, options.createdAt);
}

function insertInitialResources(
  database: DatabaseSync,
  options: CreateWorkflowRunDatabaseV17Options,
): void {
  for (const resource of options.snapshot.resources) {
    const resourceId = workflowV17ResourceId(resource.inputPath, resource.bindingHash);
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

function insertEvent(database: DatabaseSync, event: WorkflowRunV17Event): void {
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

function resourceFromRow(row: SqlRow): WorkflowInvocationResourceV17Record {
  const resource = (jsonColumnRequired<JsonValue>(row, "resource_json") as unknown) as WorkflowInvocationResourceV17Record["resource"];
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

function eventFromRow(row: SqlRow): WorkflowRunV17Event {
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

function scopeFromRow(row: SqlRow): WorkflowScopeV17Record {
  const failure = jsonColumn<JsonObject>(row, "failure_json");
  return {
    scopeId: requiredString(row, "scope_id"),
    runId: requiredString(row, "run_id"),
    ...(optionalString(row, "parent_scope_id") ? { parentScopeId: optionalString(row, "parent_scope_id")! } : {}),
    ...(optionalString(row, "owner_operation_id") ? { ownerOperationId: optionalString(row, "owner_operation_id")! } : {}),
    path: requiredString(row, "path"),
    kind: requiredString(row, "kind") as WorkflowScopeV17Record["kind"],
    siblingOrdinal: requiredNumber(row, "sibling_ordinal"),
    ...(optionalString(row, "lane_key") ? { laneKey: optionalString(row, "lane_key")! } : {}),
    seedKey: requiredString(row, "seed_key"),
    status: requiredString(row, "status") as WorkflowScopeV17Record["status"],
    ...(optionalString(row, "terminal_key") ? { terminalKey: optionalString(row, "terminal_key")! } : {}),
    ...(failure ? { failure } : {}),
    createdAt: requiredString(row, "created_at"),
    ...(optionalString(row, "ended_at") ? { endedAt: optionalString(row, "ended_at")! } : {}),
  };
}

function operationFromRow(row: SqlRow): WorkflowOperationV17Record {
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
    kind: requiredString(row, "kind") as WorkflowOperationV17Kind,
    ordinal: requiredNumber(row, "ordinal"),
    sourceSite: requiredString(row, "source_site"),
    ...(optionalString(row, "descriptor_source_site") ? {
      descriptorSourceSite: optionalString(row, "descriptor_source_site")!,
    } : {}),
    ...(optionalString(row, "title") ? { title: optionalString(row, "title")! } : {}),
    semanticInputHash: requiredString(row, "semantic_input_hash"),
    status: requiredString(row, "status") as WorkflowOperationV17Record["status"],
    ...(result !== undefined ? { result } : {}),
    ...(failure ? { failure } : {}),
    ...(optionalString(row, "call_key") ? { callKey: optionalString(row, "call_key")! } : {}),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
    ...(optionalString(row, "ended_at") ? { endedAt: optionalString(row, "ended_at")! } : {}),
  };
}

function scopeCallFromRow(row: SqlRow): WorkflowScopeCallV17Record {
  const sourceRunId = optionalString(row, "source_run_id");
  return {
    operationId: requiredString(row, "operation_id"),
    runId: requiredString(row, "run_id"),
    scopeId: requiredString(row, "scope_id"),
    cursor: requiredNumber(row, "cursor"),
    previousCallKey: requiredString(row, "previous_call_key"),
    semanticKey: requiredString(row, "semantic_key"),
    callKey: requiredString(row, "call_key"),
    outcome: requiredString(row, "outcome") as WorkflowScopeCallV17Record["outcome"],
    completionAuthority: requiredString(row, "completion_authority") as WorkflowScopeCallV17Record["completionAuthority"],
    replayPolicy: requiredString(row, "replay_policy") as WorkflowScopeCallV17Record["replayPolicy"],
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

function structuralJoinFromRow(
  row: SqlRow,
  lanes: WorkflowStructuralJoinLaneV17Record[],
): WorkflowStructuralJoinV17Record {
  return {
    operationId: requiredString(row, "operation_id"),
    runId: requiredString(row, "run_id"),
    scopeId: requiredString(row, "scope_id"),
    cursor: requiredNumber(row, "cursor"),
    kind: requiredString(row, "kind") as WorkflowStructuralJoinV17Record["kind"],
    previousCallKey: requiredString(row, "previous_call_key"),
    policyHash: requiredString(row, "policy_hash"),
    outputOrder: jsonColumnRequired<string[]>(row, "output_order_json"),
    joinKey: requiredString(row, "join_key"),
    lanes,
    committedAt: requiredString(row, "committed_at"),
  };
}

function joinLaneFromRow(row: SqlRow): WorkflowStructuralJoinLaneV17Record {
  return {
    ordinal: requiredNumber(row, "ordinal"),
    laneKey: requiredString(row, "lane_key"),
    scopeId: requiredString(row, "scope_id"),
    terminalKey: requiredString(row, "terminal_key"),
    outcome: requiredString(row, "outcome") as WorkflowStructuralJoinLaneV17Record["outcome"],
  };
}

function artifactFromRow(row: SqlRow): WorkflowArtifactV17Record {
  return {
    digest: requiredString(row, "digest"),
    runId: requiredString(row, "run_id"),
    kind: requiredString(row, "kind"),
    mediaType: requiredString(row, "media_type") as WorkflowArtifactV17Record["mediaType"],
    bytes: requiredNumber(row, "bytes"),
    bodyPath: requiredString(row, "body_path"),
    metadata: jsonColumnRequired<JsonObject>(row, "metadata_json"),
    createdAt: requiredString(row, "created_at"),
  };
}

function attemptFromRow(row: SqlRow): WorkflowAttemptV17Record {
  return {
    attemptId: requiredString(row, "attempt_id"),
    runId: requiredString(row, "run_id"),
    operationId: requiredString(row, "operation_id"),
    number: requiredNumber(row, "number"),
    effect: requiredString(row, "effect") as WorkflowAttemptV17Record["effect"],
    ...(optionalString(row, "execution_id") ? { executionId: optionalString(row, "execution_id")! } : {}),
    status: requiredString(row, "status") as WorkflowAttemptV17Record["status"],
    usage: jsonColumnRequired<JsonObject>(row, "usage_json"),
    ...(optionalString(row, "resources_json") ? {
      resources: jsonColumnRequired<JsonObject>(row, "resources_json"),
    } : {}),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
    ...(optionalString(row, "ended_at") ? { endedAt: optionalString(row, "ended_at")! } : {}),
  };
}

function workspaceCheckpointFromRow(row: SqlRow): WorkflowWorkspaceCheckpointV17Record {
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

function candidateWorkspaceFromRow(row: SqlRow): WorkflowCandidateWorkspaceV17Record {
  const failure = jsonColumn<JsonObject>(row, "failure_json");
  return {
    workspaceId: requiredString(row, "workspace_id"),
    runId: requiredString(row, "run_id"),
    candidateOperationId: requiredString(row, "candidate_operation_id"),
    bodyScopeId: requiredString(row, "body_scope_id"),
    ...(optionalString(row, "parent_candidate_id") ? { parentCandidateId: optionalString(row, "parent_candidate_id")! } : {}),
    state: requiredString(row, "state") as WorkflowCandidateWorkspaceV17Record["state"],
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

function candidateDispositionFromRow(row: SqlRow): WorkflowCandidateDispositionV17Record {
  const reason = jsonColumn<JsonObject>(row, "reason_json");
  return {
    candidateId: requiredString(row, "candidate_id"),
    runId: requiredString(row, "run_id"),
    ...(optionalString(row, "operation_id") ? { operationId: optionalString(row, "operation_id")! } : {}),
    disposition: requiredString(row, "disposition") as WorkflowCandidateDispositionV17Record["disposition"],
    authorityHash: requiredString(row, "authority_hash"),
    ...(optionalString(row, "verification_id") ? { verificationId: optionalString(row, "verification_id")! } : {}),
    ...(optionalString(row, "measurement_id") ? { measurementId: optionalString(row, "measurement_id")! } : {}),
    ...(reason ? { reason } : {}),
    disposedAt: requiredString(row, "disposed_at"),
  };
}

function candidateMeasurementFromRow(row: SqlRow): WorkflowCandidateMeasurementV17Record {
  return {
    measurementId: requiredString(row, "measurement_id"),
    runId: requiredString(row, "run_id"),
    candidateId: requiredString(row, "candidate_id"),
    operationId: requiredString(row, "operation_id"),
    bindingHash: requiredString(row, "binding_hash"),
    status: requiredString(row, "status") as WorkflowCandidateMeasurementV17Record["status"],
    createdAt: requiredString(row, "created_at"),
    ...(optionalString(row, "finalized_at") ? { finalizedAt: optionalString(row, "finalized_at")! } : {}),
  };
}

function candidateVerificationFromRow(row: SqlRow): WorkflowCandidateVerificationV17Record {
  return {
    verificationId: requiredString(row, "verification_id"),
    runId: requiredString(row, "run_id"),
    candidateId: requiredString(row, "candidate_id"),
    operationId: requiredString(row, "operation_id"),
    status: requiredString(row, "status") as WorkflowCandidateVerificationV17Record["status"],
    bindingHash: requiredString(row, "binding_hash"),
    evidenceHash: requiredString(row, "evidence_hash"),
    artifactDigest: requiredString(row, "artifact_digest"),
    createdAt: requiredString(row, "created_at"),
  };
}

function candidateDispositionSemantic(
  candidate: WorkflowCandidateV17Record,
  disposition: WorkflowCandidateDispositionV17Record["disposition"],
  reason: JsonObject | undefined,
  verification: WorkflowCandidateVerificationV17Record | undefined,
  measurement: WorkflowCandidateMeasurementV17Record | undefined,
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

function assertCreateOptions(options: CreateWorkflowRunDatabaseV17Options): void {
  assertIdentifier(options.runId, "workflow v17 run id");
  assertWorkflowV17InvocationSnapshot(options.snapshot);
  if (options.snapshot.runtimeApiHash !== WORKFLOW_V17_RUNTIME_API_HASH) {
    throw new TypeError("Workflow v17 invocation uses another runtime API");
  }
  assertHash(options.projectSnapshotHash, "workflow v17 project snapshot hash");
  assertHash(options.routeSnapshotHash, "workflow v17 route snapshot hash");
  assertHash(options.contextIdentityHash, "workflow v17 context identity hash");
  assertSafety(options.safety);
  assertIsoDate(options.createdAt, "workflow v17 run createdAt");
}

function assertRunRecord(run: WorkflowRunV17Record): void {
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
    ["context identity", run.contextIdentityHash],
    ["policy", run.launch.policyHash],
  ] as const) assertHash(value, `workflow v17 ${label} hash`);
  if (run.workflow.runtimeApiHash !== WORKFLOW_V17_RUNTIME_API_HASH) {
    throw corrupt("Workflow v17 run uses another runtime API hash");
  }
  if (!new Set(["model", "user", "rpc"]).has(run.launch.authority)
    || !new Set(["human", "model"]).has(run.launch.exposure)
    || (run.launch.authority === "model" && run.launch.exposure !== "model")
    || (run.workflow.id.startsWith("project:") && !run.launch.projectTrusted)) {
    throw corrupt("Workflow v17 run has invalid launch authority");
  }
  if (!new Set<WorkflowRunV17Status>(["queued", "running", "waiting", "paused", "completed", "failed", "stopped"]).has(run.status)) {
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

function assertResourceRecord(resource: WorkflowInvocationResourceV17Record, runId: string): void {
  if (resource.runId !== runId || resource.kind !== "measurement-profile"
    || resource.resourceId !== workflowV17ResourceId(resource.inputPath, resource.bindingHash)
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

function assertClaimInput(input: ClaimWorkflowOperationV17Input): void {
  assertPositiveRevision(input.expectedRevision);
  assertIdentifier(input.scopeId, "workflow v17 operation scope id");
  assertNonNegativeInteger(input.cursor, "workflow v17 operation cursor");
  if (input.cursor > 999_999) throw new TypeError("Workflow v17 operation cursor exceeds path bound");
  if (!new Set<WorkflowOperationV17Kind>([
    "parallel", "map", "agent", "command", "ask", "metrics", "measure", "candidate",
    "verify", "accept", "reject", "record-experiment", "apply",
  ]).has(input.kind)) throw new TypeError("Invalid workflow v17 operation kind");
  assertSourceSite(input.sourceSite);
  if (input.descriptorSourceSite) assertSourceSite(input.descriptorSourceSite);
  if (input.title !== undefined) assertDisplayTitle(input.title);
  assertHash(input.semanticInputHash, "workflow v17 semantic input hash");
  assertIsoDate(input.at, "workflow v17 operation claim time");
}

function assertCompleteCallInput(input: CompleteWorkflowCallV17Input): void {
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
  if (input.replay) {
    assertIdentifier(input.replay.sourceRunId, "workflow v17 replay source run id");
    assertIdentifier(input.replay.sourceOperationId, "workflow v17 replay source operation id");
    assertScopePath(input.replay.sourceScopePath);
    assertNonNegativeInteger(input.replay.sourceCursor, "workflow v17 replay source cursor");
    assertHash(input.replay.sourceCallKey, "workflow v17 replay source call key");
  }
  assertIsoDate(input.at, "workflow v17 call completion time");
}

function assertCompleteStructuralJoinInput(input: CompleteWorkflowStructuralJoinV17Input): void {
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

function assertChildScopeSpecs(specs: readonly CreateWorkflowChildScopeV17Spec[]): void {
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
  ownerKind: WorkflowOperationV17Kind,
  specs: readonly CreateWorkflowChildScopeV17Spec[],
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
  existing: readonly WorkflowScopeV17Record[],
  owner: WorkflowOperationV17Record,
  specs: readonly CreateWorkflowChildScopeV17Spec[],
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

function assertCreateCandidateWorkspaceInput(input: CreateCandidateWorkspaceV17Input): void {
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

function assertFreezeCandidateInput(input: FreezeCandidateV17Input): void {
  assertPositiveRevision(input.expectedRevision);
  assertIdentifier(input.workspaceId, "workflow v17 candidate workspace id");
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

function assertDisposeCandidateInput(input: DisposeCandidateV17Input): void {
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
  verification: Omit<WorkflowCandidateVerificationV17Record, "runId">,
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

function assertCandidateApplyRecord(apply: Omit<WorkflowCandidateApplyV17Record, "runId">): void {
  assertIdentifier(apply.receiptId, "workflow v17 apply receipt id");
  assertIdentifier(apply.candidateId, "workflow v17 apply candidate id");
  assertIdentifier(apply.operationId, "workflow v17 apply operation id");
  assertIdentifier(apply.approvalId, "workflow v17 approval id");
  assertHash(apply.verificationBindingHash, "workflow v17 apply verification binding hash");
  assertHash(apply.authorityHash, "workflow v17 apply authority hash");
  assertIsoDate(apply.appliedAt, "workflow v17 apply time");
}

function assertArtifactRecord(artifact: WorkflowArtifactV17Record): void {
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

function assertAttemptRecord(attempt: WorkflowAttemptV17Record): void {
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

function assertWorkspaceCheckpoint(checkpoint: WorkflowWorkspaceCheckpointV17Record): void {
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

function assertRunTransitionInput(input: TransitionWorkflowRunV17Input): void {
  if (!new Set<WorkflowRunV17Status>(["queued", "running", "waiting", "paused", "completed", "failed", "stopped"]).has(input.status)) {
    throw new TypeError("Invalid workflow v17 run transition status");
  }
  if (input.reason) canonicalJsonValue(input.reason, jsonLimits());
  if (input.currentOperationId) assertIdentifier(input.currentOperationId, "workflow v17 current operation id");
  if (input.status === "completed") {
    if (!input.rootTerminalKey) throw new TypeError("Completed workflow v17 run requires root terminal key");
    assertHash(input.rootTerminalKey, "workflow v17 root terminal key");
  } else if (input.rootTerminalKey !== undefined) {
    throw new TypeError("Only completed workflow v17 run accepts root terminal key");
  }
  assertIsoDate(input.at, "workflow v17 run transition time");
}

function assertRunTransition(from: WorkflowRunV17Status, to: WorkflowRunV17Status): void {
  const allowed: Record<WorkflowRunV17Status, readonly WorkflowRunV17Status[]> = {
    queued: ["running", "stopped"],
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
  owner: WorkflowOperationV17Record,
  spec: CreateWorkflowChildScopeV17Spec,
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

function laneOutcome(status: WorkflowScopeV17Record["status"]): WorkflowStructuralJoinLaneV17Record["outcome"] {
  if (status === "completed") return "success";
  if (status === "failed") return "failure";
  if (status === "cancelled") return "cancelled";
  throw state("Active scope has no structural lane outcome");
}

function assertEvent(event: WorkflowRunV17Event): void {
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
  if (actual !== expected) throw new WorkflowRunDatabaseV17RevisionConflictError(expected, actual);
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
  options: WorkflowRunDatabaseV17OpenOptions,
  creating = false,
): DatabaseSync {
  const busyTimeoutMs = options.busyTimeoutMs ?? WORKFLOW_RUN_DATABASE_V17_BUSY_TIMEOUT_MS;
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
      if (version !== WORKFLOW_RUN_DATABASE_V17_SCHEMA_VERSION) {
        throw new WorkflowRunDatabaseV17VersionError(version);
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
  if (error instanceof WorkflowRunDatabaseV17StateError
    || error instanceof WorkflowRunDatabaseV17RevisionConflictError
    || error instanceof WorkflowRunDatabaseV17CorruptionError
    || error instanceof TypeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/constraint|foreign key|unique/iu.test(message)) return state(`Workflow v17 database rejected state: ${message}`);
  return error;
}

function state(message: string): WorkflowRunDatabaseV17StateError {
  return new WorkflowRunDatabaseV17StateError(message);
}

function corrupt(message: string): WorkflowRunDatabaseV17CorruptionError {
  return new WorkflowRunDatabaseV17CorruptionError(message);
}
