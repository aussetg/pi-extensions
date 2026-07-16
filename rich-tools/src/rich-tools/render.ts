import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  keyHint,
  keyText,
} from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  getImageDimensions,
  Image,
  imageFallback,
  Text,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { PierreInlineDiffComponent } from "../pierre/index.ts";
import { getPierreRendererConfig } from "../pierre/config.ts";
import type { PierreDiffPayload } from "../pierre/types.ts";
import {
  renderCodeFeedbackFromDetails,
  type CodeFeedbackRender,
} from "../code-feedback.ts";
import {
  editPreviewPayload,
  readPreviewPayload,
  writePreviewPayload,
} from "./payloads.ts";
import {
  reconcileInlineImageComponents,
  type InlineReadImage,
  type InlineReadImageComponent,
} from "./read-image-cache.ts";
import {
  compactReadClassification,
  countLines,
  firstLine,
  isRecord,
  isToolError,
  type ImageContentLike,
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
const ANSI_ESCAPE_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const suppressedDefaultReadImageArrays = new WeakMap<unknown[], unknown[]>();

export function renderReadCall(args: unknown, theme: ThemeLike, context?: ShellContextLike): Component {
  const classification = !context?.expanded ? compactReadClassification(args, context?.cwd) : undefined;
  if (classification) {
    return new Text(formatCompactReadCall(classification, args, theme), 1, 1, toolBackground(theme, context));
  }

  return new Text(formatReadCall(args, theme), 1, 1, toolBackground(theme, context));
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

  const text = readDisplayText(result, context?.showImages ?? true);
  if (text === undefined) return renderText(theme.fg("muted", "(no content)"), theme, context);
  if (isToolError(result, context)) return renderText(theme.fg("error", firstLine(text)), theme, context);

  const plainOutput = shouldRenderReadAsPlainOutput(result, text, context?.args);
  if (!options.expanded && !plainOutput && compactReadClassification(context?.args, context?.cwd)) {
    return renderTextParts([], theme, context);
  }

  if (plainOutput) {
    const display = collapseTextForDisplay(text, options.expanded, false);
    const footer = footerParts([
      display.collapsed ? collapseNotice(display.collapsed, theme, false) : undefined,
      readFooter(result.details, theme),
    ]);
    const parts = footerParts([
      display.text ? theme.fg("toolOutput", display.text) : undefined,
      ...footer,
    ]);
    const inlineImages = readInlineImages(result, context?.showImages ?? true);
    if (inlineImages.length > 0) {
      suppressDefaultReadImageRendering(result.content);
      return renderReadImageParts(parts, inlineImages, theme, context);
    }
    return renderTextParts(parts, theme, context);
  }

  const renderPath = renderStringArg(context?.args, "file_path", "path");
  const path = renderPath && renderPath !== null ? renderPath : "file";
  const startLine = Math.max(1, Math.trunc(numberArg(context?.args, "offset") ?? 1));
  const payload = readPreviewPayload({ path, content: text, startLine });
  const footer = footerParts([readFooter(result.details, theme)]);
  if (!payload) {
    const display = collapseTextForDisplay(text, options.expanded, false);
    return renderTextParts(footerParts([
      theme.fg("toolOutput", display.text),
      display.collapsed ? collapseNotice(display.collapsed, theme, false) : undefined,
      ...footer,
    ]), theme, context);
  }

  return renderReadPierre([payload], footer, options.expanded, theme, context, {
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
    : theme.fg("success", preview.existed === false ? "Created" : "Written");
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
    if (lines.length === 0) return lines;
    if (!footerPartAttachesToPrevious(this.parts.at(-1))) {
      for (let i = 0; i < this.footerLines; i += 1) {
        lines.push(backgroundBlankLine(width, this.background));
      }
    }
    return lines;
  }

  invalidate(): void {}
}

class RichReadImageResultComponent implements Component {
  private parts: FooterPart[] = [];
  private imageComponents: InlineReadImageComponent[] = [];
  private background: ((text: string) => string) | undefined;
  private footerLines = getPierreRendererConfig().spacing.afterDiff;
  private theme: ThemeLike;

  constructor(
    parts: FooterPart[],
    images: InlineReadImage[],
    theme: ThemeLike,
    context?: ShellContextLike,
  ) {
    this.theme = theme;
    this.update(parts, images, theme, context);
  }

  update(
    parts: FooterPart[],
    images: InlineReadImage[],
    theme: ThemeLike,
    context?: ShellContextLike,
  ): void {
    const themeChanged = this.theme !== theme;
    this.theme = theme;
    this.parts = parts;
    this.background = toolBackground(theme, context);
    this.footerLines = getPierreRendererConfig().spacing.afterDiff;
    this.imageComponents = reconcileInlineImageComponents(
      this.imageComponents,
      images,
      (image) => ({
        ...image,
        component: new Image(
          image.data,
          image.mimeType,
          { fallbackColor: (text: string) => this.theme.fg("toolOutput", text) },
          { maxWidthCells: 60 },
        ),
      }),
    );

    if (themeChanged) {
      for (const image of this.imageComponents) image.component.invalidate();
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.trunc(width));
    const lines = renderFooterParts(this.parts, safeWidth, this.background);
    if (this.imageComponents.length === 0) return lines;

    if (lines.length > 0) {
      lines.push(backgroundBlankLine(safeWidth, this.background));
    }

    const imageWidth = Math.max(1, safeWidth - 2);
    for (let i = 0; i < this.imageComponents.length; i += 1) {
      const imageLines = this.imageComponents[i]!.component.render(imageWidth);
      for (const line of imageLines) {
        lines.push(paintInlineImageLine(line, safeWidth, this.background));
      }
      if (i < this.imageComponents.length - 1) {
        lines.push(backgroundBlankLine(safeWidth, this.background));
      }
    }

    for (let i = 0; i < this.footerLines; i += 1) {
      lines.push(backgroundBlankLine(safeWidth, this.background));
    }
    return lines;
  }

  invalidate(): void {
    for (const image of this.imageComponents) image.component.invalidate();
  }
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

class RichReadPierreResultComponent implements Component {
  private diff: PierreInlineDiffComponent;
  private footerParts: FooterPart[] = [];
  private footerBg: ((text: string) => string) | undefined;
  private expanded = false;
  private theme: ThemeLike;

  constructor(
    payloads: PierreDiffPayload[],
    theme: ThemeLike,
    options: PierreRenderOptions,
  ) {
    this.theme = theme;
    this.diff = new PierreInlineDiffComponent(payloads, theme, pierreOptions(options));
    this.update(payloads, theme, options);
  }

  update(payloads: PierreDiffPayload[], theme: ThemeLike, options: PierreRenderOptions): void {
    this.theme = theme;
    this.expanded = options.expanded;
    this.diff.update(payloads, theme, pierreOptions(options));
    this.footerParts = options.footerParts;
    this.footerBg = toolBackground(theme, { isPartial: false, isError: false });
  }

  render(width: number): string[] {
    const rendered = this.expanded
      ? { lines: this.diff.render(width), omittedLines: 0 }
      : this.diff.renderLimited(width, COLLAPSED_MAX_LINES);
    const footerPartsValue = footerParts([
      rendered.omittedLines > 0
        ? collapseNotice({ remaining: rendered.omittedLines }, this.theme, false)
        : undefined,
      ...this.footerParts,
    ]);
    if (footerPartsValue.length === 0) return rendered.lines;
    return [
      ...rendered.lines,
      ...renderFooterParts(footerPartsValue, width, this.footerBg, {
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

function renderReadPierre(
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
    context?.lastComponent instanceof RichReadPierreResultComponent
      ? context.lastComponent
      : new RichReadPierreResultComponent(payloads, theme, renderOptions);
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

function renderReadImageParts(
  parts: FooterPart[],
  images: InlineReadImage[],
  theme: ThemeLike,
  context?: ShellContextLike,
): Component {
  const component =
    context?.lastComponent instanceof RichReadImageResultComponent
      ? context.lastComponent
      : new RichReadImageResultComponent(parts, images, theme, context);
  component.update(parts, images, theme, context);
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
  let lastPartAttached = false;

  for (const part of parts) {
    const rendered = renderFooterPart(part, safeWidth, background);
    if (rendered.length === 0) continue;
    const attached = footerPartAttachesToPrevious(part);
    if (emitted && !attached) {
      lines.push(backgroundBlankLine(safeWidth, background));
    }
    lines.push(...rendered);
    emitted = true;
    lastPartAttached = attached;
  }

  if (emitted && options.trailingBlank && !lastPartAttached) {
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
  return part.render(width, background);
}

function footerPartAttachesToPrevious(part: FooterPart | undefined): boolean {
  return typeof part !== "string" && part?.attachesToPrevious === true;
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

function renderStringArg(args: unknown, ...keys: string[]): string | null {
  if (!isRecord(args)) return "";
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return value;
    if (value !== undefined && value !== null) return null;
  }
  return "";
}

function formatReadLineRange(args: unknown, theme: ThemeLike): string {
  const offset = numberArg(args, "offset");
  const limit = numberArg(args, "limit");
  if (offset === undefined && limit === undefined) return "";

  const startLine = offset ?? 1;
  const endLine = limit !== undefined ? startLine + limit - 1 : "";
  return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

function formatReadCall(args: unknown, theme: ThemeLike): string {
  const rawPath = renderStringArg(args, "file_path", "path");
  const path = rawPath !== null ? shortenPathForDisplay(rawPath) : null;
  const pathDisplay = path === null
    ? theme.fg("error", "[invalid arg]")
    : path
      ? theme.fg("accent", path)
      : theme.fg("toolOutput", "...");
  return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}${formatReadLineRange(args, theme)}`;
}

function formatCompactReadCall(
  classification: { kind: "docs" | "resource" | "skill"; label: string },
  args: unknown,
  theme: ThemeLike,
): string {
  const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
  if (classification.kind === "skill") {
    return (
      theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
      theme.fg("customMessageText", classification.label) +
      formatReadLineRange(args, theme) +
      expandHint
    );
  }

  return (
    theme.fg("toolTitle", theme.bold(`read ${classification.kind}`)) +
    " " +
    theme.fg("accent", classification.label) +
    formatReadLineRange(args, theme) +
    expandHint
  );
}

function detailsDiff(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  const diff = details.diff;
  return typeof diff === "string" && diff.length > 0 ? diff : undefined;
}

function readDisplayText(result: ToolResultLike, showImages: boolean): string | undefined {
  const content = result.content;
  if (!Array.isArray(content)) return undefined;

  const textBlocks: string[] = [];
  const imageBlocks: Array<{ data?: string; mimeType?: string; mime?: string }> = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string") {
      textBlocks.push(stripAnsi(item.text).replace(/\r/g, ""));
    } else if (item.type === "image") {
      imageBlocks.push(item);
    }
  }

  const parts = [...textBlocks];
  const capabilities = getCapabilities();
  if (imageBlocks.length > 0 && (!capabilities.images || !showImages)) {
    // ToolExecutionComponent owns actual image rendering. Keep the text stream
    // aligned with the default read renderer when inline images are disabled or
    // unavailable in the current terminal.
    parts.push(...imageBlocks.map((image) => {
      const mimeType = image.mimeType ?? image.mime ?? "image/unknown";
      const dimensions = image.data ? getImageDimensions(image.data, mimeType) ?? undefined : undefined;
      return imageFallback(mimeType, dimensions);
    }));
  }

  const output = parts.join("\n");
  return output.length > 0 ? output : "";
}

function shouldRenderReadAsPlainOutput(
  result: ToolResultLike,
  text: string,
  args: unknown,
): boolean {
  // Image reads return a small status text plus an image attachment. Pierre's
  // gutter is useful for real file content, but turns that status line into the
  // `1    Read image file ...` row. Keep image-read status text in the
  // default/plain read style; ToolExecutionComponent renders the image block.
  if (hasImageBlock(result)) return true;

  const path = renderStringArg(args, "file_path", "path");
  return (
    path !== null &&
    looksLikeSupportedImagePath(path) &&
    /^Read image file \[image\/[\w.+-]+\]/i.test(firstLine(text, ""))
  );
}

function readInlineImages(result: ToolResultLike, showImages: boolean): InlineReadImage[] {
  if (!showImages) return [];

  const capabilities = getCapabilities();
  if (!capabilities.images) return [];

  return imageBlocks(result).flatMap((image) => {
    const mimeType = image.mimeType ?? image.mime;
    if (!mimeType) return [];

    // Pi's default ToolExecutionComponent converts non-PNGs for Kitty. We do
    // not have that internal converter here, so only take over images this
    // renderer can hand to Image directly. Non-PNG Kitty images stay on Pi's
    // default path rather than disappearing.
    if (capabilities.images === "kitty" && mimeType !== "image/png") return [];

    return [{ data: image.data, mimeType }];
  });
}

function imageBlocks(result: ToolResultLike): ImageContentLike[] {
  const content = result.content;
  if (!Array.isArray(content)) return [];

  return content.filter((item): item is ImageContentLike =>
    isRecord(item) && item.type === "image" && typeof item.data === "string"
  );
}

function hasImageBlock(result: ToolResultLike): boolean {
  return imageBlocks(result).length > 0;
}

function looksLikeSupportedImagePath(rawPath: string): boolean {
  return /\.(?:png|jpe?g|gif|webp)$/i.test(rawPath);
}

function suppressDefaultReadImageRendering(content: unknown): void {
  if (!Array.isArray(content)) return;
  if (suppressedDefaultReadImageArrays.has(content)) return;
  if (!content.some((item) => isRecord(item) && item.type === "image")) return;

  // ToolExecutionComponent appends image blocks after renderResult(), outside
  // the custom tool shell. When we render the image inside the read result,
  // hide those blocks for that one synchronous UI pass, then restore them so
  // the stored/tool-result content still carries the model attachment.
  const original = [...content];
  const withoutImages = content.filter((item) => !(isRecord(item) && item.type === "image"));
  suppressedDefaultReadImageArrays.set(content, original);
  content.splice(0, content.length, ...withoutImages);

  queueMicrotask(() => {
    const saved = suppressedDefaultReadImageArrays.get(content);
    if (!saved) return;
    suppressedDefaultReadImageArrays.delete(content);

    const unchanged = content.length === withoutImages.length &&
      content.every((item, index) => item === withoutImages[index]);
    if (unchanged) content.splice(0, content.length, ...saved);
  });
}

function paintInlineImageLine(
  line: string,
  width: number,
  background: ((text: string) => string) | undefined,
): string {
  if (!background) return line;

  const padded = ` ${line}`;
  const pad = Math.max(0, width - safeVisibleWidth(padded));
  return background(`${padded}${" ".repeat(pad)}`);
}

function safeVisibleWidth(text: string): number {
  try {
    return visibleWidth(text);
  } catch {
    return text.length;
  }
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_REGEX, "");
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
