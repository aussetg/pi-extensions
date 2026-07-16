import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { NamedWorkflowClient } from "../runtime/named-workflow-types.js";
import type {
  WorkflowInspectorPage,
  WorkflowInspectorPageKind,
  WorkflowRunProjection,
} from "../projection/types.js";
import { boundedProjectionText } from "../projection/run-projection.js";
import { stableJson } from "../utils/stable-json.js";
import { truncateToWidth } from "../utils/truncate.js";
import type { FlowThemeLike } from "./flow-widget.js";

export const WORKFLOW_INSPECTOR_VIEWS = ["overview", "operations", "logs", "artifacts", "measurements", "events"] as const;
export type WorkflowInspectorView = typeof WORKFLOW_INSPECTOR_VIEWS[number];

interface TuiLike { requestRender(): void; terminal?: { rows?: number }; }
type Done = (value: undefined) => void;

/** Read-only, keyset-paged inspector. It stores focus, never runtime state. */
export class FlowInspectorComponent {
  private view: WorkflowInspectorView = "overview";
  private page?: WorkflowInspectorPage;
  private cursorHistory: string[] = [];
  private selected = 0;
  private readonly selectedIdentity = new Map<WorkflowInspectorView, string>();
  private loading = false;
  private error?: string;
  private poll?: NodeJS.Timeout;
  private tui?: TuiLike;
  private done?: Done;
  private viewportRows = 30;
  private cached?: { width: number; key: string; lines: string[] };

  constructor(
    private readonly workflows: NamedWorkflowClient,
    private readonly runRef: string,
    private projection: WorkflowRunProjection,
    private readonly context: ExtensionCommandContext,
    private theme?: FlowThemeLike,
  ) {}

