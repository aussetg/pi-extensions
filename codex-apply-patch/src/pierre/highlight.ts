import type { FileDiffMetadata } from "../../node_modules/@pierre/diffs/dist/types.js";
import { highlightCode } from "@mariozechner/pi-coding-agent";
import type { PierreRendererConfig } from "./config.ts";
import type { PiThemeLike, PierreTerminalPalette } from "./theme.ts";
import type {
  DiffSpan,
  HastNode,
  HighlightedDiffCode,
  HighlightedDiffSet,
  PierreAppearance,
  SyntaxCategory,
} from "./types.ts";
import { emptyHighlightedDiffSet } from "./types.ts";

export async function loadHighlightedDiff(
  metadata: FileDiffMetadata,
  config: PierreRendererConfig,
  theme?: PiThemeLike,
): Promise<HighlightedDiffSet> {
  return buildPiHighlightedDiff(metadata, config, theme);
}

export function buildPiHighlightedDiff(
  metadata: FileDiffMetadata,
  config: PierreRendererConfig,
  theme?: PiThemeLike,
): HighlightedDiffSet {
  if (!config.syntaxHighlight.enabled) return emptyHighlightedDiffSet();

  const indexes = renderedLineIndexes(metadata);
  const lineCount = indexes.deletion.length + indexes.addition.length;
  if (lineCount === 0 || lineCount > config.syntaxHighlight.maxLines) {
    return emptyHighlightedDiffSet();
  }

  const lang = metadata.lang ?? "text";
  const deletion = highlightAnsiLines(
    metadata.deletionLines,
    indexes.deletion,
    lang,
    config,
    theme,
  );
  const addition = highlightAnsiLines(
    metadata.additionLines,
    indexes.addition,
    lang,
    config,
    theme,
  );
  if (!deletion.styled && !addition.styled) return emptyHighlightedDiffSet();

  const highlighted = {
    deletionLines: deletion.lines,
    additionLines: addition.lines,
  };
  return { dark: highlighted, light: highlighted };
}

export function normalizeHighlightedDiffSet(
  highlighted: unknown,
): HighlightedDiffSet {
  if (!highlighted || typeof highlighted !== "object") {
    return emptyHighlightedDiffSet();
  }

  const candidate = highlighted as Partial<HighlightedDiffSet>;
  return {
    dark: normalizeHighlightedDiffCode(candidate.dark),
    light: normalizeHighlightedDiffCode(candidate.light),
  };
}

export function hasHighlightedLines(highlighted: HighlightedDiffSet): boolean {
  return (
    highlighted.dark.deletionLines.length > 0 ||
    highlighted.dark.additionLines.length > 0 ||
    highlighted.light.deletionLines.length > 0 ||
    highlighted.light.additionLines.length > 0
  );
}

export function flattenHighlightedLine(
  node: HastNode | undefined,
  _appearance: PierreAppearance,
  palette: PierreTerminalPalette,
  emphasisBg: string,
  fallbackText: string,
): DiffSpan[] {
  const spans: DiffSpan[] = [];

  const visit = (
    current: HastNode | undefined,
    inherited: Pick<DiffSpan, "fg" | "bg">,
  ) => {
    if (!current) return;

    if (current.type === "text") {
      mergeSpan(spans, {
        text: tabify(current.value),
        fg: inherited.fg,
        bg: inherited.bg,
      });
      return;
    }

    const properties = current.properties ?? {};
    const ansiSpans = normalizeAnsiSpans(properties["data-pi-ansi-spans"]);
    if (ansiSpans) {
      for (const span of ansiSpans) mergeSpan(spans, span);
      return;
    }

    const syntaxCategory = normalizeSyntaxCategory(properties["data-pi-syntax"]);
    const nextStyle: Pick<DiffSpan, "fg" | "bg"> = {
      fg: syntaxCategory ? syntaxColor(palette, syntaxCategory) : inherited.fg,
      bg: Object.prototype.hasOwnProperty.call(properties, "data-diff-span")
        ? emphasisBg
        : inherited.bg,
    };

    for (const child of current.children ?? []) visit(child, nextStyle);
  };

  visit(node, {});

  return spans.length > 0
    ? spans
    : fallbackText.length > 0
      ? [{ text: fallbackText }]
      : [];
}

