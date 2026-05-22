import type { FileDiffMetadata } from "../../node_modules/@pierre/diffs/dist/types.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
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
  _theme?: PiThemeLike,
): HighlightedDiffSet {
  if (!config.syntaxHighlight.enabled) return emptyHighlightedDiffSet();

  const indexes = renderedLineIndexes(metadata);
  const lineCount = indexes.deletion.length + indexes.addition.length;
  if (lineCount === 0 || lineCount > config.syntaxHighlight.maxLines) {
    return emptyHighlightedDiffSet();
  }

  const lang = metadata.lang ?? "text";
  const treeSitter = buildTreeSitterHighlightedDiff(
    metadata,
    indexes,
    lang,
    config,
  );
  if (treeSitter?.styled) {
    const highlighted = {
      deletionLines: treeSitter.deletionLines,
      additionLines: treeSitter.additionLines,
    };
    return { dark: highlighted, light: highlighted };
  }

  return emptyHighlightedDiffSet();
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

type TreeSitterLanguage = unknown;
type TreeSitterNode = {
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
};
type TreeSitterCapture = { name: string; node: TreeSitterNode };
type TreeSitterPoint = { row: number; column: number };
type TreeSitterQueryOptions = {
  startPosition?: TreeSitterPoint;
  endPosition?: TreeSitterPoint;
};
type TreeSitterQuery = {
  captures: (
    node: unknown,
    options?: TreeSitterQueryOptions,
  ) => TreeSitterCapture[];
};
type TreeSitterParser = {
  setLanguage: (language: TreeSitterLanguage) => void;
  parse: (code: string) => { rootNode: unknown };
};
type TreeSitterParserConstructor = {
  new (): TreeSitterParser;
  Query: new (language: TreeSitterLanguage, source: string) => TreeSitterQuery;
};
type TreeSitterRuntime = {
  Parser: TreeSitterParserConstructor;
  languages: Map<string, TreeSitterLanguage>;
  queries: Map<string, string>;
};
type HighlightLineResult = {
  lines: Array<HastNode | undefined>;
  styled: boolean;
};
type PreparedTreeSitterLines = {
  cleanLines: string[];
  lineStyles: Map<number, Array<SyntaxCategory | undefined>>;
};
type LineRange = { start: number; end: number };
type CaptureStyle = { category: SyntaxCategory; priority: number };

const nodeRequire = createRequire(import.meta.url);
const treeSitterWorkerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "tree-sitter-worker.cjs",
);
const TREE_SITTER_QUERY_RANGE_GAP = 2;
const TREE_SITTER_QUERY_RANGE_END_COLUMN = 0x7fffffff;
const TREE_SITTER_QUERY_FULL_COVERAGE_NUMERATOR = 3;
const TREE_SITTER_QUERY_FULL_COVERAGE_DENOMINATOR = 4;
let treeSitterRuntime: TreeSitterRuntime | null | undefined;
const treeSitterQueryCache = new Map<string, TreeSitterQuery>();
const syntaxStyleByCaptureName = Object.create(null) as Record<
  string,
  CaptureStyle | null | undefined
>;

function buildTreeSitterHighlightedDiff(
  metadata: FileDiffMetadata,
  indexes: { deletion: number[]; addition: number[] },
  lang: string,
  config: PierreRendererConfig,
):
  | {
      deletionLines: Array<HastNode | undefined>;
      additionLines: Array<HastNode | undefined>;
      styled: boolean;
    }
  | undefined {
  const languageKey = treeSitterLanguageKey(lang);
  if (!languageKey) return undefined;

  const runtime = getTreeSitterRuntime();
  const language = runtime?.languages.get(languageKey);
  const querySource = runtime?.queries.get(languageKey);
  const highlightLines = (lines: string[], lineIndexes: number[]) => {
    if (runtime && language && querySource) {
      const inProcess = highlightTreeSitterLines(
        runtime,
        languageKey,
        language,
        querySource,
        lines,
        lineIndexes,
        config,
      );
      if (inProcess.styled) return inProcess;
    }

    return highlightTreeSitterLinesWithWorker(
      languageKey,
      lines,
      lineIndexes,
      config,
    );
  };

  const deletion = highlightLines(metadata.deletionLines, indexes.deletion);
  const addition = highlightLines(metadata.additionLines, indexes.addition);

  if (!deletion.styled && !addition.styled) return undefined;
  return {
    deletionLines: deletion.lines,
    additionLines: addition.lines,
    styled: true,
  };
}

