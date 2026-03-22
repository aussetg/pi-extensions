import {
  renderDiff,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/*
 * Models that should run under the apply_patch-only policy.
 * Match the whole GPT-5 family (provider-agnostic), e.g.:
 * - gpt-5
 * - gpt-5.2
 * - gpt-5.2-codex
 * - gpt-5.1-codex-max
 */
const GPT5_MODEL_RE = /^gpt-5(?:[.-].*)?$/;

// Decide whether the active model should be forced into apply_patch-only mode.
function isCodexModel(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  if (!model) return false;
  return GPT5_MODEL_RE.test(model.id);
}

// Types used for tool progress and result reporting in the TUI.
type ApplyPatchOpType = "create_file" | "update_file" | "delete_file";

interface ApplyPatchOperation {
  type: ApplyPatchOpType;
  path: string;
  /**
   * V4A diff.
   * - create_file: full file content (each line starts with '+')
   * - update_file: @@ sections with +/-/space lines
   */
  diff?: string;
  /** Optional move target (non-standard, but some Codex outputs include it). */
  move_path?: string;
}

type ApplyPatchDetails =
  | {
      stage: "progress";
      message: string;
      previewPath?: string;
      previewDiff?: string;
    }
  | {
      stage: "done";
      fuzz: number;
      results: Array<{
        type: ApplyPatchOpType;
        path: string;
        status: "completed" | "failed";
        output?: string;
      }>;
      previews?: Array<{ path: string; diff: string }>;
      warnings?: string[];
    };

// Emit a progress update (used by the tool renderer).
function progress(
  onUpdate: AgentToolUpdateCallback<ApplyPatchDetails> | undefined,
  message: string,
  preview?: { path?: string; diff?: string },
): void {
  onUpdate?.({
    content: [{ type: "text", text: message }],
    details: {
      stage: "progress",
      message,
      previewPath: preview?.path,
      previewDiff: preview?.diff,
    },
  });
}

function createThrottledProgressEmitter(
  onUpdate: AgentToolUpdateCallback<ApplyPatchDetails> | undefined,
  minIntervalMs = 40,
): {
  emit: (
    message: string,
    preview?: { path?: string; diff?: string },
    force?: boolean,
  ) => void;
  flush: () => void;
} {
  if (!onUpdate) {
    return {
      emit() {
        // no-op
      },
      flush() {
        // no-op
      },
    };
  }

  let lastEmitTs = 0;
  let pending:
    | { message: string; preview?: { path?: string; diff?: string } }
    | undefined;

  const emitNow = (
    message: string,
    preview?: { path?: string; diff?: string },
  ) => {
    lastEmitTs = Date.now();
    progress(onUpdate, message, preview);
  };

  return {
    emit(message, preview, force = false) {
      if (force) {
        emitNow(message, preview);
        pending = undefined;
        return;
      }

      const now = Date.now();
      if (lastEmitTs === 0 || now - lastEmitTs >= minIntervalMs) {
        emitNow(message, preview);
        pending = undefined;
        return;
      }

      pending = { message, preview };
    },
    flush() {
      if (!pending) return;
      emitNow(pending.message, pending.preview);
      pending = undefined;
    },
  };
}

// Errors thrown by the diff parser/application are surfaced to the model as tool failures.
class DiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffError";
  }
}

