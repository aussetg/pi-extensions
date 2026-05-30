import path from "node:path";
import fs from "node:fs";
import type { AgentOptions, RunRecord, WorkflowCallProgress, WorkflowUsage } from "../types.js";
import { DEFAULT_LIMITS, WORKFLOW_ISOLATION_POLICY } from "../constants.js";
import { WorkflowAgent } from "../agents/workflow-agent.js";
import { JsonlJournal, type ResumeIndex } from "../persistence/journal.js";
import { relativeToRun } from "../persistence/paths.js";
import { sha256, stableHash } from "../utils/hashes.js";
import { nowIso } from "../utils/ids.js";
import { WorkflowBudget } from "./budget.js";
import { computeAgentChainKey } from "./cache-key.js";
import { WorkflowAgentCapError, WorkflowAbortError, WorkflowSkipAgentError } from "./errors.js";
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
  private readonly agent = new WorkflowAgent();
  private sequence = 0;
  private previousChainKey: string | undefined;
  private calls = new Map<string, WorkflowCallProgress>();

  constructor(private readonly deps: SchedulerDeps) {
    this.limiter = new AsyncLimiter(DEFAULT_LIMITS.agentConcurrency, deps.control.signal);
  }

  async agentCall(prompt: unknown, opts: AgentOptions = {}): Promise<unknown> {
    if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("agent(prompt, opts?) requires a non-empty string prompt");
    this.deps.control.throwIfAborted();
    await this.deps.control.waitIfPaused();
    this.deps.budget.assertCanStart();
    if (this.sequence >= this.deps.maxAgents) throw new WorkflowAgentCapError(`Workflow agent cap exceeded (${this.deps.maxAgents})`);

    const effectiveOpts: AgentOptions = {
      ...opts,
      isolation: opts.isolation ?? WORKFLOW_ISOLATION_POLICY.directAgentDefault,
    };

    const callId = String(++this.sequence).padStart(4, "0");
    const phase = effectiveOpts.phase ?? this.deps.run.phase;
    const label = effectiveOpts.label ?? `agent ${callId}`;
    const previousChainKey = this.previousChainKey;
    const chainKey = computeAgentChainKey({ previousChainKey, prompt, opts: { ...effectiveOpts, phase }, activeTools: this.deps.activeTools });
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
      const durationMs = Date.now() - started;
      const usage: WorkflowUsage = { ...result.usage, durationMs };
      call.status = "done";
      call.endedAt = nowIso();
      call.resultPath = result.resultPath;
      call.usage = usage;
      if (result.model) call.model = result.model;
      this.addUsage(usage);
      this.deps.budget.charge(usage.subagentTokens);
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
    const call: WorkflowCallProgress = { callId, label, phase, model: replay.model, usage: replay.usage, status: replay.status === "skipped" ? "skipped" : "cached", cached: true, startedAt: nowIso(), endedAt: nowIso(), resultPath };
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

  private addUsage(usage: WorkflowUsage): void {
    const target = this.deps.run.usage;
    target.agentCount += usage.agentCount;
    target.subagentTokens += usage.subagentTokens;
    target.toolUses += usage.toolUses;
    if (usage.durationMs !== undefined) target.durationMs = (target.durationMs ?? 0) + usage.durationMs;
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
