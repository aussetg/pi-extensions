import type { Component } from "@mariozechner/pi-tui";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { hasHighlightedLines } from "./highlight.ts";
import { buildDiffRows, lineNumberWidthFor } from "./rows.ts";
import {
  getPierrePalette,
  type PiThemeLike,
  type PierreTerminalPalette,
} from "./theme.ts";
import type {
  DiffRow,
  DiffSpan,
  HighlightedDiffSet,
  PierreDiffPayload,
} from "./types.ts";
import { emptyHighlightedDiffSet } from "./types.ts";

const ANSI_RESET = "\u001b[22m\u001b[39m\u001b[49m";
const DEFAULT_MAX_VISIBLE_LINES = 18;

interface RenderSegment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}

export interface PierreInlineDiffOptions {
  maxVisibleLines?: number;
  showFileHeaders?: boolean;
  onInvalidate?: () => void;
}

export class PierreStatusComponent implements Component {
  private palette: PierreTerminalPalette;
  private text: string;
  private kind: "pending" | "success" | "error";

  constructor(
    theme: PiThemeLike,
    text: string,
    kind: "pending" | "success" | "error",
  ) {
    this.palette = getPierrePalette(theme);
    this.text = text;
    this.kind = kind;
  }

  update(
    theme: PiThemeLike,
    text: string,
    kind: "pending" | "success" | "error",
  ): void {
    this.palette = getPierrePalette(theme);
    this.text = text;
    this.kind = kind;
  }

  render(width: number): string[] {
    const colors =
      this.kind === "success"
        ? { fg: this.palette.successFg, bg: this.palette.successBg }
        : this.kind === "error"
          ? { fg: this.palette.errorFg, bg: this.palette.errorBg }
          : { fg: this.palette.pendingFg, bg: this.palette.pendingBg };

    return [
      renderFullWidthLine([{ text: this.text, ...colors }], width, colors),
    ];
  }

  invalidate(): void {}
}

export class PierreInlineDiffComponent implements Component {
  private payloads: PierreDiffPayload[];
  private palette: PierreTerminalPalette;
  private maxVisibleLines: number;
  private showFileHeaders: boolean;
  private highlightedByKey = new Map<string, HighlightedDiffSet>();

  constructor(
    payloads: PierreDiffPayload | PierreDiffPayload[],
    theme: PiThemeLike,
    options: PierreInlineDiffOptions = {},
  ) {
    this.payloads = normalizePayloads(payloads);
    this.palette = getPierrePalette(theme);
    this.maxVisibleLines = options.maxVisibleLines ?? DEFAULT_MAX_VISIBLE_LINES;
    this.showFileHeaders = options.showFileHeaders ?? this.payloads.length > 1;
    this.ingestHighlightedPayloads();
  }

  update(
    payloads: PierreDiffPayload | PierreDiffPayload[],
    theme: PiThemeLike,
    options: PierreInlineDiffOptions = {},
  ): void {
    this.payloads = normalizePayloads(payloads);
    this.palette = getPierrePalette(theme);
    this.maxVisibleLines = options.maxVisibleLines ?? DEFAULT_MAX_VISIBLE_LINES;
    this.showFileHeaders = options.showFileHeaders ?? this.payloads.length > 1;
    this.ingestHighlightedPayloads();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const lines: string[] = [];

    for (let i = 0; i < this.payloads.length; i++) {
      const payload = this.payloads[i]!;
      if (this.showFileHeaders || this.payloads.length > 1) {
        lines.push(renderFileHeader(payload, this.palette, safeWidth));
      }

      const highlighted = this.highlightedFor(payload)[this.palette.appearance];
      const rows = buildDiffRows(payload.metadata, highlighted, this.palette);
      for (const row of rows) {
        lines.push(...this.renderRow(payload, row, safeWidth));
      }
    }

    if (lines.length <= this.maxVisibleLines) return lines;

    const visible = Math.max(1, this.maxVisibleLines - 1);
    return [
      ...lines.slice(0, visible),
      renderFullWidthLine(
        [
          {
            text: `… ${lines.length - visible} more diff line${lines.length - visible === 1 ? "" : "s"}`,
            fg: this.palette.metadataFg,
            bg: this.palette.metadataBg,
          },
        ],
        safeWidth,
        { fg: this.palette.metadataFg, bg: this.palette.metadataBg },
      ),
    ];
  }

  invalidate(): void {}

  private renderRow(
    payload: PierreDiffPayload,
    row: DiffRow,
    width: number,
  ): string[] {
    if (row.kind !== "line") {
      const text = row.kind === "collapsed" ? ` ${row.text}` : row.text;
      return [
        renderFullWidthLine(
          [{ text, fg: row.fg, bg: row.bg }],
          width,
          { fg: row.fg, bg: row.bg },
        ),
      ];
    }

    const lineNumberWidth = lineNumberWidthFor(payload.metadata);
    const prefixSegments: RenderSegment[] = [
      { text: lineMarker(row.lineType), fg: row.rowFg, bg: row.rowBg },
      {
        text: formatLineNumber(row.lineNumber, lineNumberWidth),
        fg: row.lineNumberFg,
        bg: row.rowBg,
      },
      { text: " ", fg: row.lineNumberFg, bg: row.rowBg },
    ];

    const prefix = `${lineMarker(row.lineType)}${formatLineNumber(
      row.lineNumber,
      lineNumberWidth,
    )} `;
    const prefixWidth = visibleWidth(prefix);
    const contentWidth = Math.max(8, width - prefixWidth);
    const prefixAnsi = renderSegments(prefixSegments, {
      fg: row.rowFg,
      bg: row.rowBg,
    });
    const continuationAnsi = renderSegments(
      [{ text: " ".repeat(prefixWidth), fg: row.rowFg, bg: row.rowBg }],
      { fg: row.rowFg, bg: row.rowBg },
    );
    const contentAnsi = renderSegments(
      row.spans.length > 0 ? row.spans : [{ text: " " }],
      { fg: row.rowFg, bg: row.rowBg },
    );

    const wrapped = wrapTextWithAnsi(contentAnsi, contentWidth);
    return wrapped.map((segment, index) =>
      padRenderedLine(
        `${index === 0 ? prefixAnsi : continuationAnsi}${segment}`,
        width,
        { fg: row.rowFg, bg: row.rowBg },
      ),
    );
  }

