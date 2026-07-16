import type { JsonObject, JsonSchema, JsonValue } from "../types.js";
import type { WorkflowCapability, WorkflowId } from "../definition/types.js";

export type RunStatus = "queued" | "running" | "waiting" | "paused" | "completed" | "failed" | "stopped";
export type OperationStatus = RunStatus;
export type AttemptStatus = RunStatus;
export type AgentSessionStatus = RunStatus;

export type ReasonCategory =
  | "control"
  | "human-input"
  | "approval"
  | "safety"
  | "agent-protocol"
  | "provider"
  | "infrastructure"
  | "workflow"
  | "effect"
  | "workspace"
  | "replay";

/** Status detail stays data; it never grows the status unions. */
export interface StructuredReason {
  category: ReasonCategory;
  code: string;
  summary: string;
  retryable: boolean;
  operationId?: string;
  evidence?: ArtifactRef[];
  details?: JsonObject;
}

/**
 * Host-owned runaway and containment limits. This is stored beside a run and
 * is deliberately not part of workflow invocation input.
 */
export interface SafetyConfiguration {
  concurrency: number;
  maximumAgentLaunches: number;
  memoryBytes: number;
  tasks: number;
  cpuQuotaPercent: number;
  cpuWeight: number;
  outputBytes: number;
  commandTimeoutMs: number;
}

/** Observed provider and host use. These values never authorize admission. */
export interface UsageMeasurement {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  providerRequests: number;
  cost: number;
  elapsedMs: number;
  complete: boolean;
}

export function zeroUsage(complete = true): UsageMeasurement {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    providerRequests: 0,
    cost: 0,
    elapsedMs: 0,
    complete,
  };
}

export interface ResourceMeasurement {
  cpuUsec?: number;
  ioReadBytes?: number;
  ioWriteBytes?: number;
  memoryCurrentBytes?: number;
  memoryPeakBytes?: number;
  tasksCurrent?: number;
  tasksPeak?: number;
  cpuPressure?: number;
  ioPressure?: number;
  memoryPressure?: number;
}

export type ArtifactMediaType = "text/plain; charset=utf-8" | "application/json" | "application/octet-stream";

export interface ArtifactRef {
  digest: string;
  kind: string;
  mediaType: ArtifactMediaType;
  bytes: number;
}

export interface ArtifactRecord extends ArtifactRef {
  runId: string;
  bodyPath: string;
  metadata: JsonObject;
  createdAt: string;
}

export type OperationArtifactRole = "input" | "output" | "evidence" | "progress";

export interface OperationArtifactEdge {
  operationId: string;
  artifactDigest: string;
  role: OperationArtifactRole;
  name?: string;
  ordinal: number;
}

export interface WorkspaceRef {
  kind: "snapshot" | "candidate";
  workspaceId: string;
  treeHash: string;
  lineageHash?: string;
  writeScopeHash?: string;
}

export interface WorkspaceCheckpointRecord {
  checkpointId: string;
  runId: string;
  operationId: string;
  workspace: WorkspaceRef & { kind: "candidate" };
  storagePath: string;
  createdAt: string;
}

export type CandidateWriteScope =
  | "all-semantic-project-paths"
  | { allow: string[]; deny?: string[] };

/** Fixed authority and lineage for one durable mutable candidate tree. */
export interface CandidateWorkspaceRecord {
  workspaceId: string;
  runId: string;
  logicalId: string;
  parentCandidateId?: string;
  workspace: WorkspaceRef & { kind: "candidate" };
  writeScope: CandidateWriteScope;
  rootPath: string;
  createdAt: string;
}

export interface CandidateRecord {
  candidateId: string;
  runId: string;
  parentCandidateId?: string;
  workspace: WorkspaceRef & { kind: "candidate" };
  changedPaths: string[];
  manifest: ArtifactRef;
  diff: ArtifactRef;
  frozenAt: string;
}

