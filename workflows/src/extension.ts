import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerExecutePlanCommand } from "./commands/execute-plan-command.js";
import { registerFlowCommand } from "./commands/flow-command.js";
import { registerGoalCommand } from "./commands/goal-command.js";
import { WorkflowDraftService } from "./drafts/service.js";
import { MeasurementProfileRegistry } from "./measurements/profiles.js";
import { projectRoot } from "./persistence/paths.js";
import { WorkflowRegistry } from "./registry/structured-workflows.js";
import { WorkflowCoordinatorService } from "./runtime/coordinator-service.js";
import { WorkflowNamedService } from "./runtime/named-workflow-service.js";
import { registerWorkflowNamedTool } from "./tool/named-workflow.js";
import { registerWorkflowDraftTool } from "./tool/workflow-draft.js";
import { FlowUiController } from "./ui/flow-ui-controller.js";
import { registerWorkflowCompletionRenderers } from "./ui/workflow-completion-renderer.js";

const MODEL_BUILTINS = ["coding", "execute-plan", "goal", "optimize", "package-audit", "research"] as const;

/** Thin primary-session registration and client wiring. Run ownership stays in systemd. */
export async function createWorkflowExtension(pi: ExtensionAPI): Promise<void> {
  const registry = new WorkflowRegistry();
  await registry.refresh(process.cwd(), { includeProject: false });
  assertDefinitionGate(registry);

  const ui = new FlowUiController();
  const launcher = new WorkflowCoordinatorService();
  const workflows = new WorkflowNamedService(pi, { registry, coordinator: launcher });
  const drafts = new WorkflowDraftService(pi, {
    executorDescriptor: workflows.agentExecutorDescriptor,
  });
  workflows.subscribeProjection((projection) => ui.updateRunCandidate(projection.runId, projection));

  registerWorkflowDraftTool(pi, drafts);
  registerFlowCommand(pi, { workflows, drafts });
  registerGoalCommand(pi, workflows);
  registerExecutePlanCommand(pi, workflows);
  registerWorkflowCompletionRenderers(pi);

  let namedToolRegistered = false;
  pi.on("session_start", async (_event, ctx) => {
    workflows.bindContext(ctx);
    ui.bind(ctx, { sessionId: sessionId(ctx), projectId: projectRoot(ctx.cwd) });
    await workflows.refreshDefinitions(ctx);
    assertDefinitionGate(registry);
    if (!namedToolRegistered) {
      const measurements = new MeasurementProfileRegistry();
      await measurements.refresh(ctx.cwd, { includeProject: ctx.isProjectTrusted() });
      registerWorkflowNamedTool(pi, workflows, {
        definitions: registry.list(),
        measurementProfiles: measurements.list(),
      });
      namedToolRegistered = true;
    }
    const active = pi.getActiveTools();
    const required = ["workflow", "workflow_draft"];
    if (required.some((tool) => !active.includes(tool))) {
      pi.setActiveTools([...new Set([...active, ...required])]);
    }
    await workflows.restoreAsyncNotifications(ctx);
  });

  pi.on("session_info_changed", async (_event, ctx) => {
    workflows.bindContext(ctx);
    ui.bind(ctx, { sessionId: sessionId(ctx), projectId: projectRoot(ctx.cwd) });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // This drops only local polling/rendering state. It never stops a unit.
    workflows.detachContext();
    ui.clear(ctx);
  });
}

export function assertDefinitionGate(registry: WorkflowRegistry): void {
  const builtins = registry.list().filter((ref) => ref.namespace === "builtin");
  const visible = builtins.filter((ref) => ref.exposure === "model").map((ref) => ref.name).sort();
  if (visible.length !== MODEL_BUILTINS.length || visible.some((name, index) => name !== MODEL_BUILTINS[index])) {
    const invalid = registry.listInvalid().filter(entry => entry.namespace === "builtin");
    throw new Error(
      `Named workflow gate failed: expected model-visible built-ins ${MODEL_BUILTINS.join(", ")}; `
      + `found ${visible.join(", ") || "none"}`
      + (invalid.length ? `; ${invalid.map(entry => entry.error).join("; ")}` : ""),
    );
  }
  const invalid = registry.listInvalid().find((entry) => entry.namespace === "builtin");
  if (invalid) throw new Error(`Named workflow gate failed: ${invalid.error}`);
}

function sessionId(ctx: ExtensionContext): string | undefined {
  return ctx.sessionManager.getSessionId() ?? ctx.sessionManager.getHeader()?.id;
}
