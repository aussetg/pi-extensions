import path from "node:path";
import fs from "node:fs";
import type { AgentOptions, RunRecord, WorkflowCallProgress, WorkflowUsage } from "../types.js";
import { DEFAULT_LIMITS, WORKFLOW_ISOLATION_POLICY, WORKFLOW_RESOURCE_LIMITS } from "../constants.js";
import { WorkflowAgent } from "../agents/workflow-agent.js";
import { JsonlJournal, type ResumeIndex } from "../persistence/journal.js";
import { ensureDir, relativeToRun } from "../persistence/paths.js";
import { normalizeSafeRelativePath, readBoundedTextFile, safeResolveExistingDir, safeResolveExistingFile } from "../persistence/safe-paths.js";
import { sha256, stableHash } from "../utils/hashes.js";
import { nowIso } from "../utils/ids.js";
import { byteLength, truncateBytes } from "../utils/truncate.js";
import { modelPatternDeclaresThinking, type ModelRegistryModelLike, type ThinkingLevel } from "../thinking.js";
import { WorkflowBudget } from "./budget.js";
import { computeAgentChainKey } from "./cache-key.js";
import { WorkflowAgentCapError, WorkflowAbortError, WorkflowBudgetExceededError, WorkflowSkipAgentError } from "./errors.js";
import { RunControl } from "./run-control.js";
import { normalizeAgentOptions } from "./agent-options.js";

export class WorkflowAgentQuota {
  private used = 0;

  constructor(public readonly total: number) {}

  claim(): void {
    if (this.used >= this.total) throw new WorkflowAgentCapError(`Workflow agent cap exceeded (${this.total})`);
    this.used++;
  }

  assertCanStart(): void {
    if (this.used >= this.total) throw new WorkflowAgentCapError(`Workflow agent cap exceeded (${this.total})`);
  }

  remaining(): number {
    return Math.max(0, this.total - this.used);
  }

  usedCount(): number {
    return this.used;
  }
}

export interface SchedulerDeps {
  cwd: string;
  run: RunRecord;
  journal: JsonlJournal;
  control: RunControl;
  budget: WorkflowBudget;
  resumeIndex?: ResumeIndex;
  maxAgents: number;
  agentQuota?: WorkflowAgentQuota;
  defaultThinking?: ThinkingLevel;
  modelRegistryModels?: readonly ModelRegistryModelLike[];
  activeTools?: string[];
  persist: () => void;
  onProgress?: () => void;
}

export class WorkflowScheduler {
  private readonly limiter: AsyncLimiter;
  private readonly agentQuota: WorkflowAgentQuota;
  private readonly agent = new WorkflowAgent();
  private replayQueue: Promise<void> = Promise.resolve();
  private sequence = 0;
  private previousChainKey: string | undefined;
  private calls = new Map<string, WorkflowCallProgress>();
  private logEntries = 0;
  private logBytes = 0;
  private logSuppressed = false;

  constructor(private readonly deps: SchedulerDeps) {
    this.limiter = new AsyncLimiter(DEFAULT_LIMITS.agentConcurrency, deps.control.signal);
    this.agentQuota = deps.agentQuota ?? new WorkflowAgentQuota(deps.maxAgents);
  }

  async agentCall(prompt: unknown, opts: unknown = {}): Promise<unknown> {
    if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("agent(prompt, opts?) requires a non-empty string prompt");
    const normalizedOpts = normalizeAgentOptions(opts);
    this.deps.control.throwIfAborted();
    await this.deps.control.waitIfPaused();
    this.agentQuota.assertCanStart();
    const budgetReservation = await this.deps.budget.reserveExclusive(this.deps.control.signal);
    try {
      return await this.runAgentCall(prompt, normalizedOpts);
    } finally {
      budgetReservation.release();
    }
  }

