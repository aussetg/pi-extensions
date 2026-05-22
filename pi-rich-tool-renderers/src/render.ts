import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import { Image, Text, type Component } from "@earendil-works/pi-tui";
import { PierreInlineDiffComponent } from "../../codex-apply-patch/src/pierre/index.ts";
import { getPierreRendererConfig } from "../../codex-apply-patch/src/pierre/config.ts";
import type { PierreDiffPayload } from "../../codex-apply-patch/src/pierre/types.ts";
import {
  renderCodeFeedbackFromDetails,
  type CodeFeedbackRender,
} from "./code-feedback.ts";
import {
  editPreviewPayload,
  readPreviewPayload,
  writePreviewPayload,
} from "./payloads.ts";
import {
  countLines,
  firstLine,
  imageContent,
  isRecord,
  isToolError,
  plural,
  shortenPathForDisplay,
  textContent,
  type ShellContextLike,
  type ThemeLike,
  type ToolResultLike,
} from "./util.ts";

type RenderOptions = { expanded: boolean; isPartial: boolean };
type FooterPart = CodeFeedbackRender;
const COLLAPSED_MAX_LINES = 10;

export function renderReadCall(args: unknown, theme: ThemeLike, context?: ShellContextLike): Component {
  const path = stringArg(args, "path") ?? "";
  const offset = numberArg(args, "offset");
  const limit = numberArg(args, "limit");

  let out = theme.fg("toolTitle", theme.bold("read"));
  if (path) out += " " + theme.fg("accent", shortenPathForDisplay(path));
  const opts: string[] = [];
  if (offset !== undefined) opts.push(`offset=${offset}`);
  if (limit !== undefined) opts.push(`limit=${limit}`);
  if (opts.length > 0) out += " " + theme.fg("muted", `(${opts.join(", ")})`);
  return new Text(out, 1, 1, toolBackground(theme, context));
}

export function renderWriteCall(args: unknown, theme: ThemeLike, context?: ShellContextLike): Component {
  const path = stringArg(args, "path") ?? "";
  const content = stringArg(args, "content") ?? "";

  let out = theme.fg("toolTitle", theme.bold("write"));
  if (path) out += " " + theme.fg("accent", shortenPathForDisplay(path));
  out += " " + theme.fg("muted", `(${plural(countLines(content), "line")})`);
  return new Text(out, 1, 1, toolBackground(theme, context));
}

export function renderEditCall(args: unknown, theme: ThemeLike, context?: ShellContextLike): Component {
  const path = stringArg(args, "path") ?? "";
  const edits = isRecord(args) && Array.isArray(args.edits) ? args.edits.length : 0;

  let out = theme.fg("toolTitle", theme.bold("edit"));
  if (path) out += " " + theme.fg("accent", shortenPathForDisplay(path));
  if (edits > 1) out += " " + theme.fg("muted", `(${plural(edits, "replacement")})`);
  return new Text(out, 1, 1, toolBackground(theme, context));
}

export function renderReadResult(
  result: ToolResultLike,
  options: RenderOptions,
  theme: ThemeLike,
  context?: ShellContextLike,
): Component {
  if (options.isPartial) return renderText("Reading...", theme, { ...context, isPartial: true }, "pending");

  const image = imageContent(result);
  if (image) return renderImageResult(image, theme, context);

  const text = readDisplayText(result);
  if (text === undefined) return renderText(theme.fg("muted", "(no content)"), theme, context);
  if (isToolError(result, context)) return renderText(theme.fg("error", firstLine(text)), theme, context);

  const path = stringArg(context?.args, "path") ?? "file";
  const startLine = Math.max(1, Math.trunc(numberArg(context?.args, "offset") ?? 1));
  const display = collapseTextForDisplay(text, options.expanded, false);
  const payload = readPreviewPayload({ path, content: display.text, startLine });
  const footer = footerParts([
    display.collapsed ? collapseNotice(display.collapsed, theme, false) : undefined,
    readFooter(result.details, theme),
  ]);
  if (!payload) {
    return renderTextParts(footerParts([theme.fg("toolOutput", display.text), ...footer]), theme, context);
  }

  return renderPierre([payload], footer, false, theme, context, {
    showFileHeaders: false,
  });
}

