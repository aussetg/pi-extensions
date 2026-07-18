import type { WorkflowMeasurementResourceBinding } from "./workflow-invocation.js";
import type { JsonObject, JsonValue } from "../types.js";
import type { SafetyConfiguration } from "../runtime/durable-types.js";
import type { MetricCohortDelta, PersistedMetricState } from "../measurements/metrics.js";
import type { MeasurementProfileSnapshot } from "../measurements/profiles.js";

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "completed"
  | "failed"
  | "stopped";

export type WorkflowScopeKind = "root" | "parallel-branch" | "map-item" | "candidate-body";
export type WorkflowScopeStatus = "active" | "completed" | "failed" | "cancelled";

export type WorkflowOperationKind =
  | "parallel"
  | "map"
  | "agent"
  | "command"
  | "ask"
  | "measure"
  | "candidate"
  | "verify"
  | "accept"
  | "reject"
  | "record-experiment"
  | "apply";

export type WorkflowOperationStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "stopped"
  | "cancelled";

export interface WorkflowRunRecord {
  runId: string;
  revision: number;
  workflow: {
    id: `${"builtin" | "user" | "project"}:${string}`;
    name: string;
    sourceHash: string;
    definitionHash: string;
    snapshotHash: string;
    runtimeApiHash: string;
  };
  invocationHash: string;
  resourcesHash: string;
  projectSnapshotHash: string;
  routeSnapshotHash: string;
  staticResourcesHash: string;
  contextIdentityHash: string;
  launch: {
    authority: "model" | "user" | "rpc";
    exposure: "human" | "model";
    policyHash: string;
    projectTrusted: boolean;
  };
  capabilities: string[];
  safety: SafetyConfiguration;
  status: WorkflowRunStatus;
  reason?: JsonObject;
  rootScopeId: string;
  currentOperationId?: string;
  rootTerminalKey?: string;
  result?: JsonValue;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  endedAt?: string;
}

export interface WorkflowRunEvent {
  runId: string;
  sequence: number;
  revision: number;
  type: string;
  operationId?: string;
  scopeId?: string;
  candidateId?: string;
  payload: JsonObject;
  at: string;
}

export interface WorkflowHumanInteractionRecord {
  interactionId: string;
  runId: string;
  operationId: string;
  kind: "ask" | "apply";
  status: "waiting" | "answered" | "approved" | "rejected";
  challengeHash: string;
  request: JsonObject;
  response?: JsonValue;
  requestedAt: string;
  resolvedAt?: string;
}

export interface WorkflowControlRequestRecord {
  requestId: string;
  runId: string;
  kind: "pause" | "resume" | "stop" | "stop-effect" | "ask-response" | "apply-approve" | "apply-reject";
  targetId?: string;
  challengeHash?: string;
  value?: JsonValue;
  actor: string;
  status: "pending" | "processed" | "rejected";
  reason?: JsonObject;
  requestedAt: string;
  processedAt?: string;
}

export interface WorkflowScopeRecord {
  scopeId: string;
  runId: string;
  parentScopeId?: string;
  ownerOperationId?: string;
  path: string;
  kind: WorkflowScopeKind;
  siblingOrdinal: number;
  laneKey?: string;
  seedKey: string;
  status: WorkflowScopeStatus;
  terminalKey?: string;
  failure?: JsonObject;
  createdAt: string;
  endedAt?: string;
}

