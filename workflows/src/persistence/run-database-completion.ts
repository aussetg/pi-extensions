import type { DatabaseSync } from "./sqlite.js";
import type { AtomicOperationCompletion } from "./run-database.js";
import type { JsonValue } from "../types.js";
import type { OperationResult, WorkflowCallRecord, WorkspaceCheckpointRecord } from "../runtime/durable-types.js";
import {
  assertHash,
  assertIdentifier,
  assertIsoDate,
  assertNonNegativeInteger,
  assertText,
  assertWorkspace,
  encodeCanonicalJson,
  requiredString,
  type SqlRow,
} from "./run-database-codec.js";
import { RunDatabaseStateError } from "./run-database-errors.js";
import { resourceValues, usageValues, workspaceValues } from "./run-database-records.js";

/** Clear the current-only projection; durable progress/log history remains. */
export function finalizeAgentProgress(database: DatabaseSync, input: AtomicOperationCompletion): void {
  const row = database.prepare(
    "SELECT agent_session_id FROM agent_sessions WHERE operation_id = ?",
  ).get(input.operationId) as SqlRow | undefined;
  if (!row) return;
  const agentSessionId = requiredString(row, "agent_session_id");
  database.prepare("DELETE FROM agent_progress_current_paths WHERE agent_session_id = ?").run(agentSessionId);
  database.prepare("DELETE FROM agent_progress_current_metrics WHERE agent_session_id = ?").run(agentSessionId);
  database.prepare(`
    UPDATE agent_progress_current SET
      message = NULL, current_value = NULL, total_value = NULL, model_turn = 0,
      current_tool = NULL,
      usage_input_tokens = 0, usage_output_tokens = 0, usage_cache_read_tokens = 0,
      usage_cache_write_tokens = 0, usage_provider_requests = 0, usage_cost = 0,
      usage_elapsed_ms = 0, usage_complete = 1,
      tool_count = 0, retries = 0, workspace_changed = 0, workspace_change_count = 0,
      resource_cpu_usec = NULL, resource_io_read_bytes = NULL, resource_io_write_bytes = NULL,
      resource_memory_current_bytes = NULL, resource_memory_peak_bytes = NULL,
      resource_tasks_current = NULL, resource_tasks_peak = NULL,
      resource_cpu_pressure = NULL, resource_io_pressure = NULL, resource_memory_pressure = NULL,
      updated_at = ?
    WHERE agent_session_id = ?
  `).run(input.completedAt, agentSessionId);
  database.prepare(`
    UPDATE agent_sessions SET status = 'completed', reason_json = NULL, current_execution_id = NULL, updated_at = ?
    WHERE agent_session_id = ?
  `).run(input.completedAt, agentSessionId);
}

export function updateCompletedAttempt(database: DatabaseSync, input: AtomicOperationCompletion): void {
  database.prepare(`
    UPDATE attempts SET
      status = 'completed', reason_json = NULL, post_workspace_checkpoint_id = ?,
      usage_input_tokens = ?, usage_output_tokens = ?, usage_cache_read_tokens = ?,
      usage_cache_write_tokens = ?, usage_provider_requests = ?, usage_cost = ?, usage_elapsed_ms = ?, usage_complete = ?,
      resource_cpu_usec = ?, resource_io_read_bytes = ?, resource_io_write_bytes = ?,
      resource_memory_current_bytes = ?, resource_memory_peak_bytes = ?, resource_tasks_current = ?, resource_tasks_peak = ?,
      resource_cpu_pressure = ?, resource_io_pressure = ?, resource_memory_pressure = ?,
      updated_at = ?, ended_at = ?
    WHERE attempt_id = ?
  `).run(
    input.workspaceCheckpoint?.checkpointId ?? null,
    ...usageValues(input.usage),
    ...resourceValues(input.resources),
    input.completedAt,
    input.completedAt,
    input.attemptId!,
  );
}

export function updateCompletedOperation(database: DatabaseSync, input: AtomicOperationCompletion): void {
  database.prepare(`
    UPDATE operations SET
      status = 'completed', reason_json = NULL,
      attempt_count = max(attempt_count, (SELECT count(*) FROM attempts WHERE operation_id = ?)),
      result_present = 1, result_value_json = ?,
      result_workspace_kind = ?, result_workspace_id = ?, result_workspace_tree_hash = ?,
      result_workspace_lineage_hash = ?, result_workspace_write_scope_hash = ?,
      call_key = ?,
      updated_at = ?, ended_at = ?
    WHERE operation_id = ?
  `).run(
    input.operationId,
    input.result.value === undefined ? null : encodeCanonicalJson(input.result.value, "value"),
    ...workspaceValues(input.result.workspace),
    input.journal?.callKey ?? null,
    input.completedAt,
    input.completedAt,
    input.operationId,
  );
}