export function renderWriteResult(
  result: ToolResultLike,
  options: RenderOptions,
  theme: ThemeLike,
  context?: ShellContextLike,
): Component {
  if (options.isPartial) return renderText("Writing...", theme, { ...context, isPartial: true }, "pending");

  const output = textContent(result) ?? "";
  if (isToolError(result, context)) return renderText(theme.fg("error", firstLine(output || "Write failed")), theme, context);

  const path = stringArg(context?.args, "path") ?? "file";
  const content = stringArg(context?.args, "content") ?? "";
  const feedback = renderCodeFeedbackFromDetails(result.details, theme, {
    expanded: options.expanded,
    cwd: context?.cwd,
  });
  const preview = writePreviewPayload({
    toolCallId: context?.toolCallId,
    path,
    content,
    maxDisplayLines: options.expanded ? undefined : COLLAPSED_MAX_LINES,
  });
  const footers = footerParts([
    preview.collapsed ? collapseNotice(preview.collapsed, theme, true) : undefined,
    feedback,
  ]);

  if (preview.payload) {
    return renderPierre([preview.payload], footers, options.expanded, theme, context, {
      showFileHeaders: false,
    });
  }

  const summary = preview.skippedReason
    ? theme.fg("warning", `Preview skipped: ${preview.skippedReason}`)
    : theme.fg("success", preview.existed ? "Written" : "Created");
  return renderTextParts(footerParts([summary, ...footers]), theme, context);
}

export function renderEditResult(
  result: ToolResultLike,
  options: RenderOptions,
  theme: ThemeLike,
  context?: ShellContextLike,
): Component {
  if (options.isPartial) return renderText("Editing...", theme, { ...context, isPartial: true }, "pending");

  const output = textContent(result) ?? "";
  if (isToolError(result, context)) return renderText(theme.fg("error", firstLine(output || "Edit failed")), theme, context);

  const path = stringArg(context?.args, "path") ?? "file";
  const diff = detailsDiff(result.details);
  const feedback = renderCodeFeedbackFromDetails(result.details, theme, {
    expanded: options.expanded,
    cwd: context?.cwd,
  });
  const payload = diff ? editPreviewPayload({ path, diff }) : undefined;

  if (payload) {
    return renderPierre([payload], footerParts([feedback]), options.expanded, theme, context, {
      showFileHeaders: false,
    });
  }

  const summary = diff
    ? theme.fg("warning", "Diff preview unavailable")
    : theme.fg("success", output ? firstLine(output) : "Applied");
  return renderTextParts(footerParts([summary, feedback]), theme, context);
}

class RichTextResultComponent implements Component {
  private parts: FooterPart[] = [];
  private background: ((text: string) => string) | undefined;
  private footerLines = getPierreRendererConfig().spacing.afterDiff;

  constructor(parts: FooterPart[], theme: ThemeLike, context?: ShellContextLike) {
    this.update(parts, theme, context);
  }

  update(parts: FooterPart[], theme: ThemeLike, context?: ShellContextLike): void {
    this.parts = parts;
    this.background = toolBackground(theme, context);
    this.footerLines = getPierreRendererConfig().spacing.afterDiff;
  }

  render(width: number): string[] {
    const lines = renderFooterParts(this.parts, width, this.background);
    for (let i = 0; i < this.footerLines; i += 1) {
      lines.push(backgroundBlankLine(width, this.background));
    }
    return lines;
  }

  invalidate(): void {}
}

class RichPierreResultComponent implements Component {
  private diff: PierreInlineDiffComponent;
  private footerParts: FooterPart[] = [];
  private footerBg: ((text: string) => string) | undefined;

