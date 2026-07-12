import type { Component } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
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
  cleanDiffLine,
  hasHighlightedLines,
  loadHighlightedDiff,
} from "./highlight.ts";
import {
  cachedPiHighlight,
  forgetPiHighlight,
  globalPiHighlightGeneration,
  rememberPiHighlight,
} from "./highlight-cache.ts";
import { hashStringPart, hashUnknown } from "../hash.ts";
import {
  buildCachedDiffRows,
  buildContextDiffRow,
  lineNumberWidthFor,
} from "./rows.ts";
import {
  fileDiffMetadataKeyParts,
  type FileDiffMetadataKeyParts,
} from "./metadata-hash.ts";
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

interface RenderSegment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}

type PierrePayloadDigest = FileDiffMetadataKeyParts & {
  payloadKey: string;
};

type PreparedPierrePayload = {
  payload: PierreDiffPayload;
  digest: PierrePayloadDigest;
};

export interface PierreInlineDiffOptions {
  showFileHeaders?: boolean;
  expandCollapsedHunks?: boolean;
  suppressLeadingSpacing?: boolean;
  onInvalidate?: () => void;
}

export interface PierreLimitedRenderResult {
  lines: string[];
  omittedLines: number;
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
  private preparedPayloads: PreparedPierrePayload[];
  private payloadsKey: string;
  private theme: PiThemeLike;
  private themeName: string | undefined;
  private config: PierreRendererConfig;
  private palette: PierreTerminalPalette;
  private showFileHeaders: boolean;
  private explicitShowFileHeaders: boolean | undefined;
  private expandCollapsedHunks: boolean;
  private suppressLeadingSpacing: boolean;
  private invalidateView: (() => void) | undefined;
  private highlightedByKey = new Map<string, HighlightedDiffSet>();
  private piHighlightFallbacksByKey = new Set<string>();
  private piHighlightGeneration = globalPiHighlightGeneration();
  private renderedKey: string | undefined;
  private renderedResult: PierreLimitedRenderResult | undefined;

  constructor(
    payloads: PierreDiffPayload | PierreDiffPayload[],
    theme: PiThemeLike,
    options: PierreInlineDiffOptions = {},
  ) {
    this.payloads = normalizePayloads(payloads);
    freezePayloadsForRender(this.payloads);
    this.theme = theme;
    this.themeName = theme.name;
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
    this.preparedPayloads = this.payloads.map(preparePayload);
    this.payloadsKey = preparedPayloadsKey(this.preparedPayloads);
    this.ingestHighlightedPayloads();
  }

  update(
    payloads: PierreDiffPayload | PierreDiffPayload[],
    theme: PiThemeLike,
    options: PierreInlineDiffOptions = {},
  ): void {
    const nextPayloads = normalizePayloads(payloads);
    const nextConfig = getPierreRendererConfig();
    const nextExpanded = Boolean(options.expandCollapsedHunks);
    const nextSuppressSpacing = Boolean(options.suppressLeadingSpacing);
    const payloadsSame = samePayloadRefs(this.payloads, nextPayloads);
    const renderInputsSame =
      payloadsSame &&
      this.theme === theme &&
      this.themeName === theme.name &&
      this.config === nextConfig &&
      this.explicitShowFileHeaders === options.showFileHeaders &&
      this.expandCollapsedHunks === nextExpanded &&
      this.suppressLeadingSpacing === nextSuppressSpacing;

    this.invalidateView = options.onInvalidate;

    if (renderInputsSame) return;

    this.payloads = nextPayloads;
    freezePayloadsForRender(this.payloads);
    this.theme = theme;
    this.themeName = theme.name;
    this.explicitShowFileHeaders = options.showFileHeaders;
    this.expandCollapsedHunks = nextExpanded;
    this.suppressLeadingSpacing = nextSuppressSpacing;
    this.config = nextConfig;
    this.palette = getPierrePalette(theme, this.config);
    this.showFileHeaders = resolveShowFileHeaders(
      this.config,
      options.showFileHeaders,
      this.payloads.length,
    );
    if (!payloadsSame) {
      this.preparedPayloads = this.payloads.map(preparePayload);
      this.payloadsKey = preparedPayloadsKey(this.preparedPayloads);
    }
    this.ingestHighlightedPayloads();
    this.clearRenderedCache();
  }