  attach(tui: TuiLike, theme: FlowThemeLike, done: Done): this {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.viewportRows = Math.max(10, Math.min(80, (tui.terminal?.rows ?? 34) - 4));
    if (!terminal(this.projection.status)) {
      this.poll = setInterval(() => void this.refreshProjection(), 500);
      this.poll.unref?.();
    }
    return this;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.trunc(width));
    const key = `${this.projection.revision}:${this.view}:${this.page?.revision ?? 0}:${this.page?.nextCursor ?? ""}:${this.cursorHistory.length}:${this.selected}:${this.loading}:${this.error ?? ""}`;
    if (this.cached?.width === safeWidth && this.cached.key === key) return this.cached.lines;
    const rows = renderWorkflowInspectorText(this.projection, this.view === "overview" ? undefined : this.page, safeWidth, {
      view: this.view,
      selected: this.selected,
      loading: this.loading,
      error: this.error,
      theme: this.theme,
    }).slice(0, this.viewportRows);
    this.cached = { width: safeWidth, key, lines: rows };
    return rows;
  }

  invalidate(): void { this.cached = undefined; }

  updateProjection(projection: WorkflowRunProjection): void {
    this.rememberSelection();
    this.projection = structuredClone(projection);
    this.restoreSelection();
    this.redraw();
  }

  handleInput(data: string): void {
    if (data === "\x1b" || data === "\x03") { this.close(); return; }
    if (data === "\t") { void this.switchView(1); return; }
    if (data === "\x1b[Z") { void this.switchView(-1); return; }
    if (data === "\x1b[A" || data === "k") { this.move(-1); return; }
    if (data === "\x1b[B" || data === "j") { this.move(1); return; }
    if (data === "\x1b[6~" || data === "\x1b[C") { void this.nextPage(); return; }
    if (data === "\x1b[5~" || data === "\x1b[D") { void this.previousPage(); }
  }

  close(): void {
    const done = this.done;
    this.dispose();
    done?.(undefined);
  }

  dispose(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    this.done = undefined;
  }

  private async switchView(direction: -1 | 1): Promise<void> {
    if (this.loading) return;
    this.rememberSelection();
    const current = WORKFLOW_INSPECTOR_VIEWS.indexOf(this.view);
    this.view = WORKFLOW_INSPECTOR_VIEWS[(current + direction + WORKFLOW_INSPECTOR_VIEWS.length) % WORKFLOW_INSPECTOR_VIEWS.length]!;
    this.cursorHistory = [];
    this.selected = 0;
    this.page = undefined;
    if (this.view !== "overview") await this.loadPage(undefined);
    this.restoreSelection();
    this.redraw();
  }

  private move(delta: -1 | 1): void {
    const count = this.view === "overview" ? overviewSelectableCount(this.projection) : this.page?.entries.length ?? 0;
    this.selected = Math.max(0, Math.min(Math.max(0, count - 1), this.selected + delta));
    this.rememberSelection();
    this.redraw();
  }

  private async nextPage(): Promise<void> {
    if (this.loading || this.view === "overview" || !this.page?.nextCursor) return;
    this.cursorHistory.push(this.page.nextCursor);
    await this.loadPage(this.page.nextCursor);
    this.selected = 0;
  }

  private async previousPage(): Promise<void> {
    if (this.loading || this.view === "overview" || this.cursorHistory.length === 0) return;
    this.cursorHistory.pop();
    const cursor = this.cursorHistory.at(-1);
    await this.loadPage(cursor);
    this.selected = Math.max(0, (this.page?.entries.length ?? 1) - 1);
  }

  private async loadPage(cursor: string | undefined): Promise<void> {
    if (this.view === "overview") return;
    await this.load(async () => {
      this.page = await this.workflows.inspectPage(this.runRef, this.view as WorkflowInspectorPageKind, { ...(cursor ? { cursor } : {}), limit: 32 }, this.context);
    });
  }

  private async refreshProjection(): Promise<void> {
    if (this.loading) return;
    try {
      const next = await this.workflows.open(this.runRef, this.context);
      if (next.revision === this.projection.revision) return;
      this.rememberSelection();
      this.projection = structuredClone(next);
      if (this.view !== "overview") await this.loadPage(this.cursorHistory.at(-1));
      this.restoreSelection();
      if (terminal(next.status) && this.poll) { clearInterval(this.poll); this.poll = undefined; }
      this.redraw();
    } catch (error) {
      this.error = safeError(error);
      this.redraw();
    }
  }

  private async load(body: () => Promise<void>): Promise<void> {
    this.loading = true;
    this.error = undefined;
    this.redraw();
    try { await body(); }
    catch (error) { this.error = safeError(error); }
    finally { this.loading = false; this.redraw(); }
  }

  private rememberSelection(): void {
    const identity = selectedIdentity(this.projection, this.view, this.page, this.selected);
    if (identity) this.selectedIdentity.set(this.view, identity);
  }
  private restoreSelection(): void {
    const wanted = this.selectedIdentity.get(this.view);
    if (!wanted) return;
    const identities = selectableIdentities(this.projection, this.view, this.page);
    const found = identities.indexOf(wanted);
    if (found >= 0) this.selected = found;
  }
  private redraw(): void { this.invalidate(); this.tui?.requestRender(); }
}

/** Opens the same DTO/page inspector used by headless callers. */
export async function openWorkflowInspector(
  workflows: NamedWorkflowClient,
  runRef: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const projection = await workflows.open(runRef, ctx);
  await ctx.ui.custom<undefined>((tui, theme, _keybindings, done) => (
    new FlowInspectorComponent(workflows, runRef, projection, ctx, theme).attach(tui, theme, done)
  ));
}

export interface WorkflowInspectorRenderOptions {
  view?: WorkflowInspectorView;
  selected?: number;
  loading?: boolean;
  error?: string;
  theme?: FlowThemeLike;
}

