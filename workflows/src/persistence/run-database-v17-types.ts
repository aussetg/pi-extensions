import type { WorkflowV17MeasurementResourceBinding } from "./workflow-v17-invocation.js";
import type { JsonObject, JsonValue } from "../types.js";
import type { SafetyConfiguration } from "../runtime/durable-types.js";

export type WorkflowRunV17Status =
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "completed"
  | "failed"
  | "stopped";

export type WorkflowScopeV17Kind = "root" | "parallel-branch" | "map-item" | "candidate-body";
export type WorkflowScopeV17Status = "active" | "completed" | "failed" | "cancelled";

export type WorkflowOperationV17Kind =
  | "parallel"
  | "map"
  | "agent"
  | "command"
  | "ask"
  | "metrics"
  | "measure"
  | "candidate"
  | "verify"
  | "accept"
  | "reject"
  | "record-experiment"
  | "apply";

export type WorkflowOperationV17Status =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "stopped"
  | "cancelled";

export interface WorkflowRunV17Record {
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
  contextIdentityHash: string;
  launch: {
    authority: "model" | "user" | "rpc";
    exposure: "human" | "model";
    policyHash: string;
    projectTrusted: boolean;
  };
  capabilities: string[];
  safety: SafetyConfiguration;
  status: WorkflowRunV17Status;
  reason?: JsonObject;
  rootScopeId: string;
  currentOperationId?: string;
  rootTerminalKey?: string;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  endedAt?: string;
}

