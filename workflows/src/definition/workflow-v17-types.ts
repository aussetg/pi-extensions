import type { JsonSchema } from "../types.js";
import type {
  WorkflowV17DescriptorIdentity,
  WorkflowV17ResourceKind,
} from "./workflow-language-v17.js";

export interface WorkflowV17SourceLocation {
  line: number;
  column: number;
}

export interface WorkflowV17Metadata {
  title?: string;
  description: string;
  input: JsonSchema;
  output: JsonSchema;
  concurrency?: number;
}

interface WorkflowV17DescriptorBase {
  binding: string;
  identity: WorkflowV17DescriptorIdentity;
  profile: string;
  title?: string;
  location: WorkflowV17SourceLocation;
}

export interface WorkflowV17AgentDescriptor extends WorkflowV17DescriptorBase {
  kind: "agent-task";
  output: JsonSchema;
  workspace: "snapshot" | "candidate";
  network: "none" | "research";
  instructions?: string;
}

export interface WorkflowV17CommandDescriptor extends WorkflowV17DescriptorBase {
  kind: "command-task";
  output: "summary" | "text" | "json";
  effect: "read-only" | "temporary" | "candidate";
  allowFailure: boolean;
}

export type WorkflowV17Descriptor = WorkflowV17AgentDescriptor | WorkflowV17CommandDescriptor;

export type WorkflowV17ExecutionContext = "root" | "concurrent" | "candidate" | "key";

export interface WorkflowV17OperationSite {
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
  contexts: WorkflowV17ExecutionContext[];
  descriptorSourceSite?: string;
  requestedConcurrency?: number;
  errors?: "fail-fast" | "collect";
  parallelKeys?: string[];
  location: WorkflowV17SourceLocation;
}

export interface WorkflowV17HelperSummary {
  name: string;
  effectful: boolean;
  contexts: WorkflowV17ExecutionContext[];
  effects: WorkflowV17OperationSite["method"][];
  location: WorkflowV17SourceLocation;
}

export interface WorkflowV17DynamicResourceUse {
  kind: WorkflowV17ResourceKind;
  inputPath: string;
  operationSite: string;
  metricPolicyPath?: string;
  samplingPath?: string;
}

export interface WorkflowV17CandidateWriteSite {
  operationSite: string;
  mode: "default" | "static" | "input";
  paths?: string[];
  inputPath?: string;
}

export interface WorkflowV17NativeLoop {
  kind: "for" | "for-of" | "for-in" | "while" | "do-while";
  bound: "literal" | "input-schema" | "finite-iterable" | "unknown";
  containsEffects: boolean;
  location: WorkflowV17SourceLocation;
}

export type WorkflowV17Capability =
  | "read-project"
  | "candidate-write"
  | "host-command"
  | "mediated-network"
  | "human-input";

export interface WorkflowV17Review {
  capabilities: WorkflowV17Capability[];
  agentProfiles: string[];
  commandProfiles: string[];
  measurementProfiles: string[];
  verificationProfiles: string[];
  dynamicResources: WorkflowV17DynamicResourceUse[];
  candidateWrites: WorkflowV17CandidateWriteSite[];
  usesCandidateWrites: boolean;
  usesMediatedNetwork: boolean;
  humanInteractionSites: string[];
  applySites: string[];
  nativeLoops: WorkflowV17NativeLoop[];
  suspiciousUnboundedLoops: WorkflowV17SourceLocation[];
  maximumConcurrency?: number;
}

export interface WorkflowV17SourceTransform {
  formatVersion: 1;
  sourceHash: string;
  strippedSourceHash: string;
  executableSourceHash: string;
  runtimeApiHash: string;
  descriptorSites: Array<{
    sourceSite: string;
    kind: "agent-task" | "command-task";
    location: WorkflowV17SourceLocation;
  }>;
  operationSites: Array<{
    sourceSite: string;
    method: WorkflowV17OperationSite["method"];
    location: WorkflowV17SourceLocation;
  }>;
  transformHash: string;
}

export interface ParsedWorkflowV17 {
  formatVersion: 1;
  fileName: string;
  installedName: string;
  source: string;
  sourceHash: string;
  strippedSource: string;
  executableSource: string;
  metadata: WorkflowV17Metadata;
  descriptors: WorkflowV17Descriptor[];
  operations: WorkflowV17OperationSite[];
  helpers: WorkflowV17HelperSummary[];
  review: WorkflowV17Review;
  transform: WorkflowV17SourceTransform;
}

export interface WorkflowV17SchemaResource {
  kind: WorkflowV17ResourceKind;
  inputPath: string;
}
