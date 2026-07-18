import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import type { ProjectSnapshotManifest } from "../workspaces/project-snapshot.js";
import { stableHash } from "../utils/hashes.js";

export type CandidateTreeEntry =
  | { path: string; type: "directory"; mode: number; nodeHash: string }
  | { path: string; type: "file"; mode: number; nodeHash: string; bytes: number; digest: string }
  | { path: string; type: "symlink"; mode: number; nodeHash: string; target: string };

export interface CandidateTreeManifest {
  rootMode: number;
  entries: CandidateTreeEntry[];
  fileCount: number;
  totalBytes: number;
  treeHash: string;
}

export interface CandidatePathImage {
  type: CandidateTreeEntry["type"];
  mode: number;
  digest?: string;
  bytes?: number;
  target?: string;
}

export interface CandidatePathChange {
  path: string;
  kind: "add" | "delete" | "modify" | "mode";
  before?: CandidatePathImage;
  after?: CandidatePathImage;
}

const REFLINK_FLAGS = fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE_FORCE;
const BTRFS_SUPER_MAGIC = 0x9123683e;
const VCS_NAMES = new Set([".git", ".hg", ".svn", ".jj", ".bzr", "_darcs", "CVS"]);
const STATE_NAMES = new Set(["workflow-runs", "workflow-drafts"]);

interface WalkState {
  root: string;
  destination?: string;
  durable: boolean;
  entries: CandidateTreeEntry[];
  fileCount: number;
  totalBytes: number;
  visited: number;
}

interface ChildNode { name: string; nodeHash: string }

/** Scan one candidate tree and reject any observation that changes while read. */
export async function scanCandidateTree(rootInput: string): Promise<CandidateTreeManifest> {
  const requested = path.resolve(rootInput);
  const requestedStat = await lstat(requested);
  if (requestedStat.isSymbolicLink()) throw new Error("Candidate root must not be a symlink");
  const root = await fs.promises.realpath(requested);
  if (root !== requested) throw new Error("Candidate root path contains a symlink");
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Candidate root must be a real directory");
  const state: WalkState = { root, durable: false, entries: [], fileCount: 0, totalBytes: 0, visited: 0 };
  const result = await walkDirectory(state, "", rootStat, false);
  assertUnchanged(rootStat, await lstat(root), "Candidate root changed while it was scanned");
  return finishManifest(state, modeOf(rootStat), result.nodeHash);
}

/**
 * Clone a tree with mandatory Btrfs reflinks and hash the exact destination.
 * A complete source rescan closes the window after each individual clone.
 */
export async function cloneCandidateTree(
  sourceInput: string,
  destinationInput: string,
  options: { durable?: boolean } = {},
): Promise<CandidateTreeManifest> {
  const requestedSource = path.resolve(sourceInput);
  const requestedStat = await lstat(requestedSource);
  if (requestedStat.isSymbolicLink()) throw new Error("Candidate clone source must not be a symlink");
  const source = await fs.promises.realpath(requestedSource);
  if (source !== requestedSource) throw new Error("Candidate clone source path contains a symlink");
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("Candidate clone source must be a real directory");
  const destination = path.resolve(destinationInput);
  if (inside(source, destination) || inside(destination, source)) throw new Error("Candidate clone source and destination overlap");
  const parentInput = path.dirname(destination);
  await fs.promises.mkdir(parentInput, { recursive: true, mode: 0o700 });
  const parent = await fs.promises.realpath(parentInput);
  const canonicalDestination = path.join(parent, path.basename(destination));
  if (canonicalDestination !== destination) throw new Error("Candidate clone destination has a noncanonical parent");
  const [sourceFs, parentFs, parentStat] = await Promise.all([
    fs.promises.statfs(source), fs.promises.statfs(parent), lstat(parent),
  ]);
  if (sourceFs.type !== BTRFS_SUPER_MAGIC || parentFs.type !== BTRFS_SUPER_MAGIC || sourceStat.dev !== parentStat.dev) {
    throw new Error("Candidate workspaces require one shared Btrfs filesystem");
  }
  await fs.promises.mkdir(destination, { mode: 0o700 });
  const state: WalkState = {
    root: source,
    destination,
    durable: options.durable ?? false,
    entries: [],
    fileCount: 0,
    totalBytes: 0,
    visited: 0,
  };
  try {
    const result = await walkDirectory(state, "", sourceStat, false);
    assertUnchanged(sourceStat, await lstat(source), "Candidate clone source changed");
    await fs.promises.chmod(destination, modeOf(sourceStat));
    if (state.durable) await syncDirectory(destination);
    const cloned = finishManifest(state, modeOf(sourceStat), result.nodeHash);
    const sourceAfter = await scanCandidateTree(source);
    if (sourceAfter.treeHash !== cloned.treeHash) throw new Error("Candidate source changed while its reflink clone was captured");
    return cloned;
  } catch (error) {
    await makeRemovable(destination).catch(() => undefined);
    await fs.promises.rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw reflinkError(error);
  }
}

