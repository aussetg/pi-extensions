import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowDraftService } from "../drafts/service.js";
import type { WorkflowNamedClient, WorkflowRunSummary } from "../runtime/named-workflow-types.js";
import type { JsonObject, JsonValue } from "../types.js";
import {
  createFlowEnvelope,
  FLOW_PROTOCOL_MAX_BYTES,
  flowEnvelopeJson,
  type FlowChallengeProjection,
  type FlowProtocolEnvelope,
} from "../ui/flow-protocol.js";
import { boundedWorkflowProjectionText as sanitizeProjectionText } from "../projection/run-projection.js";
import { openWorkflowInspector } from "../ui/flow-inspector.js";
import {
  renderApplyApprovalConfirmation,
  renderDraftPromotionConfirmation,
  renderFlowCommandFeedback,
} from "../ui/flow-confirmations.js";
import { createFlowArgumentCompletions } from "./flow-autocomplete.js";
import { flowHelpText, parseFlowCommand, type FlowCommand } from "./flow-command-parser.js";

export interface FlowCommandDependencies {
  workflows: WorkflowNamedClient;
  drafts: WorkflowDraftService;
}

export function registerFlowCommand(pi: ExtensionAPI, dependencies: FlowCommandDependencies): void {
  pi.registerCommand("flow", {
    description: "Launch, inspect, control, replay, and promote durable named workflows",
    getArgumentCompletions: createFlowArgumentCompletions(dependencies.workflows.registry),
    handler: async (args, ctx) => {
      let envelope: FlowProtocolEnvelope;
      try {
        envelope = await routeFlowCommand(parseFlowCommand(args), dependencies, ctx);
      } catch (error) {
        const message = safeError(error);
        envelope = createFlowEnvelope({
          kind: "flow-error",
          ok: false,
          message,
          error: { name: error instanceof Error ? error.name.slice(0, 128) : "Error", message },
        });
      }
      emitFlowEnvelope(ctx, envelope);
    },
  });
}

