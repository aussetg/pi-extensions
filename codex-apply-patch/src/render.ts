import { Text, type Component } from "@earendil-works/pi-tui";
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
      footerText: string;
      expanded: boolean;
      invalidate?: () => void;
    },
  ) {
    this.diff = new PierreInlineDiffComponent(payloads, theme, {
      showFileHeaders: payloads.length > 1,
      expandCollapsedHunks: options.expanded,
      suppressLeadingSpacing: true,
      onInvalidate: options.invalidate,
    });
    this.update(payloads, theme, options);
  }

  update(
    payloads: PierreDiffPayload[],
    theme: ThemeLike,
    options: {
      footerText: string;
      expanded: boolean;
      invalidate?: () => void;
    },
  ): void {
    this.diff.update(payloads, theme, {
      showFileHeaders: payloads.length > 1,
      expandCollapsedHunks: options.expanded,
      suppressLeadingSpacing: true,
      onInvalidate: options.invalidate,
    });
    this.footerText = options.footerText;
    this.footerBg = toolBackground(theme, { isPartial: false, isError: false });
  }

  render(width: number): string[] {
    const lines = this.diff.render(width);
    if (!this.footerText) return lines;

    const footer = new Text(`${this.footerText}\n`, 1, 0, this.footerBg);
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

const CODE_FEEDBACK_DETAILS_KEY = "piCodeFeedback";

type CodeFeedbackSeverity = "error" | "warning" | "information" | "hint";

type CodeFeedbackRecord = Record<string, unknown>;

interface CodeFeedbackToolDetailsInput {
  inlineText?: string;
  edits: CodeFeedbackEditInput[];
}

interface CodeFeedbackEditInput {
  displayPath?: string;
  filePath?: string;
  formatter?: CodeFeedbackRecord;
  diagnostics?: CodeFeedbackRecord;
}

interface CodeFeedbackDiagnosticEntry {
  severity: CodeFeedbackSeverity;
  location: string;
  sourceCode?: string;
  message: string;
  linkReason?: string;
}

function readCodeFeedback(
  details: unknown,
): CodeFeedbackToolDetailsInput | undefined {
  if (!isRecord(details)) return undefined;
  const value = details[CODE_FEEDBACK_DETAILS_KEY];
  if (!isRecord(value)) return undefined;

  const inlineText = stringProp(value, "inlineText");
  const edits = Array.isArray(value.edits)
    ? value.edits.map(readCodeFeedbackEdit).filter(isPresent)
    : [];
  if (edits.length === 0 && !inlineText) return undefined;
  return { inlineText, edits };
}

function readCodeFeedbackEdit(
  value: unknown,
): CodeFeedbackEditInput | undefined {
  if (!isRecord(value)) return undefined;
  return {
    displayPath: stringProp(value, "displayPath"),
    filePath: stringProp(value, "filePath"),
    formatter: recordProp(value, "formatter"),
    diagnostics: recordProp(value, "diagnostics"),
  };
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isRecord(value: unknown): value is CodeFeedbackRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function recordProp(
  record: CodeFeedbackRecord,
  key: string,
): CodeFeedbackRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function stringProp(
  record: CodeFeedbackRecord,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberProp(
  record: CodeFeedbackRecord | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanProp(
  record: CodeFeedbackRecord | undefined,
  key: string,
): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayProp(
  record: CodeFeedbackRecord | undefined,
  key: string,
): string[] {
  const value = record?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function severityFromValue(value: unknown): CodeFeedbackSeverity | undefined {
  return value === "error" ||
    value === "warning" ||
    value === "information" ||
    value === "hint"
    ? value
    : undefined;
}

function renderCodeFeedbackFromDetails(
  details: unknown,
  theme: ThemeLike,
  options: { expanded: boolean; cwd?: string },
): string {
  const feedback = readCodeFeedback(details);
  if (!feedback) return "";

  const lines = renderStructuredCodeFeedback(feedback, theme, options);
  if (lines.length > 0) return lines.join("\n");

  return feedback.inlineText
    ? theme.fg("toolOutput", feedback.inlineText)
    : "";
}

function renderStructuredCodeFeedback(
  feedback: CodeFeedbackToolDetailsInput,
  theme: ThemeLike,
  options: { expanded: boolean; cwd?: string },
): string[] {
  const diagnostics = collectCodeFeedbackDiagnostics(
    feedback.edits,
    options.cwd,
  );
  const formatterLines = renderCodeFeedbackFormatterLines(
    feedback.edits,
    theme,
    options,
  );
  if (diagnostics.length === 0 && formatterLines.length === 0) return [];

  const severityCounts = countCodeFeedbackSeverities(diagnostics);
  const formatterSummary = summarizeCodeFeedbackFormatters(feedback.edits);
  const hidden = summarizeCodeFeedbackHiddenDiagnostics(feedback.edits);
  const summaryParts = [
    diagnostics.length > 0
      ? formatCodeFeedbackSeverityCounts(severityCounts, theme)
      : "",
    formatterSummary ? theme.fg(formatterSummary.color, formatterSummary.text) : "",
    hidden ? theme.fg("muted", hidden) : "",
  ].filter(Boolean);

  const summary = summaryParts.join(theme.fg("muted", " · "));
  const header = `${theme.fg("warning", theme.bold("code feedback"))}${
    summary ? ` ${theme.fg("muted", "·")} ${summary}` : ""
  }`;

  const lines = [header, ...formatterLines];
  for (const diagnostic of diagnostics) {
    lines.push(...renderCodeFeedbackDiagnostic(diagnostic, theme, options));
  }
  return renderCodeFeedbackPanel(lines, theme);
}

function renderCodeFeedbackPanel(
  lines: string[],
  theme: ThemeLike,
): string[] {
  if (lines.length === 0) return [];
  const border = (text: string) => theme.fg("muted", text);
  const content = [
    lines[0]!,
    ...lines.slice(1).map((line) => line.replace(/^  /, "")),
  ];
  const contentWidth = Math.max(
    1,
    ...content.map((line) => visibleAnsiWidth(line)),
  );
  const horizontal = "─".repeat(contentWidth + 2);
  return [
    border(`╭${horizontal}╮`),
    ...content.map((line) => {
      const padding = " ".repeat(
        Math.max(0, contentWidth - visibleAnsiWidth(line)),
      );
      return `${border("│")} ${line}${padding} ${border("│")}`;
    }),
    border(`╰${horizontal}╯`),
  ];
}

function visibleAnsiWidth(text: string): number {
  // Good enough for our mostly-ASCII diagnostic text; keeps ANSI styling from
  // throwing off the box padding.
  return [...text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")].length;
}

function collectCodeFeedbackDiagnostics(
  edits: CodeFeedbackEditInput[],
  cwd?: string,
): CodeFeedbackDiagnosticEntry[] {
  const entries: CodeFeedbackDiagnosticEntry[] = [];
  for (const edit of edits) {
    const linked = edit.diagnostics?.linked;
    if (!Array.isArray(linked)) continue;
    for (const item of linked) {
      const entry = readCodeFeedbackDiagnosticEntry(edit, item, cwd);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

function readCodeFeedbackDiagnosticEntry(
  edit: CodeFeedbackEditInput,
  linked: unknown,
  cwd?: string,
): CodeFeedbackDiagnosticEntry | undefined {
  if (!isRecord(linked)) return undefined;
  const diagnostic = recordProp(linked, "diagnostic");
  if (!diagnostic) return undefined;
  const severity = severityFromValue(diagnostic.severity);
  const message = stringProp(diagnostic, "message");
  if (!severity || !message) return undefined;

  const range = recordProp(diagnostic, "range");
  const start = recordProp(range ?? {}, "start");
  const line = numberProp(start, "line");
  const character = numberProp(start, "character");
  const sourceCode = [diagnostic.source, diagnostic.code]
    .filter((part) => part !== undefined && part !== null && part !== "")
    .map(String)
    .join("/");
  const basePath = displayPathForCodeFeedbackDiagnostic(diagnostic, edit, cwd);
  const location =
    line === undefined
      ? basePath
      : `${basePath}:${line}${character === undefined ? "" : `:${character}`}`;

  return {
    severity,
    location,
    sourceCode: sourceCode || undefined,
    message,
    linkReason: stringProp(linked, "linkReason"),
  };
}

function displayPathForCodeFeedbackDiagnostic(
  diagnostic: CodeFeedbackRecord,
  edit: CodeFeedbackEditInput,
  cwd?: string,
): string {
  const uriPath = filePathFromUri(stringProp(diagnostic, "uri"));
  if (uriPath) {
    const relative = relativePathFromCwd(uriPath, cwd);
    return shortenPathForDisplay(relative ?? uriPath);
  }
  const editPath = edit.displayPath ?? edit.filePath;
  return editPath ? shortenPathForDisplay(editPath) : "(unknown file)";
}

function relativePathFromCwd(filePath: string, cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const normalizedFile = normalizeAbsolutePath(filePath);
  const normalizedCwd = normalizeAbsolutePath(cwd);
  if (!normalizedFile || !normalizedCwd) return undefined;
  const prefix = normalizedCwd.endsWith("/") ? normalizedCwd : `${normalizedCwd}/`;
  if (!normalizedFile.startsWith(prefix)) return undefined;
  const relative = normalizedFile.slice(prefix.length);
  return relative || undefined;
}

function normalizeAbsolutePath(value: string): string | undefined {
  if (!value.startsWith("/")) return undefined;
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function filePathFromUri(uri: string | undefined): string | undefined {
  if (!uri?.startsWith("file:")) return undefined;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return undefined;
  }
}

function countCodeFeedbackSeverities(
  diagnostics: CodeFeedbackDiagnosticEntry[],
): Record<CodeFeedbackSeverity, number> {
  return diagnostics.reduce<Record<CodeFeedbackSeverity, number>>(
    (counts, diagnostic) => {
      counts[diagnostic.severity] += 1;
      return counts;
    },
    { error: 0, warning: 0, information: 0, hint: 0 },
  );
}

function formatCodeFeedbackSeverityCounts(
  counts: Record<CodeFeedbackSeverity, number>,
  theme: ThemeLike,
): string {
  const parts: string[] = [];
  if (counts.error > 0) {
    parts.push(theme.fg("error", plural(counts.error, "error")));
  }
  if (counts.warning > 0) {
    parts.push(theme.fg("warning", plural(counts.warning, "warning")));
  }
  if (counts.information > 0) {
    parts.push(theme.fg("muted", `${counts.information} info`));
  }
  if (counts.hint > 0) {
    parts.push(theme.fg("muted", plural(counts.hint, "hint")));
  }
  return parts.join(", ");
}

function renderCodeFeedbackFormatterLines(
  edits: CodeFeedbackEditInput[],
  theme: ThemeLike,
  options: { expanded: boolean; cwd?: string },
): string[] {
  const lines: string[] = [];
  for (const edit of edits) {
    const formatter = edit.formatter;
    if (!formatter) continue;
    const changed = booleanProp(formatter, "changed") === true;
    const errors = stringArrayProp(formatter, "errors");
    if (!changed && errors.length === 0) continue;

    const displayPath = shortenPathForDisplay(
      relativePathFromCwd(edit.filePath ?? "", options.cwd) ??
        edit.displayPath ??
        edit.filePath ??
        "file",
    );
    const name = stringProp(formatter, "formatterName") ?? "formatter";
    const command = stringProp(formatter, "command");
    const tool = command ? `${name} (${command})` : name;

    if (changed) {
      lines.push(
        `  ${theme.fg("success", "formatted")} ${theme.fg("accent", displayPath)} ${theme.fg("muted", `with ${tool}`)}`,
      );
    }
    if (errors.length > 0) {
      lines.push(
        `  ${theme.fg("error", "format failed")} ${theme.fg("accent", displayPath)} ${theme.fg("muted", `with ${tool}`)}`,
      );
      lines.push(
        ...truncateMultiline(errors[0] ?? "", options.expanded ? 8 : 3).map(
          (line) => `    ${theme.fg("error", line)}`,
        ),
      );
    }
  }
  return lines;
}

function summarizeCodeFeedbackFormatters(
  edits: CodeFeedbackEditInput[],
): { text: string; color: string; hasErrors: boolean } | undefined {
  let changed = 0;
  let errors = 0;
  for (const edit of edits) {
    const formatter = edit.formatter;
    if (!formatter) continue;
    if (booleanProp(formatter, "changed") === true) changed += 1;
    if (stringArrayProp(formatter, "errors").length > 0) errors += 1;
  }
  const parts: string[] = [];
  if (errors > 0) parts.push(plural(errors, "format error"));
  if (changed > 0) parts.push(`${changed} formatted`);
  if (parts.length === 0) return undefined;
  return {
    text: parts.join(", "),
    color: errors > 0 ? "error" : "success",
    hasErrors: errors > 0,
  };
}

function summarizeCodeFeedbackHiddenDiagnostics(
  edits: CodeFeedbackEditInput[],
): string | undefined {
  let hiddenUnrelated = 0;
  let hiddenByLimit = 0;
  for (const edit of edits) {
    const summary = recordProp(edit.diagnostics ?? {}, "summary");
    hiddenUnrelated += numberProp(summary, "hiddenUnrelated") ?? 0;
    hiddenByLimit += numberProp(summary, "hiddenByLimit") ?? 0;
  }
  const parts: string[] = [];
  if (hiddenUnrelated > 0) parts.push(`${hiddenUnrelated} unrelated hidden`);
  if (hiddenByLimit > 0) parts.push(`${hiddenByLimit} more hidden`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function renderCodeFeedbackDiagnostic(
  diagnostic: CodeFeedbackDiagnosticEntry,
  theme: ThemeLike,
  options: { expanded: boolean },
): string[] {
  const color = colorForCodeFeedbackSeverity(diagnostic.severity);
  const source = diagnostic.sourceCode
    ? ` ${theme.fg("muted", diagnostic.sourceCode)}`
    : "";
  const reason =
    diagnostic.linkReason && diagnostic.linkReason !== "overlap"
      ? ` ${theme.fg("muted", `[${diagnostic.linkReason}]`)}`
      : "";
  const lines = [
    `  ${theme.fg(color, diagnostic.severity.toUpperCase())} ${theme.fg("accent", diagnostic.location)}${source}${reason}`,
  ];
  lines.push(
    ...truncateMultiline(diagnostic.message, options.expanded ? 8 : 3).map(
      (line) => `    ${theme.fg("muted", line)}`,
    ),
  );
  return lines;
}

function colorForCodeFeedbackSeverity(severity: CodeFeedbackSeverity): string {
  switch (severity) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "information":
      return "accent";
    case "hint":
      return "muted";
  }
}

function truncateMultiline(text: string, maxLines: number): string[] {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, Math.max(0, maxLines - 1)), "…"];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
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
  const renderText = (text: string) =>
    new ApplyPatchTextResultComponent(text, theme, {
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
    const codeFeedbackText = renderCodeFeedbackFromDetails(details, theme, {
      expanded,
      cwd: context?.cwd,
    });
    const warnings = details.warnings ?? [];
    const warningsText =
      warnings.length > 0
        ? warnings.map((w) => theme.fg("warning", w)).join("\n")
        : "";
    const withFeedback = (text: string): string =>
      footerText([text, warningsText, codeFeedbackText]);

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
          return renderText(withResultSpacing(withFeedback(out)));
        }

        const output = textFromContent(result.content);
        if (!output) {
          const feedback = withFeedback("");
          if (!feedback) return renderText(withResultSpacing(theme.fg("muted", "(no output)")));
          return renderText(withResultSpacing(feedback));
        }
        return renderText(withResultSpacing(withFeedback(theme.fg("toolOutput", output))));
      }

      const pierre = renderPierrePreviews(
        previews,
        footerText([
          summarizeUnpreviewedResults(details.results, theme),
          warningsText,
          codeFeedbackText,
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
      return renderText(withResultSpacing(withFeedback(out)));
    }

    const out = failed
      .map((r) => {
        return theme.fg("error", r.output ?? "Operation failed");
      })
      .join("\n\n");
    return renderText(withResultSpacing(withFeedback(out)));
  }

  // Fallback
  const output = textFromContent(result.content);
  if (!output)
    return renderText(withResultSpacing(theme.fg("muted", "(no output)")));
  if (!details)
    return renderText(withResultSpacing(theme.fg("error", output)));
  return renderText(withResultSpacing(theme.fg("toolOutput", output)));
}
