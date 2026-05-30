import type { CallStatus, WorkflowCallProgress, WorkflowLaunchOutput, WorkflowMeta, WorkflowProgressSnapshot, WorkflowViewSnapshot } from "../types.js";
import { RENDER_LIMITS, UI_LIMITS } from "../constants.js";
import { padToWidth, sanitizeText, truncateToWidth, visibleWidth } from "../utils/truncate.js";
import type { ComponentLike } from "./simple-components.js";
import { WorkflowViewRenderer } from "./workflow-view-renderer.js";

export interface WorkflowResultRenderOptions {
  partial?: boolean;
  message?: boolean;
  profile?: WorkflowResultRenderProfile;
}

export type WorkflowResultRenderProfile = "compact" | "panel" | "full";

type ThemeLike = { fg?: (name: string, text: string) => string; bold?: (text: string) => string } | undefined;

const WIDE_PROGRESS_PANEL_MIN_WIDTH = 84;

interface ProgressPanelsOptions {
  maxPhaseRows?: number;
  maxAgentRows?: number;
  maxLogRows?: number;
}

export class WorkflowResultComponent implements ComponentLike {
  private readonly renderer = new WorkflowViewRenderer();
  private cachedWidth?: number;
  private cachedLines?: string[];
  private minHeight = 0;

  constructor(private details: WorkflowLaunchOutput, private options: WorkflowResultRenderOptions = {}, private theme?: ThemeLike) {}

