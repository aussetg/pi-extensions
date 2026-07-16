import type { DatabaseSync } from "./sqlite.js";
import { Ajv } from "ajv";
import type {
  ControlAcknowledgement,
  ControlRequest,
  HumanCheckpointRecord,
  RunRecord,
  StructuredReason,
} from "../runtime/durable-types.js";
import type { JsonValue } from "../types.js";
import {
  assertHash,
  assertIdentifier,
  assertIsoDate,
  assertText,
  decodeCanonicalJson,
  encodeCanonicalJson,
  optionalReasonJson,
  optionalString,
  requiredNumber,
  requiredString,
  type SqlRow,
} from "./run-database-codec.js";
import { RunDatabaseCorruptionError } from "./run-database-codec.js";
import { RunDatabaseStateError } from "./run-database-errors.js";
import { controlRequestFromRow } from "./run-database-reader.js";
import { requiredOperation } from "./run-database-records.js";

const TERMINAL = new Set(["completed", "failed", "stopped"]);
const ACTIVE = "'queued', 'running', 'waiting', 'paused'";

export type CoordinatorOpenDisposition = "none" | "started" | "recovered" | "stale-effects-settled";

export interface CoordinatorOpenMutation {
  disposition: CoordinatorOpenDisposition;
  runningOperationIds: string[];
}

export interface CoordinatorControlMutation {
  request: ControlRequest;
  acknowledgement: ControlAcknowledgement;
  exitRequested: boolean;
}

export function coordinatorOpenMutation(
  database: DatabaseSync,
  run: RunRecord,
): CoordinatorOpenMutation {
  const runningOperationIds = (database.prepare(
    "SELECT operation_id FROM operations WHERE status = 'running' ORDER BY ordinal",
  ).all() as SqlRow[]).map((row) => requiredString(row, "operation_id"));
  const runningAttempts = scalar(database, "SELECT count(*) AS value FROM attempts WHERE status = 'running'");
  const runningSessions = scalar(database, "SELECT count(*) AS value FROM agent_sessions WHERE status = 'running'");
  const hasRunningWork = runningOperationIds.length > 0 || runningAttempts > 0 || runningSessions > 0;

  if (run.status === "queued" && !hasRunningWork) return { disposition: "started", runningOperationIds };
  if ((run.status === "queued" || run.status === "running" || TERMINAL.has(run.status)) && hasRunningWork) {
    return {
      disposition: "stale-effects-settled",
      runningOperationIds,
    };
  }
  if (run.status === "running") return { disposition: "recovered", runningOperationIds };
  return { disposition: "none", runningOperationIds };
}

export function applyCoordinatorOpenMutation(
  database: DatabaseSync,
  run: RunRecord,
  mutation: CoordinatorOpenMutation,
  at: string,
): void {
  assertIsoDate(at, "coordinator open time");
  if (mutation.disposition === "none") return;
  if (mutation.disposition === "started") {
    database.prepare(`
      UPDATE runs SET status = 'running', reason_json = NULL, started_at = coalesce(started_at, ?), ended_at = NULL
      WHERE singleton = 1
    `).run(at);
    return;
  }
  if (mutation.disposition === "recovered") return;

  const reason: StructuredReason = {
    category: "infrastructure",
    code: "coordinator-interrupted",
    summary: "The prior coordinator stopped before its running work settled",
    retryable: true,
    ...(run.currentOperationId ? { operationId: run.currentOperationId } : {}),
  };
  const reasonJson = optionalReasonJson(reason);
  const childStatus = TERMINAL.has(run.status) ? "stopped" : "paused";
  database.prepare(`
    UPDATE operations SET status = ?, reason_json = ?, updated_at = ?,
      ended_at = CASE WHEN ? = 'stopped' THEN ? ELSE ended_at END
    WHERE status = 'running'
  `).run(childStatus, reasonJson, at, childStatus, at);
  database.prepare(`
    UPDATE attempts SET status = ?, reason_json = ?, updated_at = ?,
      ended_at = CASE WHEN ? = 'stopped' THEN ? ELSE ended_at END
    WHERE status = 'running'
  `).run(childStatus, reasonJson, at, childStatus, at);
  database.prepare(`
    UPDATE agent_sessions SET status = ?, reason_json = ?, current_execution_id = NULL, updated_at = ?
    WHERE status = 'running'
  `).run(childStatus, reasonJson, at);
  if (!TERMINAL.has(run.status)) {
    database.prepare("UPDATE runs SET status = 'paused', reason_json = ?, ended_at = NULL WHERE singleton = 1")
      .run(reasonJson);
  } else {
    database.prepare("UPDATE runs SET current_operation_id = NULL WHERE singleton = 1").run();
  }
}

