import fs from "node:fs";
import path from "node:path";
import { stableJson } from "../utils/stable-json.js";
import { zeroUsage, type AgentSessionRecord, type StructuredReason, type UsageMeasurement } from "../runtime/durable-types.js";
import {
  MISSING_RECEIPT_REMINDER,
  type AgentCancellationReason,
  type AgentEventSink,
  type AgentExecutionHandle,
  type AgentExecutionRequest,
  type AgentExecutionResult,
} from "./executor.js";

const DEFAULT_BACKOFF_MS = Object.freeze([100, 250, 500, 1_000, 2_000, 5_000]);

export interface AgentWorkerCycleExecutor {
  start(request: AgentExecutionRequest, sink: AgentEventSink): Promise<AgentExecutionHandle>;
}

export interface AgentSupervisionStore {
  read(): Promise<Pick<AgentSessionRecord, "receiptlessStrikes" | "status" | "finish">>;
  settleYield(meaningfulProgress: boolean, at: string): Promise<Pick<AgentSessionRecord, "receiptlessStrikes" | "status">>;
  recordInfrastructureRetry(reason: StructuredReason, meaningfulProgress: boolean, at: string): Promise<void>;
  pauseInfrastructure(reason: StructuredReason, at: string): Promise<void>;
}

export interface AgentSessionSupervisorOptions {
  cycleExecutor: AgentWorkerCycleExecutor;
  request: AgentExecutionRequest;
  sink: AgentEventSink;
  store?: AgentSupervisionStore;
  maximumInfrastructureFailures?: number;
  backoffMs?: readonly number[];
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => Date;
  sessionExists?: () => Promise<boolean>;
}

/**
 * One logical Pi session. It may own many transient worker processes, but only
 * a clean missing receipt can consume a strike and only the fixed reminder can
 * create another model-visible host message.
 */
export class AgentSessionSupervisor implements AgentExecutionHandle {
  private readonly abort = new AbortController();
  private readonly result: Promise<AgentExecutionResult>;
  private current?: AgentExecutionHandle;
  private cancellationReason?: AgentCancellationReason;

