import type { CallStatus, WorkflowCallProgress, WorkflowLaunchOutput, WorkflowProgressSnapshot } from "../types.js";
import { RENDER_LIMITS } from "../constants.js";
import { padToWidth, sanitizeLine, sanitizeRenderedLine, truncateToWidth, visibleWidth } from "../utils/truncate.js";
import type { ComponentLike } from "./simple-components.js";

export interface WorkflowResultRenderOptions {
  partial?: boolean;
}

type ThemeLike = { fg?: (name: string, text: string) => string; bold?: (text: string) => string } | undefined;

/**
 * The sole workflow renderer. Its input is the execution record itself: phases,
 * dynamically-created agent calls, logs, and terminal artifacts. Workflow
 * scripts do not define a second UI model.
 */
export class WorkflowResultComponent implements ComponentLike {
  private cachedWidth?: number;
  private cachedRevision?: string;
  private cachedLines?: string[];

  constructor(private details: WorkflowLaunchOutput, private options: WorkflowResultRenderOptions = {}, private theme?: ThemeLike) {}

  update(details: WorkflowLaunchOutput, options: WorkflowResultRenderOptions = {}, theme?: ThemeLike): void {
    const changed = resultRevision(details) !== resultRevision(this.details) || options.partial !== this.options.partial || theme !== this.theme;
    this.details = details;
    this.options = options;
    this.theme = theme;
    if (changed) this.invalidate();
  }

  render(width: number): string[] {
    const revision = resultRevision(this.details);
    if (this.cachedLines && this.cachedWidth === width && this.cachedRevision === revision) return this.cachedLines;
    this.cachedLines = renderWorkflowResultLines(this.details, this.options, this.theme, width);
    this.cachedWidth = width;
    this.cachedRevision = revision;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRevision = undefined;
    this.cachedLines = undefined;
  }
}

export class WorkflowProgressComponent implements ComponentLike {
  private readonly component: WorkflowResultComponent;

  constructor(private readonly details: () => WorkflowLaunchOutput, private readonly theme?: ThemeLike) {
    this.component = new WorkflowResultComponent(details(), { partial: true }, theme);
  }

  render(width: number): string[] {
    this.component.update(this.details(), { partial: true }, this.theme);
    return this.component.render(width);
  }

  invalidate(): void {
    this.component.invalidate();
  }
}

export function renderWorkflowResultLines(details: WorkflowLaunchOutput, options: WorkflowResultRenderOptions = {}, theme?: ThemeLike, width = 100): string[] {
  const progress = details.progress;
  const lines: string[] = [];
  const title = fg(theme, "accent", bold(theme, sanitizeLine(details.title ?? details.name, 240)));
  const stats = resultStats(details, progress, theme);
  lines.push(fg(theme, "borderMuted", "─".repeat(Math.max(0, width))));
  lines.push(joinLeftRight(title, fg(theme, "dim", stats), width));

  const context = progress?.phase ? `phase: ${sanitizeLine(progress.phase, 160)}` : sanitizeLine(details.description ?? "Workflow run", 300);
  lines.push(joinLeftRight(fg(theme, progress?.phase ? "accent" : "muted", context), fg(theme, "dim", sanitizeLine(details.runId, 100)), width));
  const phases = phaseTrail(details, progress);
  if (phases) lines.push(fg(theme, "dim", truncateToWidth(phases, width)));

  if (progress) {
    const callLimit = options.partial ? RENDER_LIMITS.progressCalls : Math.max(1, RENDER_LIMITS.progressCalls - 2);
    const calls = visibleCalls(progress, callLimit);
    for (const call of calls) lines.push(renderCall(call, theme, width));
    for (const log of progress.recentLogs.slice(-RENDER_LIMITS.progressLogs)) {
      lines.push(fg(theme, "dim", truncateToWidth(`log: ${sanitizeRenderedLine(log, 500)}`, width)));
    }
  }

  if (!options.partial) {
    if (details.error) lines.push(fg(theme, "error", truncateToWidth(`error: ${sanitizeLine(details.error, 1000)}`, width)));
    else if (details.resultPreview) {
      for (const line of details.resultPreview.split("\n").slice(0, 3)) lines.push(fg(theme, "muted", truncateToWidth(`result: ${sanitizeRenderedLine(line, 1000)}`, width)));
    }
    if (details.outputPath) lines.push(fg(theme, "dim", truncateToWidth(`output: ${sanitizeLine(details.outputPath, 1000)}`, width)));
  }

  return clip(lines, width, RENDER_LIMITS.resultLines);
}

function visibleCalls(progress: WorkflowProgressSnapshot, limit: number): WorkflowCallProgress[] {
  const inPhase = progress.phase ? progress.calls.filter((call) => call.phase === progress.phase) : progress.calls;
  const source = inPhase.length > 0 ? inPhase : progress.calls;
  return source.slice(-limit);
}