export function insertWorkspaceCheckpoint(
  database: DatabaseSync,
  checkpoint: WorkspaceCheckpointRecord,
  runId: string,
  operationId: string,
): void {
  if (checkpoint.runId !== runId || checkpoint.operationId !== operationId) {
    throw new TypeError("Workspace checkpoint binding does not match the completion");
  }
  assertIdentifier(checkpoint.checkpointId, "workspace checkpoint id");
  assertWorkspace(checkpoint.workspace);
  assertText(checkpoint.storagePath, "workspace checkpoint path", 4_096);
  if (checkpoint.workspace.kind !== "candidate") throw new TypeError("Workspace checkpoint must contain a candidate tree");
  if (checkpoint.storagePath !== `workspaces/checkpoints/${checkpoint.checkpointId}`) {
    throw new TypeError("Workspace checkpoint path is not canonical");
  }
  assertIsoDate(checkpoint.createdAt, "workspace checkpoint createdAt");
  const workspace = database.prepare(
    "SELECT lineage_hash, write_scope_hash FROM candidate_workspaces WHERE workspace_id = ? AND run_id = ?",
  ).get(checkpoint.workspace.workspaceId, runId) as SqlRow | undefined;
  if (!workspace) throw new RunDatabaseStateError(`Unknown candidate workspace ${checkpoint.workspace.workspaceId}`);
  if (
    requiredString(workspace, "lineage_hash") !== checkpoint.workspace.lineageHash
    || requiredString(workspace, "write_scope_hash") !== checkpoint.workspace.writeScopeHash
  ) throw new RunDatabaseStateError("Workspace checkpoint authority differs from its candidate workspace");
  database.prepare(`
    INSERT INTO workspace_checkpoints(
      checkpoint_id, run_id, operation_id, workspace_id, tree_hash, lineage_hash,
      write_scope_hash, storage_path, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    checkpoint.checkpointId, runId, operationId, checkpoint.workspace.workspaceId,
    checkpoint.workspace.treeHash, checkpoint.workspace.lineageHash ?? null,
    checkpoint.workspace.writeScopeHash ?? null, checkpoint.storagePath, checkpoint.createdAt,
  );
}

export function insertWorkflowCall(
  database: DatabaseSync,
  journal: WorkflowCallRecord,
  result: OperationResult,
  runId: string,
  operationId: string,
): void {
  if (journal.runId !== runId || journal.operationId !== operationId) throw new TypeError("Workflow call binding is invalid");
  assertNonNegativeInteger(journal.ordinal, "workflow call ordinal");
  assertHash(journal.previousJournalKey, "previous journal key");
  assertHash(journal.semanticKey, "workflow call semantic key");
  assertHash(journal.callKey, "workflow call key");
  if (journal.completionAuthority !== "finish-work" && journal.completionAuthority !== "host-effect") {
    throw new TypeError("Invalid workflow call completion authority");
  }
  if (journal.replayPolicy !== "immutable" && journal.replayPolicy !== "workspace" && journal.replayPolicy !== "never") {
    throw new TypeError("Invalid workflow call replay policy");
  }
  if (journal.replayPolicy === "workspace" && !journal.postWorkspaceCheckpointId) {
    throw new TypeError("Workspace replay requires a post-workspace checkpoint");
  }
  if (journal.replayPolicy !== "workspace" && journal.postWorkspaceCheckpointId) {
    throw new TypeError("Only workspace replay may name a post-workspace checkpoint");
  }
  assertIsoDate(journal.committedAt, "workflow call committedAt");
  if (encodeCanonicalJson(journal.result as unknown as JsonValue, "value") !== encodeCanonicalJson(result as unknown as JsonValue, "value")) {
    throw new TypeError("Workflow call result differs from the operation result");
  }
  database.prepare(`
    INSERT INTO workflow_calls(
      operation_id, run_id, ordinal, previous_journal_key, semantic_key, call_key,
      completion_authority, replay_policy, result_value_json,
      result_workspace_kind, result_workspace_id, result_workspace_tree_hash,
      result_workspace_lineage_hash, result_workspace_write_scope_hash,
      post_workspace_checkpoint_id, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    operationId, runId, journal.ordinal, journal.previousJournalKey, journal.semanticKey, journal.callKey,
    journal.completionAuthority, journal.replayPolicy,
    result.value === undefined ? null : encodeCanonicalJson(result.value, "value"),
    ...workspaceValues(result.workspace), journal.postWorkspaceCheckpointId ?? null, journal.committedAt,
  );
  for (const [ordinal, artifact] of result.artifacts.entries()) {
    database.prepare(
      "INSERT INTO workflow_call_artifacts(operation_id, artifact_digest, ordinal) VALUES (?, ?, ?)",
    ).run(operationId, artifact.digest, ordinal);
  }
}