  private async runAgentCall(prompt: string, opts: AgentOptions): Promise<unknown> {
    this.deps.control.throwIfAborted();
    await this.deps.control.waitIfPaused();
    this.agentQuota.claim();

    const effectiveOpts = withoutUndefinedProperties({
      ...opts,
      isolation: opts.isolation ?? WORKFLOW_ISOLATION_POLICY.directAgentDefault,
      thinking: opts.thinking ?? (modelPatternDeclaresThinking(opts.model, this.deps.modelRegistryModels) ? undefined : this.deps.defaultThinking),
    });

    const callId = String(++this.sequence).padStart(4, "0");
    const phase = effectiveOpts.phase ?? this.deps.run.phase;
    const label = effectiveOpts.label ?? `agent ${callId}`;
    const previousChainKey = this.previousChainKey;
    const chainKey = computeAgentChainKey({ previousChainKey, prompt, opts: { ...effectiveOpts, phase }, activeTools: this.deps.activeTools });
    this.previousChainKey = chainKey;

    const cached = await this.decideReplay(callId, chainKey, label, phase, effectiveOpts.thinking);
    if (cached.replayed) return cached.value;
    const call: WorkflowCallProgress = { callId, label, phase, model: effectiveOpts.model, thinking: effectiveOpts.thinking, agentType: effectiveOpts.agentType, status: "pending", startedAt: nowIso() };
    this.calls.set(callId, call);
    this.refreshProgress();
    await this.deps.journal.append({
      type: "agent_started",
      runId: this.deps.run.runId,
      time: nowIso(),
      callId,
      chainKey,
      previousChainKey,
      label,
      phase,
      promptHash: sha256(prompt),
      optsHash: stableHash(effectiveOpts),
    });

    const agentController = this.deps.control.registerAgent(callId);
    const started = Date.now();
    try {
      call.status = "running";
      this.refreshProgress();
      const result = await this.limiter.run(async () => {
        return await this.agent.run({
          callId,
          runId: this.deps.run.runId,
          cwd: this.deps.cwd,
          phase,
          label,
          prompt,
          options: effectiveOpts,
          transcriptDir: this.deps.run.transcriptDir,
          activeTools: this.deps.activeTools,
          signal: agentController.signal,
          stallMs: effectiveOpts.stallMs ?? DEFAULT_LIMITS.stallMs,
          stallRetries: DEFAULT_LIMITS.stallRetries,
        });
      });
      const durationMs = Date.now() - started;
      const usage: WorkflowUsage = { ...result.usage, durationMs };
      call.status = "done";
      call.endedAt = nowIso();
      call.resultPath = result.resultPath;
      call.usage = usage;
      if (result.model) call.model = result.model;
      this.addUsage(usage);
      this.deps.budget.charge(usage.subagentTokens);
      let budgetError: Error | undefined;
      try {
        this.deps.budget.assertWithinBudget();
      } catch (err) {
        budgetError = err as Error;
      }
      await this.deps.journal.append({
        type: "agent_result",
        runId: this.deps.run.runId,
        time: nowIso(),
        callId,
        chainKey,
        status: "done",
        resultPath: relativeToRun(this.deps.run.runDir, result.resultPath),
        usage,
        model: result.model,
        thinking: effectiveOpts.thinking,
      });
      this.refreshProgress();
      if (budgetError) throw budgetError;
      return result.result;
    } catch (err) {
      if (err instanceof WorkflowBudgetExceededError && call.status === "done") throw err;
      if (err instanceof WorkflowSkipAgentError || this.deps.control.isSkipped(callId)) {
        const resultPath = await this.writeSkippedResult(callId, effectiveOpts.thinking);
        call.status = "skipped";
        call.endedAt = nowIso();
        call.resultPath = resultPath;
        await this.deps.journal.append({
          type: "agent_result",
          runId: this.deps.run.runId,
          time: nowIso(),
          callId,
          chainKey,
          status: "skipped",
          resultPath: relativeToRun(this.deps.run.runDir, resultPath),
          thinking: effectiveOpts.thinking,
        });
        this.refreshProgress();
        return null;
      }
      call.status = err instanceof WorkflowAbortError ? "aborted" : "failed";
      call.error = (err as Error).message;
      call.endedAt = nowIso();
      await this.writeAgentError(callId, err, effectiveOpts.thinking);
      await this.deps.journal.append({
        type: "agent_result",
        runId: this.deps.run.runId,
        time: nowIso(),
        callId,
        chainKey,
        status: call.status === "aborted" ? "aborted" : "error",
        error: call.error,
        thinking: effectiveOpts.thinking,
      });
      this.refreshProgress();
      throw err;
    } finally {
      this.deps.control.unregisterAgent(callId);
    }
  }

  phase(title: string): void {
    this.deps.run.phase = String(title).slice(0, 200);
    this.deps.run.progress.phase = this.deps.run.phase;
    void this.deps.journal.append({ type: "phase", runId: this.deps.run.runId, time: nowIso(), phase: this.deps.run.phase }).catch(() => undefined);
    this.refreshProgress();
  }

