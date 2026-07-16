import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RunRecord } from "../runtime/durable-types.js";
import {
  RunDatabase,
  RunDatabaseReader,
  type CreateRunDatabaseOptions,
} from "./run-database.js";
import { runFilesystemPaths, workflowRunRoot, type RunFilesystemPaths } from "./paths.js";

const RUN_ID = /^flow_[a-f0-9]{32}$/;
const MAX_RUNS = 10_000;
const CREATE_ATTEMPTS = 16;

export interface RunCatalogEntry {
  runId: string;
  paths: RunFilesystemPaths;
  run?: RunRecord;
  error?: string;
}

export interface CreatedRun {
  entry: RunCatalogEntry & { run: RunRecord };
  database: RunDatabase;
}

export interface CreateCatalogRunOptions
  extends Omit<CreateRunDatabaseOptions, "run" | "artifacts"> {
  run: Omit<RunRecord, "runId">;
}

/**
 * Filesystem discovery only: immediate directories are the index and each
 * run.sqlite row is authoritative. There is no project-keyed side catalog.
 */
export class RunCatalog {
  readonly root: string;

  constructor(root = workflowRunRoot()) {
    this.root = path.resolve(root);
  }

  async ensureRoot(): Promise<void> {
    await fs.promises.mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe workflow run root");
    await fs.promises.chmod(this.root, 0o700);
  }

  /** Create the run directory with mkdir's exclusive filesystem operation. */
  async create(options: CreateCatalogRunOptions): Promise<CreatedRun> {
    await this.ensureRoot();
    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
      const runId = newRunId();
      const paths = runFilesystemPaths(this.root, runId);
      try {
        await fs.promises.mkdir(paths.root, { mode: 0o700 });
      } catch (error: any) {
        if (error?.code === "EEXIST") continue;
        throw error;
      }

      let database: RunDatabase | undefined;
      try {
        await syncDirectory(this.root);
        await initializeRunLayout(paths);
        database = RunDatabase.create(paths.database, {
          ...options,
          run: { ...options.run, runId },
        });
        await syncDirectory(paths.root);
        const run = database.readRun();
        return { entry: { runId, paths, run }, database };
      } catch (error) {
        database?.close();
        await fs.promises.rm(paths.root, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }
    throw new Error(`Could not allocate a workflow run id after ${CREATE_ATTEMPTS} attempts`);
  }

  async list(): Promise<RunCatalogEntry[]> {
    let entries: fs.Dirent[];
    try {
      const root = await fs.promises.lstat(this.root);
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Unsafe workflow run root");
      entries = await fs.promises.readdir(this.root, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }

    const runIds = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && RUN_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    if (runIds.length > MAX_RUNS) throw new Error(`Workflow run root exceeds ${MAX_RUNS} runs`);

    const runs = runIds.map((runId): RunCatalogEntry => {
      const paths = runFilesystemPaths(this.root, runId);
      let reader: RunDatabaseReader | undefined;
      try {
        reader = RunDatabaseReader.open(paths.database);
        const run = reader.readRun();
        if (run.runId !== runId) throw new Error("Run directory and database identity differ");
        return { runId, paths, run };
      } catch (error) {
        return { runId, paths, error: boundedError(error) };
      } finally {
        reader?.close();
      }
    });

    return runs.sort((left, right) => {
      const byTime = Date.parse(right.run?.createdAt ?? "") - Date.parse(left.run?.createdAt ?? "");
      return (Number.isFinite(byTime) ? byTime : 0) || right.runId.localeCompare(left.runId);
    });
  }

  async resolve(reference: string): Promise<RunCatalogEntry> {
    if (typeof reference !== "string" || reference.trim() !== reference || !/^(?:flow_)?[a-f0-9]{4,32}$/.test(reference)) {
      throw new TypeError("Run reference must be a full or displayed short run id");
    }
    const entries = await this.list();
    const exact = entries.find((entry) => entry.runId === reference);
    if (exact) return exact;
    const body = reference.startsWith("flow_") ? reference.slice(5) : reference;
    const matches = entries.filter((entry) => entry.runId.slice(5).startsWith(body));
    if (matches.length === 0) throw new Error(`Unknown workflow run ${reference}`);
    if (matches.length > 1) throw new Error(`Ambiguous workflow run ${reference}`);
    return matches[0]!;
  }

  /** Permanently remove one already-authorized run through an atomic quarantine rename. */
  async delete(runId: string): Promise<void> {
    if (!RUN_ID.test(runId)) throw new TypeError("Invalid workflow run id");
    const paths = runFilesystemPaths(this.root, runId);
    const root = path.resolve(this.root);
    const target = path.resolve(paths.root);
    if (path.dirname(target) !== root) throw new Error("Workflow run path escapes its catalog");
    const [rootStat, targetStat] = await Promise.all([
      fs.promises.lstat(root),
      fs.promises.lstat(target),
    ]);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw new Error("Unsafe workflow run directory");
    }
    const quarantine = path.join(root, `.deleting-${runId}-${crypto.randomUUID()}`);
    await fs.promises.rename(target, quarantine);
    await makeTreeRemovable(quarantine);
    await fs.promises.rm(quarantine, { recursive: true, force: false });
    await syncDirectory(root);
  }
}

async function initializeRunLayout(paths: RunFilesystemPaths): Promise<void> {
  for (const directory of [paths.context, paths.sessions, paths.workspaces, paths.artifacts, paths.outputs]) {
    await fs.promises.mkdir(directory, { mode: 0o700 });
  }
  for (const name of ["candidates", "checkpoints", "overlays"]) {
    await fs.promises.mkdir(path.join(paths.workspaces, name), { mode: 0o700 });
  }
  await syncDirectory(paths.root);
}

export function newRunId(): string {
  return `flow_${crypto.randomBytes(16).toString("hex")}`;
}

export function shortRunIds(runIds: readonly string[]): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const runId of runIds) if (!RUN_ID.test(runId)) throw new TypeError("Invalid workflow run id");
  for (const runId of runIds) {
    const body = runId.slice(5);
    let length = 8;
    while (length < 32 && runIds.some((other) => other !== runId && other.slice(5, 5 + length) === body.slice(0, length))) {
      length += 2;
    }
    result.set(runId, body.slice(0, length));
  }
  return result;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function boundedError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return Array.from(text.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, 512).join("");
}

async function makeTreeRemovable(directory: string): Promise<void> {
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe quarantined workflow run");
  await fs.promises.chmod(directory, (stat.mode & 0o777) | 0o700);
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) await makeTreeRemovable(path.join(directory, entry.name));
  }
}