export interface WorkflowOperationRecord {
  operationId: string;
  runId: string;
  scopeId: string;
  cursor: number;
  path: string;
  kind: WorkflowOperationKind;
  ordinal: number;
  sourceSite: string;
  descriptorSourceSite?: string;
  title?: string;
  semanticInputHash: string;
  status: WorkflowOperationStatus;
  result?: JsonValue;
  failure?: JsonObject;
  callKey?: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface WorkflowScopeCallRecord {
  operationId: string;
  runId: string;
  scopeId: string;
  cursor: number;
  previousCallKey: string;
  semanticKey: string;
  callKey: string;
  outcome: "success" | "failure";
  completionAuthority: "finish-work" | "host-effect" | "structural-join";
  replayPolicy: "immutable" | "workspace" | "never";
  resultHash: string;
  postWorkspaceCheckpointId?: string;
  replay?: {
    sourceRunId: string;
    sourceOperationId: string;
    sourceScopePath: string;
    sourceCursor: number;
    sourceCallKey: string;
  };
  committedAt: string;
}

/** Durable host settlement consumed before a scope call is committed. */
export interface WorkflowEffectSettlementRecord {
  operationId: string;
  runId: string;
  semanticKey: string;
  outcome: "success" | "failure";
  completionAuthority: Exclude<WorkflowScopeCallRecord["completionAuthority"], "structural-join">;
  replayPolicy: WorkflowScopeCallRecord["replayPolicy"];
  result?: JsonValue;
  failure?: JsonObject;
  postWorkspaceCheckpointId?: string;
  settledAt: string;
}

export interface WorkflowStructuralJoinLaneRecord {
  ordinal: number;
  laneKey: string;
  scopeId: string;
  terminalKey: string;
  outcome: "success" | "failure" | "cancelled";
}

export interface WorkflowStructuralJoinRecord {
  operationId: string;
  runId: string;
  scopeId: string;
  cursor: number;
  kind: "parallel" | "map" | "candidate";
  previousCallKey: string;
  policyHash: string;
  outputOrder: string[];
  joinKey: string;
  lanes: WorkflowStructuralJoinLaneRecord[];
  committedAt: string;
}

export interface WorkflowInvocationResourceRecord {
  resourceId: string;
  runId: string;
  kind: "measurement-profile";
  inputPath: string;
  selector: string;
  snapshotHash: string;
  bindingHash: string;
  resource: WorkflowMeasurementResourceBinding;
}

export interface WorkflowArtifactRecord {
  digest: string;
  runId: string;
  kind: string;
  mediaType: "text/plain; charset=utf-8" | "application/json" | "application/octet-stream";
  bytes: number;
  bodyPath: string;
  metadata: JsonObject;
  createdAt: string;
}

export interface WorkflowOperationArtifactRecord {
  operationId: string;
  role: "input" | "output" | "evidence" | "progress";
  name?: string;
  ordinal: number;
  artifact: WorkflowArtifactRecord;
}

export interface WorkflowCallArtifactInput {
  role: WorkflowOperationArtifactRecord["role"];
  name?: string;
  ordinal: number;
  artifact: WorkflowArtifactRecord;
}

export interface WorkflowAttemptRecord {
  attemptId: string;
  runId: string;
  operationId: string;
  number: number;
  effect: "agent" | "command" | "measurement" | "verification" | "apply";
  executionId?: string;
  status: "running" | "waiting" | "completed" | "failed" | "stopped" | "cancelled";
  usage: JsonObject;
  resources?: JsonObject;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface WorkflowWorkspaceCheckpointRecord {
  checkpointId: string;
  runId: string;
  operationId: string;
  workspaceId: string;
  treeHash: string;
  lineageHash?: string;
  writeScopeHash?: string;
  storagePath: string;
  createdAt: string;
}

export interface WorkflowCandidateWorkspaceRecord {
  workspaceId: string;
  runId: string;
  candidateOperationId: string;
  bodyScopeId: string;
  parentCandidateId?: string;
  state: "mutable" | "frozen" | "abandoned";
  initialTreeHash: string;
  baseLineageHash: string;
  writeScope: JsonValue;
  writeScopeHash: string;
  rootPath: string;
  failure?: JsonObject;
  createdAt: string;
  endedAt?: string;
}

export type WorkflowCandidateState =
  | "pending"
  | "accepted"
  | "rejected"
  | "discarded"
  | "abandoned"
  | "applied";

export interface WorkflowCandidateRecord {
  candidateId: string;
  runId: string;
  operationId: string;
  workspaceId: string;
  bodyScopeId: string;
  parentCandidateId?: string;
  treeHash: string;
  lineageHash: string;
  writeScopeHash: string;
  output: JsonValue;
  outputHash: string;
  changedPaths: string[];
  manifestArtifactDigest: string;
  diffArtifactDigest: string;
  state: WorkflowCandidateState;
  disposition?: WorkflowCandidateDispositionRecord;
  appliedReceiptId?: string;
  frozenAt: string;
}

export interface WorkflowCandidateDispositionRecord {
  candidateId: string;
  runId: string;
  operationId?: string;
  disposition: "accepted" | "rejected" | "discarded" | "abandoned";
  authorityHash: string;
  verificationId?: string;
  measurementId?: string;
  reason?: JsonObject;
  disposedAt: string;
}

export interface WorkflowCandidateMeasurementRecord {
  measurementId: string;
  runId: string;
  candidateId: string;
  operationId: string;
  bindingHash: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
  finalizedAt?: string;
}

export interface WorkflowMetricSetRecord {
  metricSetId: string;
  runId: string;
  authorityId: string;
  sourceSite: string;
  occurrence: number;
  policy: JsonObject;
  policyHash: string;
  sampling: JsonObject;
  samplingHash: string;
  states: PersistedMetricState[];
  stateHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowMeasurementSampleRecord {
  ordinal: number;
  kind: "warmup" | "sample";
  sampleIndex: number;
  executionId: string;
  status: "completed" | "timed-out" | "output-limited" | "infrastructure-failure" | "cancelled";
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  stdoutArtifactDigest: string;
  stderrArtifactDigest: string;
  resources?: JsonObject;
  startedAt: string;
  endedAt: string;
}

export interface WorkflowMeasurementRecord {
  measurementId: string;
  runId: string;
  operationId: string;
  metricSetId: string;
  profile: MeasurementProfileSnapshot;
  profileHash: string;
  commandHash: string;
  environment: JsonObject;
  environmentHash: string;
  workspaceTreeHash: string;
  candidateId?: string;
  bindingHash: string;
  delta: MetricCohortDelta;
  observations: JsonObject;
  artifactDigest: string;
  diagnosticsArtifactDigest?: string;
  samples: WorkflowMeasurementSampleRecord[];
  createdAt: string;
}

export interface WorkflowExperimentRecord {
  experimentId: string;
  runId: string;
  operationId: string;
  candidateId: string;
  measurementId: string;
  disposition: "accepted" | "rejected";
  learned: string;
  bindingHash: string;
  artifactDigest: string;
  createdAt: string;
}

export interface WorkflowCandidateVerificationRecord {
  verificationId: string;
  runId: string;
  candidateId: string;
  operationId: string;
  status: "passed" | "failed" | "blocked";
  bindingHash: string;
  evidenceHash: string;
  artifactDigest: string;
  createdAt: string;
}

export interface WorkflowCandidateApplyRecord {
  receiptId: string;
  runId: string;
  candidateId: string;
  operationId: string;
  approvalId: string;
  verificationBindingHash: string;
  authorityHash: string;
  appliedAt: string;
}

export interface ClaimWorkflowOperationInput {
  expectedRevision: number;
  scopeId: string;
  cursor: number;
  kind: WorkflowOperationKind;
  sourceSite: string;
  descriptorSourceSite?: string;
  title?: string;
  semanticInputHash: string;
  maximumOperations?: number;
  maximumAgentOperations?: number;
  at: string;
}

export interface SettleWorkflowEffectInput {
  expectedRevision: number;
  operationId: string;
  semanticKey: string;
  outcome: "success" | "failure";
  completionAuthority: Exclude<WorkflowScopeCallRecord["completionAuthority"], "structural-join">;
  replayPolicy: WorkflowScopeCallRecord["replayPolicy"];
  result?: JsonValue;
  failure?: JsonObject;
  postWorkspaceCheckpointId?: string;
  at: string;
}

export interface CreateWorkflowChildScopeSpec {
  kind: Exclude<WorkflowScopeKind, "root">;
  laneKey?: string;
  seedKey: string;
}

export interface CompleteWorkflowCallInput {
  expectedRevision: number;
  operationId: string;
  previousCallKey: string;
  semanticKey: string;
  callKey: string;
  outcome: "success" | "failure";
  completionAuthority: WorkflowScopeCallRecord["completionAuthority"];
  replayPolicy: WorkflowScopeCallRecord["replayPolicy"];
  result?: JsonValue;
  failure?: JsonObject;
  postWorkspaceCheckpointId?: string;
  workspaceCheckpoint?: WorkflowWorkspaceCheckpointRecord;
  artifacts?: WorkflowCallArtifactInput[];
  replay?: NonNullable<WorkflowScopeCallRecord["replay"]>;
  at: string;
}

export interface CompleteWorkflowStructuralJoinInput
  extends Omit<CompleteWorkflowCallInput,
    "completionAuthority" | "outcome" | "replayPolicy" | "failure"> {
  kind: WorkflowStructuralJoinRecord["kind"];
  policyHash: string;
  joinKey: string;
  outputOrder: string[];
  lanes: Array<Omit<WorkflowStructuralJoinLaneRecord, "ordinal">>;
}

export interface CompleteWorkflowStructuralFailureInput
  extends Omit<CompleteWorkflowCallInput,
    "completionAuthority" | "outcome" | "replayPolicy" | "result" | "replay"> {
  kind: WorkflowStructuralJoinRecord["kind"];
  policyHash: string;
  joinKey: string;
  outputOrder: string[];
  lanes: Array<Omit<WorkflowStructuralJoinLaneRecord, "ordinal">>;
  failure: JsonObject;
}
