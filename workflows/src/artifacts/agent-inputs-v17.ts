import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentInputBundleHandle } from "../agents/executor.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import { WORKFLOW_V17_PRODUCT_KINDS } from "../definition/workflow-language-v17.js";
import type { WorkflowArtifactV17Record } from "../persistence/run-database-v17-types.js";
import type { ArtifactRef } from "../runtime/durable-types.js";
import { sha256 } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import {
  workflowV17ArtifactManifestHash,
  WORKFLOW_V17_ARTIFACT_SEGMENT_PATTERN,
  type WorkflowV17ArtifactManifest,
} from "./manifest-v17.js";
import { WorkflowV17ArtifactStore } from "./store-v17.js";

interface AgentInputManifestFile {
  formatVersion: 1;
  hash: string;
  entries: Array<{
    id: string;
    artifact: ArtifactRef;
    file: string;
  }>;
}

interface ResolvedInput {
  id: string;
  artifact: ArtifactRef;
  record: WorkflowArtifactV17Record;
  sourcePath: string;
  file: string;
}

/** Materialize a canonical v17 artifact manifest as one immutable nested agent-input tree. */
export async function materializeWorkflowV17AgentInputs(options: {
  store: WorkflowV17ArtifactStore;
  root: string;
  manifest: WorkflowV17ArtifactManifest;
}): Promise<AgentInputBundleHandle> {
  assertManifest(options.manifest);
  const resolved: ResolvedInput[] = [];
  let totalBytes = 0;
  for (const entry of options.manifest.entries) {
    const stored = await options.store.read(entry.artifact);
    totalBytes += stored.record.bytes;
    if (totalBytes > DEFINITION_LIMITS.agentInputTotalBytes) {
      throw new WorkflowV17AgentInputError("Workflow v17 agent inputs exceed their aggregate byte limit");
    }
    const extension = stored.record.mediaType === "application/json" ? ".json"
      : stored.record.mediaType === "text/plain; charset=utf-8" ? ".txt" : ".bin";
    resolved.push({
      id: entry.path,
      artifact: artifactRef(stored.record),
      record: stored.record,
      sourcePath: stored.bodyPath,
      file: `${entry.path}${extension}`,
    });
  }
  const root = path.resolve(options.root);
  assertContained(options.store.runDir, root);
  const manifest: AgentInputManifestFile = {
    formatVersion: 1,
    hash: options.manifest.hash,
    entries: resolved.map(entry => ({ id: entry.id, artifact: entry.artifact, file: entry.file })),
  };
  if (await existingBundle(root, manifest)) return bundle(root, manifest);

  const parent = path.dirname(root);
  await ensureSafeDirectoryPath(options.store.runDir, parent);
  const temporary = `${root}.tmp-${crypto.randomUUID()}`;
  await fs.promises.mkdir(temporary, { mode: 0o700 });
  try {
    for (const entry of resolved) {
      const destination = path.join(temporary, ...entry.file.split("/"));
      await ensureSafeDirectoryPath(temporary, path.dirname(destination));
      await fs.promises.copyFile(entry.sourcePath, destination, fs.constants.COPYFILE_FICLONE);
      const body = await fs.promises.readFile(destination);
      if (body.length !== entry.record.bytes || sha256(body) !== entry.record.digest) {
        throw new WorkflowV17AgentInputError(`Workflow v17 agent input ${entry.id} changed during copy`);
      }
      const copied = await fs.promises.open(destination, "r");
      try { await copied.sync(); } finally { await copied.close(); }
      await fs.promises.chmod(destination, 0o400);
    }
    const manifestFile = await fs.promises.open(path.join(temporary, ".bundle.json"), "wx", 0o400);
    try {
      await manifestFile.writeFile(`${stableJson(manifest)}\n`, "utf8");
      await manifestFile.sync();
    } finally {
      await manifestFile.close();
    }
    await makeReadOnly(temporary);
    try {
      await fs.promises.rename(temporary, root);
      await syncDirectory(parent);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await makeRemovable(temporary);
      await fs.promises.rm(temporary, { recursive: true, force: true });
      if (!await existingBundle(root, manifest)) {
        throw new WorkflowV17AgentInputError("Workflow v17 agent input bundle identity collision");
      }
    }
  } catch (error) {
    await makeRemovable(temporary).catch(() => undefined);
    await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return bundle(root, manifest);
}

export class WorkflowV17AgentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowV17AgentInputError";
  }
}

