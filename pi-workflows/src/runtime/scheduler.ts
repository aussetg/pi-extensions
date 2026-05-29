import path from "node:path";
import fs from "node:fs";
import type { AgentOptions, RunRecord, WorkflowCallProgress, WorkflowUsage } from "../types.js";
import { DEFAULT_LIMITS } from "../constants.js";
import { WorkflowAgent } from "../agents/workflow-agent.js";
import { JsonlJournal, type ResumeIndex } from "../persistence/journal.js";
import { relativeToRun } from "../persistence/paths.js";
import { sha256, stableHash } from "../utils/hashes.js";
import { nowIso } from "../utils/ids.js";
import { WorkflowBudget } from "./budget.js";
import { WorkflowAgentCapError, WorkflowAbortError, WorkflowSkipAgentError, isBudgetOrAbortError } from "./errors.js";
import { RunControl } from "./run-control.js";

export interface SchedulerDeps {
  cwd: string;
  run: RunRecord;
  journal: JsonlJournal;
  control: RunControl;
  budget: WorkflowBudget;
  resumeIndex?: ResumeIndex;
  maxAgents: number;
  activeTools?: string[];
  persist: () => void;
  onProgress?: () => void;
}

export class WorkflowScheduler {
  private readonly limiter: AsyncLimiter;
  private readonly pipelineLimiter: AsyncLimiter;
  private readonly agent = new WorkflowAgent();
  private sequence = 0;
  private previousChainKey: string | undefined;
  private calls = new Map<string, WorkflowCallProgress>();
  private isolatedSectionDepth = 0;

  constructor(private readonly deps: SchedulerDeps) {
    this.limiter = new AsyncLimiter(DEFAULT_LIMITS.agentConcurrency, deps.control.signal);
    this.pipelineLimiter = new AsyncLimiter(DEFAULT_LIMITS.pipelineSchedulingLimit, deps.control.signal);
  }

