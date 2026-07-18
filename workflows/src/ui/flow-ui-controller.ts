import type { WorkflowRunProjection } from "../projection/types.js";

export interface FlowUiContextLike {
  mode?: "tui" | "rpc" | "json" | "print";
  hasUI?: boolean;
  ui?: any;
}

/** Presentation-only aggregate status for active schema-4 runs. */
export class FlowUiController {
  private context?: FlowUiContextLike;
  private readonly active = new Map<string, WorkflowRunProjection>();

  bind(ctx: FlowUiContextLike, _identity: { sessionId?: string; projectId?: string } = {}): void {
    this.context = ctx;
    this.render();
  }

  updateRunCandidate(runId: string, projection: WorkflowRunProjection): void {
    if (["completed", "failed", "stopped"].includes(projection.status)) this.active.delete(runId);
    else this.active.set(runId, structuredClone(projection));
    this.render();
  }

  clear(ctx: FlowUiContextLike): void {
    this.active.clear();
    ctx.ui?.setStatus?.("flow", undefined);
    ctx.ui?.setWidget?.("flow", undefined);
    this.context = undefined;
  }

  private render(): void {
    const ctx = this.context;
    if (!ctx?.hasUI || (ctx.mode !== undefined && ctx.mode !== "tui")) return;
    const runs = [...this.active.values()];
    if (!runs.length) {
      ctx.ui?.setStatus?.("flow", undefined);
      ctx.ui?.setWidget?.("flow", undefined);
      return;
    }
    const waiting = runs.filter(run => run.status === "waiting" || run.status === "paused").length;
    const effects = runs.reduce((count, run) => count + (run.operationCounts.running ?? 0), 0);
    ctx.ui?.setStatus?.("flow", `${runs.length} workflow${runs.length === 1 ? "" : "s"} · ${effects} effects${waiting ? ` · ${waiting} waiting` : ""}`);
  }
}
