import type { LineReplacement } from "./types.ts";
import { normalizeLineEndings } from "./util.ts";

export interface GeneratedDiff {
  diff: string;
  firstChangedLine?: number;
}

function splitDisplayLines(content: string): string[] {
  const lines = normalizeLineEndings(content).split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function generateDiffFromReplacements(
  oldContent: string,
  newContent: string,
  replacements: LineReplacement[],
  contextLines = 4,
): GeneratedDiff {
  if (normalizeLineEndings(oldContent) === normalizeLineEndings(newContent)) {
    return { diff: "", firstChangedLine: undefined };
  }

  const oldLines = splitDisplayLines(oldContent);
  const newLines = splitDisplayLines(newContent);
  const maxLineNum = Math.max(oldLines.length, newLines.length, 1);
  const lineNumWidth = String(maxLineNum).length;

  const sorted = [...replacements].sort((a, b) => a.oldStart - b.oldStart);
  let delta = 0;
  const hunks: Array<{
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
    oldSegment: string[];
    newSegment: string[];
  }> = [];

  for (const replacement of sorted) {
    const oldStart = Math.max(0, Math.min(replacement.oldStart, oldLines.length));
    const oldLen = Math.max(
      0,
      Math.min(replacement.oldLines.length, oldLines.length - oldStart),
    );
    const newStart = Math.max(0, Math.min(oldStart + delta, newLines.length));
    const newLen = Math.max(
      0,
      Math.min(replacement.newLines.length, newLines.length - newStart),
    );
    const oldSegment = oldLines.slice(oldStart, oldStart + oldLen);
    const newSegment = newLines.slice(newStart, newStart + newLen);
    delta += newSegment.length - oldSegment.length;

    if (oldSegment.length === 0 && newSegment.length === 0) continue;
    if (
      oldSegment.length === newSegment.length &&
      oldSegment.every((line, i) => line === newSegment[i])
    ) {
      continue;
    }

    hunks.push({
      oldStart,
      oldEnd: oldStart + oldSegment.length,
      newStart,
      newEnd: newStart + newSegment.length,
      oldSegment,
      newSegment,
    });
  }

  if (hunks.length === 0) return { diff: "", firstChangedLine: undefined };

  const groups: Array<typeof hunks> = [];
  let currentGroup: typeof hunks = [];
  let currentOldEnd = -1;
  for (const hunk of hunks) {
    if (
      currentGroup.length === 0 ||
      hunk.oldStart <= currentOldEnd + contextLines * 2
    ) {
      currentGroup.push(hunk);
      currentOldEnd = Math.max(currentOldEnd, hunk.oldEnd);
      continue;
    }
    groups.push(currentGroup);
    currentGroup = [hunk];
    currentOldEnd = hunk.oldEnd;
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  const output: string[] = [];
  const pushContext = (oldIndex: number) => {
    const lineNum = String(oldIndex + 1).padStart(lineNumWidth, " ");
    output.push(` ${lineNum} ${oldLines[oldIndex] ?? ""}`);
  };
  const pushRemoval = (oldIndex: number, line: string) => {
    const lineNum = String(oldIndex + 1).padStart(lineNumWidth, " ");
    output.push(`-${lineNum} ${line}`);
  };
  const pushAddition = (newIndex: number, line: string) => {
    const lineNum = String(newIndex + 1).padStart(lineNumWidth, " ");
    output.push(`+${lineNum} ${line}`);
  };
  const pushEllipsis = () => {
    output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
  };

  let previousContextEnd = 0;
  for (const group of groups) {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const contextStart = Math.max(0, first.oldStart - contextLines);
    const contextEnd = Math.min(oldLines.length, last.oldEnd + contextLines);

    if (contextStart > previousContextEnd) pushEllipsis();

    let oldCursor = contextStart;
    for (const hunk of group) {
      while (oldCursor < hunk.oldStart) {
        pushContext(oldCursor);
        oldCursor++;
      }

      for (let i = 0; i < hunk.oldSegment.length; i++) {
        pushRemoval(hunk.oldStart + i, hunk.oldSegment[i]!);
      }
      for (let i = 0; i < hunk.newSegment.length; i++) {
        pushAddition(hunk.newStart + i, hunk.newSegment[i]!);
      }

      oldCursor = hunk.oldEnd;
    }

    while (oldCursor < contextEnd) {
      pushContext(oldCursor);
      oldCursor++;
    }

    previousContextEnd = contextEnd;
  }

  if (previousContextEnd < oldLines.length) pushEllipsis();

  return {
    diff: output.join("\n"),
    firstChangedLine: hunks[0]!.newStart + 1,
  };
}

