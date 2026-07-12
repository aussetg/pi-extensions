import fs from "node:fs";
import path from "node:path";
import type { JsonObject, RunRecord, WorkflowViewPlacement, WorkflowViewSnapshot, WorkflowViewSpec } from "../types.js";
import { UI_LIMITS } from "../constants.js";
import { nowIso } from "../utils/ids.js";
import { relativeToRun } from "../persistence/paths.js";
import { JsonlJournal } from "../persistence/journal.js";
import { RunStore } from "../persistence/run-store.js";
import { readBoundedTextFile } from "../persistence/safe-paths.js";
import { WorkflowViewValidator } from "./workflow-view-validator.js";

export class WorkflowViewStore {
  private readonly validator = new WorkflowViewValidator();
  private readonly views = new Map<string, WorkflowViewSnapshot>();
  private readonly lastFlushMs = new Map<string, number>();
  private readonly dirtySeq = new Map<string, number>();
  private readonly flushedSeq = new Map<string, number>();
  private readonly flushTimers = new Map<string, NodeJS.Timeout>();
  private readonly flushPromises = new Map<string, Promise<void>>();
  private readonly historyCounts = new Map<string, number>();
  private readonly closedViews = new Set<string>();

  constructor(
    private readonly run: RunRecord,
    private readonly journal: JsonlJournal,
    private readonly runStore: RunStore,
    private readonly onUpdate?: (viewId: string, snapshot: WorkflowViewSnapshot) => void,
    private readonly onClose?: (viewId: string, snapshot: WorkflowViewSnapshot) => void,
  ) {}

