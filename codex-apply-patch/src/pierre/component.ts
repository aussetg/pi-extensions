import type { Component } from "@earendil-works/pi-tui";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  ANSI_RESET,
  openAnsi,
  renderAnsiSegments as renderSegments,
} from "./ansi.ts";
import {
  continuationPrefixSegments,
  lineBar,
  lineBarColors,
  lineNumberBg,
} from "./gutter.ts";
import {
  buildPiHighlightedDiff,
  hasHighlightedLines,
  loadHighlightedDiff,
} from "./highlight.ts";
import {
  globalPiHighlightCache,
  globalPiHighlightGeneration,
} from "./highlight-cache.ts";
import { buildCachedDiffRows, lineNumberWidthFor } from "./rows.ts";
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
  HighlightedDiffSet,
  PierreDiffPayload,
} from "./types.ts";
import { emptyHighlightedDiffSet } from "./types.ts";

const PI_HIGHLIGHT_CACHE_LIMIT = 512;
const payloadCacheKeys = new WeakMap<object, { path: string; key: string }>();

interface RenderSegment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}

export interface PierreInlineDiffOptions {
  showFileHeaders?: boolean;
  expandCollapsedHunks?: boolean;
  suppressLeadingSpacing?: boolean;
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
  private showFileHeaders: boolean;
  private explicitShowFileHeaders: boolean | undefined;
  private expandCollapsedHunks: boolean;
  private suppressLeadingSpacing: boolean;
  private invalidateView: (() => void) | undefined;
  private highlightedByKey = new Map<string, HighlightedDiffSet>();
  private piHighlightedByKey = globalPiHighlightCache();
  private piHighlightFallbacksByKey = new Set<string>();
  private piHighlightGeneration = globalPiHighlightGeneration();
  private renderedKey: string | undefined;
  private renderedLines: string[] | undefined;

  constructor(
    payloads: PierreDiffPayload | PierreDiffPayload[],
    theme: PiThemeLike,
    options: PierreInlineDiffOptions = {},
  ) {
    this.payloads = normalizePayloads(payloads);
    this.theme = theme;
    this.explicitShowFileHeaders = options.showFileHeaders;
    this.expandCollapsedHunks = Boolean(options.expandCollapsedHunks);
    this.suppressLeadingSpacing = Boolean(options.suppressLeadingSpacing);
    this.invalidateView = options.onInvalidate;
    this.config = getPierreRendererConfig();
    this.palette = getPierrePalette(theme, this.config);
    this.showFileHeaders = resolveShowFileHeaders(
      this.config,
      options.showFileHeaders,
      this.payloads.length,
    );
    this.ingestHighlightedPayloads();
  }

  update(
    payloads: PierreDiffPayload | PierreDiffPayload[],
    theme: PiThemeLike,
    options: PierreInlineDiffOptions = {},
  ): void {
    this.payloads = normalizePayloads(payloads);
    this.theme = theme;
    this.explicitShowFileHeaders = options.showFileHeaders;
    this.expandCollapsedHunks = Boolean(options.expandCollapsedHunks);
    this.suppressLeadingSpacing = Boolean(options.suppressLeadingSpacing);
    this.invalidateView = options.onInvalidate;
    this.config = getPierreRendererConfig();
    this.palette = getPierrePalette(theme, this.config);
    this.showFileHeaders = resolveShowFileHeaders(
      this.config,
      options.showFileHeaders,
      this.payloads.length,
    );
    this.ingestHighlightedPayloads();
    this.clearRenderedCache();
  }

