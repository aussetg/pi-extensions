import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { relativePathFromCwd, shortenPathForDisplay } from "./util.ts";

type ThemeLike = {
  fg: (color: string, text: string) => string;
  bg?: (color: string, text: string) => string;
  bold: (text: string) => string;
};

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

export interface CodeFeedbackBlock {
  readonly attachesToPrevious: true;
  render(
    width: number,
    fallbackBackground?: (text: string) => string,
  ): string[];
}

export type CodeFeedbackRender = string | CodeFeedbackBlock;

export function renderCodeFeedbackFromDetails(
  details: unknown,
  theme: ThemeLike,
  options: { expanded: boolean; cwd?: string },
): CodeFeedbackRender | undefined {
  const feedback = readCodeFeedback(details);
  if (!feedback) return undefined;

  const lines = renderStructuredCodeFeedback(feedback, theme, options);
  if (lines.length > 0) return new CodeFeedbackPanel(lines, theme);

  if (!feedback.inlineText) return undefined;
  const fallbackLines = feedback.inlineText.trim().split("\n");
  if (/^code-feedback\s*:/i.test(fallbackLines[0] ?? "")) {
    fallbackLines.shift();
  }
  return new CodeFeedbackPanel([
    theme.fg("warning", theme.bold("code feedback")),
    ...fallbackLines,
  ], theme);
}

class CodeFeedbackPanel implements CodeFeedbackBlock {
  readonly attachesToPrevious = true as const;

  private readonly content: string[];
  private readonly theme: ThemeLike;
  private renderedWidth: number | undefined;
  private renderedBackgroundSample: string | undefined;
  private renderedLines: string[] | undefined;

  constructor(lines: string[], theme: ThemeLike) {
    this.theme = theme;
    this.content = [lines[0]!, ...lines.slice(1).map((line) => line.replace(/^  /, ""))];
  }

  render(
    width: number,
    fallbackBackground?: (text: string) => string,
  ): string[] {
    const safeWidth = Math.max(1, Math.trunc(width));
    const background = fallbackBackground ?? (this.theme.bg
      ? (text: string) => this.theme.bg!("toolSuccessBg", text)
      : undefined);
    const backgroundSample = background?.("__code_feedback_background__");
    if (
      this.renderedWidth === safeWidth &&
      this.renderedBackgroundSample === backgroundSample &&
      this.renderedLines
    ) {
      return this.renderedLines;
    }

    // Keep feedback on the settled tool surface. Spacing and typography are
    // enough hierarchy; another full-width color creates an unnecessary band.
    const paddingX = safeWidth >= 3 ? 1 : 0;
    const innerWidth = Math.max(1, safeWidth - paddingX * 2);
    const paint = (line: string) => background ? background(line) : line;
    const blank = paint(" ".repeat(safeWidth));
    const rendered: string[] = [];
    for (const line of this.content) {
      for (const segment of wrapAnsiLine(line, innerWidth)) {
        const fitted = fitAnsiLine(segment, innerWidth);
        const rightPadding = Math.max(
          0,
          safeWidth - paddingX - visibleWidth(fitted),
        );
        rendered.push(
          paint(`${" ".repeat(paddingX)}${fitted}${" ".repeat(rightPadding)}`),
        );
      }
    }
    rendered.push(blank);
    this.renderedLines = rendered;
    this.renderedWidth = safeWidth;
    this.renderedBackgroundSample = backgroundSample;
    return this.renderedLines;
  }
}

function readCodeFeedback(details: unknown): CodeFeedbackToolDetailsInput | undefined {
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

function readCodeFeedbackEdit(value: unknown): CodeFeedbackEditInput | undefined {
  if (!isRecord(value)) return undefined;
  return {
    displayPath: stringProp(value, "displayPath"),
    filePath: stringProp(value, "filePath"),
    formatter: recordProp(value, "formatter"),
    diagnostics: recordProp(value, "diagnostics"),
  };
}

function renderStructuredCodeFeedback(
  feedback: CodeFeedbackToolDetailsInput,
  theme: ThemeLike,
  options: { expanded: boolean; cwd?: string },
): string[] {
  const diagnostics = collectCodeFeedbackDiagnostics(feedback.edits, options.cwd);
  const formatterLines = renderCodeFeedbackFormatterLines(feedback.edits, theme, options);
  if (diagnostics.length === 0 && formatterLines.length === 0) return [];

  const severityCounts = countCodeFeedbackSeverities(diagnostics);
  const formatterSummary = summarizeCodeFeedbackFormatters(feedback.edits);
  const hidden = summarizeCodeFeedbackHiddenDiagnostics(feedback.edits);
  const summaryParts = [
    diagnostics.length > 0 ? formatCodeFeedbackSeverityCounts(severityCounts, theme) : "",
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
  return lines;
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

function summarizeCodeFeedbackHiddenDiagnostics(edits: CodeFeedbackEditInput[]): string | undefined {
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
  const source = diagnostic.sourceCode ? ` ${theme.fg("muted", diagnostic.sourceCode)}` : "";
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
  if (counts.error > 0) parts.push(theme.fg("error", plural(counts.error, "error")));
  if (counts.warning > 0) parts.push(theme.fg("warning", plural(counts.warning, "warning")));
  if (counts.information > 0) parts.push(theme.fg("muted", `${counts.information} info`));
  if (counts.hint > 0) parts.push(theme.fg("muted", plural(counts.hint, "hint")));
  return parts.join(", ");
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

function filePathFromUri(uri: string | undefined): string | undefined {
  if (!uri?.startsWith("file:")) return undefined;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is CodeFeedbackRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function recordProp(record: CodeFeedbackRecord, key: string): CodeFeedbackRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function stringProp(record: CodeFeedbackRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberProp(record: CodeFeedbackRecord | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanProp(record: CodeFeedbackRecord | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayProp(record: CodeFeedbackRecord | undefined, key: string): string[] {
  const value = record?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function severityFromValue(value: unknown): CodeFeedbackSeverity | undefined {
  return value === "error" || value === "warning" || value === "information" || value === "hint"
    ? value
    : undefined;
}

function truncateMultiline(text: string, maxLines: number): string[] {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, Math.max(0, maxLines - 1)), "…"];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function wrapAnsiLine(line: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.trunc(width));
  const wrapped = wrapTextWithAnsi(line, safeWidth);
  const lines = wrapped.length > 0 ? wrapped : [""];
  return lines.map((segment) => fitAnsiLine(segment, safeWidth));
}

function fitAnsiLine(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
}