  update(details: WorkflowLaunchOutput, options: WorkflowResultRenderOptions = {}, theme?: ThemeLike): void {
    this.details = details;
    this.options = options;
    this.theme = theme;
    this.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const lines = renderWorkflowResultLines(this.details, this.options, this.theme, width, this.renderer);
    this.minHeight = Math.max(this.minHeight, lines.length);
    while (lines.length < this.minHeight) lines.push(padToWidth("", width));
    this.cachedLines = lines;
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

export class WorkflowProgressComponent implements ComponentLike {
  private cachedWidth?: number;
  private cachedRevision?: string;
  private cachedLines?: string[];

  constructor(private readonly details: () => WorkflowLaunchOutput, private readonly theme?: ThemeLike) {}

  render(width: number): string[] {
    const details = this.details();
    const progress = details.progress;
    const clockTick = progress && hasLiveProgress(details, progress) ? Math.floor(Date.now() / 1000) : 0;
    const revision = `${details.status}:${progress?.updatedAt ?? ""}:${progress?.calls.length ?? 0}:${progress?.running ?? 0}:${clockTick}`;
    if (this.cachedLines && this.cachedWidth === width && this.cachedRevision === revision) return this.cachedLines;
    const lines = renderWorkflowResultLines(details, { partial: true, profile: "panel" }, this.theme, width);
    this.cachedLines = lines;
    this.cachedWidth = width;
    this.cachedRevision = revision;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRevision = undefined;
    this.cachedLines = undefined;
  }
}

export function renderWorkflowResultLines(details: WorkflowLaunchOutput, options: WorkflowResultRenderOptions = {}, theme?: ThemeLike, width = 100, renderer = new WorkflowViewRenderer()): string[] {
  const profile = options.profile ?? "full";
  const progress = details.progress ?? ((details as any).progress as WorkflowProgressSnapshot | undefined);
  const uiViews = details.uiViews ?? [];
  const maxLines = profile === "panel" ? panelResultLineLimit(details, progress, uiViews, renderer, width) : undefined;

  if (profile === "compact") return finalizeResultLines(renderCompactResult(details, progress, theme, width), width, profile, maxLines);
  if (profile === "panel") return finalizeResultLines(renderPanelResult(details, progress, uiViews, renderer, options, theme, width), width, profile, maxLines);

  return finalizeResultLines(renderFullResult(details, progress, uiViews, renderer, options, theme, width), width, profile, maxLines);
}

function renderFullResult(details: WorkflowLaunchOutput, progress: WorkflowProgressSnapshot | undefined, uiViews: WorkflowViewSnapshot[], renderer: WorkflowViewRenderer, options: WorkflowResultRenderOptions, theme: ThemeLike, width: number): string[] {
  const lines = progress && uiViews.length === 0 ? renderDashboard(details, progress, theme, width) : renderHeader(details, theme, width);

  if (uiViews.length > 0) withViewSections(lines, uiViews, renderer, width, "full");

  if (!options.partial) {
    if (details.resultPreview && uiViews.length === 0) lines.push("", ...frameBlock("Result", limitedLines(details.resultPreview, options.message ? 12 : 16), width, theme));
    if (details.error) lines.push("", ...frameBlock("Error", limitedLines(details.error, 12), width, theme, "error"));
    if (uiViews.length > 0) lines.push("", fg(theme, "dim", truncateToWidth(renderArtifactHint(details), width)));
    else lines.push("", ...frameBlock("Artifacts", renderArtifactLines(details, options), width, theme, "borderMuted"));
  }
  return lines;
}

function renderPanelResult(details: WorkflowLaunchOutput, progress: WorkflowProgressSnapshot | undefined, uiViews: WorkflowViewSnapshot[], renderer: WorkflowViewRenderer, options: WorkflowResultRenderOptions, theme: ThemeLike, width: number): string[] {
  if (uiViews.length > 0) {
    const lines = options.partial && progress && hasAgentProgress(progress) ? renderPanelDashboard(details, progress, theme, width, { maxPhaseRows: 5, maxAgentRows: 5, maxLogRows: 0 }) : [];
    withViewSections(lines, uiViews, renderer, width, "panel");
    if (!options.partial && details.status === "failed" && details.error) lines.push(fg(theme, "error", truncateToWidth(`error: ${sanitizeText(details.error, 1000).replace(/\n+/g, " ↵ ")}`, width)));
    return lines;
  }

  const lines = progress ? renderPanelDashboard(details, progress, theme, width) : renderHeader(details, theme, width);
  if (!options.partial) {
    if (details.error) lines.push(fg(theme, "error", truncateToWidth(`error: ${sanitizeText(details.error, 1000).replace(/\n+/g, " ↵ ")}`, width)));
    if (details.outputPath) lines.push(fg(theme, "dim", truncateToWidth(`output: ${sanitizeText(details.outputPath, 1000)}`, width)));
  }
  withViewSections(lines, uiViews, renderer, width, "panel");
  return lines;
}

function renderCompactResult(details: WorkflowLaunchOutput, progress: WorkflowProgressSnapshot | undefined, theme: ThemeLike, width: number): string[] {
  const title = fg(theme, "accent", bold(theme, sanitizeText(details.title ?? details.name, 200)));
  const stats = compactResultStats(details, progress, theme, { terminalStatus: false });
  const icon = workflowStatusIcon(details.status);
  const left = icon ? `${icon} ${title}` : title;
  const lines = [joinLeftRight(left, fg(theme, "dim", stats), width)];
  const secondary = compactResultSecondary(details, progress, width);
  if (secondary) lines.push(fg(theme, "dim", secondary));
  return lines;
}

function renderDashboard(details: WorkflowLaunchOutput, progress: WorkflowProgressSnapshot, theme: ThemeLike, width: number): string[] {
  const title = fg(theme, "accent", bold(theme, sanitizeText(details.title ?? details.name, 300)));
  const status = statusWord(details.status, theme);
  const duration = elapsed(details.startedAt, details.endedAt);
  const tokenText = details.usage?.subagentTokens ? `${compactNumber(details.usage.subagentTokens)} tok` : undefined;
  const agentText = hasAgentProgress(progress) ? `${progress.completed}/${progress.total} agents` : undefined;
  const stats = [status, agentText, progress.running > 0 ? `${progress.running} running` : undefined, tokenText, duration].filter(Boolean).join(" · ");
  const desc = fg(theme, "muted", sanitizeText(details.description ?? "Workflow run", 1000));

  const lines = [
    fg(theme, "borderMuted", "─".repeat(Math.max(0, width))),
    joinLeftRight(title, fg(theme, "dim", stats), width),
    joinLeftRight(desc, fg(theme, "dim", details.runId), width),
  ];
  if (hasProgressPanel(details, progress)) lines.push("", ...renderProgressPanels(details, progress, theme, width));
  else {
    if (progress.phase) lines.push(fg(theme, "accent", truncateToWidth(`phase: ${sanitizeText(progress.phase, 160)}`, width)));
    for (const log of progress.recentLogs.slice(-RENDER_LIMITS.progressLogs)) lines.push(fg(theme, "dim", truncateToWidth(`log: ${sanitizeText(log, 500)}`, width)));
  }
  return lines;
}

function renderPanelDashboard(details: WorkflowLaunchOutput, progress: WorkflowProgressSnapshot, theme: ThemeLike, width: number, progressPanelOptions: ProgressPanelsOptions = { maxPhaseRows: 8, maxAgentRows: 8, maxLogRows: 0 }): string[] {
  const title = fg(theme, "accent", bold(theme, sanitizeText(details.title ?? details.name, 240)));
  const stats = compactResultStats(details, progress, theme);
  const desc = fg(theme, "muted", sanitizeText(details.description ?? "Workflow run", 500));
  const lines = [
    fg(theme, "borderMuted", "─".repeat(Math.max(0, width))),
    joinLeftRight(title, fg(theme, "dim", stats), width),
    joinLeftRight(desc, fg(theme, "dim", details.runId), width),
  ];
  if (hasProgressPanel(details, progress)) {
    if (width >= WIDE_PROGRESS_PANEL_MIN_WIDTH) {
      lines.push("", ...renderProgressPanels(details, progress, theme, width, progressPanelOptions));
    } else {
      if (hasAgentProgress(progress)) lines.push(renderProgressLine(progress, theme, width));
      if (progress.phase) lines.push(fg(theme, "accent", truncateToWidth(`phase: ${sanitizeText(progress.phase, 160)}`, width)));
      const calls = callsForActivePhase(progress).slice(-3);
      for (const call of calls) lines.push(renderCompactCallRow(call, theme, width));
    }
  } else if (progress.phase) {
    lines.push(fg(theme, "accent", truncateToWidth(`phase: ${sanitizeText(progress.phase, 160)}`, width)));
  }
  const log = progress.recentLogs.at(-1);
  if (log && (!hasAgentProgress(progress) || width < WIDE_PROGRESS_PANEL_MIN_WIDTH)) lines.push(fg(theme, "dim", truncateToWidth(`log: ${sanitizeText(log, 500)}`, width)));
  return lines;
}

function renderHeader(details: WorkflowLaunchOutput, theme: ThemeLike, width: number): string[] {
  const title = fg(theme, "accent", bold(theme, sanitizeText(details.title ?? details.name, 300)));
  const stats = [statusWord(details.status, theme), elapsed(details.startedAt, details.endedAt)].filter(Boolean).join(" · ");
  return [
    fg(theme, "borderMuted", "─".repeat(Math.max(0, width))),
    joinLeftRight(title, fg(theme, "dim", stats), width),
    joinLeftRight(fg(theme, "muted", sanitizeText(details.description ?? "Workflow run", 1000)), fg(theme, "dim", details.runId), width),
  ];
}

function renderProgressPanels(details: WorkflowLaunchOutput, progress: WorkflowProgressSnapshot, theme: ThemeLike, width: number, options: ProgressPanelsOptions = {}): string[] {
  if (width >= WIDE_PROGRESS_PANEL_MIN_WIDTH) {
    const phaseWidth = Math.min(46, Math.max(30, Math.floor(width * 0.3)));
    const agentWidth = Math.max(28, width - phaseWidth - 1);
    const calls = callsForActivePhase(progress);
    const phaseRows = renderPhaseRows(details, progress, phaseWidth - 2, theme, options.maxPhaseRows);
    const agentRows = renderAgentRows(calls, progress.recentLogs, agentWidth - 2, theme, { maxCalls: options.maxAgentRows, maxLogs: options.maxLogRows });
    const bodyHeight = Math.max(phaseRows.length, agentRows.length);
    while (phaseRows.length < bodyHeight) phaseRows.push("");
    while (agentRows.length < bodyHeight) agentRows.push("");
    const phases = frameBlock("Phases", phaseRows, phaseWidth, theme);
    const title = agentPanelTitle(progress, calls);
    const agents = frameBlock(title, agentRows, agentWidth, theme);
    return sideBySide(phases, agents, width);
  }

  const calls = callsForActivePhase(progress);
  return [
    ...frameBlock("Phases", renderPhaseRows(details, progress, width - 2, theme, options.maxPhaseRows), width, theme),
    "",
    ...frameBlock(agentPanelTitle(progress, calls), renderAgentRows(calls, progress.recentLogs, width - 2, theme, { maxCalls: options.maxAgentRows, maxLogs: options.maxLogRows }), width, theme),
  ];
}

function renderPhaseRows(details: WorkflowLaunchOutput, progress: WorkflowProgressSnapshot, width: number, theme: ThemeLike, maxRows = 14): string[] {
  const phases = phaseSpecs(details, progress);
  if (phases.length === 0) {
    return [joinLeftRight(fg(theme, "accent", "▶ Agents"), `${progress.completed}/${progress.total}`, width)];
  }

  const rows: string[] = [];
  const activeIndex = phases.findIndex((phase) => phase.title === progress.phase);
  phases.forEach((phase, index) => {
    const stats = phaseStats(progress, phase.title, phases.length === 1 && phase.title === "Agents");
    const active = progress.phase === phase.title || (!progress.phase && phase.title === "Agents");
    const passed = activeIndex >= 0 && index < activeIndex;
    const failed = stats.failed > 0 || (active && details.status === "failed");
    const complete = !failed && (passed || (stats.total > 0 && stats.finished >= stats.total) || (active && details.status === "completed"));
    const color = failed ? "error" : complete ? "success" : active ? "accent" : "muted";
    const icon = failed ? "✗" : complete ? "✓" : active ? "›" : "·";
    const count = stats.total > 0 ? `${stats.finished}/${stats.total}` : "";
    const label = `${icon} ${index + 1} ${sanitizeText(phase.title, 180)}`;
    rows.push(fg(theme, color, joinLeftRight(label, count, width)));
    if (active && phase.detail) rows.push(fg(theme, "dim", truncateToWidth(`  ${sanitizeText(phase.detail, 240)}`, width)));
  });
  return rows.slice(0, maxRows);
}

function agentPanelTitle(progress: WorkflowProgressSnapshot, visibleCalls: WorkflowCallProgress[]): string {
  if (progress.phase && progress.calls.some((call) => call.phase === progress.phase)) return `${sanitizeText(progress.phase, 120)} · ${visibleCalls.length} agents`;
  if (progress.total === 0 && progress.calls.length === 0) return "Activity";
  return `Agents · ${progress.total}`;
}

function renderAgentRows(calls: WorkflowCallProgress[], logs: string[], width: number, theme: ThemeLike, options: { maxCalls?: number; maxLogs?: number } = {}): string[] {
  const rows: string[] = [];
  const visibleCalls = tail(calls, Math.max(0, options.maxCalls ?? RENDER_LIMITS.progressCalls));
  if (visibleCalls.length === 0) rows.push(fg(theme, "dim", "No agents have started yet."));

  for (const call of visibleCalls) {
    const icon = callIcon(call.status);
    const left = `${icon} ${sanitizeText(call.callId, 40)} ${sanitizeText(call.label, 240)}`;
    const meta = callMeta(call);
    rows.push(fg(theme, callColor(call.status), joinLeftRight(left, meta, width)));
  }

  const requestedMaxLogs = options.maxLogs ?? RENDER_LIMITS.progressLogs;
  const visibleLogs = tail(logs, Math.max(0, visibleCalls.length === 0 && requestedMaxLogs === 0 ? RENDER_LIMITS.progressLogs : requestedMaxLogs));
  if (visibleLogs.length > 0) {
    if (rows.length > 0) rows.push("");
    for (const log of visibleLogs) rows.push(fg(theme, "dim", truncateToWidth(`log: ${sanitizeText(log, 500)}`, width)));
  }
  return rows;
}

function tail<T>(items: readonly T[], count: number): T[] {
  return count <= 0 ? [] : items.slice(-count);
}

function renderArtifactLines(details: WorkflowLaunchOutput, options: WorkflowResultRenderOptions): string[] {
  const lines = [
    `run: ${sanitizeText(details.runId, 100)}`,
    `script: ${sanitizeText(details.scriptPath, 1000)}`,
    `transcripts: ${sanitizeText(details.transcriptDir, 1000)}`,
  ];
  if (details.outputPath) lines.push(`output: ${sanitizeText(details.outputPath, 1000)}`);
  if (!options.message) {
    const scriptPath = sanitizeText(JSON.stringify(details.scriptPath), 1000);
    const runId = sanitizeText(JSON.stringify(details.runId), 200);
    lines.push(`resume: workflow({ scriptPath: ${scriptPath}, resumeFromRunId: ${runId} })`);
  }
  return lines;
}

function renderArtifactHint(details: WorkflowLaunchOutput): string {
  const parts = [
    `artifacts: ${sanitizeText(details.outputPath ?? details.scriptPath, 1000)}`,
    `run: ${sanitizeText(details.runId, 100)}`,
  ];
  return parts.join(" · ");
}

function withViewSections(lines: string[], snapshots: WorkflowViewSnapshot[], renderer: WorkflowViewRenderer, width: number, profile: Exclude<WorkflowResultRenderProfile, "compact">): string[] {
  for (const snapshot of snapshots) {
    if (lines.length > 0) lines.push("");
    lines.push(...renderer.render(snapshot, width, profile));
  }
  return lines;
}

function finalizeResultLines(lines: string[], width: number, profile: WorkflowResultRenderProfile, overrideMaxLines?: number): string[] {
  const maxLines = overrideMaxLines ?? (profile === "compact" ? RENDER_LIMITS.compactViewLines : profile === "panel" ? RENDER_LIMITS.panelViewLines : RENDER_LIMITS.fullViewLines);
  const clipped = lines.length > maxLines && maxLines > 0 ? [...lines.slice(0, maxLines - 1), `… ${lines.length - maxLines + 1} more line(s)`] : lines.slice(0, maxLines);
  return clipped.map((line) => padToWidth(truncateToWidth(line, width), width));
}

function panelResultLineLimit(details: WorkflowLaunchOutput, progress: WorkflowProgressSnapshot | undefined, uiViews: WorkflowViewSnapshot[], renderer: WorkflowViewRenderer, width: number): number {
  const progressLimit = progress && hasProgressPanel(details, progress) && width >= WIDE_PROGRESS_PANEL_MIN_WIDTH ? RENDER_LIMITS.workflowPanelLines : RENDER_LIMITS.panelViewLines;
  if (uiViews.length === 0) return progressLimit;
  const viewLimit = Math.max(...uiViews.map((snapshot) => renderer.panelLineLimit(snapshot)));
  return Math.max(progressLimit, Math.min(UI_LIMITS.maxDashboardPanelLines + 2, viewLimit));
}

function compactResultStats(details: WorkflowLaunchOutput, progress: WorkflowProgressSnapshot | undefined, theme: ThemeLike, options: { terminalStatus?: boolean } = {}): string {
  const tokenText = details.usage?.subagentTokens ? `${compactNumber(details.usage.subagentTokens)} tok` : undefined;
  const progressText = progress && hasAgentProgress(progress) ? `${progress.completed}/${progress.total} agents` : undefined;
  const runningText = progress && progress.running > 0 ? `${progress.running} running` : undefined;
  const statusText = options.terminalStatus === false && details.status !== "async_launched" ? undefined : statusWord(details.status, theme);
  return [statusText, progressText, runningText, tokenText, elapsed(details.startedAt, details.endedAt)].filter(Boolean).join(" · ");
}

function compactResultSecondary(details: WorkflowLaunchOutput, progress: WorkflowProgressSnapshot | undefined, width: number): string | undefined {
  if (details.status === "failed" && details.error) {
    return truncateToWidth(`error: ${sanitizeText(details.error, 1000).replace(/\n+/g, " ↵ ")}`, width);
  }
  if (progress) {
    const latest = progress.calls.at(-1);
    const left = progress.phase ? `phase: ${sanitizeText(progress.phase, 160)}` : sanitizeText(details.description ?? "Workflow run", 300);
    const right = latest ? `${callIcon(latest.status)} ${sanitizeText(latest.label, 160)}` : sanitizeText(details.runId, 100);
    return joinLeftRight(left, right, width);
  }
  return joinLeftRight(sanitizeText(details.description ?? "Workflow run", 300), sanitizeText(details.runId, 100), width);
}

function renderProgressLine(progress: WorkflowProgressSnapshot, theme: ThemeLike, width: number): string {
  const total = Math.max(0, progress.total);
  const finished = Math.min(total, progress.completed + progress.failed + progress.skipped);
  const percent = total > 0 ? finished / total : 0;
  const barWidth = Math.max(8, Math.min(24, width - 28));
  const filled = Math.max(0, Math.min(barWidth, Math.round(percent * barWidth)));
  const bar = `${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`;
  return joinLeftRight(fg(theme, "muted", `progress: ${bar}`), `${finished}/${total}`, width);
}

function renderCompactCallRow(call: WorkflowCallProgress, theme: ThemeLike, width: number): string {
  const left = `${callIcon(call.status)} ${sanitizeText(call.callId, 40)} ${sanitizeText(call.label, 180)}`;
  const right = callMeta(call);
  return fg(theme, callColor(call.status), joinLeftRight(left, right, width));
}

function callMeta(call: WorkflowCallProgress): string {
  const usage = call.usage;
  const tokens = usage ? `${compactNumber(usage.subagentTokens)} tok` : undefined;
  const tools = usage ? `${usage.toolUses} ${usage.toolUses === 1 ? "tool" : "tools"}` : undefined;
  const duration = usage?.durationMs !== undefined ? formatDuration(usage.durationMs) : callElapsed(call);
  const status = call.status === "done" ? undefined : call.status;
  return [call.model ? sanitizeText(call.model, 80) : undefined, tokens, tools, duration, status].filter(Boolean).join(" · ");
}

function workflowStatusIcon(status: WorkflowLaunchOutput["status"]): string {
  if (status === "completed" || status === "failed") return "";
  return "▶";
}

function frameBlock(title: string, body: string[], width: number, theme: ThemeLike, color = "muted"): string[] {
  if (width < 8) return body.map((line) => padToWidth(line, width));
  const inner = Math.max(1, width - 2);
  const safeTitle = sanitizeText(title, 180);
  const label = safeTitle ? truncateToWidth(` ${safeTitle} `, inner, "") : "";
  const top = `┌${label}${"─".repeat(Math.max(0, inner - visibleWidth(label)))}┐`;
  const bottom = `└${"─".repeat(inner)}┘`;
  const rows = body.length > 0 ? body : [""];
  const leftBorder = fg(theme, color, "│");
  const rightBorder = fg(theme, color, "│");
  return [fg(theme, color, top), ...rows.map((line) => `${leftBorder}${padToWidth(line, inner)}${rightBorder}`), fg(theme, color, bottom)].map((line) => padToWidth(line, width));
}

function sideBySide(left: string[], right: string[], width: number): string[] {
  const gap = " ";
  const height = Math.max(left.length, right.length);
  const leftWidth = Math.max(0, ...left.map(visibleWidth));
  const rightWidth = Math.max(0, width - leftWidth - visibleWidth(gap));
  const out: string[] = [];
  for (let i = 0; i < height; i++) {
    out.push(padToWidth(`${padToWidth(left[i] ?? "", leftWidth)}${gap}${padToWidth(right[i] ?? "", rightWidth)}`, width));
  }
  return out;
}

function joinLeftRight(left: string, right: string | undefined, width: number): string {
  if (!right) return truncateToWidth(left, width);
  const clippedRight = truncateToWidth(right, Math.max(0, Math.min(visibleWidth(right), Math.floor(width * 0.46))));
  const gap = clippedRight ? 1 : 0;
  const leftWidth = Math.max(0, width - visibleWidth(clippedRight) - gap);
  const clippedLeft = truncateToWidth(left, leftWidth);
  return `${clippedLeft}${" ".repeat(Math.max(gap, width - visibleWidth(clippedLeft) - visibleWidth(clippedRight)))}${clippedRight}`;
}

function phaseSpecs(details: WorkflowLaunchOutput, progress: WorkflowProgressSnapshot): Array<{ title: string; detail?: string }> {
  const fromMeta = ((details.phases ?? []) as WorkflowMeta["phases"])?.filter((phase): phase is { title: string; detail?: string } => !!phase && typeof phase.title === "string" && phase.title.trim() !== "") ?? [];
  if (fromMeta.length > 0) return fromMeta;
  const titles = new Set<string>();
  for (const call of progress.calls) if (call.phase) titles.add(call.phase);
  if (progress.phase) titles.add(progress.phase);
  return titles.size > 0 ? [...titles].map((title) => ({ title })) : [{ title: "Agents" }];
}

function phaseStats(progress: WorkflowProgressSnapshot, title: string, aggregate: boolean): { total: number; finished: number; failed: number } {
  const calls = aggregate ? progress.calls : progress.calls.filter((call) => call.phase === title);
  return {
    total: calls.length,
    finished: calls.filter((call) => ["done", "cached", "skipped"].includes(call.status)).length,
    failed: calls.filter((call) => call.status === "failed" || call.status === "aborted").length,
  };
}

function callsForActivePhase(progress: WorkflowProgressSnapshot): WorkflowCallProgress[] {
  if (!progress.phase) return progress.calls;
  const calls = progress.calls.filter((call) => call.phase === progress.phase);
  return calls.length > 0 ? calls : progress.calls;
}

function hasAgentProgress(progress: WorkflowProgressSnapshot): boolean {
  return progress.total > 0 || progress.calls.length > 0 || progress.running > 0 || progress.completed > 0 || progress.failed > 0 || progress.cached > 0 || progress.skipped > 0;
}

function hasProgressPanel(details: WorkflowLaunchOutput, progress: WorkflowProgressSnapshot): boolean {
  return hasAgentProgress(progress) || !!progress.phase || ((details.phases?.length ?? 0) > 0);
}

function hasLiveProgress(details: WorkflowLaunchOutput, progress: WorkflowProgressSnapshot): boolean {
  return details.status === "async_launched" || progress.running > 0 || progress.calls.some((call) => call.status === "running" || call.status === "pending");
}

function statusWord(status: WorkflowLaunchOutput["status"], theme: ThemeLike): string {
  if (status === "completed") return fg(theme, "success", "completed");
  if (status === "failed") return fg(theme, "error", "failed");
  return fg(theme, "accent", "running");
}

function callIcon(status: CallStatus): string {
  switch (status) {
    case "done":
    case "cached":
      return "✓";
    case "failed":
    case "aborted":
      return "✗";
    case "running":
      return "▶";
    case "skipped":
      return "↷";
    default:
      return "•";
  }
}

function callColor(status: CallStatus): string {
  if (status === "done" || status === "cached") return "success";
  if (status === "failed" || status === "aborted") return "error";
  if (status === "running") return "accent";
  return "muted";
}

function limitedLines(text: string, maxLines: number): string[] {
  const lines = sanitizeText(text, 8_000).split("\n");
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more line(s)`];
}

function elapsed(startIso?: string, endIso?: string): string | undefined {
  if (!startIso) return undefined;
  const start = Date.parse(startIso);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return formatDuration(end - start);
}

function callElapsed(call: WorkflowCallProgress): string | undefined {
  return elapsed(call.startedAt, call.endedAt);
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours}h${mins}m` : `${hours}h`;
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
