import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonObject, JsonValue } from "../types.js";
import type {
  ArtifactRef,
  HumanCheckpointRecord,
  RunStatus,
  StructuredReason,
  UsageMeasurement,
} from "./durable-types.js";
import type {
  WorkflowInspectorPage,
  WorkflowInspectorPageKind,
  WorkflowRunProjection,
} from "../projection/types.js";

export type WorkflowInvocationAuthority = "model" | "user" | "rpc";
export type WorkflowInvocationMode = "await" | "async";

export interface NamedWorkflowInvocation {
  name: string;
  args: JsonObject;
  mode: WorkflowInvocationMode;
}

/** Small extension-side read model. The full inspector projection is built later. */
export interface WorkflowRunSummary {
  runId: string;
  shortRunId: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  revision: number;
  reason?: StructuredReason;
  currentOperationId?: string;
  result?: ArtifactRef;
  usage: UsageMeasurement;
  replay?: {
    sourceRunId: string;
    matchedCalls: number;
    firstMissOrdinal?: number;
    fresh: boolean;
  };
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export type WorkflowRunDetails = WorkflowRunProjection;

export interface NamedWorkflowResult {
  runId: string;
  status: RunStatus;
  summary: WorkflowRunSummary;
  result?: JsonValue;
  resultArtifact?: ArtifactRef;
  handoff: boolean;
}

export interface WorkflowReplayInvocation {
  sourceRunRef: string;
  args?: JsonObject;
  mode: WorkflowInvocationMode;
  fresh: boolean;
}

export interface WorkflowCheckpointChallenge {
  summary: WorkflowRunSummary;
  checkpoint: HumanCheckpointRecord;
  token: string;
}

export interface WorkflowApprovalChallenge {
  summary: WorkflowRunSummary;
  approvalId: string;
  operationId: string;
  token: string;
  summaryArtifact: ArtifactRef;
}

export interface WorkflowDeletionChallenge {
  summary: WorkflowRunSummary;
  token: string;
}

/** The tools and commands depend on this client contract, not coordinator internals. */
export interface NamedWorkflowClient {
  readonly registry: import("../registry/structured-workflows.js").StructuredWorkflowRegistry;
  bindContext(ctx: ExtensionContext): void;
  detachContext(): void;
  refreshDefinitions(ctx: ExtensionContext): Promise<void>;
  restoreAsyncNotifications(ctx: ExtensionContext): Promise<void>;
  invoke(
    input: NamedWorkflowInvocation,
    authority: WorkflowInvocationAuthority,
    ctx: ExtensionContext,
    options?: { onUpdate?: (summary: WorkflowRunSummary) => void | Promise<void> },
  ): Promise<NamedWorkflowResult>;
  replay(input: WorkflowReplayInvocation, authority: WorkflowInvocationAuthority, ctx: ExtensionContext): Promise<NamedWorkflowResult>;
  list(ctx: ExtensionContext): Promise<WorkflowRunSummary[]>;
  open(runRef: string, ctx: ExtensionContext): Promise<WorkflowRunDetails>;
  inspectPage(
    runRef: string,
    kind: WorkflowInspectorPageKind,
    options: { cursor?: string; limit?: number },
    ctx: ExtensionContext,
  ): Promise<WorkflowInspectorPage>;
  pause(runRef: string, ctx: ExtensionContext): Promise<WorkflowRunSummary>;
  resume(runRef: string, ctx: ExtensionContext): Promise<WorkflowRunSummary>;
  stop(runRef: string, ctx: ExtensionContext): Promise<WorkflowRunSummary>;
  stopEffect(runRef: string, operationRef: string, ctx: ExtensionContext): Promise<WorkflowRunSummary>;
  checkpointChallenge(runRef: string, checkpointId: string | undefined, ctx: ExtensionContext): Promise<WorkflowCheckpointChallenge>;
  respond(
    runRef: string,
    checkpointId: string | undefined,
    challenge: string,
    value: JsonValue,
    ctx: ExtensionContext,
  ): Promise<WorkflowRunSummary>;
  approvalChallenge(runRef: string, ctx: ExtensionContext): Promise<WorkflowApprovalChallenge>;
  decideApproval(
    runRef: string,
    decision: "approve" | "reject",
    challenge: string,
    ctx: ExtensionContext,
  ): Promise<WorkflowRunSummary>;
  deletionChallenge(runRef: string, ctx: ExtensionContext): Promise<WorkflowDeletionChallenge>;
  deleteRun(runRef: string, challenge: string, ctx: ExtensionContext): Promise<void>;
}
