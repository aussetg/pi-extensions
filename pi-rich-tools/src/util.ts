import * as os from "node:os";
import * as path from "node:path";

// Errors thrown by top-level argument parsing and entirely failed patches are
// surfaced as tool failures. Per-operation errors remain in apply_patch results
// when independent operations can still be applied.
export class DiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffError";
  }
}

// Normalize line endings to LF so diff parsing is consistent across platforms.
export function normalizeLineEndings(text: string): string {
  if (!text.includes("\r")) return text;
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

// Normalize patch paths to POSIX-style and trim whitespace.
// Some models prepend '@' to paths (mirroring shell-ish argument style), so strip one leading '@'.
export function normalizePatchPath(p: string): string {
  let s = p.replace(/\\/g, "/").trim();
  if (s.startsWith("@")) s = s.slice(1);
  return s;
}

// Validate and normalize a patch path.
// We intentionally allow absolute paths and ../ traversal to match Pi's built-in edit/write behavior.
export function validatePatchPath(p: string): string {
  const raw = normalizePatchPath(p);
  if (!raw) throw new DiffError("Invalid path: empty");
  if (raw.includes("\u0000")) throw new DiffError("Invalid path: contains NUL");
  return path.posix.normalize(raw);
}

// Resolve a validated path against cwd, while supporting ~ expansion and absolute paths.
export function toFsPath(cwd: string, p: string): string {
  let expanded = p;
  if (expanded === "~") expanded = os.homedir();
  else if (expanded.startsWith("~/"))
    expanded = path.join(os.homedir(), expanded.slice(2));

  if (path.isAbsolute(expanded) || /^[A-Za-z]:\//.test(expanded)) {
    return expanded;
  }

  return path.resolve(cwd, expanded);
}

// Keep paths compact in the TUI, similar to built-in tool renderers.
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

export function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

