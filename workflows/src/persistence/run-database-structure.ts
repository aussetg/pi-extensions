import type { DatabaseSync } from "./sqlite.js";
import type { OperationRecord, RunRecord, StructuredReason } from "../runtime/durable-types.js";
import {
  assertPositiveInteger,
  optionalReasonJson,
  optionalString,
  requiredNumber,
  requiredString,
  type SqlRow,
} from "./run-database-codec.js";
import { RunDatabaseAdmissionError, RunDatabaseStateError } from "./run-database-errors.js";
import { insertOperationRow, requiredOperation } from "./run-database-records.js";
import type { OperationAdmissionLimits, OperationPreclaim } from "./run-database-types.js";
import { assertOperation } from "./run-database-validation.js";

export function validateOperationPreclaim(input: OperationPreclaim): void {
  if (!Array.isArray(input.operations) || input.operations.length < 1) {
    throw new TypeError("Operation preclaim requires at least one operation");
  }
  const paths = new Set<string>();
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  for (const operation of input.operations) {
    assertOperation(operation);
    if (operation.status !== "queued" || operation.result || operation.reason || operation.startedAt) {
      throw new TypeError("A preclaimed operation must be a fresh queued operation");
    }
    if (paths.has(operation.path) || ids.has(operation.operationId) || ordinals.has(operation.ordinal)) {
      throw new TypeError("Operation preclaim contains duplicate identity");
    }
    paths.add(operation.path);
    ids.add(operation.operationId);
    ordinals.add(operation.ordinal);
  }
}

export function applyOperationPreclaim(
  database: DatabaseSync,
  run: RunRecord,
  input: OperationPreclaim,
): void {
  if (run.status !== "running") throw new RunDatabaseStateError(`Run is ${run.status}, not admitting operations`);
  const missing: OperationRecord[] = [];
  for (const requested of input.operations) {
    if (requested.runId !== run.runId) throw new TypeError("Operation belongs to a different run");
    const row = database.prepare(
      "SELECT * FROM operations WHERE run_id = ? AND path = ?",
    ).get(run.runId, requested.path) as SqlRow | undefined;
    if (row) assertSameOperationClaimRow(row, requested);
    else missing.push(requested);
  }
  assertOperationAdmission(database, input.admission, missing);
  for (const operation of missing) {
    if (operation.parentOperationId) requiredOperation(database, operation.parentOperationId, run.runId);
    insertOperationRow(database, operation);
  }
}

export interface OperationOrderPlan {
  ordered: string[];
  current: Map<string, number>;
  maximum: number;
  changed: boolean;
}

export function planOperationOrder(database: DatabaseSync): OperationOrderPlan {
  const rows = database.prepare(
    "SELECT operation_id, parent_operation_id, ordinal FROM operations ORDER BY ordinal",
  ).all() as SqlRow[];
  const byParent = new Map<string | undefined, Array<{ id: string; ordinal: number }>>();
  for (const row of rows) {
    const parent = optionalString(row, "parent_operation_id");
    const children = byParent.get(parent) ?? [];
    children.push({ id: requiredString(row, "operation_id"), ordinal: requiredNumber(row, "ordinal") });
    byParent.set(parent, children);
  }
  for (const children of byParent.values()) children.sort((left, right) => left.ordinal - right.ordinal);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) throw new RunDatabaseStateError("Operation tree contains a cycle");
    seen.add(id);
    ordered.push(id);
    for (const child of byParent.get(id) ?? []) visit(child.id);
  };
  for (const root of byParent.get(undefined) ?? []) visit(root.id);
  if (ordered.length !== rows.length) throw new RunDatabaseStateError("Operation tree has an unreachable parent");
  const current = new Map(rows.map((row) => [
    requiredString(row, "operation_id"),
    requiredNumber(row, "ordinal"),
  ]));
  return {
    ordered,
    current,
    maximum: rows.reduce((value, row) => Math.max(value, requiredNumber(row, "ordinal")), -1),
    changed: !ordered.every((id, ordinal) => current.get(id) === ordinal),
  };
}