export interface RunWorkflowIdentity {
  id: WorkflowId;
  name: string;
  sourceHash: string;
  definitionHash: string;
  capabilities: WorkflowCapability[];
}

export interface RunRecord {
  runId: string;
  revision: number;
  workflow: RunWorkflowIdentity;
  invocationHash: string;
  projectSnapshotHash: string;
  routeSnapshotHash: string;
  contextIdentityHash: string;
  status: RunStatus;
  reason?: StructuredReason;
  safety: SafetyConfiguration;
  usage: UsageMeasurement;
  currentOperationId?: string;
  result?: ArtifactRef;
  error?: ArtifactRef;
  replay?: RunReplayRecord;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  endedAt?: string;
}

export type OperationKind =
  | "stage"
  | "loop"
  | "parallel"
  | "fan-out"
  | "agent"
  | "command"
  | "checkpoint"
  | "measure"
  | "candidate"
  | "verify"
  | "accept"
  | "reject"
  | "record-experiment"
  | "apply";

export interface OperationResult {
  value?: JsonValue;
  artifacts: ArtifactRef[];
  workspace?: WorkspaceRef;
}

export interface OperationRecord {
  operationId: string;
  runId: string;
  parentOperationId?: string;
  path: string;
  sourceId: string;
  kind: OperationKind;
  ordinal: number;
  status: OperationStatus;
  reason?: StructuredReason;
  semanticInputHash: string;
  callKey?: string;
  attemptCount: number;
  result?: OperationResult;
  replay?: OperationReplayRecord;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  endedAt?: string;
}

export interface AttemptRecord {
  attemptId: string;
  runId: string;
  operationId: string;
  number: number;
  effect: "agent" | "command" | "measurement" | "verification" | "apply";
  executionId?: string;
  status: AttemptStatus;
  reason?: StructuredReason;
  preWorkspace?: WorkspaceRef;
  postWorkspaceCheckpointId?: string;
  usage: UsageMeasurement;
  resources?: ResourceMeasurement;
  outputArtifacts: ArtifactRef[];
  startedAt?: string;
  updatedAt: string;
  endedAt?: string;
}

export interface ProgressMetric {
  name: string;
  value: number;
  unit?: string;
}

export interface AgentProgress {
  message?: string;
  current?: number;
  total?: number;
  metrics: ProgressMetric[];
  usage: UsageMeasurement;
  modelTurn: number;
  currentTool?: string;
  toolCount: number;
  retries: number;
  workspaceChanged: boolean;
  workspaceChangeCount: number;
  recentWorkspaceChanges: string[];
  resources?: ResourceMeasurement;
  updatedAt: string;
}

export type AgentProgressEvent =
  | { type: "report"; message: string; current?: number; total?: number; metrics?: ProgressMetric[] }
  | { type: "log"; message: string; artifact?: ArtifactRef }
  | { type: "artifact"; artifact: ArtifactRef; name?: string }
  | { type: "observed"; progress: AgentProgress };

export interface AgentProgressRecord {
  sequence: number;
  runId: string;
  operationId: string;
  agentSessionId: string;
  at: string;
  event: AgentProgressEvent;
}

/** A bounded inspector row. Full event text remains available through the paged history API. */
export interface AgentRecentProgress {
  sequence: number;
  type: Exclude<AgentProgressEvent["type"], "observed">;
  at: string;
  messagePreview?: string;
  current?: number;
  total?: number;
  metrics?: ProgressMetric[];
  artifact?: ArtifactRef;
  name?: string;
}

/** Current-row projection for an active agent; it never scans transcript evidence. */
export interface AgentLiveProgressProjection {
  session: AgentSessionRecord;
  elapsedMs: number;
  automaticMetrics: ProgressMetric[];
  recent: AgentRecentProgress[];
}

/** Durable acknowledgement of the terminating finish_work call. */
export interface AgentFinishRecord {
  toolCallId: string;
  schemaHash: string;
  value?: JsonValue;
  artifacts: ArtifactRef[];
  committedAt: string;
}

