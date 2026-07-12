import path from "node:path";
import fs from "node:fs";
import type { AgentOptions, RunRecord, WorkflowCallProgress, WorkflowUsage } from "../types.js";
import { DEFAULT_LIMITS, WORKFLOW_ISOLATION_POLICY, WORKFLOW_RESOURCE_LIMITS } from "../constants.js";
import { WorkflowAgent } from "../agents/workflow-agent.js";
import { JsonlJournal } from "../persistence/journal.js";
import { relativeToRun } from "../persistence/paths.js";
import { sha256, stableHash } from "../utils/hashes.js";
import { nowIso } from "../utils/ids.js";
import { byteLength, truncateBytes } from "../utils/truncate.js";
import { modelPatternDeclaresThinking, type ModelRegistryModelLike, type ThinkingLevel } from "../thinking.js";
import { WorkflowBudget } from "./budget.js";
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
  private sequence = 0;
  private calls = new Map<string, WorkflowCallProgress>();
  private logEntries = 0;
  private logBytes = 0;
  private logSuppressed = false;

  constructor(private readonly deps: SchedulerDeps) {
    this.limiter = new AsyncLimiter(DEFAULT_LIMITS.agentConcurrency);
    this.agentQuota = deps.agentQuota ?? new WorkflowAgentQuota(deps.maxAgents);
  }

  async agentCall(prompt: unknown, opts: unknown = {}, signal?: AbortSignal): Promise<unknown> {
    if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("agent(prompt, opts?) requires a non-empty string prompt");
    const normalizedOpts = normalizeAgentOptions(opts);
    const operationSignal = linkAbortSignals(this.deps.control.signal, signal);
    this.deps.control.throwIfAborted();
    throwIfOperationAborted(operationSignal.signal);
    await this.deps.control.waitIfPaused(operationSignal.signal);
    this.agentQuota.assertCanStart();
    let budgetReservation: Awaited<ReturnType<WorkflowBudget["reserveExclusive"]>> | undefined;
    try {
      budgetReservation = await this.deps.budget.reserveExclusive(operationSignal.signal);
      return await this.runAgentCall(prompt, normalizedOpts, operationSignal.signal);
    } finally {
      budgetReservation?.release();
      operationSignal.cleanup();
    }
  }

  private async runAgentCall(prompt: string, opts: AgentOptions, signal?: AbortSignal): Promise<unknown> {
    this.deps.control.throwIfAborted();
    throwIfOperationAborted(signal);
    await this.deps.control.waitIfPaused(signal);
    this.agentQuota.claim();

    const effectiveOpts = withoutUndefinedProperties({
      ...opts,
      isolation: opts.isolation ?? WORKFLOW_ISOLATION_POLICY.directAgentDefault,
      thinking: opts.thinking ?? (modelPatternDeclaresThinking(opts.model, this.deps.modelRegistryModels) ? undefined : this.deps.defaultThinking),
    });

    const callId = String(++this.sequence).padStart(4, "0");
    const phase = effectiveOpts.phase ?? this.deps.run.phase;
    const label = effectiveOpts.label ?? `agent ${callId}`;
    const call: WorkflowCallProgress = { callId, label, phase, model: effectiveOpts.model, thinking: effectiveOpts.thinking, agentType: effectiveOpts.agentType, status: "pending", startedAt: nowIso() };
    this.calls.set(callId, call);
    this.refreshProgress();
    await this.deps.journal.append({
      type: "agent_started",
      runId: this.deps.run.runId,
      time: nowIso(),
      callId,
      label,
      phase,
      promptHash: sha256(prompt),
      optsHash: stableHash(effectiveOpts),
    });

    const agentController = this.deps.control.registerAgent(callId, signal);
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
      }, agentController.signal);
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

  private refreshProgress(): void {
    const calls = [...this.calls.values()];
    this.deps.run.progress = {
      total: calls.length,
      running: calls.filter((c) => c.status === "running" || c.status === "pending").length,
      completed: calls.filter((c) => c.status === "done").length,
      failed: calls.filter((c) => c.status === "failed" || c.status === "aborted").length,
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

class AsyncLimiter {
  private active = 0;
  private readonly queue: AsyncLimiterWaiter[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const reservation = await this.acquire(signal);
    try {
      throwIfLimiterAborted(signal);
      return await fn();
    } finally {
      reservation.release();
    }
  }

  private async acquire(signal?: AbortSignal): Promise<AsyncLimiterReservation> {
    throwIfLimiterAborted(signal);
    if (this.active < this.limit) {
      this.active++;
      return this.reservation();
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: AsyncLimiterWaiter = {
        settled: false,
        wake: () => undefined,
        abort: () => undefined,
      };
      const cleanup = () => {
        const index = this.queue.indexOf(waiter);
        if (index !== -1) this.queue.splice(index, 1);
        signal?.removeEventListener("abort", waiter.abort);
      };
      waiter.wake = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        cleanup();
        this.active++;
        resolve();
      };
      waiter.abort = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        cleanup();
        reject(limiterAbortError(signal));
        this.wakeNext();
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.queue.push(waiter);
      if (signal?.aborted) waiter.abort();
    });

    return this.reservation();
  }

  private reservation(): AsyncLimiterReservation {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        this.wakeNext();
      },
    };
  }

  private wakeNext(): void {
    while (this.active < this.limit) {
      const waiter = this.queue.shift();
      if (!waiter) return;
      if (waiter.settled) continue;
      waiter.wake();
      return;
    }
  }
}

interface AsyncLimiterWaiter {
  settled: boolean;
  wake(): void;
  abort(): void;
}

interface AsyncLimiterReservation {
  release(): void;
}

interface LinkedAbortSignal {
  signal: AbortSignal;
  cleanup(): void;
}

function linkAbortSignals(...signals: Array<AbortSignal | undefined>): LinkedAbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return { signal: new AbortController().signal, cleanup: () => undefined };
  if (active.length === 1) return { signal: active[0], cleanup: () => undefined };
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  const abortFrom = (source: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(source.reason instanceof Error ? source.reason : new WorkflowAbortError());
  };
  for (const signal of active) {
    if (signal.aborted) {
      abortFrom(signal);
      continue;
    }
    const listener = () => abortFrom(signal);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push(() => signal.removeEventListener("abort", listener));
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const remove of listeners.splice(0)) remove();
    },
  };
}

function throwIfOperationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new WorkflowAbortError();
}

function throwIfLimiterAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw limiterAbortError(signal);
}

function limiterAbortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new WorkflowAbortError();
}