function getTreeSitterRuntime(): TreeSitterRuntime | undefined {
  if (treeSitterRuntime !== undefined) return treeSitterRuntime ?? undefined;

  try {
    const Parser = nodeRequire("tree-sitter") as TreeSitterParserConstructor;
    const TypeScript = nodeRequire("tree-sitter-typescript") as {
      typescript?: TreeSitterLanguage;
      tsx?: TreeSitterLanguage;
    };
    const JavaScript = nodeRequire("tree-sitter-javascript") as TreeSitterLanguage;
    const jsQuery = readFileSync(
      nodeRequire.resolve("tree-sitter-javascript/queries/highlights.scm"),
      "utf8",
    );
    const tsQuery = readFileSync(
      nodeRequire.resolve("tree-sitter-typescript/queries/highlights.scm"),
      "utf8",
    );
    if (!TypeScript.typescript || !TypeScript.tsx) throw new Error("missing TS grammar");

    treeSitterRuntime = {
      Parser,
      languages: new Map<string, TreeSitterLanguage>([
        ["javascript", JavaScript],
        ["typescript", TypeScript.typescript],
        ["tsx", TypeScript.tsx],
      ]),
      queries: new Map<string, string>([
        ["javascript", jsQuery],
        ["typescript", `${jsQuery}\n${tsQuery}`],
        ["tsx", `${jsQuery}\n${tsQuery}`],
      ]),
    };
  } catch {
    treeSitterRuntime = null;
  }

  return treeSitterRuntime ?? undefined;
}

function treeSitterLanguageKey(lang: string): string | undefined {
  const normalized = lang.toLowerCase();
  if (normalized === "typescript" || normalized === "ts") return "typescript";
  if (normalized === "tsx") return "tsx";
  if (
    normalized === "javascript" ||
    normalized === "js" ||
    normalized === "jsx" ||
    normalized === "mjs" ||
    normalized === "cjs"
  ) {
    return "javascript";
  }
  return undefined;
}

function highlightTreeSitterLines(
  runtime: TreeSitterRuntime,
  languageKey: string,
  language: TreeSitterLanguage,
  querySource: string,
  lines: string[],
  indexes: number[],
  config: PierreRendererConfig,
): HighlightLineResult {
  if (lines.length === 0 || indexes.length === 0) {
    return { lines: [], styled: false };
  }

  const prepared = prepareTreeSitterLines(lines, indexes, config);
  if (!prepared) return { lines: [], styled: false };
  const { cleanLines, lineStyles } = prepared;

  try {
    const parser = new runtime.Parser();
    parser.setLanguage(language);
    const tree = parser.parse(cleanLines.join("\n"));
    const query = treeSitterQuery(runtime, languageKey, language, querySource);
    paintCaptures(
      cleanLines,
      lineStyles,
      treeSitterCapturesForStyledRanges(
        query,
        tree.rootNode,
        lineStyles,
        cleanLines.length,
      ),
    );
  } catch {
    return { lines: [], styled: false };
  }

  const out: Array<HastNode | undefined> = [];
  let styled = false;
  for (const [index, styles] of lineStyles) {
    if (!styles.some(Boolean)) continue;
    const line = cleanLines[index] ?? "";
    out[index] = syntaxSpansNode(spansFromLineStyles(line, styles));
    styled = true;
  }

  return { lines: out, styled };
}

function highlightTreeSitterLinesWithWorker(
  languageKey: string,
  lines: string[],
  indexes: number[],
  config: PierreRendererConfig,
): HighlightLineResult {
  if (lines.length === 0 || indexes.length === 0) {
    return { lines: [], styled: false };
  }

  const prepared = prepareTreeSitterLines(lines, indexes, config);
  if (!prepared) return { lines: [], styled: false };
  const { cleanLines, lineStyles } = prepared;

  const captures = treeSitterWorkerCaptures(
    languageKey,
    cleanLines,
    [...lineStyles.keys()],
  );
  if (!captures) return { lines: [], styled: false };

  paintCaptures(cleanLines, lineStyles, captures);

  const out: Array<HastNode | undefined> = [];
  let styled = false;
  for (const [index, styles] of lineStyles) {
    if (!styles.some(Boolean)) continue;
    const line = cleanLines[index] ?? "";
    out[index] = syntaxSpansNode(spansFromLineStyles(line, styles));
    styled = true;
  }

  return { lines: out, styled };
}

function prepareTreeSitterLines(
  lines: string[],
  indexes: number[],
  config: PierreRendererConfig,
): PreparedTreeSitterLines | undefined {
  const cleanLines = lines.map(cleanDiffLine);
  const lineStyles = new Map<number, Array<SyntaxCategory | undefined>>();
  for (const index of indexes) {
    const line = cleanLines[index] ?? "";
    if (line.length > config.syntaxHighlight.maxLineLength) continue;
    lineStyles.set(index, new Array<SyntaxCategory | undefined>(line.length));
  }
  return lineStyles.size === 0 ? undefined : { cleanLines, lineStyles };
}

