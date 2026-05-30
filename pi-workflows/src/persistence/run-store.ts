import fs from "node:fs";
import path from "node:path";
import type { RunManifest, RunRecord, RunStatus, WorkflowMeta, WorkflowProgressSnapshot } from "../types.js";
import { EXTENSION_VERSION } from "../constants.js";
import { sha256, stableHash } from "../utils/hashes.js";
import { createRunId, createTaskId, nowIso } from "../utils/ids.js";
import { toStableJsonValue } from "../utils/stable-json.js";
import { ensureDir, runRootForCwd } from "./paths.js";

export interface RunStoreCreateArgs {
  cwd: string;
  sessionId: string;
  taskId?: string;
  meta: WorkflowMeta;
  source: string;
  args: Record<string, unknown>;
  resumeFromRunId?: string;
}

export interface CreatedRun {
  record: RunRecord;
  runDir: string;
}

export interface RunControlLike {
  pause(): void;
  resume(): void;
  stop(reason?: string): void;
  skipAgent(callId: string): boolean;
}

export interface LiveRun {
  runId: string;
  sessionId: string;
  control: RunControlLike;
  donePromise: Promise<unknown>;
  notifyOnComplete: boolean;
}

export class RunStore {
  private static readonly saveDebounceMs = 100;

  private readonly runs = new Map<string, RunRecord>();
  private readonly runRoots = new Map<string, string>();
  private readonly controls = new Map<string, RunControlLike>();
  private readonly liveRuns = new Map<string, LiveRun>();
  private readonly saveQueues = new Map<string, Promise<void>>();
  private readonly saveTimers = new Map<string, NodeJS.Timeout>();
  private readonly scheduledSaves = new Map<string, RunRecord>();
  private currentRoot?: string;

  rootFor(cwd: string): string {
    this.currentRoot = runRootForCwd(cwd);
    return this.currentRoot;
  }