  render(width: number): string[] {
    this.resetLocalCachesAfterPierreReset();
    this.config = getPierreRendererConfig();
    this.palette = getPierrePalette(this.theme, this.config);
    this.showFileHeaders = resolveShowFileHeaders(
      this.config,
      this.explicitShowFileHeaders,
      this.payloads.length,
    );
    const safeWidth = Math.max(20, width);
    const renderedKey = this.renderCacheKey(safeWidth);
    if (this.renderedKey === renderedKey && this.renderedLines) {
      return this.renderedLines;
    }

    const lines: string[] = [];

    const beforeDiff = this.suppressLeadingSpacing
      ? 0
      : this.config.spacing.beforeDiff;
    for (let i = 0; i < beforeDiff; i += 1) {
      lines.push(renderBlankLine(safeWidth, this.palette.editorBg));
    }

    for (let i = 0; i < this.payloads.length; i++) {
      const payload = this.payloads[i]!;
      if (this.showFileHeaders || this.payloads.length > 1) {
        lines.push(renderFileHeader(payload, this.palette, this.config, safeWidth));
      }

      const highlighted = this.highlightedFor(payload)[this.palette.appearance];
      const rows = buildCachedDiffRows(
        payload.metadata,
        highlighted,
        this.palette,
        this.config,
        { expandCollapsed: this.expandCollapsedHunks },
        payloadKey(payload),
      );
      const lineNumberWidth = lineNumberWidthFor(
        payload.metadata,
        this.config.gutter.lineNumberMinWidth,
      );
      for (const row of rows) {
        lines.push(...this.renderRow(row, safeWidth, lineNumberWidth));
      }
    }

    for (let i = 0; i < this.config.spacing.afterDiff; i += 1) {
      lines.push(renderBlankLine(safeWidth, this.palette.editorBg));
    }

    this.renderedKey = renderedKey;
    this.renderedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.clearRenderedCache();
  }

  private clearRenderedCache(): void {
    this.renderedKey = undefined;
    this.renderedLines = undefined;
  }

  private resetLocalCachesAfterPierreReset(): void {
    const generation = globalPiHighlightGeneration();
    if (this.piHighlightGeneration === generation) return;

    this.piHighlightGeneration = generation;
    this.piHighlightedByKey = globalPiHighlightCache();
    this.highlightedByKey.clear();
    this.piHighlightFallbacksByKey.clear();
    this.clearRenderedCache();
    this.ingestHighlightedPayloads();
  }

  private renderCacheKey(width: number): string {
    return [
      width,
      this.showFileHeaders ? "headers" : "no-headers",
      this.expandCollapsedHunks ? "expanded" : "collapsed",
      this.suppressLeadingSpacing ? "tight" : "spaced",
      this.palette.appearance,
      JSON.stringify(this.config),
      ...this.payloads.map(payloadKey),
    ].join("\u0000");
  }

  private renderRow(
    row: DiffRow,
    width: number,
    lineNumberWidth: number,
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
        ),
      ];
    }

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
        visibleWidth,
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
    const stored = this.highlightedByKey.get(key) ?? payload.highlighted;
    if (stored && hasHighlightedLines(stored)) return stored;

    const piKey = [
      key,
      this.config.syntaxHighlight.maxLines,
      this.config.syntaxHighlight.maxLineLength,
    ].join("\u0000");
    let piHighlighted = this.piHighlightedByKey.get(piKey);
    if (piHighlighted && !hasHighlightedLines(piHighlighted)) {
      this.piHighlightedByKey.delete(piKey);
      piHighlighted = undefined;
    }

    if (!piHighlighted) {
      const directHighlighted = buildPiHighlightedDiff(
        payload.metadata,
        this.config,
        this.theme,
      );
      if (hasHighlightedLines(directHighlighted)) {
        piHighlighted = directHighlighted;
        this.piHighlightedByKey.set(piKey, piHighlighted);
        if (this.piHighlightedByKey.size > PI_HIGHLIGHT_CACHE_LIMIT) {
          const oldestKey = this.piHighlightedByKey.keys().next().value;
          if (typeof oldestKey === "string") this.piHighlightedByKey.delete(oldestKey);
        }
      }
    }
    if (piHighlighted && hasHighlightedLines(piHighlighted)) return piHighlighted;

    this.scheduleAsyncHighlightFallback(piKey, payload);

    return emptyHighlightedDiffSet();
  }

  private scheduleAsyncHighlightFallback(
    piKey: string,
    payload: PierreDiffPayload,
  ): void {
    if (this.piHighlightFallbacksByKey.has(piKey)) return;
    this.piHighlightFallbacksByKey.add(piKey);

    void loadHighlightedDiff(payload.metadata, this.config, this.theme)
      .then((highlighted) => {
        if (!hasHighlightedLines(highlighted)) return;
        this.piHighlightedByKey.set(piKey, highlighted);
        this.clearRenderedCache();
        this.invalidateView?.();
      })
      .catch(() => undefined);
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
): string {
  return renderFullWidthLine(
    [
      { text: " ".repeat(config.layout.leftPadding), fg: palette.hunkFg, bg: palette.hunkBg },
      ...hunkLabelSegments(text, palette),
    ],
    width,
    { fg: palette.hunkFg, bg: palette.hunkBg },
  );
}