  async agentCall(prompt: unknown, opts: AgentOptions = {}): Promise<unknown> {
    if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("agent(prompt, opts?) requires a non-empty string prompt");
    this.deps.control.throwIfAborted();
    await this.deps.control.waitIfPaused();
    this.deps.budget.assertCanStart();
    if (this.sequence >= this.deps.maxAgents) throw new WorkflowAgentCapError(`Workflow agent cap exceeded (${this.deps.maxAgents})`);

    const effectiveOpts: AgentOptions = { ...opts, isolation: opts.isolation ?? (this.isolatedSectionDepth > 0 ? "worktree" : "shared") };

    const callId = String(++this.sequence).padStart(4, "0");
    const phase = effectiveOpts.phase ?? this.deps.run.phase;
    const label = effectiveOpts.label ?? `agent ${callId}`;
    const previousChainKey = this.previousChainKey;
    const chainKey = computeChainKey(previousChainKey, prompt, { ...effectiveOpts, phase }, this.deps.run.argsHash, this.deps.run.scriptHash);
    this.previousChainKey = chainKey;

    const cached = await this.tryReplay(callId, chainKey, label, phase);
    if (cached.replayed) return cached.value;

    this.deps.resumeIndex?.disableAfterFirstMiss();
    const call: WorkflowCallProgress = { callId, label, phase, model: effectiveOpts.model, agentType: effectiveOpts.agentType, status: "pending", startedAt: nowIso() };
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
      call.status = "done";
      call.endedAt = nowIso();
      call.resultPath = result.resultPath;
      this.addUsage(result.usage, Date.now() - started);
      this.deps.budget.charge(result.usage.subagentTokens);
      await this.deps.journal.append({
        type: "agent_result",
        runId: this.deps.run.runId,
        time: nowIso(),
        callId,
        chainKey,
        status: "done",
        resultPath: relativeToRun(this.deps.run.runDir, result.resultPath),
        usage: result.usage as unknown as Record<string, unknown>,
      });
      this.refreshProgress();
      return result.result;
    } catch (err) {
      if (err instanceof WorkflowSkipAgentError || this.deps.control.isSkipped(callId)) {
        const resultPath = await this.writeSkippedResult(callId);
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
        });
        this.refreshProgress();
        return null;
      }
      call.status = err instanceof WorkflowAbortError ? "aborted" : "failed";
      call.error = (err as Error).message;
      call.endedAt = nowIso();
      await this.writeAgentError(callId, err);
      await this.deps.journal.append({
        type: "agent_result",
        runId: this.deps.run.runId,
        time: nowIso(),
        callId,
        chainKey,
        status: call.status === "aborted" ? "aborted" : "error",
        error: call.error,
      });
      this.refreshProgress();
      throw err;
    } finally {
      this.deps.control.unregisterAgent(callId);
    }
  }

  async parallel(thunks: unknown): Promise<unknown[]> {
    if (!Array.isArray(thunks) || thunks.some((thunk) => typeof thunk !== "function")) {
      throw new Error("parallel() expects an array of thunk functions, e.g. items.map(x => () => agent(...))");
    }
    return await Promise.all(
      thunks.map(async (thunk, index) => {
        try {
          return await this.withIsolatedSection(async () => await (thunk as () => Promise<unknown>)());
        } catch (err) {
          if (isBudgetOrAbortError(err)) throw err;
          await this.log(`parallel branch ${index} failed: ${(err as Error).message}`);
          return null;
        }
      }),
    );
  }

  async pipeline(items: unknown, ...stages: unknown[]): Promise<unknown[]> {
    if (!Array.isArray(items)) throw new Error("pipeline(items, ...stages) expects items to be an array");
    if (stages.length === 0 || stages.some((stage) => typeof stage !== "function")) throw new Error("pipeline() expects one or more stage functions");
    const results = new Array(items.length);
    await Promise.all(
      items.map((item, index) =>
        this.pipelineLimiter.run(async () => {
          let current: unknown = item;
          try {
            for (const stage of stages) current = await this.withIsolatedSection(async () => await (stage as (input: unknown, index: number) => Promise<unknown>)(current, index));
            results[index] = current;
          } catch (err) {
            if (isBudgetOrAbortError(err)) throw err;
            await this.log(`pipeline item ${index} failed: ${(err as Error).message}`);
            results[index] = null;
          }
        }),
      ),
    );
    return results;
  }

  private async withIsolatedSection<T>(fn: () => Promise<T>): Promise<T> {
    this.isolatedSectionDepth++;
    try {
      return await fn();
    } finally {
      this.isolatedSectionDepth--;
    }
  }

  phase(title: string): void {
    this.deps.run.phase = String(title).slice(0, 200);
    this.deps.run.progress.phase = this.deps.run.phase;
    void this.deps.journal.append({ type: "phase", runId: this.deps.run.runId, time: nowIso(), phase: this.deps.run.phase }).catch(() => undefined);
    this.refreshProgress();
  }

  async log(message: string): Promise<void> {
    const text = String(message).slice(0, 4000);
    this.deps.run.progress.recentLogs.push(text);
    this.deps.run.progress.recentLogs = this.deps.run.progress.recentLogs.slice(-20);
    await this.deps.journal.append({ type: "log", runId: this.deps.run.runId, time: nowIso(), message: text });
    await fs.promises.appendFile(this.deps.run.logsPath, `${JSON.stringify({ time: nowIso(), message: text })}\n`, "utf8");
    this.refreshProgress();
  }

  private async tryReplay(callId: string, chainKey: string, label: string, phase?: string): Promise<{ replayed: boolean; value?: unknown }> {
    if (!this.deps.resumeIndex?.canReplay(chainKey)) return { replayed: false };
    const replay = await this.deps.resumeIndex.load(chainKey);
    if (!replay) return { replayed: false };
    const resultPath = await this.materializeReplayResult(callId, replay.sourcePath);
    const call: WorkflowCallProgress = { callId, label, phase, status: replay.status === "skipped" ? "skipped" : "cached", cached: true, startedAt: nowIso(), endedAt: nowIso(), resultPath };
    this.calls.set(callId, call);
    await this.deps.journal.append({
      type: "agent_result",
      runId: this.deps.run.runId,
      time: nowIso(),
      callId,
      chainKey,
      status: "cached",
      resultPath: relativeToRun(this.deps.run.runDir, resultPath),
    });
    this.refreshProgress();
    return { replayed: true, value: replay.value };
  }

  private async materializeReplayResult(callId: string, sourcePath: string): Promise<string> {
    const dir = path.join(this.deps.run.transcriptDir, callId);
    await fs.promises.mkdir(dir, { recursive: true });
    const resultPath = path.join(dir, "result.json");
    await fs.promises.copyFile(sourcePath, resultPath);
    return resultPath;
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

  private addUsage(usage: WorkflowUsage, durationMs: number): void {
    const target = this.deps.run.usage;
    target.agentCount += usage.agentCount;
    target.subagentTokens += usage.subagentTokens;
    target.toolUses += usage.toolUses;
    target.durationMs = (target.durationMs ?? 0) + durationMs;
    target.estimated = target.estimated || usage.estimated;
  }

  private async writeSkippedResult(callId: string): Promise<string> {
    const dir = path.join(this.deps.run.transcriptDir, callId);
    await fs.promises.mkdir(dir, { recursive: true });
    const resultPath = path.join(dir, "result.json");
    await fs.promises.writeFile(resultPath, `${JSON.stringify({ status: "skipped", result: null }, null, 2)}\n`, "utf8");
    return resultPath;
  }

  private async writeAgentError(callId: string, err: unknown): Promise<void> {
    const dir = path.join(this.deps.run.transcriptDir, callId);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, "error.json"), `${JSON.stringify({ error: (err as Error).message ?? String(err) }, null, 2)}\n`, "utf8");
  }
}

function computeChainKey(previousChainKey: string | undefined, prompt: string, opts: AgentOptions, argsHash: string, scriptHash: string): string {
  return `v2:${stableHash({
    version: 2,
    previousChainKey: previousChainKey ?? null,
    prompt,
    opts: {
      label: opts.label ?? null,
      phase: opts.phase ?? null,
      schema: opts.schema ?? null,
      model: opts.model ?? null,
      isolation: opts.isolation ?? null,
      agentType: opts.agentType ?? null,
    },
    argsHash,
    scriptHash,
  }).slice("sha256:".length)}`;
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
