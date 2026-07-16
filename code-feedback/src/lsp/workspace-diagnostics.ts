import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import { errorMessage, isErrorCode } from "../errors.ts";
import { readDescriptorUpTo, type ReadUtf8SkippedReason } from "../fs.ts";
import { isInsideOrEqual } from "../paths.ts";
import { throwIfAborted } from "./cancellation.ts";

export const DEFAULT_WORKSPACE_DIAGNOSTIC_FILE_LIMIT = 50;
export const MAX_WORKSPACE_DIAGNOSTIC_FILE_LIMIT = 200;
export const MAX_WORKSPACE_DIAGNOSTIC_ENTRIES = 50_000;

const IGNORED_WORKSPACE_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".mypy_cache",
  ".next",
  ".nox",
  ".nuxt",
  ".pytest_cache",
  ".ruff_cache",
  ".stack-work",
  ".tox",
  ".turbo",
  ".venv",
  "__pycache__",
  "bower_components",
  "build",
  "coverage",
  "dist",
  "dist-newstyle",
  "node_modules",
  "out",
  "target",
  "vendor",
  "venv",
]);

export interface WorkspaceDiagnosticDiscoveryOptions {
  projectRoot: string;
  targetPath: string;
  extensions: ReadonlySet<string>;
  limit: number;
  maxEntries?: number;
  signal?: AbortSignal;
}

export interface WorkspaceDiagnosticDiscovery {
  projectRoot: string;
  projectRealRoot: string;
  targetPath: string;
  files: string[];
  entriesVisited: number;
  ignoredDirectories: number;
  symlinksSkipped: number;
  boundaryEntriesSkipped: number;
  walkErrors: number;
  fileLimitReached: boolean;
  entryLimitReached: boolean;
}

export interface WorkspaceDiagnosticSourceReadResult {
  content?: string;
  size?: number;
  skippedReason?: ReadUtf8SkippedReason | "unsafe-path";
  limitBytes: number;
}

export async function discoverWorkspaceDiagnosticFiles(
  options: WorkspaceDiagnosticDiscoveryOptions,
): Promise<WorkspaceDiagnosticDiscovery> {
  throwIfAborted(options.signal);
  const projectRoot = path.resolve(options.projectRoot);
  const targetPath = path.resolve(projectRoot, options.targetPath);
  const maxEntries = normalizePositiveInteger(options.maxEntries ?? MAX_WORKSPACE_DIAGNOSTIC_ENTRIES, "workspace diagnostic entry limit");
  const limit = normalizeWorkspaceDiagnosticFileLimit(options.limit);

  if (!isInsideOrEqual(targetPath, projectRoot)) {
    throw new Error(`Workspace diagnostic target is outside the project root: ${targetPath}`);
  }

  const projectRealRoot = await realpathOrThrow(projectRoot, "project root");
  const targetStat = await lstatOrThrow(targetPath, "workspace diagnostic target");
  if (targetStat.isSymbolicLink() && targetPath !== projectRoot) {
    throw new Error(`Workspace diagnostic target must not be a symbolic link: ${targetPath}`);
  }
  const targetTypeStat = targetStat.isSymbolicLink()
    ? await statOrThrow(targetPath, "workspace diagnostic target")
    : targetStat;
  if (!targetTypeStat.isDirectory() && !targetTypeStat.isFile()) {
    throw new Error(`Workspace diagnostic target is not a regular file or directory: ${targetPath}`);
  }

  const targetRealPath = await realpathOrThrow(targetPath, "workspace diagnostic target");
  const expectedTargetRealPath = path.resolve(projectRealRoot, path.relative(projectRoot, targetPath));
  if (!isInsideOrEqual(targetRealPath, projectRealRoot)) {
    throw new Error(`Workspace diagnostic target resolves outside the project root: ${targetPath}`);
  }
  if (path.resolve(targetRealPath) !== path.resolve(expectedTargetRealPath)) {
    throw new Error(`Workspace diagnostic target resolves through a symbolic link: ${targetPath}`);
  }

  const discovery: WorkspaceDiagnosticDiscovery = {
    projectRoot,
    projectRealRoot,
    targetPath,
    files: [],
    entriesVisited: 0,
    ignoredDirectories: 0,
    symlinksSkipped: 0,
    boundaryEntriesSkipped: 0,
    walkErrors: 0,
    fileLimitReached: false,
    entryLimitReached: false,
  };

  const targetRelative = path.relative(projectRoot, targetPath);
  if (hasIgnoredWorkspacePart(targetRelative)) {
    throw new Error(`Workspace diagnostic target is inside an ignored directory: ${targetPath}`);
  }
  if (options.extensions.size === 0) return discovery;

  if (targetTypeStat.isFile()) {
    discovery.entriesVisited = 1;
    if (matchesExtension(targetPath, options.extensions)) discovery.files.push(targetPath);
    return discovery;
  }

  const pendingDirectories = [targetPath];
  scan: while (pendingDirectories.length > 0) {
    throwIfAborted(options.signal);
    const directory = pendingDirectories.pop()!;
    let entries: Dirent<string>[];
    try {
      entries = await fsPromises.readdir(directory, { withFileTypes: true });
    } catch {
      discovery.walkErrors += 1;
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    const childDirectories: string[] = [];
    for (const entry of entries) {
      throwIfAborted(options.signal);
      if (discovery.entriesVisited >= maxEntries) {
        discovery.entryLimitReached = true;
        break scan;
      }
      discovery.entriesVisited += 1;

      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        discovery.symlinksSkipped += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (IGNORED_WORKSPACE_DIRECTORIES.has(entry.name)) {
          discovery.ignoredDirectories += 1;
        } else {
          childDirectories.push(candidate);
        }
        continue;
      }
      if (!entry.isFile() || !matchesExtension(candidate, options.extensions)) continue;

      if (discovery.files.length >= limit) {
        discovery.fileLimitReached = true;
        break scan;
      }
      if (!(await hasExpectedRealPath(candidate, projectRoot, projectRealRoot))) {
        discovery.boundaryEntriesSkipped += 1;
        continue;
      }
      discovery.files.push(candidate);
    }

    for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
      pendingDirectories.push(childDirectories[index]);
    }
  }

  return discovery;
}