  render(width: number): string[] {
    return this.renderResult(width).lines;
  }

  renderLimited(width: number, maxContentLines: number): PierreLimitedRenderResult {
    const limit = Math.max(0, Math.trunc(maxContentLines));
    return this.renderResult(width, limit);
  }

  private renderResult(
    width: number,
    maxContentLines?: number,
  ): PierreLimitedRenderResult {
    this.resetLocalCachesAfterPierreReset();
    const currentConfig = getPierreRendererConfig();
    if (currentConfig !== this.config) {
      this.config = currentConfig;
      this.palette = getPierrePalette(this.theme, this.config);
      this.showFileHeaders = resolveShowFileHeaders(
        this.config,
        this.explicitShowFileHeaders,
        this.payloads.length,
      );
      this.clearRenderedCache();
    }
    const safeWidth = normalizeRenderWidth(width);
    const renderedKey = this.renderCacheKey(safeWidth, maxContentLines);
    if (this.renderedKey === renderedKey && this.renderedResult) {
      return this.renderedResult;
    }

    if (maxContentLines !== undefined) {
      const limited = this.renderContextOnlyLimited(safeWidth, maxContentLines);
      if (limited) {
        this.renderedKey = renderedKey;
        this.renderedResult = limited;
        return limited;
      }
    }

    const lines: string[] = [];

    const beforeDiff = this.suppressLeadingSpacing
      ? 0
      : this.config.spacing.beforeDiff;
    for (let i = 0; i < beforeDiff; i += 1) {
      lines.push(renderBlankLine(safeWidth, this.palette.editorBg));
    }

    for (const prepared of this.preparedPayloads) {
      const { payload, digest } = prepared;
      if (this.showFileHeaders || this.payloads.length > 1) {
        lines.push(renderFileHeader(payload, this.palette, this.config, safeWidth));
      }

      const highlighted = this.highlightedFor(prepared)[this.palette.appearance];
      const rows = buildCachedDiffRows(
        payload.metadata,
        highlighted,
        this.palette,
        this.config,
        { expandCollapsed: this.expandCollapsedHunks },
        digest.payloadKey,
        {
          metadataContentKey: digest.contentKey,
          metadataHunksKey: digest.hunksKey,
        },
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

    let result: PierreLimitedRenderResult = { lines, omittedLines: 0 };
    if (maxContentLines !== undefined) {
      const trailingBlankCount = Math.min(
        Math.max(0, this.config.spacing.afterDiff),
        lines.length,
      );
      const contentEnd = lines.length - trailingBlankCount;
      if (contentEnd > maxContentLines) {
        result = {
          lines: [
            ...lines.slice(0, maxContentLines),
            ...lines.slice(contentEnd),
          ],
          omittedLines: contentEnd - maxContentLines,
        };
      }
    }

    this.renderedKey = renderedKey;
    this.renderedResult = result;
    return result;
  }

  invalidate(): void {
    this.clearRenderedCache();
  }

  private clearRenderedCache(): void {
    this.renderedKey = undefined;
    this.renderedResult = undefined;
  }

  private resetLocalCachesAfterPierreReset(): void {
    const generation = globalPiHighlightGeneration();
    if (this.piHighlightGeneration === generation) return;

    this.piHighlightGeneration = generation;
    this.highlightedByKey.clear();
    this.piHighlightFallbacksByKey.clear();
    this.clearRenderedCache();
    this.ingestHighlightedPayloads();
  }

  private renderCacheKey(
    width: number,
    maxContentLines?: number,
  ): string {
    return [
      width,
      maxContentLines === undefined ? "full" : `limit:${maxContentLines}`,
      this.showFileHeaders ? "headers" : "no-headers",
      this.expandCollapsedHunks ? "expanded" : "collapsed",
      this.suppressLeadingSpacing ? "tight" : "spaced",
      this.palette.appearance,
      rendererConfigKey(this.config),
      this.payloadsKey,
    ].join("\u0000");
  }

  private renderContextOnlyLimited(
    width: number,
    maxContentLines: number,
  ): PierreLimitedRenderResult | undefined {
    const ranges = this.preparedPayloads.map((prepared) =>
      contextOnlyRange(prepared.payload.metadata)
    );
    if (ranges.some((range) => range === undefined)) return undefined;

    const lines: string[] = [];
    let totalContentLines = 0;

    const emitFixedLine = (render: () => string): void => {
      if (totalContentLines < maxContentLines) lines.push(render());
      totalContentLines += 1;
    };

    const beforeDiff = this.suppressLeadingSpacing
      ? 0
      : this.config.spacing.beforeDiff;
    for (let i = 0; i < beforeDiff; i += 1) {
      emitFixedLine(() => renderBlankLine(width, this.palette.editorBg));
    }

    for (
      let payloadIndex = 0;
      payloadIndex < this.preparedPayloads.length;
      payloadIndex += 1
    ) {
      const prepared = this.preparedPayloads[payloadIndex]!;
      const range = ranges[payloadIndex]!;
      const { payload } = prepared;

      if (this.showFileHeaders || this.payloads.length > 1) {
        emitFixedLine(() => renderFileHeader(payload, this.palette, this.config, width));
      }

      const lineNumberWidth = lineNumberWidthFor(
        payload.metadata,
        this.config.gutter.lineNumberMinWidth,
      );
      const sampleRow = buildContextDiffRow(
        payload.metadata,
        emptyHighlightedDiffSet()[this.palette.appearance],
        this.palette,
        range.startIndex,
        range.startLineNumber,
      );
      const contentWidth = Math.max(
        8,
        width - visibleWidth(linePrefixText(sampleRow, lineNumberWidth, this.config)),
      );

      let payloadContentLines = 0;
      let sourceRowsToRender = 0;
      for (let offset = 0; offset < range.count; offset += 1) {
        const index = range.startIndex + offset;
        const rawLine = cleanDiffLine(
          payload.metadata.additionLines[index] ?? payload.metadata.deletionLines[index],
        );
        const wrappedLineCount = wrappedPlainLineCount(rawLine, contentWidth);
        if (totalContentLines + payloadContentLines < maxContentLines) {
          sourceRowsToRender = offset + 1;
        }
        payloadContentLines += wrappedLineCount;
      }

      const highlighted = sourceRowsToRender > 0
        ? this.highlightedForContextPrefix(prepared, range, sourceRowsToRender)
        : emptyHighlightedDiffSet()[this.palette.appearance];
      for (let offset = 0; offset < sourceRowsToRender; offset += 1) {
        const available = Math.max(0, maxContentLines - lines.length);
        if (available === 0) break;
        const row = buildContextDiffRow(
          payload.metadata,
          highlighted,
          this.palette,
          range.startIndex + offset,
          range.startLineNumber + offset,
        );
        const rendered = this.renderRow(row, width, lineNumberWidth);
        lines.push(...rendered.slice(0, available));
      }

      totalContentLines += payloadContentLines;
    }

    for (let i = 0; i < this.config.spacing.afterDiff; i += 1) {
      lines.push(renderBlankLine(width, this.palette.editorBg));
    }

    return {
      lines,
      omittedLines: Math.max(0, totalContentLines - maxContentLines),
    };
  }

  private highlightedForContextPrefix(
    prepared: PreparedPierrePayload,
    range: ContextOnlyRange,
    sourceRowCount: number,
  ): HighlightedDiffSet["dark"] {
    if (sourceRowCount >= range.count) {
      return this.highlightedFor(prepared)[this.palette.appearance];
    }
    if (!this.config.syntaxHighlight.enabled) {
      return emptyHighlightedDiffSet()[this.palette.appearance];
    }

    const stored = prepared.payload.highlighted;
    if (stored && hasHighlightedLines(stored)) return stored[this.palette.appearance];

    const piKey = [
      prepared.digest.payloadKey,
      `context-prefix:${sourceRowCount}`,
      this.config.syntaxHighlight.maxLines,
      this.config.syntaxHighlight.maxLineLength,
    ].join("\u0000");
    const cached = cachedPiHighlight(piKey);
    if (cached && hasHighlightedLines(cached)) return cached[this.palette.appearance];

    this.scheduleAsyncHighlightFallback(
      piKey,
      contextPrefixPayload(prepared.payload, range, sourceRowCount),
    );
    return emptyHighlightedDiffSet()[this.palette.appearance];
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

  private highlightedFor(prepared: PreparedPierrePayload): HighlightedDiffSet {
    if (!this.config.syntaxHighlight.enabled) return emptyHighlightedDiffSet();

    const { payload, digest } = prepared;
    const key = digest.payloadKey;
    const stored = this.highlightedByKey.get(key) ?? payload.highlighted;
    if (stored && hasHighlightedLines(stored)) return stored;

    const piKey = [
      key,
      this.config.syntaxHighlight.maxLines,
      this.config.syntaxHighlight.maxLineLength,
    ].join("\u0000");
    let piHighlighted = cachedPiHighlight(piKey);
    if (piHighlighted && !hasHighlightedLines(piHighlighted)) {
      forgetPiHighlight(piKey);
      piHighlighted = undefined;
    }

    if (piHighlighted && hasHighlightedLines(piHighlighted)) {
      return piHighlighted;
    }

    this.scheduleAsyncHighlightFallback(piKey, payload);

    return emptyHighlightedDiffSet();
  }

  private scheduleAsyncHighlightFallback(
    piKey: string,
    payload: PierreDiffPayload,
  ): void {
    if (this.piHighlightFallbacksByKey.has(piKey)) return;
    this.piHighlightFallbacksByKey.add(piKey);

    void loadHighlightedDiff(payload.metadata, this.config, this.theme, piKey)
      .then((highlighted) => {
        if (!hasHighlightedLines(highlighted)) return;
        rememberPiHighlight(piKey, highlighted);
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

type ContextOnlyRange = {
  startIndex: number;
  startLineNumber: number;
  count: number;
};

function contextOnlyRange(
  metadata: PierreDiffPayload["metadata"],
): ContextOnlyRange | undefined {
  if (metadata.hunks.length !== 1 || !metadata.isPartial) return undefined;
  const hunk = metadata.hunks[0]!;
  if (
    hunk.collapsedBefore !== 0 ||
    hunk.additionLineIndex !== 0 ||
    hunk.deletionLineIndex !== 0 ||
    hunk.noEOFCRDeletions ||
    hunk.noEOFCRAdditions ||
    hunk.hunkContent.length !== 1
  ) {
    return undefined;
  }

  const content = hunk.hunkContent[0]!;
  if (content.type !== "context" || content.lines <= 0) return undefined;
  return {
    startIndex: Math.max(0, hunk.additionLineIndex),
    startLineNumber: Math.max(1, hunk.additionStart),
    count: content.lines,
  };
}

function contextPrefixPayload(
  payload: PierreDiffPayload,
  range: ContextOnlyRange,
  sourceRowCount: number,
): PierreDiffPayload {
  const count = Math.max(1, Math.min(range.count, sourceRowCount));
  const metadata = payload.metadata;
  const hunk = metadata.hunks[0]!;
  const content = hunk.hunkContent[0]!;
  if (content.type !== "context") return payload;
  const additionLines = metadata.additionLines.slice(0, count);
  const deletionLines = metadata.deletionLines.slice(0, count);
  return {
    path: payload.path,
    metadata: {
      ...metadata,
      additionLines,
      deletionLines,
      splitLineCount: count,
      unifiedLineCount: count,
      cacheKey: `${metadata.cacheKey ?? payload.path}:context-prefix:${count}`,
      hunks: [{
        ...hunk,
        additionCount: count,
        deletionCount: count,
        splitLineCount: count,
        unifiedLineCount: count,
        hunkContent: [{ ...content, lines: count }],
      }],
    },
  };
}

const plainGraphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});
const CJK_BREAK_REGEX = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;

function wrappedPlainLineCount(text: string, width: number): number {
  if (!text || visibleWidth(text) <= width) return 1;

  let wrappedLines = 0;
  let currentWidth = 0;
  let hasCurrent = false;
  let tokenKind: "space" | "word" | undefined;
  let tokenWidth = 0;
  let tokenWhitespace = true;
  let tokenGraphemeWidths: number[] = [];

  const flushToken = (): void => {
    if (tokenKind === undefined) return;

    if (tokenWidth > width && !tokenWhitespace) {
      if (hasCurrent) {
        wrappedLines += 1;
        currentWidth = 0;
        hasCurrent = false;
      }
      for (const graphemeWidth of tokenGraphemeWidths) {
        if (hasCurrent && currentWidth + graphemeWidth > width) {
          wrappedLines += 1;
          currentWidth = 0;
          hasCurrent = false;
        }
        currentWidth += graphemeWidth;
        hasCurrent = true;
      }
    } else if (hasCurrent && currentWidth + tokenWidth > width) {
      wrappedLines += 1;
      if (tokenWhitespace) {
        currentWidth = 0;
        hasCurrent = false;
      } else {
        currentWidth = tokenWidth;
        hasCurrent = true;
      }
    } else {
      currentWidth += tokenWidth;
      hasCurrent = true;
    }

    tokenKind = undefined;
    tokenWidth = 0;
    tokenWhitespace = true;
    tokenGraphemeWidths = [];
  };

  for (const { segment } of plainGraphemeSegmenter.segment(text)) {
    const segmentWidth = visibleWidth(segment);
    if (segment !== " " && CJK_BREAK_REGEX.test(segment)) {
      flushToken();
      tokenKind = "word";
      tokenWidth = segmentWidth;
      tokenWhitespace = segment.trim() === "";
      tokenGraphemeWidths.push(segmentWidth);
      flushToken();
      continue;
    }

    const nextKind = segment === " " ? "space" : "word";
    if (tokenKind !== undefined && tokenKind !== nextKind) flushToken();
    tokenKind = nextKind;
    tokenWidth += segmentWidth;
    tokenWhitespace &&= segment.trim() === "";
    tokenGraphemeWidths.push(segmentWidth);
  }

  flushToken();
  return Math.max(1, wrappedLines + (hasCurrent ? 1 : 0));
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
  const safeWidth = normalizeRenderWidth(width);
  const rendered = renderSegments(segments, base);
  return padRenderedLine(truncateToWidth(rendered, safeWidth), safeWidth, base);
}

function padRenderedLine(
  line: string,
  width: number,
  base: { fg?: string; bg?: string; bold?: boolean },
): string {
  const safeWidth = normalizeRenderWidth(width);
  const clipped =
    visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, "") : line;
  const padding = Math.max(0, safeWidth - visibleWidth(clipped));
  return `${clipped}${openAnsi(base)}${" ".repeat(padding)}${ANSI_RESET}`;
}

function normalizeRenderWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(1, Math.trunc(width)) : 1;
}

function normalizePayloads(
  payloads: PierreDiffPayload | PierreDiffPayload[],
): PierreDiffPayload[] {
  return Array.isArray(payloads) ? [...payloads] : [payloads];
}

const frozenRenderPayloads = new WeakSet<object>();

function freezePayloadsForRender(payloads: readonly PierreDiffPayload[]): void {
  for (const payload of payloads) deepFreezeRenderPayload(payload, new WeakSet());
}

function deepFreezeRenderPayload(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== "object") return;
  if (frozenRenderPayloads.has(value)) return;
  if (seen.has(value)) return;
  seen.add(value);

  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreezeRenderPayload((value as Record<string, unknown>)[key], seen);
  }

  Object.freeze(value);
  frozenRenderPayloads.add(value);
}

function samePayloadRefs(
  a: readonly PierreDiffPayload[],
  b: readonly PierreDiffPayload[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function payloadKey(payload: PierreDiffPayload): string {
  return payloadDigest(payload).payloadKey;
}

function preparedPayloadsKey(payloads: readonly PreparedPierrePayload[]): string {
  return payloads.map((prepared) => prepared.digest.payloadKey).join("\u0000");
}

const rendererConfigKeyCache = new WeakMap<PierreRendererConfig, string>();

function rendererConfigKey(config: PierreRendererConfig): string {
  const cached = rendererConfigKeyCache.get(config);
  if (cached) return cached;

  const hash = createHash("sha256");
  hashUnknown(hash, config);
  const key = `cfg:${hash.digest("hex").slice(0, 16)}`;
  rendererConfigKeyCache.set(config, key);
  return key;
}

function preparePayload(payload: PierreDiffPayload): PreparedPierrePayload {
  return { payload, digest: payloadDigest(payload) };
}

function payloadDigest(payload: PierreDiffPayload): PierrePayloadDigest {
  const { contentKey, hunksKey } = fileDiffMetadataKeyParts(payload.metadata);
  const hash = createHash("sha256");
  hashStringPart(hash, payload.path);
  hashStringPart(hash, payload.metadata.cacheKey ?? "");
  hashStringPart(hash, contentKey);
  hashStringPart(hash, hunksKey);
  return {
    contentKey,
    hunksKey,
    payloadKey: `payload:${hash.digest("hex").slice(0, 24)}`,
  };
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