function highlightAnsiLines(
  lines: string[],
  indexes: number[],
  lang: string,
  config: PierreRendererConfig,
  theme?: PiThemeLike,
): { lines: Array<HastNode | undefined>; styled: boolean } {
  if (lines.length === 0 || indexes.length === 0) {
    return { lines: [], styled: false };
  }

  const out: Array<HastNode | undefined> = [];
  let styled = false;

  for (const run of contiguousRuns(indexes)) {
    let start = 0;
    while (start < run.length) {
      while (
        start < run.length &&
        cleanDiffLine(lines[run[start]!]).length >
          config.syntaxHighlight.maxLineLength
      ) {
        start++;
      }
      if (start >= run.length) break;

      let end = start + 1;
      while (
        end < run.length &&
        cleanDiffLine(lines[run[end]!]).length <=
          config.syntaxHighlight.maxLineLength
      ) {
        end++;
      }

      const subrun = run.slice(start, end);
      const cleanLines = subrun.map((index) => cleanDiffLine(lines[index]));
      const highlighted = highlightCleanLines(cleanLines, lang, theme);
      if (highlighted) {
        for (let i = 0; i < subrun.length; i++) {
          const line = cleanLines[i] ?? "";
          const renderedLine = highlighted[i] ?? line;
          const parsed = ansiToSpans(renderedLine);
          styled ||= parsed.some((span) => Boolean(span.fg));
          out[subrun[i]!] = ansiSpansNode(parsed);
        }
      }

      start = end;
    }
  }

  return { lines: out, styled };
}

function highlightCleanLines(
  cleanLines: string[],
  lang: string,
  theme?: PiThemeLike,
): string[] | undefined {
  const highlighted = callHighlightCode(cleanLines, lang, theme);
  if (!theme || highlightedLinesHaveAnsi(highlighted)) return highlighted;

  const fallback = callHighlightCode(cleanLines, lang);
  return highlightedLinesHaveAnsi(fallback) ? fallback : highlighted;
}

function callHighlightCode(
  cleanLines: string[],
  lang: string,
  theme?: PiThemeLike,
): string[] | undefined {
  try {
    const highlighter = highlightCode as (
      code: string,
      lang?: string,
      theme?: PiThemeLike,
    ) => string | string[];
    const rawHighlighted = highlighter(
      cleanLines.join("\n"),
      isPlainTextLanguage(lang) ? undefined : lang,
      theme,
    );
    return normalizeHighlightedLines(rawHighlighted);
  } catch {
    return undefined;
  }
}

function highlightedLinesHaveAnsi(lines: string[] | undefined): boolean {
  return Boolean(lines?.some((line) => /\u001b\[[0-9;]*m/.test(line)));
}

function renderedLineIndexes(metadata: FileDiffMetadata): {
  deletion: number[];
  addition: number[];
} {
  const deletion = new Set<number>();
  const addition = new Set<number>();

  for (const hunk of metadata.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        addRange(addition, content.additionLineIndex, content.lines);
        continue;
      }

      addRange(deletion, content.deletionLineIndex, content.deletions);
      addRange(addition, content.additionLineIndex, content.additions);
    }
  }

  return {
    deletion: [...deletion].sort((a, b) => a - b),
    addition: [...addition].sort((a, b) => a - b),
  };
}

function addRange(target: Set<number>, start: number, count: number): void {
  for (let i = 0; i < count; i++) target.add(start + i);
}

function contiguousRuns(indexes: number[]): number[][] {
  const runs: number[][] = [];
  let current: number[] = [];

  for (const index of indexes) {
    if (current.length === 0 || index === current[current.length - 1]! + 1) {
      current.push(index);
      continue;
    }

    runs.push(current);
    current = [index];
  }

  if (current.length > 0) runs.push(current);
  return runs;
}

function normalizeHighlightedLines(value: string | string[]): string[] {
  return Array.isArray(value) ? value : value.split("\n");
}

function ansiSpansNode(spans: DiffSpan[]): HastNode | undefined {
  if (spans.length === 0) return undefined;
  return {
    type: "element",
    tagName: "span",
    properties: { "data-pi-ansi-spans": spans },
    children: [],
  };
}

function normalizeSyntaxCategory(value: unknown): SyntaxCategory | undefined {
  return typeof value === "string" && isSyntaxCategory(value) ? value : undefined;
}

