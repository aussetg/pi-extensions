import { StaticTextComponent, type ComponentLike } from "../ui/simple-components.js";
import type { WorkflowLaunchOutput } from "../types.js";
import { WorkflowResultComponent, type WorkflowResultRenderProfile } from "../ui/workflow-result-component.js";
import { sanitizeText } from "../utils/truncate.js";

export function renderWorkflowCall(args: Record<string, unknown>, theme?: any): StaticTextComponent {
  const fg = (name: string, text: string) => (theme?.fg ? theme.fg(name, text) : text);
  const name = sanitizeText(String(args.name ?? args.scriptPath ?? "inline"), 300);
  const mode = sanitizeText(String(args.mode ?? "auto"), 40);
  return new StaticTextComponent(`${fg("toolTitle", "workflow")} ${fg("accent", name)} · ${mode}`, { preserveAnsi: true });
}

export function renderWorkflowResult(result: { details?: WorkflowLaunchOutput | any; content?: Array<{ type: string; text?: string }> }, options?: { expanded?: boolean; isPartial?: boolean }, theme?: any): ComponentLike {
  const details = result.details as WorkflowLaunchOutput | undefined;
  if (!details) return new StaticTextComponent(result.content?.find((c) => c.type === "text")?.text ?? "workflow");
  return new WorkflowResultComponent(details, { partial: options?.isPartial, profile: toolResultProfile(options) }, theme);
}

function toolResultProfile(options?: { expanded?: boolean; isPartial?: boolean }): WorkflowResultRenderProfile {
  if (options?.isPartial) return "panel";
  return options?.expanded ? "full" : "panel";
}
