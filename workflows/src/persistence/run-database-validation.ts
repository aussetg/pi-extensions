import type {
  AgentProgress,
  AgentSessionRecord,
  ControlRequest,
  OperationRecord,
  OperationResult,
  AttemptRecord,
  CandidateRecord,
  CandidateWorkspaceRecord,
  RunStatus,
} from "../runtime/durable-types.js";
import { AGENT_PROGRESS_LIMITS } from "../runtime/agent-progress-limits.js";
import {
  assertAgentToolCallId,
  assertArtifactRef,
  assertHash,
  assertIdentifier,
  assertIsoDate,
  assertNonNegativeInteger,
  assertPositiveInteger,
  assertResources,
  assertStructuredReason,
  assertText,
  assertUsage,
  assertWorkspace,
  encodeCanonicalJson,
} from "./run-database-codec.js";
import type { RunTransitionEvent } from "./run-database.js";

export function assertOperation(operation: OperationRecord): void {
  assertIdentifier(operation.operationId, "operation id");
  assertIdentifier(operation.runId, "run id");
  if (operation.parentOperationId) assertIdentifier(operation.parentOperationId, "parent operation id");
  assertText(operation.path, "operation path", 4_096);
  assertIdentifier(operation.sourceId, "operation source id");
  if (!new Set(["stage", "loop", "parallel", "fan-out", "agent", "command", "checkpoint", "measure", "candidate", "verify", "accept", "reject", "record-experiment", "apply"]).has(operation.kind)) {
    throw new TypeError("Invalid operation kind");
  }
  assertNonNegativeInteger(operation.ordinal, "operation ordinal");
  assertStatus(operation.status);
  if (operation.reason) assertStructuredReason(operation.reason);
  assertHash(operation.semanticInputHash, "operation semantic input hash");
  if (operation.callKey) assertHash(operation.callKey, "operation call key");
  assertNonNegativeInteger(operation.attemptCount, "operation attempt count");
  if (operation.result) assertResult(operation.result);
  if (operation.replay) {
    assertIdentifier(operation.replay.sourceRunId, "operation replay source run id");
    assertIdentifier(operation.replay.sourceOperationId, "operation replay source operation id");
    assertNonNegativeInteger(operation.replay.ordinal, "operation replay ordinal");
    assertHash(operation.replay.callKey, "operation replay call key");
    if (operation.replay.restoredWorkspaceCheckpointId) {
      assertIdentifier(operation.replay.restoredWorkspaceCheckpointId, "operation replay workspace checkpoint id");
    }
    if (operation.replay.sourceRunId === operation.runId) throw new TypeError("Operation replay source is the target run");
    if (operation.status !== "completed" || !operation.result || operation.callKey !== operation.replay.callKey) {
      throw new TypeError("Operation replay evidence requires its exact completed call");
    }
  }
  assertIsoDate(operation.createdAt, "operation createdAt");
  if (operation.startedAt) assertIsoDate(operation.startedAt, "operation startedAt");
  assertIsoDate(operation.updatedAt, "operation updatedAt");
  if (operation.endedAt) assertIsoDate(operation.endedAt, "operation endedAt");
}

export function assertAttempt(attempt: AttemptRecord): void {
  assertIdentifier(attempt.attemptId, "attempt id");
  assertIdentifier(attempt.runId, "run id");
  assertIdentifier(attempt.operationId, "operation id");
  assertPositiveInteger(attempt.number, "attempt number");
  if (!new Set(["agent", "command", "measurement", "verification", "apply"]).has(attempt.effect)) throw new TypeError("Invalid attempt effect");
  if (attempt.executionId) assertIdentifier(attempt.executionId, "execution id");
  assertStatus(attempt.status);
  if (attempt.reason) assertStructuredReason(attempt.reason);
  if (attempt.preWorkspace) assertWorkspace(attempt.preWorkspace);
  if (attempt.postWorkspaceCheckpointId) assertIdentifier(attempt.postWorkspaceCheckpointId, "post-workspace checkpoint id");
  assertUsage(attempt.usage);
  assertResources(attempt.resources);
  for (const artifact of attempt.outputArtifacts) assertArtifactRef(artifact);
  if (attempt.startedAt) assertIsoDate(attempt.startedAt, "attempt startedAt");
  assertIsoDate(attempt.updatedAt, "attempt updatedAt");
  if (attempt.endedAt) assertIsoDate(attempt.endedAt, "attempt endedAt");
}