  async log(message: string): Promise<void> {
    if (this.logSuppressed) return;
    const text = truncateBytes(String(message), WORKFLOW_RESOURCE_LIMITS.logMessageBytes);
    const line = `${JSON.stringify({ time: nowIso(), message: text })}\n`;
    const bytes = byteLength(line);
    if (this.logEntries >= WORKFLOW_RESOURCE_LIMITS.logEntries || this.logBytes + bytes > WORKFLOW_RESOURCE_LIMITS.logFileBytes) {
      await this.suppressFurtherLogs();
      return;
    }
    this.logEntries++;
    this.logBytes += bytes;
    this.deps.run.progress.recentLogs.push(text);
    this.deps.run.progress.recentLogs = this.deps.run.progress.recentLogs.slice(-20);
    await this.deps.journal.append({ type: "log", runId: this.deps.run.runId, time: nowIso(), message: text });
    await fs.promises.appendFile(this.deps.run.logsPath, line, "utf8");
    this.refreshProgress();
  }

  private async suppressFurtherLogs(): Promise<void> {
    if (this.logSuppressed) return;
    this.logSuppressed = true;
    const message = `workflow log quota reached; suppressing further log() output (${WORKFLOW_RESOURCE_LIMITS.logEntries} entries or ${WORKFLOW_RESOURCE_LIMITS.logFileBytes} bytes)`;
    this.deps.run.progress.recentLogs.push(message);
    this.deps.run.progress.recentLogs = this.deps.run.progress.recentLogs.slice(-20);
    const line = `${JSON.stringify({ time: nowIso(), message })}\n`;
    if (this.logBytes + byteLength(line) <= WORKFLOW_RESOURCE_LIMITS.logFileBytes) {
      this.logBytes += byteLength(line);
      await this.deps.journal.append({ type: "log", runId: this.deps.run.runId, time: nowIso(), message }).catch(() => undefined);
      await fs.promises.appendFile(this.deps.run.logsPath, line, "utf8").catch(() => undefined);
    }
    this.refreshProgress();
  }