// Normalize line endings to LF so diff parsing is consistent across platforms.
function normalizeLineEndings(text: string): string {
  if (!text.includes("\r")) return text;
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// Normalize patch paths to POSIX-style and trim whitespace.
// Some models prepend '@' to paths (mirroring shell-ish argument style), so strip one leading '@'.
function normalizePatchPath(p: string): string {
  let s = p.replace(/\\/g, "/").trim();
  if (s.startsWith("@")) s = s.slice(1);
  return s;
}

// Validate and normalize a patch path.
// We intentionally allow absolute paths and ../ traversal to match Pi's built-in edit/write behavior.
function validatePatchPath(p: string): string {
  const raw = normalizePatchPath(p);
  if (!raw) throw new DiffError("Invalid path: empty");
  if (raw.includes("\u0000")) throw new DiffError("Invalid path: contains NUL");
  return path.posix.normalize(raw);
}

// Resolve a validated path against cwd, while supporting ~ expansion and absolute paths.
function toFsPath(cwd: string, p: string): string {
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
function shortenPathForDisplay(p: string): string {
  const home = os.homedir();
  if (p === home) return "~";
  if (p.startsWith(home + path.sep)) return "~" + p.slice(home.length);
  return p;
}

// Cheap existence check used for create/update/delete preconditions.
async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

// Parsed diff chunk: where to delete lines and insert new ones.
interface Chunk {
  origIndex: number;
  delLines: string[];
  insLines: string[];
}

interface LineMatchCache {
  raw: string[];
  trimEnd?: string[];
  trim?: string[];
  rawIndex?: Map<string, number[]>;
  trimEndIndex?: Map<string, number[]>;
  trimIndex?: Map<string, number[]>;
  rawScanMisses?: number;
  preferRawIndex?: boolean;
}

const INDEXED_CONTEXT_MATCH_MIN_LINES = 256;

function buildLineIndex(lines: string[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const arr = index.get(line);
    if (arr) arr.push(i);
    else index.set(line, [i]);
  }
  return index;
}

function getRawLineIndex(cache: LineMatchCache): Map<string, number[]> {
  if (!cache.rawIndex) cache.rawIndex = buildLineIndex(cache.raw);
  return cache.rawIndex;
}

function getTrimEndLines(cache: LineMatchCache): string[] {
  if (!cache.trimEnd) cache.trimEnd = cache.raw.map((line) => line.trimEnd());
  return cache.trimEnd;
}

function getTrimEndLineIndex(cache: LineMatchCache): Map<string, number[]> {
  if (!cache.trimEndIndex)
    cache.trimEndIndex = buildLineIndex(getTrimEndLines(cache));
  return cache.trimEndIndex;
}

function getTrimmedLines(cache: LineMatchCache): string[] {
  if (!cache.trim) cache.trim = cache.raw.map((line) => line.trim());
  return cache.trim;
}

function getTrimmedLineIndex(cache: LineMatchCache): Map<string, number[]> {
  if (!cache.trimIndex)
    cache.trimIndex = buildLineIndex(getTrimmedLines(cache));
  return cache.trimIndex;
}

function lowerBound(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function findContextByScan(
  lines: string[],
  context: string[],
  start: number,
): number {
  const first = Math.max(0, start);
  const contextLen = context.length;
  const last = lines.length - contextLen;
  if (first > last) return -1;

  const c0 = context[0]!;
  if (contextLen === 1) {
    for (let i = first; i <= last; i++) {
      if (lines[i] === c0) return i;
    }
    return -1;
  }

  const cLastOffset = contextLen - 1;
  const cLast = context[cLastOffset]!;

  for (let i = first; i <= last; i++) {
    if (lines[i] !== c0) continue;
    if (lines[i + cLastOffset] !== cLast) continue;

    let ok = true;
    for (let j = 1; j < cLastOffset; j++) {
      if (lines[i + j] !== context[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }

  return -1;
}

function findContextByIndex(
  lines: string[],
  context: string[],
  start: number,
  index: Map<string, number[]>,
): number {
  const first = Math.max(0, start);
  const contextLen = context.length;
  const last = lines.length - contextLen;
  if (first > last) return -1;

  const candidates = index.get(context[0]!);
  if (!candidates || candidates.length === 0) return -1;

  if (contextLen === 1) {
    const pos = lowerBound(candidates, first);
    if (pos >= candidates.length) return -1;
    const lineIndex = candidates[pos]!;
    return lineIndex <= last ? lineIndex : -1;
  }

  const cLastOffset = contextLen - 1;
  const cLast = context[cLastOffset]!;

  for (let k = lowerBound(candidates, first); k < candidates.length; k++) {
    const i = candidates[k]!;
    if (i > last) break;
    if (lines[i + cLastOffset] !== cLast) continue;

    let ok = true;
    for (let j = 1; j < cLastOffset; j++) {
      if (lines[i + j] !== context[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }

  return -1;
}

function findLineFrom(lines: string[], start: number, target: string): number {
  for (let i = Math.max(0, start); i < lines.length; i++) {
    if (lines[i] === target) return i;
  }
  return -1;
}

// Parse a single V4A section into context + chunks, returning the next index.
function peekNextSection(
  lines: string[],
  startIndex: number,
): { context: string[]; chunks: Chunk[]; nextIndex: number; eof: boolean } {
  const old: string[] = [];
  let delLines: string[] = [];
  let insLines: string[] = [];
  const chunks: Chunk[] = [];

  let mode: "keep" | "add" | "delete" = "keep";
  const origIndex = startIndex;
  let index = startIndex;

  while (index < lines.length) {
    const s0 = lines[index]!;
    const c0 = s0.charCodeAt(0);
    if (c0 === 64 && s0.charCodeAt(1) === 64) break; // @@
    if (c0 === 42 && s0.startsWith("***")) {
      if (
        s0 === "***" ||
        s0 === "*** End of File" ||
        s0 === "*** End Patch" ||
        s0.startsWith("*** Update File:") ||
        s0.startsWith("*** Delete File:") ||
        s0.startsWith("*** Add File:")
      ) {
        break;
      }
      throw new DiffError(`Invalid Line: ${s0}`);
    }

    index++;
    const lastMode = mode;
    const prefix = s0 === "" ? " " : s0[0];
    const content = s0 === "" ? "" : s0.slice(1);
    if (prefix === "+") mode = "add";
    else if (prefix === "-") mode = "delete";
    else if (prefix === " ") mode = "keep";
    else throw new DiffError(`Invalid Line: ${s0}`);

    if (mode === "keep" && lastMode !== mode) {
      if (insLines.length > 0 || delLines.length > 0) {
        chunks.push({
          origIndex: old.length - delLines.length,
          delLines,
          insLines,
        });
        delLines = [];
        insLines = [];
      }
    }

    if (mode === "delete") {
      delLines.push(content);
      old.push(content);
    } else if (mode === "add") {
      insLines.push(content);
    } else {
      old.push(content);
    }
  }

  if (insLines.length > 0 || delLines.length > 0) {
    chunks.push({
      origIndex: old.length - delLines.length,
      delLines,
      insLines,
    });
  }

  if (index < lines.length && lines[index] === "*** End of File") {
    index++;
    return { context: old, chunks, nextIndex: index, eof: true };
  }

  if (index === origIndex) {
    throw new DiffError(
      `Nothing in this section - index=${index} line='${lines[index] ?? ""}'`,
    );
  }

  return { context: old, chunks, nextIndex: index, eof: false };
}

// Find a matching context block in the target file, with fuzzy fallbacks.
function findContextCore(
  cache: LineMatchCache,
  contextRaw: string[],
  start: number,
): { index: number; fuzz: number } {
  const lines = cache.raw;
  if (contextRaw.length === 0) return { index: start, fuzz: 0 };
  if (contextRaw.length === 1) {
    let idx = findLineFrom(lines, start, contextRaw[0]!);
    if (idx !== -1) return { index: idx, fuzz: 0 };

    const linesTrimEnd = getTrimEndLines(cache);
    idx = findLineFrom(linesTrimEnd, start, contextRaw[0]!.trimEnd());
    if (idx !== -1) return { index: idx, fuzz: 1 };

    const linesTrimmed = getTrimmedLines(cache);
    idx = findLineFrom(linesTrimmed, start, contextRaw[0]!.trim());
    if (idx !== -1) return { index: idx, fuzz: 100 };

    return { index: -1, fuzz: 0 };
  }

  let exactIndex =
    cache.preferRawIndex && lines.length >= INDEXED_CONTEXT_MATCH_MIN_LINES
      ? findContextByIndex(lines, contextRaw, start, getRawLineIndex(cache))
      : findContextByScan(lines, contextRaw, start);

  if (
    exactIndex === -1 &&
    !cache.preferRawIndex &&
    lines.length >= INDEXED_CONTEXT_MATCH_MIN_LINES
  ) {
    const misses = (cache.rawScanMisses ?? 0) + 1;
    cache.rawScanMisses = misses;
    if (misses >= 1) {
      cache.preferRawIndex = true;
      exactIndex = findContextByIndex(
        lines,
        contextRaw,
        start,
        getRawLineIndex(cache),
      );
    }
  }

  if (exactIndex !== -1) return { index: exactIndex, fuzz: 0 };

  let contextTrimEnd: string[] | undefined;
  const getContextTrimEnd = () => {
    if (!contextTrimEnd) {
      contextTrimEnd = new Array<string>(contextRaw.length);
      for (let i = 0; i < contextRaw.length; i++) {
        contextTrimEnd[i] = contextRaw[i]!.trimEnd();
      }
    }
    return contextTrimEnd;
  };

  const linesTrimEnd = getTrimEndLines(cache);
  const rstripIndex =
    linesTrimEnd.length >= INDEXED_CONTEXT_MATCH_MIN_LINES
      ? findContextByIndex(
          linesTrimEnd,
          getContextTrimEnd(),
          start,
          getTrimEndLineIndex(cache),
        )
      : findContextByScan(linesTrimEnd, getContextTrimEnd(), start);
  if (rstripIndex !== -1) return { index: rstripIndex, fuzz: 1 };

  let contextTrimmed: string[] | undefined;
  const getContextTrimmed = () => {
    if (!contextTrimmed) {
      contextTrimmed = new Array<string>(contextRaw.length);
      for (let i = 0; i < contextRaw.length; i++) {
        contextTrimmed[i] = contextRaw[i]!.trim();
      }
    }
    return contextTrimmed;
  };

  const linesTrimmed = getTrimmedLines(cache);
  const trimIndex =
    linesTrimmed.length >= INDEXED_CONTEXT_MATCH_MIN_LINES
      ? findContextByIndex(
          linesTrimmed,
          getContextTrimmed(),
          start,
          getTrimmedLineIndex(cache),
        )
      : findContextByScan(linesTrimmed, getContextTrimmed(), start);
  if (trimIndex !== -1) return { index: trimIndex, fuzz: 100 };

  return { index: -1, fuzz: 0 };
}

// If the section is marked EOF, prefer matching near file end; otherwise match forward.
function findContext(
  cache: LineMatchCache,
  contextRaw: string[],
  start: number,
  eof: boolean,
): { index: number; fuzz: number } {
  if (eof) {
    const atEof = findContextCore(
      cache,
      contextRaw,
      Math.max(0, cache.raw.length - contextRaw.length),
    );
    if (atEof.index !== -1) return atEof;
    const fallback = findContextCore(cache, contextRaw, start);
    return { index: fallback.index, fuzz: fallback.fuzz + 10000 };
  }
  return findContextCore(cache, contextRaw, start);
}

const ENVELOPE_BEGIN_MARKER = "*** Begin Patch";
const ENVELOPE_END_MARKER = "*** End Patch";
const ENVELOPE_UPDATE_PREFIX = "*** Update File:";

function isEnvelopeMarkerParseError(err: unknown): boolean {
  if (!(err instanceof DiffError)) return false;
  const msg = err.message;
  if (!msg.includes("***")) return false;

  return (
    msg.startsWith("Invalid diff (expected @@ section): ***") ||
    msg.startsWith("Invalid Line: ***") ||
    msg.includes("line='***") ||
    msg.includes(ENVELOPE_BEGIN_MARKER) ||
    msg.includes(ENVELOPE_END_MARKER) ||
    msg.includes("*** Update File:") ||
    msg.includes("*** Add File:") ||
    msg.includes("*** Delete File:")
  );
}

interface NormalizedEnvelopeDiff {
  diff: string;
  markers: string[];
}

function tryNormalizeUpdateDiffEnvelope(
  diff: string,
  rel: string,
): NormalizedEnvelopeDiff | undefined {
  const lines = normalizeLineEndings(diff).split("\n");

  let lo = 0;
  let hi = lines.length;
  while (lo < hi && lines[lo] === "") lo++;
  while (hi > lo && lines[hi - 1] === "") hi--;

  const markers: string[] = [];

  if (lo < hi && lines[lo] === ENVELOPE_BEGIN_MARKER) {
    markers.push(ENVELOPE_BEGIN_MARKER);
    lo++;
  }

  if (lo < hi && lines[hi - 1] === ENVELOPE_END_MARKER) {
    markers.push(ENVELOPE_END_MARKER);
    hi--;
  }

  if (lo < hi && lines[lo]!.startsWith(ENVELOPE_UPDATE_PREFIX)) {
    const rawPath = lines[lo]!.slice(ENVELOPE_UPDATE_PREFIX.length).trim();
    let normalizedRawPath = normalizePatchPath(rawPath);
    if (normalizedRawPath)
      normalizedRawPath = path.posix.normalize(normalizedRawPath);
    if (!normalizedRawPath || normalizedRawPath !== rel) {
      return undefined;
    }
    markers.push(`${ENVELOPE_UPDATE_PREFIX} ${rawPath}`);
    lo++;
  }

  if (markers.length === 0) return undefined;

  const candidateLines = lines.slice(lo, hi);
  for (const line of candidateLines) {
    if (!line.startsWith("***")) continue;
    if (line === "*** End of File") continue;
    // Keep recovery narrowly scoped: if envelope-style bare markers remain,
    // refuse fallback rather than guessing intent.
    return undefined;
  }

  return { diff: candidateLines.join("\n"), markers };
}

interface ApplyUpdateResult {
  output: string;
  fuzz: number;
  normalizedMarkers?: string[];
}

function applyV4AUpdateWithRecovery(
  input: string,
  diff: string,
  rel: string,
): ApplyUpdateResult {
  try {
    const strict = applyV4AUpdate(input, diff);
    return { output: strict.output, fuzz: strict.fuzz };
  } catch (err) {
    if (!isEnvelopeMarkerParseError(err)) throw err;

    const normalized = tryNormalizeUpdateDiffEnvelope(diff, rel);
    if (!normalized) throw err;

    const recovered = applyV4AUpdate(input, normalized.diff);
    return {
      output: recovered.output,
      fuzz: recovered.fuzz,
      normalizedMarkers: normalized.markers,
    };
  }
}

// Apply a V4A update diff to existing file content.
// Returns updated content plus a fuzz score when context matching was inexact.
function applyV4AUpdate(
  input: string,
  diff: string,
): { output: string; fuzz: number } {
  // IMPORTANT: do NOT trim() here. V4A diff lines may start with a leading space (context lines).
  const normalizedDiff = normalizeLineEndings(diff);
  const patchLines = normalizedDiff.split("\n");
  // Drop a single trailing newline to avoid creating an extra empty diff line.
  if (patchLines.length > 0 && patchLines[patchLines.length - 1] === "")
    patchLines.pop();

  const fileLines = normalizeLineEndings(input).split("\n");
  const fileLineCache: LineMatchCache = { raw: fileLines };

  let fuzz = 0;
  let patchIndex = 0;
  let fileIndex = 0;
  const dest: string[] = [];
  let origIndex = 0;
  let seenPrefixIndex = 0;
  const seenExact = new Set<string>();
  let seenTrimmed: Set<string> | undefined;

  const syncSeenPrefix = (toExclusive: number) => {
    const limit = Math.min(toExclusive, fileLines.length);
    if (seenPrefixIndex >= limit) return;

    if (seenTrimmed) {
      const trimmedLines = getTrimmedLines(fileLineCache);
      for (; seenPrefixIndex < limit; seenPrefixIndex++) {
        seenExact.add(fileLines[seenPrefixIndex]!);
        seenTrimmed.add(trimmedLines[seenPrefixIndex]!);
      }
      return;
    }

    for (; seenPrefixIndex < limit; seenPrefixIndex++) {
      seenExact.add(fileLines[seenPrefixIndex]!);
    }
  };

  const getSeenTrimmed = (): Set<string> => {
    if (!seenTrimmed) {
      const trimmedLines = getTrimmedLines(fileLineCache);
      seenTrimmed = new Set<string>();
      for (let i = 0; i < seenPrefixIndex; i++) {
        seenTrimmed.add(trimmedLines[i]!);
      }
    }
    return seenTrimmed;
  };

  while (patchIndex < patchLines.length) {
    // Section marker
    const line = patchLines[patchIndex] ?? "";
    let defStr = "";
    if (line.startsWith("@@ ")) {
      defStr = line.slice(3);
      patchIndex++;
    } else if (line === "@@") {
      patchIndex++;
    } else if (patchIndex === 0) {
      // Allow diffs without leading @@ (common in some examples)
    } else {
      throw new DiffError(`Invalid diff (expected @@ section): ${line}`);
    }

    if (defStr.trim()) {
      syncSeenPrefix(fileIndex);
      if (!seenExact.has(defStr)) {
        const exactPos = findLineFrom(fileLines, fileIndex, defStr);
        if (exactPos !== -1) {
          fileIndex = exactPos + 1;
        } else {
          const defStrTrimmed = defStr.trim();
          const trimmedLines = getTrimmedLines(fileLineCache);
          if (!getSeenTrimmed().has(defStrTrimmed)) {
            const trimPos = findLineFrom(
              trimmedLines,
              fileIndex,
              defStrTrimmed,
            );
            if (trimPos !== -1) {
              fileIndex = trimPos + 1;
              fuzz += 1;
            }
          }
        }
      }
    }

    const {
      context,
      chunks: sectionChunks,
      nextIndex,
      eof,
    } = peekNextSection(patchLines, patchIndex);
    const found = findContext(fileLineCache, context, fileIndex, eof);
    if (found.index === -1) {
      const nextChunkText = context.join("\n");
      if (eof)
        throw new DiffError(
          `Invalid EOF Context ${fileIndex}:\n${nextChunkText}`,
        );
      throw new DiffError(`Invalid Context ${fileIndex}:\n${nextChunkText}`);
    }

    fuzz += found.fuzz;
    for (const ch of sectionChunks) {
      const chunkOrigIndex = ch.origIndex + found.index;
      if (origIndex > chunkOrigIndex) {
        throw new DiffError(
          `applyDiff: origIndex ${origIndex} > chunk.origIndex ${chunkOrigIndex}`,
        );
      }

      dest.push(...fileLines.slice(origIndex, chunkOrigIndex));
      origIndex = chunkOrigIndex;

      const expected = ch.delLines;
      let mismatchAt = -1;
      for (let i = 0; i < expected.length; i++) {
        if (expected[i] !== fileLines[origIndex + i]) {
          mismatchAt = i;
          break;
        }
      }
      if (mismatchAt !== -1) {
        const actual: string[] = [];
        for (let i = 0; i < expected.length; i++) {
          actual.push(fileLines[origIndex + i] ?? "");
        }
        throw new DiffError(
          `Patch conflict at line ${origIndex + 1}. Expected:\n${expected.join("\n")}\n\nActual:\n${actual.join("\n")}`,
        );
      }

      dest.push(...ch.insLines);
      origIndex += expected.length;
    }

    fileIndex = found.index + context.length;
    patchIndex = nextIndex;
  }

  // Tail
  dest.push(...fileLines.slice(origIndex));
  return { output: dest.join("\n"), fuzz };
}

// Apply a V4A create diff (every line starts with '+') and return file content.
function applyV4ACreate(diff: string): string {
  const lines = normalizeLineEndings(diff).split("\n");
  // Drop trailing empty line to avoid an extra empty content line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const out = new Array<string>(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith("+")) {
      throw new DiffError(
        `Invalid create_file diff line (must start with '+'): ${line}`,
      );
    }
    out[i] = line.slice(1);
  }
  return out.join("\n");
}

// Atomic write using a temp file in the same directory. Best-effort mode preservation.
async function writeFileAtomic(
  abs: string,
  content: string,
  mode?: number,
): Promise<void> {
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  const tmp = path.join(
    dir,
    `.${base}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`,
  );

  await fs.writeFile(tmp, content, "utf8");
  if (typeof mode === "number") {
    try {
      await fs.chmod(tmp, mode);
    } catch {
      // ignore (best effort)
    }
  }

  try {
    await fs.rename(tmp, abs);
  } catch (err) {
    // Windows can fail rename() if the target exists.
    try {
      await fs.unlink(abs);
      await fs.rename(tmp, abs);
    } catch {
      try {
        await fs.unlink(tmp);
      } catch {
        // ignore
      }
      throw err;
    }
  }
}

interface ApplyOperationResult {
  type: ApplyPatchOpType;
  path: string;
  status: "completed" | "failed";
  output?: string;
}

interface PreparedApplyTask {
  index: number;
  type: ApplyPatchOpType;
  rel: string;
  abs: string;
  displayPath: string;
  touchedPaths: string[];
  diff?: string;
  moveRel?: string;
  moveAbs?: string;
}

interface PrepareApplyTasksResult {
  tasks: PreparedApplyTask[];
  presetResults: Array<ApplyOperationResult | undefined>;
}

function prepareApplyTasks(
  operations: ApplyPatchOperation[],
  cwd: string,
): PrepareApplyTasksResult {
  const tasks: PreparedApplyTask[] = [];
  const presetResults: Array<ApplyOperationResult | undefined> = new Array(
    operations.length,
  );

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i]!;
    const type = op.type;

    let rel: string;
    let abs: string;
    try {
      rel = validatePatchPath(op.path);
      abs = toFsPath(cwd, rel);
    } catch (err) {
      presetResults[i] = {
        type,
        path: typeof op.path === "string" ? op.path : "(invalid)",
        status: "failed",
        output: err instanceof Error ? err.message : String(err),
      };
      continue;
    }

    const task: PreparedApplyTask = {
      index: i,
      type,
      rel,
      abs,
      displayPath: shortenPathForDisplay(rel),
      touchedPaths: [abs],
      diff:
        typeof op.diff === "string" ? normalizeLineEndings(op.diff) : undefined,
    };

    if (
      (type === "create_file" || type === "update_file") &&
      typeof task.diff !== "string"
    ) {
      presetResults[i] = {
        type,
        path: rel,
        status: "failed",
        output: `${type} missing diff for ${rel}`,
      };
      continue;
    }

    if (
      type === "update_file" &&
      typeof op.move_path === "string" &&
      op.move_path.length > 0
    ) {
      try {
        task.moveRel = validatePatchPath(op.move_path);
        task.moveAbs = toFsPath(cwd, task.moveRel);
        if (task.moveAbs !== abs) task.touchedPaths.push(task.moveAbs);
      } catch (err) {
        presetResults[i] = {
          type,
          path: rel,
          status: "failed",
          output: err instanceof Error ? err.message : String(err),
        };
        continue;
      }
    }

    tasks.push(task);
  }

  return { tasks, presetResults };
}

function chooseBatchParallelism(
  tasks: PreparedApplyTask[],
  upperLimit: number,
): number {
  if (tasks.length <= 1) return 1;
  if (upperLimit <= 1) return 1;

  let updateCount = 0;
  let nonUpdateCount = 0;
  let totalDiffLen = 0;
  let maxDiffLen = 0;

  for (const task of tasks) {
    if (task.type === "update_file") {
      updateCount++;
      const len = task.diff?.length ?? 0;
      totalDiffLen += len;
      if (len > maxDiffLen) maxDiffLen = len;
    } else {
      nonUpdateCount++;
    }
  }

  if (updateCount === 0) return Math.min(upperLimit, tasks.length);

  const avgUpdateDiffLen = totalDiffLen / updateCount;

  if (updateCount === tasks.length) {
    if (maxDiffLen >= 120_000 || avgUpdateDiffLen >= 40_000)
      return Math.min(upperLimit, 2, tasks.length);
    if (avgUpdateDiffLen >= 12_000)
      return Math.min(upperLimit, 3, tasks.length);
    if (avgUpdateDiffLen >= 4_000) return Math.min(upperLimit, 4, tasks.length);
    return Math.min(upperLimit, 6, tasks.length);
  }

  if (maxDiffLen >= 120_000 || avgUpdateDiffLen >= 40_000)
    return Math.min(upperLimit, 2, tasks.length);
  if (avgUpdateDiffLen >= 12_000) return Math.min(upperLimit, 3, tasks.length);
  if (nonUpdateCount > updateCount)
    return Math.min(upperLimit, 6, tasks.length);
  return Math.min(upperLimit, 4, tasks.length);
}

// Apply operations in order, but run independent non-move operations in bounded parallel batches.
// Each op reports its own success/failure; no rollback.
async function applyOperations(
  operations: ApplyPatchOperation[],
  cwd: string,
  signal?: AbortSignal,
  onProgress?: (
    message: string,
    preview?: { path?: string; diff?: string },
  ) => void,
): Promise<{
  fuzz: number;
  results: ApplyOperationResult[];
  warnings: string[];
}> {
  const { tasks, presetResults } = prepareApplyTasks(operations, cwd);
  const results: Array<ApplyOperationResult | undefined> = presetResults;
  let fuzzTotal = 0;
  const warnings = new Set<string>();
  const ensuredDirs = new Map<string, Promise<void>>();
  const knownPathExistence = new Map<string, boolean>();
  const maxParallelUpper = Math.max(
    1,
    Math.min(
      8,
      typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : 4,
    ),
  );

  const ensureDir = async (dir: string) => {
    const inFlight = ensuredDirs.get(dir);
    if (inFlight) return inFlight;

    const pending = fs.mkdir(dir, { recursive: true }).catch((err) => {
      ensuredDirs.delete(dir);
      throw err;
    });
    ensuredDirs.set(dir, pending);
    return pending;
  };

  const markPathExists = (abs: string, exists: boolean) => {
    knownPathExistence.set(abs, exists);
  };

  const checkPathExists = async (abs: string): Promise<boolean> => {
    const known = knownPathExistence.get(abs);
    if (typeof known === "boolean") return known;
    const exists = await fileExists(abs);
    knownPathExistence.set(abs, exists);
    return exists;
  };

  const runTask = async (
    task: PreparedApplyTask,
  ): Promise<{
    result: ApplyOperationResult;
    fuzz: number;
    warning?: string;
  }> => {
    if (signal?.aborted) throw new Error("Aborted");

    const { type, rel, abs, diff } = task;
    try {
      if (type === "create_file") {
        if (typeof diff !== "string")
          throw new DiffError(`create_file missing diff for ${rel}`);
        if (await checkPathExists(abs))
          throw new DiffError(`File already exists at path '${rel}'`);

        const content = applyV4ACreate(diff);
        await ensureDir(path.dirname(abs));
        await writeFileAtomic(abs, content);
        markPathExists(abs, true);
        return { result: { type, path: rel, status: "completed" }, fuzz: 0 };
      }

      if (type === "update_file") {
        if (typeof diff !== "string")
          throw new DiffError(`update_file missing diff for ${rel}`);

        let st: Awaited<ReturnType<typeof fs.stat>>;
        let current: string;
        try {
          [st, current] = await Promise.all([
            fs.stat(abs),
            fs.readFile(abs, "utf8"),
          ]);
        } catch (err) {
          if (isNotFoundError(err)) {
            markPathExists(abs, false);
            throw new DiffError(`File not found at path '${rel}'`);
          }
          throw err;
        }
        markPathExists(abs, true);

        const { output, fuzz, normalizedMarkers } = applyV4AUpdateWithRecovery(
          current,
          diff,
          rel,
        );
        const warning =
          normalizedMarkers && normalizedMarkers.length > 0
            ? `Warning: forbidden marker lines were auto-removed: ${normalizedMarkers.join(", ")}. Use only @@/space/+/- lines.`
            : undefined;

        if (task.moveAbs && task.moveRel) {
          const relTo = task.moveRel;
          const absTo = task.moveAbs;
          if (await checkPathExists(absTo))
            throw new DiffError(`Target already exists at path '${relTo}'`);

          await ensureDir(path.dirname(absTo));
          await writeFileAtomic(absTo, output, st.mode);
          await fs.unlink(abs);
          markPathExists(abs, false);
          markPathExists(absTo, true);
          return {
            result: {
              type,
              path: relTo,
              status: "completed",
              output: `Moved from ${rel}`,
            },
            fuzz,
            warning,
          };
        }

        await ensureDir(path.dirname(abs));
        await writeFileAtomic(abs, output, st.mode);
        markPathExists(abs, true);
        return {
          result: { type, path: rel, status: "completed" },
          fuzz,
          warning,
        };
      }

      // delete_file
      try {
        await fs.unlink(abs);
      } catch (err) {
        if (isNotFoundError(err)) {
          markPathExists(abs, false);
          throw new DiffError(`File not found at path '${rel}'`);
        }
        throw err;
      }
      markPathExists(abs, false);
      return { result: { type, path: rel, status: "completed" }, fuzz: 0 };
    } catch (err) {
      return {
        result: {
          type,
          path: rel,
          status: "failed",
          output: err instanceof Error ? err.message : String(err),
        },
        fuzz: 0,
      };
    }
  };

  let batch: PreparedApplyTask[] = [];
  const batchTouchedPaths = new Set<string>();

  const flushBatch = async () => {
    if (batch.length === 0) return;
    const toRun = batch;
    batch = [];
    batchTouchedPaths.clear();
    const batchParallel = chooseBatchParallelism(toRun, maxParallelUpper);

    for (let start = 0; start < toRun.length; start += batchParallel) {
      if (signal?.aborted) throw new Error("Aborted");

      const slice = toRun.slice(start, start + batchParallel);
      const done = await Promise.all(slice.map((task) => runTask(task)));
      for (let i = 0; i < slice.length; i++) {
        const task = slice[i]!;
        const executed = done[i]!;
        results[task.index] = executed.result;
        fuzzTotal += executed.fuzz;
        if (executed.warning) warnings.add(executed.warning);
      }
    }
  };

  onProgress?.(`Applying ${operations.length} operation(s)...`);

  for (let i = 0; i < tasks.length; i++) {
    if (signal?.aborted) throw new Error("Aborted");

    const task = tasks[i]!;

    const stepPreview =
      task.type === "update_file" &&
      typeof task.diff === "string" &&
      task.diff.length > 0
        ? { path: task.displayPath, diff: task.diff }
        : undefined;
    onProgress?.(
      `${task.index + 1}/${operations.length} ${task.type} ${task.rel}`,
      stepPreview,
    );

    let conflictsWithBatch = false;
    for (const touched of task.touchedPaths) {
      if (batchTouchedPaths.has(touched)) {
        conflictsWithBatch = true;
        break;
      }
    }
    if (conflictsWithBatch) {
      await flushBatch();
    }

    batch.push(task);
    for (const touched of task.touchedPaths) {
      batchTouchedPaths.add(touched);
    }
  }

  await flushBatch();

  const finalized: ApplyOperationResult[] = results.map(
    (res, i): ApplyOperationResult => {
      if (res) return res;
      const op = operations[i]!;
      return {
        type: op.type,
        path: typeof op.path === "string" ? op.path : "(invalid)",
        status: "failed",
        output: "Internal error: missing result",
      };
    },
  );

  return { fuzz: fuzzTotal, results: finalized, warnings: [...warnings] };
}

// UI helpers for rendering tool arguments/results without flooding the TUI.

// Pull and normalize operations from tool args for call/result rendering.
interface RenderOperation {
  type: ApplyPatchOpType;
  path: string;
  movePath?: string;
  diff?: string;
}

function parseRenderOperations(args: unknown): RenderOperation[] {
  const ops = (args as { operations?: unknown })?.operations;
  if (!Array.isArray(ops)) return [];

  const out: RenderOperation[] = [];
  for (const o of ops) {
    if (!o || typeof o !== "object") continue;
    const type = (o as { type?: unknown }).type;
    if (
      type !== "create_file" &&
      type !== "update_file" &&
      type !== "delete_file"
    )
      continue;

    const pathValue = (o as { path?: unknown }).path;
    if (typeof pathValue !== "string") continue;

    let opPath = pathValue;
    try {
      opPath = validatePatchPath(pathValue);
    } catch {
      // keep raw value for display
    }

    let movePath: string | undefined;
    const moveValue = (o as { move_path?: unknown }).move_path;
    if (typeof moveValue === "string") {
      movePath = moveValue;
      try {
        movePath = validatePatchPath(moveValue);
      } catch {
        // keep raw value for display
      }
    }

    const diff =
      typeof (o as { diff?: unknown }).diff === "string"
        ? (o as { diff: string }).diff
        : undefined;
    out.push({ type, path: opPath, movePath, diff });
  }

  return out;
}

const DIFF_PREVIEW_CACHE_LIMIT = 96;
const diffPreviewCache = new Map<string, string>();
const FIRST_CHANGED_LINE_CACHE_LIMIT = 256;
const firstChangedLineCache = new Map<string, number>();

function diffPreviewCacheKey(diff: string, filePath?: string): string {
  return `${filePath ?? ""}\u0000${diff}`;
}

function getCachedDiffPreview(diff: string, filePath?: string): string {
  const key = diffPreviewCacheKey(diff, filePath);
  const cached = diffPreviewCache.get(key);
  if (cached !== undefined) return cached;

  const nativeDiff = v4aToNativeDiffText(diff);
  const rendered = nativeDiff ? renderDiff(nativeDiff, { filePath }) : "";
  diffPreviewCache.set(key, rendered);

  if (diffPreviewCache.size > DIFF_PREVIEW_CACHE_LIMIT) {
    const oldestKey = diffPreviewCache.keys().next().value;
    if (typeof oldestKey === "string") diffPreviewCache.delete(oldestKey);
  }

  return rendered;
}

function v4aToNativeDiffText(diff: string): string {
  const lines = normalizeLineEndings(diff).split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const prefixes: Array<"+" | "-" | " "> = [];
  const lineNumbers: number[] = [];
  const contents: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  let maxLine = 1;

  for (let line of lines) {
    // V4A markers are not part of the rendered body.
    if (line.startsWith("@@") || line.startsWith("***")) continue;

    // Keep parity with parser behavior for blank lines in sections.
    if (line === "") line = " ";

    if (line.startsWith("+")) {
      prefixes.push("+");
      lineNumbers.push(newLine);
      contents.push(line.slice(1));
      if (newLine > maxLine) maxLine = newLine;
      newLine++;
      continue;
    }

    if (line.startsWith("-")) {
      prefixes.push("-");
      lineNumbers.push(oldLine);
      contents.push(line.slice(1));
      if (oldLine > maxLine) maxLine = oldLine;
      oldLine++;
      continue;
    }

    if (line.startsWith(" ")) {
      prefixes.push(" ");
      lineNumbers.push(newLine);
      contents.push(line.slice(1));
      if (newLine > maxLine) maxLine = newLine;
      oldLine++;
      newLine++;
      continue;
    }
  }

  if (lineNumbers.length === 0) return "";
  const digits = String(maxLine).length;
  const out = new Array<string>(lineNumbers.length);
  for (let i = 0; i < lineNumbers.length; i++) {
    const n = String(lineNumbers[i]!).padStart(digits, " ");
    out[i] = `${prefixes[i]!}${n} ${contents[i]!}`;
  }
  return out.join("\n");
}

function firstChangedLineFromDiff(diff: string): number {
  const cached = firstChangedLineCache.get(diff);
  if (typeof cached === "number") return cached;

  const lines = normalizeLineEndings(diff).split("\n");
  let oldLine = 1;
  let newLine = 1;
  let result = 1;
  for (const line of lines) {
    if (line.startsWith("+")) {
      result = newLine;
      break;
    }
    if (line.startsWith("-")) {
      result = oldLine;
      break;
    }
    if (line.startsWith(" ")) {
      oldLine++;
      newLine++;
    }
  }

  firstChangedLineCache.set(diff, result);
  if (firstChangedLineCache.size > FIRST_CHANGED_LINE_CACHE_LIMIT) {
    const oldestKey = firstChangedLineCache.keys().next().value;
    if (typeof oldestKey === "string") firstChangedLineCache.delete(oldestKey);
  }

  return result;
}

function makeDiffPreview(
  diff: string,
  theme: { fg: (color: string, text: string) => string },
  filePath?: string,
): string {
  const rendered = getCachedDiffPreview(diff, filePath);
  if (!rendered) return theme.fg("muted", "(no diff preview)");
  return rendered;
}

// Summarize tool args for a native-like compact header.
function summarizeOperationsArgs(args: unknown): {
  operationCount: number;
  headerPath?: string;
  headerLine?: number;
} {
  const ops = parseRenderOperations(args);
  if (ops.length === 0) return { operationCount: 0 };

  if (ops.length > 1) return { operationCount: ops.length };

  const op = ops[0]!;
  const headerPath = shortenPathForDisplay(op.path);
  if (
    op.type === "update_file" &&
    typeof op.diff === "string" &&
    op.diff.length > 0
  ) {
    return {
      operationCount: 1,
      headerPath,
      headerLine: firstChangedLineFromDiff(op.diff),
    };
  }

  return { operationCount: 1, headerPath };
}

function opLabel(type: ApplyPatchOpType): "create" | "update" | "delete" {
  return type === "create_file"
    ? "create"
    : type === "update_file"
      ? "update"
      : "delete";
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let output = "";
  for (const c of content) {
    if (
      c &&
      typeof c === "object" &&
      (c as { type?: unknown }).type === "text"
    ) {
      const t = (c as { text?: unknown }).text;
      if (typeof t === "string" && t) output += (output ? "\n" : "") + t;
    }
  }
  return output;
}

function withResultSpacing(text: string): string {
  return text ? `\n${text}` : text;
}

function renderOperationLine(
  entry: { type: ApplyPatchOpType; path: string; output?: string },
  theme: { fg: (color: string, text: string) => string },
): string {
  const label = opLabel(entry.type);
  const head = `${theme.fg("warning", `${label}:`)} ${theme.fg("accent", shortenPathForDisplay(entry.path))}`;
  if (!entry.output) return head;
  return `${head} ${theme.fg("muted", `— ${entry.output}`)}`;
}

function collectSuccessPreviews(
  ops: ApplyPatchOperation[],
  results: Array<{
    type: ApplyPatchOpType;
    path: string;
    status: "completed" | "failed";
    output?: string;
  }>,
): Array<{ path: string; diff: string }> {
  const previews: Array<{ path: string; diff: string }> = [];
  const n = Math.min(ops.length, results.length);
  for (let i = 0; i < n; i++) {
    const op = ops[i]!;
    const res = results[i]!;
    if (op.type !== "update_file" || res.status !== "completed") continue;
    if (typeof op.diff !== "string" || op.diff.length === 0) continue;
    const displayPath = shortenPathForDisplay(res.path || op.path);
    previews.push({ path: displayPath, diff: op.diff });
  }
  return previews;
}

function collectProgressPreview(
  ops: ApplyPatchOperation[],
): { path?: string; diff?: string } | undefined {
  for (const op of ops) {
    if (op.type !== "update_file") continue;
    if (typeof op.diff !== "string" || op.diff.length === 0) continue;
    return { path: shortenPathForDisplay(op.path), diff: op.diff };
  }
  return undefined;
}

// Extension wiring: tool policy, tool registration, and system prompt hook.
export default function (pi: ExtensionAPI) {
  let baselineTools: string[] | null = null;

  // Enforce apply_patch-only policy for selected models; hide edit/write to avoid mixed diffs.
  function applyToolPolicy(ctx: ExtensionContext): void {
    if (!baselineTools) baselineTools = pi.getActiveTools();

    if (isCodexModel(ctx)) {
      const next = new Set(baselineTools);
      next.delete("edit");
      next.delete("write");
      next.add("apply_patch");
      pi.setActiveTools([...next]);
      return;
    }

    pi.setActiveTools(baselineTools.filter((t) => t !== "apply_patch"));
  }

  pi.registerTool({
    name: "apply_patch",
    label: "apply_patch",
    description:
      "Apply file edits via JSON operations (create_file/update_file/delete_file) with V4A diffs. For update_file, each non-empty diff line must start with @@, space, +, or -. Never include lines starting with ***.",
    parameters: Type.Object({
      operations: Type.Array(
        Type.Object({
          type: StringEnum([
            "create_file",
            "update_file",
            "delete_file",
          ] as const),
          path: Type.String(),
          diff: Type.Optional(Type.String()),
          move_path: Type.Optional(Type.String()),
        }),
      ),
    }),

    renderCall(args, theme) {
      let out = theme.fg("toolTitle", theme.bold("apply_patch"));
      try {
        const { operationCount, headerPath, headerLine } =
          summarizeOperationsArgs(args);
        if (headerPath) {
          out += " " + theme.fg("accent", headerPath);
          if (typeof headerLine === "number")
            out += theme.fg("warning", `:${headerLine}`);
        } else if (operationCount > 0)
          out +=
            " " +
            theme.fg(
              "muted",
              `(${operationCount} operation${operationCount === 1 ? "" : "s"})`,
            );
        else out += " " + theme.fg("muted", "(waiting for operations)");
      } catch {
        // Keep renderer resilient; fallback to just tool title.
      }
      return new Text(out, 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      const details = result.details as ApplyPatchDetails | undefined;
      if (isPartial) {
        const msg =
          details?.stage === "progress" ? details.message : "Working...";
        let out = theme.fg("warning", msg);
        if (details?.stage === "progress" && details.previewDiff) {
          const previewPath = details.previewPath
            ? theme.fg("muted", details.previewPath) + "\n"
            : "";
          out +=
            "\n\n" +
            previewPath +
            makeDiffPreview(details.previewDiff, theme, details.previewPath);
        }
        return new Text(withResultSpacing(out), 0, 0);
      }

      if (details?.stage === "done") {
        const warnings = details.warnings ?? [];
        const warningsText =
          warnings.length > 0
            ? warnings.map((w) => theme.fg("warning", w)).join("\n")
            : "";
        const withWarnings = (text: string): string => {
          if (!warningsText) return text;
          if (!text) return warningsText;
          return `${text}\n\n${warningsText}`;
        };

        const failed = details.results.filter((r) => r.status === "failed");
        if (failed.length === 0) {
          const previews = details.previews ?? [];
          if (previews.length === 0) {
            const completed = details.results.filter(
              (r) => r.status === "completed",
            );
            if (completed.length > 0) {
              const out = completed
                .map((r) => renderOperationLine(r, theme))
                .join("\n");
              return new Text(withResultSpacing(withWarnings(out)), 0, 0);
            }

            const output = textFromContent(result.content);
            if (!output) {
              if (!warningsText) return undefined;
              return new Text(withResultSpacing(warningsText), 0, 0);
            }
            return new Text(
              withResultSpacing(withWarnings(theme.fg("toolOutput", output))),
              0,
              0,
            );
          }

          const singleUpdateOnly =
            details.results.length === 1 &&
            details.results[0]?.status === "completed" &&
            details.results[0]?.type === "update_file" &&
            previews.length === 1;

          const out = previews
            .map((p) => {
              const diff = makeDiffPreview(p.diff, theme, p.path);
              if (singleUpdateOnly) return diff;
              const line = firstChangedLineFromDiff(p.diff);
              const header = `${theme.fg("accent", p.path)}${theme.fg("warning", `:${line}`)}`;
              return `${header}\n${diff}`;
            })
            .join("\n\n");
          return new Text(withResultSpacing(withWarnings(out)), 0, 0);
        }

        const out = failed
          .map((r) => {
            return theme.fg("error", r.output ?? "Operation failed");
          })
          .join("\n\n");
        return new Text(withResultSpacing(withWarnings(out)), 0, 0);
      }

      // Fallback
      const output = textFromContent(result.content);
      if (!output)
        return new Text(
          withResultSpacing(theme.fg("muted", "(no output)")),
          0,
          0,
        );
      if (!details)
        return new Text(withResultSpacing(theme.fg("error", output)), 0, 0);
      return new Text(withResultSpacing(theme.fg("toolOutput", output)), 0, 0);
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const update = onUpdate as
        | AgentToolUpdateCallback<ApplyPatchDetails>
        | undefined;
      const progressEmitter = createThrottledProgressEmitter(update, 40);

      const ops = params.operations as ApplyPatchOperation[];
      const preview = collectProgressPreview(ops);
      progressEmitter.emit("Applying patch operations...", preview, true);
      const { fuzz, results, warnings } = await (async () => {
        try {
          return await applyOperations(
            ops,
            ctx.cwd,
            signal,
            (msg, stepPreview) => progressEmitter.emit(msg, stepPreview),
          );
        } finally {
          progressEmitter.flush();
        }
      })();

      const failed = results.filter((r) => r.status === "failed");
      const normalizationNotice =
        warnings.length > 0
          ? "WARNING: forbidden marker lines (for example '*** End Patch') were detected in update_file.diff and auto-removed. Only @@/space/+/- lines are valid."
          : undefined;
      const summaryLines = results
        .map((r) => {
          const opName =
            r.type === "create_file"
              ? "create"
              : r.type === "update_file"
                ? "update"
                : "delete";
          const status = r.status === "completed" ? "✓" : "✗";
          return `${status} ${opName} ${shortenPathForDisplay(r.path)}${r.output ? ` — ${r.output}` : ""}`;
        })
        .join("\n");

      if (failed.length > 0) {
        const errorText = failed
          .map((r) => {
            return r.output && r.output.trim().length > 0
              ? r.output
              : "Operation failed";
          })
          .join("\n");
        const baseError = errorText || `${failed.length} operation(s) failed`;
        throw new DiffError(
          normalizationNotice
            ? `${normalizationNotice}\n${baseError}`
            : baseError,
        );
      }

      const previews = collectSuccessPreviews(ops, results);
      const contentText = normalizationNotice
        ? `${summaryLines || "✓"}\n${normalizationNotice}`
        : summaryLines || "✓";

      return {
        content: [{ type: "text", text: contentText }],
        details: { stage: "done", fuzz, results, previews, warnings },
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    baselineTools = pi.getActiveTools();
    applyToolPolicy(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    applyToolPolicy(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    applyToolPolicy(ctx);
    if (!isCodexModel(ctx)) return;

    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n# apply_patch\n" +
        "- Use the apply_patch tool for file edits.\n" +
        "- Use operations with type: create_file | update_file | delete_file.\n" +
        "- For create_file: diff is full file content in V4A create mode (every line starts with '+').\n" +
        "- For update_file: diff is a V4A diff with @@ sections; each non-empty line must start with @@, space, +, or -.\n" +
        "- NEVER include any line starting with *** in diff.\n" +
        "- BAD: *** End Patch\n" +
        "- GOOD: end diff after normal @@/context/add/remove lines.\n" +
        "- If you need literal *** text in file content, use +*** ... (or a context line starting with a single space).\n" +
        "- For delete_file: no diff.\n" +
        "- Use create_file for new files and update_file for existing files.\n",
    };
  });
}