  async refresh(cwd: string): Promise<void> {
    const root = this.rootFor(cwd);
    await ensureDir(root);

    for (const [runId, runRoot] of this.runRoots) {
      if (runRoot === root && !this.controls.has(runId)) {
        this.runs.delete(runId);
        this.runRoots.delete(runId);
      }
    }

    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const recordPath = path.join(root, entry.name, "run.json");
      try {
        const record = JSON.parse(await fs.promises.readFile(recordPath, "utf8")) as RunRecord;
        if (this.controls.has(record.runId)) continue;
        this.runs.set(record.runId, record);
        this.runRoots.set(record.runId, root);
      } catch {
        // Invalid records should not poison extension startup.
      }
    }
  }

  async create(args: RunStoreCreateArgs): Promise<CreatedRun> {
    const root = this.rootFor(args.cwd);
    await ensureDir(root);
    const runId = createRunId();
    const runDir = path.join(root, runId);
    const transcriptDir = path.join(runDir, "subagents");
    await ensureDir(transcriptDir);
    await ensureDir(path.join(runDir, "ui"));

    const scriptPath = path.join(runDir, "script.js");
    const argsPath = path.join(runDir, "args.json");
    const journalPath = path.join(runDir, "journal.jsonl");
    const logsPath = path.join(runDir, "logs.jsonl");
    const manifestPath = path.join(runDir, "manifest.json");
    const startedAt = nowIso();
    const stableArgs = toStableJsonValue(args.args) as Record<string, unknown>;
    const argsHash = stableHash(stableArgs);
    const scriptHash = sha256(args.source);
    const progress: WorkflowProgressSnapshot = {
      total: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cached: 0,
      skipped: 0,
      calls: [],
      recentLogs: [],
      updatedAt: startedAt,
    };

    const record: RunRecord = {
      runId,
      taskId: args.taskId ?? createTaskId(),
      sessionId: args.sessionId,
      name: args.meta.name,
      title: args.meta.title,
      description: args.meta.description,
      phases: args.meta.phases,
      status: "running",
      scriptPath,
      runDir,
      journalPath,
      logsPath,
      manifestPath,
      argsPath,
      transcriptDir,
      startedAt,
      argsHash,
      scriptHash,
      resumeFromRunId: args.resumeFromRunId,
      progress,
      usage: { agentCount: 0, subagentTokens: 0, toolUses: 0, estimated: true },
      uiViews: [],
    };
    record.recovery = { scriptPath, resumeFromRunId: runId, args: stableArgs };

    await fs.promises.writeFile(scriptPath, args.source, "utf8");
    await fs.promises.writeFile(path.join(runDir, "meta.json"), `${JSON.stringify(args.meta, null, 2)}\n`, "utf8");
    await fs.promises.writeFile(argsPath, `${JSON.stringify(stableArgs, null, 2)}\n`, "utf8");
    await fs.promises.writeFile(journalPath, "", "utf8");
    await fs.promises.writeFile(logsPath, "", "utf8");
    this.runs.set(runId, record);
    this.runRoots.set(runId, root);
    await this.saveNow(record);
    return { record, runDir };
  }

  upsert(record: RunRecord): void {
    this.runs.set(record.runId, record);
    this.runRoots.set(record.runId, path.dirname(record.runDir));
    this.scheduleSave(record);
  }

  enqueueSave(runId: string, fn: () => Promise<void>): Promise<void> {
    const previous = this.saveQueues.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    this.saveQueues.set(runId, next);
    void next.then(
      () => {
        if (this.saveQueues.get(runId) === next) this.saveQueues.delete(runId);
      },
      () => {
        if (this.saveQueues.get(runId) === next) this.saveQueues.delete(runId);
      },
    );
    return next;
  }

  scheduleSave(record: RunRecord, delayMs = RunStore.saveDebounceMs): void {
    this.runs.set(record.runId, record);
    this.runRoots.set(record.runId, path.dirname(record.runDir));
    this.scheduledSaves.set(record.runId, record);
    if (this.saveTimers.has(record.runId)) return;
    const timer = setTimeout(() => {
      this.saveTimers.delete(record.runId);
      const scheduled = this.scheduledSaves.get(record.runId);
      this.scheduledSaves.delete(record.runId);
      if (scheduled) void this.saveNow(scheduled).catch(() => undefined);
    }, delayMs);
    timer.unref?.();
    this.saveTimers.set(record.runId, timer);
  }

  async flush(runId: string): Promise<void> {
    const timer = this.saveTimers.get(runId);
    const scheduled = this.scheduledSaves.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.saveTimers.delete(runId);
    }
    if (scheduled) {
      this.scheduledSaves.delete(runId);
      await this.saveNow(scheduled);
      return;
    }
    await (this.saveQueues.get(runId) ?? Promise.resolve());
  }

  async saveNow(record: RunRecord): Promise<void> {
    this.runs.set(record.runId, record);
    this.runRoots.set(record.runId, path.dirname(record.runDir));
    await this.enqueueSave(record.runId, async () => {
      await this.writeRunRecord(record);
      await this.writeManifest(record);
    });
  }

  private async writeRunRecord(record: RunRecord): Promise<void> {
    await atomicWriteJson(path.join(record.runDir, "run.json"), record);
  }

  private async writeManifest(record: RunRecord): Promise<void> {
    const subagents: RunManifest["subagents"] = [];
    try {
      const dirs = await fs.promises.readdir(record.transcriptDir, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const callDir = path.join(record.transcriptDir, dir.name);
        const transcriptPath = path.join(callDir, "transcript.json");
        const resultPath = path.join(callDir, "result.json");
        subagents.push({
          callId: dir.name,
          transcriptPath,
          resultPath: fs.existsSync(resultPath) ? resultPath : undefined,
        });
      }
    } catch {
      // ignored
    }
    const manifest: RunManifest = {
      runId: record.runId,
      createdBy: "pi-workflows",
      extensionVersion: EXTENSION_VERSION,
      scriptHash: record.scriptHash,
      argsHash: record.argsHash,
      scriptPath: record.scriptPath,
      journalPath: record.journalPath,
      outputPath: record.outputPath,
      runPath: record.runDir,
      uiViews: record.uiViews.map((view) => ({ viewId: view.viewId, specPath: view.specPath, latestStatePath: view.latestStatePath })),
      subagents,
      recovery: record.recovery,
    };
    await atomicWriteJson(record.manifestPath, manifest);
  }

  get(runId: string): RunRecord | undefined {
    if (this.currentRoot && this.runRoots.get(runId) !== this.currentRoot) return undefined;
    return this.runs.get(runId);
  }

  list(filter: "running" | "completed" | "all" = "all", limit = Infinity): RunRecord[] {
    const rows = [...this.runs.values()]
      .filter((run) => !this.currentRoot || this.runRoots.get(run.runId) === this.currentRoot)
      .filter((run) => {
        if (filter === "all") return true;
        if (filter === "running") return run.status === "running" || run.status === "paused";
        return run.status === "completed" || run.status === "failed" || run.status === "aborted" || run.status === "stale";
      })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return rows.slice(0, limit);
  }

  registerControl(runId: string, control: RunControlLike): void {
    this.controls.set(runId, control);
  }

  registerLiveRun(live: LiveRun): void {
    this.liveRuns.set(live.runId, live);
    this.controls.set(live.runId, live.control);
  }

  unregisterControl(runId: string): void {
    this.controls.delete(runId);
    this.liveRuns.delete(runId);
  }

  unregisterLiveRun(runId: string): void {
    this.unregisterControl(runId);
  }

  getControl(runId: string): RunControlLike | undefined {
    if (!this.get(runId)) return undefined;
    return this.controls.get(runId);
  }

  getLiveRun(runId: string): LiveRun | undefined {
    if (!this.get(runId)) return undefined;
    return this.liveRuns.get(runId);
  }

  shouldNotifyOnComplete(runId: string): boolean {
    return this.liveRuns.get(runId)?.notifyOnComplete ?? false;
  }

  suppressCompletion(runId: string): void {
    const live = this.liveRuns.get(runId);
    if (live) live.notifyOnComplete = false;
  }

  async stopLiveRunsForSession(sessionId: string | undefined, reason = "session shutdown"): Promise<number> {
    const liveRuns = [...this.liveRuns.values()].filter((live) => sessionId === undefined || live.sessionId === sessionId);
    for (const live of liveRuns) {
      live.notifyOnComplete = false;
      live.control.stop(reason);
      const record = this.runs.get(live.runId);
      if (!record || (record.status !== "running" && record.status !== "paused")) continue;
      record.status = "aborted";
      record.endedAt = nowIso();
      record.recovery = { scriptPath: record.scriptPath, resumeFromRunId: record.runId, args: record.recovery?.args };
      await this.flush(record.runId);
      await this.saveNow(record);
    }
    return liveRuns.length;
  }

  async setStatus(runId: string, status: RunStatus, extra?: Partial<RunRecord>): Promise<void> {
    const record = this.get(runId);
    if (!record) return;
    Object.assign(record, extra);
    record.status = status;
    if (status !== "running" && status !== "paused" && !record.endedAt) record.endedAt = nowIso();
    await this.flush(runId);
    await this.saveNow(record);
  }

  async delete(runId: string): Promise<boolean> {
    const record = this.get(runId);
    if (!record) return false;
    const control = this.controls.get(runId);
    if (control) control.stop("deleted");
    this.cancelScheduledSave(runId);
    await this.flush(runId).catch(() => undefined);
    this.controls.delete(runId);
    await fs.promises.rm(record.runDir, { recursive: true, force: true });
    this.runs.delete(runId);
    this.runRoots.delete(runId);
    return true;
  }

  async markStaleRunsForSession(cwd: string): Promise<number> {
    await this.refresh(cwd);
    let count = 0;
    for (const run of this.runs.values()) {
      if (this.currentRoot && this.runRoots.get(run.runId) !== this.currentRoot) continue;
      if ((run.status === "running" || run.status === "paused") && !this.controls.has(run.runId)) {
        run.status = "stale";
        run.endedAt = nowIso();
        run.recovery = { scriptPath: run.scriptPath, resumeFromRunId: run.runId };
        await this.flush(run.runId);
        await this.saveNow(run);
        count++;
      }
    }
    return count;
  }

  private cancelScheduledSave(runId: string): void {
    const timer = this.saveTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.saveTimers.delete(runId);
    this.scheduledSaves.delete(runId);
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await fs.promises.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}
