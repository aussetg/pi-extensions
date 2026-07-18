import type { WorkflowCapability } from "../definition/workflow-types.js";
import type {
  WorkflowArtifactRecord,
  WorkflowCandidateState,
  WorkflowOperationKind,
  WorkflowOperationStatus,
  WorkflowRunStatus,
  WorkflowScopeKind,
} from "../persistence/run-database-types.js";
import type { JsonObject, JsonSchema, JsonValue } from "../types.js";

export const WORKFLOW_PROJECTION_LIMITS = Object.freeze({
  overviewOperations: 128,
  overviewArtifacts: 32,
  overviewCandidates: 32,
  overviewMeasurements: 64,
  overviewExperiments: 64,
  overviewCheckpoints: 32,
  changedPathPreview: 16,
  pageEntries: 64,
  pageBytes: 256 * 1024,
  projectionBytes: 256 * 1024,
  textScalars: 2_048,
} as const);

export interface WorkflowArtifactProjection {
  digest: string;
  kind: string;
  mediaType: WorkflowArtifactRecord["mediaType"];
  bytes: number;
  createdAt: string;
}

export interface WorkflowOperationProjection {
  operationId: string;
  parentOperationId?: string;
  scopeId: string;
  scopePath: string;
  scopeKind: WorkflowScopeKind;
  laneKey?: string;
  depth: number;
  cursor: number;
  ordinal: number;
  path: string;
  kind: WorkflowOperationKind;
  status: WorkflowOperationStatus;
  sourceSite: string;
  descriptorSourceSite?: string;
  descriptor?: {
    binding: string;
    kind: "agent-task" | "command-task";
    profile: string;
    workspace?: "snapshot" | "candidate";
    network?: "none" | "research";
    effect?: "read-only" | "temporary" | "candidate";
  };
  title?: string;
  replay?: {
    sourceRunId: string;
    sourceOperationId: string;
    sourceScopePath: string;
    sourceCursor: number;
    workspaceRestored: boolean;
  };
  outputArtifacts: WorkflowArtifactProjection[];
  checkpoint?: {
    checkpointId: string;
    workspaceId: string;
    treeHash: string;
  };
  failure?: JsonObject;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface WorkflowStructureProjection {
  operationId: string;
  kind: "parallel" | "map" | "candidate";
  path: string;
  title?: string;
  status: WorkflowOperationStatus;
  outputOrder: string[];
  lanes: Array<{
    key: string;
    scopeId: string;
    scopePath: string;
    scopeKind: Exclude<WorkflowScopeKind, "root">;
    outcome: "active" | "success" | "failure" | "cancelled";
    operationIds: string[];
  }>;
}

export interface WorkflowCandidateProjection {
  candidateId: string;
  parentCandidateId?: string;
  operationId: string;
  state: WorkflowCandidateState;
  treeHash: string;
  lineageHash: string;
  writeScopeHash: string;
  changedPathCount: number;
  changedPathPreview: string[];
  output: JsonValue;
  manifest: WorkflowArtifactProjection;
  diff: WorkflowArtifactProjection;
  verification: Array<{
    verificationId: string;
    operationId: string;
    status: "passed" | "failed" | "blocked";
    artifact: WorkflowArtifactProjection;
  }>;
  measurement?: {
    measurementId: string;
    operationId: string;
    status: "pending" | "accepted" | "rejected";
  };
  disposition?: {
    disposition: "accepted" | "rejected" | "discarded" | "abandoned";
    operationId?: string;
    verificationId?: string;
    measurementId?: string;
    reason?: JsonObject;
    disposedAt: string;
  };
  apply?: {
    operationId: string;
    approvalId: string;
    receiptId: string;
    appliedAt: string;
  };
  frozenAt: string;
}

export interface WorkflowMetricSetProjection {
  metricSetId: string;
  sourceSite: string;
  occurrence: number;
  policy: JsonObject;
  sampling: JsonObject;
  metrics: Array<{
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
  }>;
}

export interface WorkflowMeasurementProjection {
  measurementId: string;
  operationId: string;
  metricSetId: string;
  profileId: string;
  profileHash: string;
  candidateId?: string;
  workspaceTreeHash: string;
  observations: JsonObject;
  sampleCount: number;
  artifact: WorkflowArtifactProjection;
  diagnostics?: WorkflowArtifactProjection;
  createdAt: string;
}

export interface WorkflowExperimentProjection {
  experimentId: string;
  operationId: string;
  candidateId: string;
  measurementId: string;
  disposition: "accepted" | "rejected";
  learned: string;
  artifact: WorkflowArtifactProjection;
  createdAt: string;
}

export interface WorkflowResourceProjection {
  resourceId: string;
  kind: "measurement-profile";
  inputPath: string;
  selector: string;
  snapshotHash: string;
  bindingHash: string;
  outputs: Array<{ operationSite: string; output: string; role: "primary" | "guardrail" | "observe" }>;
}

export interface WorkflowHumanInteractionProjection {
  operationId: string;
  kind: "ask" | "apply";
  status: WorkflowOperationStatus;
  title?: string;
  approvalId?: string;
  receiptId?: string;
}

export interface WorkflowRunProjection {
  runId: string;
  shortRunId: string;
  workflowId: string;
  workflowName: string;
  title?: string;
  description: string;
  revision: number;
  status: WorkflowRunStatus;
  launch: {
    authority: "model" | "user" | "rpc";
    exposure: "human" | "model";
    policyHash: string;
    projectTrusted: boolean;
  };
  capabilities: string[];
  safety: { concurrency: number; maximumAgentLaunches: number };
  operationCounts: Partial<Record<WorkflowOperationStatus, number>>;
  operations: WorkflowOperationProjection[];
  operationOmittedCount: number;
  structures: WorkflowStructureProjection[];
  candidates: WorkflowCandidateProjection[];
  metricSets: WorkflowMetricSetProjection[];
  measurements: WorkflowMeasurementProjection[];
  experiments: WorkflowExperimentProjection[];
  resources: WorkflowResourceProjection[];
  humanInteractions: WorkflowHumanInteractionProjection[];
  artifacts: WorkflowArtifactProjection[];
  attention: Array<{ code: string; summary: string; operationId?: string }>;
  latestEventSequence: number;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  endedAt?: string;
}

export interface WorkflowDefinitionReviewProjection {
  workflowId: string;
  name: string;
  title?: string;
  description: string;
  exposure: "human" | "model";
  policyHash: string;
  definitionHash: string;
  sourceHash: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  concurrency?: number;
  authority: {
    capabilities: WorkflowCapability[];
    descriptors: Array<{
      binding: string;
      kind: "agent-task" | "command-task";
      profile: string;
      workspace?: "snapshot" | "candidate";
      network?: "none" | "research";
      effect?: "read-only" | "temporary" | "candidate";
      sourceSite: string;
    }>;
    verificationProfiles: string[];
    measurementProfiles: string[];
    dynamicResources: Array<{
      kind: "measurement-profile";
      inputPath: string;
      operationSite: string;
      metricPolicyPath?: string;
      samplingPath?: string;
    }>;
    candidateWrites: Array<{
      operationSite: string;
      mode: "default" | "static" | "input";
      paths?: string[];
      inputPath?: string;
    }>;
    humanInteractionSites: string[];
    applySites: string[];
    suspiciousUnboundedLoops: Array<{ line: number; column: number }>;
  };
  launchBinding?: {
    snapshotHash: string;
    authority: "model" | "user" | "rpc";
    projectTrusted: boolean;
    resources: WorkflowResourceProjection[];
  };
}

export type WorkflowInspectorPageKind =
  | "operations"
  | "attempts"
  | "artifacts"
  | "measurements"
  | "experiments"
  | "candidates"
  | "resources"
  | "events";

export interface WorkflowInspectorPage<T = JsonValue> {
  runId: string;
  revision: number;
  kind: WorkflowInspectorPageKind;
  entries: T[];
  nextCursor?: string;
  bytes: number;
}