function phaseTrail(details: WorkflowLaunchOutput, progress: WorkflowProgressSnapshot | undefined): string | undefined {
  const phases = details.phases?.filter((phase) => phase && typeof phase.title === "string" && phase.title.trim()).slice(0, 8);
  if (!phases || phases.length < 2) return undefined;
  const active = phases.findIndex((phase) => phase.title === progress?.phase);
  return phases.map((phase, index) => {
    const icon = index < active ? "✓" : index === active ? "▶" : "·";
    return `${icon} ${sanitizeLine(phase.title, 80)}`;
  }).join(" → ");
}

function renderCall(call: WorkflowCallProgress, theme: ThemeLike, width: number): string {
  const left = `${callIcon(call.status)} ${sanitizeLine(call.callId, 40)} ${sanitizeLine(call.label, 220)}`;
  const usage = call.usage;
  const meta = [
    call.model ? sanitizeLine(call.model, 80) : undefined,
    usage?.subagentTokens ? `${compactNumber(usage.subagentTokens)} tok` : undefined,
    usage?.toolUses ? `${usage.toolUses} tools` : undefined,
    callDuration(call),
    call.status === "done" ? undefined : call.status,
  ].filter(Boolean).join(" · ");
  return fg(theme, callColor(call.status), joinLeftRight(left, meta, width));
}

function resultStats(details: WorkflowLaunchOutput, progress: WorkflowProgressSnapshot | undefined, theme: ThemeLike): string {
  const finished = progress ? progress.completed + progress.failed + progress.skipped : 0;
  const agents = progress && progress.total > 0 ? `${finished}/${progress.total} agents` : undefined;
  const running = progress && progress.running > 0 ? `${progress.running} running` : undefined;
  const tokens = details.usage?.subagentTokens ? `${compactNumber(details.usage.subagentTokens)} tok` : undefined;
  return [statusWord(details.status, theme), agents, running, tokens, elapsed(details.startedAt, details.endedAt)].filter(Boolean).join(" · ");
}

function resultRevision(details: WorkflowLaunchOutput): string {
  const progress = details.progress;
  const tick = details.status === "async_launched" || (progress?.running ?? 0) > 0 ? Math.floor(Date.now() / 1000) : 0;
  return `${details.status}:${progress?.updatedAt ?? ""}:${progress?.calls.length ?? 0}:${tick}:${details.outputPath ?? ""}`;
}

function clip(lines: string[], width: number, maxLines: number): string[] {
  const visible = lines.length > maxLines ? [...lines.slice(0, maxLines - 1), `… ${lines.length - maxLines + 1} more line(s)`] : lines;
  return visible.map((line) => padToWidth(truncateToWidth(line, width), width));
}

function joinLeftRight(left: string, right: string | undefined, width: number): string {
  if (!right) return truncateToWidth(left, width);
  const clippedRight = truncateToWidth(right, Math.max(0, Math.min(visibleWidth(right), Math.floor(width * 0.48))));
  const leftWidth = Math.max(0, width - visibleWidth(clippedRight) - 1);
  const clippedLeft = truncateToWidth(left, leftWidth);
  return `${clippedLeft}${" ".repeat(Math.max(1, width - visibleWidth(clippedLeft) - visibleWidth(clippedRight)))}${clippedRight}`;
}

function statusWord(status: WorkflowLaunchOutput["status"], theme: ThemeLike): string {
  if (status === "completed") return fg(theme, "success", "completed");
  if (status === "failed") return fg(theme, "error", "failed");
  return fg(theme, "accent", "running");
}

function callIcon(status: CallStatus): string {
  if (status === "done") return "✓";
  if (status === "failed" || status === "aborted") return "✗";
  if (status === "running") return "▶";
  if (status === "skipped") return "↷";
  return "•";
}

function callColor(status: CallStatus): string {
  if (status === "done") return "success";
  if (status === "failed" || status === "aborted") return "error";
  if (status === "running") return "accent";
  return "muted";
}

function elapsed(startIso?: string, endIso?: string): string | undefined {
  if (!startIso) return undefined;
  const start = Date.parse(startIso);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return formatDuration(end - start);
}

function callDuration(call: WorkflowCallProgress): string | undefined {
  if (call.usage?.durationMs !== undefined) return formatDuration(call.usage.durationMs);
  return elapsed(call.startedAt, call.endedAt);
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
}

function compactNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function fg(theme: ThemeLike, name: string, text: string): string {
  return theme?.fg ? theme.fg(name, text) : text;
}

function bold(theme: ThemeLike, text: string): string {
  return theme?.bold ? theme.bold(text) : text;
}