  private async decideReplay(callId: string, chainKey: string, label: string, phase?: string, thinking?: ThinkingLevel): Promise<{ replayed: boolean; value?: unknown }> {
    if (!this.deps.resumeIndex) return { replayed: false };

    const previous = this.replayQueue;
    let release!: () => void;
    this.replayQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      const cached = await this.tryReplay(callId, chainKey, label, phase, thinking);
      if (!cached.replayed) this.deps.resumeIndex.disableAfterFirstMiss();
      return cached;
    } finally {
      release();
    }
  }

  private async tryReplay(callId: string, chainKey: string, label: string, phase?: string, thinking?: ThinkingLevel): Promise<{ replayed: boolean; value?: unknown }> {
    if (!this.deps.resumeIndex?.canReplay(chainKey)) return { replayed: false };
    const replay = await this.deps.resumeIndex.load(chainKey);
    if (!replay) return { replayed: false };
    const resultPath = await this.materializeReplayResult(callId, replay.sourcePath);
    const effectiveThinking = replay.thinking ?? thinking;
    const call: WorkflowCallProgress = { callId, label, phase, model: replay.model, thinking: effectiveThinking, usage: replay.usage, status: replay.status === "skipped" ? "skipped" : "cached", cached: true, startedAt: nowIso(), endedAt: nowIso(), resultPath };
    this.calls.set(callId, call);
    await this.deps.journal.append({
      type: "agent_result",
      runId: this.deps.run.runId,
      time: nowIso(),
      callId,
      chainKey,
      status: "cached",
      resultPath: relativeToRun(this.deps.run.runDir, resultPath),
      usage: replay.usage,
      model: replay.model,
      thinking: effectiveThinking,
    });
    this.refreshProgress();
    return { replayed: true, value: replay.value };
  }

  private async materializeReplayResult(callId: string, sourcePath: string): Promise<string> {
    const dir = path.join(this.deps.run.transcriptDir, callId);
    await fs.promises.mkdir(dir, { recursive: true });
    const resultPath = path.join(dir, "result.json");
    const parsed = JSON.parse(await readBoundedTextFile(sourcePath, WORKFLOW_RESOURCE_LIMITS.workflowReplayResultBytes)) as Record<string, unknown>;
    await this.materializeReplayWorkspace(parsed, sourcePath, dir);
    await fs.promises.writeFile(resultPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    return resultPath;
  }

  private async materializeReplayWorkspace(result: Record<string, unknown>, sourceResultPath: string, targetCallDir: string): Promise<void> {
    const workspace = result.workspace;
    if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return;
    const sourceWorkspace = workspace as Record<string, unknown>;
    if (sourceWorkspace.kind !== "worktree") return;

    const replayedWorkspace: Record<string, unknown> = {
      ...sourceWorkspace,
      worktreeDir: path.join(targetCallDir, "worktree"),
    };
    const errors: string[] = [];
    const sourceCallDir = path.dirname(sourceResultPath);

    const statusPath = await copyReplayFileArtifact(sourceWorkspace.statusPath, sourceCallDir, path.join(targetCallDir, "worktree-status.txt"), REPLAY_ARTIFACT_NAMES.status, WORKFLOW_RESOURCE_LIMITS.worktreeStatusBytes, errors, "status");
    if (statusPath) replayedWorkspace.statusPath = statusPath;
    else delete replayedWorkspace.statusPath;

    const patchPath = await copyReplayFileArtifact(sourceWorkspace.patchPath, sourceCallDir, path.join(targetCallDir, "worktree.patch"), REPLAY_ARTIFACT_NAMES.patch, WORKFLOW_RESOURCE_LIMITS.worktreePatchBytes, errors, "patch");
    if (patchPath) replayedWorkspace.patchPath = patchPath;
    else delete replayedWorkspace.patchPath;

    const ignored = await materializeReplayIgnoredArtifacts(sourceWorkspace, sourceCallDir, targetCallDir, errors);
    const ignoredManifestPath = ignored.ignoredManifestPath;
    if (ignoredManifestPath) replayedWorkspace.ignoredManifestPath = ignoredManifestPath;
    else delete replayedWorkspace.ignoredManifestPath;

    const ignoredFilesDir = ignored.ignoredFilesDir;
    if (ignoredFilesDir) replayedWorkspace.ignoredFilesDir = ignoredFilesDir;
    else delete replayedWorkspace.ignoredFilesDir;

    if (errors.length > 0) replayedWorkspace.error = [typeof replayedWorkspace.error === "string" ? replayedWorkspace.error : undefined, ...errors].filter(Boolean).join("; ");
    result.workspace = replayedWorkspace;
  }

  private refreshProgress(): void {
    const calls = [...this.calls.values()];
    this.deps.run.progress = {
      total: calls.length,
      running: calls.filter((c) => c.status === "running" || c.status === "pending").length,
      completed: calls.filter((c) => c.status === "done" || c.status === "cached").length,
      failed: calls.filter((c) => c.status === "failed" || c.status === "aborted").length,
      cached: calls.filter((c) => c.status === "cached").length,
      skipped: calls.filter((c) => c.status === "skipped").length,
      phase: this.deps.run.phase,
      calls,
      recentLogs: this.deps.run.progress.recentLogs.slice(-20),
      updatedAt: nowIso(),
    };
    this.deps.persist();
    this.deps.onProgress?.();
  }

  private addUsage(usage: WorkflowUsage): void {
    const target = this.deps.run.usage;
    target.agentCount += usage.agentCount;
    target.subagentTokens += usage.subagentTokens;
    target.toolUses += usage.toolUses;
    if (usage.durationMs !== undefined) target.durationMs = (target.durationMs ?? 0) + usage.durationMs;
    target.estimated = target.estimated || usage.estimated;
  }

  private async writeSkippedResult(callId: string, thinking?: ThinkingLevel): Promise<string> {
    const dir = path.join(this.deps.run.transcriptDir, callId);
    await fs.promises.mkdir(dir, { recursive: true });
    const resultPath = path.join(dir, "result.json");
    await fs.promises.writeFile(resultPath, `${JSON.stringify({ status: "skipped", result: null, thinking }, null, 2)}\n`, "utf8");
    return resultPath;
  }

  private async writeAgentError(callId: string, err: unknown, thinking?: ThinkingLevel): Promise<void> {
    const dir = path.join(this.deps.run.transcriptDir, callId);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, "error.json"), `${JSON.stringify({ error: (err as Error).message ?? String(err), thinking }, null, 2)}\n`, "utf8");
  }
}

function withoutUndefinedProperties(opts: AgentOptions): AgentOptions {
  return Object.fromEntries(Object.entries(opts).filter(([, value]) => value !== undefined)) as AgentOptions;
}