export function projectTreeManifest(project: ProjectSnapshotManifest): CandidateTreeManifest {
  const manifest: CandidateTreeManifest = {
    rootMode: project.rootMode,
    entries: project.entries.map((entry) => ({ ...entry })),
    fileCount: project.fileCount,
    totalBytes: project.totalBytes,
    treeHash: project.treeHash,
  };
  assertCandidateTreeManifest(manifest);
  return manifest;
}

export function diffCandidateTrees(base: CandidateTreeManifest, current: CandidateTreeManifest): CandidatePathChange[] {
  assertCandidateTreeManifest(base);
  assertCandidateTreeManifest(current);
  if (base.rootMode !== current.rootMode) throw new Error("Candidate changed the workspace root mode");
  const before = new Map(base.entries.map((entry) => [entry.path, entry]));
  const after = new Map(current.entries.map((entry) => [entry.path, entry]));
  const changes: CandidatePathChange[] = [];
  for (const candidatePath of [...new Set([...before.keys(), ...after.keys()])].sort(compareBytes)) {
    const left = before.get(candidatePath);
    const right = after.get(candidatePath);
    if (!left && right) changes.push({ path: candidatePath, kind: "add", after: image(right) });
    else if (left && !right) changes.push({ path: candidatePath, kind: "delete", before: image(left) });
    else if (left && right && left.type !== right.type) {
      changes.push({ path: candidatePath, kind: "delete", before: image(left) });
      changes.push({ path: candidatePath, kind: "add", after: image(right) });
    } else if (left && right && contentIdentity(left) !== contentIdentity(right)) {
      changes.push({ path: candidatePath, kind: "modify", before: image(left), after: image(right) });
    } else if (left && right && left.mode !== right.mode) {
      changes.push({ path: candidatePath, kind: "mode", before: image(left), after: image(right) });
    }
  }
  return changes;
}

