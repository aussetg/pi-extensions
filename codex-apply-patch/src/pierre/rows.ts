import type { FileDiffMetadata } from "../../node_modules/@pierre/diffs/dist/types.js";
import { diffWordsWithSpace } from "diff";
import { cleanDiffLine } from "./highlight.ts";
import type { DiffRow, HighlightedDiffCode } from "./types.ts";
import type { PierreTerminalPalette } from "./theme.ts";
import type { PierreRendererConfig } from "./config.ts";

export function buildDiffRows(
  metadata: FileDiffMetadata,
  _highlighted: HighlightedDiffCode,
  palette: PierreTerminalPalette,
  config: PierreRendererConfig,
): DiffRow[] {
  const rows: DiffRow[] = [];

  for (const hunk of metadata.hunks) {
    if (hunk.collapsedBefore > 0) {
      rows.push({
        kind: "collapsed",
        count: hunk.collapsedBefore,
      });
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
            spans: plainSpans(line),
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
          ),
          rowFg: palette.deletionFg,
          rowBg: palette.deletionRowBg,
          lineNumberFg: palette.lineNumberFg,
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

function wordDiffSpans(
  line: string,
  pairedLine: string | undefined,
  type: "addition" | "deletion",
  palette: PierreTerminalPalette,
  config: PierreRendererConfig,
) {
  if (
    !config.wordDiff.enabled ||
    config.wordDiff.style === "none" ||
    !pairedLine ||
    line.length === 0 ||
    line.length > config.wordDiff.maxLineLength ||
    pairedLine.length > config.wordDiff.maxLineLength
  ) {
    return plainSpans(line);
  }

  const oldLine = type === "deletion" ? line : pairedLine;
  const newLine = type === "addition" ? line : pairedLine;
  const parts = diffWordsWithSpace(oldLine, newLine);
  const spans = [];
  let changed = false;

  for (const part of parts) {
    if (type === "deletion") {
      if (part.added) continue;
      changed ||= Boolean(part.removed);
      spans.push({
        text: part.value,
        bg: part.removed ? palette.deletionWordBg : undefined,
      });
      continue;
    }

    if (part.removed) continue;
    changed ||= Boolean(part.added);
    spans.push({
      text: part.value,
      bg: part.added ? palette.additionWordBg : undefined,
    });
  }

  return changed && spans.length > 0 ? spans : plainSpans(line);
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
