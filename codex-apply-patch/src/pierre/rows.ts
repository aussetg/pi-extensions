import type { FileDiffMetadata } from "../../node_modules/@pierre/diffs/dist/types.js";
import { diffWordsWithSpace } from "diff";
import { cleanDiffLine, flattenHighlightedLine } from "./highlight.ts";
import type { DiffRow, DiffSpan, HighlightedDiffCode } from "./types.ts";
import type { PierreTerminalPalette } from "./theme.ts";
import type { PierreRendererConfig } from "./config.ts";

export function buildDiffRows(
  metadata: FileDiffMetadata,
  highlighted: HighlightedDiffCode,
  palette: PierreTerminalPalette,
  config: PierreRendererConfig,
  options: { expandCollapsed?: boolean } = {},
): DiffRow[] {
  const rows: DiffRow[] = [];

  for (const hunk of metadata.hunks) {
    if (hunk.collapsedBefore > 0) {
      if (options.expandCollapsed) {
        pushContextRows(
          rows,
          metadata,
          highlighted,
          palette,
          hunk.additionLineIndex - hunk.collapsedBefore,
          hunk.additionStart - hunk.collapsedBefore,
          hunk.collapsedBefore,
        );
      } else {
        rows.push({
          kind: "collapsed",
          count: hunk.collapsedBefore,
        });
      }
    }

    let deletionLineIndex = hunk.deletionLineIndex;
    let additionLineIndex = hunk.additionLineIndex;
    let deletionLineNumber = hunk.deletionStart;
    let additionLineNumber = hunk.additionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          const line = cleanDiffLine(
            metadata.additionLines[additionLineIndex + offset],
          );
          rows.push({
            kind: "line",
            lineType: "context",
            lineNumber: additionLineNumber + offset,
            spans: highlightedSpans(
              highlighted.additionLines[additionLineIndex + offset],
              line,
              palette,
              palette.contextRowBg,
            ),
            rowFg: palette.contextFg,
            rowBg: palette.contextRowBg,
            lineNumberFg: palette.lineNumberFg,
          });
        }

        deletionLineIndex += content.lines;
        additionLineIndex += content.lines;
        deletionLineNumber += content.lines;
        additionLineNumber += content.lines;
        continue;
      }

      for (let offset = 0; offset < content.deletions; offset += 1) {
        const deletionLine = cleanDiffLine(
          metadata.deletionLines[deletionLineIndex + offset],
        );
        const pairedAdditionLine =
          offset < content.additions
            ? cleanDiffLine(metadata.additionLines[additionLineIndex + offset])
            : undefined;
        rows.push({
          kind: "line",
          lineType: "deletion",
          lineNumber: deletionLineNumber + offset,
          spans: wordDiffSpans(
            deletionLine,
            pairedAdditionLine,
            "deletion",
            palette,
            config,
            highlightedSpans(
              highlighted.deletionLines[deletionLineIndex + offset],
              deletionLine,
              palette,
              palette.deletionWordBg,
            ),
          ),
          rowFg: palette.deletionFg,
          rowBg: palette.deletionRowBg,
          lineNumberFg: palette.deletionLineNumberFg,
        });
      }

      for (let offset = 0; offset < content.additions; offset += 1) {
        const additionLine = cleanDiffLine(
          metadata.additionLines[additionLineIndex + offset],
        );
        const pairedDeletionLine =
          offset < content.deletions
            ? cleanDiffLine(metadata.deletionLines[deletionLineIndex + offset])
            : undefined;
        rows.push({
          kind: "line",
          lineType: "addition",
          lineNumber: additionLineNumber + offset,
          spans: wordDiffSpans(
            additionLine,
            pairedDeletionLine,
            "addition",
            palette,
            config,
            highlightedSpans(
              highlighted.additionLines[additionLineIndex + offset],
              additionLine,
              palette,
              palette.additionWordBg,
            ),
          ),
          rowFg: palette.additionFg,
          rowBg: palette.additionRowBg,
          lineNumberFg: palette.additionLineNumberFg,
        });
      }

      deletionLineIndex += content.deletions;
      additionLineIndex += content.additions;
      deletionLineNumber += content.deletions;
      additionLineNumber += content.additions;
    }

    if (hunk.noEOFCRDeletions || hunk.noEOFCRAdditions) {
      rows.push({
        kind: "metadata",
        text: "\\ No newline at end of file",
        fg: palette.metadataFg,
        bg: palette.metadataBg,
      });
    }
  }

  const trailing = trailingCollapsedLines(metadata);
  if (trailing > 0 && options.expandCollapsed) {
    const lastHunk = metadata.hunks[metadata.hunks.length - 1]!;
    pushContextRows(
      rows,
      metadata,
      highlighted,
      palette,
      lastHunk.additionLineIndex + lastHunk.additionCount,
      lastHunk.additionStart + lastHunk.additionCount,
      trailing,
    );
  } else if (trailing > 0) {
    rows.push({
      kind: "collapsed",
      count: trailing,
    });
  }

  if (rows.length === 0) {
    rows.push({
      kind: "metadata",
      text: "No diff",
      fg: palette.metadataFg,
      bg: palette.metadataBg,
    });
  }

  return rows;
}

