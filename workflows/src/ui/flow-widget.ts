import type { WorkflowAgentProjection, WorkflowRunProjection } from "../projection/types.js";
import { boundedProjectionText } from "../projection/run-projection.js";
import { truncateToWidth, visibleWidth } from "../utils/truncate.js";

export interface FlowThemeLike {
  fg?: (color: any, text: string) => string;
  bold?: (text: string) => string;
}

/**
 * Small live component backed only by the uniform projection DTO.  Revisions
 * which do not alter visible fields deliberately retain the render cache.
 */
export class FlowWidgetComponent {
  private cached?: { width: number; fingerprint: string; lines: string[] };

  constructor(private projection: WorkflowRunProjection, private theme?: FlowThemeLike) {}

  update(projection: WorkflowRunProjection, theme?: FlowThemeLike): void {
    if (visibleFingerprint(projection) !== visibleFingerprint(this.projection) || theme !== this.theme) this.invalidate();
    this.projection = structuredClone(projection);
    this.theme = theme;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.trunc(width));
    const fingerprint = visibleFingerprint(this.projection);
    if (this.cached?.width === safeWidth && this.cached.fingerprint === fingerprint) return this.cached.lines;
    const lines = renderFlowWidgetLines(this.projection, this.theme, safeWidth);
    this.cached = { width: safeWidth, fingerprint, lines };
    return lines;
  }

  invalidate(): void { this.cached = undefined; }
}

/** TUI adapter. With no theme this is also the canonical headless rendering. */
export function renderFlowWidgetLines(
  projection: WorkflowRunProjection,
  theme: FlowThemeLike | undefined,
  width: number,
): string[] {
  const safeWidth = Math.max(0, Math.trunc(width));
  if (safeWidth === 0) return [];
  const maximumRows = safeWidth < 48 ? 3 : safeWidth < 88 ? 5 : 7;
  const rows: Array<{ color?: string; text: string }> = [{ color: statusColor(projection.status), text: header(projection, safeWidth) }];
  const attention = projection.attentionReasons[0];
  if (attention) rows.push({ color: attention.retryable ? "warning" : "error", text: `! ${safe(attention.summary)} · ${actionFor(projection)}` });

  const agent = projection.activeAgents[0];
  if (agent) {
    rows.push({ color: "accent", text: agentLine(agent, projection.activeAgents.length - 1) });
    const telemetry = telemetryLine(agent, safeWidth);
    if (telemetry) rows.push({ color: "dim", text: telemetry });
    const log = agent.recentLogs.at(-1);
    if (log) rows.push({ color: "muted", text: `log · ${safe(log.messagePreview ?? log.type)}${log.artifact ? ` · artifact ${safe(log.artifact.kind)} ${shortHash(log.artifact.digest)}` : ""}` });
  } else {
    const operation = projection.phaseTree.find((entry) => entry.operationId === projection.currentOperationId)
      ?? projection.phaseTree.find((entry) => entry.status === "running" || entry.status === "waiting");
    if (operation) rows.push({ color: "accent", text: `${operationGlyph(operation.status)} ${safe(operation.path)} · ${operation.kind}` });
  }

  const state = stateLine(projection);
  if (state) rows.push({ color: state.color, text: state.text });
  const replay = replayLine(projection);
  if (replay) rows.push({ color: "dim", text: replay });
  rows.push({ color: "dim", text: usageLine(projection) });

  return dedupe(rows)
    .slice(0, maximumRows)
    .map((row) => truncateToWidth(fg(theme, row.color, row.text), safeWidth));
}

/** Plain immutable output for RPC/headless clients which want a text adapter. */
export function renderWorkflowRunText(projection: WorkflowRunProjection, width = 100): readonly string[] {
  return Object.freeze([...renderFlowWidgetLines(structuredClone(projection), undefined, width)]);
}

function header(projection: WorkflowRunProjection, width: number): string {
  const left = `${statusGlyph(projection.status)} ${safe(projection.workflowName)} · ${safe(projection.shortRunId)}`;
  const right = projection.attentionReasons[0]?.code.replace(/-/g, " ") ?? projection.status;
  if (width < 72) return `${left} · ${right}`;
  const room = Math.max(1, width - visibleWidth(right) - 1);
  const boundedLeft = truncateToWidth(left, room);
  return `${boundedLeft}${" ".repeat(Math.max(1, width - visibleWidth(boundedLeft) - visibleWidth(right)))}${right}`;
}

function agentLine(agent: WorkflowAgentProjection, additional: number): string {
  const progress = agent.progress
    ? `${agent.progress.message}${agent.progress.current !== undefined && agent.progress.total !== undefined ? ` ${agent.progress.current}/${agent.progress.total}` : ""}`
    : `${agent.profileId} · ${agent.status}`;
  const tool = agent.currentTool ? ` · tool ${agent.currentTool}` : "";
  return `▶ ${safe(progress)}${tool}${additional > 0 ? ` · +${additional} agents` : ""}`;
}

function telemetryLine(agent: WorkflowAgentProjection, width: number): string | undefined {
  const custom = agent.customMetrics.slice(0, width >= 88 ? 3 : 1).map(metric).join(" · ");
  const resources = resourceMetrics(agent).slice(0, width >= 88 ? 4 : 2).join(" · ");
  const activity = `turn ${agent.modelTurn} · ${agent.toolCount} tools${agent.retries ? ` · ${agent.retries} retries` : ""}`;
  return [activity, custom, resources].filter(Boolean).join(" · ");
}

