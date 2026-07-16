import type { PersistedMetricState } from "../measurements/metrics.js";
import type { RunDatabaseReader } from "../persistence/run-database-reader.js";
import type {
  AgentLiveProgressProjection,
  ApprovalRecord,
  ArtifactRecord,
  CandidateRecord,
  HumanCheckpointRecord,
  OperationRecord,
  RunRecord,
  StructuredReason,
  UsageMeasurement,
} from "../runtime/durable-types.js";
import {
  WORKFLOW_PROJECTION_LIMITS as LIMITS,
  type WorkflowAgentProjection,
  type WorkflowApplyProjection,
  type WorkflowAttentionReason,
  type WorkflowCandidateProjection,
  type WorkflowCheckpointProjection,
  type WorkflowMetricProjection,
  type WorkflowOperationProjection,
  type WorkflowRunProjection,
} from "./types.js";

export interface WorkflowRunProjectionSource {
  run: RunRecord;
  shortRunId?: string;
  operationCounts: WorkflowRunProjection["operationCounts"];
  operationTotal: number;
  operations: OperationRecord[];
  activeAgents: AgentLiveProgressProjection[];
  checkpoints: HumanCheckpointRecord[];
  approval?: ApprovalRecord;
  apply?: {
    plan: NonNullable<ReturnType<RunDatabaseReader["readApplyPlanByOperation"]>>;
    receipt?: NonNullable<ReturnType<RunDatabaseReader["readApplyReceipt"]>>;
  };
  candidate?: CandidateRecord;
  metrics: PersistedMetricState[];
  artifacts: ArtifactRecord[];
  pendingControlRequests: number;
  latestEventSequence: number;
}

/** Read one coherent WAL snapshot and immediately detach it from SQLite. */
export function readWorkflowRunProjection(
  reader: RunDatabaseReader,
  options: { shortRunId?: string; now?: Date } = {},
): WorkflowRunProjection {
  return reader.readSnapshot((snapshot) => {
    const run = snapshot.readRun();
    const operations = snapshot.listProjectionOperations(LIMITS.phaseOperations);
    const approval = snapshot.readLatestApproval();
    const plan = approval ? snapshot.readApplyPlanByOperation(approval.operationId) : undefined;
    const receipt = plan ? snapshot.readApplyReceipt(plan.planId) : undefined;
    const apply = plan ? {
      plan,
      ...(receipt ? { receipt } : {}),
    } : undefined;
    const candidate = snapshot.readLatestCandidate();
    return buildWorkflowRunProjection({
      run,
      ...(options.shortRunId ? { shortRunId: options.shortRunId } : {}),
      operationCounts: snapshot.readOperationCounts(),
      operationTotal: snapshot.countOperations(),
      operations,
      activeAgents: snapshot.readActiveAgentProgress({
        limit: LIMITS.activeAgents,
        recentLimit: LIMITS.recentAgentLogs,
        now: options.now,
      }),
      checkpoints: snapshot.listHumanCheckpoints({ limit: LIMITS.overviewCheckpoints }),
      ...(approval ? { approval } : {}),
      ...(apply ? { apply } : {}),
      ...(candidate ? { candidate } : {}),
      metrics: snapshot.listMetricsPage({ limit: LIMITS.overviewMetrics }),
      artifacts: snapshot.listArtifacts({ limit: LIMITS.overviewArtifacts }),
      pendingControlRequests: snapshot.countPendingControlRequests(),
      latestEventSequence: snapshot.latestEventSequence(),
    });
  });
}

