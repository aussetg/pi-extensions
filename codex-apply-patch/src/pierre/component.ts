import type { Component } from "@mariozechner/pi-tui";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { hasHighlightedLines, loadHighlightedDiff } from "./highlight.ts";
import { buildDiffRows, lineNumberWidthFor } from "./rows.ts";
import {
  getPierreRendererConfig,
  type PierreRendererConfig,
} from "./config.ts";
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
  private config: PierreRendererConfig;
  private palette: PierreTerminalPalette;
  private text: string;
  private kind: "pending" | "success" | "error";

  constructor(
    theme: PiThemeLike,
    text: string,
    kind: "pending" | "success" | "error",
  ) {
    this.config = getPierreRendererConfig();
    this.palette = getPierrePalette(theme, this.config);
    this.text = text;
    this.kind = kind;
  }

  update(
    theme: PiThemeLike,
    text: string,
    kind: "pending" | "success" | "error",
  ): void {
    this.config = getPierreRendererConfig();
    this.palette = getPierrePalette(theme, this.config);
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
  private theme: PiThemeLike;
  private config: PierreRendererConfig;
  private palette: PierreTerminalPalette;
  private maxVisibleLines: number;
  private showFileHeaders: boolean;
  private explicitMaxVisibleLines: number | undefined;
  private explicitShowFileHeaders: boolean | undefined;
  private invalidateView: (() => void) | undefined;
  private highlightedByKey = new Map<string, HighlightedDiffSet>();
  private loadingByKey = new Map<string, Promise<void>>();
  private attemptedKeys = new Set<string>();

  constructor(
    payloads: PierreDiffPayload | PierreDiffPayload[],
    theme: PiThemeLike,
    options: PierreInlineDiffOptions = {},
  ) {
    this.payloads = normalizePayloads(payloads);
    this.theme = theme;
    this.explicitMaxVisibleLines = options.maxVisibleLines;
    this.explicitShowFileHeaders = options.showFileHeaders;
    this.invalidateView = options.onInvalidate;
    this.config = getPierreRendererConfig();
    this.palette = getPierrePalette(theme, this.config);
    this.maxVisibleLines =
      options.maxVisibleLines ?? this.config.layout.maxVisibleLines;
    this.showFileHeaders = resolveShowFileHeaders(
      this.config,
      options.showFileHeaders,
      this.payloads.length,
    );
    this.ingestHighlightedPayloads();
    this.maybeRefreshHighlightedDiffs();
  }

  update(
    payloads: PierreDiffPayload | PierreDiffPayload[],
    theme: PiThemeLike,
    options: PierreInlineDiffOptions = {},
  ): void {
    this.payloads = normalizePayloads(payloads);
    this.theme = theme;
    this.explicitMaxVisibleLines = options.maxVisibleLines;
    this.explicitShowFileHeaders = options.showFileHeaders;
    this.invalidateView = options.onInvalidate;
    this.config = getPierreRendererConfig();
    this.palette = getPierrePalette(theme, this.config);
    this.maxVisibleLines =
      options.maxVisibleLines ?? this.config.layout.maxVisibleLines;
    this.showFileHeaders = resolveShowFileHeaders(
      this.config,
      options.showFileHeaders,
      this.payloads.length,
    );
    this.ingestHighlightedPayloads();
    this.maybeRefreshHighlightedDiffs();
  }

  render(width: number): string[] {
    this.config = getPierreRendererConfig();
    this.palette = getPierrePalette(this.theme, this.config);
    this.maxVisibleLines =
      this.explicitMaxVisibleLines ?? this.config.layout.maxVisibleLines;
    this.showFileHeaders = resolveShowFileHeaders(
      this.config,
      this.explicitShowFileHeaders,
      this.payloads.length,
    );
    this.maybeRefreshHighlightedDiffs();
    const safeWidth = Math.max(20, width);
    const lines: string[] = [];

    for (let i = 0; i < this.config.spacing.beforeDiff; i += 1) {
      lines.push(renderBlankLine(safeWidth, this.palette.editorBg));
    }

    for (let i = 0; i < this.payloads.length; i++) {
      const payload = this.payloads[i]!;
      if (this.showFileHeaders || this.payloads.length > 1) {
        lines.push(renderFileHeader(payload, this.palette, this.config, safeWidth));
      }

      const highlighted = this.highlightedFor(payload)[this.palette.appearance];
      const rows = buildDiffRows(
        payload.metadata,
        highlighted,
        this.palette,
        this.config,
      );
      for (const row of rows) {
        lines.push(...this.renderRow(payload, row, safeWidth));
      }
    }

    if (lines.length <= this.maxVisibleLines) return lines;

    const visible = Math.max(1, this.maxVisibleLines - 1);
    return [
      ...lines.slice(0, visible),
      renderHunkNoticeLine(
        formatCountLabel(
          this.config.hunk.moreDiffLabel,
          lines.length - visible,
        ),
        this.palette,
        this.config,
        safeWidth,
      ),
    ];
  }

  invalidate(): void {}

  private renderRow(
    payload: PierreDiffPayload,
    row: DiffRow,
    width: number,
  ): string[] {
    if (row.kind === "metadata") {
      return [
        renderMetadataLine(row.text, this.palette, this.config, width, row),
      ];
    }

    if (row.kind === "collapsed") {
      return [
        renderHunkNoticeLine(
          formatCountLabel(this.config.hunk.collapsedLabel, row.count),
          this.palette,
          this.config,
          width,
          payload,
        ),
      ];
    }

    const lineNumberWidth = lineNumberWidthFor(
      payload.metadata,
      this.config.gutter.lineNumberMinWidth,
    );
    const prefixSegments = linePrefixSegments(
      row,
      lineNumberWidth,
      this.palette,
      this.config,
    );
    const prefix = linePrefixText(row, lineNumberWidth, this.config);
    const prefixWidth = visibleWidth(prefix);
    const contentWidth = Math.max(8, width - prefixWidth);
    const prefixAnsi = renderSegments(prefixSegments, {
      fg: row.rowFg,
      bg: row.rowBg,
    });
    const continuationAnsi = renderSegments(
      continuationPrefixSegments(
        prefixWidth,
        row,
        this.palette,
        this.config,
      ),
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
    if (!this.config.syntaxHighlight.enabled) return emptyHighlightedDiffSet();

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
      this.attemptedKeys.add(key);
    }
  }

  private maybeRefreshHighlightedDiffs(): void {
    if (!this.config.syntaxHighlight.enabled) return;

    for (const payload of this.payloads) {
      const key = payloadKey(payload);
      if (this.highlightedByKey.has(key)) continue;
      if (this.loadingByKey.has(key)) continue;
      if (this.attemptedKeys.has(key)) continue;
      if (!shouldHighlight(payload, this.config)) continue;

      const pending = loadHighlightedDiff(payload.metadata, this.config)
        .then((highlighted) => {
          this.highlightedByKey.set(key, highlighted);
          this.attemptedKeys.add(key);
          this.invalidateView?.();
        })
        .catch(() => {
          this.attemptedKeys.add(key);
        })
        .finally(() => {
          this.loadingByKey.delete(key);
        });

      this.loadingByKey.set(key, pending);
    }
  }
}