const REPLAY_ARTIFACT_NAMES = {
  status: /^worktree-status(?:-attempt-\d+)?\.txt$/,
  patch: /^worktree(?:-attempt-\d+)?\.patch$/,
  ignoredManifest: /^worktree-ignored(?:-attempt-\d+)?\.json$/,
  ignoredFilesDir: /^worktree-ignored(?:-attempt-\d+)?$/,
} as const;

async function copyReplayFileArtifact(sourceValue: unknown, sourceCallDir: string, targetPath: string, allowedName: RegExp, maxBytes: number, errors: string[], label: string): Promise<string | undefined> {
  if (!hasArtifactPath(sourceValue)) return undefined;
  const sourceName = replayArtifactBasename(sourceValue, allowedName);
  if (!sourceName) {
    errors.push(`could not materialize replayed worktree ${label} artifact: unsafe artifact path`);
    return undefined;
  }
  const source = await safeResolveExistingFile(sourceCallDir, sourceName, { maxBytes });
  if (!source) {
    errors.push(`could not materialize replayed worktree ${label} artifact: missing, unsafe, or too large`);
    return undefined;
  }
  try {
    await fs.promises.copyFile(source.path, targetPath);
    return targetPath;
  } catch (err) {
    errors.push(`could not materialize replayed worktree ${label} artifact: ${(err as Error).message}`);
    return undefined;
  }
}

