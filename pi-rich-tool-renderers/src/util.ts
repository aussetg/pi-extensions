import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ThemeLike = {
  name?: string;
  fg: (color: string, text: string) => string;
  bg?: (color: string, text: string) => string;
  bold: (text: string) => string;
};

export type ShellContextLike = {
  args?: unknown;
  cwd?: string;
  expanded?: boolean;
  invalidate?: () => void;
  isError?: boolean;
  isPartial?: boolean;
  lastComponent?: unknown;
  showImages?: boolean;
  toolCallId?: string;
};

export type TextContentLike = { type: "text"; text: string };
export type ImageContentLike = {
  type: "image";
  data: string;
  mimeType?: string;
  mime?: string;
};

export type ToolResultLike = {
  content?: unknown;
  details?: unknown;
  isError?: boolean;
};

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";
const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

export class ByteLruCache<V> {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private bytes = 0;
  private map = new Map<string, { value: V; bytes: number }>();

  constructor(options: { maxEntries: number; maxBytes: number }) {
    this.maxEntries = Math.max(1, options.maxEntries);
    this.maxBytes = Math.max(1, options.maxBytes);
  }

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, bytes: number): void {
    const safeBytes = Math.max(0, bytes);
    const previous = this.map.get(key);
    if (previous) {
      this.bytes -= previous.bytes;
      this.map.delete(key);
    }

    if (safeBytes > this.maxBytes) return;

    this.map.set(key, { value, bytes: safeBytes });
    this.bytes += safeBytes;
    this.trim();
  }

  delete(key: string): void {
    const previous = this.map.get(key);
    if (!previous) return;
    this.bytes -= previous.bytes;
    this.map.delete(key);
  }

  private trim(): void {
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next().value;
      if (typeof oldest !== "string") return;
      this.delete(oldest);
    }
  }
}

export function textContent(result: ToolResultLike): string | undefined {
  const content = result.content;
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      return item.text;
    }
  }
  return undefined;
}

export function imageContent(result: ToolResultLike): ImageContentLike | undefined {
  const content = result.content;
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (isRecord(item) && item.type === "image" && typeof item.data === "string") {
      return item as ImageContentLike;
    }
  }
  return undefined;
}

export function isToolError(result: ToolResultLike, context?: ShellContextLike): boolean {
  return Boolean(result.isError || context?.isError);
}

export function firstLine(text: string, fallback = text): string {
  return text.split("\n", 1)[0] || fallback;
}

export function countLines(text: string): number {
  if (text.length === 0) return 1;
  return text.split("\n").length;
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function normalizeLineEndings(text: string): string {
  if (!text.includes("\r")) return text;
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

export function toFsPath(cwd: string | undefined, rawPath: string): string {
  let expanded = normalizeToolPath(rawPath);
  if (expanded === "~") expanded = os.homedir();
  else if (expanded.startsWith("~/")) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }

  if (path.isAbsolute(expanded) || /^[A-Za-z]:\//.test(expanded)) {
    return expanded;
  }

  return path.resolve(cwd || process.cwd(), expanded);
}

export function normalizeToolPath(rawPath: string): string {
  const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  return withoutAt.replace(UNICODE_SPACES, " ");
}

export type CompactReadClassification = {
  kind: "docs" | "resource" | "skill";
  label: string;
};

export function compactReadClassification(
  args: unknown,
  cwd?: string,
): CompactReadClassification | undefined {
  if (!cwd || !isRecord(args)) return undefined;
  const rawPath = stringField(args, "file_path") ?? stringField(args, "path");
  if (!rawPath) return undefined;

  const absolutePath = resolveReadPath(cwd, rawPath);
  const fileName = path.basename(absolutePath);
  if (fileName === "SKILL.md") {
    return { kind: "skill", label: path.basename(path.dirname(absolutePath)) || fileName };
  }

  const docsClassification = piDocsClassification(absolutePath);
  if (docsClassification) return docsClassification;

  if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
    return {
      kind: "resource",
      label: relativePathFromCwd(absolutePath, cwd) ?? shortenPathForDisplay(absolutePath),
    };
  }

  return undefined;
}

export function resolveReadPath(cwd: string | undefined, rawPath: string): string {
  const resolved = toFsPath(cwd, rawPath);
  if (existsSync(resolved)) return resolved;

  const amPmVariant = tryMacOSScreenshotPath(resolved);
  if (amPmVariant !== resolved && existsSync(amPmVariant)) return amPmVariant;

  const nfdVariant = resolved.normalize("NFD");
  if (nfdVariant !== resolved && existsSync(nfdVariant)) return nfdVariant;

  const curlyVariant = tryCurlyQuoteVariant(resolved);
  if (curlyVariant !== resolved && existsSync(curlyVariant)) return curlyVariant;

  const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
  if (nfdCurlyVariant !== resolved && existsSync(nfdCurlyVariant)) return nfdCurlyVariant;

  return resolved;
}

export function shortenPathForDisplay(p: string): string {
  const home = os.homedir();
  if (p === home) return "~";
  if (p.startsWith(home + path.sep)) return "~" + p.slice(home.length);
  return p;
}

export function relativePathFromCwd(filePath: string, cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const normalizedFile = normalizeAbsolutePath(filePath);
  const normalizedCwd = normalizeAbsolutePath(cwd);
  if (!normalizedFile || !normalizedCwd) return undefined;
  const prefix = normalizedCwd.endsWith("/") ? normalizedCwd : `${normalizedCwd}/`;
  if (!normalizedFile.startsWith(prefix)) return undefined;
  const relative = normalizedFile.slice(prefix.length);
  return relative || undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function piDocsClassification(absolutePath: string): CompactReadClassification | undefined {
  const root = piPackageRoot();
  if (!root) return undefined;

  const relative = path.relative(root, path.resolve(absolutePath));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }

  const label = relative.split(path.sep).join("/");
  if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
    return { kind: "docs", label };
  }
  return undefined;
}

function piPackageRoot(): string | undefined {
  const roots = [
    "/opt/pi-coding-agent",
    realPiBinaryDir(),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  for (const root of roots) {
    if (existsSync(path.join(root, "README.md"))) return root;
  }
  return undefined;
}

function realPiBinaryDir(): string | undefined {
  try {
    return path.dirname(realpathSync("/usr/bin/pi"));
  } catch {
    return undefined;
  }
}

function tryMacOSScreenshotPath(filePath: string): string {
  return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryCurlyQuoteVariant(filePath: string): string {
  return filePath.replace(/'/g, "’");
}

function normalizeAbsolutePath(value: string): string | undefined {
  if (!value.startsWith("/")) return undefined;
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}