  constructor(private readonly options: AgentSessionSupervisorOptions) {
    if (!Number.isSafeInteger(options.maximumInfrastructureFailures ?? 6)
      || (options.maximumInfrastructureFailures ?? 6) < 1
      || (options.maximumInfrastructureFailures ?? 6) > 32) {
      throw new TypeError("Agent infrastructure failure limit must be 1–32");
    }
    const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    if (!Array.isArray(backoff) || backoff.length < 1 || backoff.length > 32
      || backoff.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 60_000)) {
      throw new TypeError("Agent infrastructure backoff is invalid");
    }
    this.result = this.run();
  }

  wait(): Promise<AgentExecutionResult> { return this.result; }

  async cancel(reason: AgentCancellationReason): Promise<void> {
    if (this.abort.signal.aborted) return;
    this.cancellationReason = reason;
    this.abort.abort(new Error(reason));
    await this.current?.cancel(reason).catch(() => undefined);
    await this.result;
  }

  async dispose(): Promise<void> {
    await this.current?.dispose?.();
  }

  private async run(): Promise<AgentExecutionResult> {
    const request = this.options.request;
    const store = this.options.store ?? new FileAgentSupervisionStore(request);
    const now = this.options.now ?? (() => new Date());
    const sleep = this.options.sleep ?? abortableDelay;
    const maximumFailures = this.options.maximumInfrastructureFailures ?? 6;
    const backoff = this.options.backoffMs ?? DEFAULT_BACKOFF_MS;
    const sessionExists = this.options.sessionExists ?? (() => persistedSessionExists(request));
    const initial = await store.read();
    if (initial.finish) {
      return { outcome: "finished", finish: initial.finish, usage: zeroUsage(false), transcriptComplete: false };
    }
    if (initial.status === "paused") {
      return {
        outcome: "paused",
        reason: receiptlessPauseReason(request.operationId),
        receiptlessStrikes: initial.receiptlessStrikes,
        usage: zeroUsage(false),
        transcriptComplete: false,
      };
    }
    let instructionRequest = request.instruction.kind === "missing-receipt-reminder"
      ? request
      : request.session.resume || await sessionExists()
        ? resumeRequest(request)
        : request;
    let infrastructureFailures = 0;
    let progressSinceYield = false;
    let usage = zeroUsage();
    let transcriptComplete = true;
    let strikes = initial.receiptlessStrikes;

    for (;;) {
      if (this.abort.signal.aborted) return stopped(usage, transcriptComplete, request.operationId);
      let cycle: AgentExecutionResult;
      try {
        this.current = await this.options.cycleExecutor.start(instructionRequest, this.options.sink);
        if (this.abort.signal.aborted) {
          await this.current.cancel(this.cancellationReason ?? "coordinator-shutdown").catch(() => undefined);
        }
        cycle = await this.current.wait();
      } catch (error) {
        cycle = infrastructureFailure(request, error);
      } finally {
        await this.current?.dispose?.().catch(() => undefined);
        this.current = undefined;
      }

      usage = addUsage(usage, cycle.usage);
      transcriptComplete &&= cycle.transcriptComplete;
      if (this.abort.signal.aborted || cycle.outcome === "stopped") {
        return stopped(usage, transcriptComplete, request.operationId, cycle.outcome === "stopped" ? cycle.reason : undefined);
      }
      if (cycle.outcome === "finished") {
        return { ...cycle, usage, transcriptComplete };
      }
      if (cycle.outcome === "paused") {
        return { ...cycle, usage, transcriptComplete };
      }
      if (cycle.outcome === "yielded") {
        progressSinceYield ||= cycle.meaningfulProgress;
        const settled = await store.settleYield(progressSinceYield, timestamp(now));
        strikes = settled.receiptlessStrikes;
        if (settled.status === "paused" || strikes >= 3) {
          return {
            outcome: "paused",
            reason: receiptlessPauseReason(request.operationId),
            receiptlessStrikes: strikes,
            usage,
            transcriptComplete,
          };
        }
        progressSinceYield = false;
        infrastructureFailures = 0;
        instructionRequest = reminderRequest(request);
        continue;
      }

      progressSinceYield ||= cycle.meaningfulProgress === true;
      if (!cycle.reason.retryable
        || (cycle.reason.category !== "provider" && cycle.reason.category !== "infrastructure")) {
        return { ...cycle, meaningfulProgress: progressSinceYield, usage, transcriptComplete };
      }
      infrastructureFailures += 1;
      await store.recordInfrastructureRetry(cycle.reason, progressSinceYield, timestamp(now));
      if (infrastructureFailures >= maximumFailures) {
        const reason = infrastructurePauseReason(request.operationId, cycle.reason, infrastructureFailures);
        await store.pauseInfrastructure(reason, timestamp(now));
        return {
          outcome: "paused",
          reason,
          receiptlessStrikes: strikes,
          usage,
          transcriptComplete,
        };
      }
      const delay = backoff[Math.min(infrastructureFailures - 1, backoff.length - 1)]!;
      await sleep(delay, this.abort.signal);
      if (this.abort.signal.aborted) return stopped(usage, transcriptComplete, request.operationId);
      instructionRequest = await sessionExists() ? resumeRequest(request) : request;
    }
  }
}

interface FileSupervisionState {
  receiptlessStrikes: number;
  status: "running" | "paused";
  infrastructureRetries: number;
  updatedAt: string;
}

/** Durable, attempt-local supervision state; protocol receipts remain the completion authority. */
export class FileAgentSupervisionStore implements AgentSupervisionStore {
  readonly statePath: string;

  constructor(request: AgentExecutionRequest) {
    this.statePath = path.join(path.dirname(path.resolve(request.session.piSessionPath)), "supervision.json");
  }

  async read(): Promise<Pick<AgentSessionRecord, "receiptlessStrikes" | "status" | "finish">> {
    const state = await this.readState();
    return { receiptlessStrikes: state.receiptlessStrikes, status: state.status };
  }

  async settleYield(meaningfulProgress: boolean, at: string): Promise<Pick<AgentSessionRecord, "receiptlessStrikes" | "status">> {
    const current = await this.readState();
    const receiptlessStrikes = meaningfulProgress ? 0 : current.receiptlessStrikes + 1;
    const next: FileSupervisionState = { ...current, receiptlessStrikes,
      status: receiptlessStrikes >= 3 ? "paused" : "running", updatedAt: at };
    await this.writeState(next);
    return { receiptlessStrikes: next.receiptlessStrikes, status: next.status };
  }

