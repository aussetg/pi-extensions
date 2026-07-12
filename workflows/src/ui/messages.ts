import type { WorkflowLaunchOutput } from "../types.js";
import { StaticTextComponent, type ComponentLike } from "./simple-components.js";
import { WorkflowResultComponent } from "./workflow-result-component.js";

export function renderWorkflowResultMessage(message: { content?: unknown; details?: unknown }, _options?: unknown, theme?: any): ComponentLike {
  const details = message.details as WorkflowLaunchOutput | undefined;
  if (!details) return new StaticTextComponent(String(message.content ?? "Workflow result"));
  const options = (_options && typeof _options === "object" ? _options : {}) as { expanded?: boolean };
  return new WorkflowResultComponent(details, { message: true, profile: options.expanded ? "full" : "panel" }, theme);
}
