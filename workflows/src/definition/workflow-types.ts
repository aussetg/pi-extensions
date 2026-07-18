import type { JsonSchema } from "../types.js";
import type {
  WorkflowDescriptorIdentity,
  WorkflowResourceKind,
} from "./workflow-language.js";

export interface WorkflowSourceLocation {
  line: number;
  column: number;
}

export interface WorkflowMetadata {
  title?: string;
  description: string;
  input: JsonSchema;
  output: JsonSchema;
  concurrency?: number;
}

interface WorkflowDescriptorBase {
  binding: string;
  identity: WorkflowDescriptorIdentity;
  profile: string;
  title?: string;
  location: WorkflowSourceLocation;
}

export interface WorkflowAgentDescriptor extends WorkflowDescriptorBase {
  kind: "agent-task";
  output: JsonSchema;
  workspace: "snapshot" | "candidate";
  network: "none" | "research";
  instructions?: string;
}

export interface WorkflowCommandDescriptor extends WorkflowDescriptorBase {
  kind: "command-task";
  output: "summary" | "text" | "json";
  effect: "read-only" | "temporary" | "candidate";
  allowFailure: boolean;
}

export type WorkflowDescriptor = WorkflowAgentDescriptor | WorkflowCommandDescriptor;

export type WorkflowExecutionContext = "root" | "concurrent" | "candidate" | "key";

export interface WorkflowOperationSite {
  sourceSite: string;
  method:
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
    | "recordExperiment"
    | "apply";
  function: string;
  contexts: WorkflowExecutionContext[];
  descriptorSourceSite?: string;
  requestedConcurrency?: number;
  errors?: "fail-fast" | "collect";
  parallelKeys?: string[];
  location: WorkflowSourceLocation;
}

export interface WorkflowHelperSummary {
  name: string;
  effectful: boolean;
  contexts: WorkflowExecutionContext[];
  effects: WorkflowOperationSite["method"][];
  location: WorkflowSourceLocation;
}

export interface WorkflowDynamicResourceUse {
  kind: WorkflowResourceKind;
  inputPath: string;
  operationSite: string;
  metricPolicyPath?: string;
  samplingPath?: string;
}

export interface WorkflowCandidateWriteSite {
  operationSite: string;
  mode: "default" | "static" | "input";
  paths?: string[];
  inputPath?: string;
}

export interface WorkflowNativeLoop {
  kind: "for" | "for-of" | "for-in" | "while" | "do-while";
  bound: "literal" | "input-schema" | "finite-iterable" | "unknown";
  containsEffects: boolean;
  location: WorkflowSourceLocation;
}

export type WorkflowCapability =
  | "read-project"
  | "candidate-write"
  | "host-command"
  | "mediated-network"
  | "human-input";

export interface WorkflowReview {
  capabilities: WorkflowCapability[];
  agentProfiles: string[];
  commandProfiles: string[];
  measurementProfiles: string[];
  verificationProfiles: string[];
  dynamicResources: WorkflowDynamicResourceUse[];
  candidateWrites: WorkflowCandidateWriteSite[];
  usesCandidateWrites: boolean;
  usesMediatedNetwork: boolean;
  humanInteractionSites: string[];
  applySites: string[];
  nativeLoops: WorkflowNativeLoop[];
  suspiciousUnboundedLoops: WorkflowSourceLocation[];
  maximumConcurrency?: number;
}

export interface WorkflowSourceTransform {
  sourceHash: string;
  strippedSourceHash: string;
  executableSourceHash: string;
  runtimeApiHash: string;
  descriptorSites: Array<{
    sourceSite: string;
    kind: "agent-task" | "command-task";
    location: WorkflowSourceLocation;
  }>;
  operationSites: Array<{
    sourceSite: string;
    method: WorkflowOperationSite["method"];
    location: WorkflowSourceLocation;
  }>;
  transformHash: string;
}

export interface ParsedWorkflow {
  fileName: string;
  installedName: string;
  source: string;
  sourceHash: string;
  strippedSource: string;
  executableSource: string;
  metadata: WorkflowMetadata;
  descriptors: WorkflowDescriptor[];
  operations: WorkflowOperationSite[];
  helpers: WorkflowHelperSummary[];
  review: WorkflowReview;
  transform: WorkflowSourceTransform;
}

export interface WorkflowSchemaResource {
  kind: WorkflowResourceKind;
  inputPath: string;
}