  async recordInfrastructureRetry(_reason: StructuredReason, meaningfulProgress: boolean, at: string): Promise<void> {
    const current = await this.readState();
    await this.writeState({ ...current, receiptlessStrikes: meaningfulProgress ? 0 : current.receiptlessStrikes,
      infrastructureRetries: current.infrastructureRetries + 1, updatedAt: at });
  }

  async pauseInfrastructure(_reason: StructuredReason, at: string): Promise<void> {
    const current = await this.readState();
    await this.writeState({ ...current, status: "paused", updatedAt: at });
  }

  private async readState(): Promise<FileSupervisionState> {
    try {
      const value = JSON.parse(await fs.promises.readFile(this.statePath, "utf8")) as FileSupervisionState;
      if (Object.keys(value).sort().join(",") !== "infrastructureRetries,receiptlessStrikes,status,updatedAt"
        || !Number.isSafeInteger(value.receiptlessStrikes)
        || value.receiptlessStrikes < 0 || !Number.isSafeInteger(value.infrastructureRetries)
        || value.infrastructureRetries < 0 || (value.status !== "running" && value.status !== "paused")) {
        throw new Error("Agent supervision state is invalid");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { receiptlessStrikes: 0, status: "running", infrastructureRetries: 0,
        updatedAt: new Date(0).toISOString() };
    }
  }

  private async writeState(value: FileSupervisionState): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
    const handle = await fs.promises.open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${stableJson(value)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await fs.promises.rename(temporary, this.statePath);
  }
}

function reminderRequest(request: AgentExecutionRequest): AgentExecutionRequest {
  return {
    ...request,
    instruction: { kind: "missing-receipt-reminder", text: MISSING_RECEIPT_REMINDER },
    session: { ...request.session, resume: true },
  } as AgentExecutionRequest;
}

function resumeRequest(request: AgentExecutionRequest): AgentExecutionRequest {
  return {
    ...request,
    instruction: { kind: "resume" },
    session: { ...request.session, resume: true },
  } as AgentExecutionRequest;
}

async function persistedSessionExists(request: AgentExecutionRequest): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(path.resolve(request.session.piSessionPath));
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function receiptlessPauseReason(operationId: string): StructuredReason {
  return {
    category: "agent-protocol",
    code: "receiptless-yield-limit",
    summary: "Agent paused after three consecutive clean yields without finish_work or meaningful progress",
    retryable: true,
    operationId,
  };
}

function infrastructurePauseReason(
  operationId: string,
  last: StructuredReason,
  failures: number,
): StructuredReason {
  return {
    category: "infrastructure",
    code: "agent-infrastructure-unavailable",
    summary: `Agent infrastructure remained unavailable after ${failures} recoveries: ${last.summary}`,
    retryable: true,
    operationId,
    details: { failures, lastCode: last.code },
  };
}

function infrastructureFailure(request: AgentExecutionRequest, error: unknown): AgentExecutionResult {
  return {
    outcome: "failed",
    reason: {
      category: "infrastructure",
      code: "agent-worker-launch-failed",
      summary: bounded(error instanceof Error ? error.message : String(error), 2_000),
      retryable: true,
      operationId: request.operationId,
    },
    usage: zeroUsage(false),
    transcriptComplete: false,
  };
}

function stopped(
  usage: UsageMeasurement,
  transcriptComplete: boolean,
  operationId: string,
  reason?: StructuredReason,
): AgentExecutionResult {
  return {
    outcome: "stopped",
    reason: reason ?? {
      category: "control",
      code: "agent-cancelled",
      summary: "Agent execution was cancelled",
      retryable: false,
      operationId,
    },
    usage,
    transcriptComplete,
  };
}

function addUsage(left: UsageMeasurement, right: UsageMeasurement): UsageMeasurement {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    providerRequests: left.providerRequests + right.providerRequests,
    cost: left.cost + right.cost,
    elapsedMs: left.elapsedMs + right.elapsedMs,
    complete: left.complete && right.complete,
  };
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Agent supervisor clock is invalid");
  return value.toISOString();
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || milliseconds === 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function bounded(value: string, maximum: number): string {
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, maximum).join("") || "Agent worker failed";
}
