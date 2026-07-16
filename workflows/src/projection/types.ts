import type { WorkflowDraftDiagnostic, WorkflowDraftOperationAnalysis } from "../drafts/types.js";
import type { PersistedMetricObservation } from "../measurements/metrics.js";
import type {
  AgentRecentProgress,
  ArtifactRef,
  HumanCheckpointRequest,
  OperationKind,
  OperationStatus,
  ProgressMetric,
  ReasonCategory,
  ResourceMeasurement,
  RunStatus,
  UsageMeasurement,
  VerificationStatus,
} from "../runtime/durable-types.js";
import type { JsonObject, JsonValue } from "../types.js";

/** Hard query and serialization bounds shared by TUI, RPC, and headless clients. */
export const WORKFLOW_PROJECTION_LIMITS = Object.freeze({
  phaseOperations: 128,
  activeAgents: 16,
  recentAgentLogs: 4,
  overviewArtifacts: 24,
  overviewMetrics: 32,
  overviewCheckpoints: 16,
  recentOperations: 16,
  changedPathPreview: 16,
  pageEntries: 64,
  pageBytes: 256 * 1024,
  projectionBytes: 256 * 1024,
  textScalars: 2_048,
} as const);

export interface WorkflowOperationProjection {
  operationId: string;
  parentOperationId?: string;
  path: string;
  sourceId: string;
  kind: OperationKind;
  ordinal: number;
  depth: number;
  status: OperationStatus;
  attemptCount: number;
  reason?: WorkflowAttentionReason;
  replay?: {
    sourceRunId: string;
    sourceOperationId: string;
    ordinal: number;
    workspaceRestored: boolean;
  };
  outputArtifacts: ArtifactRef[];
  outputArtifactOmittedCount: number;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  endedAt?: string;
}

export interface WorkflowAgentProjection {
  agentSessionId: string;
  operationId: string;
  profileId: string;
  routeId: string;
  status: RunStatus;
  reason?: WorkflowAttentionReason;
  workspace: { kind: "snapshot" | "candidate"; workspaceId: string; treeHash: string };
  network: "none" | "research";
  receiptlessStrikes: number;
  executionId?: string;
  progress?: { message: string; current?: number; total?: number };
  customMetrics: ProgressMetric[];
  automaticMetrics: ProgressMetric[];
  currentTool?: string;
  modelTurn: number;
  toolCount: number;
  retries: number;
  usage: UsageMeasurement;
  resources?: ResourceMeasurement;
  workspaceChanged: boolean;
  workspaceChangeCount: number;
  recentWorkspaceChanges: string[];
  recentLogs: AgentRecentProgress[];
  elapsedMs: number;
  updatedAt: string;
}

export interface WorkflowCheckpointProjection {
  checkpointId: string;
  operationId: string;
  status: "waiting" | "completed" | "stopped";
  request: HumanCheckpointRequest;
  challengeHash: string;
  requestedRevision: number;
  response?: JsonValue;
  requestedAt: string;
  resolvedAt?: string;
}

export interface WorkflowApplyProjection {
  operationId: string;
  planId: string;
  approvalId: string;
  status: "waiting" | "approved" | "rejected" | "stopped" | "applied";
  challenge: {
    challengeHash: string;
    runRevision: number;
    bindingHash: string;
    summary: ArtifactRef;
  };
  candidateId: string;
  candidateTreeHash: string;
  candidateLineageHash: string;
  candidateWriteScopeHash: string;
  verificationId: string;
  verificationProfileHash: string;
  changedPathCount: number;
  changedPathPreview: string[];
  receiptId?: string;
}

export interface WorkflowCandidateProjection {
  candidateId: string;
  parentCandidateId?: string;
  workspaceId: string;
  treeHash: string;
  lineageHash: string;
  writeScopeHash: string;
  changedPathCount: number;
  changedPathPreview: string[];
  manifest: ArtifactRef;
  diff: ArtifactRef;
  frozenAt: string;
}