export function lineNumberWidthFor(
  metadata: FileDiffMetadata,
  minWidth = 3,
): number {
  let maxLine = Math.max(metadata.deletionLines.length, metadata.additionLines.length, 1);
  for (const hunk of metadata.hunks) {
    maxLine = Math.max(
      maxLine,
      hunk.deletionStart + Math.max(hunk.deletionCount - 1, 0),
      hunk.additionStart + Math.max(hunk.additionCount - 1, 0),
    );
  }
  return Math.max(minWidth, String(maxLine).length);
}

function plainSpans(text: string) {
  return text.length > 0 ? [{ text }] : [];
}

function pushContextRows(
  rows: DiffRow[],
  metadata: FileDiffMetadata,
  highlighted: HighlightedDiffCode,
  palette: PierreTerminalPalette,
  startIndex: number,
  startLineNumber: number,
  count: number,
): void {
  const safeStartIndex = Math.max(0, startIndex);
  const safeStartLineNumber = Math.max(1, startLineNumber);

  for (let offset = 0; offset < count; offset += 1) {
    const index = safeStartIndex + offset;
    const line = cleanDiffLine(
      metadata.additionLines[index] ?? metadata.deletionLines[index],
    );
    rows.push({
      kind: "line",
      lineType: "context",
      lineNumber: safeStartLineNumber + offset,
      spans: highlightedSpans(
        highlighted.additionLines[index] ?? highlighted.deletionLines[index],
        line,
        palette,
        palette.contextRowBg,
      ),
      rowFg: palette.contextFg,
      rowBg: palette.contextRowBg,
      lineNumberFg: palette.lineNumberFg,
    });
  }
}

function highlightedSpans(
  node: HighlightedDiffCode["additionLines"][number],
  fallbackLine: string,
  palette: PierreTerminalPalette,
  emphasisBg: string,
) {
  return flattenHighlightedLine(
    node,
    palette.appearance,
    palette,
    emphasisBg,
    fallbackLine,
  );
}

function wordDiffSpans(
  line: string,
  pairedLine: string | undefined,
  type: "addition" | "deletion",
  palette: PierreTerminalPalette,
  config: PierreRendererConfig,
  baseSpans: DiffSpan[],
) {
  if (
    !config.wordDiff.enabled ||
    config.wordDiff.style === "none" ||
    !pairedLine ||
    line.length === 0 ||
    line.length > config.wordDiff.maxLineLength ||
    pairedLine.length > config.wordDiff.maxLineLength
  ) {
    return baseSpans;
  }

  const oldLine = type === "deletion" ? line : pairedLine;
  const newLine = type === "addition" ? line : pairedLine;
  const parts = diffWordsWithSpace(oldLine, newLine);
  const ranges: Array<[number, number]> = [];
  let oldIndex = 0;
  let newIndex = 0;
  let changed = false;

  for (const part of parts) {
    const length = part.value.length;
    if (part.removed) {
      if (type === "deletion") ranges.push([oldIndex, oldIndex + length]);
      oldIndex += length;
      changed = true;
      continue;
    }
    if (part.added) {
      if (type === "addition") ranges.push([newIndex, newIndex + length]);
      newIndex += length;
      changed = true;
      continue;
    }

    oldIndex += length;
    newIndex += length;
  }

  return changed && ranges.length > 0
    ? applyWordDiffBackground(
        baseSpans,
        ranges,
        type === "addition" ? palette.additionWordBg : palette.deletionWordBg,
      )
    : baseSpans;
}

function applyWordDiffBackground(
  spans: DiffSpan[],
  ranges: Array<[number, number]>,
  bg: string,
) {
  const out: DiffSpan[] = [];
  let offset = 0;

  for (const span of spans) {
    let localStart = 0;
    const spanStart = offset;
    const spanEnd = offset + span.text.length;

    for (const [rangeStart, rangeEnd] of ranges) {
      const start = Math.max(spanStart, rangeStart);
      const end = Math.min(spanEnd, rangeEnd);
      if (start >= end) continue;

      const before = start - spanStart;
      const after = end - spanStart;
      if (before > localStart) {
        out.push({ ...span, text: span.text.slice(localStart, before) });
      }
      out.push({ ...span, text: span.text.slice(before, after), bg });
      localStart = after;
    }

    if (localStart < span.text.length) {
      out.push({ ...span, text: span.text.slice(localStart) });
    }
    offset = spanEnd;
  }

  return out;
}

function trailingCollapsedLines(metadata: FileDiffMetadata): number {
  const lastHunk =
    metadata.hunks.length > 0
      ? metadata.hunks[metadata.hunks.length - 1]
      : undefined;
  if (!lastHunk || metadata.isPartial) return 0;

  const additionRemaining =
    metadata.additionLines.length -
    (lastHunk.additionLineIndex + lastHunk.additionCount);
  const deletionRemaining =
    metadata.deletionLines.length -
    (lastHunk.deletionLineIndex + lastHunk.deletionCount);

  if (additionRemaining !== deletionRemaining) return 0;
  return Math.max(additionRemaining, 0);
}