function treeSitterCapturesForStyledRanges(
  query: TreeSitterQuery,
  rootNode: unknown,
  lineStyles: Map<number, Array<SyntaxCategory | undefined>>,
  lineCount: number,
): TreeSitterCapture[] {
  const ranges = styledLineRanges(lineStyles, lineCount);
  if (ranges.length === 0) return [];
  if (shouldQueryFullTree(ranges, lineCount)) {
    return query.captures(rootNode);
  }

  try {
    const captures: TreeSitterCapture[] = [];
    for (const range of ranges) {
      captures.push(
        ...query.captures(rootNode, {
          startPosition: { row: range.start, column: 0 },
          endPosition: {
            row: range.end,
            column: TREE_SITTER_QUERY_RANGE_END_COLUMN,
          },
        }),
      );
    }
    return captures;
  } catch {
    return query.captures(rootNode);
  }
}

function styledLineRanges(
  lineStyles: Map<number, Array<SyntaxCategory | undefined>>,
  lineCount: number,
): LineRange[] {
  const ranges: LineRange[] = [];
  let current: LineRange | undefined;

  for (const row of lineStyles.keys()) {
    if (row < 0 || row >= lineCount) continue;
    if (!current) {
      current = { start: row, end: row };
      continue;
    }
    if (row <= current.end + TREE_SITTER_QUERY_RANGE_GAP + 1) {
      current.end = row;
      continue;
    }

    ranges.push(current);
    current = { start: row, end: row };
  }

  if (current) ranges.push(current);
  return ranges;
}

function shouldQueryFullTree(ranges: LineRange[], lineCount: number): boolean {
  if (
    ranges.length === 1 &&
    ranges[0]!.start === 0 &&
    ranges[0]!.end >= lineCount - 1
  ) {
    return true;
  }

  let coveredLines = 0;
  for (const range of ranges) coveredLines += range.end - range.start + 1;
  return (
    coveredLines * TREE_SITTER_QUERY_FULL_COVERAGE_DENOMINATOR >=
    lineCount * TREE_SITTER_QUERY_FULL_COVERAGE_NUMERATOR
  );
}

function paintCaptures(
  lines: string[],
  lineStyles: Map<number, Array<SyntaxCategory | undefined>>,
  captures: TreeSitterCapture[],
): void {
  const buckets: Array<TreeSitterCapture[] | undefined> = [];
  const categories: Array<SyntaxCategory | undefined> = [];
  for (const capture of captures) {
    if (!captureOverlapsStyledLine(capture.node, lineStyles)) continue;
    const style = syntaxStyleForCapture(capture.name);
    if (!style) continue;
    categories[style.priority] = style.category;
    (buckets[style.priority] ??= []).push(capture);
  }

  for (let priority = 0; priority < buckets.length; priority++) {
    const bucket = buckets[priority];
    if (!bucket) continue;
    const category = categories[priority];
    if (!category) continue;
    for (const capture of bucket) {
      paintCapture(lines, lineStyles, capture.node, category);
    }
  }
}

function captureOverlapsStyledLine(
  node: TreeSitterNode,
  lineStyles: Map<number, Array<SyntaxCategory | undefined>>,
): boolean {
  for (let row = node.startPosition.row; row <= node.endPosition.row; row++) {
    if (lineStyles.has(row)) return true;
  }
  return false;
}