export function assertAgentSession(session: AgentSessionRecord): void {
  assertIdentifier(session.agentSessionId, "agent session id");
  assertIdentifier(session.runId, "run id");
  assertIdentifier(session.operationId, "operation id");
  assertIdentifier(session.profileId, "profile id");
  assertIdentifier(session.routeId, "route id");
  assertText(session.piSessionPath, "Pi session path", 4_096);
  assertWorkspace(session.workspace);
  if (session.network !== "none" && session.network !== "research") throw new TypeError("Invalid agent network mode");
  assertStatus(session.status);
  if (session.reason) assertStructuredReason(session.reason);
  assertNonNegativeInteger(session.receiptlessStrikes, "receiptless strikes");
  if (session.receiptlessStrikes > 3) throw new TypeError("Receiptless strikes exceed three");
  if (session.currentExecutionId) assertIdentifier(session.currentExecutionId, "current execution id");
  assertProgress(session.progress);
  if (session.finish) {
    assertAgentToolCallId(session.finish.toolCallId, "finish tool call id");
    assertHash(session.finish.schemaHash, "finish schema hash");
    if (session.finish.value !== undefined) encodeCanonicalJson(session.finish.value, "value");
    for (const artifact of session.finish.artifacts) assertArtifactRef(artifact);
    assertIsoDate(session.finish.committedAt, "finish committedAt");
  }
  assertIsoDate(session.createdAt, "agent session createdAt");
  assertIsoDate(session.updatedAt, "agent session updatedAt");
}

export function assertProgress(progress: AgentProgress): void {
  if (progress.message) assertText(progress.message, "progress message", AGENT_PROGRESS_LIMITS.messageScalars);
  if (progress.current !== undefined) assertNonNegativeInteger(progress.current, "progress current");
  if (progress.total !== undefined) assertNonNegativeInteger(progress.total, "progress total");
  if (progress.current !== undefined && progress.total !== undefined && progress.current > progress.total) {
    throw new TypeError("Progress current exceeds total");
  }
  assertUsage(progress.usage);
  assertNonNegativeInteger(progress.modelTurn, "progress model turn");
  if (progress.currentTool) assertIdentifier(progress.currentTool, "progress current tool");
  assertNonNegativeInteger(progress.toolCount, "progress tool count");
  assertNonNegativeInteger(progress.retries, "progress retries");
  assertNonNegativeInteger(progress.workspaceChangeCount, "progress workspace change count");
  if (progress.workspaceChanged !== (progress.workspaceChangeCount > 0)) {
    throw new TypeError("Progress workspace change flag and count differ");
  }
  if (!Array.isArray(progress.recentWorkspaceChanges)
    || progress.recentWorkspaceChanges.length > AGENT_PROGRESS_LIMITS.recentWorkspacePaths) {
    throw new TypeError("Invalid recent workspace changes");
  }
  const paths = new Set<string>();
  for (const changedPath of progress.recentWorkspaceChanges) {
    assertText(changedPath, "progress workspace path", AGENT_PROGRESS_LIMITS.workspacePathScalars);
    if (changedPath.startsWith("/") || changedPath.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new TypeError("Unsafe progress workspace path");
    }
    if (paths.has(changedPath)) throw new TypeError("Duplicate progress workspace path");
    paths.add(changedPath);
  }
  const names = new Set<string>();
  if (progress.metrics.length > AGENT_PROGRESS_LIMITS.metrics) throw new TypeError("Too many progress metrics");
  for (const metric of progress.metrics) {
    assertIdentifier(metric.name, "progress metric name");
    if (names.has(metric.name)) throw new TypeError("Duplicate progress metric name");
    names.add(metric.name);
    if (!Number.isFinite(metric.value) || Math.abs(metric.value) > AGENT_PROGRESS_LIMITS.metricAbsoluteValue) {
      throw new TypeError("Invalid progress metric value");
    }
    if (metric.unit) assertText(metric.unit, "progress metric unit", AGENT_PROGRESS_LIMITS.metricUnitScalars);
  }
  assertResources(progress.resources);
  assertIsoDate(progress.updatedAt, "progress updatedAt");
}

export function assertResult(result: OperationResult): void {
  if (result.value !== undefined) encodeCanonicalJson(result.value, "value");
  if (!Array.isArray(result.artifacts) || result.artifacts.length > 256) throw new TypeError("Invalid operation artifacts");
  const digests = new Set<string>();
  for (const artifact of result.artifacts) {
    assertArtifactRef(artifact);
    if (digests.has(artifact.digest)) throw new TypeError("Duplicate operation result artifact");
    digests.add(artifact.digest);
  }
  if (result.workspace) assertWorkspace(result.workspace);
}

export function assertEvent(event: RunTransitionEvent): void {
  assertText(event.type, "event type", 128);
  if (event.operationId) assertIdentifier(event.operationId, "event operation id");
  if (event.attemptId) assertIdentifier(event.attemptId, "event attempt id");
  encodeCanonicalJson(event.payload);
  assertIsoDate(event.at, "event time");
}

