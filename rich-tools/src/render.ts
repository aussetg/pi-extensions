import { Text, type Component } from "@earendil-works/pi-tui";
import {
  renderCodeFeedbackFromDetails,
  type CodeFeedbackRender,
} from "./code-feedback.ts";
import type {
  ApplyPatchDetails,
  ApplyPatchFileChange,
  ApplyPatchOperation,
  ApplyPatchOpType,
  ApplyPatchResultEntry,
} from "./types.ts";
import { prepareApplyPatchArguments } from "./patch-envelope.ts";
import { firstChangedLineFromDiff } from "./diff-lines.ts";
import { PierreInlineDiffComponent } from "./pierre/component.ts";
import { getPierreRendererConfig } from "./pierre/config.ts";
import {
  buildPierreCreatePayload,
  buildPierreDeletePayload,
  buildPierreUnifiedPatchPayload,
} from "./pierre/metadata.ts";
import type { PierreDiffPayload } from "./pierre/types.ts";
import { shortenPathForDisplay, validatePatchPath } from "./util.ts";

// UI helpers for rendering tool arguments/results without flooding the TUI.

// Pull and normalize operations from tool args for call/result rendering.
interface RenderOperation {
  type: ApplyPatchOpType;
  path: string;
  movePath?: string;
  diff?: string;
}

function parseRenderOperations(args: unknown): RenderOperation[] {
  const ops = (args as { operations?: unknown })?.operations;
  if (!Array.isArray(ops)) return [];

  const out: RenderOperation[] = [];
  for (const o of ops) {
    if (!o || typeof o !== "object") continue;
    const type = (o as { type?: unknown }).type;
    if (
      type !== "create_file" &&
      type !== "update_file" &&
      type !== "delete_file"
    )
      continue;

    const pathValue = (o as { path?: unknown }).path;
    if (typeof pathValue !== "string") continue;

    let opPath = pathValue;
    try {
      opPath = validatePatchPath(pathValue);
    } catch {
      // keep raw value for display
    }

    let movePath: string | undefined;
    const moveValue = (o as { move_path?: unknown }).move_path;
    if (typeof moveValue === "string") {
      movePath = moveValue;
      try {
        movePath = validatePatchPath(moveValue);
      } catch {
        // keep raw value for display
      }
    }

    const diff =
      typeof (o as { diff?: unknown }).diff === "string"
        ? (o as { diff: string }).diff
        : undefined;
    out.push({ type, path: opPath, movePath, diff });
  }

  return out;
}

// Summarize tool args for a native-like compact header.
function summarizeOperationsArgs(args: unknown): {
  operationCount: number;
  headerPath?: string;
  headerLine?: number;
} {
  const ops = parseRenderOperations(args);
  if (ops.length === 0) return { operationCount: 0 };

  if (ops.length > 1) return { operationCount: ops.length };

  const op = ops[0]!;
  const headerPath = shortenPathForDisplay(op.path);
  if (
    op.type === "update_file" &&
    typeof op.diff === "string" &&
    op.diff.length > 0 &&
    op.diff.length <= MAX_RENDER_PATCH_PARSE_BYTES &&
    Buffer.byteLength(op.diff, "utf8") <= MAX_RENDER_PATCH_PARSE_BYTES
  ) {
    return {
      operationCount: 1,
      headerPath,
      headerLine: firstChangedLineFromDiff(op.diff),
    };
  }

  return { operationCount: 1, headerPath };
}

function oversizedPatchText(args: unknown): { bytes: number } | undefined {
  const text = patchTextFromArgs(args);
  if (!text) return undefined;
  const bytes = Buffer.byteLength(text, "utf8");
  return bytes > MAX_RENDER_PATCH_PARSE_BYTES ? { bytes } : undefined;
}

