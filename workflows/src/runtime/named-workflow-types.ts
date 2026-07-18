import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowInspectorPage, WorkflowInspectorPageKind, WorkflowRunProjection } from "../projection/types.js";
import type { WorkflowRegistry } from "../registry/structured-workflows.js";
import type { JsonObject, JsonValue } from "../types.js";

export interface WorkflowRunSummary {
  runId: string;
  shortRunId: string;
  workflowId: string;
  workflowName: string;
  status: "queued" | "running" | "waiting" | "paused" | "completed" | "failed" | "stopped" | "corrupt";
  revision: number;
  reason?: JsonObject;
  currentOperationId?: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface WorkflowNamedResult {
  runId: string;
  status: Exclude<WorkflowRunSummary["status"], "corrupt">;
  summary: WorkflowRunSummary;
  result?: JsonValue;
  handoff: boolean;
}

export interface WorkflowHumanChallenge {
  summary: WorkflowRunSummary;
  interactionId: string;
  operationId: string;
  kind: "ask" | "apply";
  token: string;
  request: JsonObject;
}

export interface WorkflowDeletionChallenge {
  summary: WorkflowRunSummary;
  token: string;
}

export interface WorkflowNamedClient {
  readonly registry: WorkflowRegistry;
  bindContext(ctx: ExtensionContext): void;
  detachContext(): void;
  refreshDefinitions(ctx: ExtensionContext): Promise<void>;
  restoreAsyncNotifications(ctx: ExtensionContext): Promise<void>;
  invoke(input: { name: string; args: JsonObject; mode: "await" | "async" }, authority: "model" | "user" | "rpc", ctx: ExtensionContext,
    options?: { onUpdate?: (summary: WorkflowRunSummary) => void | Promise<void> }): Promise<WorkflowNamedResult>;
  replay(input: { sourceRunRef: string; args?: JsonObject; mode: "await" | "async"; fresh: boolean }, authority: "model" | "user" | "rpc", ctx: ExtensionContext): Promise<WorkflowNamedResult>;
  list(ctx: ExtensionContext): Promise<WorkflowRunSummary[]>;
  open(runRef: string, ctx: ExtensionContext): Promise<WorkflowRunProjection>;
  inspectPage(runRef: string, kind: WorkflowInspectorPageKind, options: { cursor?: string; limit?: number }, ctx: ExtensionContext): Promise<WorkflowInspectorPage>;
  pause(runRef: string, ctx: ExtensionContext): Promise<WorkflowRunSummary>;
  resume(runRef: string, ctx: ExtensionContext): Promise<WorkflowRunSummary>;
  stop(runRef: string, ctx: ExtensionContext): Promise<WorkflowRunSummary>;
  stopEffect(runRef: string, operationRef: string, ctx: ExtensionContext): Promise<WorkflowRunSummary>;
  humanChallenge(runRef: string, kind: "ask" | "apply", ctx: ExtensionContext): Promise<WorkflowHumanChallenge>;
  respond(runRef: string, interactionId: string | undefined, challenge: string, value: JsonValue, ctx: ExtensionContext): Promise<WorkflowRunSummary>;
  decideApproval(runRef: string, decision: "approve" | "reject", challenge: string, ctx: ExtensionContext): Promise<WorkflowRunSummary>;
  deletionChallenge(runRef: string, ctx: ExtensionContext): Promise<WorkflowDeletionChallenge>;
  deleteRun(runRef: string, challenge: string, ctx: ExtensionContext): Promise<void>;
}
