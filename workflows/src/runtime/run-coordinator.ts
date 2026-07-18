import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WorkflowRunDatabase,
  WorkflowRunDatabaseRevisionConflictError,
} from "../persistence/run-database.js";
import { assertCurrentCoordinatorProcessIdentity } from "./coordinator-identity.js";
import { executePreparedWorkflowRun } from "./prepared-workflow-run.js";

const SETTLED = new Set(["waiting", "paused", "completed", "failed", "stopped"]);

export interface WorkflowRunCoordinatorOptions {
  pollIntervalMs?: number;
  processIdentityCheck?: false | ((runId: string) => void | Promise<void>);
  execute?: (database: WorkflowRunDatabase, signal: AbortSignal) => Promise<unknown>;
}

/** Short-lived schema-4 owner. Control requests are durable; systemd owns process lifetime. */
export class WorkflowRunCoordinator {
  readonly runDir: string;
  private readonly pollIntervalMs: number;
  private readonly identityCheck: WorkflowRunCoordinatorOptions["processIdentityCheck"];
  private readonly execute: NonNullable<WorkflowRunCoordinatorOptions["execute"]>;

  constructor(runDir: string, options: WorkflowRunCoordinatorOptions = {}) {
    this.runDir = path.resolve(runDir);
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.identityCheck = options.processIdentityCheck === undefined
      ? async runId => { await assertCurrentCoordinatorProcessIdentity(runId); }
      : options.processIdentityCheck;
    this.execute = options.execute ?? (async (database, signal) =>
      await executePreparedWorkflowRun(this.runDir, database, signal));
  }

  async run(signal?: AbortSignal): Promise<{ runId: string; status: string; processed: number }> {
    await assertRunDirectory(this.runDir);
    const database = WorkflowRunDatabase.open(path.join(this.runDir, "run.sqlite"));
    let processed = 0;
    try {
      const initial = database.readRun();
      if (path.basename(this.runDir) !== initial.runId) throw new Error("Coordinator run directory and database identity differ");
      if (this.identityCheck) await this.identityCheck(initial.runId);
      processed += await drain(database);
      let current = database.readRun();
      if (SETTLED.has(current.status)) return { runId: current.runId, status: current.status, processed };

      const execution = new AbortController();
      const external = () => execution.abort(signal?.reason ?? new Error("Coordinator received a signal"));
      signal?.addEventListener("abort", external, { once: true });
      if (signal?.aborted) external();
      let pumping = true;
      const pump = (async () => {
        while (pumping && !execution.signal.aborted) {
          await delay(this.pollIntervalMs, execution.signal);
          if (!pumping || execution.signal.aborted) break;
          const count = await drain(database);
          processed += count;
          if (count > 0) {
            const status = database.readRun().status;
            if (status === "paused" || status === "stopped") execution.abort(new Error(`Workflow control set ${status}`));
          }
        }
      })();
      try {
        try {
          await this.execute(database, execution.signal);
        } catch (error) {
          const currentAfterFailure = database.readRun();
          if (!signal?.aborted && !SETTLED.has(currentAfterFailure.status)) {
            await failRun(database, error);
          } else if (signal?.aborted) {
            throw error;
          }
        }
      } finally {
        pumping = false;
        if (!execution.signal.aborted) execution.abort();
        await pump;
        signal?.removeEventListener("abort", external);
      }
      processed += await drain(database);
      current = database.readRun();
      return { runId: current.runId, status: current.status, processed };
    } finally {
      database.close();
    }
  }
}

async function failRun(database: WorkflowRunDatabase, error: unknown): Promise<void> {
  const summary = Array.from(error instanceof Error ? error.message : String(error)).slice(0, 2_000).join("")
    || "Workflow coordinator setup failed";
  for (let attempt = 0; attempt < 16; attempt++) {
    const current = database.readRun();
    if (SETTLED.has(current.status)) return;
    try {
      database.transitionRun(current.revision, {
        status: "failed",
        reason: { category: "infrastructure", code: "coordinator-setup-failed", summary, retryable: false },
        at: new Date().toISOString(),
      });
      return;
    } catch (failure) {
      if (failure instanceof WorkflowRunDatabaseRevisionConflictError) continue;
      throw failure;
    }
  }
  throw new Error("Could not settle coordinator setup failure after revision races");
}

export async function workflowCoordinatorMain(args: readonly string[]): Promise<number> {
  const runDir = parseRunDirectory(args);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await new WorkflowRunCoordinator(runDir).run(abort.signal);
    return 0;
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

export function workflowCoordinatorEntryPath(): string {
  return fileURLToPath(new URL("./coordinator-entry.js", import.meta.url));
}

async function drain(database: WorkflowRunDatabase): Promise<number> {
  let processed = 0;
  for (;;) {
    const request = database.listPendingControlRequests(1)[0];
    if (!request) return processed;
    try {
      database.processControlRequest(request.requestId, new Date().toISOString());
      processed++;
    } catch (error) {
      if (error instanceof WorkflowRunDatabaseRevisionConflictError) continue;
      throw error;
    }
  }
}

async function assertRunDirectory(runDir: string): Promise<void> {
  const databasePath = path.join(runDir, "run.sqlite");
  const [root, database, real] = await Promise.all([
    fs.promises.lstat(runDir), fs.promises.lstat(databasePath), fs.promises.realpath(runDir),
  ]);
  if (!root.isDirectory() || root.isSymbolicLink() || real !== runDir) throw new Error("Unsafe coordinator run directory");
  if (!database.isFile() || database.isSymbolicLink()) throw new Error("Unsafe coordinator run database");
}

function parseRunDirectory(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== "--run-dir" || !args[1] || !path.isAbsolute(args[1])) {
    throw new Error("Usage: coordinator-entry.js --run-dir ABSOLUTE_RUN_DIRECTORY");
  }
  return path.resolve(args[1]);
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
  });
}
