import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { workflowRunRoot } from "./paths.js";
import { WorkflowRunDatabaseReader } from "./run-database.js";
import type { WorkflowRunRecord } from "./run-database-types.js";

const RUN_ID = /^flow_[a-f0-9]{32}$/u;

export interface WorkflowRunPaths {
  root: string;
  database: string;
  source: string;
  context: string;
  invocation: string;
  projectSnapshot: string;
  projectManifest: string;
  staticResources: string;
  sessions: string;
  workspaces: string;
  artifacts: string;
  outputs: string;
}

export interface WorkflowRunCatalogEntry {
  runId: string;
  paths: WorkflowRunPaths;
  run?: WorkflowRunRecord;
  error?: string;
}

export class WorkflowRunCatalog {
  readonly root: string;
  constructor(root = workflowRunRoot()) { this.root = path.resolve(root); }

  async ensureRoot(): Promise<void> {
    await fs.promises.mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe workflow run root");
  }

  allocate(): { runId: string; paths: WorkflowRunPaths } {
    const runId = `flow_${crypto.randomBytes(16).toString("hex")}`;
    return { runId, paths: workflowRunPaths(this.root, runId) };
  }

  async list(): Promise<WorkflowRunCatalogEntry[]> {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(this.root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const result = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && RUN_ID.test(entry.name))
      .map(entry => {
        const paths = workflowRunPaths(this.root, entry.name);
        let reader: WorkflowRunDatabaseReader | undefined;
        try {
          reader = WorkflowRunDatabaseReader.open(paths.database);
          const run = reader.readRun();
          if (run.runId !== entry.name) throw new Error("Run directory and database identity differ");
          return { runId: entry.name, paths, run };
        } catch (error) {
          return { runId: entry.name, paths, error: bounded(error) };
        } finally { reader?.close(); }
      });
    return result.sort((left, right) => Date.parse(right.run?.createdAt ?? "") - Date.parse(left.run?.createdAt ?? "")
      || right.runId.localeCompare(left.runId));
  }

  async resolve(reference: string): Promise<WorkflowRunCatalogEntry> {
    if (!/^(?:flow_)?[a-f0-9]{4,32}$/u.test(reference)) throw new TypeError("Invalid workflow run reference");
    const entries = await this.list();
    const exact = entries.find(entry => entry.runId === reference);
    if (exact) return exact;
    const body = reference.startsWith("flow_") ? reference.slice(5) : reference;
    const matches = entries.filter(entry => entry.runId.slice(5).startsWith(body));
    if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous workflow run ${reference}` : `Unknown workflow run ${reference}`);
    return matches[0]!;
  }

  async delete(runId: string): Promise<void> {
    if (!RUN_ID.test(runId)) throw new TypeError("Invalid workflow run id");
    const target = workflowRunPaths(this.root, runId).root;
    const quarantine = path.join(this.root, `.deleting-${runId}-${crypto.randomUUID()}`);
    await fs.promises.rename(target, quarantine);
    await makeRemovable(quarantine);
    await fs.promises.rm(quarantine, { recursive: true, force: false });
  }
}

export function workflowRunPaths(rootInput: string, runId: string): WorkflowRunPaths {
  if (!RUN_ID.test(runId)) throw new TypeError("Invalid workflow run id");
  const root = path.join(path.resolve(rootInput), runId);
  const context = path.join(root, "context");
  return {
    root,
    database: path.join(root, "run.sqlite"),
    source: path.join(root, "source.flow.ts"),
    context,
    invocation: path.join(context, "invocation.json"),
    projectSnapshot: path.join(context, "project"),
    projectManifest: path.join(context, "project-manifest.json"),
    staticResources: path.join(context, "static-resources.json"),
    sessions: path.join(root, "sessions"),
    workspaces: path.join(root, "workspaces"),
    artifacts: path.join(root, "artifacts"),
    outputs: path.join(root, "outputs"),
  };
}

export function workflowShortRunIds(runIds: readonly string[]): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const runId of runIds) {
    const body = runId.slice(5);
    let length = 8;
    while (length < 32 && runIds.some(other => other !== runId && other.slice(5).startsWith(body.slice(0, length)))) length += 2;
    result.set(runId, body.slice(0, length));
  }
  return result;
}

async function makeRemovable(target: string): Promise<void> {
  const stat = await fs.promises.lstat(target);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    await fs.promises.chmod(target, 0o700);
    for (const name of await fs.promises.readdir(target)) await makeRemovable(path.join(target, name));
  } else if (!stat.isSymbolicLink()) await fs.promises.chmod(target, 0o600).catch(() => undefined);
}

function bounded(error: unknown): string {
  return Array.from((error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/gu, " ")).slice(0, 512).join("");
}