export function applyCoordinatorSignalPause(
  database: DatabaseSync,
  run: RunRecord,
  at: string,
  summary: string,
): void {
  if (TERMINAL.has(run.status) || run.status === "waiting" || run.status === "paused") return;
  const reason = controlReason("coordinator-signal", summary, true, run.currentOperationId);
  pauseRunning(database, reason, at);
  database.prepare("UPDATE runs SET status = 'paused', reason_json = ?, ended_at = NULL WHERE singleton = 1")
    .run(optionalReasonJson(reason));
}

export function insertHumanCheckpoint(
  database: DatabaseSync,
  checkpoint: HumanCheckpointRecord,
  runId: string,
  nextRevision: number,
): void {
  assertHumanCheckpoint(checkpoint);
  if (checkpoint.runId !== runId) throw new TypeError("Human checkpoint belongs to another run");
  if (checkpoint.status !== "waiting" || checkpoint.response !== undefined || checkpoint.resolvedAt !== undefined) {
    throw new TypeError("A new human checkpoint must be unresolved and waiting");
  }
  if (checkpoint.requestedRevision !== nextRevision) {
    throw new TypeError("Human checkpoint must bind the revision committed with its request");
  }
  const operation = requiredOperation(database, checkpoint.operationId, runId);
  if (requiredString(operation, "kind") !== "checkpoint") {
    throw new RunDatabaseStateError("Human checkpoint operation has the wrong kind");
  }
  const request = checkpoint.request;
  database.prepare(`
    INSERT INTO human_checkpoints(
      checkpoint_id, run_id, operation_id, status, request_kind, title, prompt,
      choices_json, response_schema_json, challenge_hash, requested_revision,
      response_json, requested_at, resolved_at
    ) VALUES (?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
  `).run(
    checkpoint.checkpointId,
    runId,
    checkpoint.operationId,
    request.kind,
    request.title ?? null,
    request.prompt,
    request.kind === "choice" ? encodeCanonicalJson(request.choices as unknown as JsonValue, "value") : null,
    request.kind === "input" ? encodeCanonicalJson(request.responseSchema as unknown as JsonValue) : null,
    checkpoint.challengeHash,
    checkpoint.requestedRevision,
    checkpoint.requestedAt,
  );
  database.prepare("UPDATE operations SET status = 'waiting', updated_at = ? WHERE operation_id = ?")
    .run(checkpoint.requestedAt, checkpoint.operationId);
  database.prepare("UPDATE runs SET status = 'waiting', reason_json = NULL, current_operation_id = ? WHERE singleton = 1")
    .run(checkpoint.operationId);
}