function isSyntaxCategory(value: string): value is SyntaxCategory {
  return [
    "text",
    "comment",
    "keyword",
    "function",
    "variable",
    "string",
    "number",
    "type",
    "operator",
    "punctuation",
  ].includes(value);
}

function syntaxColor(
  palette: PierreTerminalPalette,
  category: SyntaxCategory,
): string {
  switch (category) {
    case "comment":
      return palette.syntaxComment;
    case "keyword":
      return palette.syntaxKeyword;
    case "function":
      return palette.syntaxFunction;
    case "variable":
      return palette.syntaxVariable;
    case "string":
      return palette.syntaxString;
    case "number":
      return palette.syntaxNumber;
    case "type":
      return palette.syntaxType;
    case "operator":
      return palette.syntaxOperator;
    case "punctuation":
      return palette.syntaxPunctuation;
    case "text":
      return palette.syntaxText;
  }
}

function isPlainTextLanguage(lang: string): boolean {
  return lang === "text" || lang === "txt" || lang === "plain" || lang === "plaintext";
}

function normalizeAnsiSpans(value: unknown): DiffSpan[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const spans: DiffSpan[] = [];
  for (const span of value) {
    if (!span || typeof span !== "object") continue;
    const text = (span as { text?: unknown }).text;
    if (typeof text !== "string" || text.length === 0) continue;
    const fg = (span as { fg?: unknown }).fg;
    const bg = (span as { bg?: unknown }).bg;
    spans.push({
      text,
      fg: typeof fg === "string" ? fg : undefined,
      bg: typeof bg === "string" ? bg : undefined,
    });
  }
  return spans.length > 0 ? spans : undefined;
}

function ansiToSpans(text: string): DiffSpan[] {
  const spans: DiffSpan[] = [];
  const sgr = /\u001b\[([0-9;]*)m/g;
  let offset = 0;
  let fg: string | undefined;

  for (const match of text.matchAll(sgr)) {
    const index = match.index ?? 0;
    if (index > offset) {
      mergeSpan(spans, { text: text.slice(offset, index), fg });
    }

    fg = nextAnsiFg(fg, match[1] ?? "");
    offset = index + match[0].length;
  }

  if (offset < text.length) mergeSpan(spans, { text: text.slice(offset), fg });
  return spans;
}

function nextAnsiFg(current: string | undefined, params: string): string | undefined {
  const codes = params
    .split(";")
    .filter((part) => part.length > 0)
    .map((part) => Number(part));
  if (codes.length === 0) return current;

  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    if (code === 0 || code === 39) {
      current = undefined;
      continue;
    }

    if (code === 38 && codes[i + 1] === 2) {
      const r = codes[i + 2];
      const g = codes[i + 3];
      const b = codes[i + 4];
      if (isByte(r) && isByte(g) && isByte(b)) {
        current = `\u001b[38;2;${r};${g};${b}m`;
        i += 4;
      }
      continue;
    }

    if (code === 38 && codes[i + 1] === 5) {
      const color = codes[i + 2];
      if (typeof color === "number" && Number.isInteger(color)) {
        current = `\u001b[38;5;${color}m`;
        i += 2;
      }
      continue;
    }

    if (typeof code === "number" && code >= 30 && code <= 37) {
      current = `\u001b[${code}m`;
      continue;
    }

    if (typeof code === "number" && code >= 90 && code <= 97) {
      current = `\u001b[${code}m`;
    }
  }

  return current;
}

function isByte(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}

export function cleanDiffLine(line: string | undefined): string {
  return tabify(cleanLastNewline(line ?? "").replace(/\r$/, ""));
}

function normalizeHighlightedDiffCode(code: unknown): HighlightedDiffCode {
  if (!code || typeof code !== "object") {
    return { deletionLines: [], additionLines: [] };
  }

  const candidate = code as Partial<HighlightedDiffCode>;
  return {
    deletionLines: Array.isArray(candidate.deletionLines)
      ? candidate.deletionLines
      : [],
    additionLines: Array.isArray(candidate.additionLines)
      ? candidate.additionLines
      : [],
  };
}

function tabify(text: string): string {
  return text.replace(/\t/g, "    ");
}

function cleanLastNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function mergeSpan(target: DiffSpan[], next: DiffSpan): void {
  if (next.text.length === 0) return;

  const previous = target[target.length - 1];
  if (previous && previous.fg === next.fg && previous.bg === next.bg) {
    previous.text += next.text;
    return;
  }

  target.push(next);
}