export interface WorkflowMetricProjection {
  metricId: string;
  title: string;
  role: "primary" | "guardrail" | "secondary";
  direction: "minimize" | "maximize";
  unit?: string;
  baseline: number | null;
  current: number | null;
  best: number | null;
  relativeGain: number | null;
  observationCount: number;
  recentObservations: PersistedMetricObservation[];
}

export interface WorkflowAttentionReason {
  category: ReasonCategory;
  code: string;
  summary: string;
  retryable: boolean;
  operationId?: string;
  evidence?: ArtifactRef[];
}

export interface WorkflowReplayProjection {
  mode: "same-run" | "cross-revision-prefix";
  sourceRunId: string;
  matchedCalls: number;
  firstMissOrdinal?: number;
  firstMissReason?: string;
  fresh: boolean;
}

/** The only runtime read model. It contains data, never Pi component state. */
export interface WorkflowRunProjection {
  formatVersion: 1;
  runId: string;
  shortRunId: string;
  workflowId: string;
  workflowName: string;
  revision: number;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  endedAt?: string;
  currentOperationId?: string;
  usage: UsageMeasurement;
  safety: { concurrency: number; maximumAgentLaunches: number };
  operationCounts: Partial<Record<OperationStatus, number>>;
  phaseTree: WorkflowOperationProjection[];
  phaseOperationOmittedCount: number;
  recentOperations: WorkflowOperationProjection[];
  activeAgents: WorkflowAgentProjection[];
  checkpoints: WorkflowCheckpointProjection[];
  apply?: WorkflowApplyProjection;
  candidate?: WorkflowCandidateProjection;
  metrics: WorkflowMetricProjection[];
  artifacts: ArtifactRef[];
  replay?: WorkflowReplayProjection;
  attentionReasons: WorkflowAttentionReason[];
  pendingControlRequests: number;
  latestEventSequence: number;
}

export type WorkflowInspectorPageKind = "operations" | "logs" | "artifacts" | "measurements" | "events";

export interface WorkflowInspectorPage<T = JsonValue> {
  formatVersion: 1;
  runId: string;
  revision: number;
  kind: WorkflowInspectorPageKind;
  entries: T[];
  nextCursor?: string;
  bytes: number;
}

export interface WorkflowMeasurementPageEntry {
  measurementId: string;
  operationId: string;
  profileId: string;
  candidateId?: string;
  environmentHash: string;
  observationCount: number;
  sampleCount: number;
  startedAt: string;
  endedAt: string;
}

export interface WorkflowDraftValidationProjection {
  formatVersion: 1;
  draftId: string;
  namespace: "user" | "project";
  name: string;
  valid: boolean;
  source: { draftHash: string; installedHash: string | null; targetPath: string; changed: boolean; diffPreview: string; truncated: boolean };
  reviewHash: string;
  capabilities: { declared: string[]; derived: string[] };
  profiles: Array<{ id: string; profileHash: string; routeId: string; routeHash: string }>;
  commandProfiles: string[];
  operations: WorkflowDraftOperationAnalysis;
  diagnostics: WorkflowDraftDiagnostic[];
}

export interface WorkflowDraftPromotionProjection {
  formatVersion: 1;
  validation: WorkflowDraftValidationProjection;
  challenge: {
    challengeHash: string;
    draftHash: string;
    installedSourceHash: string | null;
    reviewHash: string;
    targetNamespace: "user" | "project";
    targetPath: string;
  };
}

export interface WorkflowApplyApprovalInspectorProjection {
  formatVersion: 1;
  runId: string;
  revision: number;
  approvalId: string;
  operationId: string;
  status: "waiting" | "completed" | "stopped";
  decision?: "approved" | "rejected";
  challengeHash: string;
  bindingHash: string;
  summaryArtifact: ArtifactRef;
  candidate: { id: string; treeHash: string; lineageHash: string; writeScopeHash: string };
  verification: { id: string; profileHash: string; environmentHash: string; status: VerificationStatus };
  paths: { count: number; preview: string[] };
  requestedAt: string;
  resolvedAt?: string;
}

export type ProjectionJson = JsonObject;