function shouldHighlight(
  payload: PierreDiffPayload,
  config: PierreRendererConfig,
): boolean {
  const lineCount =
    payload.metadata.deletionLines.length + payload.metadata.additionLines.length;
  return lineCount > 0 && lineCount <= config.syntaxHighlight.maxLines;
}

function renderFileHeader(
  payload: PierreDiffPayload,
  palette: PierreTerminalPalette,
  config: PierreRendererConfig,
  width: number,
): string {
  const label = changeLabel(payload.metadata.type);
  return renderFullWidthLine(
    [
      { text: " ".repeat(config.layout.leftPadding), fg: palette.headerFg, bg: palette.headerBg },
      { text: `${label} `, fg: palette.headerFg, bg: palette.headerBg, bold: true },
      { text: payload.path, fg: palette.headerAccentFg, bg: palette.headerBg },
    ],
    width,
    { fg: palette.headerFg, bg: palette.headerBg },
  );
}

function renderBlankLine(width: number, bg: string): string {
  return renderFullWidthLine([], width, { bg });
}

function renderMetadataLine(
  text: string,
  palette: PierreTerminalPalette,
  config: PierreRendererConfig,
  width: number,
  row: { fg: string; bg: string },
): string {
  return renderFullWidthLine(
    [
      { text: " ".repeat(config.layout.leftPadding), fg: row.fg, bg: row.bg },
      { text, fg: row.fg, bg: row.bg },
    ],
    width,
    { fg: palette.metadataFg, bg: row.bg },
  );
}