export function applyOperationOrder(database: DatabaseSync, plan: OperationOrderPlan): void {
  const offset = plan.maximum + plan.ordered.length + 1;
  if (!Number.isSafeInteger(offset)) throw new RangeError("Operation ordinal offset overflow");
  database.prepare("UPDATE operations SET ordinal = ordinal + ?").run(offset);
  for (let ordinal = 0; ordinal < plan.ordered.length; ordinal++) {
    database.prepare("UPDATE operations SET ordinal = ? WHERE operation_id = ?")
      .run(ordinal, plan.ordered[ordinal]!);
  }
}

export function applySafetyPause(
  database: DatabaseSync,
  run: RunRecord,
  at: string,
  reason: StructuredReason,
): void {
  if (run.status !== "running" && run.status !== "queued") {
    throw new RunDatabaseStateError(`Run is ${run.status}, not safety-pausable`);
  }
  const encoded = optionalReasonJson(reason);
  database.prepare(
    "UPDATE operations SET status = 'paused', reason_json = ?, updated_at = ? WHERE status = 'running'",
  ).run(encoded, at);
  database.prepare(
    "UPDATE attempts SET status = 'paused', reason_json = ?, updated_at = ? WHERE status = 'running'",
  ).run(encoded, at);
  database.prepare(`
    UPDATE agent_sessions SET status = 'paused', reason_json = ?, current_execution_id = NULL, updated_at = ?
    WHERE status = 'running'
  `).run(encoded, at);
  database.prepare("UPDATE runs SET status = 'paused', reason_json = ?, ended_at = NULL WHERE singleton = 1")
    .run(encoded);
}

export function assertSameOperationClaim(existing: OperationRecord, requested: OperationRecord): void {
  const same = existing.operationId === requested.operationId
    && existing.runId === requested.runId
    && existing.parentOperationId === requested.parentOperationId
    && existing.path === requested.path
    && existing.sourceId === requested.sourceId
    && existing.kind === requested.kind
    && existing.ordinal === requested.ordinal
    && existing.semanticInputHash === requested.semanticInputHash
    && existing.callKey === requested.callKey;
  if (!same) throw new RunDatabaseStateError(`Operation path ${requested.path} was claimed with different semantics`);
}

export function assertSameOperationClaimRow(row: SqlRow, requested: OperationRecord): void {
  const same = requiredString(row, "operation_id") === requested.operationId
    && requiredString(row, "run_id") === requested.runId
    && optionalString(row, "parent_operation_id") === requested.parentOperationId
    && requiredString(row, "path") === requested.path
    && requiredString(row, "source_id") === requested.sourceId
    && requiredString(row, "kind") === requested.kind
    && requiredNumber(row, "ordinal") === requested.ordinal
    && requiredString(row, "semantic_input_hash") === requested.semanticInputHash
    && optionalString(row, "call_key") === requested.callKey;
  if (!same) throw new RunDatabaseStateError(`Operation path ${requested.path} was claimed with different semantics`);
}

export function assertOperationAdmission(
  database: DatabaseSync,
  limits: OperationAdmissionLimits,
  requested: readonly OperationRecord[],
): void {
  assertPositiveInteger(limits.maximumOperations, "maximum operations");
  assertPositiveInteger(limits.maximumAgentOperations, "maximum agent operations");
  if (requested.length === 0) return;
  const admitted = requiredNumber(database.prepare("SELECT count(*) AS value FROM operations").get() as SqlRow, "value");
  if (admitted + requested.length > limits.maximumOperations) {
    throw new RunDatabaseAdmissionError("operations", admitted, requested.length, limits.maximumOperations);
  }
  const requestedAgents = requested.filter((operation) => operation.kind === "agent").length;
  if (requestedAgents === 0) return;
  const admittedAgents = requiredNumber(
    database.prepare("SELECT count(*) AS value FROM operations WHERE kind = 'agent'").get() as SqlRow,
    "value",
  );
  if (admittedAgents + requestedAgents > limits.maximumAgentOperations) {
    throw new RunDatabaseAdmissionError(
      "agent-launches",
      admittedAgents,
      requestedAgents,
      limits.maximumAgentOperations,
    );
  }
}
