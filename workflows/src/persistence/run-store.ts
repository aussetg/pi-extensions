import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunManifest, RunRecord, RunStatus, WorkflowMeta, WorkflowProgressSnapshot } from "../types.js";
import { EXTENSION_VERSION, WORKFLOW_RESOURCE_LIMITS } from "../constants.js";
import { sha256, stableHash } from "../utils/hashes.js";
import { createRunId, createTaskId, nowIso } from "../utils/ids.js";
import { toStableJsonValue } from "../utils/stable-json.js";
import { ensureDir, runRootForCwd } from "./paths.js";
import { readBoundedTextFile } from "./safe-paths.js";

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

interface RunOwnerFile {
  version: 2;
  runId: string;
  sessionId: string;
  ownerId: string;
  pid: number;
  pidStartTime: string;
  bootId: string;
  createdAt: string;
  updatedAt: string;
}

interface RunOwnerIdentity {
  ownerId: string;
  createdAt: string;
}

interface ShutdownStop {
  reason: string;
  endedAt: string;
}

const RUN_OWNER_FILE = "owner.json";
const RUN_OWNER_HEARTBEAT_MS = 10_000;
const RUN_OWNER_STALE_MS = 60_000;
const RUN_SHUTDOWN_WAIT_MS = 500;

export class RunStore {
  private static readonly saveDebounceMs = 100;

  private readonly runs = new Map<string, RunRecord>();
  private readonly runRoots = new Map<string, string>();
  private readonly controls = new Map<string, RunControlLike>();
  private readonly liveRuns = new Map<string, LiveRun>();
  private readonly saveQueues = new Map<string, Promise<void>>();
  private readonly saveTimers = new Map<string, NodeJS.Timeout>();
  private readonly scheduledSaves = new Map<string, RunRecord>();
  private readonly ownerTimers = new Map<string, NodeJS.Timeout>();
  private readonly ownerIdentities = new Map<string, RunOwnerIdentity>();
  private readonly shutdownStops = new Map<string, ShutdownStop>();
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
        const record = normalizeLoadedRunRecord(JSON.parse(await readBoundedTextFile(recordPath, WORKFLOW_RESOURCE_LIMITS.runRecordBytes)), root, entry.name);
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

    const scriptPath = path.join(runDir, "script.js");
    const argsPath = path.join(runDir, "args.json");
    const journalPath = path.join(runDir, "journal.jsonl");
    const logsPath = path.join(runDir, "logs.jsonl");
    const manifestPath = path.join(runDir, "manifest.json");
    const startedAt = nowIso();
    const stableArgs = toStableJsonValue(args.args) as Record<string, unknown>;
    const stableArgsText = jsonTextWithinLimit(stableArgs, WORKFLOW_RESOURCE_LIMITS.runArgsBytes, "workflow args");
    const argsHash = stableHash(stableArgs);
    const scriptHash = sha256(args.source);
    const progress: WorkflowProgressSnapshot = {
      total: 0,
      running: 0,
      completed: 0,
      failed: 0,
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
    };
    record.recovery = { scriptPath, resumeFromRunId: runId, args: stableArgs };