export type AgentTerminalToolName =
  | "finish_work"
  | "report_progress"
  | "log_result"
  | "publish_artifact";

/** Non-terminal tools whose authority remains in the coordinator. */
export type AgentMediatedToolName = "web_search" | "web_fetch" | "workspace_command";

/** Write-ahead authority for one coordinator-mediated effect. */
export interface AgentMediatedToolIntentRecord {
  agentSessionId: string;
  executionId: string;
  toolCallId: string;
  toolName: AgentMediatedToolName;
  requestHash: string;
  status: "started" | "uncertain" | "completed";
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  reason?: StructuredReason;
}

export type AgentProtocolToolName = AgentTerminalToolName | AgentMediatedToolName;

/**
 * Idempotence authority for one SDK-worker tool call. The execution token is
 * deliberately absent: it authenticates a live socket and is never durable
 * semantic state.
 */
export interface AgentToolReceiptRecord {
  agentSessionId: string;
  executionId: string;
  toolCallId: string;
  toolName: AgentProtocolToolName;
  requestHash: string;
  response: JsonValue;
  committedAt: string;
}

export interface AgentSessionRecord {
  agentSessionId: string;
  runId: string;
  operationId: string;
  profileId: string;
  routeId: string;
  piSessionPath: string;
  workspace: WorkspaceRef;
  network: "none" | "research";
  status: AgentSessionStatus;
  reason?: StructuredReason;
  receiptlessStrikes: number;
  currentExecutionId?: string;
  progress: AgentProgress;
  finish?: AgentFinishRecord;
  createdAt: string;
  updatedAt: string;
}

export interface CheckpointChoice {
  id: string;
  label: string;
}

export type HumanCheckpointRequest =
  | { kind: "confirm"; title?: string; prompt: string }
  | { kind: "choice"; title?: string; prompt: string; choices: CheckpointChoice[] }
  | { kind: "input"; title?: string; prompt: string; responseSchema: JsonSchema };

export interface HumanCheckpointRecord {
  checkpointId: string;
  runId: string;
  operationId: string;
  status: "waiting" | "completed" | "stopped";
  request: HumanCheckpointRequest;
  challengeHash: string;
  requestedRevision: number;
  response?: JsonValue;
  requestedAt: string;
  resolvedAt?: string;
}

export interface ApprovalChallenge {
  challengeHash: string;
  runRevision: number;
  bindingHash: string;
  summary: ArtifactRef;
}

export interface ApprovalRecord {
  approvalId: string;
  runId: string;
  operationId: string;
  kind: "apply" | "draft-promotion";
  status: "waiting" | "completed" | "stopped";
  challenge: ApprovalChallenge;
  decision?: "approved" | "rejected";
  actor?: string;
  requestedAt: string;
  resolvedAt?: string;
}

export type VerificationStatus = "passed" | "failed" | "blocked";
export type VerificationGateKind =
  | "tests"
  | "diagnostics"
  | "diff-inspection"
  | "adversarial-review"
  | "contamination";
export type VerificationGateStatus = VerificationStatus | "not-applicable";

/** One bounded gate row. Detailed command/reviewer output lives in evidence. */
export interface VerificationGateRecord {
  verificationId: string;
  ordinal: number;
  kind: VerificationGateKind;
  status: VerificationGateStatus;
  summary: string;
  environmentHash: string;
  evidenceHash: string;
  agentSessionId?: string;
  finishToolCallId?: string;
  finishSchemaHash?: string;
}

/** Historical evidence for one exact candidate and observed live-project state. */
export interface VerificationRecord {
  verificationId: string;
  runId: string;
  operationId: string;
  attemptId: string;
  attemptNumber: number;
  status: VerificationStatus;
  candidateId: string;
  candidateTreeHash: string;
  candidateLineageHash: string;
  candidateWriteScopeHash: string;
  projectSnapshotHash: string;
  liveProjectTreeHash: string;
  profileId: string;
  profileHash: string;
  gateEnvironmentHash: string;
  evidence: ArtifactRef;
  evidenceHash: string;
  gates: VerificationGateRecord[];
  createdAt: string;
}