function renderHunkNoticeLine(
  text: string,
  palette: PierreTerminalPalette,
  config: PierreRendererConfig,
  width: number,
  payload?: PierreDiffPayload,
): string {
  const lineNumberWidth = payload
    ? lineNumberWidthFor(payload.metadata, config.gutter.lineNumberMinWidth)
    : config.gutter.lineNumberMinWidth;
  const prefixSegments = hunkPrefixSegments(lineNumberWidth, palette, config);
  prefixSegments.push({ text, fg: palette.hunkFg, bg: palette.hunkBg });

  return renderFullWidthLine(prefixSegments, width, {
    fg: palette.hunkFg,
    bg: palette.hunkBg,
  });
}

function linePrefixSegments(
  row: Extract<DiffRow, { kind: "line" }>,
  lineNumberWidth: number,
  palette: PierreTerminalPalette,
  config: PierreRendererConfig,
): RenderSegment[] {
  const pad = {
    text: " ".repeat(config.layout.leftPadding),
    fg: row.rowFg,
    bg: palette.editorBg,
  };
  const number = {
    text:
      formatLineNumber(row.lineNumber, lineNumberWidth) +
      " ".repeat(config.gutter.lineNumberPaddingRight),
    fg: row.lineNumberFg,
    bg: lineNumberBg(row.lineType, palette),
  };
  const separator = {
    text: config.gutter.separator,
    fg: palette.gutterFg,
    bg: row.rowBg,
  };
  const bar = {
    text: lineBar(row.lineType, config),
    ...lineBarColors(row.lineType, palette),
  };
  const barGap = {
    text: config.gutter.barGap,
    fg: palette.gutterFg,
    bg: lineNumberBg(row.lineType, palette),
  };

  return config.gutter.barPosition === "after-number"
    ? [pad, number, separator, bar, { ...barGap, bg: row.rowBg }]
    : [pad, bar, barGap, number, separator];
}

function linePrefixText(
  row: Extract<DiffRow, { kind: "line" }>,
  lineNumberWidth: number,
  config: PierreRendererConfig,
): string {
  const number =
    formatLineNumber(row.lineNumber, lineNumberWidth) +
    " ".repeat(config.gutter.lineNumberPaddingRight);
  const bar = lineBar(row.lineType, config);
  const pad = " ".repeat(config.layout.leftPadding);

  return config.gutter.barPosition === "after-number"
    ? pad + number + config.gutter.separator + bar + config.gutter.barGap
    : pad + bar + config.gutter.barGap + number + config.gutter.separator;
}

function hunkPrefixSegments(
  lineNumberWidth: number,
  palette: PierreTerminalPalette,
  config: PierreRendererConfig,
): RenderSegment[] {
  const pad = {
    text: " ".repeat(config.layout.leftPadding),
    fg: palette.hunkFg,
    bg: palette.hunkBg,
  };
  const numberSpace = {
    text: " ".repeat(lineNumberWidth + config.gutter.lineNumberPaddingRight),
    fg: palette.lineNumberFg,
    bg: palette.hunkBg,
  };
  const separator = {
    text: config.gutter.separator,
    fg: palette.gutterFg,
    bg: palette.hunkBg,
  };
  const bar = { text: config.gutter.hunkBar, fg: palette.hunkFg, bg: palette.hunkBg };
  const barGap = { text: config.gutter.barGap, fg: palette.hunkFg, bg: palette.hunkBg };

  return config.gutter.barPosition === "after-number"
    ? [pad, numberSpace, separator, bar, barGap]
    : [pad, bar, barGap, numberSpace, separator];
}