export function assertCandidateTreeManifest(manifest: CandidateTreeManifest): void {
  if (!manifest || !Array.isArray(manifest.entries)) throw new Error("Invalid candidate tree manifest");
  if (Object.keys(manifest).sort().join(",") !== "entries,fileCount,rootMode,totalBytes,treeHash") {
    throw new Error("Candidate tree manifest has unexpected fields");
  }
  if (!validMode(manifest.rootMode) || !isHash(manifest.treeHash)) throw new Error("Invalid candidate tree root identity");
  if (!Number.isSafeInteger(manifest.fileCount) || manifest.fileCount < 0 || manifest.fileCount > DEFINITION_LIMITS.candidateFiles) {
    throw new Error("Invalid candidate file count");
  }
  if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0 || manifest.totalBytes > DEFINITION_LIMITS.candidateTreeBytes) {
    throw new Error("Invalid candidate byte count");
  }
  let previous: string | undefined;
  let files = 0;
  let bytes = 0;
  for (const entry of manifest.entries) {
    validateCandidatePath(entry.path);
    if (previous !== undefined && compareBytes(previous, entry.path) >= 0) throw new Error("Candidate manifest paths are not uniquely sorted");
    previous = entry.path;
    if (!validMode(entry.mode) || !isHash(entry.nodeHash)) throw new Error(`Invalid candidate entry ${entry.path}`);
    if (entry.type === "file") {
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > DEFINITION_LIMITS.candidateFileBytes || !isHash(entry.digest)) {
        throw new Error(`Invalid candidate file ${entry.path}`);
      }
      if (entry.nodeHash !== fileNodeHash(entry.mode, entry.bytes, entry.digest)) throw new Error(`Invalid candidate file hash ${entry.path}`);
      files++;
      bytes += entry.bytes;
    } else if (entry.type === "symlink") {
      assertSafeSymlink(entry.path, entry.target);
      if (entry.nodeHash !== symlinkNodeHash(entry.mode, entry.target)) throw new Error(`Invalid candidate symlink hash ${entry.path}`);
    } else if (entry.type === "directory") {
      // Directory node hashes are recomputed from children by a live scan.
    } else throw new Error("Invalid candidate entry type");
  }
  if (files !== manifest.fileCount || bytes !== manifest.totalBytes) throw new Error("Candidate manifest totals do not match");
}

async function walkDirectory(state: WalkState, relative: string, before: BigStats, includeEntry: boolean): Promise<{ nodeHash: string }> {
  const source = relative ? path.join(state.root, relative) : state.root;
  const destination = state.destination ? (relative ? path.join(state.destination, relative) : state.destination) : undefined;
  if (includeEntry && destination) await fs.promises.mkdir(destination, { mode: 0o700 });
  const names = await readNames(source);
  const children: ChildNode[] = [];
  for (const name of names) {
    const child = relative ? path.join(relative, name) : name;
    validateCandidatePath(portable(child));
    if (++state.visited > DEFINITION_LIMITS.candidateScanEntries) throw new Error("Candidate tree exceeds its scan-entry limit");
    const childStat = await lstat(path.join(state.root, child));
    let nodeHash: string;
    if (childStat.isDirectory() && !childStat.isSymbolicLink()) {
      nodeHash = (await walkDirectory(state, child, childStat, true)).nodeHash;
    } else if (childStat.isFile()) {
      nodeHash = await walkFile(state, child, childStat);
    } else if (childStat.isSymbolicLink()) {
      nodeHash = await walkSymlink(state, child, childStat);
    } else throw new Error(`Special files are not allowed in candidates: ${portable(child)}`);
    children.push({ name, nodeHash });
  }
  assertUnchanged(before, await lstat(source), `Candidate directory changed while scanned: ${portable(relative) || "."}`);
  const mode = modeOf(before);
  const nodeHash = directoryNodeHash(mode, children);
  if (includeEntry) {
    if (destination) {
      await fs.promises.chmod(destination, mode);
      if (state.durable) await syncDirectory(destination);
    }
    state.entries.push({ path: portable(relative), type: "directory", mode, nodeHash });
  }
  return { nodeHash };
}

