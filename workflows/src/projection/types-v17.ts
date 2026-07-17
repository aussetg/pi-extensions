import type { WorkflowV17Capability } from "../definition/workflow-v17-types.js";
import type {
  WorkflowArtifactV17Record,
  WorkflowCandidateV17State,
  WorkflowOperationV17Kind,
  WorkflowOperationV17Status,
  WorkflowRunV17Status,
  WorkflowScopeV17Kind,
} from "../persistence/run-database-v17-types.js";
import type { JsonObject, JsonSchema, JsonValue } from "../types.js";

export const WORKFLOW_V17_PROJECTION_LIMITS = Object.freeze({
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

export interface WorkflowV17ArtifactProjection {
  digest: string;
  kind: string;
  mediaType: WorkflowArtifactV17Record["mediaType"];
  bytes: number;
  createdAt: string;
}

export interface WorkflowV17OperationProjection {
  operationId: string;
  parentOperationId?: string;
  scopeId: string;
  scopePath: string;
  scopeKind: WorkflowScopeV17Kind;
  laneKey?: string;
  depth: number;
  cursor: number;
  ordinal: number;
  path: string;
  kind: WorkflowOperationV17Kind;
  status: WorkflowOperationV17Status;
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
  outputArtifacts: WorkflowV17ArtifactProjection[];
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

export interface WorkflowV17StructureProjection {
  operationId: string;
  kind: "parallel" | "map" | "candidate";
  path: string;
  title?: string;
  status: WorkflowOperationV17Status;
  outputOrder: string[];
  lanes: Array<{
    key: string;
    scopeId: string;
    scopePath: string;
    scopeKind: Exclude<WorkflowScopeV17Kind, "root">;
    outcome: "active" | "success" | "failure" | "cancelled";
    operationIds: string[];
  }>;
}

export interface WorkflowV17CandidateProjection {
  candidateId: string;
  parentCandidateId?: string;
  operationId: string;
  state: WorkflowCandidateV17State;
  treeHash: string;
  lineageHash: string;
  writeScopeHash: string;
  changedPathCount: number;
  changedPathPreview: string[];
  output: JsonValue;
  manifest: WorkflowV17ArtifactProjection;
  diff: WorkflowV17ArtifactProjection;
  verification: Array<{
    verificationId: string;
    operationId: string;
    status: "passed" | "failed" | "blocked";
    artifact: WorkflowV17ArtifactProjection;
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

export interface WorkflowV17MetricSetProjection {
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

export interface WorkflowV17MeasurementProjection {
  measurementId: string;
  operationId: string;
  metricSetId: string;
  profileId: string;
  profileHash: string;
  candidateId?: string;
  workspaceTreeHash: string;
  observations: JsonObject;
  sampleCount: number;
  artifact: WorkflowV17ArtifactProjection;
  diagnostics?: WorkflowV17ArtifactProjection;
  createdAt: string;
}

export interface WorkflowV17ExperimentProjection {
  experimentId: string;
  operationId: string;
  candidateId: string;
  measurementId: string;
  disposition: "accepted" | "rejected";
  learned: string;
  artifact: WorkflowV17ArtifactProjection;
  createdAt: string;
}

export interface WorkflowV17ResourceProjection {
  resourceId: string;
  kind: "measurement-profile";
  inputPath: string;
  selector: string;
  snapshotHash: string;
  bindingHash: string;
  outputs: Array<{ operationSite: string; output: string; role: "primary" | "guardrail" | "observe" }>;
}

export interface WorkflowV17HumanInteractionProjection {
  operationId: string;
  kind: "ask" | "apply";
  status: WorkflowOperationV17Status;
  title?: string;
  approvalId?: string;
  receiptId?: string;
}

export interface WorkflowV17RunProjection {
  formatVersion: 1;
  runtimeVersion: 17;
  runId: string;
  shortRunId: string;
  workflowId: string;
  workflowName: string;
  title?: string;
  description: string;
  revision: number;
  status: WorkflowRunV17Status;
  launch: {
    authority: "model" | "user" | "rpc";
    exposure: "human" | "model";
    policyHash: string;
    projectTrusted: boolean;
  };
  capabilities: string[];
  safety: { concurrency: number; maximumAgentLaunches: number };
  operationCounts: Partial<Record<WorkflowOperationV17Status, number>>;
  operations: WorkflowV17OperationProjection[];
  operationOmittedCount: number;
  structures: WorkflowV17StructureProjection[];
  candidates: WorkflowV17CandidateProjection[];
  metricSets: WorkflowV17MetricSetProjection[];
  measurements: WorkflowV17MeasurementProjection[];
  experiments: WorkflowV17ExperimentProjection[];
  resources: WorkflowV17ResourceProjection[];
  humanInteractions: WorkflowV17HumanInteractionProjection[];
  artifacts: WorkflowV17ArtifactProjection[];
  attention: Array<{ code: string; summary: string; operationId?: string }>;
  latestEventSequence: number;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  endedAt?: string;
}

export interface WorkflowV17DefinitionReviewProjection {
  formatVersion: 1;
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
    capabilities: WorkflowV17Capability[];
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
    resources: WorkflowV17ResourceProjection[];
  };
}

export type WorkflowV17InspectorPageKind =
  | "operations"
  | "attempts"
  | "artifacts"
  | "measurements"
  | "experiments"
  | "candidates"
  | "resources"
  | "events";

export interface WorkflowV17InspectorPage<T = JsonValue> {
  formatVersion: 1;
  runtimeVersion: 17;
  runId: string;
  revision: number;
  kind: WorkflowV17InspectorPageKind;
  entries: T[];
  nextCursor?: string;
  bytes: number;
}
