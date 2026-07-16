import type { DatabaseSync } from "./sqlite.js";
import type {
  AgentProgress,
  AgentSessionRecord,
  ArtifactRecord,
  ArtifactRef,
  AttemptRecord,
  OperationRecord,
  ResourceMeasurement,
  RunRecord,
  UsageMeasurement,
  WorkspaceRef,
} from "../runtime/durable-types.js";
import {
  assertArtifactRecord,
  assertArtifactRef,
  encodeCanonicalJson,
  optionalReasonJson,
  requiredNumber,
  requiredString,
  type SqlRow,
} from "./run-database-codec.js";
import type { RunTransitionEvent } from "./run-database.js";
import { RunDatabaseStateError } from "./run-database-errors.js";

export function insertRun(database: DatabaseSync, run: RunRecord): void {
  database.prepare(`
    INSERT INTO runs(
      singleton, run_id, revision,
      workflow_id, workflow_name, workflow_source_hash, workflow_definition_hash,
      invocation_hash, project_snapshot_hash, route_snapshot_hash, context_identity_hash,
      status, reason_json,
      safety_concurrency, safety_maximum_agent_launches, safety_memory_bytes, safety_tasks,
      safety_cpu_quota_percent, safety_cpu_weight, safety_output_bytes, safety_command_timeout_ms,
      usage_input_tokens, usage_output_tokens, usage_cache_read_tokens, usage_cache_write_tokens,
      usage_provider_requests, usage_cost, usage_elapsed_ms, usage_complete,
      current_operation_id, result_artifact_digest, error_artifact_digest,
      created_at, started_at, updated_at, ended_at
    ) VALUES (
      1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    run.runId,
    run.revision,
    run.workflow.id,
    run.workflow.name,
    run.workflow.sourceHash,
    run.workflow.definitionHash,
    run.invocationHash,
    run.projectSnapshotHash,
    run.routeSnapshotHash,
    run.contextIdentityHash,
    run.status,
    optionalReasonJson(run.reason),
    run.safety.concurrency,
    run.safety.maximumAgentLaunches,
    run.safety.memoryBytes,
    run.safety.tasks,
    run.safety.cpuQuotaPercent,
    run.safety.cpuWeight,
    run.safety.outputBytes,
    run.safety.commandTimeoutMs,
    ...usageValues(run.usage),
    run.currentOperationId ?? null,
    run.result?.digest ?? null,
    run.error?.digest ?? null,
    run.createdAt,
    run.startedAt ?? null,
    run.updatedAt,
    run.endedAt ?? null,
  );
  for (const [ordinal, capability] of run.workflow.capabilities.entries()) {
    database.prepare("INSERT INTO run_capabilities(run_id, ordinal, capability) VALUES (?, ?, ?)")
      .run(run.runId, ordinal, capability);
  }
  if (run.replay) database.prepare(`
    INSERT INTO run_replay(
      run_id, mode, source_run_id, matched_calls, first_miss_ordinal, first_miss_reason, fresh
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.runId,
    run.replay.mode,
    run.replay.sourceRunId,
    run.replay.matchedCalls,
    run.replay.firstMissOrdinal ?? null,
    run.replay.firstMissReason ?? null,
    run.replay.fresh ? 1 : 0,
  );
}

export function insertOperationRow(database: DatabaseSync, operation: OperationRecord): void {
  const result = operation.result;
  const workspace = result?.workspace;
  database.prepare(`
    INSERT INTO operations(
      operation_id, run_id, parent_operation_id, path, source_id, kind, ordinal, status,
      reason_json, semantic_input_hash, call_key, attempt_count, result_present, result_value_json,
      result_workspace_kind, result_workspace_id, result_workspace_tree_hash,
      result_workspace_lineage_hash, result_workspace_write_scope_hash,
      created_at, started_at, updated_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    operation.operationId,
    operation.runId,
    operation.parentOperationId ?? null,
    operation.path,
    operation.sourceId,
    operation.kind,
    operation.ordinal,
    operation.status,
    optionalReasonJson(operation.reason),
    operation.semanticInputHash,
    operation.callKey ?? null,
    operation.attemptCount,
    result ? 1 : 0,
    result?.value === undefined ? null : encodeCanonicalJson(result.value, "value"),
    ...workspaceValues(workspace),
    operation.createdAt,
    operation.startedAt ?? null,
    operation.updatedAt,
    operation.endedAt ?? null,
  );
}

export function insertAttemptRow(database: DatabaseSync, attempt: AttemptRecord): void {
  database.prepare(`
    INSERT INTO attempts(
      attempt_id, run_id, operation_id, number, effect, execution_id, status, reason_json,
      pre_workspace_kind, pre_workspace_id, pre_workspace_tree_hash, pre_workspace_lineage_hash,
      pre_workspace_write_scope_hash, post_workspace_checkpoint_id,
      usage_input_tokens, usage_output_tokens, usage_cache_read_tokens, usage_cache_write_tokens,
      usage_provider_requests, usage_cost, usage_elapsed_ms, usage_complete,
      resource_cpu_usec, resource_io_read_bytes, resource_io_write_bytes,
      resource_memory_current_bytes, resource_memory_peak_bytes, resource_tasks_current, resource_tasks_peak,
      resource_cpu_pressure, resource_io_pressure, resource_memory_pressure,
      started_at, updated_at, ended_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    attempt.attemptId,
    attempt.runId,
    attempt.operationId,
    attempt.number,
    attempt.effect,
    attempt.executionId ?? null,
    attempt.status,
    optionalReasonJson(attempt.reason),
    ...workspaceValues(attempt.preWorkspace),
    attempt.postWorkspaceCheckpointId ?? null,
    ...usageValues(attempt.usage),
    ...resourceValues(attempt.resources),
    attempt.startedAt ?? null,
    attempt.updatedAt,
    attempt.endedAt ?? null,
  );
}

export function insertAgentSessionRow(database: DatabaseSync, session: AgentSessionRecord): void {
  database.prepare(`
    INSERT INTO agent_sessions(
      agent_session_id, run_id, operation_id, profile_id, route_id, pi_session_path,
      workspace_kind, workspace_id, workspace_tree_hash, workspace_lineage_hash, workspace_write_scope_hash,
      network, status, reason_json, receiptless_strikes, current_execution_id,
      finish_tool_call_id, finish_schema_hash, finish_value_json, finish_committed_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.agentSessionId,
    session.runId,
    session.operationId,
    session.profileId,
    session.routeId,
    session.piSessionPath,
    ...workspaceValues(session.workspace),
    session.network,
    session.status,
    optionalReasonJson(session.reason),
    session.receiptlessStrikes,
    session.currentExecutionId ?? null,
    session.finish?.toolCallId ?? null,
    session.finish?.schemaHash ?? null,
    session.finish?.value === undefined ? null : encodeCanonicalJson(session.finish.value, "value"),
    session.finish?.committedAt ?? null,
    session.createdAt,
    session.updatedAt,
  );
}

export function insertCurrentProgress(database: DatabaseSync, agentSessionId: string, progress: AgentProgress): void {
  database.prepare(`
    INSERT INTO agent_progress_current(
      agent_session_id, message, current_value, total_value, model_turn, current_tool,
      usage_input_tokens, usage_output_tokens, usage_cache_read_tokens, usage_cache_write_tokens,
      usage_provider_requests, usage_cost, usage_elapsed_ms, usage_complete,
      tool_count, retries, workspace_changed, workspace_change_count,
      resource_cpu_usec, resource_io_read_bytes, resource_io_write_bytes,
      resource_memory_current_bytes, resource_memory_peak_bytes, resource_tasks_current, resource_tasks_peak,
      resource_cpu_pressure, resource_io_pressure, resource_memory_pressure, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    agentSessionId,
    progress.message ?? null,
    progress.current ?? null,
    progress.total ?? null,
    progress.modelTurn,
    progress.currentTool ?? null,
    ...usageValues(progress.usage),
    progress.toolCount,
    progress.retries,
    progress.workspaceChanged ? 1 : 0,
    progress.workspaceChangeCount,
    ...resourceValues(progress.resources),
    progress.updatedAt,
  );
  for (const [ordinal, metric] of progress.metrics.entries()) {
    database.prepare(`
      INSERT INTO agent_progress_current_metrics(agent_session_id, ordinal, name, value, unit)
      VALUES (?, ?, ?, ?, ?)
    `).run(agentSessionId, ordinal, metric.name, metric.value, metric.unit ?? null);
  }
  for (const [ordinal, changedPath] of progress.recentWorkspaceChanges.entries()) {
    database.prepare(`
      INSERT INTO agent_progress_current_paths(agent_session_id, ordinal, path)
      VALUES (?, ?, ?)
    `).run(agentSessionId, ordinal, changedPath);
  }
}

export function replaceCurrentProgress(database: DatabaseSync, agentSessionId: string, progress: AgentProgress): void {
  database.prepare("DELETE FROM agent_progress_current_paths WHERE agent_session_id = ?").run(agentSessionId);
  database.prepare("DELETE FROM agent_progress_current_metrics WHERE agent_session_id = ?").run(agentSessionId);
  database.prepare("DELETE FROM agent_progress_current WHERE agent_session_id = ?").run(agentSessionId);
  insertCurrentProgress(database, agentSessionId, progress);
}

export function insertArtifactRow(database: DatabaseSync, artifact: ArtifactRecord, runId: string): void {
  assertArtifactRecord(artifact, runId);
  const existing = database.prepare("SELECT * FROM artifacts WHERE digest = ?").get(artifact.digest) as SqlRow | undefined;
  if (existing) {
    const same = requiredString(existing, "run_id") === artifact.runId
      && requiredString(existing, "kind") === artifact.kind
      && requiredString(existing, "media_type") === artifact.mediaType
      && requiredNumber(existing, "bytes") === artifact.bytes
      && requiredString(existing, "body_path") === artifact.bodyPath
      && requiredString(existing, "metadata_json") === encodeCanonicalJson(artifact.metadata)
      && requiredString(existing, "created_at") === artifact.createdAt;
    if (!same) throw new RunDatabaseStateError(`Artifact digest collision for ${artifact.digest}`);
    return;
  }
  database.prepare(`
    INSERT INTO artifacts(digest, run_id, kind, media_type, bytes, body_path, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifact.digest,
    artifact.runId,
    artifact.kind,
    artifact.mediaType,
    artifact.bytes,
    artifact.bodyPath,
    encodeCanonicalJson(artifact.metadata),
    artifact.createdAt,
  );
}

export function requiredArtifactRef(database: DatabaseSync, ref: ArtifactRef): void {
  assertArtifactRef(ref);
  const row = database.prepare(
    "SELECT kind, media_type, bytes FROM artifacts WHERE digest = ?",
  ).get(ref.digest) as SqlRow | undefined;
  if (!row) throw new RunDatabaseStateError(`Unknown artifact ${ref.digest}`);
  if (
    requiredString(row, "kind") !== ref.kind
    || requiredString(row, "media_type") !== ref.mediaType
    || requiredNumber(row, "bytes") !== ref.bytes
  ) throw new RunDatabaseStateError(`Artifact reference ${ref.digest} does not match its row`);
}

export function requiredOperation(database: DatabaseSync, operationId: string, runId: string): SqlRow {
  const row = database.prepare(
    "SELECT * FROM operations WHERE operation_id = ? AND run_id = ?",
  ).get(operationId, runId) as SqlRow | undefined;
  if (!row) throw new RunDatabaseStateError(`Unknown operation ${operationId}`);
  return row;
}

export function insertEvent(
  database: DatabaseSync,
  runId: string,
  sequence: number,
  revision: number,
  event: RunTransitionEvent,
): void {
  database.prepare(`
    INSERT INTO events(run_id, sequence, revision, type, operation_id, attempt_id, payload_json, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    sequence,
    revision,
    event.type,
    event.operationId ?? null,
    event.attemptId ?? null,
    encodeCanonicalJson(event.payload),
    event.at,
  );
}

export function nextEventSequence(database: DatabaseSync, runId: string): number {
  return requiredNumber(
    database.prepare("SELECT coalesce(max(sequence), 0) + 1 AS value FROM events WHERE run_id = ?").get(runId) as SqlRow,
    "value",
  );
}

export function nextSequence(database: DatabaseSync, table: "agent_progress_history"): number {
  return requiredNumber(
    database.prepare(`SELECT coalesce(max(sequence), 0) + 1 AS value FROM ${table}`).get() as SqlRow,
    "value",
  );
}

export function usageValues(usage: UsageMeasurement): Array<number> {
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.providerRequests,
    usage.cost,
    usage.elapsedMs,
    usage.complete ? 1 : 0,
  ];
}

export function workspaceValues(workspace: WorkspaceRef | undefined): Array<string | null> {
  return workspace ? [
    workspace.kind,
    workspace.workspaceId,
    workspace.treeHash,
    workspace.lineageHash ?? null,
    workspace.writeScopeHash ?? null,
  ] : [null, null, null, null, null];
}

export function resourceValues(resources: ResourceMeasurement | undefined): Array<number | null> {
  return [
    resources?.cpuUsec ?? null,
    resources?.ioReadBytes ?? null,
    resources?.ioWriteBytes ?? null,
    resources?.memoryCurrentBytes ?? null,
    resources?.memoryPeakBytes ?? null,
    resources?.tasksCurrent ?? null,
    resources?.tasksPeak ?? null,
    resources?.cpuPressure ?? null,
    resources?.ioPressure ?? null,
    resources?.memoryPressure ?? null,
  ];
}
