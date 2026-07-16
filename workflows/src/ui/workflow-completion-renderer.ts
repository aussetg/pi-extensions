import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StaticTextComponent } from "./simple-components.js";

/** Completion messages are bounded context; entries are the matching TUI-only event. */
export function registerWorkflowCompletionRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("workflow-completion", (message, _options, theme) => (
    new StaticTextComponent(
      theme.fg("success", bounded(typeof message.content === "string" ? message.content : "Workflow completed", 2_048)),
      { preserveAnsi: true },
    )
  ));
  pi.registerEntryRenderer("workflow-completion", (entry, _options, theme) => {
    const data = entry.data as { shortRunId?: unknown; workflowId?: unknown; status?: unknown } | undefined;
    const workflowId = typeof data?.workflowId === "string" ? data.workflowId : "workflow";
    const shortRunId = typeof data?.shortRunId === "string" ? data.shortRunId : "unknown";
    const status = typeof data?.status === "string" ? data.status : "settled";
    return new StaticTextComponent(
      theme.fg("dim", bounded(`${workflowId} (${shortRunId}) · ${status}`, 512)),
      { preserveAnsi: true },
    );
  });
}

function bounded(value: string, maximum: number): string {
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, maximum).join("");
}