function treeSitterWorkerCaptures(
  languageKey: string,
  lines: string[],
  indexes: number[],
): TreeSitterCapture[] | undefined {
  try {
    const result = spawnSync(
      process.env.PI_TREE_SITTER_NODE ?? "node",
      [treeSitterWorkerPath],
      {
        input: JSON.stringify({ languageKey, lines, indexes }),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.status !== 0 || !result.stdout) return undefined;

    const parsed = JSON.parse(result.stdout) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const captures = (parsed as { captures?: unknown }).captures;
    if (!Array.isArray(captures)) return undefined;

    return captures
      .map(normalizeWorkerCapture)
      .filter((capture): capture is TreeSitterCapture => Boolean(capture));
  } catch {
    return undefined;
  }
}

function normalizeWorkerCapture(value: unknown): TreeSitterCapture | undefined {
  if (!value || typeof value !== "object") return undefined;
  const capture = value as {
    name?: unknown;
    startRow?: unknown;
    startColumn?: unknown;
    endRow?: unknown;
    endColumn?: unknown;
  };
  if (typeof capture.name !== "string") return undefined;
  if (
    typeof capture.startRow !== "number" ||
    typeof capture.startColumn !== "number" ||
    typeof capture.endRow !== "number" ||
    typeof capture.endColumn !== "number"
  ) {
    return undefined;
  }

  return {
    name: capture.name,
    node: {
      text: "",
      startPosition: { row: capture.startRow, column: capture.startColumn },
      endPosition: { row: capture.endRow, column: capture.endColumn },
    },
  };
}

function treeSitterQuery(
  runtime: TreeSitterRuntime,
  languageKey: string,
  language: TreeSitterLanguage,
  querySource: string,
): TreeSitterQuery {
  const cached = treeSitterQueryCache.get(languageKey);
  if (cached) return cached;

  const query = new runtime.Parser.Query(language, querySource);
  treeSitterQueryCache.set(languageKey, query);
  return query;
}

function syntaxCategoryForCapture(name: string): SyntaxCategory | undefined {
  const dot = name.indexOf(".");
  const head = dot < 0 ? name : name.slice(0, dot);
  switch (head) {
    case "comment":
    case "keyword":
    case "function":
    case "string":
    case "number":
    case "type":
    case "operator":
    case "punctuation":
      return head;
    case "constructor":
      return "type";
    case "constant":
      return "number";
    case "property":
    case "variable":
      return "variable";
    default:
      return undefined;
  }
}

function syntaxStyleForCapture(name: string): CaptureStyle | undefined {
  const cached = syntaxStyleByCaptureName[name];
  if (cached !== undefined) return cached ?? undefined;

  const category = syntaxCategoryForCapture(name);
  const style = category
    ? { category, priority: syntaxCategoryPriority(category) }
    : null;
  syntaxStyleByCaptureName[name] = style;
  return style ?? undefined;
}

function syntaxCategoryPriority(category: SyntaxCategory): number {
  switch (category) {
    case "punctuation":
      return 10;
    case "operator":
      return 20;
    case "variable":
      return 30;
    case "type":
      return 40;
    case "function":
      return 50;
    case "number":
      return 60;
    case "keyword":
      return 70;
    case "string":
      return 80;
    case "comment":
      return 90;
    case "text":
      return 0;
  }
}

function paintCapture(
  lines: string[],
  lineStyles: Map<number, Array<SyntaxCategory | undefined>>,
  node: TreeSitterNode,
  category: SyntaxCategory,
): void {
  const startRow = node.startPosition.row;
  const endRow = node.endPosition.row;
  for (let row = startRow; row <= endRow; row++) {
    const styles = lineStyles.get(row);
    if (!styles) continue;

    const line = lines[row] ?? "";
    const start = row === startRow ? byteColumnToStringIndex(line, node.startPosition.column) : 0;
    const end = row === endRow ? byteColumnToStringIndex(line, node.endPosition.column) : line.length;
    for (let i = start; i < end; i++) styles[i] = category;
  }
}

function byteColumnToStringIndex(line: string, column: number): number {
  if (column <= 0) return 0;

  let bytes = 0;
  for (let i = 0; i < line.length;) {
    const codePoint = line.codePointAt(i);
    if (codePoint === undefined) break;
    if (codePoint < 0x80) {
      if (bytes + 1 > column) return i;
      bytes += 1;
      i += 1;
      continue;
    }
    const nextBytes =
      codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (bytes + nextBytes > column) return i;
    bytes += nextBytes;
    i += codePoint > 0xffff ? 2 : 1;
  }

  return line.length;
}

function spansFromLineStyles(
  line: string,
  styles: Array<SyntaxCategory | undefined>,
): SyntaxSpan[] {
  const spans: SyntaxSpan[] = [];
  let offset = 0;
  while (offset < line.length) {
    const category = styles[offset];
    let end = offset + 1;
    while (end < line.length && styles[end] === category) end++;
    spans.push({ text: line.slice(offset, end), category });
    offset = end;
  }
  return spans;
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

type SyntaxSpan = { text: string; category?: SyntaxCategory };

function syntaxSpansNode(spans: SyntaxSpan[]): HastNode | undefined {
  if (spans.length === 0) return undefined;
  return {
    type: "element",
    tagName: "span",
    properties: {},
    children: spans.map(syntaxSpanNode),
  };
}

function syntaxSpanNode(span: SyntaxSpan): HastNode {
  const text: HastNode = { type: "text", value: span.text };
  if (!span.category) return text;
  return {
    type: "element",
    tagName: "span",
    properties: { "data-pi-syntax": span.category },
    children: [text],
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
