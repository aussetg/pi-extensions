import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkflowTool } from "./tool/workflow-tool.js";
import { registerWorkflowCommand } from "./commands/workflow-command.js";
import { createWorkflowAutocomplete } from "./commands/workflow-autocomplete.js";
import { WorkflowRegistry } from "./persistence/registry.js";
import { RunStore } from "./persistence/run-store.js";
import { registryRefreshOptions } from "./persistence/trust.js";
import { WorkflowViewRenderer } from "./ui/workflow-view-renderer.js";
import { renderWorkflowResultMessage } from "./ui/messages.js";
import { createWorkflowActivation } from "./tool/workflow-activation.js";

export function createWorkflowExtension(pi: ExtensionAPI): void {
  const runStore = new RunStore();
  const registry = new WorkflowRegistry();
  const renderer = new WorkflowViewRenderer();
  const activation = createWorkflowActivation(pi);

  pi.registerTool(createWorkflowTool({ pi, runStore, registry }));
  registerWorkflowCommand(pi, { runStore, registry, renderer, activation });
  pi.registerMessageRenderer?.("workflow_result", renderWorkflowResultMessage as any);

  pi.on("tool_result", (event: any) => {
    if (event.toolName !== "workflow") return undefined;
    const status = event.details && typeof event.details === "object" ? (event.details as any).status : undefined;
    if (status === "failed") return { isError: true };
    return undefined;
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    await registry.refresh(ctx.cwd, registryRefreshOptions(ctx));
    activation.reset(ctx);
    const stale = await runStore.markStaleRunsForSession(ctx.cwd);
    ctx.ui?.addAutocompleteProvider?.(createWorkflowAutocomplete(registry, runStore));
    if (stale > 0) ctx.ui?.notify?.(`Marked ${stale} stale workflow run(s). Use /workflow resume <runId> to recover.`, "warning");
  });

  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    activation.enforce(ctx);
  });

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    await runStore.stopLiveRunsForSession(sessionIdFromContext(ctx), "session shutdown");
  });
}

function sessionIdFromContext(ctx: any): string | undefined {
  return ctx.sessionManager?.getSessionId?.() ?? ctx.sessionManager?.getHeader?.()?.id;
}
