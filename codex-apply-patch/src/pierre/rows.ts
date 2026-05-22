import type { FileDiffMetadata } from "../../node_modules/@pierre/diffs/dist/types.js";
import { cleanDiffLine, flattenHighlightedLine } from "./highlight.ts";
import type { DiffRow, HighlightedDiffCode } from "./types.ts";
import type { PierreTerminalPalette } from "./theme.ts";

export function buildDiffRows(
  metadata: FileDiffMetadata,
  highlighted: HighlightedDiffCode,
  palette: PierreTerminalPalette,
): DiffRow[] {
  const rows: DiffRow[] = [];

  for (const hunk of metadata.hunks) {
    if (hunk.collapsedBefore > 0) {
      rows.push({
        kind: "collapsed",
        text: collapsedText(hunk.collapsedBefore),
        fg: palette.metadataFg,
        bg: palette.metadataBg,
      });
    }

    let deletionLineIndex = hunk.deletionLineIndex;
    let additionLineIndex = hunk.additionLineIndex;
    let deletionLineNumber = hunk.deletionStart;
    let additionLineNumber = hunk.additionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          rows.push({
            kind: "line",
            lineType: "context",
            lineNumber: additionLineNumber + offset,
            spans: flattenHighlightedLine(
              highlighted.additionLines[additionLineIndex + offset],
              palette.appearance,
              palette.contextRowBg,
              cleanDiffLine(metadata.additionLines[additionLineIndex + offset]),
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
        rows.push({
          kind: "line",
          lineType: "deletion",
          lineNumber: deletionLineNumber + offset,
          spans: flattenHighlightedLine(
            highlighted.deletionLines[deletionLineIndex + offset],
            palette.appearance,
            palette.deletionRowBg,
            cleanDiffLine(metadata.deletionLines[deletionLineIndex + offset]),
          ),
          rowFg: palette.deletionFg,
          rowBg: palette.deletionRowBg,
          lineNumberFg: palette.lineNumberFg,
        });
      }

      for (let offset = 0; offset < content.additions; offset += 1) {
        rows.push({
          kind: "line",
          lineType: "addition",
          lineNumber: additionLineNumber + offset,
          spans: flattenHighlightedLine(
            highlighted.additionLines[additionLineIndex + offset],
            palette.appearance,
            palette.additionRowBg,
            cleanDiffLine(metadata.additionLines[additionLineIndex + offset]),
          ),
          rowFg: palette.additionFg,
          rowBg: palette.additionRowBg,
          lineNumberFg: palette.lineNumberFg,
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
  if (trailing > 0) {
    rows.push({
      kind: "collapsed",
      text: collapsedText(trailing),
      fg: palette.metadataFg,
      bg: palette.metadataBg,
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

export function lineNumberWidthFor(metadata: FileDiffMetadata): number {
  let maxLine = Math.max(metadata.deletionLines.length, metadata.additionLines.length, 1);
  for (const hunk of metadata.hunks) {
    maxLine = Math.max(
      maxLine,
      hunk.deletionStart + Math.max(hunk.deletionCount - 1, 0),
      hunk.additionStart + Math.max(hunk.additionCount - 1, 0),
    );
  }
  return Math.max(3, String(maxLine).length);
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

function collapsedText(lines: number): string {
  if (lines <= 0) return "…";
  return `… ${lines} unchanged line${lines === 1 ? "" : "s"}`;
}