async function walkFile(state: WalkState, relative: string, expected: BigStats): Promise<string> {
  state.fileCount++;
  if (state.fileCount > DEFINITION_LIMITS.candidateFiles) throw new Error("Candidate exceeds its file-count limit");
  const bytes = safeSize(expected, relative);
  if (bytes > DEFINITION_LIMITS.candidateFileBytes) throw new Error(`Candidate file is too large: ${portable(relative)}`);
  state.totalBytes += bytes;
  if (state.totalBytes > DEFINITION_LIMITS.candidateTreeBytes) throw new Error("Candidate exceeds its tree byte limit");
  const source = path.join(state.root, relative);
  let digest: string;
  if (state.destination) {
    const destination = path.join(state.destination, relative);
    const handle = await fs.promises.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      assertUnchanged(expected, opened, `Candidate file changed while opened: ${portable(relative)}`);
      await fs.promises.copyFile(`/proc/self/fd/${handle.fd}`, destination, REFLINK_FLAGS);
      await fs.promises.chmod(destination, modeOf(opened));
      digest = await hashStableFile(destination, await lstat(destination), relative);
      assertUnchanged(opened, await handle.stat({ bigint: true }), `Candidate file changed while cloned: ${portable(relative)}`);
      assertUnchanged(opened, await lstat(source), `Candidate file was replaced while cloned: ${portable(relative)}`);
      if (state.durable) await syncFile(destination);
    } finally { await handle.close(); }
  } else {
    digest = await hashStableFile(source, expected, relative);
  }
  const mode = modeOf(expected);
  const nodeHash = fileNodeHash(mode, bytes, digest);
  state.entries.push({ path: portable(relative), type: "file", mode, bytes, digest, nodeHash });
  return nodeHash;
}

async function walkSymlink(state: WalkState, relative: string, before: BigStats): Promise<string> {
  const source = path.join(state.root, relative);
  const target = await readLink(source);
  assertSafeSymlink(portable(relative), target);
  if (state.destination) await fs.promises.symlink(target, path.join(state.destination, relative));
  assertUnchanged(before, await lstat(source), `Candidate symlink changed while scanned: ${portable(relative)}`);
  if (await readLink(source) !== target) throw new Error(`Candidate symlink target changed: ${portable(relative)}`);
  const mode = modeOf(before);
  const nodeHash = symlinkNodeHash(mode, target);
  state.entries.push({ path: portable(relative), type: "symlink", mode, target, nodeHash });
  return nodeHash;
}

async function hashStableFile(filePath: string, expected: BigStats, relative: string): Promise<string> {
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    assertUnchanged(expected, before, `Candidate file changed while hashing: ${portable(relative)}`);
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0n;
    while (offset < before.size) {
      const length = Number((before.size - offset) < BigInt(buffer.length) ? before.size - offset : BigInt(buffer.length));
      const { bytesRead } = await handle.read(buffer, 0, length, Number(offset));
      if (bytesRead === 0) throw new Error(`Candidate file changed while hashing: ${portable(relative)}`);
      hash.update(buffer.subarray(0, bytesRead));
      offset += BigInt(bytesRead);
    }
    assertUnchanged(before, await handle.stat({ bigint: true }), `Candidate file changed while hashing: ${portable(relative)}`);
    return `sha256:${hash.digest("hex")}`;
  } finally { await handle.close(); }
}

function finishManifest(state: WalkState, rootMode: number, treeHash: string): CandidateTreeManifest {
  state.entries.sort((left, right) => compareBytes(left.path, right.path));
  const manifest: CandidateTreeManifest = {
    rootMode,
    entries: state.entries,
    fileCount: state.fileCount,
    totalBytes: state.totalBytes,
    treeHash,
  };
  assertCandidateTreeManifest(manifest);
  return manifest;
}

function image(entry: CandidateTreeEntry): CandidatePathImage {
  return entry.type === "file"
    ? { type: entry.type, mode: entry.mode, digest: entry.digest, bytes: entry.bytes }
    : entry.type === "symlink"
      ? { type: entry.type, mode: entry.mode, target: entry.target }
      : { type: entry.type, mode: entry.mode };
}

function contentIdentity(entry: CandidateTreeEntry): string {
  if (entry.type === "file") return `file:${entry.digest}:${entry.bytes}`;
  if (entry.type === "symlink") return `symlink:${entry.target}`;
  return "directory";
}

function directoryNodeHash(mode: number, children: readonly ChildNode[]): string {
  return stableHash({
    type: "directory",
    mode,
    children: [...children].sort((left, right) => compareBytes(left.name, right.name)),
  });
}
function fileNodeHash(mode: number, bytes: number, digest: string): string { return stableHash({ type: "file", mode, bytes, digest }); }
function symlinkNodeHash(mode: number, target: string): string { return stableHash({ type: "symlink", mode, target }); }