  async define(specInput: unknown): Promise<{ id: string }> {
    const spec = this.validator.validateSpec(specInput, new Set(this.views.keys()));
    if (this.views.size >= 5) throw new Error("A workflow run may define at most 5 UI views");
    const state = this.validator.validateState(spec, spec.initialState ?? {});
    const viewDir = path.join(this.run.runDir, "ui", spec.id);
    await fs.promises.mkdir(viewDir, { recursive: true });
    const specPath = path.join(viewDir, "spec.json");
    const latestStatePath = path.join(viewDir, "state-latest.json");
    await fs.promises.writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
    await fs.promises.writeFile(latestStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    const snapshot: WorkflowViewSnapshot = { spec, state, seq: 0 };
    this.views.set(spec.id, snapshot);
    this.dirtySeq.set(spec.id, 0);
    this.flushedSeq.set(spec.id, 0);
    this.historyCounts.set(spec.id, 0);
    this.run.uiViews.push({ viewId: spec.id, title: spec.title, specPath, latestStatePath });
    await this.journal.append({ type: "ui_defined", runId: this.run.runId, time: nowIso(), viewId: spec.id, specPath: relativeToRun(this.run.runDir, specPath) });
    await this.journal.append({ type: "ui_state", runId: this.run.runId, time: nowIso(), viewId: spec.id, seq: 0, statePath: relativeToRun(this.run.runDir, latestStatePath) });
    this.lastFlushMs.set(spec.id, Date.now());
    await this.runStore.saveNow(this.run);
    this.onUpdate?.(spec.id, cloneSnapshot(snapshot));
    return { id: spec.id };
  }

  async update(viewId: string, stateInput: unknown): Promise<void> {
    const snapshot = this.views.get(viewId);
    if (!snapshot) throw new Error(`Unknown workflow UI view: ${viewId}`);
    if (this.closedViews.has(viewId)) throw new Error(`Workflow UI view is closed: ${viewId}`);
    const state = this.validator.validateState(snapshot.spec, stateInput);
    snapshot.state = state;
    snapshot.seq++;
    this.dirtySeq.set(viewId, snapshot.seq);
    this.scheduleFlush(viewId);
  }

  async close(viewId: string): Promise<void> {
    const snapshot = this.views.get(viewId);
    if (!snapshot) throw new Error(`Unknown workflow UI view: ${viewId}`);
    await this.forceFlushView(viewId);
    if (this.closedViews.has(viewId)) return;
    this.closedViews.add(viewId);
    await this.journal.append({ type: "ui_closed", runId: this.run.runId, time: nowIso(), viewId });
    await this.runStore.saveNow(this.run);
    this.onClose?.(viewId, cloneSnapshot(snapshot));
  }

  async flush(): Promise<void> {
    const viewIds = [...this.views.keys()];
    await Promise.all(viewIds.map((viewId) => this.forceFlushView(viewId)));
  }

  private async forceFlushView(viewId: string): Promise<void> {
    this.cancelFlushTimer(viewId);
    await (this.flushPromises.get(viewId) ?? Promise.resolve());
    this.cancelFlushTimer(viewId);
    if (this.isDirty(viewId)) await this.startFlush(viewId);
  }

  private scheduleFlush(viewId: string): void {
    if (this.flushTimers.has(viewId) || this.flushPromises.has(viewId) || !this.isDirty(viewId)) return;
    const snapshot = this.views.get(viewId);
    if (!snapshot) return;
    const interval = updateIntervalMs(snapshot.spec.limits?.updateHz ?? UI_LIMITS.maxUpdateHz);
    const wait = Math.max(0, interval - (Date.now() - (this.lastFlushMs.get(viewId) ?? 0)));
    const timer = setTimeout(() => {
      this.flushTimers.delete(viewId);
      void this.startFlush(viewId).catch(() => undefined);
    }, wait);
    timer.unref?.();
    this.flushTimers.set(viewId, timer);
  }

  private startFlush(viewId: string): Promise<void> {
    const existing = this.flushPromises.get(viewId);
    if (existing) return existing;
    const promise = this.flushViewNow(viewId).finally(() => {
      this.flushPromises.delete(viewId);
      if (this.isDirty(viewId)) this.scheduleFlush(viewId);
    });
    this.flushPromises.set(viewId, promise);
    return promise;
  }

  private async flushViewNow(viewId: string): Promise<void> {
    const snapshot = this.views.get(viewId);
    if (!snapshot || !this.isDirty(viewId)) return;
    const seq = snapshot.seq;
    const state = structuredClone(snapshot.state) as JsonObject;
    const viewDir = path.join(this.run.runDir, "ui", viewId);
    const latestStatePath = path.join(viewDir, "state-latest.json");
    await fs.promises.writeFile(latestStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    const historyCount = this.historyCounts.get(viewId) ?? 0;
    if (historyCount < UI_LIMITS.maxStateSnapshotsPerView) {
      const numbered = path.join(viewDir, `state-${String(seq).padStart(4, "0")}.json`);
      await fs.promises.writeFile(numbered, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      this.historyCounts.set(viewId, historyCount + 1);
      await this.journal.append({ type: "ui_state", runId: this.run.runId, time: nowIso(), viewId, seq, statePath: relativeToRun(this.run.runDir, numbered) });
    }
    this.lastFlushMs.set(viewId, Date.now());
    this.flushedSeq.set(viewId, seq);
    this.onUpdate?.(viewId, { spec: snapshot.spec, state, seq });
  }

  private cancelFlushTimer(viewId: string): void {
    const timer = this.flushTimers.get(viewId);
    if (timer) clearTimeout(timer);
    this.flushTimers.delete(viewId);
  }

  private isDirty(viewId: string): boolean {
    return (this.dirtySeq.get(viewId) ?? 0) > (this.flushedSeq.get(viewId) ?? 0);
  }

  get(viewId: string): WorkflowViewSnapshot | undefined {
    return this.views.get(viewId);
  }

  list(): WorkflowViewSnapshot[] {
    return [...this.views.values()];
  }

  listByPlacement(...placements: WorkflowViewPlacement[]): WorkflowViewSnapshot[] {
    const wanted = new Set(placements);
    return this.list().filter((snapshot) => !this.closedViews.has(snapshot.spec.id) && wanted.has(workflowViewPlacement(snapshot)));
  }
}

function updateIntervalMs(updateHz: number): number {
  return Math.max(250, Math.ceil(1000 / Math.min(UI_LIMITS.maxUpdateHz, Math.max(0.1, updateHz))));
}

function cloneSnapshot(snapshot: WorkflowViewSnapshot): WorkflowViewSnapshot {
  return structuredClone(snapshot) as WorkflowViewSnapshot;
}

export function workflowViewPlacement(snapshot: WorkflowViewSnapshot): WorkflowViewPlacement {
  return snapshot.spec.placement ?? "runPanel";
}

export async function loadViewSnapshot(run: RunRecord, viewId?: string): Promise<WorkflowViewSnapshot | undefined> {
  const view = viewId ? run.uiViews.find((v) => v.viewId === viewId) : run.uiViews[0];
  if (!view) return undefined;
  const [spec, state] = await Promise.all([
    readBoundedTextFile(view.specPath, UI_LIMITS.maxSpecBytes * 2).then((s) => JSON.parse(s) as WorkflowViewSpec),
    readBoundedTextFile(view.latestStatePath, UI_LIMITS.maxStateBytes * 2).then((s) => JSON.parse(s) as JsonObject),
  ]);
  return { spec, state, seq: 0 };
}
