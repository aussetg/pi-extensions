import { pathToFileURL } from "node:url";
import type { RangeConfidence, TouchedRange } from "../types.ts";

const MAX_MAPPING_CELLS = 4_000_000;

interface DiffHunk {
  beforeStart: number;
  beforeEnd: number;
  afterStart: number;
  afterEnd: number;
}

export function mapTouchedRangesThroughFormatting(filePath: string, beforeFormatContent: string, afterFormatContent: string, touchedRanges: TouchedRange[]): TouchedRange[] {
  if (touchedRanges.length === 0 || beforeFormatContent === afterFormatContent) return touchedRanges;

  const beforeLines = splitLines(beforeFormatContent);
  const afterLines = splitLines(afterFormatContent);
  const maxAfterLine = Math.max(1, afterLines.length);

  if (beforeLines.length * afterLines.length > MAX_MAPPING_CELLS) {
    return [makeMappedRange(filePath, 1, maxAfterLine, "approximate")];
  }

  const hunks = buildDiffHunks(beforeLines, afterLines);
  if (hunks.length === 0) return clampRanges(filePath, touchedRanges, maxAfterLine);

  const mapped: TouchedRange[] = [];

  for (const range of touchedRanges) {
    mapped.push(...mapOneRange(filePath, range, hunks, beforeLines.length, afterLines.length));
  }

  return mergeRanges(mapped, maxAfterLine);
}

function mapOneRange(filePath: string, range: TouchedRange, hunks: DiffHunk[], beforeLineCount: number, afterLineCount: number): TouchedRange[] {
  const output: TouchedRange[] = [];
  let beforeCursor = 1;
  let afterCursor = 1;

  for (const hunk of hunks) {
    const equalBeforeStart = beforeCursor;
    const equalBeforeEnd = hunk.beforeStart - 1;
    const equalAfterStart = afterCursor;

    appendEqualOverlap(filePath, output, range, equalBeforeStart, equalBeforeEnd, equalAfterStart);

    if (rangesOverlap(range.startLine, range.endLine, hunk.beforeStart, Math.max(hunk.beforeStart, hunk.beforeEnd))) {
      const afterStart = clampLine(hunk.afterStart, afterLineCount);
      const afterEnd = hunk.afterEnd >= hunk.afterStart ? clampLine(hunk.afterEnd, afterLineCount) : afterStart;
      output.push(makeMappedRange(filePath, afterStart, afterEnd, "approximate"));
    }

    beforeCursor = hunk.beforeEnd + 1;
    afterCursor = hunk.afterEnd + 1;
  }

  appendEqualOverlap(filePath, output, range, beforeCursor, beforeLineCount, afterCursor);
  return output;
}

function appendEqualOverlap(filePath: string, output: TouchedRange[], range: TouchedRange, beforeStart: number, beforeEnd: number, afterStart: number): void {
  if (beforeEnd < beforeStart) return;
  const start = Math.max(range.startLine, beforeStart);
  const end = Math.min(range.endLine, beforeEnd);
  if (end < start) return;
  const delta = afterStart - beforeStart;
  output.push(makeMappedRange(filePath, start + delta, end + delta, range.confidence));
}

function buildDiffHunks(before: string[], after: string[]): DiffHunk[] {
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);

  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      const index = i * width + j;
      table[index] = before[i] === after[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | undefined;
  let i = 0;
  let j = 0;

  const beginHunk = () => {
    if (!hunk) {
      hunk = {
        beforeStart: i + 1,
        beforeEnd: i,
        afterStart: j + 1,
        afterEnd: j,
      };
    }
  };

  const flushHunk = () => {
    if (!hunk) return;
    hunks.push(hunk);
    hunk = undefined;
  };

  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      flushHunk();
      i += 1;
      j += 1;
      continue;
    }

    beginHunk();
    if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      i += 1;
      hunk!.beforeEnd = i;
    } else {
      j += 1;
      hunk!.afterEnd = j;
    }
  }

  while (i < before.length) {
    beginHunk();
    i += 1;
    hunk!.beforeEnd = i;
  }

  while (j < after.length) {
    beginHunk();
    j += 1;
    hunk!.afterEnd = j;
  }

  flushHunk();
  return hunks;
}

function clampRanges(filePath: string, ranges: TouchedRange[], maxAfterLine: number): TouchedRange[] {
  return ranges.map((range) => makeMappedRange(filePath, clampLine(range.startLine, maxAfterLine), clampLine(range.endLine, maxAfterLine), range.confidence));
}

function mergeRanges(ranges: TouchedRange[], maxAfterLine: number): TouchedRange[] {
  const sorted = ranges
    .map((range) => makeMappedRange(range.filePath, clampLine(range.startLine, maxAfterLine), clampLine(range.endLine, maxAfterLine), range.confidence))
    .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);

  const merged: TouchedRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.startLine <= previous.endLine + 1) {
      previous.endLine = Math.max(previous.endLine, range.endLine);
      previous.confidence = weakerConfidence(previous.confidence, range.confidence);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

function makeMappedRange(filePath: string, startLine: number, endLine: number, confidence: RangeConfidence): TouchedRange {
  return {
    uri: pathToFileURL(filePath).href,
    filePath,
    startLine: Math.min(startLine, endLine),
    endLine: Math.max(startLine, endLine),
    source: "formatter-map",
    confidence,
  };
}

function splitLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart <= rightEnd && leftEnd >= rightStart;
}

function clampLine(line: number, maxLine: number): number {
  if (!Number.isFinite(line)) return 1;
  return Math.min(Math.max(1, Math.floor(line)), Math.max(1, maxLine));
}

function weakerConfidence(left: RangeConfidence, right: RangeConfidence): RangeConfidence {
  if (left === "approximate" || right === "approximate") return "approximate";
  if (left === "expanded" || right === "expanded") return "expanded";
  return "exact";
}