export interface WorkflowRunV17Event {
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

export interface WorkflowScopeV17Record {
  scopeId: string;
  runId: string;
  parentScopeId?: string;
  ownerOperationId?: string;
  path: string;
  kind: WorkflowScopeV17Kind;
  siblingOrdinal: number;
  laneKey?: string;
  seedKey: string;
  status: WorkflowScopeV17Status;
  terminalKey?: string;
  failure?: JsonObject;
  createdAt: string;
  endedAt?: string;
}

export interface WorkflowOperationV17Record {
  operationId: string;
  runId: string;
  scopeId: string;
  cursor: number;
  path: string;
  kind: WorkflowOperationV17Kind;
  ordinal: number;
  sourceSite: string;
  descriptorSourceSite?: string;
  title?: string;
  semanticInputHash: string;
  status: WorkflowOperationV17Status;
  result?: JsonValue;
  failure?: JsonObject;
  callKey?: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface WorkflowScopeCallV17Record {
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
export interface WorkflowEffectSettlementV17Record {
  operationId: string;
  runId: string;
  semanticKey: string;
  outcome: "success" | "failure";
  completionAuthority: Exclude<WorkflowScopeCallV17Record["completionAuthority"], "structural-join">;
  replayPolicy: WorkflowScopeCallV17Record["replayPolicy"];
  result?: JsonValue;
  failure?: JsonObject;
  settledAt: string;
}

export interface WorkflowStructuralJoinLaneV17Record {
  ordinal: number;
  laneKey: string;
  scopeId: string;
  terminalKey: string;
  outcome: "success" | "failure" | "cancelled";
}

export interface WorkflowStructuralJoinV17Record {
  operationId: string;
  runId: string;
  scopeId: string;
  cursor: number;
  kind: "parallel" | "map" | "candidate";
  previousCallKey: string;
  policyHash: string;
  outputOrder: string[];
  joinKey: string;
  lanes: WorkflowStructuralJoinLaneV17Record[];
  committedAt: string;
}

export interface WorkflowInvocationResourceV17Record {
  resourceId: string;
  runId: string;
  kind: "measurement-profile";
  inputPath: string;
  selector: string;
  snapshotHash: string;
  bindingHash: string;
  resource: WorkflowV17MeasurementResourceBinding;
}

export interface WorkflowArtifactV17Record {
  digest: string;
  runId: string;
  kind: string;
  mediaType: "text/plain; charset=utf-8" | "application/json" | "application/octet-stream";
  bytes: number;
  bodyPath: string;
  metadata: JsonObject;
  createdAt: string;
}

export interface WorkflowOperationArtifactV17Record {
  operationId: string;
  role: "input" | "output" | "evidence" | "progress";
  name?: string;
  ordinal: number;
  artifact: WorkflowArtifactV17Record;
}

export interface WorkflowCallArtifactV17Input {
  role: WorkflowOperationArtifactV17Record["role"];
  name?: string;
  ordinal: number;
  artifact: WorkflowArtifactV17Record;
}

export interface WorkflowAttemptV17Record {
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

export interface WorkflowWorkspaceCheckpointV17Record {
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

export interface WorkflowCandidateWorkspaceV17Record {
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

export type WorkflowCandidateV17State =
  | "pending"
  | "accepted"
  | "rejected"
  | "discarded"
  | "abandoned"
  | "applied";

export interface WorkflowCandidateV17Record {
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
  state: WorkflowCandidateV17State;
  disposition?: WorkflowCandidateDispositionV17Record;
  appliedReceiptId?: string;
  frozenAt: string;
}

export interface WorkflowCandidateDispositionV17Record {
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

export interface WorkflowCandidateMeasurementV17Record {
  measurementId: string;
  runId: string;
  candidateId: string;
  operationId: string;
  bindingHash: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
  finalizedAt?: string;
}

export interface WorkflowCandidateVerificationV17Record {
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

export interface WorkflowCandidateApplyV17Record {
  receiptId: string;
  runId: string;
  candidateId: string;
  operationId: string;
  approvalId: string;
  verificationBindingHash: string;
  authorityHash: string;
  appliedAt: string;
}

export interface ClaimWorkflowOperationV17Input {
  expectedRevision: number;
  scopeId: string;
  cursor: number;
  kind: WorkflowOperationV17Kind;
  sourceSite: string;
  descriptorSourceSite?: string;
  title?: string;
  semanticInputHash: string;
  maximumOperations?: number;
  maximumAgentOperations?: number;
  at: string;
}

export interface SettleWorkflowEffectV17Input {
  expectedRevision: number;
  operationId: string;
  semanticKey: string;
  outcome: "success" | "failure";
  completionAuthority: Exclude<WorkflowScopeCallV17Record["completionAuthority"], "structural-join">;
  replayPolicy: WorkflowScopeCallV17Record["replayPolicy"];
  result?: JsonValue;
  failure?: JsonObject;
  at: string;
}

export interface CreateWorkflowChildScopeV17Spec {
  kind: Exclude<WorkflowScopeV17Kind, "root">;
  laneKey?: string;
  seedKey: string;
}

export interface CompleteWorkflowCallV17Input {
  expectedRevision: number;
  operationId: string;
  previousCallKey: string;
  semanticKey: string;
  callKey: string;
  outcome: "success" | "failure";
  completionAuthority: WorkflowScopeCallV17Record["completionAuthority"];
  replayPolicy: WorkflowScopeCallV17Record["replayPolicy"];
  result?: JsonValue;
  failure?: JsonObject;
  postWorkspaceCheckpointId?: string;
  workspaceCheckpoint?: WorkflowWorkspaceCheckpointV17Record;
  artifacts?: WorkflowCallArtifactV17Input[];
  replay?: NonNullable<WorkflowScopeCallV17Record["replay"]>;
  at: string;
}

export interface CompleteWorkflowStructuralJoinV17Input
  extends Omit<CompleteWorkflowCallV17Input,
    "completionAuthority" | "outcome" | "replayPolicy" | "failure"> {
  kind: WorkflowStructuralJoinV17Record["kind"];
  policyHash: string;
  joinKey: string;
  outputOrder: string[];
  lanes: Array<Omit<WorkflowStructuralJoinLaneV17Record, "ordinal">>;
}
