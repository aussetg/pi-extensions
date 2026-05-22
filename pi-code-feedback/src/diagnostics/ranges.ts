import { pathToFileURL } from "node:url";
import type { RangeConfidence, TouchedRange, TouchedRangeSource, TrackedToolName } from "../types.ts";

const MAX_EXACT_CONTENT_DIFF_CELLS = 4_000_000;

export interface ComputeTouchedRangesInput {
  filePath: string;
  beforeContent: string | undefined;
  afterContent: string;
  toolName: TrackedToolName;
  detailsDiff?: string;
}

export function computeTouchedRanges(input: ComputeTouchedRangesInput): TouchedRange[] {
  const lineCount = countLines(input.afterContent);

  const diffRanges = input.detailsDiff ? rangesFromToolDiff(input.filePath, input.detailsDiff, lineCount) : [];
  if (diffRanges.length > 0) return diffRanges;

  if (input.beforeContent === undefined) {
    return [makeRange(input.filePath, 1, Math.max(1, lineCount), "whole-file", "approximate")];
  }

  return rangesFromContentDiff(input.filePath, input.beforeContent, input.afterContent);
}

export function rangesFromToolDiff(filePath: string, diff: string, maxLine: number): TouchedRange[] {
  const unified = rangesFromUnifiedDiff(filePath, diff, maxLine);
  if (unified.length > 0) return unified;
  return rangesFromNumberedDiff(filePath, diff, maxLine);
}

export function rangesFromContentDiff(filePath: string, beforeContent: string, afterContent: string): TouchedRange[] {
  if (beforeContent === afterContent) return [];

  const before = splitLines(beforeContent);
  const after = splitLines(afterContent);

  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }

  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  while (beforeEnd >= prefix && afterEnd >= prefix && before[beforeEnd] === after[afterEnd]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const maxLine = countLines(afterContent);
  const beforeMiddleLength = Math.max(0, beforeEnd - prefix + 1);
  const afterMiddleLength = Math.max(0, afterEnd - prefix + 1);
  if (beforeMiddleLength * afterMiddleLength <= MAX_EXACT_CONTENT_DIFF_CELLS) {
    const beforeMiddle = before.slice(prefix, beforeEnd + 1);
    const afterMiddle = after.slice(prefix, afterEnd + 1);
    const changedLines = changedLinesFromLcs(beforeMiddle, afterMiddle, prefix);
    return lineNumbersToRanges(filePath, changedLines, maxLine, "content-diff", "exact");
  }

  const startLine = clampLine(prefix + 1, maxLine);
  const endLine = afterEnd >= prefix ? clampLine(afterEnd + 1, maxLine) : startLine;
  return [makeRange(filePath, startLine, endLine, "content-diff", "approximate")];
}

export function countLines(content: string): number {
  return Math.max(1, splitLines(content).length);
}

export function formatTouchedRange(range: TouchedRange): string {
  const suffix = range.startLine === range.endLine ? `${range.startLine}` : `${range.startLine}-${range.endLine}`;
  return `${suffix} (${range.source}, ${range.confidence})`;
}

function rangesFromUnifiedDiff(filePath: string, diff: string, maxLine: number): TouchedRange[] {
  const changedLines: number[] = [];
  let newLine: number | undefined;

  for (const line of diff.split("\n")) {
    const header = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (header) {
      newLine = Number.parseInt(header[1], 10);
      continue;
    }
    if (newLine === undefined) continue;

    if (line.startsWith("+++") || line.startsWith("---")) continue;

    if (line.startsWith("+")) {
      changedLines.push(newLine);
      newLine += 1;
      continue;
    }

    if (line.startsWith("-")) {
      changedLines.push(newLine);
      continue;
    }

    if (line.startsWith(" ") || line === "") {
      newLine += 1;
    }
  }

  return lineNumbersToRanges(filePath, changedLines, maxLine, "tool-diff", "exact");
}

function rangesFromNumberedDiff(filePath: string, diff: string, maxLine: number): TouchedRange[] {
  const changedLines: number[] = [];
  for (const line of diff.split("\n")) {
    const match = line.match(/^[+-]\s*(\d+)(?:\s|$)/);
    if (!match) continue;
    changedLines.push(Number.parseInt(match[1], 10));
  }
  return lineNumbersToRanges(filePath, changedLines, maxLine, "tool-diff", "approximate");
}

function lineNumbersToRanges(
  filePath: string,
  lines: number[],
  maxLine: number,
  source: TouchedRangeSource,
  confidence: RangeConfidence,
): TouchedRange[] {
  const unique = [...new Set(lines.map((line) => clampLine(line, maxLine)))].sort((a, b) => a - b);
  if (unique.length === 0) return [];

  const ranges: TouchedRange[] = [];
  let start = unique[0];
  let end = unique[0];

  for (const line of unique.slice(1)) {
    if (line <= end + 1) {
      end = line;
      continue;
    }
    ranges.push(makeRange(filePath, start, end, source, confidence));
    start = line;
    end = line;
  }

  ranges.push(makeRange(filePath, start, end, source, confidence));
  return ranges;
}

function changedLinesFromLcs(before: string[], after: string[], offset: number): number[] {
  if (before.length === 0) return after.map((_, index) => offset + index + 1);
  if (after.length === 0) return [offset + 1];

  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);

  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      const index = i * width + j;
      if (before[i] === after[j]) {
        table[index] = table[(i + 1) * width + j + 1] + 1;
      } else {
        table[index] = Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
  }

  const changedLines: number[] = [];
  let i = 0;
  let j = 0;

  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      i += 1;
      j += 1;
      continue;
    }

    if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      changedLines.push(offset + j + 1);
      i += 1;
    } else {
      changedLines.push(offset + j + 1);
      j += 1;
    }
  }

  while (j < after.length) {
    changedLines.push(offset + j + 1);
    j += 1;
  }

  if (i < before.length) {
    changedLines.push(offset + j + 1);
  }

  return changedLines;
}

function makeRange(
  filePath: string,
  startLine: number,
  endLine: number,
  source: TouchedRangeSource,
  confidence: RangeConfidence,
): TouchedRange {
  return {
    uri: pathToFileURL(filePath).href,
    filePath,
    startLine: Math.min(startLine, endLine),
    endLine: Math.max(startLine, endLine),
    source,
    confidence,
  };
}

function splitLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function clampLine(line: number, maxLine: number): number {
  if (!Number.isFinite(line)) return 1;
  return Math.min(Math.max(1, Math.floor(line)), Math.max(1, maxLine));
}