function hunkLabelSegments(
  text: string,
  palette: PierreTerminalPalette,
): RenderSegment[] {
  const key = "ctrl+o";
  const index = text.toLowerCase().indexOf(key);
  if (index < 0) return [{ text, fg: palette.hunkFg, bg: palette.hunkBg }];

  return [
    { text: text.slice(0, index), fg: palette.hunkFg, bg: palette.hunkBg },
    { text: text.slice(index, index + key.length), fg: palette.hunkKeyFg, bg: palette.hunkBg },
    { text: text.slice(index + key.length), fg: palette.hunkFg, bg: palette.hunkBg },
  ];
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
      formatLineNumber(
        row.lineNumber,
        lineNumberWidth,
        config.gutter.lineNumberAlign,
      ) +
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
    formatLineNumber(
      row.lineNumber,
      lineNumberWidth,
      config.gutter.lineNumberAlign,
    ) +
    " ".repeat(config.gutter.lineNumberPaddingRight);
  const bar = lineBar(row.lineType, config);
  const pad = " ".repeat(config.layout.leftPadding);

  return config.gutter.barPosition === "after-number"
    ? pad + number + config.gutter.separator + bar + config.gutter.barGap
    : pad + bar + config.gutter.barGap + number + config.gutter.separator;
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

function normalizePayloads(
  payloads: PierreDiffPayload | PierreDiffPayload[],
): PierreDiffPayload[] {
  return Array.isArray(payloads) ? payloads : [payloads];
}

function payloadKey(payload: PierreDiffPayload): string {
  const cached = payloadCacheKeys.get(payload.metadata);
  if (cached && cached.path === payload.path) return cached.key;

  if (payload.metadata.cacheKey) {
    payloadCacheKeys.set(payload.metadata, {
      path: payload.path,
      key: payload.metadata.cacheKey,
    });
    return payload.metadata.cacheKey;
  }
  const key = [
    payload.path,
    payload.metadata.name,
    payload.metadata.prevName ?? "",
    payload.metadata.type,
    payload.metadata.lang ?? "",
    payload.metadata.deletionLines.join("\n"),
    payload.metadata.additionLines.join("\n"),
    payload.metadata.hunks.map((hunk) => hunk.hunkSpecs ?? "").join("\n"),
  ].join("\u0000");
  payloadCacheKeys.set(payload.metadata, { path: payload.path, key });
  return key;
}

function formatLineNumber(
  lineNumber: number | undefined,
  width: number,
  align: "left" | "right" = "right",
): string {
  if (lineNumber === undefined) return " ".repeat(width);
  const text = String(lineNumber);
  return align === "left" ? text.padEnd(width, " ") : text.padStart(width, " ");
}

function changeLabel(type: string): string {
  if (type === "new") return "create";
  if (type === "deleted") return "delete";
  if (type.startsWith("rename")) return "move";
  return "update";
}