  private highlightedFor(payload: PierreDiffPayload): HighlightedDiffSet {
    const key = payloadKey(payload);
    return (
      this.highlightedByKey.get(key) ??
      payload.highlighted ??
      emptyHighlightedDiffSet()
    );
  }

  private ingestHighlightedPayloads(): void {
    for (const payload of this.payloads) {
      if (!payload.highlighted || !hasHighlightedLines(payload.highlighted)) continue;
      const key = payloadKey(payload);
      this.highlightedByKey.set(key, payload.highlighted);
    }
  }
}

function renderFileHeader(
  payload: PierreDiffPayload,
  palette: PierreTerminalPalette,
  width: number,
): string {
  const label = changeLabel(payload.metadata.type);
  return renderFullWidthLine(
    [
      { text: `${label} `, fg: palette.headerFg, bg: palette.headerBg, bold: true },
      { text: payload.path, fg: palette.headerAccentFg, bg: palette.headerBg },
    ],
    width,
    { fg: palette.headerFg, bg: palette.headerBg },
  );
}

function renderFullWidthLine(
  segments: RenderSegment[],
  width: number,
  base: { fg?: string; bg?: string; bold?: boolean },
): string {
  const safeWidth = Math.max(1, width);
  const rendered = renderSegments(segments, base);
  return padRenderedLine(truncateToWidth(rendered, safeWidth), safeWidth, base);
}

function padRenderedLine(
  line: string,
  width: number,
  base: { fg?: string; bg?: string; bold?: boolean },
): string {
  const safeWidth = Math.max(1, width);
  const clipped =
    visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, "") : line;
  const padding = Math.max(0, safeWidth - visibleWidth(clipped));
  return `${clipped}${openAnsi(base)}${" ".repeat(padding)}${ANSI_RESET}`;
}

function renderSegments(
  segments: Array<RenderSegment | DiffSpan>,
  base: { fg?: string; bg?: string; bold?: boolean },
): string {
  let output = openAnsi(base);
  for (const segment of segments) {
    output += openAnsi({
      fg: segment.fg ?? base.fg,
      bg: segment.bg ?? base.bg,
      bold: "bold" in segment ? segment.bold ?? base.bold : base.bold,
    });
    output += segment.text;
  }
  output += openAnsi(base);
  return output;
}

function openAnsi(style: { fg?: string; bg?: string; bold?: boolean }): string {
  return [
    `\u001b[${style.bold ? "1" : "22"}m`,
    colorToAnsi(style.fg, "fg"),
    colorToAnsi(style.bg, "bg"),
  ].join("");
}

function colorToAnsi(
  color: string | undefined,
  slot: "fg" | "bg",
): string {
  const reset = slot === "fg" ? "\u001b[39m" : "\u001b[49m";
  const normalized = color?.trim();
  if (!normalized) return reset;

  if (normalized.includes("\u001b[")) return normalized;

  const rgb = toRgb(normalized);
  if (!rgb) return reset;

  const prefix = slot === "fg" ? "38" : "48";
  return `\u001b[${prefix};2;${rgb.r};${rgb.g};${rgb.b}m`;
}

function toRgb(hex: string) {
  const normalized = hex.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) return undefined;

  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function normalizePayloads(
  payloads: PierreDiffPayload | PierreDiffPayload[],
): PierreDiffPayload[] {
  return Array.isArray(payloads) ? payloads : [payloads];
}

function payloadKey(payload: PierreDiffPayload): string {
  if (payload.metadata.cacheKey) return payload.metadata.cacheKey;
  return [
    payload.path,
    payload.metadata.name,
    payload.metadata.prevName ?? "",
    payload.metadata.type,
    payload.metadata.lang ?? "",
    payload.metadata.deletionLines.join("\n"),
    payload.metadata.additionLines.join("\n"),
    payload.metadata.hunks.map((hunk) => hunk.hunkSpecs ?? "").join("\n"),
  ].join("\u0000");
}

function formatLineNumber(lineNumber: number | undefined, width: number): string {
  return lineNumber === undefined ? " ".repeat(width) : String(lineNumber).padStart(width, " ");
}

function lineMarker(lineType: "context" | "addition" | "deletion"): string {
  return lineType === "addition" ? "+" : lineType === "deletion" ? "-" : " ";
}

function changeLabel(type: string): string {
  if (type === "new") return "create";
  if (type === "deleted") return "delete";
  if (type.startsWith("rename")) return "move";
  return "update";
}