  constructor(
    payloads: PierreDiffPayload[],
    theme: ThemeLike,
    options: PierreRenderOptions,
  ) {
    this.diff = new PierreInlineDiffComponent(payloads, theme, pierreOptions(options));
    this.update(payloads, theme, options);
  }

  update(payloads: PierreDiffPayload[], theme: ThemeLike, options: PierreRenderOptions): void {
    this.diff.update(payloads, theme, pierreOptions(options));
    this.footerParts = options.footerParts;
    this.footerBg = toolBackground(theme, { isPartial: false, isError: false });
  }

  render(width: number): string[] {
    const lines = this.diff.render(width);
    if (this.footerParts.length === 0) return lines;
    return [
      ...lines,
      ...renderFooterParts(this.footerParts, width, this.footerBg, {
        trailingBlank: true,
      }),
    ];
  }

  invalidate(): void {
    this.diff.invalidate();
  }
}

interface PierreRenderOptions {
  expanded: boolean;
  footerParts: FooterPart[];
  invalidate?: () => void;
  showFileHeaders?: boolean;
}

function renderPierre(
  payloads: PierreDiffPayload[],
  footerPartsValue: FooterPart[],
  expanded: boolean,
  theme: ThemeLike,
  context: ShellContextLike | undefined,
  options: { showFileHeaders?: boolean } = {},
): Component {
  const renderOptions: PierreRenderOptions = {
    expanded,
    footerParts: footerPartsValue,
    invalidate: context?.invalidate,
    showFileHeaders: options.showFileHeaders ?? payloads.length > 1,
  };
  const component =
    context?.lastComponent instanceof RichPierreResultComponent
      ? context.lastComponent
      : new RichPierreResultComponent(payloads, theme, renderOptions);
  component.update(payloads, theme, renderOptions);
  return component;
}

function pierreOptions(options: PierreRenderOptions) {
  return {
    showFileHeaders: options.showFileHeaders,
    expandCollapsedHunks: options.expanded,
    suppressLeadingSpacing: true,
    onInvalidate: options.invalidate,
  };
}

function renderText(
  text: string,
  theme: ThemeLike,
  context?: ShellContextLike,
  color?: "pending",
): Component {
  const body = color === "pending" ? theme.fg("warning", text) : text;
  return renderTextParts([body], theme, context);
}

function renderTextParts(
  parts: FooterPart[],
  theme: ThemeLike,
  context?: ShellContextLike,
): Component {
  const component =
    context?.lastComponent instanceof RichTextResultComponent
      ? context.lastComponent
      : new RichTextResultComponent(parts, theme, context);
  component.update(parts, theme, context);
  return component;
}

function renderFooterParts(
  parts: FooterPart[],
  width: number,
  background: ((text: string) => string) | undefined,
  options: { trailingBlank?: boolean } = {},
): string[] {
  const safeWidth = Math.max(1, Math.trunc(width));
  const lines: string[] = [];
  let emitted = false;

  for (const part of parts) {
    const rendered = renderFooterPart(part, safeWidth, background);
    if (rendered.length === 0) continue;
    if (emitted) lines.push(backgroundBlankLine(safeWidth, background));
    lines.push(...rendered);
    emitted = true;
  }

  if (emitted && options.trailingBlank) {
    lines.push(backgroundBlankLine(safeWidth, background));
  }

  return lines;
}

function renderFooterPart(
  part: FooterPart,
  width: number,
  background: ((text: string) => string) | undefined,
): string[] {
  if (typeof part === "string") return new Text(part, 1, 0, background).render(width);

  const contentWidth = Math.max(1, width - 2);
  const content = part.renderContent(contentWidth);
  if (content.length === 0) return [];
  return new Text(content.join("\n"), 1, 0, background).render(width);
}

function footerParts(parts: Array<FooterPart | undefined>): FooterPart[] {
  return parts.filter((part): part is FooterPart =>
    typeof part === "string" ? part.length > 0 : part !== undefined,
  );
}

