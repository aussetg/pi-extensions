import fs from "node:fs";
import path from "node:path";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import type { WorkspaceRef } from "../runtime/durable-types.js";
import { stableJson } from "../utils/stable-json.js";
import type { ProjectSnapshotManifest } from "../workspaces/project-snapshot.js";

export class CandidateWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateWorkspaceError";
  }
}

export async function readProjectManifest(filePath: string): Promise<ProjectSnapshotManifest> {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > DEFINITION_LIMITS.projectManifestBytes) {
    throw new CandidateWorkspaceError("Project manifest is unsafe");
  }
  const source = await fs.promises.readFile(filePath, "utf8");
  const value = JSON.parse(source) as ProjectSnapshotManifest;
  if (source !== `${stableJson(value)}\n`) throw new CandidateWorkspaceError("Project manifest is not canonical");
  return value;
}

export function normalizeLogicalId(value: string): string {
  if (
    typeof value !== "string" || value.trim() !== value || value.length === 0
    || Buffer.byteLength(value) > 512 || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new CandidateWorkspaceError("Candidate logical id is invalid");
  return value;
}

export function iso(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new CandidateWorkspaceError("Candidate timestamp is invalid");
  }
  return value;
}

export function assertSame(left: unknown, right: unknown, label: string): void {
  if (stableJson(left) !== stableJson(right)) {
    throw new CandidateWorkspaceError(`${label} differs from its durable record`);
  }
}

export function assertSameWorkspace(left: WorkspaceRef, right: WorkspaceRef, label: string): void {
  if (stableJson(left) !== stableJson(right)) {
    throw new CandidateWorkspaceError(`${label} workspace differs from its checkpoint`);
  }
}

export async function assertRealDirectory(directory: string): Promise<void> {
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CandidateWorkspaceError(`Unsafe candidate directory: ${directory}`);
  }
}

export async function assertDirectoryChain(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  let current = root;
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    await assertRealDirectory(current);
  }
}

export async function assertNoSymlinkPath(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  assertInside(root, target, "Candidate path");
  let current = root;
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    if ((await fs.promises.lstat(current)).isSymbolicLink()) {
      throw new CandidateWorkspaceError("Candidate path contains a symlink");
    }
  }
}

export function assertInside(root: string, target: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new CandidateWorkspaceError(`${label} escapes its root`);
  }
}

export async function removeTree(target: string): Promise<void> {
  await makeRemovable(target);
  await fs.promises.rm(target, { recursive: true, force: true });
}

async function makeRemovable(target: string): Promise<void> {
  let stat: fs.Stats;
  try { stat = await fs.promises.lstat(target); } catch { return; }
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    await fs.promises.chmod(target, 0o600).catch(() => undefined);
    return;
  }
  await fs.promises.chmod(target, 0o700).catch(() => undefined);
  for (const name of await fs.promises.readdir(target)) await makeRemovable(path.join(target, name));
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