/** Pure projection function used by every transport and by data fixtures. */
export function buildWorkflowRunProjection(source: WorkflowRunProjectionSource): WorkflowRunProjection {
  const operations = projectOperationRecords(source.operations);
  const activeAgents = source.activeAgents.slice(0, LIMITS.activeAgents).map(projectAgent);
  const checkpoints = source.checkpoints.slice(0, LIMITS.overviewCheckpoints).map(projectCheckpoint);
  const apply = projectApply(source.approval, source.apply);
  const candidate = source.candidate ? projectCandidate(source.candidate) : undefined;
  const metrics = source.metrics.slice(0, LIMITS.overviewMetrics).map(projectMetric);
  const attentionReasons = deriveAttention(source.run, activeAgents, checkpoints, source.approval);
  const terminal = new Set(["completed", "failed", "stopped"]);
  const recentOperations = operations.filter((operation) => terminal.has(operation.status)).slice(-LIMITS.recentOperations);
  const projection: WorkflowRunProjection = {
    formatVersion: 1,
    runId: source.run.runId,
    shortRunId: source.shortRunId ?? source.run.runId.replace(/^flow_/, "").slice(0, 8),
    workflowId: source.run.workflow.id,
    workflowName: source.run.workflow.name,
    revision: source.run.revision,
    status: source.run.status,
    createdAt: source.run.createdAt,
    ...(source.run.startedAt ? { startedAt: source.run.startedAt } : {}),
    updatedAt: source.run.updatedAt,
    ...(source.run.endedAt ? { endedAt: source.run.endedAt } : {}),
    ...(source.run.currentOperationId ? { currentOperationId: source.run.currentOperationId } : {}),
    usage: aggregateLiveUsage(source.run.usage, activeAgents),
    safety: {
      concurrency: source.run.safety.concurrency,
      maximumAgentLaunches: source.run.safety.maximumAgentLaunches,
    },
    operationCounts: structuredClone(source.operationCounts),
    phaseTree: operations,
    phaseOperationOmittedCount: Math.max(0, source.operationTotal - operations.length),
    recentOperations,
    activeAgents,
    checkpoints,
    ...(apply ? { apply } : {}),
    ...(candidate ? { candidate } : {}),
    metrics,
    artifacts: source.artifacts.slice(0, LIMITS.overviewArtifacts).map(artifactRef),
    ...(source.run.replay ? { replay: structuredClone(source.run.replay) } : {}),
    attentionReasons,
    pendingControlRequests: source.pendingControlRequests,
    latestEventSequence: source.latestEventSequence,
  };
  while (projectionBytes(projection) > LIMITS.projectionBytes && projection.recentOperations.length > 0) {
    projection.recentOperations.shift();
  }
  while (projectionBytes(projection) > LIMITS.projectionBytes && projection.phaseTree.length > 1) {
    projection.phaseTree.pop();
    projection.phaseOperationOmittedCount += 1;
  }
  while (projectionBytes(projection) > LIMITS.projectionBytes && projection.activeAgents.length > 1) {
    projection.activeAgents.pop();
  }
  while (projectionBytes(projection) > LIMITS.projectionBytes && projection.artifacts.length > 0) projection.artifacts.pop();
  while (projectionBytes(projection) > LIMITS.projectionBytes && projection.metrics.length > 0) projection.metrics.pop();
  while (projectionBytes(projection) > LIMITS.projectionBytes && projection.checkpoints.length > 0) projection.checkpoints.pop();
  if (projectionBytes(projection) > LIMITS.projectionBytes) {
    throw new Error(`Workflow projection exceeds ${LIMITS.projectionBytes} bytes after bounded reduction`);
  }
  return projection;
}

export function projectOperationRecords(records: readonly OperationRecord[]): WorkflowOperationProjection[] {
  const included = records.slice(0, LIMITS.phaseOperations);
  const byId = new Map(included.map((operation) => [operation.operationId, operation]));
  const depth = (operation: OperationRecord): number => {
    let result = 0;
    let parent = operation.parentOperationId ? byId.get(operation.parentOperationId) : undefined;
    const seen = new Set<string>([operation.operationId]);
    while (parent && !seen.has(parent.operationId) && result < 64) {
      seen.add(parent.operationId);
      result += 1;
      parent = parent.parentOperationId ? byId.get(parent.parentOperationId) : undefined;
    }
    return result;
  };
  return included.map((operation) => ({
    operationId: operation.operationId,
    ...(operation.parentOperationId ? { parentOperationId: operation.parentOperationId } : {}),
    path: boundedText(operation.path, 1_024),
    sourceId: boundedText(operation.sourceId, 256),
    kind: operation.kind,
    ordinal: operation.ordinal,
    depth: depth(operation),
    status: operation.status,
    attemptCount: operation.attemptCount,
    ...(operation.reason ? { reason: reason(operation.reason) } : {}),
    ...(operation.replay ? {
      replay: {
        sourceRunId: operation.replay.sourceRunId,
        sourceOperationId: operation.replay.sourceOperationId,
        ordinal: operation.replay.ordinal,
        workspaceRestored: operation.replay.restoredWorkspaceCheckpointId !== undefined,
      },
    } : {}),
    outputArtifacts: (operation.result?.artifacts ?? []).slice(0, 16).map((artifact) => structuredClone(artifact)),
    outputArtifactOmittedCount: Math.max(0, (operation.result?.artifacts.length ?? 0) - 16),
    createdAt: operation.createdAt,
    ...(operation.startedAt ? { startedAt: operation.startedAt } : {}),
    updatedAt: operation.updatedAt,
    ...(operation.endedAt ? { endedAt: operation.endedAt } : {}),
  }));
}