function continuationPrefixSegments(
  prefixWidth: number,
  row: Extract<DiffRow, { kind: "line" }>,
  palette: PierreTerminalPalette,
  config: PierreRendererConfig,
): RenderSegment[] {
  const pad = " ".repeat(config.layout.leftPadding);
  const numberBg = lineNumberBg(row.lineType, palette);

  if (config.gutter.barPosition === "before-number") {
    const rest = Math.max(
      0,
      prefixWidth -
        visibleWidth(
          pad + config.gutter.continuationBar + config.gutter.barGap,
        ) -
        visibleWidth(config.gutter.separator),
    );

    return [
      { text: pad, fg: row.rowFg, bg: palette.editorBg },
      { text: config.gutter.continuationBar, fg: palette.contextBarFg, bg: numberBg },
      { text: config.gutter.barGap, fg: palette.gutterFg, bg: numberBg },
      { text: " ".repeat(rest), fg: palette.lineNumberFg, bg: numberBg },
      { text: config.gutter.separator, fg: palette.gutterFg, bg: row.rowBg },
    ];
  }

  const rest = Math.max(
    0,
    prefixWidth -
      visibleWidth(
        pad + config.gutter.continuationBar + config.gutter.barGap,
      ),
  );

  return [
    { text: pad, fg: row.rowFg, bg: palette.editorBg },
    { text: " ".repeat(rest), fg: palette.lineNumberFg, bg: numberBg },
    { text: config.gutter.continuationBar, fg: palette.contextBarFg, bg: palette.contextBarBg },
    { text: config.gutter.barGap, fg: row.rowFg, bg: row.rowBg },
  ];
}

function lineNumberBg(
  lineType: "context" | "addition" | "deletion",
  palette: PierreTerminalPalette,
): string {
  if (lineType === "addition") return palette.additionLineNumberBg;
  if (lineType === "deletion") return palette.deletionLineNumberBg;
  return palette.lineNumberBg;
}

function lineBar(
  lineType: "context" | "addition" | "deletion",
  config: PierreRendererConfig,
): string {
  return lineType === "addition"
    ? config.gutter.additionBar
    : lineType === "deletion"
      ? config.gutter.deletionBar
      : config.gutter.contextBar;
}

function lineBarColors(
  lineType: "context" | "addition" | "deletion",
  palette: PierreTerminalPalette,
): Pick<RenderSegment, "fg" | "bg"> {
  if (lineType === "addition") {
    return { fg: palette.additionBarFg, bg: palette.additionBarBg };
  }
  if (lineType === "deletion") {
    return { fg: palette.deletionBarFg, bg: palette.deletionBarBg };
  }
  return { fg: palette.contextBarFg, bg: palette.contextBarBg };
}

function formatCountLabel(template: string, count: number): string {
  const noun = count === 1 ? "line" : "lines";
  return template
    .replaceAll("{count}", String(count))
    .replaceAll("{line|lines}", noun)
    .replaceAll("{s}", count === 1 ? "" : "s");
}

function resolveShowFileHeaders(
  config: PierreRendererConfig,
  explicit: boolean | undefined,
  payloadCount: number,
): boolean {
  if (explicit !== undefined) return explicit;
  if (config.layout.showFileHeaders === "always") return true;
  if (config.layout.showFileHeaders === "never") return false;
  return payloadCount > 1;
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

function changeLabel(type: string): string {
  if (type === "new") return "create";
  if (type === "deleted") return "delete";
  if (type.startsWith("rename")) return "move";
  return "update";
}
