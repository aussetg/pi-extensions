import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import { PROJECT_CONFIG_DIR_NAME } from "../persistence/paths.js";
import { stableHash } from "../utils/hashes.js";

export type ProjectSnapshotExclusionReason = "vcs-internal" | "workflow-state";

export interface ProjectSnapshotExclusion {
  path: string;
  type: "directory" | "file" | "symlink" | "special";
  reason: ProjectSnapshotExclusionReason;
}

interface ProjectSnapshotEntryBase {
  path: string;
  mode: number;
  nodeHash: string;
}

export type ProjectSnapshotEntry =
  | (ProjectSnapshotEntryBase & {
      type: "directory";
    })
  | (ProjectSnapshotEntryBase & {
      type: "file";
      bytes: number;
      digest: string;
    })
  | (ProjectSnapshotEntryBase & {
      type: "symlink";
      target: string;
    });

/**
 * The tree hash identifies only what a model can observe. The live absolute
 * source path and excluded VCS/state contents are deliberately not inputs.
 * Entries describe the exact admitted destination; they do not claim that
 * the changing live source was observed at one global atomic instant.
 */
export interface ProjectSnapshotManifest {
  sourceRoot: string;
  cwd: string;
  rootMode: number;
  entries: ProjectSnapshotEntry[];
  exclusions: ProjectSnapshotExclusion[];
  fileCount: number;
  totalBytes: number;
  treeHash: string;
  manifestHash: string;
}

/** Current semantic live-project state, using the same visibility policy and tree hash as launch capture. */
export interface ProjectSourceState {
  rootMode: number;
  entries: ProjectSnapshotEntry[];
  exclusions: ProjectSnapshotExclusion[];
  fileCount: number;
  totalBytes: number;
  treeHash: string;
}

interface CaptureState {
  sourceRoot: string;
  destinationRoot: string;
  entries: ProjectSnapshotEntry[];
  exclusions: ProjectSnapshotExclusion[];
  fileCount: number;
  totalBytes: number;
}

interface NodeResult {
  name: string;
  nodeHash: string;
}

const REFLINK_FLAGS = fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE_FORCE;
const BTRFS_SUPER_MAGIC = 0x9123683e;
const WORKFLOW_STATE_DIRS = new Set(["workflow-runs", "workflow-drafts", "workflow-locks"]);
const VCS_INTERNAL_NAMES = new Set([".git", ".hg", ".svn", ".jj", ".bzr", "_darcs", "CVS"]);

/**
 * Clone and admit the project in one source traversal. Every regular file is
 * cloned with FICLONE_FORCE, then the destination inode is hashed. A source
 * inode changing or being replaced before that destination hash completes
 * aborts the whole capture.
 */