    await fs.promises.writeFile(scriptPath, args.source, "utf8");
    await fs.promises.writeFile(path.join(runDir, "meta.json"), `${JSON.stringify(args.meta, null, 2)}\n`, "utf8");
    await fs.promises.writeFile(argsPath, stableArgsText, "utf8");
    await fs.promises.writeFile(journalPath, "", "utf8");
    await fs.promises.writeFile(logsPath, "", "utf8");
    await writeRunOwner(runDir, runId, args.sessionId, this.ownerIdentity(runId));
    this.runs.set(runId, record);
    this.runRoots.set(runId, root);
    await this.saveNow(record);
    return { record, runDir };
  }

  upsert(record: RunRecord): void {
    this.applyShutdownStop(record);
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
    this.applyShutdownStop(record);
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
    this.applyShutdownStop(record);
    this.runs.set(record.runId, record);
    this.runRoots.set(record.runId, path.dirname(record.runDir));
    await this.enqueueSave(record.runId, async () => {
      this.applyShutdownStop(record);
      await this.writeRunRecord(record);
      await this.writeManifest(record);
      if (isTerminalStatus(record.status)) await removeRunOwner(record.runDir).catch(() => undefined);
    });
  }

  private async writeRunRecord(record: RunRecord): Promise<void> {
    await atomicWriteJson(path.join(record.runDir, "run.json"), record, WORKFLOW_RESOURCE_LIMITS.runRecordBytes, "run.json");
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
      createdBy: "workflows",
      extensionVersion: EXTENSION_VERSION,
      scriptHash: record.scriptHash,
      argsHash: record.argsHash,
      scriptPath: record.scriptPath,
      journalPath: record.journalPath,
      outputPath: record.outputPath,
      runPath: record.runDir,
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
    this.startOwnerHeartbeat(live.runId, live.sessionId);
  }

  unregisterControl(runId: string): void {
    this.controls.delete(runId);
    this.liveRuns.delete(runId);
    this.stopOwnerHeartbeat(runId);
    this.shutdownStops.delete(runId);
    const record = this.runs.get(runId);
    if (record && isTerminalStatus(record.status)) {
      this.ownerIdentities.delete(runId);
      void removeRunOwner(record.runDir).catch(() => undefined);
    }
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

  async stopLiveRunsForSession(sessionId: string | undefined, reason = "session shutdown", waitMs = RUN_SHUTDOWN_WAIT_MS): Promise<number> {
    const liveRuns = [...this.liveRuns.values()].filter((live) => sessionId === undefined || live.sessionId === sessionId);
    const shutdownStops = new Map<string, ShutdownStop>();
    for (const live of liveRuns) {
      live.notifyOnComplete = false;
      const shutdownStop = this.recordShutdownStop(live.runId, reason);
      if (shutdownStop) shutdownStops.set(live.runId, shutdownStop);
      live.control.stop(reason);
    }

    await waitForLiveRunsToSettle(liveRuns, waitMs);

    for (const [runId, shutdownStop] of shutdownStops) {
      const record = this.runs.get(runId);
      if (!record) continue;
      this.applyShutdownStop(record, shutdownStop);
      await this.flush(runId);
      await this.saveNow(record);
    }
    return liveRuns.length;
  }

  private recordShutdownStop(runId: string, reason: string): ShutdownStop | undefined {
    const record = this.runs.get(runId);
    if (!record || (record.status !== "running" && record.status !== "paused")) return undefined;
    const existing = this.shutdownStops.get(runId);
    const shutdownStop = existing ?? { reason, endedAt: nowIso() };
    this.shutdownStops.set(runId, shutdownStop);
    this.applyShutdownStop(record, shutdownStop);
    return shutdownStop;
  }

  private applyShutdownStop(record: RunRecord, shutdownStop = this.shutdownStops.get(record.runId)): void {
    if (!shutdownStop) return;
    record.status = "aborted";
    record.endedAt = shutdownStop.endedAt;
    record.recovery = { scriptPath: record.scriptPath, resumeFromRunId: record.runId, args: record.recovery?.args };
    delete record.outputPath;
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
    const live = this.liveRuns.get(runId);
    if (live) {
      live.notifyOnComplete = false;
      this.stopOwnerHeartbeat(runId);
      live.control.stop("deleted");
      await live.donePromise.catch(() => undefined);
    } else {
      const control = this.controls.get(runId);
      if (control) control.stop("deleted");
    }
    this.cancelScheduledSave(runId);
    await this.flush(runId).catch(() => undefined);
    this.stopOwnerHeartbeat(runId);
    this.ownerIdentities.delete(runId);
    this.shutdownStops.delete(runId);
    this.controls.delete(runId);
    this.liveRuns.delete(runId);
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
        if (await hasLiveOwner(run)) continue;
        run.status = "stale";
        run.endedAt = nowIso();
        run.recovery = await recoveryForRun(run);
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

  private startOwnerHeartbeat(runId: string, sessionId: string): void {
    this.stopOwnerHeartbeat(runId);
    this.ownerIdentity(runId);
    void this.touchOwner(runId, sessionId).catch(() => undefined);
    const timer = setInterval(() => {
      void this.touchOwner(runId, sessionId).catch(() => undefined);
    }, RUN_OWNER_HEARTBEAT_MS);
    timer.unref?.();
    this.ownerTimers.set(runId, timer);
  }

  private stopOwnerHeartbeat(runId: string): void {
    const timer = this.ownerTimers.get(runId);
    if (timer) clearInterval(timer);
    this.ownerTimers.delete(runId);
  }

  private async touchOwner(runId: string, sessionId: string): Promise<void> {
    const record = this.runs.get(runId);
    if (!record || isTerminalStatus(record.status)) return;
    await writeRunOwner(record.runDir, runId, sessionId, this.ownerIdentity(runId));
  }

  private ownerIdentity(runId: string): RunOwnerIdentity {
    const existing = this.ownerIdentities.get(runId);
    if (existing) return existing;
    const identity = { ownerId: randomUUID(), createdAt: nowIso() };
    this.ownerIdentities.set(runId, identity);
    return identity;
  }
}

function normalizeLoadedRunRecord(raw: unknown, root: string, dirName: string): RunRecord {
  if (!isRecord(raw)) throw new Error("run.json must contain an object");
  if (typeof raw.runId !== "string" || raw.runId !== dirName) throw new Error("run.json runId must match its directory");

  const runDir = path.join(root, dirName);
  const paths = canonicalRunPaths(runDir);
  const { uiViews: _removedUiViews, ...persisted } = raw;
  const record = persisted as unknown as RunRecord;
  return {
    ...record,
    runDir,
    scriptPath: paths.scriptPath,
    journalPath: paths.journalPath,
    logsPath: paths.logsPath,
    manifestPath: paths.manifestPath,
    argsPath: paths.argsPath,
    transcriptDir: paths.transcriptDir,
    outputPath: scopedOrExistingDefault(record.outputPath, runDir, "output.json"),
    errorPath: scopedOrExistingDefault(record.errorPath, runDir, "error.json"),
    recovery: normalizeRecovery(record.recovery, paths.scriptPath, record.runId),
  };
}

function canonicalRunPaths(runDir: string): Pick<RunRecord, "scriptPath" | "journalPath" | "logsPath" | "manifestPath" | "argsPath" | "transcriptDir"> {
  return {
    scriptPath: path.join(runDir, "script.js"),
    journalPath: path.join(runDir, "journal.jsonl"),
    logsPath: path.join(runDir, "logs.jsonl"),
    manifestPath: path.join(runDir, "manifest.json"),
    argsPath: path.join(runDir, "args.json"),
    transcriptDir: path.join(runDir, "subagents"),
  };
}

function scopedOrExistingDefault(rawPath: unknown, runDir: string, fileName: string): string | undefined {
  const scoped = scopedPath(rawPath, runDir);
  if (scoped) return scoped;
  const fallback = path.join(runDir, fileName);
  return fs.existsSync(fallback) ? fallback : undefined;
}

function normalizeRecovery(rawRecovery: unknown, scriptPath: string, runId: string): RunRecord["recovery"] {
  if (!isRecord(rawRecovery)) return { scriptPath, resumeFromRunId: runId };
  const args = isRecord(rawRecovery.args) ? (rawRecovery.args as Record<string, unknown>) : undefined;
  return {
    scriptPath,
    resumeFromRunId: typeof rawRecovery.resumeFromRunId === "string" && rawRecovery.resumeFromRunId.trim() ? rawRecovery.resumeFromRunId : runId,
    ...(args ? { args } : {}),
  };
}

function scopedPath(rawPath: unknown, runDir: string): string | undefined {
  if (typeof rawPath !== "string" || rawPath.includes("\0")) return undefined;
  const resolved = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(runDir, rawPath));
  return isInsideOrSame(runDir, resolved) ? resolved : undefined;
}

