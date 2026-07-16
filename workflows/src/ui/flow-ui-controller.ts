import type { FlowForegroundCandidate, FlowForegroundSelectionOptions } from "./flow-selection.js";
import { formatFlowAggregateStatus, selectForegroundRun } from "./flow-selection.js";
import { FlowWidgetComponent } from "./flow-widget.js";
import type { WorkflowRunProjection } from "../projection/types.js";

export interface FlowUiContextLike {
  mode?: "tui" | "rpc" | "json" | "print";
  hasUI?: boolean;
  ui?: any;
}

/**
 * Thin Pi adapter around the presentation-neutral projection. It owns no run
 * state: discarding this object cannot pause, resume, or otherwise alter a
 * workflow.
 */
export class FlowUiController {
  private candidates: readonly FlowForegroundCandidate[] = [];
  private selection: FlowForegroundSelectionOptions = {};
  private readonly managed = new Map<string, FlowForegroundCandidate>();
  private readonly metadata = new Map<string, { sessionId?: string; projectId?: string; launchedSequence: number; awaitedToolActive?: boolean }>();
  private launchSequence = 0;
  private context?: FlowUiContextLike;
  private currentSessionId?: string;
  private currentProjectId?: string;
  private widget?: FlowWidgetComponent;
  private widgetRunId?: string;

  bind(ctx: FlowUiContextLike, identity: { sessionId?: string; projectId?: string } = {}): void {
    this.context = ctx;
    this.currentSessionId = identity.sessionId;
    this.currentProjectId = identity.projectId;
    this.renderManaged();
  }

  ensureRunCandidate(
    runId: string,
    metadata: { sessionId?: string; projectId?: string; origin?: string; source?: string; startedAt?: string } = {},
  ): void {
    const current = this.metadata.get(runId);
    this.metadata.set(runId, {
      ...(metadata.sessionId ? { sessionId: metadata.sessionId } : current?.sessionId ? { sessionId: current.sessionId } : {}),
      ...(metadata.projectId ? { projectId: metadata.projectId } : current?.projectId ? { projectId: current.projectId } : {}),
      launchedSequence: current?.launchedSequence ?? ++this.launchSequence,
      awaitedToolActive: current?.awaitedToolActive ?? false,
    });
  }

  updateRunCandidate(runId: string, projection: WorkflowRunProjection): void {
    if (!this.context) return;
    this.ensureRunCandidate(runId);
    const previous = this.managed.get(runId);
    const meta = this.metadata.get(runId)!;
    const ordinaryTerminal = ["completed", "failed", "stopped"].includes(projection.status);
    if (ordinaryTerminal) this.managed.delete(runId);
    else {
      this.managed.set(runId, {
        projection: structuredClone(projection),
        ...(meta.sessionId ? { uiOwnerSessionId: meta.sessionId } : {}),
        ...(this.currentSessionId ? { currentSessionId: this.currentSessionId } : {}),
        ...(meta.projectId ? { projectId: meta.projectId } : {}),
        ...(this.currentProjectId ? { currentProjectId: this.currentProjectId } : {}),
        awaitedToolActive: meta.awaitedToolActive ?? previous?.awaitedToolActive ?? false,
        launchedSequence: meta.launchedSequence,
      });
    }
    this.renderManaged();
  }

  markAwaitedTool(runId: string, active: boolean): void {
    const meta = this.metadata.get(runId);
    if (meta) this.metadata.set(runId, { ...meta, awaitedToolActive: active });
    const candidate = this.managed.get(runId);
    if (candidate) this.managed.set(runId, { ...candidate, awaitedToolActive: active });
    this.renderManaged();
  }

  removeRun(runId: string): void {
    this.managed.delete(runId);
    this.metadata.delete(runId);
    this.renderManaged();
  }

  focusRun(runId?: string): void {
    this.selection = runId ? { pinnedRunId: runId } : {};
    this.renderManaged();
  }

  update(
    ctx: FlowUiContextLike,
    candidates: readonly FlowForegroundCandidate[],
    selection: FlowForegroundSelectionOptions = {},
  ): void {
    this.context = ctx;
    this.candidates = candidates;
    this.selection = selection;
    if (!ctx.hasUI || (ctx.mode !== undefined && ctx.mode !== "tui")) return;
    const status = formatFlowAggregateStatus(candidates);
    ctx.ui?.setStatus?.("flow", status);
    const foreground = selectForegroundRun(candidates, selection);
    if (!foreground) {
      this.widget = undefined;
      this.widgetRunId = undefined;
      ctx.ui?.setWidget?.("flow", undefined);
      return;
    }
    if (!this.widget || this.widgetRunId !== foreground.projection.runId) {
      this.widget = new FlowWidgetComponent(foreground.projection);
      this.widgetRunId = foreground.projection.runId;
    } else {
      this.widget.update(foreground.projection);
    }
    const widget = this.widget;
    ctx.ui?.setWidget?.(
      "flow",
      (_tui: unknown, theme: unknown) => {
        widget.update(foreground.projection, theme as any);
        return widget;
      },
      { placement: "aboveEditor" },
    );
  }

  refresh(ctx: FlowUiContextLike): void {
    this.update(ctx, this.candidates, this.selection);
  }

  clear(ctx: FlowUiContextLike): void {
    this.candidates = [];
    this.selection = {};
    this.managed.clear();
    this.metadata.clear();
    this.widget = undefined;
    this.widgetRunId = undefined;
    ctx.ui?.setStatus?.("flow", undefined);
    ctx.ui?.setWidget?.("flow", undefined);
    this.context = undefined;
    this.currentSessionId = undefined;
    this.currentProjectId = undefined;
  }

  private renderManaged(): void {
    if (!this.context) return;
    const candidates = [...this.managed.values()].map((candidate) => ({
      ...candidate,
      ...(this.currentSessionId ? { currentSessionId: this.currentSessionId } : {}),
      ...(this.currentProjectId ? { currentProjectId: this.currentProjectId } : {}),
    }));
    this.update(this.context, candidates, this.selection);
  }
}