export async function captureProjectSnapshot(
  sourceRootInput: string,
  sourceCwdInput: string,
  destinationRootInput: string,
): Promise<ProjectSnapshotManifest> {
  const sourceRoot = await fs.promises.realpath(sourceRootInput);
  const sourceCwd = await fs.promises.realpath(sourceCwdInput);
  assertInside(sourceRoot, sourceCwd, "Project cwd");

  let destinationRoot = path.resolve(destinationRootInput);
  if (inside(sourceRoot, destinationRoot) || inside(destinationRoot, sourceRoot)) {
    throw new Error("Project snapshot source and destination must be disjoint");
  }

  const rootStat = await lstatBigInt(sourceRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Project snapshot source root must be a real directory");
  }

  const destinationName = path.basename(destinationRoot);
  const destinationParentInput = path.dirname(destinationRoot);
  await fs.promises.mkdir(destinationParentInput, { recursive: true, mode: 0o700 });
  const destinationParent = await fs.promises.realpath(destinationParentInput);
  destinationRoot = path.join(destinationParent, destinationName);
  if (inside(sourceRoot, destinationRoot) || inside(destinationRoot, sourceRoot)) {
    throw new Error("Project snapshot source and destination must be disjoint");
  }
  const [sourceFilesystem, destinationFilesystem, destinationParentStat] = await Promise.all([
    fs.promises.statfs(sourceRoot),
    fs.promises.statfs(destinationParent),
    lstatBigInt(destinationParent),
  ]);
  if (
    filesystemType(sourceFilesystem.type) !== BTRFS_SUPER_MAGIC
    || filesystemType(destinationFilesystem.type) !== BTRFS_SUPER_MAGIC
    || rootStat.dev !== destinationParentStat.dev
  ) {
    throw new Error("Project snapshots require one shared Btrfs filesystem");
  }
  await fs.promises.mkdir(destinationRoot, { recursive: false, mode: 0o700 });
  const state: CaptureState = {
    sourceRoot,
    destinationRoot,
    entries: [],
    exclusions: [],
    fileCount: 0,
    totalBytes: 0,
  };

  try {
    const root = await cloneDirectory(state, "", rootStat, false);
    const rootAfter = await lstatBigInt(sourceRoot);
    assertUnchanged(rootStat, rootAfter, "Project root changed during snapshot capture");
    await fs.promises.chmod(destinationRoot, modeOf(rootStat));
    await syncDirectory(destinationRoot);

    state.entries.sort((left, right) => compareBytes(left.path, right.path));
    state.exclusions.sort((left, right) => compareBytes(left.path, right.path));
    const body = {
      sourceRoot,
      cwd: relativePath(sourceRoot, sourceCwd),
      rootMode: modeOf(rootStat),
      entries: state.entries,
      exclusions: state.exclusions,
      fileCount: state.fileCount,
      totalBytes: state.totalBytes,
      treeHash: root.nodeHash,
    };
    return { ...body, manifestHash: stableHash(body) };
  } catch (error) {
    await makeTreeRemovable(destinationRoot).catch(() => undefined);
    await fs.promises.rm(destinationRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Pi's extension host reports Linux statfs magic numbers as signed int32. */
function filesystemType(value: number | bigint): number {
  return Number(value) >>> 0;
}

/** Re-hash a captured tree without consulting the live project. */
export async function verifyProjectSnapshot(
  snapshotRootInput: string,
  manifest: ProjectSnapshotManifest,
): Promise<void> {
  assertProjectSnapshotManifest(manifest);
  const snapshotRoot = path.resolve(snapshotRootInput);
  const stat = await lstatBigInt(snapshotRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || modeOf(stat) !== manifest.rootMode) {
    throw new Error("Project snapshot root does not match its manifest");
  }

  const actual: ProjectSnapshotEntry[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  const visit = async (relative: string, expected: BigIntStats): Promise<string> => {
    const absolute = relative ? path.join(snapshotRoot, relative) : snapshotRoot;
    if (expected.isDirectory()) {
      const children = await readDirectoryNames(absolute);
      const nodes: NodeResult[] = [];
      for (const name of children) {
        const child = relative ? path.join(relative, name) : name;
        const childStat = await lstatBigInt(path.join(snapshotRoot, child));
        nodes.push({ name, nodeHash: await visit(child, childStat) });
      }
      const nodeHash = directoryNodeHash(modeOf(expected), nodes);
      if (relative) actual.push({
        path: portablePath(relative),
        type: "directory",
        mode: modeOf(expected),
        nodeHash,
      });
      return nodeHash;
    }
    if (expected.isFile()) {
      const bytes = safeSize(expected, relative);
      const digest = await hashStableFile(absolute, expected, "Project snapshot file changed during verification");
      const nodeHash = fileNodeHash(modeOf(expected), bytes, digest);
      actual.push({ path: portablePath(relative), type: "file", mode: modeOf(expected), bytes, digest, nodeHash });
      fileCount++;
      totalBytes += bytes;
      return nodeHash;
    }
    if (expected.isSymbolicLink()) {
      const target = await readUtf8Link(absolute);
      const nodeHash = symlinkNodeHash(modeOf(expected), target);
      actual.push({ path: portablePath(relative), type: "symlink", mode: modeOf(expected), target, nodeHash });
      return nodeHash;
    }
    throw new Error(`Unsupported entry in project snapshot: ${portablePath(relative)}`);
  };

  const treeHash = await visit("", stat);
  actual.sort((left, right) => compareBytes(left.path, right.path));
  if (
    treeHash !== manifest.treeHash
    || fileCount !== manifest.fileCount
    || totalBytes !== manifest.totalBytes
    || stableHash(actual) !== stableHash(manifest.entries)
  ) {
    throw new Error("Project snapshot content does not match its manifest");
  }
  const cwd = path.resolve(snapshotRoot, manifest.cwd);
  assertInside(snapshotRoot, cwd, "Project snapshot cwd");
}

/**
 * Scan the live project without copying it. VCS internals and workflow state
 * are omitted exactly as they are during launch capture. This is evidence for
 * verification/apply freshness, not a replacement for the immutable launch
 * snapshot.
 */
export async function scanProjectSource(sourceRootInput: string): Promise<ProjectSourceState> {
  const requested = path.resolve(sourceRootInput);
  const requestedStat = await lstatBigInt(requested);
  if (requestedStat.isSymbolicLink()) throw new Error("Live project root must not be a symlink");
  const sourceRoot = await fs.promises.realpath(requested);
  if (sourceRoot !== requested) throw new Error("Live project root path contains a symlink");
  const rootStat = await lstatBigInt(sourceRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Live project root must be a real directory");
  const entries: ProjectSnapshotEntry[] = [];
  const exclusions: ProjectSnapshotExclusion[] = [];
  let fileCount = 0;
  let totalBytes = 0;

  const visit = async (relative: string, before: BigIntStats, includeEntry: boolean): Promise<string> => {
    const absolute = relative ? path.join(sourceRoot, relative) : sourceRoot;
    const children = await readDirectoryNames(absolute);
    const nodes: NodeResult[] = [];
    for (const name of children) {
      const child = relative ? path.join(relative, name) : name;
      assertPathBound(child);
      const portable = portablePath(child);
      const childStat = await lstatBigInt(path.join(sourceRoot, child));
      const excluded = exclusionReason(portable);
      if (excluded) {
        exclusions.push({ path: portable, type: statType(childStat), reason: excluded });
        continue;
      }
      let nodeHash: string;
      if (childStat.isDirectory() && !childStat.isSymbolicLink()) {
        nodeHash = await visit(child, childStat, true);
      } else if (childStat.isFile()) {
        const bytes = safeSize(childStat, child);
        if (++fileCount > DEFINITION_LIMITS.projectSnapshotFiles) throw new Error("Live project exceeds the file-count limit");
        if (bytes > DEFINITION_LIMITS.projectSnapshotFileBytes) throw new Error(`Live project file is too large: ${portable}`);
        totalBytes += bytes;
        if (totalBytes > DEFINITION_LIMITS.projectSnapshotTotalBytes) throw new Error("Live project exceeds the byte limit");
        const digest = await hashStableFile(path.join(sourceRoot, child), childStat, `Live project file changed while scanned: ${portable}`);
        const mode = modeOf(childStat);
        nodeHash = fileNodeHash(mode, bytes, digest);
        entries.push({ path: portable, type: "file", mode, bytes, digest, nodeHash });
      } else if (childStat.isSymbolicLink()) {
        const target = await readUtf8Link(path.join(sourceRoot, child));
        assertSafeSymlink(portable, target);
        assertUnchanged(childStat, await lstatBigInt(path.join(sourceRoot, child)), `Live project symlink changed: ${portable}`);
        const mode = modeOf(childStat);
        nodeHash = symlinkNodeHash(mode, target);
        entries.push({ path: portable, type: "symlink", mode, target, nodeHash });
      } else {
        throw new Error(`Unsupported special file in live project: ${portable}`);
      }
      nodes.push({ name, nodeHash });
    }
    assertUnchanged(before, await lstatBigInt(absolute), `Live project directory changed while scanned: ${portablePath(relative) || "."}`);
    const mode = modeOf(before);
    const nodeHash = directoryNodeHash(mode, nodes);
    if (includeEntry) entries.push({ path: portablePath(relative), type: "directory", mode, nodeHash });
    return nodeHash;
  };

  const treeHash = await visit("", rootStat, false);
  entries.sort((left, right) => compareBytes(left.path, right.path));
  exclusions.sort((left, right) => compareBytes(left.path, right.path));
  return { rootMode: modeOf(rootStat), entries, exclusions, fileCount, totalBytes, treeHash };
}

/** Validate the bounded record itself without traversing snapshot content. */
export function assertProjectSnapshotManifest(manifest: ProjectSnapshotManifest): void {
  if (!manifest) throw new Error("Invalid project snapshot manifest");
  if (Object.keys(manifest).sort().join(",")
    !== "cwd,entries,exclusions,fileCount,manifestHash,rootMode,sourceRoot,totalBytes,treeHash") {
    throw new Error("Project snapshot manifest has unexpected fields");
  }
  const { manifestHash, ...body } = manifest;
  if (stableHash(body) !== manifestHash) throw new Error("Project snapshot manifest hash mismatch");
  if (!isHash(manifest.treeHash)) throw new Error("Project snapshot tree hash is invalid");
  if (!path.isAbsolute(manifest.sourceRoot)) throw new Error("Project snapshot source root is invalid");
  if (!validRelativePath(manifest.cwd, true)) throw new Error("Project snapshot cwd is invalid");
  if (!Number.isSafeInteger(manifest.rootMode) || manifest.rootMode < 0 || manifest.rootMode > 0o777) {
    throw new Error("Project snapshot root mode is invalid");
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length > DEFINITION_LIMITS.projectSnapshotFiles * 2) {
    throw new Error("Project snapshot entries are invalid");
  }
  if (!Array.isArray(manifest.exclusions) || manifest.exclusions.length > DEFINITION_LIMITS.candidateScanEntries) {
    throw new Error("Project snapshot exclusions are invalid");
  }
  if (!Number.isSafeInteger(manifest.fileCount) || manifest.fileCount < 0 || manifest.fileCount > DEFINITION_LIMITS.projectSnapshotFiles) {
    throw new Error("Project snapshot file count is invalid");
  }
  if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0 || manifest.totalBytes > DEFINITION_LIMITS.projectSnapshotTotalBytes) {
    throw new Error("Project snapshot byte count is invalid");
  }

  let previous = "";
  let countedFiles = 0;
  let countedBytes = 0;
  for (const [index, entry] of manifest.entries.entries()) {
    if (!validRelativePath(entry.path, false) || (index > 0 && compareBytes(previous, entry.path) >= 0)) {
      throw new Error("Project snapshot entry paths are invalid or unordered");
    }
    if (exclusionReason(entry.path)) throw new Error(`Excluded path appears in project snapshot entries: ${entry.path}`);
    previous = entry.path;
    if (!Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || !isHash(entry.nodeHash)) {
      throw new Error(`Project snapshot entry is invalid: ${entry.path}`);
    }
    if (entry.type === "file") {
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !isHash(entry.digest)) {
        throw new Error(`Project snapshot file is invalid: ${entry.path}`);
      }
      if (entry.nodeHash !== fileNodeHash(entry.mode, entry.bytes, entry.digest)) {
        throw new Error(`Project snapshot file node hash is invalid: ${entry.path}`);
      }
      countedFiles++;
      countedBytes += entry.bytes;
    } else if (entry.type === "symlink") {
      assertSafeSymlink(entry.path, entry.target);
      if (entry.nodeHash !== symlinkNodeHash(entry.mode, entry.target)) {
        throw new Error(`Project snapshot symlink node hash is invalid: ${entry.path}`);
      }
    } else if (entry.type !== "directory") {
      throw new Error(`Project snapshot entry type is invalid: ${String((entry as unknown as { path?: unknown }).path)}`);
    }
  }
  if (countedFiles !== manifest.fileCount || countedBytes !== manifest.totalBytes) {
    throw new Error("Project snapshot totals do not match its entries");
  }
  previous = "";
  for (const [index, exclusion] of manifest.exclusions.entries()) {
    if (
      !validRelativePath(exclusion.path, false)
      || (index > 0 && compareBytes(previous, exclusion.path) >= 0)
      || !["directory", "file", "symlink", "special"].includes(exclusion.type)
      || !["vcs-internal", "workflow-state"].includes(exclusion.reason)
      || exclusionReason(exclusion.path) !== exclusion.reason
    ) throw new Error("Project snapshot exclusion record is invalid");
    previous = exclusion.path;
  }
}

async function cloneDirectory(
  state: CaptureState,
  relative: string,
  before: BigIntStats,
  includeEntry: boolean,
): Promise<{ nodeHash: string }> {
  const source = relative ? path.join(state.sourceRoot, relative) : state.sourceRoot;
  const destination = relative ? path.join(state.destinationRoot, relative) : state.destinationRoot;
  if (includeEntry) await fs.promises.mkdir(destination, { recursive: false, mode: 0o700 });

  const children = await readDirectoryNames(source);
  const childNodes: NodeResult[] = [];
  for (const name of children) {
    const childRelative = relative ? path.join(relative, name) : name;
    assertPathBound(childRelative);
    const sourcePath = path.join(state.sourceRoot, childRelative);
    const childBefore = await lstatBigInt(sourcePath);
    const exclusion = exclusionReason(portablePath(childRelative));
    if (exclusion) {
      state.exclusions.push({
        path: portablePath(childRelative),
        type: statType(childBefore),
        reason: exclusion,
      });
      continue;
    }

    let nodeHash: string;
    if (childBefore.isDirectory()) {
      nodeHash = (await cloneDirectory(state, childRelative, childBefore, true)).nodeHash;
    } else if (childBefore.isFile()) {
      nodeHash = await cloneFile(state, childRelative, childBefore);
    } else if (childBefore.isSymbolicLink()) {
      nodeHash = await cloneSymlink(state, childRelative, childBefore);
    } else {
      throw new Error(`Unsupported special file in project snapshot: ${portablePath(childRelative)}`);
    }
    childNodes.push({ name, nodeHash });
  }

  const after = await lstatBigInt(source);
  assertUnchanged(before, after, `Project directory changed during snapshot capture: ${portablePath(relative) || "."}`);
  const mode = modeOf(before);
  const nodeHash = directoryNodeHash(mode, childNodes);
  if (includeEntry) {
    await fs.promises.chmod(destination, mode);
    state.entries.push({ path: portablePath(relative), type: "directory", mode, nodeHash });
  }
  return { nodeHash };
}

async function cloneFile(state: CaptureState, relative: string, pathStat: BigIntStats): Promise<string> {
  state.fileCount++;
  if (state.fileCount > DEFINITION_LIMITS.projectSnapshotFiles) {
    throw new Error("Project exceeds the snapshot file-count limit");
  }
  const bytes = safeSize(pathStat, relative);
  if (bytes > DEFINITION_LIMITS.projectSnapshotFileBytes) {
    throw new Error(`Project snapshot file is too large: ${portablePath(relative)}`);
  }
  state.totalBytes += bytes;
  if (state.totalBytes > DEFINITION_LIMITS.projectSnapshotTotalBytes) {
    throw new Error("Project exceeds the snapshot byte limit");
  }

  const source = path.join(state.sourceRoot, relative);
  const destination = path.join(state.destinationRoot, relative);
  const handle = await fs.promises.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    assertUnchanged(pathStat, before, `Project file changed while opening for snapshot capture: ${portablePath(relative)}`);
    await fs.promises.copyFile(`/proc/self/fd/${handle.fd}`, destination, REFLINK_FLAGS);
    await fs.promises.chmod(destination, modeOf(before));
    const destinationStat = await lstatBigInt(destination);
    const digest = await hashStableFile(destination, destinationStat, "Reflink destination changed while hashing");
    const sourceAfter = await handle.stat({ bigint: true });
    assertUnchanged(before, sourceAfter, `Project file changed during snapshot capture: ${portablePath(relative)}`);
    const pathAfter = await lstatBigInt(source);
    assertUnchanged(before, pathAfter, `Project file was replaced during snapshot capture: ${portablePath(relative)}`);
    const mode = modeOf(before);
    const nodeHash = fileNodeHash(mode, bytes, digest);
    state.entries.push({ path: portablePath(relative), type: "file", mode, bytes, digest, nodeHash });
    return nodeHash;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOTSUP" || (error as NodeJS.ErrnoException).code === "EOPNOTSUPP") {
      throw new Error(`Btrfs reflink cloning is required for project snapshots: ${portablePath(relative)}`, { cause: error });
    }
    throw error;
  } finally {
    await handle.close();
  }
}

async function cloneSymlink(state: CaptureState, relative: string, before: BigIntStats): Promise<string> {
  const source = path.join(state.sourceRoot, relative);
  const destination = path.join(state.destinationRoot, relative);
  const target = await readUtf8Link(source);
  assertSafeSymlink(portablePath(relative), target);
  await fs.promises.symlink(target, destination);
  const after = await lstatBigInt(source);
  assertUnchanged(before, after, `Project symlink changed during snapshot capture: ${portablePath(relative)}`);
  if (await readUtf8Link(source) !== target) {
    throw new Error(`Project symlink target changed during snapshot capture: ${portablePath(relative)}`);
  }
  const mode = modeOf(before);
  const nodeHash = symlinkNodeHash(mode, target);
  state.entries.push({ path: portablePath(relative), type: "symlink", mode, target, nodeHash });
  return nodeHash;
}

async function hashStableFile(filePath: string, expected: BigIntStats, message: string): Promise<string> {
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    assertUnchanged(expected, before, message);
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0n;
    while (offset < before.size) {
      const length = Number(minBigInt(BigInt(buffer.length), before.size - offset));
      const { bytesRead } = await handle.read(buffer, 0, length, Number(offset));
      if (bytesRead === 0) throw new Error(message);
      digest.update(buffer.subarray(0, bytesRead));
      offset += BigInt(bytesRead);
    }
    const after = await handle.stat({ bigint: true });
    assertUnchanged(before, after, message);
    return `sha256:${digest.digest("hex")}`;
  } finally {
    await handle.close();
  }
}

