import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RunDatabase,
  RunRevisionConflictError,
  type CoordinatorOpenResult,
} from "../persistence/run-database.js";
import type { RunRecord, RunStatus } from "./durable-types.js";
import { assertCurrentCoordinatorProcessIdentity } from "./coordinator-identity.js";
import { executePreparedWorkflowRun } from "./prepared-workflow-run.js";

const SETTLED = new Set<RunStatus>(["waiting", "paused", "completed", "failed", "stopped"]);

export interface RunCoordinatorOptions {
  pollIntervalMs?: number;
  now?: () => Date;
  /** Tests may bypass systemd; production never does. */
  processIdentityCheck?: false | ((runId: string) => void | Promise<void>);
  /** Production binds the prepared semantic runtime; focused inbox tests may omit it. */
  execute?: (database: RunDatabase, signal: AbortSignal) => Promise<unknown>;
}

export interface RunCoordinatorResult {
  runId: string;
  status: RunStatus;
  exit: "settled" | "shutdown" | "signal";
  processedControlRequests: number;
  openDisposition: CoordinatorOpenResult["disposition"];
}

/** One short-lived owner loop. SQLite remains the only ordinary control transport. */
export class RunCoordinator {
  readonly runDir: string;
  readonly databasePath: string;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly identityCheck: false | ((runId: string) => void | Promise<void>);
  private readonly execute?: RunCoordinatorOptions["execute"];

  constructor(runDir: string, options: RunCoordinatorOptions = {}) {
    this.runDir = path.resolve(runDir);
    this.databasePath = path.join(this.runDir, "run.sqlite");
    this.pollIntervalMs = boundedInteger(options.pollIntervalMs ?? 100, "coordinator poll interval", 10, 1_000);
    this.now = options.now ?? (() => new Date());
    this.identityCheck = options.processIdentityCheck === undefined
      ? async (runId) => { await assertCurrentCoordinatorProcessIdentity(runId); }
      : options.processIdentityCheck;
    this.execute = options.execute;
  }

  async run(signal?: AbortSignal): Promise<RunCoordinatorResult> {
    await assertRunDirectory(this.runDir, this.databasePath);
    const database = RunDatabase.open(this.databasePath);
    let processed = 0;
    let opened: CoordinatorOpenResult | undefined;
    try {
      const initial = database.readRun();
      if (path.basename(this.runDir) !== initial.runId) throw new Error("Coordinator run directory and database identity differ");
      if (this.identityCheck) await this.identityCheck(initial.runId);
      opened = this.reconcileOpen(database);

      if (this.execute) {
        return await this.runPrepared(database, opened, signal);
      }

      for (;;) {
        if (signal?.aborted) {
          const run = this.pauseForSignal(database);
          return result(run, "signal", processed, opened.disposition);
        }

        let exitRequested = false;
        for (;;) {
          const request = database.listPendingControlRequests(1)[0];
          if (!request) break;
          try {
            const consumed = database.processCoordinatorControlRequest(
              database.readRun().revision,
              request.requestId,
              this.timestamp(),
            );
            processed += 1;
            if (consumed.exitRequested) {
              exitRequested = true;
              break;
            }
          } catch (error) {
            if (error instanceof RunRevisionConflictError) continue;
            throw error;
          }
        }

        const run = database.readRun();
        if (exitRequested) return result(run, "shutdown", processed, opened.disposition);
        if (SETTLED.has(run.status) && database.listPendingControlRequests(1).length === 0) {
          return result(run, "settled", processed, opened.disposition);
        }
        await boundedDelay(this.pollIntervalMs, signal);
      }
    } finally {
      database.close();
    }
  }

