import type { JsonObject, JsonSchema, JsonValue } from "../types.js";

/** Authority a reviewed workflow may exercise through the host. */
export const WORKFLOW_CAPABILITIES = [
  "read-project",
  "candidate-write",
  "host-command",
  "mediated-network",
  "human-input",
] as const;

export type WorkflowCapability = (typeof WORKFLOW_CAPABILITIES)[number];
export type WorkflowNamespace = "builtin" | "user" | "project";
export type WorkflowId = `${WorkflowNamespace}:${string}`;

export interface StructuredWorkflowDefinition<
  TArgs extends JsonObject = JsonObject,
  TResult extends JsonValue = JsonValue,
> {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  capabilities: WorkflowCapability[];
  modelVisible: boolean;
  /** A definition may lower, but never raise, the host concurrency ceiling. */
  maxParallelism?: number;
  run(flow: unknown, args: TArgs): Promise<TResult>;
}

export interface StructuredWorkflowMetadata {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  capabilities: WorkflowCapability[];
  modelVisible: boolean;
  maxParallelism?: number;
}

export interface SourceLocation {
  line: number;
  column: number;
}

export interface OperationSourceLocation extends SourceLocation {
  method: string;
  id: string;
}

/** Static agent authority derived without evaluating workflow source. */
export interface AgentSourceSelection {
  id: string;
  profile: string;
  workspace: "snapshot" | "candidate";
  network: "none" | "research";
  resultMode: "value" | "artifact" | "value-and-artifact";
  location: SourceLocation;
}

/** Static named-command authority derived without evaluating workflow source. */
export interface CommandSourceSelection {
  id: string;
  profile: string;
  effect: "read-only" | "temporary" | "candidate";
  location: SourceLocation;
}

export interface NamedProfileSourceSelection {
  id: string;
  profile: string;
  location: SourceLocation;
}

export interface WorkflowReviewSummary {
  capabilities: WorkflowCapability[];
  agentProfiles: string[];
  commandProfiles: string[];
  measurementProfiles: string[];
  verificationProfiles: string[];
  usesCandidateWrites: boolean;
  usesMediatedNetwork: boolean;
  humanCheckpointCount: number;
  applySiteCount: number;
}

export interface ParsedStructuredWorkflow {
  metadata: StructuredWorkflowMetadata;
  source: string;
  sourceHash: string;
  executableSource: string;
  runFlowParameter: string;
  runArgsParameter: string;
  topLevelConstantInitializers: Array<{ start: number; end: number }>;
  operationLocations: OperationSourceLocation[];
  agentSelections: AgentSourceSelection[];
  commandSelections: CommandSourceSelection[];
  measurementSelections: NamedProfileSourceSelection[];
  verificationSelections: NamedProfileSourceSelection[];
  review: WorkflowReviewSummary;
}

export interface StructuredWorkflowRef extends StructuredWorkflowMetadata {
  id: WorkflowId;
  namespace: WorkflowNamespace;
  path: string;
  source: string;
  sourceHash: string;
  parsed: ParsedStructuredWorkflow;
}

export interface InvalidStructuredWorkflowRef {
  namespace: WorkflowNamespace;
  path: string;
  name: string;
  error: string;
  location?: SourceLocation;
}

/** Exact reviewed definition and canonical input captured for one run. */
export interface WorkflowInvocationSnapshot {
  formatVersion: 1;
  workflowId: WorkflowId;
  namespace: WorkflowNamespace;
  name: string;
  title?: string;
  description: string;
  capabilities: WorkflowCapability[];
  modelVisible: boolean;
  maxParallelism?: number;
  source: string;
  sourceHash: string;
  definitionHash: string;
  runtimeApiVersion: number;
  runtimeApiHash: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  input: JsonObject;
  inputHash: string;
  review: WorkflowReviewSummary;
  installedPath: string;
}
