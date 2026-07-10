import type { FileDiffMetadata } from "../../node_modules/@pierre/diffs/dist/types.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fork, type ChildProcess } from "node:child_process";
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
import {
  querySharedSyntaxCaptures,
  treeSitterColumnToStringIndex,
  treeSitterLanguageKey,
  type TreeSitterCapture,
  type TreeSitterNode,
  type TreeSitterRange,
} from "./syntax-service.ts";
import {
  queryTextMateSyntaxSpans,
  type TextMateSyntaxSpan,
} from "./textmate-service.ts";
import {
  requestHighlightedDiff,
  resetHighlightWorker,
} from "./highlight-worker-client.ts";

export function loadHighlightedDiff(
  metadata: FileDiffMetadata,
  config: PierreRendererConfig,
  _theme?: PiThemeLike,
  requestKey?: string,
): Promise<HighlightedDiffSet> {
  return requestHighlightedDiff(metadata, config, requestKey);
}

/** Runs inside highlight-worker.mjs. Keep heavy syntax work out of Pi's process. */
export async function buildPiHighlightedDiffInWorker(
  metadata: FileDiffMetadata,
  config: PierreRendererConfig,
): Promise<HighlightedDiffSet> {
  return buildPiHighlightedDiffAsync(metadata, config);
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

async function buildPiHighlightedDiffAsync(
  metadata: FileDiffMetadata,
  config: PierreRendererConfig,
  _theme?: PiThemeLike,
): Promise<HighlightedDiffSet> {
  if (!config.syntaxHighlight.enabled) return emptyHighlightedDiffSet();

  const indexes = renderedLineIndexes(metadata);
  const lineCount = indexes.deletion.length + indexes.addition.length;
  if (lineCount === 0 || lineCount > config.syntaxHighlight.maxLines) {
    return emptyHighlightedDiffSet();
  }

  const lang = metadata.lang ?? "text";
  const treeSitter = await buildTreeSitterHighlightedDiffAsync(
    metadata,
    indexes,
    lang,
    config,
  );

  let deletionLines = treeSitter?.deletionLines ?? [];
  let additionLines = treeSitter?.additionLines ?? [];
  let deletionStyled = treeSitter?.deletionStyled ?? false;
  let additionStyled = treeSitter?.additionStyled ?? false;
  const supplementDeletion = deletionStyled && shouldSupplementTreeSitterHighlight(
    metadata.deletionLines,
    indexes.deletion,
    deletionLines,
  );
  const supplementAddition = additionStyled && shouldSupplementTreeSitterHighlight(
    metadata.additionLines,
    indexes.addition,
    additionLines,
  );

  if (!deletionStyled || !additionStyled || supplementDeletion || supplementAddition) {
    const textMate = await buildTextMateHighlightedDiffAsync(
      metadata,
      indexes,
      lang,
      config,
      {
        deletion: !deletionStyled || supplementDeletion,
        addition: !additionStyled || supplementAddition,
      },
    );
    if (!deletionStyled && textMate?.deletionStyled) {
      deletionLines = textMate.deletionLines;
      deletionStyled = true;
    } else if (supplementDeletion && textMate?.deletionStyled) {
      deletionLines = supplementHighlightedLines(deletionLines, textMate.deletionLines);
    }
    if (!additionStyled && textMate?.additionStyled) {
      additionLines = textMate.additionLines;
      additionStyled = true;
    } else if (supplementAddition && textMate?.additionStyled) {
      additionLines = supplementHighlightedLines(additionLines, textMate.additionLines);
    }
  }

  if (!deletionStyled && !additionStyled) return emptyHighlightedDiffSet();
  const highlighted = { deletionLines, additionLines };
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

export function needsHighlightedDiffSupplement(
  metadata: FileDiffMetadata,
  highlighted: HighlightedDiffSet,
  config: PierreRendererConfig,
): boolean {
  if (!config.syntaxHighlight.enabled || !hasHighlightedLines(highlighted)) {
    return false;
  }

  const indexes = renderedLineIndexes(metadata);
  const lineCount = indexes.deletion.length + indexes.addition.length;
  if (lineCount === 0 || lineCount > config.syntaxHighlight.maxLines) {
    return false;
  }

  const code = highlighted.dark;
  return (
    shouldSupplementTreeSitterHighlight(
      metadata.deletionLines,
      indexes.deletion,
      code.deletionLines,
    ) ||
    shouldSupplementTreeSitterHighlight(
      metadata.additionLines,
      indexes.addition,
      code.additionLines,
    )
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
        text: displaySafeText(current.value),
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

  // A highlighted line is represented as a mixture of captured syntax spans
  // and plain text spans.  The plain spans are still code, not diff metadata,
  // so they should use the normal syntax foreground instead of inheriting the
  // row foreground (`toolDiffContext` for read/context rows).  Otherwise Rust
  // in particular looks mostly muted because tree-sitter intentionally leaves
  // many ordinary identifiers uncaptured.
  visit(node, { fg: palette.syntaxText });

  return spans.length > 0
    ? spans
    : fallbackText.length > 0
      ? [{ text: fallbackText }]
      : [];
}

type HighlightLineResult = {
  lines: Array<HastNode | undefined>;
  styled: boolean;
};
type TreeSitterDiffSide = "deletion" | "addition";
type TreeSitterWorkerHighlightJob = {
  side: TreeSitterDiffSide;
  documentId: string;
  lines: string[];
  indexes: number[];
};
type TreeSitterWorkerResponse = {
  id?: number;
  jobs?: Array<{ captures?: unknown }>;
  error?: string;
};
type TimerHandle = ReturnType<typeof setTimeout> & {
  ref?: () => void;
  unref?: () => void;
};
type PendingTreeSitterWorkerRequest = {
  resolve: (value: TreeSitterWorkerResponse | undefined) => void;
  timeout: TimerHandle;
};
type TreeSitterWorkerClient = {
  child: ChildProcess;
  nextId: number;
  pending: Map<number, PendingTreeSitterWorkerRequest>;
  idleTimer?: TimerHandle;
};
type PreparedTreeSitterLines = {
  cleanLines: string[];
  lineStyles: Map<number, Array<SyntaxCategory | undefined>>;
};
type PreparedTextMateLines = {
  rawLines: string[];
  displayLines: string[];
  lineStyles: Map<number, Array<SyntaxCategory | undefined>>;
};
type PreparedTreeSitterWorkerJob = PreparedTreeSitterLines & {
  side: TreeSitterDiffSide;
  documentId: string;
};
type HighlightedDiffResult = {
  deletionLines: Array<HastNode | undefined>;
  additionLines: Array<HastNode | undefined>;
  styled: boolean;
  deletionStyled: boolean;
  additionStyled: boolean;
};
type LineRange = { start: number; end: number };
type CaptureStyle = { category: SyntaxCategory; priority: number };

const treeSitterWorkerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "tree-sitter-worker.cjs",
);
const TREE_SITTER_QUERY_RANGE_GAP = 2;
const TREE_SITTER_QUERY_RANGE_END_COLUMN = 0x7fffffff;
const TREE_SITTER_QUERY_FULL_COVERAGE_NUMERATOR = 3;
const TREE_SITTER_QUERY_FULL_COVERAGE_DENOMINATOR = 4;
const TREE_SITTER_WORKER_IDLE_MS = 10_000;
const DEFAULT_TREE_SITTER_WORKER_TIMEOUT_MS = 5_000;
const TEXTMATE_SUPPLEMENT_MIN_LINE_CHARS = 12;
const TEXTMATE_SUPPLEMENT_LOW_COVERAGE_RATIO = 0.24;
const GLOBAL_TREE_SITTER_WORKER_STATE_KEY = "__piRichToolsTreeSitterWorkerState";
const syntaxStyleByCaptureName = Object.create(null) as Record<
  string,
  CaptureStyle | null | undefined
>;

type TreeSitterWorkerState = {
  client?: TreeSitterWorkerClient;
};

function treeSitterWorkerState(): TreeSitterWorkerState {
  const scope = globalThis as typeof globalThis & {
    [GLOBAL_TREE_SITTER_WORKER_STATE_KEY]?: TreeSitterWorkerState;
  };
  scope[GLOBAL_TREE_SITTER_WORKER_STATE_KEY] ??= {};
  return scope[GLOBAL_TREE_SITTER_WORKER_STATE_KEY];
}

export function resetPierreHighlighter(): void {
  resetHighlightWorker();

  const treeSitterClient = treeSitterWorkerState().client;
  if (treeSitterClient) restartTreeSitterWorker(treeSitterClient);
}

function buildTreeSitterHighlightedDiff(
  metadata: FileDiffMetadata,
  indexes: { deletion: number[]; addition: number[] },
  lang: string,
  config: PierreRendererConfig,
): HighlightedDiffResult | undefined {
  const languageKey = treeSitterLanguageKey(lang);
  if (!languageKey) return undefined;

  const deletion = highlightTreeSitterLines(
    languageKey,
    treeSitterDocumentId(metadata, "deletion"),
    metadata.deletionLines,
    indexes.deletion,
    config,
  );
  const addition = highlightTreeSitterLines(
    languageKey,
    treeSitterDocumentId(metadata, "addition"),
    metadata.additionLines,
    indexes.addition,
    config,
  );

  if (!deletion.styled && !addition.styled) return undefined;
  return {
    deletionLines: deletion.lines,
    additionLines: addition.lines,
    styled: true,
    deletionStyled: deletion.styled,
    additionStyled: addition.styled,
  };
}

async function buildTreeSitterHighlightedDiffAsync(
  metadata: FileDiffMetadata,
  indexes: { deletion: number[]; addition: number[] },
  lang: string,
  config: PierreRendererConfig,
): Promise<HighlightedDiffResult | undefined> {
  const languageKey = treeSitterLanguageKey(lang);
  if (!languageKey) return undefined;

  let deletion = emptyHighlightLineResult();
  let addition = emptyHighlightLineResult();
  const workerJobs: TreeSitterWorkerHighlightJob[] = [];
  const forceWorker = envValue("PI_TREE_SITTER_FORCE_WORKER") === "1";

  if (!forceWorker) {
    deletion = highlightTreeSitterLines(
      languageKey,
      treeSitterDocumentId(metadata, "deletion"),
      metadata.deletionLines,
      indexes.deletion,
      config,
    );
    addition = highlightTreeSitterLines(
      languageKey,
      treeSitterDocumentId(metadata, "addition"),
      metadata.additionLines,
      indexes.addition,
      config,
    );
  }

  if (!deletion.styled) {
    workerJobs.push({
      side: "deletion",
      documentId: treeSitterDocumentId(metadata, "deletion"),
      lines: metadata.deletionLines,
      indexes: indexes.deletion,
    });
  }
  if (!addition.styled) {
    workerJobs.push({
      side: "addition",
      documentId: treeSitterDocumentId(metadata, "addition"),
      lines: metadata.additionLines,
      indexes: indexes.addition,
    });
  }

  if (workerJobs.length > 0) {
    const workerResults = await highlightTreeSitterLinesWithWorkerBatch(
      languageKey,
      workerJobs,
      config,
    );
    deletion = workerResults.get("deletion") ?? deletion;
    addition = workerResults.get("addition") ?? addition;
  }

  if (!deletion.styled && !addition.styled) return undefined;
  return {
    deletionLines: deletion.lines,
    additionLines: addition.lines,
    styled: true,
    deletionStyled: deletion.styled,
    additionStyled: addition.styled,
  };
}

async function buildTextMateHighlightedDiffAsync(
  metadata: FileDiffMetadata,
  indexes: { deletion: number[]; addition: number[] },
  lang: string,
  config: PierreRendererConfig,
  sides: { deletion: boolean; addition: boolean },
): Promise<HighlightedDiffResult | undefined> {
  const [deletion, addition] = await Promise.all([
    sides.deletion
      ? highlightTextMateLines(lang, metadata.deletionLines, indexes.deletion, config)
      : Promise.resolve(emptyHighlightLineResult()),
    sides.addition
      ? highlightTextMateLines(lang, metadata.additionLines, indexes.addition, config)
      : Promise.resolve(emptyHighlightLineResult()),
  ]);

  if (!deletion.styled && !addition.styled) return undefined;
  return {
    deletionLines: deletion.lines,
    additionLines: addition.lines,
    styled: true,
    deletionStyled: deletion.styled,
    additionStyled: addition.styled,
  };
}

function treeSitterDocumentId(
  metadata: FileDiffMetadata,
  side: TreeSitterDiffSide,
): string {
  const path = side === "deletion" ? metadata.prevName ?? metadata.name : metadata.name;
  return `${side}:${path}`;
}

function highlightTreeSitterLines(
  languageKey: string,
  documentId: string,
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

  const captures = querySharedSyntaxCaptures({
    documentId,
    languageKey,
    text: cleanLines.join("\n"),
    ranges: treeSitterQueryRangesForStyledRanges(lineStyles, cleanLines.length),
  });
  if (!captures) {
    return { lines: [], styled: false };
  }

  paintCaptures(cleanLines, lineStyles, captures);
  return highlightedLinesFromStyles(cleanLines, lineStyles);
}

async function highlightTextMateLines(
  lang: string,
  lines: string[],
  indexes: number[],
  config: PierreRendererConfig,
): Promise<HighlightLineResult> {
  if (lines.length === 0 || indexes.length === 0) {
    return { lines: [], styled: false };
  }

  const prepared = prepareTextMateLines(lines, indexes, config);
  if (!prepared) return { lines: [], styled: false };
  const { rawLines, displayLines, lineStyles } = prepared;
  const lastStyledLine = Math.max(...lineStyles.keys());

  const spans = await queryTextMateSyntaxSpans({
    lang,
    lines: rawLines.slice(0, lastStyledLine + 1),
    maxLineLength: config.syntaxHighlight.maxLineLength,
  });
  if (!spans) return { lines: [], styled: false };

  paintTextMateSpans(rawLines, lineStyles, spans);
  return highlightedLinesFromStyles(displayLines, lineStyles);
}

async function highlightTreeSitterLinesWithWorkerBatch(
  languageKey: string,
  jobs: TreeSitterWorkerHighlightJob[],
  config: PierreRendererConfig,
): Promise<Map<TreeSitterDiffSide, HighlightLineResult>> {
  const results = new Map<TreeSitterDiffSide, HighlightLineResult>();
  const preparedJobs: PreparedTreeSitterWorkerJob[] = [];

  for (const job of jobs) {
    if (job.lines.length === 0 || job.indexes.length === 0) {
      results.set(job.side, emptyHighlightLineResult());
      continue;
    }

    const prepared = prepareTreeSitterLines(job.lines, job.indexes, config);
    if (!prepared) {
      results.set(job.side, emptyHighlightLineResult());
      continue;
    }

    preparedJobs.push({ side: job.side, documentId: job.documentId, ...prepared });
  }

  if (preparedJobs.length === 0) return results;

  const captureSets = await treeSitterWorkerCapturesBatch(
    languageKey,
    preparedJobs.map((job) => ({
      documentId: job.documentId,
      lines: job.cleanLines,
      indexes: [...job.lineStyles.keys()],
    })),
  );

  for (let index = 0; index < preparedJobs.length; index++) {
    const job = preparedJobs[index]!;
    const captures = captureSets?.[index];
    if (!captures) {
      results.set(job.side, emptyHighlightLineResult());
      continue;
    }

    paintCaptures(job.cleanLines, job.lineStyles, captures);
    results.set(job.side, highlightedLinesFromStyles(job.cleanLines, job.lineStyles));
  }

  return results;
}

function highlightedLinesFromStyles(
  cleanLines: string[],
  lineStyles: Map<number, Array<SyntaxCategory | undefined>>,
): HighlightLineResult {
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

function shouldSupplementTreeSitterHighlight(
  lines: string[],
  indexes: number[],
  highlightedLines: Array<HastNode | undefined>,
): boolean {
  for (const index of indexes) {
    const line = cleanDiffLine(lines[index]);
    const total = countNonWhitespace(line);
    if (total < TEXTMATE_SUPPLEMENT_MIN_LINE_CHARS) continue;

    const node = highlightedLines[index];
    const styled = node ? syntaxLineStyleInfo(node).styledNonWhitespace : 0;
    if (styled / total < TEXTMATE_SUPPLEMENT_LOW_COVERAGE_RATIO) return true;
  }

  return false;
}

function supplementHighlightedLines(
  primaryLines: Array<HastNode | undefined>,
  supplementLines: Array<HastNode | undefined>,
): Array<HastNode | undefined> {
  const length = Math.max(primaryLines.length, supplementLines.length);
  const out = primaryLines.slice();

  for (let index = 0; index < length; index++) {
    const primary = primaryLines[index];
    const supplement = supplementLines[index];
    if (!supplement) continue;
    if (!primary) {
      out[index] = supplement;
      continue;
    }

    const primaryInfo = syntaxLineStyleInfo(primary);
    const supplementInfo = syntaxLineStyleInfo(supplement);
    if (primaryInfo.text !== supplementInfo.text) continue;

    const styles = primaryInfo.styles.slice();
    let changed = false;
    for (let offset = 0; offset < styles.length; offset++) {
      if (styles[offset] || !supplementInfo.styles[offset]) continue;
      styles[offset] = supplementInfo.styles[offset];
      changed = true;
    }

    if (changed) {
      out[index] = syntaxSpansNode(spansFromLineStyles(primaryInfo.text, styles));
    }
  }

  return out;
}

function syntaxLineStyleInfo(node: HastNode): {
  text: string;
  styles: Array<SyntaxCategory | undefined>;
  styledNonWhitespace: number;
} {
  let text = "";
  const styles: Array<SyntaxCategory | undefined> = [];
  let styledNonWhitespace = 0;

  const visit = (current: HastNode | undefined, inherited?: SyntaxCategory) => {
    if (!current) return;

    if (current.type === "text") {
      text += current.value;
      for (let offset = 0; offset < current.value.length;) {
        const codePoint = current.value.codePointAt(offset);
        const width = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
        const char = current.value.slice(offset, offset + width);
        for (let index = 0; index < width; index++) styles.push(inherited);
        if (inherited && !isWhitespace(char)) styledNonWhitespace += 1;
        offset += width;
      }
      return;
    }

    const category = normalizeSyntaxCategory(
      current.properties?.["data-pi-syntax"],
    ) ?? inherited;
    for (const child of current.children ?? []) visit(child, category);
  };

  visit(node);
  return { text, styles, styledNonWhitespace };
}

function countNonWhitespace(text: string): number {
  let count = 0;
  for (const char of text) {
    if (!isWhitespace(char)) count += 1;
  }
  return count;
}

function isWhitespace(char: string): boolean {
  return /\s/u.test(char);
}

function emptyHighlightLineResult(): HighlightLineResult {
  return { lines: [], styled: false };
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

function prepareTextMateLines(
  lines: string[],
  indexes: number[],
  config: PierreRendererConfig,
): PreparedTextMateLines | undefined {
  const rawLines = lines.map(cleanRawDiffLine);
  const displayLines = rawLines.map(displaySafeText);
  const lineStyles = new Map<number, Array<SyntaxCategory | undefined>>();
  for (const index of indexes) {
    const line = displayLines[index] ?? "";
    if (line.length > config.syntaxHighlight.maxLineLength) continue;
    lineStyles.set(index, new Array<SyntaxCategory | undefined>(line.length));
  }
  return lineStyles.size === 0
    ? undefined
    : { rawLines, displayLines, lineStyles };
}

function treeSitterQueryRangesForStyledRanges(
  lineStyles: Map<number, Array<SyntaxCategory | undefined>>,
  lineCount: number,
): TreeSitterRange[] | undefined {
  const ranges = styledLineRanges(lineStyles, lineCount);
  if (ranges.length === 0) return [];
  if (shouldQueryFullTree(ranges, lineCount)) {
    return undefined;
  }

  return ranges.map((range) => ({
    startPosition: { row: range.start, column: 0 },
    endPosition: {
      row: range.end,
      column: TREE_SITTER_QUERY_RANGE_END_COLUMN,
    },
  }));
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

function paintTextMateSpans(
  rawLines: string[],
  lineStyles: Map<number, Array<SyntaxCategory | undefined>>,
  spans: TextMateSyntaxSpan[],
): void {
  for (const span of spans) {
    const styles = lineStyles.get(span.row);
    if (!styles) continue;

    const line = rawLines[span.row] ?? "";
    const start = rawColumnToDisplayIndex(line, span.startColumn);
    const end = rawColumnToDisplayIndex(line, span.endColumn);
    for (let index = start; index < end && index < styles.length; index++) {
      styles[index] = span.category;
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

async function treeSitterWorkerCapturesBatch(
  languageKey: string,
  jobs: Array<{ documentId: string; lines: string[]; indexes: number[] }>,
): Promise<Array<TreeSitterCapture[] | undefined> | undefined> {
  if (jobs.length === 0) return [];

  try {
    return normalizeTreeSitterWorkerJobs(
      await treeSitterWorkerRequest(languageKey, jobs),
    );
  } catch {
    return undefined;
  }
}

function normalizeTreeSitterWorkerJobs(
  response: TreeSitterWorkerResponse | undefined,
): Array<TreeSitterCapture[] | undefined> | undefined {
  if (!response || !Array.isArray(response.jobs)) return undefined;
  return response.jobs.map((job) => {
    if (!job || typeof job !== "object") return undefined;
    const captures = (job as { captures?: unknown }).captures;
    if (!Array.isArray(captures)) return undefined;
    return captures
      .map(normalizeWorkerCapture)
      .filter((capture): capture is TreeSitterCapture => Boolean(capture));
  });
}

function treeSitterWorkerRequest(
  languageKey: string,
  jobs: Array<{ documentId: string; lines: string[]; indexes: number[] }>,
): Promise<TreeSitterWorkerResponse | undefined> {
  const client = getTreeSitterWorkerClient();
  const child = client.child;
  const requestId = client.nextId++;

  refTreeSitterWorker(client);
  if (client.idleTimer) clearTimeout(client.idleTimer);
  client.idleTimer = undefined;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      client.pending.delete(requestId);
      resolve(undefined);
      restartTreeSitterWorker(client);
    }, treeSitterWorkerTimeoutMs()) as TimerHandle;
    timeout.unref?.();

    client.pending.set(requestId, { resolve, timeout });

    try {
      child.send?.({ id: requestId, languageKey, jobs }, (error: Error | null) => {
        if (!error) return;
        const pending = client.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        client.pending.delete(requestId);
        pending.resolve(undefined);
        maybeUnrefTreeSitterWorker(client);
      });
    } catch {
      const pending = client.pending.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      client.pending.delete(requestId);
      pending.resolve(undefined);
      maybeUnrefTreeSitterWorker(client);
    }
  });
}

function getTreeSitterWorkerClient(): TreeSitterWorkerClient {
  const state = treeSitterWorkerState();
  if (state.client) return state.client;

  const execPath = treeSitterWorkerNodePath();
  const child = fork(treeSitterWorkerPath, [], {
    ...(execPath ? { execPath } : {}),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const client: TreeSitterWorkerClient = {
    child,
    nextId: 1,
    pending: new Map(),
  };
  state.client = client;

  child.on("message", (message: unknown) => {
    const response = normalizeTreeSitterWorkerResponse(message);
    if (!response || typeof response.id !== "number") return;

    const pending = client.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    client.pending.delete(response.id);
    pending.resolve(response.error ? undefined : response);
    maybeUnrefTreeSitterWorker(client);
  });
  child.on("exit", () => {
    if (treeSitterWorkerState().client === client) {
      treeSitterWorkerState().client = undefined;
    }
    for (const pending of client.pending.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(undefined);
    }
    client.pending.clear();
  });
  child.on("error", () => {
    restartTreeSitterWorker(client);
  });

  maybeUnrefTreeSitterWorker(client);
  return client;
}

function normalizeTreeSitterWorkerResponse(
  message: unknown,
): TreeSitterWorkerResponse | undefined {
  if (!message || typeof message !== "object") return undefined;
  const response = message as TreeSitterWorkerResponse;
  if (response.id !== undefined && typeof response.id !== "number") return undefined;
  return response;
}

function restartTreeSitterWorker(client: TreeSitterWorkerClient): void {
  if (treeSitterWorkerState().client === client) {
    treeSitterWorkerState().client = undefined;
  }
  if (client.idleTimer) clearTimeout(client.idleTimer);
  for (const pending of client.pending.values()) {
    clearTimeout(pending.timeout);
    pending.resolve(undefined);
  }
  client.pending.clear();
  client.child.kill();
}

function refTreeSitterWorker(client: TreeSitterWorkerClient): void {
  client.child.ref?.();
  client.child.channel?.ref?.();
}

function maybeUnrefTreeSitterWorker(client: TreeSitterWorkerClient): void {
  if (client.pending.size > 0) return;
  client.child.unref?.();
  client.child.channel?.unref?.();

  if (client.idleTimer) clearTimeout(client.idleTimer);
  client.idleTimer = setTimeout(() => {
    if (client.pending.size === 0) restartTreeSitterWorker(client);
  }, TREE_SITTER_WORKER_IDLE_MS) as TimerHandle;
  client.idleTimer.unref?.();
}

function treeSitterWorkerNodePath(): string | undefined {
  return envValue("PI_TREE_SITTER_NODE") ?? "node";
}

function treeSitterWorkerTimeoutMs(): number {
  const raw = envValue("PI_TREE_SITTER_WORKER_TIMEOUT_MS");
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_TREE_SITTER_WORKER_TIMEOUT_MS;
}

function envValue(name: string): string | undefined {
  return (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env?.[name];
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
    const start = row === startRow ? treeSitterColumnToStringIndex(line, node.startPosition.column) : 0;
    const end = row === endRow ? treeSitterColumnToStringIndex(line, node.endPosition.column) : line.length;
    for (let i = start; i < end; i++) styles[i] = category;
  }
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
  return displaySafeText(cleanLastNewline(line ?? "").replace(/\r$/, ""));
}

function cleanRawDiffLine(line: string | undefined): string {
  return cleanLastNewline(line ?? "").replace(/\r$/, "");
}

function rawColumnToDisplayIndex(line: string, column: number): number {
  const end = Math.max(0, Math.min(column, line.length));
  let displayIndex = 0;
  for (let index = 0; index < end;) {
    const codePoint = line.codePointAt(index);
    if (codePoint === undefined) break;
    if (codePoint === 0x09) {
      displayIndex += 4;
      index += 1;
      continue;
    }

    const width = codePoint > 0xffff ? 2 : 1;
    displayIndex += width;
    index += width;
  }
  return displayIndex;
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

function displaySafeText(text: string): string {
  return visualizeControlCharacters(tabify(text));
}

// Raw C0 controls can move the terminal cursor while the TUI still accounts
// for one rendered row. Show them as Unicode Control Pictures instead.
function visualizeControlCharacters(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, (char) => {
    const code = char.charCodeAt(0);
    return code === 0x7f
      ? "\u2421"
      : String.fromCharCode(0x2400 + code);
  });
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