  private async runPrepared(
    database: RunDatabase,
    opened: CoordinatorOpenResult,
    signal?: AbortSignal,
  ): Promise<RunCoordinatorResult> {
    let processed = 0;
    let shutdown = false;
    const drain = () => {
      for (;;) {
        const request = database.listPendingControlRequests(1)[0];
        if (!request) return;
        try {
          const consumed = database.processCoordinatorControlRequest(
            database.readRun().revision,
            request.requestId,
            this.timestamp(),
          );
          processed += 1;
          if (consumed.exitRequested) {
            shutdown = true;
            return;
          }
        } catch (error) {
          if (error instanceof RunRevisionConflictError) continue;
          throw error;
        }
      }
    };

    drain();
    let current = database.readRun();
    if (shutdown) return result(current, "shutdown", processed, opened.disposition);
    if (SETTLED.has(current.status)) return result(current, "settled", processed, opened.disposition);

    const execution = new AbortController();
    const externalAbort = () => execution.abort(signal?.reason);
    signal?.addEventListener("abort", externalAbort, { once: true });
    if (signal?.aborted) externalAbort();
    let pumping = true;
    const pump = (async () => {
      while (pumping && !execution.signal.aborted) {
        await boundedDelay(this.pollIntervalMs, execution.signal);
        if (!pumping || execution.signal.aborted) break;
        drain();
        if (shutdown && !execution.signal.aborted) execution.abort(new Error("Coordinator shutdown requested"));
      }
    })();
    try {
      try {
        await this.execute!(database, execution.signal);
      } catch (error) {
        const run = database.readRun();
        if (!SETTLED.has(run.status)) {
          this.pauseForSignal(database, `Coordinator execution failed: ${boundedError(error)}`);
        }
        throw error;
      }
    } finally {
      pumping = false;
      if (!execution.signal.aborted) execution.abort();
      await pump;
      signal?.removeEventListener("abort", externalAbort);
    }
    drain();
    current = database.readRun();
    const exit = shutdown ? "shutdown" : signal?.aborted ? "signal" : "settled";
    return result(current, exit, processed, opened.disposition);
  }

  private reconcileOpen(database: RunDatabase): CoordinatorOpenResult {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      try {
        return database.reconcileCoordinatorOpen(this.timestamp());
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error("Coordinator could not reconcile the run after 16 revision races");
  }

  private pauseForSignal(database: RunDatabase, summary = "Coordinator received a termination signal"): RunRecord {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const run = database.readRun();
      if (SETTLED.has(run.status)) return run;
      try {
        return database.pauseCoordinatorForSignal(
          run.revision,
          this.timestamp(),
          summary,
        );
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error("Coordinator could not pause after a termination signal");
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Coordinator clock returned an invalid date");
    return value.toISOString();
  }
}

export async function coordinatorMain(args: readonly string[]): Promise<number> {
  const runDir = parseRunDirectoryArgument(args);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await new RunCoordinator(runDir, {
      execute: async (database, signal) => await executePreparedWorkflowRun(runDir, database, signal),
    }).run(abort.signal);
    return 0;
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

export function coordinatorEntryPath(): string {
  return fileURLToPath(new URL("./coordinator-entry.js", import.meta.url));
}

async function assertRunDirectory(runDir: string, databasePath: string): Promise<void> {
  const [root, database, realRoot] = await Promise.all([
    fs.promises.lstat(runDir),
    fs.promises.lstat(databasePath),
    fs.promises.realpath(runDir),
  ]);
  if (!root.isDirectory() || root.isSymbolicLink() || realRoot !== runDir) throw new Error("Unsafe coordinator run directory");
  if (!database.isFile() || database.isSymbolicLink()) throw new Error("Unsafe coordinator run database");
}

function parseRunDirectoryArgument(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== "--run-dir" || !args[1] || args[1].includes("\0")) {
    throw new Error("Usage: coordinator-entry.js --run-dir ABSOLUTE_RUN_DIRECTORY");
  }
  if (!path.isAbsolute(args[1])) throw new Error("Coordinator run directory must be absolute");
  return args[1];
}

function result(
  run: RunRecord,
  exit: RunCoordinatorResult["exit"],
  processedControlRequests: number,
  openDisposition: CoordinatorOpenResult["disposition"],
): RunCoordinatorResult {
  return { runId: run.runId, status: run.status, exit, processedControlRequests, openDisposition };
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

async function boundedDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, 1_500).join("");
}