function projectAgent(live: AgentLiveProgressProjection): WorkflowAgentProjection {
  const session = live.session;
  const progress = session.progress;
  return {
    agentSessionId: session.agentSessionId,
    operationId: session.operationId,
    profileId: session.profileId,
    routeId: session.routeId,
    status: session.status,
    ...(session.reason ? { reason: reason(session.reason) } : {}),
    workspace: { kind: session.workspace.kind, workspaceId: session.workspace.workspaceId, treeHash: session.workspace.treeHash },
    network: session.network,
    receiptlessStrikes: session.receiptlessStrikes,
    ...(session.currentExecutionId ? { executionId: session.currentExecutionId } : {}),
    ...(progress.message ? {
      progress: { message: boundedText(progress.message), ...(progress.current !== undefined ? { current: progress.current } : {}), ...(progress.total !== undefined ? { total: progress.total } : {}) },
    } : {}),
    customMetrics: structuredClone(progress.metrics),
    automaticMetrics: structuredClone(live.automaticMetrics),
    ...(progress.currentTool ? { currentTool: boundedText(progress.currentTool, 512) } : {}),
    modelTurn: progress.modelTurn,
    toolCount: progress.toolCount,
    retries: progress.retries,
    usage: structuredClone(progress.usage),
    ...(progress.resources ? { resources: structuredClone(progress.resources) } : {}),
    workspaceChanged: progress.workspaceChanged,
    workspaceChangeCount: progress.workspaceChangeCount,
    recentWorkspaceChanges: progress.recentWorkspaceChanges.slice(0, 4).map((entry) => boundedText(entry, 512)),
    recentLogs: structuredClone(live.recent.slice(0, LIMITS.recentAgentLogs)),
    elapsedMs: live.elapsedMs,
    updatedAt: progress.updatedAt,
  };
}

function aggregateLiveUsage(settled: UsageMeasurement, activeAgents: readonly WorkflowAgentProjection[]): UsageMeasurement {
  return activeAgents.reduce((usage, agent) => ({
    inputTokens: usage.inputTokens + agent.usage.inputTokens,
    outputTokens: usage.outputTokens + agent.usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens + agent.usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens + agent.usage.cacheWriteTokens,
    providerRequests: usage.providerRequests + agent.usage.providerRequests,
    cost: usage.cost + agent.usage.cost,
    elapsedMs: usage.elapsedMs + agent.usage.elapsedMs,
    complete: usage.complete && agent.usage.complete,
  }), structuredClone(settled));
}

function projectCheckpoint(checkpoint: HumanCheckpointRecord): WorkflowCheckpointProjection {
  return {
    checkpointId: checkpoint.checkpointId,
    operationId: checkpoint.operationId,
    status: checkpoint.status,
    request: structuredClone(checkpoint.request),
    challengeHash: checkpoint.challengeHash,
    requestedRevision: checkpoint.requestedRevision,
    ...(checkpoint.response !== undefined ? { response: structuredClone(checkpoint.response) } : {}),
    requestedAt: checkpoint.requestedAt,
    ...(checkpoint.resolvedAt ? { resolvedAt: checkpoint.resolvedAt } : {}),
  };
}

function projectApply(
  approval: ApprovalRecord | undefined,
  apply: WorkflowRunProjectionSource["apply"],
): WorkflowApplyProjection | undefined {
  if (!approval || approval.kind !== "apply" || !apply) return undefined;
  const { plan, receipt } = apply;
  const status = receipt ? "applied" : approval.status === "stopped" ? "stopped" : approval.decision ?? "waiting";
  return {
    operationId: plan.operationId,
    planId: plan.planId,
    approvalId: approval.approvalId,
    status,
    challenge: structuredClone(approval.challenge),
    candidateId: plan.candidateId,
    candidateTreeHash: plan.candidateTreeHash,
    candidateLineageHash: plan.candidateLineageHash,
    candidateWriteScopeHash: plan.candidateWriteScopeHash,
    verificationId: plan.verificationId,
    verificationProfileHash: plan.verificationProfileHash,
    changedPathCount: plan.paths.length,
    changedPathPreview: plan.paths.slice(0, LIMITS.changedPathPreview).map((entry) => entry.path),
    ...(receipt ? { receiptId: receipt.receiptId } : {}),
  };
}