/** Pure bounded renderer for TUI, RPC text, tests, and headless output. */
export function renderWorkflowInspectorText(
  projection: WorkflowRunProjection,
  page: WorkflowInspectorPage | undefined,
  width: number,
  options: WorkflowInspectorRenderOptions = {},
): string[] {
  const safeWidth = Math.max(1, Math.trunc(width));
  const view = options.view ?? page?.kind ?? "overview";
  const selected = options.selected ?? -1;
  const theme = options.theme;
  const tabs = safeWidth < 72 ? view : WORKFLOW_INSPECTOR_VIEWS.map((entry) => entry === view ? `[${entry}]` : entry).join("  ");
  const lines = [
    fg(theme, "accent", `Flow ${safe(projection.workflowName)} · ${projection.shortRunId} · ${projection.status} · r${projection.revision}`),
    fg(theme, "dim", `${tabs} · Tab views · ↑↓ focus · ←→ pages · Esc close`),
  ];
  if (view === "overview") lines.push(...overviewLines(projection, selected, theme));
  else if (!page) lines.push(fg(theme, "dim", "No page loaded."));
  else {
    page.entries.forEach((entry, index) => {
      const prefix = index === selected ? fg(theme, "accent", "›") : " ";
      lines.push(`${prefix} ${formatPageEntry(entry, safeWidth - 2)}`);
    });
    lines.push(fg(theme, "dim", `${page.entries.length} entries${page.nextCursor ? " · more →" : " · end"} · ${page.bytes} bytes`));
  }
  if (options.loading) lines.push(fg(theme, "warning", "loading…"));
  if (options.error) lines.push(fg(theme, "error", safe(options.error)));
  return lines.slice(0, 96).map((line) => truncateToWidth(line, safeWidth));
}

function overviewLines(projection: WorkflowRunProjection, selected: number, theme?: FlowThemeLike): string[] {
  const rows: string[] = [];
  const add = (text: string, color = "text") => {
    const prefix = rows.length === selected ? fg(theme, "accent", "›") : " ";
    rows.push(`${prefix} ${fg(theme, color, text)}`);
  };
  projection.attentionReasons.forEach((reason) => add(`attention · ${reason.category}/${reason.code} · ${safe(reason.summary)}`, reason.retryable ? "warning" : "error"));
  if (projection.replay) add(`replay · ${projection.replay.matchedCalls} hits${projection.replay.firstMissOrdinal !== undefined ? ` · first miss ${projection.replay.firstMissOrdinal} ${safe(projection.replay.firstMissReason ?? "")}` : ""}`, "muted");
  projection.activeAgents.forEach((agent) => {
    add(`agent ${safe(agent.profileId)} · ${agent.status} · ${agent.progress ? safe(agent.progress.message) : "no message"}${agent.currentTool ? ` · tool ${safe(agent.currentTool)}` : ""}`, "accent");
    const metrics = [...agent.customMetrics, ...agent.automaticMetrics].slice(0, 8).map((metric) => `${safe(metric.name)}=${metric.value}${metric.unit ? safe(metric.unit) : ""}`).join(" · ");
    if (metrics) add(`  metrics · ${metrics}`, "dim");
    if (agent.resources) add(`  cgroup · ${resourceText(agent.resources)}`, "dim");
    agent.recentLogs.forEach((log) => add(`  log · ${safe(log.messagePreview ?? log.type)}${log.artifact ? ` · artifact ${safe(log.artifact.kind)} ${short(log.artifact.digest)}` : ""}`, "muted"));
  });
  projection.checkpoints.forEach((checkpoint) => add(`checkpoint ${checkpoint.status} · ${safe(checkpoint.request.prompt)} · ${checkpoint.checkpointId}`, checkpoint.status === "waiting" ? "warning" : "muted"));
  if (projection.apply) add(`apply ${projection.apply.status} · candidate ${safe(projection.apply.candidateId)} · ${projection.apply.changedPathCount} paths · challenge ${short(projection.apply.challenge.challengeHash)}`, projection.apply.status === "waiting" ? "warning" : "muted");
  if (projection.candidate) add(`candidate ${safe(projection.candidate.candidateId)} · ${projection.candidate.changedPathCount} paths · tree ${short(projection.candidate.treeHash)}`, "muted");
  projection.metrics.slice(0, 8).forEach((metric) => add(`metric ${safe(metric.title)} · ${metric.role} · current ${metric.current ?? "—"} · best ${metric.best ?? "—"}`, "muted"));
  projection.phaseTree.slice(0, 32).forEach((operation) => add(`${"  ".repeat(Math.min(8, operation.depth))}${safe(operation.path)} · ${operation.kind} · ${operation.status}${operation.replay ? " · replayed" : ""}`, operation.status === "failed" ? "error" : operation.status === "running" ? "accent" : "text"));
  projection.artifacts.slice(0, 12).forEach((artifact) => add(`artifact ${safe(artifact.kind)} · ${artifact.bytes} bytes · ${short(artifact.digest)}`, "muted"));
  if (projection.phaseOperationOmittedCount) add(`… ${projection.phaseOperationOmittedCount} operations omitted from overview`, "dim");
  add(`usage · ${projection.usage.inputTokens + projection.usage.outputTokens} tokens · ${projection.usage.providerRequests} calls · ${projection.usage.elapsedMs}ms`, "dim");
  return rows;
}

