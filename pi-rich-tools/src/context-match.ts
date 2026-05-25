import { DiffError } from "./util.ts";

// Parsed diff chunk: where to delete lines and insert new ones.
export interface Chunk {
  origIndex: number;
  delLines: string[];
  insLines: string[];
}

export interface LineMatchCache {
  raw: string[];
  trimEnd?: string[];
  trim?: string[];
  unicode?: string[];
  rawIndex?: Map<string, number[]>;
  trimEndIndex?: Map<string, number[]>;
  trimIndex?: Map<string, number[]>;
  unicodeIndex?: Map<string, number[]>;
  rawScanMisses?: number;
  preferRawIndex?: boolean;
}

export type FuzzyMatchKind = "trim-end" | "trim" | "unicode" | "eof";

interface ContextMatchResult {
  index: number;
  fuzz: number;
  fuzzKinds: FuzzyMatchKind[];
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

export function getTrimmedLines(cache: LineMatchCache): string[] {
  if (!cache.trim) cache.trim = cache.raw.map((line) => line.trim());
  return cache.trim;
}

function getTrimmedLineIndex(cache: LineMatchCache): Map<string, number[]> {
  if (!cache.trimIndex)
    cache.trimIndex = buildLineIndex(getTrimmedLines(cache));
  return cache.trimIndex;
}

export function normalizeLineForUnicodeMatch(line: string): string {
  return line
    .normalize("NFKC")
    .trim()
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

export function getUnicodeLines(cache: LineMatchCache): string[] {
  if (!cache.unicode)
    cache.unicode = cache.raw.map((line) => normalizeLineForUnicodeMatch(line));
  return cache.unicode;
}

function getUnicodeLineIndex(cache: LineMatchCache): Map<string, number[]> {
  if (!cache.unicodeIndex)
    cache.unicodeIndex = buildLineIndex(getUnicodeLines(cache));
  return cache.unicodeIndex;
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

export function findLineFrom(lines: string[], start: number, target: string): number {
  for (let i = Math.max(0, start); i < lines.length; i++) {
    if (lines[i] === target) return i;
  }
  return -1;
}

// Parse a single update hunk section into context + chunks, returning the next index.
export function peekNextSection(
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
): ContextMatchResult {
  const lines = cache.raw;
  if (contextRaw.length === 0) return { index: start, fuzz: 0, fuzzKinds: [] };
  if (contextRaw.length === 1) {
    let idx = findLineFrom(lines, start, contextRaw[0]!);
    if (idx !== -1) return { index: idx, fuzz: 0, fuzzKinds: [] };

    const linesTrimEnd = getTrimEndLines(cache);
    idx = findLineFrom(linesTrimEnd, start, contextRaw[0]!.trimEnd());
    if (idx !== -1) return { index: idx, fuzz: 1, fuzzKinds: ["trim-end"] };

    const linesTrimmed = getTrimmedLines(cache);
    idx = findLineFrom(linesTrimmed, start, contextRaw[0]!.trim());
    if (idx !== -1) return { index: idx, fuzz: 100, fuzzKinds: ["trim"] };

    const linesUnicode = getUnicodeLines(cache);
    idx = findLineFrom(
      linesUnicode,
      start,
      normalizeLineForUnicodeMatch(contextRaw[0]!),
    );
    if (idx !== -1) return { index: idx, fuzz: 1000, fuzzKinds: ["unicode"] };

    return { index: -1, fuzz: 0, fuzzKinds: [] };
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

  if (exactIndex !== -1) return { index: exactIndex, fuzz: 0, fuzzKinds: [] };

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
  if (rstripIndex !== -1)
    return { index: rstripIndex, fuzz: 1, fuzzKinds: ["trim-end"] };

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
  if (trimIndex !== -1)
    return { index: trimIndex, fuzz: 100, fuzzKinds: ["trim"] };

  let contextUnicode: string[] | undefined;
  const getContextUnicode = () => {
    if (!contextUnicode) {
      contextUnicode = new Array<string>(contextRaw.length);
      for (let i = 0; i < contextRaw.length; i++) {
        contextUnicode[i] = normalizeLineForUnicodeMatch(contextRaw[i]!);
      }
    }
    return contextUnicode;
  };

  const linesUnicode = getUnicodeLines(cache);
  const unicodeIndex =
    linesUnicode.length >= INDEXED_CONTEXT_MATCH_MIN_LINES
      ? findContextByIndex(
          linesUnicode,
          getContextUnicode(),
          start,
          getUnicodeLineIndex(cache),
        )
      : findContextByScan(linesUnicode, getContextUnicode(), start);
  if (unicodeIndex !== -1)
    return { index: unicodeIndex, fuzz: 1000, fuzzKinds: ["unicode"] };

  return { index: -1, fuzz: 0, fuzzKinds: [] };
}

// If the section is marked EOF, prefer matching near file end; otherwise match forward.
export function findContext(
  cache: LineMatchCache,
  contextRaw: string[],
  start: number,
  eof: boolean,
): ContextMatchResult {
  if (eof) {
    const atEof = findContextCore(
      cache,
      contextRaw,
      Math.max(0, cache.raw.length - contextRaw.length),
    );
    if (atEof.index !== -1) return atEof;
    const fallback = findContextCore(cache, contextRaw, start);
    return {
      index: fallback.index,
      fuzz: fallback.fuzz + 10000,
      fuzzKinds: [...fallback.fuzzKinds, "eof"],
    };
  }
  return findContextCore(cache, contextRaw, start);
}

export function matchDeletedLines(
  cache: LineMatchCache,
  start: number,
  expected: string[],
): {
  matched: boolean;
  actual: string[];
  fuzz: number;
  fuzzKinds: FuzzyMatchKind[];
} {
  const actual = expected.map((_, i) => cache.raw[start + i] ?? "");
  if (start < 0 || start + expected.length > cache.raw.length) {
    return { matched: false, actual, fuzz: 0, fuzzKinds: [] };
  }

  if (expected.length === 0)
    return { matched: true, actual: [], fuzz: 0, fuzzKinds: [] };

  if (expected.every((line, i) => line === actual[i])) {
    return { matched: true, actual, fuzz: 0, fuzzKinds: [] };
  }

  if (expected.every((line, i) => line.trimEnd() === actual[i]!.trimEnd())) {
    return { matched: true, actual, fuzz: 1, fuzzKinds: ["trim-end"] };
  }

  if (expected.every((line, i) => line.trim() === actual[i]!.trim())) {
    return { matched: true, actual, fuzz: 100, fuzzKinds: ["trim"] };
  }

  if (
    expected.every(
      (line, i) =>
        normalizeLineForUnicodeMatch(line) ===
        normalizeLineForUnicodeMatch(actual[i]!),
    )
  ) {
    return { matched: true, actual, fuzz: 1000, fuzzKinds: ["unicode"] };
  }

  return { matched: false, actual, fuzz: 0, fuzzKinds: [] };
}