function projectCandidate(candidate: CandidateRecord): WorkflowCandidateProjection {
  return {
    candidateId: candidate.candidateId,
    ...(candidate.parentCandidateId ? { parentCandidateId: candidate.parentCandidateId } : {}),
    workspaceId: candidate.workspace.workspaceId,
    treeHash: candidate.workspace.treeHash,
    lineageHash: candidate.workspace.lineageHash!,
    writeScopeHash: candidate.workspace.writeScopeHash!,
    changedPathCount: candidate.changedPaths.length,
    changedPathPreview: candidate.changedPaths.slice(0, LIMITS.changedPathPreview),
    manifest: structuredClone(candidate.manifest),
    diff: structuredClone(candidate.diff),
    frozenAt: candidate.frozenAt,
  };
}

function projectMetric(metric: PersistedMetricState): WorkflowMetricProjection {
  return {
    metricId: metric.metricId,
    title: metric.definition.title,
    role: metric.role,
    direction: metric.definition.direction,
    ...(metric.definition.unit ? { unit: metric.definition.unit } : {}),
    baseline: metric.baseline,
    current: metric.current,
    best: metric.best,
    relativeGain: metric.relativeGain,
    observationCount: metric.observationCount,
    recentObservations: structuredClone(metric.recentObservations),
  };
}

function deriveAttention(
  run: RunRecord,
  agents: readonly WorkflowAgentProjection[],
  checkpoints: readonly WorkflowCheckpointProjection[],
  approval: ApprovalRecord | undefined,
): WorkflowAttentionReason[] {
  const result: WorkflowAttentionReason[] = [];
  if (run.reason) result.push(reason(run.reason));
  for (const agent of agents) {
    if (agent.receiptlessStrikes >= 3 && !result.some((entry) => entry.code === "receiptless-three-strikes")) {
      result.push(agent.reason ?? {
        category: "agent-protocol",
        code: "receiptless-three-strikes",
        summary: "Agent paused after three clean receiptless yields",
        retryable: true,
        operationId: agent.operationId,
      });
    }
  }
  for (const checkpoint of checkpoints.filter((entry) => entry.status === "waiting")) {
    result.push({
      category: "human-input",
      code: "checkpoint-waiting",
      summary: boundedText(checkpoint.request.prompt),
      retryable: true,
      operationId: checkpoint.operationId,
    });
  }
  if (approval?.status === "waiting") {
    result.push({
      category: "approval",
      code: approval.kind === "apply" ? "apply-approval-waiting" : "draft-promotion-waiting",
      summary: `${approval.kind} requires an exact human decision`,
      retryable: true,
      operationId: approval.operationId,
      evidence: [structuredClone(approval.challenge.summary)],
    });
  }
  if (run.status === "failed" && !result.some((entry) => entry.category === "workflow" || entry.category === "effect")) {
    result.push({ category: "workflow", code: "run-failed", summary: "Workflow failed", retryable: false });
  }
  if (run.status === "stopped" && !result.some((entry) => entry.code === "run-stopped")) {
    result.push({ category: "control", code: "run-stopped", summary: "Workflow was stopped", retryable: false });
  }
  return result.slice(0, 16);
}

function reason(value: StructuredReason): WorkflowAttentionReason {
  return {
    category: value.category,
    code: boundedText(value.code, 256),
    summary: boundedText(value.summary),
    retryable: value.retryable,
    ...(value.operationId ? { operationId: value.operationId } : {}),
    ...(value.evidence ? { evidence: structuredClone(value.evidence.slice(0, 16)) } : {}),
  };
}

function artifactRef(record: ArtifactRecord) {
  return { digest: record.digest, kind: record.kind, mediaType: record.mediaType, bytes: record.bytes };
}

function projectionBytes(projection: WorkflowRunProjection): number {
  return Buffer.byteLength(JSON.stringify(projection), "utf8");
}

export function boundedProjectionText(value: unknown, maximum: number = LIMITS.textScalars): string {
  return boundedText(String(value ?? ""), maximum);
}

function boundedText(value: string, maximum: number = LIMITS.textScalars): string {
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "�");
  const scalars = Array.from(clean);
  return scalars.length <= maximum ? clean : `${scalars.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}
