import type { JsonObject } from "../types.js";
import type { WorkflowRunProjection } from "../projection/types.js";
import { boundedWorkflowProjectionText } from "../projection/run-projection.js";
import { truncateToWidth } from "../utils/truncate.js";
import { StaticTextComponent, type ComponentLike } from "./simple-components.js";
import type { FlowToolResultDetails } from "./flow-protocol.js";

export type { FlowToolResultDetails } from "./flow-protocol.js";
export interface NamedWorkflowToolInput { name: string; args: JsonObject; mode?: "await" | "async"; }
export interface FlowToolRenderOptions { expanded?: boolean; isPartial?: boolean; isError?: boolean; }

export function renderNamedWorkflowCall(args: Partial<NamedWorkflowToolInput>, theme?: { fg?(color: string, text: string): string }): ComponentLike {
  const name = safe(args.name ?? "workflow", 192);
  return new StaticTextComponent(`${theme?.fg?.("toolTitle", "workflow") ?? "workflow"} ${name} · ${args.mode ?? "await"}`, { preserveAnsi: true });
}

export function renderNamedWorkflowResult(
  result: { details?: FlowToolResultDetails; content?: Array<{ type: string; text?: string }> },
  options: FlowToolRenderOptions = {},
  _theme?: unknown,
  _context?: unknown,
): ComponentLike {
  const projection = result.details?.projection;
  const lines = projection
    ? renderWorkflowToolText(projection, options, 120)
    : [safe(result.content?.find(entry => entry.type === "text")?.text ?? result.details?.error?.message ?? "workflow result unavailable", 2_048)];
  return new StaticTextComponent(lines.join("\n"));
}

export function renderWorkflowToolText(
  projection: WorkflowRunProjection,
  options: FlowToolRenderOptions = {},
  width = 100,
): readonly string[] {
  const lines = [
    `${projection.workflowId} (${projection.shortRunId}) · ${projection.status} · r${projection.revision}`,
    `${projection.operationCounts.completed ?? 0} completed · ${projection.operationCounts.running ?? 0} running · ${projection.operationCounts.failed ?? 0} failed`,
  ];
  if (projection.attention[0]) lines.push(`attention · ${safe(projection.attention[0].summary, 512)}`);
  if (options.expanded) {
    for (const operation of projection.operations.slice(-6)) {
      lines.push(`${glyph(operation.status)} ${safe(operation.path, 160)} · ${operation.kind} · ${operation.status}`);
    }
    lines.push(`/flow open ${projection.shortRunId}`);
  }
  return Object.freeze(lines.slice(0, 12).map(line => truncateToWidth(line, Math.max(1, width))));
}

function glyph(status: string): string { return status === "completed" ? "✓" : status === "failed" || status === "stopped" ? "×" : "·"; }
function safe(value: unknown, maximum = 512): string { return boundedWorkflowProjectionText(value, maximum); }