export function applyCoordinatorControl(
  database: DatabaseSync,
  run: RunRecord,
  nextRevision: number,
  requestId: string,
  at: string,
): CoordinatorControlMutation {
  assertIdentifier(requestId, "control request id");
  assertIsoDate(at, "control acknowledgement time");
  const row = database.prepare(
    "SELECT * FROM control_requests WHERE request_id = ? AND run_id = ?",
  ).get(requestId, run.runId) as SqlRow | undefined;
  if (!row) throw new RunDatabaseStateError(`Unknown control request ${requestId}`);
  if (database.prepare("SELECT 1 AS value FROM control_acknowledgements WHERE request_id = ?").get(requestId)) {
    throw new RunDatabaseStateError(`Control request ${requestId} is already acknowledged`);
  }
  const request = controlRequestFromRow(row);
  if (request.expectedRevision >= run.revision) {
    throw new RunDatabaseCorruptionError(`Control request ${requestId} was not committed after its bound revision`);
  }

  const decision = decideControl(database, run, request, at);
  database.prepare(`
    INSERT INTO control_acknowledgements(request_id, run_id, accepted, revision, reason_json, acknowledged_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    requestId,
    run.runId,
    decision.accepted ? 1 : 0,
    nextRevision,
    optionalReasonJson(decision.reason),
    at,
  );
  return {
    request,
    acknowledgement: {
      requestId,
      runId: run.runId,
      accepted: decision.accepted,
      revision: nextRevision,
      ...(decision.reason ? { reason: decision.reason } : {}),
      acknowledgedAt: at,
    },
    exitRequested: decision.exitRequested,
  };
}

function decideControl(
  database: DatabaseSync,
  run: RunRecord,
  request: ControlRequest,
  at: string,
): { accepted: boolean; reason?: StructuredReason; exitRequested: boolean } {
  switch (request.kind) {
    case "pause": {
      if (run.status !== "queued" && run.status !== "running") return rejected(request, run, "not-pausable", `Run is ${run.status}, not active`);
      const reason = controlReason("paused", request.reason ?? "Human paused the workflow", true, run.currentOperationId);
      pauseRunning(database, reason, at);
      database.prepare("UPDATE runs SET status = 'paused', reason_json = ?, ended_at = NULL WHERE singleton = 1")
        .run(optionalReasonJson(reason));
      return { accepted: true, exitRequested: false };
    }
    case "resume": {
      if (run.status !== "paused") return rejected(request, run, "not-paused", `Run is ${run.status}, not paused`);
      database.prepare("UPDATE operations SET status = 'running', reason_json = NULL, updated_at = ? WHERE status = 'paused'").run(at);
      database.prepare("UPDATE attempts SET status = 'running', reason_json = NULL, updated_at = ? WHERE status = 'paused'").run(at);
      database.prepare(`
        UPDATE agent_sessions SET status = 'running', reason_json = NULL, updated_at = ? WHERE status = 'paused'
      `).run(at);
      database.prepare(`
        UPDATE runs SET status = 'running', reason_json = NULL,
          started_at = coalesce(started_at, ?), ended_at = NULL
        WHERE singleton = 1
      `).run(at);
      return { accepted: true, exitRequested: false };
    }
    case "stop": {
      if (TERMINAL.has(run.status)) return rejected(request, run, "already-terminal", `Run is already ${run.status}`);
      const reason = controlReason("stopped", request.reason ?? "Human stopped the workflow", false, run.currentOperationId);
      stopAll(database, reason, at);
      database.prepare(`
        UPDATE runs SET status = 'stopped', reason_json = ?, current_operation_id = NULL, ended_at = ? WHERE singleton = 1
      `).run(optionalReasonJson(reason), at);
      return { accepted: true, exitRequested: false };
    }
    case "stop-effect": {
      const operation = database.prepare(
        "SELECT status FROM operations WHERE operation_id = ? AND run_id = ?",
      ).get(request.operationId, run.runId) as SqlRow | undefined;
      if (!operation) return rejected(request, run, "unknown-operation", `Unknown operation ${request.operationId}`, request.operationId);
      const status = requiredString(operation, "status");
      if (!new Set(["queued", "running", "waiting", "paused"]).has(status)) {
        return rejected(request, run, "effect-not-active", `Operation ${request.operationId} is ${status}`, request.operationId);
      }
      const reason = controlReason("effect-stopped", request.reason ?? "Human stopped this effect", false, request.operationId);
      const reasonJson = optionalReasonJson(reason);
      database.prepare(`
        UPDATE operations SET status = 'stopped', reason_json = ?, updated_at = ?, ended_at = ? WHERE operation_id = ?
      `).run(reasonJson, at, at, request.operationId);
      database.prepare(`
        UPDATE attempts SET status = 'stopped', reason_json = ?, updated_at = ?, ended_at = ?
        WHERE operation_id = ? AND status IN (${ACTIVE})
      `).run(reasonJson, at, at, request.operationId);
      database.prepare(`
        UPDATE agent_sessions SET status = 'stopped', reason_json = ?, current_execution_id = NULL, updated_at = ?
        WHERE operation_id = ? AND status IN (${ACTIVE})
      `).run(reasonJson, at, request.operationId);
      if (run.currentOperationId === request.operationId) {
        database.prepare("UPDATE runs SET current_operation_id = NULL WHERE singleton = 1").run();
      }
      return { accepted: true, exitRequested: false };
    }
    case "checkpoint-response":
      return resolveCheckpoint(database, run, request, at);
    case "approve":
    case "reject":
      return resolveApproval(database, run, request, at);
    case "shutdown": {
      if (!TERMINAL.has(run.status) && run.status !== "waiting" && run.status !== "paused") {
        const reason = controlReason("coordinator-shutdown", "Human requested coordinator shutdown", true, run.currentOperationId);
        pauseRunning(database, reason, at);
        database.prepare("UPDATE runs SET status = 'paused', reason_json = ?, ended_at = NULL WHERE singleton = 1")
          .run(optionalReasonJson(reason));
      }
      return { accepted: true, exitRequested: true };
    }
  }
}

function resolveCheckpoint(
  database: DatabaseSync,
  run: RunRecord,
  request: Extract<ControlRequest, { kind: "checkpoint-response" }>,
  at: string,
): { accepted: boolean; reason?: StructuredReason; exitRequested: boolean } {
  const row = database.prepare(
    "SELECT * FROM human_checkpoints WHERE checkpoint_id = ? AND run_id = ?",
  ).get(request.checkpointId, run.runId) as SqlRow | undefined;
  if (!row) return rejected(request, run, "unknown-checkpoint", `Unknown checkpoint ${request.checkpointId}`);
  const operationId = requiredString(row, "operation_id");
  if (requiredString(row, "status") !== "waiting" || run.status !== "waiting") {
    return rejected(request, run, "checkpoint-not-waiting", "Checkpoint is no longer waiting", operationId);
  }
  if (requiredString(row, "challenge_hash") !== request.challengeHash) {
    return rejected(request, run, "challenge-mismatch", "Checkpoint challenge changed before the response was consumed", operationId);
  }
  const invalid = invalidCheckpointValue(row, request.value);
  if (invalid) return rejected(request, run, "invalid-response", invalid, operationId);

  database.prepare(`
    UPDATE human_checkpoints SET status = 'completed', response_json = ?, resolved_at = ?
    WHERE checkpoint_id = ? AND status = 'waiting'
  `).run(encodeCanonicalJson(request.value, "value"), at, request.checkpointId);
  database.prepare("UPDATE operations SET status = 'running', reason_json = NULL, updated_at = ? WHERE operation_id = ?")
    .run(at, operationId);
  database.prepare(`
    UPDATE runs SET status = 'running', reason_json = NULL, current_operation_id = ?, ended_at = NULL WHERE singleton = 1
  `).run(operationId);
  return { accepted: true, exitRequested: false };
}

function resolveApproval(
  database: DatabaseSync,
  run: RunRecord,
  request: Extract<ControlRequest, { kind: "approve" | "reject" }>,
  at: string,
): { accepted: boolean; reason?: StructuredReason; exitRequested: boolean } {
  const row = database.prepare(
    "SELECT * FROM approvals WHERE approval_id = ? AND run_id = ?",
  ).get(request.approvalId, run.runId) as SqlRow | undefined;
  if (!row || requiredString(row, "kind") !== "apply") {
    return rejected(request, run, "unknown-approval", `Unknown apply approval ${request.approvalId}`);
  }
  const operationId = requiredString(row, "operation_id");
  if (requiredString(row, "status") !== "waiting" || run.status !== "waiting") {
    return rejected(request, run, "approval-not-waiting", "Apply approval is no longer waiting", operationId);
  }
  if (!request.actor.startsWith("human:")) {
    return rejected(request, run, "actor-not-human", "Apply approval requires a human actor", operationId);
  }
  if (requiredString(row, "challenge_hash") !== request.challengeHash) {
    return rejected(request, run, "challenge-mismatch", "Approval challenge changed before the decision was consumed", operationId);
  }

  const decision = request.kind === "approve" ? "approved" : "rejected";
  database.prepare(`
    UPDATE approvals SET status = 'completed', decision = ?, actor = ?, resolved_at = ?
    WHERE approval_id = ? AND status = 'waiting'
  `).run(decision, request.actor, at, request.approvalId);
  if (decision === "approved") {
    database.prepare("UPDATE operations SET status = 'running', reason_json = NULL, updated_at = ? WHERE operation_id = ?")
      .run(at, operationId);
    database.prepare("UPDATE attempts SET status = 'running', reason_json = NULL, updated_at = ? WHERE operation_id = ? AND status = 'waiting'")
      .run(at, operationId);
    database.prepare(`
      UPDATE runs SET status = 'running', reason_json = NULL, current_operation_id = ?, ended_at = NULL WHERE singleton = 1
    `).run(operationId);
  } else {
    const reason = controlReason(
      "approval-rejected",
      request.kind === "reject" ? request.reason ?? "Human rejected live-project apply" : "Human rejected live-project apply",
      false,
      operationId,
      "approval",
    );
    database.prepare(`
      UPDATE operations SET status = 'stopped', reason_json = ?, updated_at = ?, ended_at = ? WHERE operation_id = ?
    `).run(optionalReasonJson(reason), at, at, operationId);
    database.prepare(`
      UPDATE attempts SET status = 'stopped', reason_json = ?, updated_at = ?, ended_at = ?
      WHERE operation_id = ? AND status IN (${ACTIVE})
    `).run(optionalReasonJson(reason), at, at, operationId);
    database.prepare(`
      UPDATE runs SET status = 'stopped', reason_json = ?, current_operation_id = NULL, ended_at = ? WHERE singleton = 1
    `).run(optionalReasonJson(reason), at);
  }
  return { accepted: true, exitRequested: false };
}

function pauseRunning(database: DatabaseSync, reason: StructuredReason, at: string): void {
  const reasonJson = optionalReasonJson(reason);
  database.prepare("UPDATE operations SET status = 'paused', reason_json = ?, updated_at = ? WHERE status = 'running'")
    .run(reasonJson, at);
  database.prepare("UPDATE attempts SET status = 'paused', reason_json = ?, updated_at = ? WHERE status = 'running'")
    .run(reasonJson, at);
  database.prepare(`
    UPDATE agent_sessions SET status = 'paused', reason_json = ?, current_execution_id = NULL, updated_at = ?
    WHERE status = 'running'
  `).run(reasonJson, at);
}

function stopAll(database: DatabaseSync, reason: StructuredReason, at: string): void {
  const reasonJson = optionalReasonJson(reason);
  database.prepare(`
    UPDATE operations SET status = 'stopped', reason_json = ?, updated_at = ?, ended_at = ?
    WHERE status IN (${ACTIVE})
  `).run(reasonJson, at, at);
  database.prepare(`
    UPDATE attempts SET status = 'stopped', reason_json = ?, updated_at = ?, ended_at = ?
    WHERE status IN (${ACTIVE})
  `).run(reasonJson, at, at);
  database.prepare(`
    UPDATE agent_sessions SET status = 'stopped', reason_json = ?, current_execution_id = NULL, updated_at = ?
    WHERE status IN (${ACTIVE})
  `).run(reasonJson, at);
  database.prepare("UPDATE human_checkpoints SET status = 'stopped', resolved_at = ? WHERE status = 'waiting'").run(at);
  database.prepare("UPDATE approvals SET status = 'stopped', resolved_at = ? WHERE status = 'waiting'").run(at);
}

function invalidCheckpointValue(row: SqlRow, value: JsonValue): string | undefined {
  const kind = requiredString(row, "request_kind");
  if (kind === "confirm") return typeof value === "boolean" ? undefined : "Confirmation response must be boolean";
  if (kind === "choice") {
    const source = optionalString(row, "choices_json");
    if (!source) throw new RunDatabaseCorruptionError("Choice checkpoint has no choices");
    const choices = decodeCanonicalJson(source, "value") as unknown as Array<{ id?: unknown }>;
    return typeof value === "string" && choices.some((choice) => choice.id === value)
      ? undefined
      : "Choice response is not one of the declared ids";
  }
  if (kind === "input") {
    const source = optionalString(row, "response_schema_json");
    if (!source) throw new RunDatabaseCorruptionError("Input checkpoint has no response schema");
    try {
      const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
      const validate = ajv.compile(decodeCanonicalJson(source));
      return validate(value) ? undefined : `Checkpoint response failed schema: ${bounded(ajv.errorsText(validate.errors), 512)}`;
    } catch (error) {
      throw new RunDatabaseCorruptionError(`Stored checkpoint schema is invalid: ${bounded(errorText(error), 512)}`);
    }
  }
  throw new RunDatabaseCorruptionError(`Unknown checkpoint request kind ${kind}`);
}

function assertHumanCheckpoint(checkpoint: HumanCheckpointRecord): void {
  assertIdentifier(checkpoint.checkpointId, "human checkpoint id");
  assertIdentifier(checkpoint.runId, "human checkpoint run id");
  assertIdentifier(checkpoint.operationId, "human checkpoint operation id");
  assertHash(checkpoint.challengeHash, "human checkpoint challenge hash");
  if (!Number.isSafeInteger(checkpoint.requestedRevision) || checkpoint.requestedRevision < 1) {
    throw new TypeError("Invalid human checkpoint revision");
  }
  assertText(checkpoint.request.prompt, "human checkpoint prompt", 32_768);
  if (checkpoint.request.title) assertText(checkpoint.request.title, "human checkpoint title", 512);
  if (checkpoint.request.kind === "choice") {
    if (checkpoint.request.choices.length < 1 || checkpoint.request.choices.length > 256) throw new TypeError("Invalid checkpoint choices");
    const ids = new Set<string>();
    for (const choice of checkpoint.request.choices) {
      assertIdentifier(choice.id, "checkpoint choice id");
      assertText(choice.label, "checkpoint choice label", 1_024);
      if (ids.has(choice.id)) throw new TypeError("Duplicate checkpoint choice id");
      ids.add(choice.id);
    }
  }
  if (checkpoint.request.kind === "input") encodeCanonicalJson(checkpoint.request.responseSchema as unknown as JsonValue);
  assertIsoDate(checkpoint.requestedAt, "human checkpoint requestedAt");
}

function rejected(
  request: ControlRequest,
  run: RunRecord,
  code: string,
  summary: string,
  operationId?: string,
): { accepted: false; reason: StructuredReason; exitRequested: false } {
  return {
    accepted: false,
    reason: {
      category: request.kind === "approve" || request.kind === "reject" ? "approval" : "control",
      code,
      summary: bounded(summary, 1_024),
      retryable: !TERMINAL.has(run.status),
      ...(operationId ? { operationId } : {}),
    },
    exitRequested: false,
  };
}

function controlReason(
  code: string,
  summary: string,
  retryable: boolean,
  operationId?: string,
  category: StructuredReason["category"] = "control",
): StructuredReason {
  return {
    category,
    code,
    summary: bounded(summary, 1_024),
    retryable,
    ...(operationId ? { operationId } : {}),
  };
}

function scalar(database: DatabaseSync, sql: string): number {
  return requiredNumber(database.prepare(sql).get() as SqlRow, "value");
}

function bounded(value: string, scalars: number): string {
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, scalars).join("");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