export function readWorkspaceDiagnosticSource(
  discovery: WorkspaceDiagnosticDiscovery,
  filePath: string,
  maxBytes: number,
): WorkspaceDiagnosticSourceReadResult {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("workspace diagnostic source limit must be a non-negative safe integer");
  }

  const resolved = path.resolve(filePath);
  if (!isInsideOrEqual(resolved, discovery.projectRoot)) {
    return { skippedReason: "unsafe-path", limitBytes: maxBytes };
  }

  let descriptor: number;
  try {
    // O_NOFOLLOW protects the basename. The descriptor-path check below also
    // catches a parent directory replaced with a symlink after discovery.
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    return {
      skippedReason: workspaceSourceOpenSkipReason(error),
      limitBytes: maxBytes,
    };
  }

  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      return { skippedReason: "not-file", size: stat.size, limitBytes: maxBytes };
    }
    if (!openedFileHasExpectedPath(descriptor, resolved, discovery)) {
      return { skippedReason: "unsafe-path", size: stat.size, limitBytes: maxBytes };
    }
    if (stat.size > maxBytes) {
      return { skippedReason: "too-large", size: stat.size, limitBytes: maxBytes };
    }

    const bytes = readDescriptorUpTo(descriptor, maxBytes + 1);
    if (bytes.length > maxBytes) {
      return { skippedReason: "too-large", size: bytes.length, limitBytes: maxBytes };
    }

    const content = bytes.toString("utf8");
    if (content.includes("\0")) {
      return { skippedReason: "binary", size: bytes.length, limitBytes: maxBytes };
    }
    return { content, size: bytes.length, limitBytes: maxBytes };
  } catch {
    return { skippedReason: "read-error", limitBytes: maxBytes };
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch {
      // The read result is already determined; there is nothing useful to do here.
    }
  }
}

export function normalizeWorkspaceDiagnosticFileLimit(value: unknown): number {
  const limit = normalizePositiveInteger(value, "workspace diagnostic file limit");
  if (limit > MAX_WORKSPACE_DIAGNOSTIC_FILE_LIMIT) {
    throw new Error(`Workspace diagnostic file limit must be at most ${MAX_WORKSPACE_DIAGNOSTIC_FILE_LIMIT}`);
  }
  return limit;
}

function normalizePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function matchesExtension(filePath: string, extensions: ReadonlySet<string>): boolean {
  return extensions.has(path.extname(filePath).toLowerCase());
}

function hasIgnoredWorkspacePart(relativePath: string): boolean {
  return relativePath.split(path.sep).filter(Boolean).some((part) => IGNORED_WORKSPACE_DIRECTORIES.has(part));
}

async function realpathOrThrow(filePath: string, label: string): Promise<string> {
  try {
    return await fsPromises.realpath(filePath);
  } catch (error) {
    throw new Error(`Cannot resolve ${label}: ${filePath}: ${errorMessage(error)}`);
  }
}

async function lstatOrThrow(filePath: string, label: string) {
  try {
    return await fsPromises.lstat(filePath);
  } catch (error) {
    throw new Error(`Cannot inspect ${label}: ${filePath}: ${errorMessage(error)}`);
  }
}

async function statOrThrow(filePath: string, label: string) {
  try {
    return await fsPromises.stat(filePath);
  } catch (error) {
    throw new Error(`Cannot inspect ${label}: ${filePath}: ${errorMessage(error)}`);
  }
}

async function hasExpectedRealPath(candidate: string, projectRoot: string, projectRealRoot: string): Promise<boolean> {
  try {
    const real = await fsPromises.realpath(candidate);
    const expected = path.resolve(projectRealRoot, path.relative(projectRoot, candidate));
    return isInsideOrEqual(real, projectRealRoot) && path.resolve(real) === path.resolve(expected);
  } catch {
    return false;
  }
}

function openedFileHasExpectedPath(
  descriptor: number,
  filePath: string,
  discovery: WorkspaceDiagnosticDiscovery,
): boolean {
  try {
    const openedRealPath = fs.readlinkSync(`/proc/self/fd/${descriptor}`);
    const expectedRealPath = path.resolve(
      discovery.projectRealRoot,
      path.relative(discovery.projectRoot, filePath),
    );
    return isInsideOrEqual(openedRealPath, discovery.projectRealRoot) &&
      path.resolve(openedRealPath) === path.resolve(expectedRealPath);
  } catch {
    return false;
  }
}

function workspaceSourceOpenSkipReason(error: unknown): WorkspaceDiagnosticSourceReadResult["skippedReason"] {
  if (isErrorCode(error, "ELOOP")) return "unsafe-path";
  if (isErrorCode(error, "ENOENT", "ENOTDIR")) return "missing";
  return "read-error";
}