function isInsideOrSame(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTerminalStatus(status: RunStatus): boolean {
  return status !== "running" && status !== "paused";
}

async function waitForLiveRunsToSettle(liveRuns: LiveRun[], waitMs: number): Promise<void> {
  if (liveRuns.length === 0 || waitMs <= 0) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
    timer.unref?.();
  });
  try {
    await Promise.race([Promise.allSettled(liveRuns.map((live) => live.donePromise)), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function writeRunOwner(runDir: string, runId: string, sessionId: string, identity: RunOwnerIdentity): Promise<void> {
  const processIdentity = await currentProcessIdentity(process.pid);
  if (!processIdentity) throw new Error("Could not determine workflow owner process identity");
  const owner: RunOwnerFile = {
    version: 2,
    runId,
    sessionId,
    ownerId: identity.ownerId,
    pid: process.pid,
    pidStartTime: processIdentity.pidStartTime,
    bootId: processIdentity.bootId,
    createdAt: identity.createdAt,
    updatedAt: nowIso(),
  };
  const filePath = runOwnerPath(runDir);
  const tmpPath = path.join(runDir, `.${RUN_OWNER_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await fs.promises.writeFile(tmpPath, jsonTextWithinLimit(owner, WORKFLOW_RESOURCE_LIMITS.runOwnerBytes, RUN_OWNER_FILE), "utf8");
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function removeRunOwner(runDir: string): Promise<void> {
  await fs.promises.rm(runOwnerPath(runDir), { force: true });
}

async function hasLiveOwner(run: RunRecord): Promise<boolean> {
  const owner = await readRunOwner(run.runDir);
  if (!owner || owner.runId !== run.runId || owner.sessionId !== run.sessionId || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  if (typeof owner.ownerId !== "string" || owner.ownerId.trim() === "") return false;
  const updatedAt = Date.parse(owner.updatedAt);
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > RUN_OWNER_STALE_MS) return false;
  const processIdentity = await currentProcessIdentity(owner.pid);
  if (!processIdentity || processIdentity.bootId !== owner.bootId || processIdentity.pidStartTime !== owner.pidStartTime) return false;
  return processIsAlive(owner.pid);
}

async function readRunOwner(runDir: string): Promise<RunOwnerFile | undefined> {
  try {
    const parsed = JSON.parse(await readBoundedTextFile(runOwnerPath(runDir), WORKFLOW_RESOURCE_LIMITS.runOwnerBytes)) as unknown;
    if (!isRecord(parsed) || parsed.version !== 2) return undefined;
    if (typeof parsed.runId !== "string" || typeof parsed.sessionId !== "string" || typeof parsed.ownerId !== "string" || typeof parsed.pid !== "number") return undefined;
    if (typeof parsed.pidStartTime !== "string" || typeof parsed.bootId !== "string" || typeof parsed.createdAt !== "string" || typeof parsed.updatedAt !== "string") return undefined;
    return parsed as unknown as RunOwnerFile;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function currentProcessIdentity(pid: number): Promise<{ bootId: string; pidStartTime: string } | undefined> {
  const [bootId, pidStartTime] = await Promise.all([readBootId(), readPidStartTime(pid)]);
  return bootId && pidStartTime ? { bootId, pidStartTime } : undefined;
}

async function readBootId(): Promise<string | undefined> {
  try {
    const bootId = (await readBoundedTextFile("/proc/sys/kernel/random/boot_id", 128)).trim();
    return bootId ? bootId : undefined;
  } catch {
    return undefined;
  }
}

async function readPidStartTime(pid: number): Promise<string | undefined> {
  try {
    const stat = await readBoundedTextFile(`/proc/${pid}/stat`, 4096);
    const endOfCommand = stat.lastIndexOf(")");
    if (endOfCommand === -1) return undefined;
    const fields = stat.slice(endOfCommand + 1).trim().split(/\s+/);
    const startTime = fields[19];
    return /^\d+$/.test(startTime) ? startTime : undefined;
  } catch {
    return undefined;
  }
}

async function recoveryForRun(run: RunRecord): Promise<RunRecord["recovery"]> {
  const args = run.recovery?.args ?? (await readArgsFile(run.argsPath));
  return { scriptPath: run.scriptPath, resumeFromRunId: run.runId, ...(args ? { args } : {}) };
}

async function readArgsFile(argsPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readBoundedTextFile(argsPath, WORKFLOW_RESOURCE_LIMITS.runArgsBytes)) as unknown;
    return isRecord(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function runOwnerPath(runDir: string): string {
  return path.join(runDir, RUN_OWNER_FILE);
}

async function atomicWriteJson(filePath: string, value: unknown, maxBytes?: number, label = path.basename(filePath)): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    const text = maxBytes === undefined ? `${JSON.stringify(value, null, 2)}\n` : jsonTextWithinLimit(value, maxBytes, label);
    await fs.promises.writeFile(tmpPath, text, "utf8");
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

function jsonTextWithinLimit(value: unknown, maxBytes: number, label: string): string {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return text;
}
