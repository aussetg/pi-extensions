import { Text, type Component } from "@mariozechner/pi-tui";
import type {
  ApplyPatchDetails,
  ApplyPatchOperation,
  ApplyPatchOpType,
  ApplyPatchPreview,
} from "./types.ts";
import type { ApplyOperationResult } from "./apply.ts";
import { prepareApplyPatchArguments } from "./codex-envelope.ts";
import { firstChangedLineFromDiff } from "./diff-lines.ts";
import { PierreInlineDiffComponent } from "./pierre/component.ts";
import { getPierreRendererConfig } from "./pierre/config.ts";
import { buildPierreNumberedDiffPayload } from "./pierre/metadata.ts";
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
    op.diff.length > 0
  ) {
    return {
      operationCount: 1,
      headerPath,
      headerLine: firstChangedLineFromDiff(op.diff),
    };
  }

  return { operationCount: 1, headerPath };
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
  return text ? `\n${text}` : text;
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

export function collectSuccessPreviews(
  results: ApplyOperationResult[],
): ApplyPatchPreview[] {
  const previews: ApplyPatchPreview[] = [];
  for (const res of results) {
    if (res.status !== "completed") continue;
    if (!hasResultPreview(res)) continue;
    previews.push({
      path: shortenPathForDisplay(res.path),
      diff: res.diff ?? "",
      firstChangedLine: res.firstChangedLine,
      pierre: res.pierre,
    });
  }
  return previews;
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
  private text: string;
  private background: ((text: string) => string) | undefined;
  private footerLines: number;

  constructor(
    text: string,
    theme: ThemeLike,
    context?: ShellContextLike,
  ) {
    this.text = text;
    this.background = toolBackground(theme, context);
    this.footerLines = getPierreRendererConfig().spacing.afterDiff;
  }

  render(width: number): string[] {
    const lines = new Text(this.text, 1, 0, this.background).render(width);
    for (let i = 0; i < this.footerLines; i += 1) {
      const blank = persistentBlankLine(width);
      lines.push(this.background ? this.background(blank) : blank);
    }
    return lines;
  }

  invalidate(): void {}
}

function persistentBlankLine(width: number): string {
  return `\u200b${" ".repeat(Math.max(0, width))}`;
}

const DEGRADED_PIERRE_CACHE_LIMIT = 128;
const degradedPierreCache = new Map<string, PierreDiffPayload | null>();

function degradedPierreCacheKey(preview: ApplyPatchPreview): string {
  return `${preview.path}\u0000${preview.diff}`;
}

function getPierrePreviewPayload(
  preview: ApplyPatchPreview,
): PierreDiffPayload | undefined {
  if (isPierreDiffPayload(preview.pierre)) return preview.pierre;
  if (!preview.diff) return undefined;

  const key = degradedPierreCacheKey(preview);
  const cached = degradedPierreCache.get(key);
  if (cached !== undefined) return cached ?? undefined;

  const payload = buildPierreNumberedDiffPayload({
    path: preview.path,
    diff: preview.diff,
  });
  degradedPierreCache.set(key, payload ?? null);
  if (degradedPierreCache.size > DEGRADED_PIERRE_CACHE_LIMIT) {
    const oldestKey = degradedPierreCache.keys().next().value;
    if (typeof oldestKey === "string") degradedPierreCache.delete(oldestKey);
  }

  return payload;
}

class ApplyPatchPierreResultComponent implements Component {
  private diff: PierreInlineDiffComponent;
  private footerText = "";
  private footerBg: ((text: string) => string) | undefined;

  constructor(
    payloads: PierreDiffPayload[],
    theme: ThemeLike,
    options: {
      maxVisibleLines: number;
      footerText: string;
      expanded: boolean;
      invalidate?: () => void;
    },
  ) {
    this.diff = new PierreInlineDiffComponent(payloads, theme, {
      maxVisibleLines: options.maxVisibleLines,
      showFileHeaders: payloads.length > 1,
      expandCollapsedHunks: options.expanded,
      onInvalidate: options.invalidate,
    });
    this.update(payloads, theme, options);
  }

  update(
    payloads: PierreDiffPayload[],
    theme: ThemeLike,
    options: {
      maxVisibleLines: number;
      footerText: string;
      expanded: boolean;
      invalidate?: () => void;
    },
  ): void {
    this.diff.update(payloads, theme, {
      maxVisibleLines: options.maxVisibleLines,
      showFileHeaders: payloads.length > 1,
      expandCollapsedHunks: options.expanded,
      onInvalidate: options.invalidate,
    });
    this.footerText = options.footerText;
    this.footerBg = toolBackground(theme, { isPartial: false, isError: false });
  }

  render(width: number): string[] {
    const lines = this.diff.render(width);
    if (!this.footerText) return lines;

    const footer = new Text(`\n${this.footerText}\n`, 1, 0, this.footerBg);
    return [...lines, ...footer.render(width)];
  }