function collapseTextForDisplay(
  text: string,
  expanded: boolean,
  includeTotal: boolean,
): { text: string; collapsed?: { remaining: number; totalLines?: number } } {
  if (expanded) return { text };

  const lines = trimTrailingEmptyLines(text.split("\n"));
  if (lines.length <= COLLAPSED_MAX_LINES) return { text };

  return {
    text: lines.slice(0, COLLAPSED_MAX_LINES).join("\n"),
    collapsed: {
      remaining: lines.length - COLLAPSED_MAX_LINES,
      totalLines: includeTotal ? lines.length : undefined,
    },
  };
}

function collapseNotice(
  collapsed: { remaining: number; totalLines?: number },
  theme: ThemeLike,
  includeTotal: boolean,
): string {
  const total = includeTotal && collapsed.totalLines !== undefined
    ? ` ${collapsed.totalLines} total,`
    : "";
  return `${theme.fg("muted", `... (${collapsed.remaining} more lines,${total}`)} ${keyHint(
    "app.tools.expand",
    "to expand",
  )})`;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return lines.slice(0, end);
}

function backgroundBlankLine(
  width: number,
  background: ((text: string) => string) | undefined,
): string {
  const blank = persistentBlankLine(width);
  return background ? background(blank) : blank;
}

function renderImageResult(
  image: { data: string; mimeType?: string; mime?: string },
  theme: ThemeLike,
  context?: ShellContextLike,
): Component {
  if (context?.showImages === false) {
    return renderText(theme.fg("success", "Image loaded"), theme, context);
  }
  return new Image(image.data, image.mimeType ?? image.mime ?? "image/png", theme, {
    maxWidthCells: 80,
    maxHeightCells: 24,
  });
}

function toolBackground(theme: ThemeLike, context?: ShellContextLike): ((text: string) => string) | undefined {
  if (!theme.bg) return undefined;
  const color = (context?.isPartial ?? true)
    ? "toolPendingBg"
    : context?.isError
      ? "toolErrorBg"
      : "toolSuccessBg";
  return (text: string) => theme.bg!(color, text);
}

function persistentBlankLine(width: number): string {
  return `\u200b${" ".repeat(Math.max(0, width))}`;
}

function footerText(parts: string[]): string {
  return parts.filter(Boolean).join("\n\n");
}

function stringArg(args: unknown, key: string): string | undefined {
  if (!isRecord(args)) return undefined;
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function numberArg(args: unknown, key: string): number | undefined {
  if (!isRecord(args)) return undefined;
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function detailsDiff(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  const diff = details.diff;
  return typeof diff === "string" && diff.length > 0 ? diff : undefined;
}

function readDisplayText(result: ToolResultLike): string | undefined {
  return textContent(result);
}

function readFooter(details: unknown, theme: ThemeLike): string {
  if (!isRecord(details)) return "";
  const truncation = details.truncation;
  if (!isRecord(truncation)) return "";
  if (truncation.truncated !== true) return "";

  const outputLines = numberField(truncation, "outputLines");
  const totalLines = numberField(truncation, "totalLines");
  const maxBytes = numberField(truncation, "maxBytes") ?? DEFAULT_MAX_BYTES;
  const maxLines = numberField(truncation, "maxLines") ?? DEFAULT_MAX_LINES;

  if (truncation.firstLineExceedsLimit === true) {
    return theme.fg("warning", `[First line exceeds ${formatSize(maxBytes)} limit]`);
  }

  if (truncation.truncatedBy === "lines" && outputLines !== undefined && totalLines !== undefined) {
    return theme.fg(
      "warning",
      `[Truncated: showing ${outputLines} of ${totalLines} lines (${maxLines} line limit)]`,
    );
  }

  if (outputLines !== undefined) {
    return theme.fg(
      "warning",
      `[Truncated: ${outputLines} lines shown (${formatSize(maxBytes)} limit)]`,
    );
  }

  return theme.fg("warning", `[Truncated: ${formatSize(maxBytes)} limit]`);
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