function patchTextFromArgs(args: unknown): string | undefined {
  if (typeof args === "string") return args;
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["patch", "input", "diff", "text", "operations"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib >= 10 ? kib.toFixed(0) : kib.toFixed(1)} KiB`;
  const mib = kib / 1024;
  return `${mib >= 10 ? mib.toFixed(0) : mib.toFixed(1)} MiB`;
}

function opLabel(type: ApplyPatchOpType): "create" | "update" | "delete" {
  return type === "create_file"
    ? "create"
    : type === "update_file"
      ? "update"
      : "delete";
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let output = "";
  for (const c of content) {
    if (
      c &&
      typeof c === "object" &&
      (c as { type?: unknown }).type === "text"
    ) {
      const t = (c as { text?: unknown }).text;
      if (typeof t === "string" && t) output += (output ? "\n" : "") + t;
    }
  }
  return output;
}

function withResultSpacing(text: string): string {
  // Vertical spacing around tool output is owned by renderApplyPatchCall()
  // above the result and by ApplyPatchTextResultComponent/Pierre below it.
  return text;
}

function renderOperationLine(
  entry: { type: ApplyPatchOpType; path: string; output?: string },
  theme: { fg: (color: string, text: string) => string },
): string {
  const label = opLabel(entry.type);
  const head = `${theme.fg("warning", `${label}:`)} ${theme.fg("accent", shortenPathForDisplay(entry.path))}`;
  if (!entry.output) return head;
  return `${head} ${theme.fg("muted", `— ${entry.output}`)}`;
}

function renderOperationStatusLine(
  entry: ApplyPatchResultEntry,
  theme: { fg: (color: string, text: string) => string },
): string {
  const completed = entry.status === "completed";
  const label = opLabel(entry.type);
  const marker = theme.fg(
    completed ? "success" : "error",
    completed ? "✓" : "✗",
  );
  const labelColor = completed ? "warning" : "error";
  const head = `${marker} ${theme.fg(labelColor, `${label}:`)} ${theme.fg(
    "accent",
    shortenPathForDisplay(entry.path),
  )}`;
  if (!entry.output) return head;
  return `${head} ${theme.fg(
    completed ? "muted" : "error",
    `— ${entry.output}`,
  )}`;
}

export function collectProgressPreview(
  ops: ApplyPatchOperation[],
): { path?: string; diff?: string } | undefined {
  for (const op of ops) {
    if (op.type !== "update_file") continue;
    if (typeof op.diff !== "string" || op.diff.length === 0) continue;
    return { path: shortenPathForDisplay(op.path) };
  }
  return undefined;
}

type ThemeLike = {
  name?: string;
  fg: (color: string, text: string) => string;
  bg?: (color: string, text: string) => string;
  bold: (text: string) => string;
};

type ShellContextLike = {
  isPartial?: boolean;
  isError?: boolean;
  lastComponent?: unknown;
  invalidate?: () => void;
  cwd?: string;
};

function toolBackground(
  theme: ThemeLike,
  context?: ShellContextLike,
): ((text: string) => string) | undefined {
  if (!theme.bg) return undefined;
  const color = (context?.isPartial ?? true)
    ? "toolPendingBg"
    : context?.isError
      ? "toolErrorBg"
      : "toolSuccessBg";
  return (text: string) => theme.bg!(color, text);
}

class ApplyPatchTextResultComponent implements Component {
  private parts: ResultPart[];
  private background: ((text: string) => string) | undefined;
  private footerLines: number;

  constructor(
    parts: ResultPart[] | string,
    theme: ThemeLike,
    context?: ShellContextLike,
  ) {
    this.parts = typeof parts === "string" ? [parts] : parts;
    this.background = toolBackground(theme, context);
    this.footerLines = getPierreRendererConfig().spacing.afterDiff;
  }

  render(width: number): string[] {
    const lines = renderResultParts(this.parts, width, this.background);
    if (!resultPartAttachesToPrevious(this.parts.at(-1))) {
      for (let i = 0; i < this.footerLines; i += 1) {
        lines.push(backgroundBlankLine(width, this.background));
      }
    }
    return lines;
  }

  invalidate(): void {}
}

function persistentBlankLine(width: number): string {
  return `\u200b${" ".repeat(Math.max(0, width))}`;
}

const MAX_RENDER_PATCH_PARSE_BYTES = 1_000_000;

const changePayloadCache = new WeakMap<ApplyPatchFileChange, PierreDiffPayload | null>();
const resultPayloadPartitionCache = new WeakMap<
  ApplyPatchResultEntry[],
  ApplyPatchResultPayloadPartition
>();

interface ApplyPatchResultPayloadPartition {
  completed: ApplyPatchResultEntry[];
  payloads: PierreDiffPayload[];
  unpreviewed: ApplyPatchResultEntry[];
}

function partitionResultPayloads(
  results: ApplyPatchResultEntry[],
): ApplyPatchResultPayloadPartition {
  const cached = resultPayloadPartitionCache.get(results);
  if (cached) return cached;

  const completed: ApplyPatchResultEntry[] = [];
  const payloads: PierreDiffPayload[] = [];
  const unpreviewed: ApplyPatchResultEntry[] = [];

  for (const entry of results) {
    if (entry.status !== "completed") continue;
    completed.push(entry);

    const payload = getPierreResultPayload(entry);
    if (payload) payloads.push(payload);
    else unpreviewed.push(entry);
  }

  const partition = { completed, payloads, unpreviewed };
  resultPayloadPartitionCache.set(results, partition);
  return partition;
}

function getPierreResultPayload(
  entry: ApplyPatchResultEntry,
): PierreDiffPayload | undefined {
  const change = entry.change;
  if (!isApplyPatchFileChange(change)) return undefined;

  const cached = changePayloadCache.get(change);
  if (cached !== undefined) return cached ?? undefined;

  const payload = buildPierrePayloadFromChange(entry, change);
  changePayloadCache.set(change, payload ?? null);
  return payload;
}

function buildPierrePayloadFromChange(
  entry: ApplyPatchResultEntry,
  change: ApplyPatchFileChange,
): PierreDiffPayload | undefined {
  const displayPath = shortenPathForDisplay(entry.path);
  switch (change.type) {
    case "add":
      return buildPierreCreatePayload({
        path: displayPath,
        newContent: change.content,
      });
    case "delete":
      return buildPierreDeletePayload({
        path: displayPath,
        oldContent: change.content,
      });
    case "update":
      if (!hasUnifiedDiffHunks(change.unifiedDiff)) return undefined;
      return buildPierreUnifiedPatchPayload({
        path: displayPath,
        unifiedDiff: change.unifiedDiff,
      });
  }
}

function hasUnifiedDiffHunks(diff: string): boolean {
  return /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/m.test(diff);
}

class ApplyPatchPierreResultComponent implements Component {
  private diff: PierreInlineDiffComponent;
  private payloads: PierreDiffPayload[];
  private theme: ThemeLike;
  private expanded: boolean;
  private invalidateView: (() => void) | undefined;
  private footerParts: ResultPart[] = [];
  private footerBg: ((text: string) => string) | undefined;
  private renderedWidth: number | undefined;
  private renderedLines: string[] | undefined;

  constructor(
    payloads: PierreDiffPayload[],
    theme: ThemeLike,
    options: {
      footerParts: ResultPart[];
      expanded: boolean;
      invalidate?: () => void;
    },
  ) {
    this.payloads = payloads;
    this.theme = theme;
    this.expanded = options.expanded;
    this.invalidateView = options.invalidate;
    this.footerParts = options.footerParts;
    this.footerBg = toolBackground(theme, { isPartial: false, isError: false });
    this.diff = new PierreInlineDiffComponent(
      this.payloads,
      theme,
      this.diffOptions(this.payloads),
    );
  }

  update(
    payloads: PierreDiffPayload[],
    theme: ThemeLike,
    options: {
      footerParts: ResultPart[];
      expanded: boolean;
      invalidate?: () => void;
    },
  ): void {
    const themeSame = this.theme === theme;
    const payloadsSame = sameArrayItems(this.payloads, payloads);
    const footerSame = sameArrayItems(this.footerParts, options.footerParts);
    const diffSame =
      payloadsSame &&
      themeSame &&
      this.expanded === options.expanded;

    this.invalidateView = options.invalidate;

    if (diffSame && footerSame) return;

    this.theme = theme;
    this.expanded = options.expanded;

    if (!diffSame) {
      this.payloads = payloads;
      this.diff.update(this.payloads, theme, this.diffOptions(this.payloads));
    }

    this.footerParts = options.footerParts;
    if (!themeSame) {
      this.footerBg = toolBackground(theme, {
        isPartial: false,
        isError: false,
      });
    }
    this.clearRenderedCache();
  }

  render(width: number): string[] {
    if (this.renderedWidth === width && this.renderedLines) return this.renderedLines;

    const lines = this.diff.render(width);
    if (this.footerParts.length === 0) {
      this.renderedWidth = width;
      this.renderedLines = lines;
      return lines;
    }

    const rendered = [
      ...lines,
      ...renderResultParts(this.footerParts, width, this.footerBg, {
        trailingBlank: true,
      }),
    ];
    this.renderedWidth = width;
    this.renderedLines = rendered;
    return rendered;
  }

  invalidate(): void {
    this.diff.invalidate();
    this.clearRenderedCache();
  }

  private clearRenderedCache(): void {
    this.renderedWidth = undefined;
    this.renderedLines = undefined;
  }

  private diffOptions(payloads: PierreDiffPayload[]) {
    return {
      showFileHeaders: payloads.length > 1,
      expandCollapsedHunks: this.expanded,
      suppressLeadingSpacing: true,
      onInvalidate: () => {
        this.clearRenderedCache();
        this.invalidateView?.();
      },
    };
  }
}

function renderPierrePayloads(
  payloads: PierreDiffPayload[],
  footerParts: ResultPart[],
  expanded: boolean,
  theme: ThemeLike,
  context?: ShellContextLike,
): Component | undefined {
  if (payloads.length === 0) return undefined;

  const options = {
    footerParts,
    expanded,
    invalidate: context?.invalidate,
  };
  const component =
    context?.lastComponent instanceof ApplyPatchPierreResultComponent
      ? context.lastComponent
      : new ApplyPatchPierreResultComponent(payloads, theme, options);
  component.update(payloads, theme, options);
  return component;
}

function sameArrayItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isApplyPatchFileChange(value: unknown): value is ApplyPatchFileChange {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ApplyPatchFileChange>;
  if (record.type === "add" || record.type === "delete") {
    return typeof record.content === "string";
  }
  if (record.type === "update") {
    return typeof record.unifiedDiff === "string";
  }
  return false;
}

function resultParts(parts: Array<ResultPart | undefined>): ResultPart[] {
  return parts.filter((part): part is ResultPart =>
    typeof part === "string" ? part.length > 0 : part !== undefined,
  );
}

function renderResultParts(
  parts: ResultPart[],
  width: number,
  background: ((text: string) => string) | undefined,
  options: { trailingBlank?: boolean } = {},
): string[] {
  const safeWidth = Math.max(1, Math.trunc(width));
  const lines: string[] = [];
  let emitted = false;
  let lastPartAttached = false;

  for (const part of parts) {
    const rendered = renderResultPart(part, safeWidth, background);
    if (rendered.length === 0) continue;
    const attached = resultPartAttachesToPrevious(part);
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

function renderResultPart(
  part: ResultPart,
  width: number,
  background: ((text: string) => string) | undefined,
): string[] {
  if (typeof part === "string") return new Text(part, 1, 0, background).render(width);
  return part.render(width, background);
}

function resultPartAttachesToPrevious(part: ResultPart | undefined): boolean {
  return typeof part !== "string" && part?.attachesToPrevious === true;
}

function backgroundBlankLine(
  width: number,
  background: ((text: string) => string) | undefined,
): string {
  const blank = persistentBlankLine(width);
  return background ? background(blank) : blank;
}

type ResultPart = CodeFeedbackRender;

function summarizeUnpreviewedResults(
  results: ApplyPatchResultEntry[],
  theme: ThemeLike,
): string {
  if (results.length === 0) return "";
  return results.map((r) => renderOperationLine(r, theme)).join("\n");
}

export function renderApplyPatchCall(
  args: unknown,
  theme: ThemeLike,
  context?: ShellContextLike,
) {
  let out = theme.fg("toolTitle", theme.bold("apply_patch"));
  try {
    const oversized = oversizedPatchText(args);
    if (oversized) {
      out += " " + theme.fg("muted", `(large patch, ${formatByteSize(oversized.bytes)})`);
      return new Text(out, 1, 1, toolBackground(theme, context));
    }

    const renderArgs = prepareApplyPatchArguments(args, { recordRepairs: false });
    const { operationCount, headerPath, headerLine } =
      summarizeOperationsArgs(renderArgs);
    if (headerPath) {
      out += " " + theme.fg("accent", headerPath);
      if (typeof headerLine === "number")
        out += theme.fg("warning", `:${headerLine}`);
    } else if (operationCount > 0)
      out +=
        " " +
        theme.fg(
          "muted",
          `(${operationCount} operation${operationCount === 1 ? "" : "s"})`,
        );
    else out += " " + theme.fg("muted", "(waiting for operations)");
  } catch {
    // Keep renderer resilient; fallback to just tool title.
  }
  return new Text(out, 1, 1, toolBackground(theme, context));
}

export function renderApplyPatchResult(
  result: { content: unknown; details?: unknown },
  { expanded, isPartial }: { expanded: boolean; isPartial: boolean },
  theme: ThemeLike,
  context?: ShellContextLike,
) {
  const renderText = (parts: ResultPart[] | string) =>
    new ApplyPatchTextResultComponent(parts, theme, {
      ...context,
      isPartial,
    });

  const details = result.details as ApplyPatchDetails | undefined;
  if (isPartial) {
    const msg =
      details?.stage === "progress" ? details.message : "Working...";
    let out = theme.fg("warning", msg);
    if (details?.stage === "progress" && details.previewPath) {
      out += "\n" + theme.fg("muted", details.previewPath);
    }
    return renderText(withResultSpacing(out));
  }

  if (details?.stage === "done") {
    const codeFeedback = renderCodeFeedbackFromDetails(details, theme, {
      expanded,
      cwd: context?.cwd,
    });
    const warnings = details.warnings ?? [];
    const warningsText =
      warnings.length > 0
        ? warnings.map((w) => theme.fg("warning", w)).join("\n")
        : "";
    const withFeedback = (text: string): ResultPart[] =>
      resultParts([text, warningsText, codeFeedback]);

    const failed = details.results.filter((r) => r.status === "failed");
    if (failed.length === 0) {
      const resultPayloads = partitionResultPayloads(details.results);
      if (resultPayloads.payloads.length === 0) {
        const completed = resultPayloads.completed;
        if (completed.length > 0) {
          const out = completed
            .map((r) => renderOperationLine(r, theme))
            .join("\n");
          return renderText(withFeedback(out));
        }

        const output = textFromContent(result.content);
        if (!output) {
          const feedback = withFeedback("");
          if (feedback.length === 0) return renderText(withResultSpacing(theme.fg("muted", "(no output)")));
          return renderText(feedback);
        }
        return renderText(withFeedback(theme.fg("toolOutput", output)));
      }

      const pierre = renderPierrePayloads(
        resultPayloads.payloads,
        resultParts([
          summarizeUnpreviewedResults(resultPayloads.unpreviewed, theme),
          warningsText,
          codeFeedback,
        ]),
        expanded,
        theme,
        context,
      );
      if (pierre) return pierre;

      const completed = details.results.filter(
        (r) => r.status === "completed",
      );
      const out = completed
        .map((r) => renderOperationLine(r, theme))
        .join("\n");
      return renderText(withFeedback(out));
    }

    const resultPayloads = partitionResultPayloads(details.results);
    const failureText = failed
      .map((r) => renderOperationStatusLine(r, theme))
      .join("\n");
    if (resultPayloads.payloads.length > 0) {
      const pierre = renderPierrePayloads(
        resultPayloads.payloads,
        resultParts([
          summarizeUnpreviewedResults(resultPayloads.unpreviewed, theme),
          failureText,
          warningsText,
          codeFeedback,
        ]),
        expanded,
        theme,
        context,
      );
      if (pierre) return pierre;
    }

    const out = details.results
      .map((r) => renderOperationStatusLine(r, theme))
      .join("\n");
    return renderText(withFeedback(out));
  }

  // Fallback
  const output = textFromContent(result.content);
  if (!output)
    return renderText(withResultSpacing(theme.fg("muted", "(no output)")));
  if (!details)
    return renderText(withResultSpacing(theme.fg("error", output)));
  return renderText(withResultSpacing(theme.fg("toolOutput", output)));
}