  invalidate(): void {
    this.diff.invalidate();
  }
}

function renderPierrePreviews(
  previews: ApplyPatchPreview[],
  footerText: string,
  expanded: boolean,
  theme: ThemeLike,
  context?: ShellContextLike,
): Component | undefined {
  const payloads = previews.map(getPierrePreviewPayload).filter(isPierreDiffPayload);
  if (payloads.length === 0 || payloads.length !== previews.length) return undefined;

  const options = {
    maxVisibleLines: maxPierreVisibleLines(expanded),
    footerText,
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

function maxPierreVisibleLines(expanded: boolean): number {
  const config = getPierreRendererConfig();
  const rows = typeof process.stdout.rows === "number" ? process.stdout.rows : 40;
  const expandedLimit = Math.max(
    10,
    Math.floor(rows * config.layout.expandedMaxVisibleRatio),
  );
  return expanded
    ? expandedLimit
    : Math.min(expandedLimit, config.layout.maxVisibleLines);
}

function isPierreDiffPayload(value: unknown): value is PierreDiffPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PierreDiffPayload>;
  return (
    typeof candidate.path === "string" &&
    !!candidate.metadata &&
    typeof candidate.metadata === "object" &&
    Array.isArray(candidate.metadata.hunks) &&
    Array.isArray(candidate.metadata.deletionLines) &&
    Array.isArray(candidate.metadata.additionLines)
  );
}

function hasNumberedDiffPreview(
  entry: { type: ApplyPatchOpType; status: "completed" | "failed"; diff?: string },
): boolean {
  return (
    entry.status === "completed" &&
    entry.type === "update_file" &&
    typeof entry.diff === "string" &&
    entry.diff.length > 0
  );
}

function hasResultPreview(
  entry: {
    type: ApplyPatchOpType;
    status: "completed" | "failed";
    diff?: string;
    pierre?: unknown;
  },
): boolean {
  return isPierreDiffPayload(entry.pierre) || hasNumberedDiffPreview(entry);
}

function footerText(parts: string[]): string {
  return parts.filter(Boolean).join("\n\n");
}

function summarizeUnpreviewedResults(
  results: Array<{
    type: ApplyPatchOpType;
    path: string;
    status: "completed" | "failed";
    output?: string;
    diff?: string;
    pierre?: unknown;
  }>,
  theme: ThemeLike,
): string {
  const unpreviewed = results.filter((r) => {
    if (r.status !== "completed") return false;
    return !hasResultPreview(r);
  });
  if (unpreviewed.length === 0) return "";
  return unpreviewed.map((r) => renderOperationLine(r, theme)).join("\n");
}

export function renderApplyPatchCall(
  args: unknown,
  theme: ThemeLike,
  context?: ShellContextLike,
) {
  let out = theme.fg("toolTitle", theme.bold("apply_patch"));
  try {
    const renderArgs = prepareApplyPatchArguments(args);
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
  const renderText = (text: string) =>
    new ApplyPatchTextResultComponent(`${text}\n`, theme, {
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
    const warnings = details.warnings ?? [];
    const warningsText =
      warnings.length > 0
        ? warnings.map((w) => theme.fg("warning", w)).join("\n")
        : "";
    const withWarnings = (text: string): string => {
      if (!warningsText) return text;
      if (!text) return warningsText;
      return `${text}\n\n${warningsText}`;
    };

    const failed = details.results.filter((r) => r.status === "failed");
    if (failed.length === 0) {
      const previews =
        details.previews ??
        collectSuccessPreviews(details.results as ApplyOperationResult[]);
      if (previews.length === 0) {
        const completed = details.results.filter(
          (r) => r.status === "completed",
        );
        if (completed.length > 0) {
          const out = completed
            .map((r) => renderOperationLine(r, theme))
            .join("\n");
          return renderText(withResultSpacing(withWarnings(out)));
        }

        const output = textFromContent(result.content);
        if (!output) {
          if (!warningsText) return renderText(withResultSpacing(theme.fg("muted", "(no output)")));
          return renderText(withResultSpacing(warningsText));
        }
        return renderText(withResultSpacing(withWarnings(theme.fg("toolOutput", output))));
      }

      const pierre = renderPierrePreviews(
        previews,
        footerText([
          summarizeUnpreviewedResults(details.results, theme),
          warningsText,
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
      return renderText(withResultSpacing(withWarnings(out)));
    }

    const out = failed
      .map((r) => {
        return theme.fg("error", r.output ?? "Operation failed");
      })
      .join("\n\n");
    return renderText(withResultSpacing(withWarnings(out)));
  }

  // Fallback
  const output = textFromContent(result.content);
  if (!output)
    return renderText(withResultSpacing(theme.fg("muted", "(no output)")));
  if (!details)
    return renderText(withResultSpacing(theme.fg("error", output)));
  return renderText(withResultSpacing(theme.fg("toolOutput", output)));
}
