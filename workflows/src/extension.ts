import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerExecutePlanCommand } from "./commands/execute-plan-command.js";
import { registerFlowCommand } from "./commands/flow-command.js";
import { registerGoalCommand } from "./commands/goal-command.js";
import { WorkflowDraftService } from "./drafts/service.js";
import { projectRoot } from "./persistence/paths.js";
import { StructuredWorkflowRegistry } from "./registry/structured-workflows.js";
import { CoordinatorService } from "./runtime/coordinator-service.js";
import { NamedWorkflowService } from "./runtime/named-workflow-service.js";
import { registerNamedWorkflowTool } from "./tool/named-workflow-tool.js";
import { registerWorkflowDraftTool } from "./tool/workflow-draft-tool.js";
import { FlowUiController } from "./ui/flow-ui-controller.js";
import { registerWorkflowCompletionRenderers } from "./ui/workflow-completion-renderer.js";

const MODEL_BUILTINS = ["coding", "execute-plan", "goal", "optimize", "package-audit", "research"] as const;

/** Thin primary-session registration and client wiring. Run ownership stays in systemd. */
export async function createWorkflowExtension(pi: ExtensionAPI): Promise<void> {
  const registry = new StructuredWorkflowRegistry();
  await registry.refresh(process.cwd(), { includeProject: false });
  assertDefinitionGate(registry);

  const ui = new FlowUiController();
  const launcher = new CoordinatorService();
  const workflows = new NamedWorkflowService(pi, { registry, coordinator: launcher });
  const drafts = new WorkflowDraftService(pi, {
    executorDescriptor: workflows.agentExecutorDescriptor,
  });
  workflows.subscribeProjection((projection) => ui.updateRunCandidate(projection.runId, projection));

  registerNamedWorkflowTool(pi, workflows);
  registerWorkflowDraftTool(pi, drafts);
  registerFlowCommand(pi, { workflows, drafts });
  registerGoalCommand(pi, workflows);
  registerExecutePlanCommand(pi, workflows);
  registerWorkflowCompletionRenderers(pi);

  pi.on("session_start", async (_event, ctx) => {
    workflows.bindContext(ctx);
    ui.bind(ctx, { sessionId: sessionId(ctx), projectId: projectRoot(ctx.cwd) });
    await workflows.refreshDefinitions(ctx);
    assertDefinitionGate(registry);
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

export function assertDefinitionGate(registry: StructuredWorkflowRegistry): void {
  const builtins = registry.list().filter((ref) => ref.namespace === "builtin");
  const visible = builtins.filter((ref) => ref.modelVisible).map((ref) => ref.name).sort();
  if (visible.length !== MODEL_BUILTINS.length || visible.some((name, index) => name !== MODEL_BUILTINS[index])) {
    throw new Error(`Named workflow gate failed: expected model-visible built-ins ${MODEL_BUILTINS.join(", ")}`);
  }
  const invalid = registry.listInvalid().find((entry) => entry.namespace === "builtin");
  if (invalid) throw new Error(`Named workflow gate failed: ${invalid.error}`);
}

function sessionId(ctx: ExtensionContext): string | undefined {
  return ctx.sessionManager.getSessionId() ?? ctx.sessionManager.getHeader()?.id;
}
