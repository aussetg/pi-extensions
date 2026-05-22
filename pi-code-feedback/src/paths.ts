import * as path from "node:path";

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

export function resolveInputPath(input: unknown, cwd: string | undefined, projectRoot: string): string | undefined {
  const raw = readPath(input);
  if (!raw) return undefined;
  return path.resolve(path.isAbsolute(raw) ? raw : path.join(cwd || projectRoot, raw));
}

export function normalizeToolPath(raw: string): string {
  return raw.startsWith("@") ? raw.slice(1) : raw;
}

export function shouldTrackFile(filePath: string, projectRoot: string): boolean {
  const resolved = path.resolve(filePath);
  const root = path.resolve(projectRoot);
  const relative = path.relative(root, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;

  const parts = relative.split(path.sep).filter(Boolean);
  return !parts.some((part) => VENDOR_PARTS.has(part));
}

function readPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const candidate = input as { path?: unknown; filePath?: unknown };
  if (typeof candidate.path === "string" && candidate.path.length > 0) {
    const normalized = normalizeToolPath(candidate.path);
    return normalized.length > 0 ? normalized : undefined;
  }
  if (typeof candidate.filePath === "string" && candidate.filePath.length > 0) {
    const normalized = normalizeToolPath(candidate.filePath);
    return normalized.length > 0 ? normalized : undefined;
  }
  return undefined;
}