export async function routeFlowCommand(
  command: FlowCommand,
  dependencies: FlowCommandDependencies,
  ctx: ExtensionCommandContext,
): Promise<FlowProtocolEnvelope> {
  const workflows = dependencies.workflows;
  workflows.bindContext(ctx);
  switch (command.action) {
    case "help":
      return envelope("flow-help", flowHelpText());
    case "list": {
      await workflows.refreshDefinitions(ctx);
      const definitions = workflows.registry.list()
        .filter((definition) => !command.namespace || definition.namespace === command.namespace)
        .map((definition) => ({
          id: definition.id,
          title: definition.title ?? definition.name,
          description: definition.description,
          namespace: definition.namespace,
          exposure: definition.exposure,
          capabilities: definition.parsed.review.capabilities,
        }));
      const invalidDefinitions = workflows.registry.listInvalid()
        .filter((definition) => !command.namespace || definition.namespace === command.namespace)
        .slice(0, 100);
      const runs = (await workflows.list(ctx))
        .filter((run) => !command.activeOnly || !terminal(run.status))
        .slice(0, 200);
      return envelope("flow-list", `${definitions.length} workflows · ${runs.length} runs`, {
        definitions,
        invalidDefinitions,
        runs,
      });
    }
    case "explain": {
      await workflows.refreshDefinitions(ctx);
      const definition = workflows.registry.resolve(command.name);
      return envelope("flow-explain", `${definition.id}: ${definition.description}`, {
        id: definition.id,
        title: definition.title ?? definition.name,
        description: definition.description,
        namespace: definition.namespace,
        exposure: definition.exposure,
        capabilities: definition.parsed.review.capabilities,
        inputSchema: definition.input,
        outputSchema: definition.output,
        concurrency: definition.concurrency ?? null,
        review: definition.parsed.review,
      });
    }
    case "run": {
      const result = await workflows.invoke(
        { name: command.name, args: command.args as JsonObject, mode: command.mode },
        authority(ctx),
        ctx,
      );
      return runEnvelope("flow-run", result.summary, await workflows.open(result.runId, ctx), result.result);
    }
    case "replay":
    case "fresh-run": {
      const result = await workflows.replay({
        sourceRunRef: command.sourceRunRef,
        ...(command.args ? { args: command.args as JsonObject } : {}),
        mode: command.mode,
        fresh: command.action === "fresh-run",
      }, authority(ctx), ctx);
      return runEnvelope(`flow-${command.action}`, result.summary, await workflows.open(result.runId, ctx), result.result);
    }
    case "status": {
      if (command.runRef) {
        const details = await workflows.open(command.runRef, ctx);
        return projectionEnvelope("flow-status", projectionMessage(details), details);
      }
      const runs = (await workflows.list(ctx)).slice(0, 200);
      return envelope("flow-status", `${runs.length} workflow runs`, runs);
    }
    case "open": {
      const details = await workflows.open(command.runRef, ctx);
      if (ctx.mode === "tui") await openWorkflowInspector(workflows, command.runRef, ctx);
      return projectionEnvelope("flow-open", projectionMessage(details), details);
    }
    case "pause":
    case "resume":
    case "stop": {
      const summary = await workflows[command.action](command.runRef, ctx);
      return projectionEnvelope(`flow-${command.action}`, `${command.action} request committed for ${summary.shortRunId}`, await workflows.open(summary.runId, ctx));
    }
    case "stop-effect": {
      const summary = await workflows.stopEffect(command.runRef, command.operationRef, ctx);
      return projectionEnvelope("flow-stop-effect", `Stop request committed for ${command.operationRef}`, await workflows.open(summary.runId, ctx));
    }
    case "respond":
      return await respond(command, workflows, ctx);
    case "approve":
    case "reject":
      return await decide(command, workflows, ctx);
    case "drafts": {
      if (command.draftId) {
        const draft = await dependencies.drafts.inspect(command.draftId, ctx);
        const { source: _source, ...summary } = draft;
        return envelope("flow-draft", `${draft.id} · ${draft.sourceHash}`, summary);
      }
      const drafts = await dependencies.drafts.list(ctx, command.namespace);
      return envelope("flow-drafts", `${drafts.length} workflow drafts`, drafts);
    }
    case "validate": {
      const review = await dependencies.drafts.validate(command.draftId, ctx);
      const { projectWorkflowDraftReview } = await import("../projection/approval-inspectors.js");
      const projection = projectWorkflowDraftReview(review);
      return createFlowEnvelope({
        kind: "flow-draft-validation",
        ok: review.valid,
        message: `${review.valid ? "Valid" : "Invalid"} draft ${review.draftId} · ${review.reviewHash}`,
        data: projection as unknown as JsonValue,
        ...(!review.valid ? { error: { name: "WorkflowDraftValidationError", message: "Draft validation failed" } } : {}),
      });
    }
    case "promote":
      return await promote(command, dependencies, ctx);
    case "discard-draft":
      await dependencies.drafts.discard(command.draftId, ctx, command.expectedHash);
      return envelope("flow-draft-discarded", `Discarded ${command.draftId}`);
    case "delete":
      return await deleteRun(command, workflows, ctx);
  }
}

async function respond(
  command: Extract<FlowCommand, { action: "respond" }>,
  workflows: WorkflowNamedClient,
  ctx: ExtensionCommandContext,
): Promise<FlowProtocolEnvelope> {
  const prepared = await workflows.humanChallenge(command.runRef, "ask", ctx);
  let value: JsonValue;
  if (ctx.mode === "tui") {
    const collected = await collectAskValue(prepared.request, ctx);
    if (!collected.committed) return envelope("flow-respond-cancelled", "Ask response cancelled", prepared.summary);
    value = collected.value;
  } else {
    if (!command.challenge) {
      return challengeEnvelope("flow-ask-challenge", "Ask response requires an exact second submission", {
        kind: "ask-response",
        runId: prepared.summary.runId,
        shortRunId: prepared.summary.shortRunId,
        revision: prepared.summary.revision,
        token: prepared.token,
        summary: String(prepared.request.prompt ?? "Workflow asks for input"),
        request: prepared.request,
      });
    }
    if (command.value === undefined) throw new Error("--value is required with --challenge");
    value = JSON.parse(command.value) as JsonValue;
  }
  const exactChallenge = ctx.mode === "tui" ? prepared.token : command.challenge!;
  const summary = await workflows.respond(command.runRef, command.interactionId, exactChallenge, value, ctx);
  return projectionEnvelope("flow-respond", `Ask response committed for ${summary.shortRunId}`, await workflows.open(summary.runId, ctx));
}