export function assertStatus(status: RunStatus): void {
  if (!new Set(["queued", "running", "waiting", "paused", "completed", "failed", "stopped"]).has(status)) {
    throw new TypeError("Invalid status");
  }
}

export function assertControlRequest(request: ControlRequest): void {
  assertIdentifier(request.requestId, "control request id");
  assertIdentifier(request.runId, "run id");
  assertPositiveInteger(request.expectedRevision, "control expected revision");
  assertIsoDate(request.requestedAt, "control requestedAt");
  assertText(request.actor, "control actor", 256);
  if ("reason" in request && request.reason) assertText(request.reason, "control reason", 8_000);
  if (request.kind === "stop-effect") assertIdentifier(request.operationId, "control operation id");
  if (request.kind === "checkpoint-response") {
    assertIdentifier(request.checkpointId, "control checkpoint id");
    assertHash(request.challengeHash, "checkpoint challenge hash");
    encodeCanonicalJson(request.value, "value");
  }
  if (request.kind === "approve" || request.kind === "reject") {
    assertIdentifier(request.approvalId, "control approval id");
    assertHash(request.challengeHash, "approval challenge hash");
  }
}

export function assertCandidateWorkspaceRecord(record: CandidateWorkspaceRecord): void {
  assertIdentifier(record.workspaceId, "candidate workspace id");
  assertIdentifier(record.runId, "candidate workspace run id");
  assertText(record.logicalId, "candidate workspace logical id", 512);
  if (record.parentCandidateId) assertIdentifier(record.parentCandidateId, "parent candidate id");
  assertWorkspace(record.workspace, "candidate workspace");
  if (record.workspace.kind !== "candidate" || record.workspace.workspaceId !== record.workspaceId) {
    throw new TypeError("Candidate workspace reference has the wrong identity");
  }
  if (!record.workspace.lineageHash || !record.workspace.writeScopeHash) {
    throw new TypeError("Candidate workspace lacks lineage or write-scope authority");
  }
  const scope = record.writeScope;
  if (scope !== "all-semantic-project-paths"
    && (!scope || !Array.isArray(scope.allow) || scope.allow.length === 0 || (scope.deny && !Array.isArray(scope.deny)))) {
    throw new TypeError("Invalid candidate write scope");
  }
  encodeCanonicalJson(scope as unknown as import("../types.js").JsonValue);
  assertText(record.rootPath, "candidate workspace root path", 4_096);
  if (!/^workspaces\/candidates\/[A-Za-z0-9._:@+~-]+\/project$/.test(record.rootPath)) {
    throw new TypeError("Candidate workspace root path is not canonical");
  }
  assertIsoDate(record.createdAt, "candidate workspace createdAt");
}

export function assertCandidateRecord(record: CandidateRecord): void {
  assertIdentifier(record.candidateId, "candidate id");
  assertIdentifier(record.runId, "candidate run id");
  if (record.parentCandidateId) assertIdentifier(record.parentCandidateId, "parent candidate id");
  assertWorkspace(record.workspace, "frozen candidate workspace");
  if (record.workspace.kind !== "candidate" || !record.workspace.lineageHash || !record.workspace.writeScopeHash) {
    throw new TypeError("Frozen candidate lacks apply authority");
  }
  if (!Array.isArray(record.changedPaths) || record.changedPaths.length > 10_000) {
    throw new TypeError("Invalid candidate changed paths");
  }
  let previous: string | undefined;
  for (const changedPath of record.changedPaths) {
    assertText(changedPath, "candidate changed path", 4_096);
    if (changedPath.startsWith("/") || changedPath.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new TypeError("Unsafe candidate changed path");
    }
    if (previous !== undefined && Buffer.compare(Buffer.from(previous), Buffer.from(changedPath)) >= 0) {
      throw new TypeError("Candidate changed paths are not uniquely sorted");
    }
    previous = changedPath;
  }
  assertArtifactRef(record.manifest);
  assertArtifactRef(record.diff);
  assertIsoDate(record.frozenAt, "candidate frozenAt");
}

export function controlRequestFields(request: ControlRequest): {
  operationId: string | null;
  reason: string | null;
  checkpointId: string | null;
  approvalId: string | null;
  challengeHash: string | null;
  valueJson: string | null;
} {
  return {
    operationId: request.kind === "stop-effect" ? request.operationId : null,
    reason: "reason" in request ? request.reason ?? null : null,
    checkpointId: request.kind === "checkpoint-response" ? request.checkpointId : null,
    approvalId: request.kind === "approve" || request.kind === "reject" ? request.approvalId : null,
    challengeHash: request.kind === "checkpoint-response" || request.kind === "approve" || request.kind === "reject"
      ? request.challengeHash
      : null,
    valueJson: request.kind === "checkpoint-response" ? encodeCanonicalJson(request.value, "value") : null,
  };
}