function stateLine(projection: WorkflowRunProjection): { color: string; text: string } | undefined {
  const waiting = projection.checkpoints.find((entry) => entry.status === "waiting");
  if (waiting) return { color: "warning", text: `checkpoint · ${safe(waiting.request.prompt)} · /flow respond ${projection.shortRunId} ${waiting.checkpointId}` };
  if (projection.apply) {
    const apply = projection.apply;
    const command = apply.status === "waiting" ? ` · /flow approve ${projection.shortRunId}` : "";
    return { color: apply.status === "rejected" || apply.status === "stopped" ? "error" : "warning", text: `apply ${apply.status} · ${apply.changedPathCount} paths · candidate ${safe(apply.candidateId)}${command}` };
  }
  if (projection.candidate) return { color: "muted", text: `candidate ${safe(projection.candidate.candidateId)} · ${projection.candidate.changedPathCount} paths · tree ${shortHash(projection.candidate.treeHash)}` };
  if (projection.artifacts.length) return { color: "muted", text: `artifacts ${projection.artifacts.length} · latest ${safe(projection.artifacts.at(-1)!.kind)}` };
  return undefined;
}

function replayLine(projection: WorkflowRunProjection): string | undefined {
  const replay = projection.replay;
  if (!replay) return undefined;
  if (replay.fresh) return "replay · fresh run requested";
  return `replay · ${replay.matchedCalls} matched${replay.firstMissOrdinal !== undefined ? ` · miss @${replay.firstMissOrdinal}${replay.firstMissReason ? ` ${safe(replay.firstMissReason)}` : ""}` : " · full prefix"}`;
}

function usageLine(projection: WorkflowRunProjection): string {
  const usage = projection.usage;
  const tokens = usage.inputTokens + usage.outputTokens;
  const running = projection.operationCounts.running ?? 0;
  const queued = projection.operationCounts.queued ?? 0;
  return `${compact(tokens)} tokens · ${usage.providerRequests} calls · ${duration(usage.elapsedMs)} · operations ${running} running${queued ? `, ${queued} queued` : ""}`;
}

function actionFor(projection: WorkflowRunProjection): string {
  if (projection.apply?.status === "waiting") return `/flow approve ${projection.shortRunId}`;
  const checkpoint = projection.checkpoints.find((entry) => entry.status === "waiting");
  if (checkpoint) return `/flow respond ${projection.shortRunId} ${checkpoint.checkpointId}`;
  if (projection.status === "paused") return `/flow resume ${projection.shortRunId}`;
  return `/flow open ${projection.shortRunId}`;
}

function resourceMetrics(agent: WorkflowAgentProjection): string[] {
  const resources = agent.resources;
  if (!resources) return [];
  return [
    resources.cpuUsec === undefined ? undefined : `cpu ${duration(resources.cpuUsec / 1_000)}`,
    resources.memoryCurrentBytes === undefined ? undefined : `mem ${bytes(resources.memoryCurrentBytes)}`,
    resources.memoryPeakBytes === undefined ? undefined : `peak ${bytes(resources.memoryPeakBytes)}`,
    resources.ioReadBytes === undefined && resources.ioWriteBytes === undefined ? undefined : `io ${bytes((resources.ioReadBytes ?? 0) + (resources.ioWriteBytes ?? 0))}`,
    resources.tasksCurrent === undefined ? undefined : `tasks ${resources.tasksCurrent}`,
  ].filter((value): value is string => Boolean(value));
}

function metric(value: { name: string; value: number; unit?: string }): string {
  return `${safe(value.name)} ${compact(value.value)}${value.unit ? ` ${safe(value.unit)}` : ""}`;
}

function visibleFingerprint(projection: WorkflowRunProjection): string {
  const agent = projection.activeAgents[0];
  return JSON.stringify({
    runId: projection.runId, status: projection.status, currentOperationId: projection.currentOperationId,
    attention: projection.attentionReasons[0], agent, agentCount: projection.activeAgents.length,
    checkpoints: projection.checkpoints, apply: projection.apply, candidate: projection.candidate,
    replay: projection.replay, usage: projection.usage, counts: projection.operationCounts,
    artifact: projection.artifacts.at(-1),
  });
}

function dedupe<T extends { text: string }>(rows: T[]): T[] {
  return rows.filter((row, index) => index === 0 || row.text !== rows[index - 1]!.text);
}

function safe(value: unknown): string { return boundedProjectionText(value, 512); }
function shortHash(value: string): string { return safe(value).replace(/^sha256:/, "").slice(0, 10); }
function compact(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.0+$/, "");
}
function bytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)}GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)}MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)}KiB`;
  return `${value}B`;
}
function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m${seconds % 60 ? `${seconds % 60}s` : ""}`;
  return `${Math.floor(seconds / 3_600)}h${Math.floor(seconds % 3_600 / 60)}m`;
}
function operationGlyph(status: string): string { return status === "waiting" ? "!" : status === "queued" ? "○" : "▶"; }
function statusGlyph(status: string): string {
  if (status === "completed") return "✓";
  if (status === "failed" || status === "stopped") return "×";
  if (status === "paused") return "‖";
  if (status === "waiting") return "!";
  if (status === "queued") return "○";
  return "◆";
}
function statusColor(status: string): string {
  if (status === "completed") return "success";
  if (status === "failed" || status === "stopped") return "error";
  if (status === "waiting") return "warning";
  if (status === "paused" || status === "queued") return "muted";
  return "accent";
}
function fg(theme: FlowThemeLike | undefined, color: string | undefined, text: string): string {
  return color && theme?.fg ? theme.fg(color, text) : text;
}