async function decide(
  command: Extract<FlowCommand, { action: "approve" | "reject" }>,
  workflows: WorkflowNamedClient,
  ctx: ExtensionCommandContext,
): Promise<FlowProtocolEnvelope> {
  const prepared = await workflows.humanChallenge(command.runRef, "apply", ctx);
  if (ctx.mode === "tui") {
    const projection = await workflows.open(command.runRef, ctx);
    const confirmed = await ctx.ui.confirm(
      command.action === "approve" ? "Approve this exact apply?" : "Reject this exact apply?",
      renderApplyApprovalConfirmation(projection, prepared.token, command.action).join("\n"),
    );
    if (!confirmed) return envelope(`flow-${command.action}-cancelled`, "Apply decision cancelled", prepared.summary);
  } else if (!command.challenge) {
    return challengeEnvelope(`flow-${command.action}-challenge`, `Apply ${command.action} requires an exact second submission`, {
      kind: command.action === "approve" ? "apply-approval" : "apply-rejection",
      runId: prepared.summary.runId,
      shortRunId: prepared.summary.shortRunId,
      revision: prepared.summary.revision,
      token: prepared.token,
      summary: `${command.action} exact apply ${prepared.interactionId}`,
      request: {
        interactionId: prepared.interactionId,
        operationId: prepared.operationId,
        request: prepared.request,
      },
    });
  }
  const challenge = command.challenge ?? prepared.token;
  const summary = await workflows.decideApproval(command.runRef, command.action, challenge, ctx);
  return projectionEnvelope(`flow-${command.action}`, `Apply ${command.action} committed for ${summary.shortRunId}`, await workflows.open(summary.runId, ctx));
}

async function promote(
  command: Extract<FlowCommand, { action: "promote" }>,
  dependencies: FlowCommandDependencies,
  ctx: ExtensionCommandContext,
): Promise<FlowProtocolEnvelope> {
  const prepared = await dependencies.drafts.promotionChallenge(command.draftId, command.exposure, ctx);
  const { projectWorkflowDraftPromotion } = await import("../projection/approval-inspectors.js");
  if (ctx.mode === "tui") {
    const projection = projectWorkflowDraftPromotion(prepared.review, prepared.challenge);
    const confirmed = await ctx.ui.confirm(
      "Promote this exact workflow draft?",
      renderDraftPromotionConfirmation(projection).join("\n"),
    );
    if (!confirmed) return envelope("flow-draft-promotion-cancelled", "Workflow draft promotion cancelled");
  } else if (!command.challenge) {
    return envelope(
      "flow-draft-promotion-challenge",
      "Draft promotion requires an exact second submission",
      projectWorkflowDraftPromotion(prepared.review, prepared.challenge),
    );
  }
  const promoted = await dependencies.drafts.promote(
    command.draftId,
    command.exposure,
    command.challenge ?? prepared.challenge.challengeHash,
    ctx,
  );
  await dependencies.workflows.refreshDefinitions(ctx);
  return envelope("flow-draft-promoted", `Promoted ${promoted.id} · ${promoted.sourceHash}`, promoted);
}

