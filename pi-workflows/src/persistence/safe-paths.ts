import fs from "node:fs";
import path from "node:path";

export interface SafeExistingFile {
  path: string;
  size: number;
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

export async function readBoundedTextFile(filePath: string, maxBytes: number): Promise<string> {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe replay file: ${filePath}`);
  if (stat.size > maxBytes) throw new Error(`replay file exceeds ${maxBytes} bytes: ${filePath}`);
  const text = await fs.promises.readFile(filePath, "utf8");
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`replay file exceeds ${maxBytes} bytes: ${filePath}`);
  return text;
}