export type ApplyPathImage =
  | { type: "absent" }
  | { type: "directory"; mode: number }
  | { type: "file"; mode: number; bytes: number; digest: string }
  | { type: "symlink"; mode: number; target: string };

export interface ApplyPathPlan {
  path: string;
  preimage: ApplyPathImage;
  postimage: ApplyPathImage;
  /** Immutable bytes used when postimage is a file. */
  content?: ArtifactRef;
}

/** Exact live-project mutation plan. It always names a waiting human approval. */
export interface ApplyPlanRecord {
  planId: string;
  runId: string;
  operationId: string;
  candidateId: string;
  candidateTreeHash: string;
  candidateLineageHash: string;
  candidateWriteScopeHash: string;
  verificationId: string;
  verificationProfileHash: string;
  gateEnvironmentHash: string;
  projectSnapshotHash: string;
  liveProjectTreeHash: string;
  unrelatedLiveHash: string;
  bindingHash: string;
  manifest: ArtifactRef;
  approvalId: string;
  challengeHash: string;
  paths: ApplyPathPlan[];
  createdAt: string;
}

/** Durable recovery authority after every verified postimage is observed. */
export interface ApplyReceiptRecord {
  receiptId: string;
  runId: string;
  operationId: string;
  planId: string;
  approvalId: string;
  challengeHash: string;
  candidateId: string;
  verificationId: string;
  mutationId: string;
  changedPaths: string[];
  reconciled: boolean;
  observedPostimageHash: string;
  startedAt: string;
  completedAt: string;
}

/** One committed effect in deterministic journal order. */
export interface WorkflowCallRecord {
  runId: string;
  operationId: string;
  ordinal: number;
  previousJournalKey: string;
  /** Hash of prompt/profile/route/tools/schema/input/pre-state semantics. */
  semanticKey: string;
  callKey: string;
  completionAuthority: "finish-work" | "host-effect";
  replayPolicy: "immutable" | "workspace" | "never";
  result: OperationResult;
  postWorkspaceCheckpointId?: string;
  committedAt: string;
}

export interface OperationReplayRecord {
  sourceRunId: string;
  sourceOperationId: string;
  ordinal: number;
  callKey: string;
  restoredWorkspaceCheckpointId?: string;
}

export interface RunReplayRecord {
  mode: "same-run" | "cross-revision-prefix";
  sourceRunId: string;
  matchedCalls: number;
  firstMissOrdinal?: number;
  firstMissReason?: string;
  fresh: boolean;
}

interface ControlRequestBase {
  requestId: string;
  runId: string;
  expectedRevision: number;
  requestedAt: string;
  actor: string;
}

export type ControlRequest =
  | (ControlRequestBase & { kind: "pause"; reason?: string })
  | (ControlRequestBase & { kind: "resume" })
  | (ControlRequestBase & { kind: "stop"; reason?: string })
  | (ControlRequestBase & { kind: "stop-effect"; operationId: string; reason?: string })
  | (ControlRequestBase & {
      kind: "checkpoint-response";
      checkpointId: string;
      challengeHash: string;
      value: JsonValue;
    })
  | (ControlRequestBase & { kind: "approve"; approvalId: string; challengeHash: string })
  | (ControlRequestBase & { kind: "reject"; approvalId: string; challengeHash: string; reason?: string })
  | (ControlRequestBase & { kind: "shutdown" });

export interface ControlAcknowledgement {
  requestId: string;
  runId: string;
  accepted: boolean;
  revision: number;
  reason?: StructuredReason;
  acknowledgedAt: string;
}

export interface RunEvent {
  runId: string;
  sequence: number;
  revision: number;
  type: string;
  operationId?: string;
  attemptId?: string;
  payload: JsonObject;
  at: string;
}