async function deleteRun(
  command: Extract<FlowCommand, { action: "delete" }>,
  workflows: WorkflowNamedClient,
  ctx: ExtensionCommandContext,
): Promise<FlowProtocolEnvelope> {
  const prepared = await workflows.deletionChallenge(command.runRef, ctx);
  if (ctx.mode === "tui") {
    const confirmed = await ctx.ui.confirm(
      "Delete this terminal workflow run?",
      `${prepared.summary.workflowId} · ${prepared.summary.runId}\nstatus ${prepared.summary.status}\nchallenge ${prepared.token}`,
    );
    if (!confirmed) return envelope("flow-delete-cancelled", "Run deletion cancelled", prepared.summary);
  } else if (!command.challenge) {
    return challengeEnvelope("flow-delete-challenge", "Run deletion requires an exact second submission", {
      kind: "run-deletion",
      runId: prepared.summary.runId,
      shortRunId: prepared.summary.shortRunId,
      revision: prepared.summary.revision,
      token: prepared.token,
      summary: `Permanently delete terminal ${prepared.summary.workflowId} evidence`,
    });
  }
  await workflows.deleteRun(command.runRef, command.challenge ?? prepared.token, ctx);
  return envelope("flow-delete", `Deleted workflow run ${prepared.summary.shortRunId}`);
}

export function emitFlowEnvelope(ctx: ExtensionCommandContext, value: FlowProtocolEnvelope): void {
  if (ctx.mode === "rpc") {
    ctx.ui.notify(flowEnvelopeJson(value), value.ok ? "info" : "error");
  } else if (ctx.mode === "json") {
    const line = JSON.stringify({ type: "flow", data: value });
    console.log(Buffer.byteLength(line) <= FLOW_PROTOCOL_MAX_BYTES ? line : flowEnvelopeJson(envelope("flow-error", "Flow output exceeded its bound")));
  } else if (ctx.mode === "print") {
    console.log(flowEnvelopeJson(value));
  } else {
    ctx.ui.notify(renderFlowCommandFeedback(value), value.ok ? "info" : "error");
  }
}

function envelope(kind: string, message: string, data?: unknown): FlowProtocolEnvelope {
  return createFlowEnvelope({ kind, ok: true, message, ...(data !== undefined ? { data: data as JsonValue } : {}) });
}

function projectionEnvelope(
  kind: string,
  message: string,
  projection: import("../projection/types.js").WorkflowRunProjection,
): FlowProtocolEnvelope {
  return createFlowEnvelope({ kind, ok: true, message, projection });
}

function challengeEnvelope(kind: string, message: string, challenge: FlowChallengeProjection): FlowProtocolEnvelope {
  return createFlowEnvelope({ kind, ok: true, message, challenge });
}

function runEnvelope(
  kind: string,
  summary: WorkflowRunSummary,
  projection: import("../projection/types.js").WorkflowRunProjection,
  result?: JsonValue,
): FlowProtocolEnvelope {
  return createFlowEnvelope({ kind, ok: true, message: summaryMessage(summary), projection, data: {
    summary,
    ...(result !== undefined ? { result } : {}),
  } as unknown as JsonValue });
}

function summaryMessage(summary: WorkflowRunSummary): string {
  return `${summary.workflowId} (${summary.shortRunId}) is ${summary.status} at revision ${summary.revision}`;
}

function projectionMessage(projection: import("../projection/types.js").WorkflowRunProjection): string {
  return `${projection.workflowId} (${projection.shortRunId}) is ${projection.status} at revision ${projection.revision}`;
}

function authority(ctx: ExtensionCommandContext): "user" | "rpc" { return ctx.mode === "rpc" ? "rpc" : "user"; }
function terminal(status: string): boolean { return status === "completed" || status === "failed" || status === "stopped" || status === "corrupt"; }

async function collectAskValue(
  request: JsonObject,
  ctx: ExtensionCommandContext,
): Promise<{ committed: false } | { committed: true; value: JsonValue }> {
  const edited = await ctx.ui.editor(String(request.prompt ?? "Workflow asks for input"), "null");
  if (edited === undefined) return { committed: false };
  return { committed: true, value: JSON.parse(edited) as JsonValue };
}

function safeError(error: unknown): string {
  return sanitizeProjectionText(error instanceof Error ? error.message : String(error), 2_048);
}
