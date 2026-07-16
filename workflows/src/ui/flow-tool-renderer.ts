import type { JsonObject } from "../types.js";
import type { WorkflowRunProjection } from "../projection/types.js";
import { boundedProjectionText } from "../projection/run-projection.js";
import { truncateToWidth } from "../utils/truncate.js";
import { StaticTextComponent, type ComponentLike } from "./simple-components.js";
import { renderFlowWidgetLines, type FlowThemeLike } from "./flow-widget.js";
import type { FlowToolResultDetails } from "./flow-protocol.js";

export type { FlowToolResultDetails } from "./flow-protocol.js";

export interface NamedWorkflowToolInput { name: string; args: JsonObject; mode?: "await" | "async"; }
export interface FlowToolRenderOptions { expanded?: boolean; isPartial?: boolean; isError?: boolean; }

/** Reused by Pi for streaming updates; visible fingerprints suppress churn. */
export class AwaitedFlowToolComponent implements ComponentLike {
  private cached?: { width: number; key: string; lines: string[] };
  constructor(private details: FlowToolResultDetails, private options: FlowToolRenderOptions, private theme?: FlowThemeLike) {}

  update(details: FlowToolResultDetails, options: FlowToolRenderOptions, theme?: FlowThemeLike): void {
    if (toolKey(details, options) !== toolKey(this.details, this.options) || theme !== this.theme) this.invalidate();
    this.details = details;
    this.options = options;
    this.theme = theme;
  }
  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.trunc(width));
    const key = toolKey(this.details, this.options);
    if (this.cached?.width === safeWidth && this.cached.key === key) return this.cached.lines;
    const lines = renderAwaitedFlowToolLines(this.details, this.options, this.theme, safeWidth);
    this.cached = { width: safeWidth, key, lines };
    return lines;
  }
  invalidate(): void { this.cached = undefined; }
}

export function renderNamedWorkflowCall(args: Partial<NamedWorkflowToolInput>, theme?: FlowThemeLike): ComponentLike {
  const name = safe(args.name ?? "workflow", 192);
  const objective = objectivePreview(args.args);
  return new StaticTextComponent(
    `${fg(theme, "toolTitle", "workflow")} ${fg(theme, "accent", name)} · ${fg(theme, "dim", `${args.mode ?? "await"}${objective ? ` · ${objective}` : ""}`)}`,
    { preserveAnsi: true },
  );
}

export function renderNamedWorkflowResult(
  result: { details?: FlowToolResultDetails; content?: Array<{ type: string; text?: string }> },
  options: FlowToolRenderOptions = {},
  theme?: FlowThemeLike,
  context?: { lastComponent?: unknown },
): ComponentLike {
  if (!result.details?.projection) {
    const fallback = result.content?.find((entry) => entry.type === "text")?.text ?? result.details?.error?.message ?? "workflow result unavailable";
    return new StaticTextComponent(safe(fallback, 2_048));
  }
  if (context?.lastComponent instanceof AwaitedFlowToolComponent) {
    context.lastComponent.update(result.details, options, theme);
    return context.lastComponent;
  }
  return new AwaitedFlowToolComponent(result.details, options, theme);
}

export function renderAwaitedFlowToolLines(
  details: FlowToolResultDetails,
  options: FlowToolRenderOptions,
  theme: FlowThemeLike | undefined,
  width: number,
): string[] {
  if (width <= 0) return [];
  const projection = details.projection;
  if (!projection) return [truncateToWidth(safe(details.error?.message ?? "workflow projection unavailable"), width)];
  if (options.isPartial) return renderFlowWidgetLines(projection, theme, width).slice(0, width < 72 ? 3 : 5);

  const lines = renderFlowWidgetLines(projection, theme, width).slice(0, 2);
  if (options.expanded) {
    for (const operation of projection.recentOperations.slice(-6)) {
      lines.push(`${operationStatusGlyph(operation.status)} ${safe(shortPath(operation.path), 160)} · ${operation.kind} · ${operation.status}`);
    }
    if (details.resultPreview) lines.push(`result · ${safe(details.resultPreview, 1_024)}`);
    lines.push(fg(theme, "dim", `/flow open ${projection.shortRunId}`));
  }
  return lines.slice(0, 12).map((line) => truncateToWidth(line, width));
}

/** Plain transport adapter; never embeds ANSI or component state. */
export function renderWorkflowToolText(
  projection: WorkflowRunProjection,
  options: FlowToolRenderOptions = {},
  width = 100,
): readonly string[] {
  return Object.freeze(renderAwaitedFlowToolLines({ formatVersion: 1, projection: structuredClone(projection) }, options, undefined, width));
}

function toolKey(details: FlowToolResultDetails, options: FlowToolRenderOptions): string {
  const p = details.projection;
  const agent = p?.activeAgents[0];
  return JSON.stringify({ run: p?.runId, status: p?.status, current: p?.currentOperationId,
    attention: p?.attentionReasons[0], progress: agent?.progress, tool: agent?.currentTool,
    metrics: agent?.customMetrics, resources: agent?.resources, strikes: agent?.receiptlessStrikes,
    apply: p?.apply, replay: p?.replay, result: details.resultPreview,
    partial: Boolean(options.isPartial), expanded: Boolean(options.expanded), error: Boolean(options.isError) });
}
function objectivePreview(args: JsonObject | undefined): string | undefined {
  if (!args) return undefined;
  for (const name of ["objective", "question", "task"]) {
    const value = args[name];
    if (typeof value === "string" && value.trim()) return safe(value, 120);
  }
  return undefined;
}
function operationStatusGlyph(status: string): string { return status === "completed" ? "✓" : status === "failed" || status === "stopped" ? "×" : "·"; }
function shortPath(value: string): string { return value.split("/").slice(-3).join(" › "); }
function safe(value: unknown, maximum = 512): string { return boundedProjectionText(value, maximum); }
function fg(theme: FlowThemeLike | undefined, color: string, text: string): string { return theme?.fg ? theme.fg(color, text) : text; }