async function materializeReplayIgnoredArtifacts(sourceWorkspace: Record<string, unknown>, sourceCallDir: string, targetCallDir: string, errors: string[]): Promise<{ ignoredManifestPath?: string; ignoredFilesDir?: string }> {
  if (!hasArtifactPath(sourceWorkspace.ignoredManifestPath)) return {};
  const manifestName = replayArtifactBasename(sourceWorkspace.ignoredManifestPath, REPLAY_ARTIFACT_NAMES.ignoredManifest);
  if (!manifestName) {
    errors.push("could not materialize replayed worktree ignored manifest artifact: unsafe artifact path");
    return {};
  }

  const sourceManifest = await safeResolveExistingFile(sourceCallDir, manifestName, { maxBytes: WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredListBytes });
  if (!sourceManifest) {
    errors.push("could not materialize replayed worktree ignored manifest artifact: missing, unsafe, or too large");
    return {};
  }

  let sourceManifestValue: Record<string, unknown>;
  try {
    sourceManifestValue = JSON.parse(await readBoundedTextFile(sourceManifest.path, WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredListBytes)) as Record<string, unknown>;
  } catch (err) {
    errors.push(`could not materialize replayed worktree ignored manifest artifact: ${(err as Error).message}`);
    return {};
  }

  if (!isIgnoredManifest(sourceManifestValue)) {
    errors.push("could not materialize replayed worktree ignored manifest artifact: malformed manifest");
    return {};
  }

  const sourceFilesName = replayArtifactBasename(sourceWorkspace.ignoredFilesDir, REPLAY_ARTIFACT_NAMES.ignoredFilesDir);
  const sourceFilesDir = sourceFilesName ? await safeResolveExistingDir(sourceCallDir, sourceFilesName) : undefined;
  const targetManifestPath = path.join(targetCallDir, "worktree-ignored.json");
  const targetFilesDir = path.join(targetCallDir, "worktree-ignored");
  await fs.promises.rm(targetFilesDir, { recursive: true, force: true });

  const outputFiles: unknown[] = [];
  const outputOmitted = Array.isArray(sourceManifestValue.omitted) ? [...sourceManifestValue.omitted] : [];
  let replayOmissions = 0;
  const omitReplay = (entry: Record<string, unknown>) => {
    outputOmitted.push(entry);
    replayOmissions++;
  };
  let totalBytes = 0;
  let copiedFiles = 0;
  const sourceEntries = sourceManifestValue.files;
  const entries = sourceEntries.slice(0, WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredFiles);
  if (sourceEntries.length > entries.length) {
    omitReplay({ path: "*", reason: "replay file count limit", bytes: sourceEntries.length - entries.length });
    errors.push("could not materialize all replayed worktree ignored files: file count limit");
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      omitReplay({ path: "*", reason: "replay malformed ignored artifact entry" });
      continue;
    }
    const object = entry as Record<string, unknown>;
    const relativePath = normalizeSafeRelativePath(object.path);
    if (!relativePath) {
      omitReplay({ path: typeof object.path === "string" ? object.path : "*", reason: "replay unsafe ignored artifact path" });
      continue;
    }

    if (object.type === "symlink") {
      const target = typeof object.target === "string" ? object.target : undefined;
      const bytes = target === undefined ? undefined : byteLength(target);
      if (target === undefined || bytes === undefined || bytes > WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredSymlinkBytes || totalBytes + bytes > WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredTotalBytes) {
        omitReplay({ path: relativePath, reason: "replay unsafe ignored symlink metadata", bytes });
        continue;
      }
      totalBytes += bytes;
      outputFiles.push({ path: relativePath, type: "symlink", bytes, target });
      continue;
    }

    if (object.type !== "file") {
      omitReplay({ path: relativePath, reason: "replay unsupported ignored artifact type" });
      continue;
    }

    const artifactPath = normalizeSafeRelativePath(typeof object.artifactPath === "string" ? object.artifactPath : object.path);
    const declaredBytes = nonNegativeInteger(object.bytes);
    if (!artifactPath || declaredBytes === undefined || declaredBytes > WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredFileBytes) {
      omitReplay({ path: relativePath, reason: "replay unsafe ignored artifact metadata", bytes: declaredBytes });
      continue;
    }
    if (!sourceFilesDir) {
      omitReplay({ path: relativePath, reason: "replay ignored files directory missing or unsafe", bytes: declaredBytes });
      continue;
    }

    const sourceFile = await safeResolveExistingFile(sourceFilesDir.path, artifactPath, { maxBytes: WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredFileBytes });
    if (!sourceFile) {
      omitReplay({ path: relativePath, reason: "replay ignored artifact missing, unsafe, or too large", bytes: declaredBytes });
      continue;
    }
    if (totalBytes + sourceFile.size > WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredTotalBytes) {
      omitReplay({ path: relativePath, reason: "replay ignored artifact total size limit", bytes: sourceFile.size });
      continue;
    }

    const targetFile = path.join(targetFilesDir, ...artifactPath.split("/"));
    try {
      await ensureDir(path.dirname(targetFile));
      await fs.promises.copyFile(sourceFile.path, targetFile);
    } catch (err) {
      omitReplay({ path: relativePath, reason: `replay ignored artifact copy failed: ${(err as Error).message}`, bytes: sourceFile.size });
      continue;
    }
    totalBytes += sourceFile.size;
    copiedFiles++;
    outputFiles.push({ path: relativePath, type: "file", bytes: sourceFile.size, artifactPath });
  }

  if (replayOmissions > 0) errors.push(`could not materialize ${replayOmissions} replayed worktree ignored artifact(s)`);

  const outputManifest = {
    ...sourceManifestValue,
    version: 1,
    kind: "worktree_ignored_files",
    limits: {
      maxFiles: WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredFiles,
      maxFileBytes: WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredFileBytes,
      maxTotalBytes: WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredTotalBytes,
    },
    totalBytes,
    files: outputFiles,
    omitted: outputOmitted,
  };
  const manifestText = `${JSON.stringify(outputManifest, null, 2)}\n`;
  if (byteLength(manifestText) > WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredListBytes) {
    errors.push("could not materialize replayed worktree ignored manifest artifact: sanitized manifest too large");
    await fs.promises.rm(targetFilesDir, { recursive: true, force: true });
    return {};
  }
  await fs.promises.writeFile(targetManifestPath, manifestText, "utf8");
  return { ignoredManifestPath: targetManifestPath, ignoredFilesDir: copiedFiles > 0 ? targetFilesDir : undefined };
}

function hasArtifactPath(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function replayArtifactBasename(value: unknown, allowedName: RegExp): string | undefined {
  if (!hasArtifactPath(value) || value.includes("\0")) return undefined;
  const withoutTrailingSlash = value.trim().replace(/[\\/]+$/, "");
  const basename = withoutTrailingSlash.split(/[\\/]/).pop() ?? "";
  return allowedName.test(basename) ? basename : undefined;
}

function isIgnoredManifest(value: Record<string, unknown>): value is Record<string, unknown> & { files: unknown[] } {
  return value.kind === "worktree_ignored_files" && Array.isArray(value.files);
}

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.ceil(value);
}

class AsyncLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number, private readonly signal: AbortSignal) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.signal.aborted) throw new WorkflowAbortError();
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(new WorkflowAbortError());
        };
        const cleanup = () => this.signal.removeEventListener("abort", abort);
        this.signal.addEventListener("abort", abort, { once: true });
        this.queue.push(wake);
      });
    }
    if (this.signal.aborted) throw new WorkflowAbortError();
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