function assertManifest(value: WorkflowV17ArtifactManifest): void {
  if (!value || value.formatVersion !== 1 || !Array.isArray(value.entries)
    || value.entries.length > DEFINITION_LIMITS.agentInputs
    || typeof value.hash !== "string" || value.hash !== workflowV17ArtifactManifestHash(value.entries)) {
    throw new WorkflowV17AgentInputError("Workflow v17 artifact manifest identity is invalid");
  }
  let previous = "";
  for (const entry of value.entries) {
    if (!entry || typeof entry.path !== "string" || !validManifestPath(entry.path)
      || entry.path <= previous || !entry.artifact || typeof entry.artifact !== "object"
      || !WORKFLOW_V17_PRODUCT_KINDS.includes(entry.productKind)) {
      throw new WorkflowV17AgentInputError("Workflow v17 artifact manifest order or path is invalid");
    }
    previous = entry.path;
  }
}

function validManifestPath(value: string): boolean {
  const parts = value.split("/");
  if (parts.length < 1 || !WORKFLOW_V17_ARTIFACT_SEGMENT_PATTERN.test(parts[0]!)) return false;
  return parts.slice(1).every(part => WORKFLOW_V17_ARTIFACT_SEGMENT_PATTERN.test(part) || /^\d{6}$/u.test(part));
}

function artifactRef(record: WorkflowArtifactV17Record): ArtifactRef {
  return {
    digest: record.digest,
    kind: record.kind,
    mediaType: record.mediaType,
    bytes: record.bytes,
  };
}

function bundle(root: string, manifest: AgentInputManifestFile): AgentInputBundleHandle {
  return Object.freeze({
    root,
    entries: Object.freeze(manifest.entries.map(entry => Object.freeze({
      id: entry.id,
      artifact: Object.freeze({ ...entry.artifact }),
      path: path.join(root, ...entry.file.split("/")),
    }))),
    hash: manifest.hash,
  });
}

async function existingBundle(root: string, expected: AgentInputManifestFile): Promise<boolean> {
  try {
    const rootStat = await fs.promises.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new WorkflowV17AgentInputError("Workflow v17 agent input root is unsafe");
    }
    const source = await fs.promises.readFile(path.join(root, ".bundle.json"), "utf8");
    const actual = JSON.parse(source) as AgentInputManifestFile;
    if (source !== `${stableJson(actual)}\n` || stableJson(actual) !== stableJson(expected)) return false;
    for (const entry of actual.entries) {
      const target = path.join(root, ...entry.file.split("/"));
      await ensureSafeDirectoryPath(root, path.dirname(target));
      const stat = await fs.promises.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.artifact.bytes) return false;
      if (sha256(await fs.promises.readFile(target)) !== entry.artifact.digest) return false;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertContained(rootInput: string, targetInput: string): void {
  const root = path.resolve(rootInput);
  const target = path.resolve(targetInput);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WorkflowV17AgentInputError("Workflow v17 agent input root escapes its run");
  }
}

async function ensureSafeDirectoryPath(rootInput: string, targetInput: string): Promise<void> {
  const root = path.resolve(rootInput);
  const target = path.resolve(targetInput);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WorkflowV17AgentInputError("Workflow v17 agent input directory escapes its root");
  }
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fs.promises.mkdir(current, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await fs.promises.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new WorkflowV17AgentInputError("Workflow v17 agent input path contains an unsafe directory");
    }
  }
}

async function makeReadOnly(root: string): Promise<void> {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await makeReadOnly(target);
      await fs.promises.chmod(target, 0o500);
    }
  }
  await syncDirectory(root);
  await fs.promises.chmod(root, 0o500);
}

async function makeRemovable(root: string): Promise<void> {
  let stat: fs.Stats;
  try { stat = await fs.promises.lstat(root); } catch { return; }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.promises.chmod(root, 0o700);
    for (const name of await fs.promises.readdir(root)) await makeRemovable(path.join(root, name));
  } else await fs.promises.chmod(root, 0o600);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