function formatPageEntry(entry: unknown, width: number): string {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const value = entry as Record<string, unknown>;
    const identity = value.path ?? value.type ?? value.digest ?? value.measurementId ?? value.operationId ?? value.sequence ?? "entry";
    const status = value.status ?? value.kind ?? value.at ?? value.createdAt ?? "";
    return truncateToWidth(`${safe(identity)}${status === "" ? "" : ` · ${safe(status)}`} · ${safe(stableJson(entry), 2_048)}`, width);
  }
  return truncateToWidth(safe(entry), width);
}

function selectableIdentities(projection: WorkflowRunProjection, view: WorkflowInspectorView, page?: WorkflowInspectorPage): string[] {
  if (view !== "overview") return (page?.entries ?? []).map((entry) => stableIdentity(entry));
  return [
    ...projection.attentionReasons.map((entry) => `attention:${entry.code}:${entry.operationId ?? ""}`),
    ...(projection.replay ? ["replay"] : []),
    ...projection.activeAgents.flatMap((agent) => [`agent:${agent.agentSessionId}`, ...agent.customMetrics.slice(0, 1).map(() => `agent-metrics:${agent.agentSessionId}`), ...(agent.resources ? [`agent-cgroup:${agent.agentSessionId}`] : []), ...agent.recentLogs.map((log) => `agent-log:${agent.agentSessionId}:${log.sequence}`)]),
    ...projection.checkpoints.map((entry) => `checkpoint:${entry.checkpointId}`),
    ...(projection.apply ? [`apply:${projection.apply.approvalId}`] : []),
    ...(projection.candidate ? [`candidate:${projection.candidate.candidateId}`] : []),
    ...projection.metrics.slice(0, 8).map((entry) => `metric:${entry.metricId}`),
    ...projection.phaseTree.slice(0, 32).map((entry) => `operation:${entry.operationId}`),
    ...projection.artifacts.slice(0, 12).map((entry) => `artifact:${entry.digest}`),
    ...(projection.phaseOperationOmittedCount ? ["omitted"] : []),
    "usage",
  ];
}
function overviewSelectableCount(projection: WorkflowRunProjection): number { return selectableIdentities(projection, "overview").length; }
function selectedIdentity(projection: WorkflowRunProjection, view: WorkflowInspectorView, page: WorkflowInspectorPage | undefined, index: number): string | undefined { return selectableIdentities(projection, view, page)[index]; }
function stableIdentity(entry: unknown): string {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const record = entry as Record<string, unknown>;
    for (const name of ["operationId", "digest", "measurementId", "sequence", "type", "path"]) if (record[name] !== undefined) return `${name}:${String(record[name])}`;
  }
  return stableJson(entry).slice(0, 512);
}
function resourceText(value: NonNullable<import("../runtime/durable-types.js").ResourceMeasurement>): string {
  return [value.cpuUsec !== undefined ? `cpu ${value.cpuUsec}µs` : "", value.memoryCurrentBytes !== undefined ? `mem ${value.memoryCurrentBytes}B` : "", value.memoryPeakBytes !== undefined ? `peak ${value.memoryPeakBytes}B` : "", value.ioReadBytes !== undefined || value.ioWriteBytes !== undefined ? `io ${(value.ioReadBytes ?? 0) + (value.ioWriteBytes ?? 0)}B` : "", value.tasksCurrent !== undefined ? `tasks ${value.tasksCurrent}` : ""].filter(Boolean).join(" · ");
}
function terminal(status: string): boolean { return status === "completed" || status === "failed" || status === "stopped"; }
function safe(value: unknown, maximum = 512): string { return boundedProjectionText(value, maximum); }
function safeError(error: unknown): string { return safe(error instanceof Error ? error.message : error, 1_024); }
function short(value: string): string { return safe(value).replace(/^sha256:/, "").slice(0, 12); }
function fg(theme: FlowThemeLike | undefined, color: string, text: string): string { return theme?.fg ? theme.fg(color, text) : text; }