function exclusionReason(relative: string): ProjectSnapshotExclusionReason | undefined {
  const parts = relative.split("/");
  if (parts.some((part) => VCS_INTERNAL_NAMES.has(part))) return "vcs-internal";
  for (let index = 0; index < parts.length - 1; index++) {
    if (parts[index] !== PROJECT_CONFIG_DIR_NAME) continue;
    if (WORKFLOW_STATE_DIRS.has(parts[index + 1]!)) return "workflow-state";
    if (parts[index + 1] === "agent" && WORKFLOW_STATE_DIRS.has(parts[index + 2] ?? "")) {
      return "workflow-state";
    }
  }
  return undefined;
}

function directoryNodeHash(mode: number, children: readonly NodeResult[]): string {
  return stableHash({
    type: "directory",
    mode,
    children: [...children]
      .sort((left, right) => compareBytes(left.name, right.name))
      .map(({ name, nodeHash }) => ({ name, nodeHash })),
  });
}

function fileNodeHash(mode: number, bytes: number, digest: string): string {
  return stableHash({ type: "file", mode, bytes, digest });
}

function symlinkNodeHash(mode: number, target: string): string {
  return stableHash({ type: "symlink", mode, target });
}

function assertSafeSymlink(relative: string, target: string): void {
  if (!target || target.includes("\0") || path.posix.isAbsolute(target)) {
    throw new Error(`Absolute or empty project symlink is not allowed: ${relative}`);
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target));
  if (resolved === ".." || resolved.startsWith("../") || path.posix.isAbsolute(resolved)) {
    throw new Error(`Project symlink escapes the snapshot: ${relative}`);
  }
}

