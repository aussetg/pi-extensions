import fs from "node:fs";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";

export interface SafeExistingFile {
  path: string;
  size: number;
}

export interface SafeOpenExistingFile extends SafeExistingFile {
  handle: FileHandle;
}

export interface SafeExistingDir {
  path: string;
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeSafeRelativePath(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw === "" || raw.includes("\0")) return undefined;
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw) || raw.startsWith("\\\\")) return undefined;
  if (raw.includes("\\")) return undefined;
  if (raw.split("/").some((part) => part === "..")) return undefined;

  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized === "" || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) return undefined;
  if (normalized.split("/").some((part) => part === "" || part === "..")) return undefined;
  return normalized;
}

export function safeResolveRelative(root: string, raw: unknown): string | undefined {
  const normalized = normalizeSafeRelativePath(raw);
  if (!normalized) return undefined;
  const resolved = path.resolve(root, ...normalized.split("/"));
  return isInside(root, resolved) ? resolved : undefined;
}

export async function safeResolveExistingFile(root: string, raw: unknown, options: { maxBytes?: number } = {}): Promise<SafeExistingFile | undefined> {
  const resolved = safeResolveRelative(root, raw);
  if (!resolved) return undefined;
  try {
    const rootStat = await fs.promises.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return undefined;
    const stat = await fs.promises.lstat(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    if (options.maxBytes !== undefined && stat.size > options.maxBytes) return undefined;

    const [rootReal, resolvedReal] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(resolved)]);
    if (!isInside(rootReal, resolvedReal)) return undefined;
    return { path: resolved, size: stat.size };
  } catch {
    return undefined;
  }
}

export async function withSafeExistingFile<T>(root: string, raw: unknown, options: { maxBytes?: number } = {}, fn: (file: SafeOpenExistingFile) => Promise<T>): Promise<T | undefined> {
  const file = await openSafeExistingFile(root, raw, options);
  if (!file) return undefined;
  try {
    return await fn(file);
  } finally {
    await file.handle.close().catch(() => undefined);
  }
}

export async function readSafeTextFile(root: string, raw: unknown, maxBytes: number): Promise<string | undefined> {
  return withSafeExistingFile(root, raw, { maxBytes }, async (file) => readOpenTextFile(file, maxBytes));
}

export async function copySafeExistingFile(root: string, raw: unknown, targetPath: string, options: { maxBytes: number }): Promise<SafeExistingFile | undefined> {
  return withSafeExistingFile(root, raw, { maxBytes: options.maxBytes }, async (file) => copyOpenFile(file, targetPath, options.maxBytes));
}

export async function copyOpenFile(file: SafeOpenExistingFile, targetPath: string, maxBytes: number): Promise<SafeExistingFile> {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${process.hrtime.bigint()}.tmp`);
  let output: FileHandle | undefined;
  try {
    output = await fs.promises.open(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, maxBytes + 1)));
    let total = 0;
    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      const { bytesRead } = await file.handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes: ${file.path}`);
      await output.write(buffer, 0, bytesRead);
    }
    await output.close();
    output = undefined;
    await fs.promises.rename(tmpPath, targetPath);
    return { path: targetPath, size: total };
  } catch (err) {
    await output?.close().catch(() => undefined);
    await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function safeResolveExistingDir(root: string, raw: unknown): Promise<SafeExistingDir | undefined> {
  const resolved = safeResolveRelative(root, raw);
  if (!resolved) return undefined;
  try {
    const rootStat = await fs.promises.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return undefined;
    const stat = await fs.promises.lstat(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;

    const [rootReal, resolvedReal] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(resolved)]);
    if (!isInside(rootReal, resolvedReal)) return undefined;
    return { path: resolved };
  } catch {
    return undefined;
  }
}

async function openSafeExistingFile(root: string, raw: unknown, options: { maxBytes?: number } = {}): Promise<SafeOpenExistingFile | undefined> {
  const resolved = safeResolveRelative(root, raw);
  if (!resolved) return undefined;
  let handle: FileHandle | undefined;
  try {
    const rootStat = await fs.promises.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return undefined;
    const rootReal = await fs.promises.realpath(root);

    const statBeforeOpen = await fs.promises.lstat(resolved);
    if (!statBeforeOpen.isFile() || statBeforeOpen.isSymbolicLink()) return undefined;
    if (options.maxBytes !== undefined && statBeforeOpen.size > options.maxBytes) return undefined;

    handle = await fs.promises.open(resolved, fs.constants.O_RDONLY | noFollowFlag());
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    if (options.maxBytes !== undefined && stat.size > options.maxBytes) return undefined;

    const openedReal = await realpathOpenHandle(handle);
    if (!openedReal || !isInside(rootReal, openedReal)) return undefined;

    const file = { path: resolved, size: stat.size, handle };
    handle = undefined;
    return file;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function realpathOpenHandle(handle: FileHandle): Promise<string | undefined> {
  try {
    return await fs.promises.realpath(`/proc/self/fd/${handle.fd}`);
  } catch {
    return undefined;
  }
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}

async function readOpenTextFile(file: SafeOpenExistingFile, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, maxBytes + 1)));
  let total = 0;
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const { bytesRead } = await file.handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes: ${file.path}`);
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export async function readBoundedTextFile(filePath: string, maxBytes: number): Promise<string> {
  const before = await fs.promises.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`unsafe file: ${filePath}`);
  if (before.size > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes: ${filePath}`);

  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`unsafe file: ${filePath}`);
    if (stat.size > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes: ${filePath}`);

    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, maxBytes + 1)));
    let total = 0;
    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes: ${filePath}`);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await handle.close();
  }
}
