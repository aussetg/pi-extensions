import { createHash } from "node:crypto";
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
  if (result.isError || context?.isError) return true;
  const text = textContent(result)?.trimStart();
  return Boolean(text && /^(error|failed|access denied)\b/i.test(text));
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
  let expanded = rawPath;
  if (expanded === "~") expanded = os.homedir();
  else if (expanded.startsWith("~/")) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }

  if (path.isAbsolute(expanded) || /^[A-Za-z]:\//.test(expanded)) {
    return expanded;
  }

  return path.resolve(cwd || process.cwd(), expanded);
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