async function readDirectoryNames(directory: string): Promise<string[]> {
  const encoded = await fs.promises.readdir(directory, { encoding: "buffer" });
  const names = encoded.map((name) => {
    const bytes = Buffer.from(name);
    const decoded = bytes.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(bytes)) {
      throw new Error(`Project contains a path that is not valid UTF-8 under ${directory}`);
    }
    return decoded;
  });
  names.sort(compareBytes);
  return names;
}

async function readUtf8Link(filePath: string): Promise<string> {
  const encoded = Buffer.from(await fs.promises.readlink(filePath, { encoding: "buffer" }));
  const decoded = encoded.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(encoded)) throw new Error(`Project symlink target is not valid UTF-8: ${filePath}`);
  return decoded;
}

function assertPathBound(relative: string): void {
  if (Buffer.byteLength(portablePath(relative)) > DEFINITION_LIMITS.projectSnapshotPathBytes) {
    throw new Error(`Project snapshot path is too long: ${portablePath(relative)}`);
  }
}

function validRelativePath(value: string, allowDot: boolean): boolean {
  if (value === ".") return allowDot;
  return value.length > 0
    && !path.posix.isAbsolute(value)
    && Buffer.byteLength(value) <= DEFINITION_LIMITS.projectSnapshotPathBytes
    && !/[\u0000-\u001f\u007f]/.test(value)
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function relativePath(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (!relative) return ".";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Path escapes project snapshot root");
  }
  return portablePath(relative);
}

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertInside(root: string, target: string, label: string): void {
  if (!inside(path.resolve(root), path.resolve(target))) throw new Error(`${label} escapes the project root`);
}

function modeOf(stat: BigIntStats): number {
  return Number(stat.mode & 0o777n);
}

function safeSize(stat: BigIntStats, relative: string): number {
  if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Project file is too large: ${portablePath(relative)}`);
  return Number(stat.size);
}

function assertUnchanged(before: BigIntStats, after: BigIntStats, message: string): void {
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.mode !== after.mode
    || before.nlink !== after.nlink
    || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs
  ) throw new Error(message);
}

function statType(stat: BigIntStats): ProjectSnapshotExclusion["type"] {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  if (stat.isSymbolicLink()) return "symlink";
  return "special";
}

function isHash(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

async function lstatBigInt(filePath: string): Promise<BigIntStats> {
  return await fs.promises.lstat(filePath, { bigint: true });
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function makeTreeRemovable(root: string): Promise<void> {
  let stat: fs.Stats;
  try { stat = await fs.promises.lstat(root); } catch { return; }
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    await fs.promises.chmod(root, 0o600).catch(() => undefined);
    return;
  }
  await fs.promises.chmod(root, 0o700).catch(() => undefined);
  for (const name of await fs.promises.readdir(root)) await makeTreeRemovable(path.join(root, name));
}

type BigIntStats = fs.BigIntStats;
