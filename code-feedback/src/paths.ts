import * as path from "node:path";
import { isRecord } from "./types.ts";

const VENDOR_PARTS = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
]);

export function resolveInputPath(input: unknown, cwd: string): string | undefined {
  const raw = readToolPath(input);
  if (!raw) return undefined;
  return path.resolve(cwd, raw);
}

export function normalizeToolPath(raw: string): string {
  return raw.startsWith("@") ? raw.slice(1) : raw;
}

export function readToolPath(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const raw = input.path;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const normalized = normalizeToolPath(raw);
  return normalized.length > 0 ? normalized : undefined;
}

export function displayPathFromRoot(filePath: string, projectRoot: string): string {
  const resolved = path.resolve(filePath);
  const root = path.resolve(projectRoot);
  const relative = path.relative(root, resolved);
  if (relative === "") return ".";
  return relative.startsWith("..") || path.isAbsolute(relative) ? resolved : relative;
}

export function isInsideOrEqual(filePath: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function projectRelativeText(text: string, projectRoot: string): string {
  const root = path.resolve(projectRoot);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return text.split(prefix).join("");
}

export function shouldTrackFile(filePath: string, projectRoot: string): boolean {
  const resolved = path.resolve(filePath);
  const root = path.resolve(projectRoot);
  const relative = path.relative(root, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;

  const parts = relative.split(path.sep).filter(Boolean);
  return !parts.some((part) => VENDOR_PARTS.has(part));
}