export function validateCandidatePath(value: string, allowDirectoryRule = false): string {
  const body = allowDirectoryRule && value.endsWith("/") ? value.slice(0, -1) : value;
  if (!body || body !== body.normalize("NFC") || path.posix.isAbsolute(body) || body.includes("\\") || /[\u0000-\u001f\u007f]/u.test(body)) {
    throw new Error(`Unsafe candidate path ${JSON.stringify(value)}`);
  }
  const parts = body.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || VCS_NAMES.has(part))) throw new Error(`Protected candidate path ${value}`);
  for (let index = 0; index < parts.length - 1; index++) {
    if (parts[index] === ".pi" && STATE_NAMES.has(parts[index + 1]!)) throw new Error(`Protected candidate path ${value}`);
    if (parts[index] === ".pi" && parts[index + 1] === "agent" && STATE_NAMES.has(parts[index + 2] ?? "")) {
      throw new Error(`Protected candidate path ${value}`);
    }
  }
  if (Buffer.byteLength(value) > DEFINITION_LIMITS.projectSnapshotPathBytes) throw new Error(`Candidate path is too long: ${value}`);
  return value;
}

function assertSafeSymlink(relative: string, target: string): void {
  if (!target || target.includes("\0") || path.posix.isAbsolute(target) || /[\u0000-\u001f\u007f]/u.test(target)) {
    throw new Error(`Candidate symlink is unsafe: ${relative}`);
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target));
  if (resolved === ".." || resolved.startsWith("../") || path.posix.isAbsolute(resolved)) {
    throw new Error(`Candidate symlink escapes its workspace: ${relative}`);
  }
}

async function readNames(directory: string): Promise<string[]> {
  const encoded = await fs.promises.readdir(directory, { encoding: "buffer" });
  const names = encoded.map((name) => {
    const decoded = name.toString("utf8");
    if (!Buffer.from(decoded).equals(name)) throw new Error(`Candidate path is not valid UTF-8 under ${directory}`);
    return decoded;
  });
  return names.sort(compareBytes);
}

async function readLink(filePath: string): Promise<string> {
  const encoded = await fs.promises.readlink(filePath, { encoding: "buffer" });
  const decoded = encoded.toString("utf8");
  if (!Buffer.from(decoded).equals(encoded)) throw new Error(`Candidate symlink is not valid UTF-8: ${filePath}`);
  return decoded;
}

function assertUnchanged(before: BigStats, after: BigStats, message: string): void {
  if (
    before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
    || before.nlink !== after.nlink || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
  ) throw new Error(message);
}

function reflinkError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV"
    ? new Error("Btrfs reflink cloning is required for candidate workspaces", { cause: error })
    : error instanceof Error ? error : new Error(String(error));
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.promises.open(filePath, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function makeRemovable(root: string): Promise<void> {
  let stat: fs.Stats;
  try { stat = await fs.promises.lstat(root); } catch { return; }
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) return void await fs.promises.chmod(root, 0o600).catch(() => undefined);
  await fs.promises.chmod(root, 0o700).catch(() => undefined);
  for (const name of await fs.promises.readdir(root)) await makeRemovable(path.join(root, name));
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function portable(value: string): string { return value.split(path.sep).join("/"); }
function compareBytes(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function validMode(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= 0o777; }
function modeOf(stat: BigStats): number { return Number(stat.mode & 0o777n); }
function safeSize(stat: BigStats, relative: string): number {
  if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Candidate file is too large: ${portable(relative)}`);
  return Number(stat.size);
}
function isHash(value: unknown): value is string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
async function lstat(filePath: string): Promise<BigStats> { return await fs.promises.lstat(filePath, { bigint: true }); }
type BigStats = fs.BigIntStats;
