import type { FileDiffMetadata } from "../../node_modules/@pierre/diffs/dist/types.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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

export async function loadHighlightedDiff(
  metadata: FileDiffMetadata,
  config: PierreRendererConfig,
  theme?: PiThemeLike,
): Promise<HighlightedDiffSet> {
  return buildPiHighlightedDiffAsync(metadata, config, theme);
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
  parsers: Map<string, TreeSitterParser>;
};
type TreeSitterLanguageSpec = {
  key: string;
  packageName: string;
  exportName?: string;
  queryPaths: string[];
};
type HighlightLineResult = {
  lines: Array<HastNode | undefined>;
  styled: boolean;
};
type TreeSitterDiffSide = "deletion" | "addition";
type TreeSitterWorkerHighlightJob = {
  side: TreeSitterDiffSide;
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
type PreparedTreeSitterWorkerJob = PreparedTreeSitterLines & {
  side: TreeSitterDiffSide;
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
const TREE_SITTER_WORKER_IDLE_MS = 10_000;
const DEFAULT_TREE_SITTER_WORKER_TIMEOUT_MS = 5_000;
let treeSitterRuntime: TreeSitterRuntime | null | undefined;
const treeSitterQueryCache = new Map<string, TreeSitterQuery>();
const syntaxStyleByCaptureName = Object.create(null) as Record<
  string,
  CaptureStyle | null | undefined
>;
let treeSitterWorkerClient: TreeSitterWorkerClient | undefined;

const TREE_SITTER_LANGUAGE_SPECS: TreeSitterLanguageSpec[] = [
  {
    key: "javascript",
    packageName: "tree-sitter-javascript",
    queryPaths: ["tree-sitter-javascript/queries/highlights.scm"],
  },
  {
    key: "typescript",
    packageName: "tree-sitter-typescript",
    exportName: "typescript",
    queryPaths: [
      "tree-sitter-javascript/queries/highlights.scm",
      "tree-sitter-typescript/queries/highlights.scm",
    ],
  },
  {
    key: "tsx",
    packageName: "tree-sitter-typescript",
    exportName: "tsx",
    queryPaths: [
      "tree-sitter-javascript/queries/highlights.scm",
      "tree-sitter-typescript/queries/highlights.scm",
    ],
  },
  languageSpec("python", "tree-sitter-python"),
  languageSpec("rust", "tree-sitter-rust"),
  languageSpec("c", "tree-sitter-c"),
  languageSpec("cpp", "tree-sitter-cpp"),
  languageSpec("zig", "@tree-sitter-grammars/tree-sitter-zig"),
  languageSpec("json", "tree-sitter-json"),
  languageSpec("yaml", "@tree-sitter-grammars/tree-sitter-yaml"),
  languageSpec("toml", "@tree-sitter-grammars/tree-sitter-toml"),
  languageSpec("julia", "tree-sitter-julia"),
  languageSpec("haskell", "tree-sitter-haskell"),
  languageSpec("bash", "tree-sitter-bash"),
  languageSpec("go", "tree-sitter-go"),
  languageSpec("java", "tree-sitter-java"),
  languageSpec("ruby", "tree-sitter-ruby"),
  languageSpec("php", "tree-sitter-php", "php"),
  languageSpec("css", "tree-sitter-css"),
  languageSpec("html", "tree-sitter-html"),
  languageSpec("regex", "tree-sitter-regex"),
];

function languageSpec(
  key: string,
  packageName: string,
  exportName?: string,
): TreeSitterLanguageSpec {
  return {
    key,
    packageName,
    exportName,
    queryPaths: [`${packageName}/queries/highlights.scm`],
  };
}

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
  if (!runtime || !language || !querySource) return undefined;

  const deletion = highlightTreeSitterLines(
    runtime,
    languageKey,
    language,
    querySource,
    metadata.deletionLines,
    indexes.deletion,
    config,
  );
  const addition = highlightTreeSitterLines(
    runtime,
    languageKey,
    language,
    querySource,
    metadata.additionLines,
    indexes.addition,
    config,
  );

  if (!deletion.styled && !addition.styled) return undefined;
  return {
    deletionLines: deletion.lines,
    additionLines: addition.lines,
    styled: true,
  };
}

async function buildTreeSitterHighlightedDiffAsync(
  metadata: FileDiffMetadata,
  indexes: { deletion: number[]; addition: number[] },
  lang: string,
  config: PierreRendererConfig,
): Promise<
  | {
      deletionLines: Array<HastNode | undefined>;
      additionLines: Array<HastNode | undefined>;
      styled: boolean;
    }
  | undefined
> {
  const languageKey = treeSitterLanguageKey(lang);
  if (!languageKey) return undefined;

  let deletion = emptyHighlightLineResult();
  let addition = emptyHighlightLineResult();
  const workerJobs: TreeSitterWorkerHighlightJob[] = [];
  const forceWorker = envValue("PI_TREE_SITTER_FORCE_WORKER") === "1";

  if (!forceWorker) {
    const runtime = getTreeSitterRuntime();
    const language = runtime?.languages.get(languageKey);
    const querySource = runtime?.queries.get(languageKey);

    if (runtime && language && querySource) {
      deletion = highlightTreeSitterLines(
        runtime,
        languageKey,
        language,
        querySource,
        metadata.deletionLines,
        indexes.deletion,
        config,
      );
      addition = highlightTreeSitterLines(
        runtime,
        languageKey,
        language,
        querySource,
        metadata.additionLines,
        indexes.addition,
        config,
      );
    }
  }

  if (!deletion.styled) {
    workerJobs.push({
      side: "deletion",
      lines: metadata.deletionLines,
      indexes: indexes.deletion,
    });
  }
  if (!addition.styled) {
    workerJobs.push({
      side: "addition",
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
  };
}

function getTreeSitterRuntime(): TreeSitterRuntime | undefined {
  if (treeSitterRuntime !== undefined) return treeSitterRuntime ?? undefined;

  try {
    const Parser = nodeRequire("tree-sitter") as TreeSitterParserConstructor;
    const languages = new Map<string, TreeSitterLanguage>();
    const queries = new Map<string, string>();

    for (const spec of TREE_SITTER_LANGUAGE_SPECS) {
      languages.set(spec.key, loadTreeSitterLanguage(spec));
      queries.set(spec.key, loadTreeSitterQuerySource(spec));
    }

    treeSitterRuntime = {
      Parser,
      languages,
      queries,
      parsers: new Map<string, TreeSitterParser>(),
    };
  } catch {
    treeSitterRuntime = null;
  }

  return treeSitterRuntime ?? undefined;
}

function loadTreeSitterLanguage(spec: TreeSitterLanguageSpec): TreeSitterLanguage {
  const module = nodeRequire(spec.packageName) as Record<string, unknown>;
  const language = spec.exportName ? module[spec.exportName] : module;
  if (!language) throw new Error(`missing tree-sitter grammar: ${spec.key}`);
  return language as TreeSitterLanguage;
}

function loadTreeSitterQuerySource(spec: TreeSitterLanguageSpec): string {
  return spec.queryPaths.map(readTreeSitterQuerySource).join("\n");
}

function readTreeSitterQuerySource(queryPath: string): string {
  return sanitizeTreeSitterQuerySource(
    readFileSync(nodeRequire.resolve(queryPath), "utf8"),
  );
}

function sanitizeTreeSitterQuerySource(source: string): string {
  return source
    .replaceAll("#lua-match?", "#match?")
    .split("\n")
    .map((line) => {
      if (!line.includes("#has-ancestor?")) return line;
      const balance = parenBalance(line);
      return balance < 0 ? ")".repeat(-balance) : "";
    })
    .join("\n");
}

function parenBalance(line: string): number {
  let balance = 0;
  for (const char of line) {
    if (char === "(") balance += 1;
    else if (char === ")") balance -= 1;
  }
  return balance;
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
  if (normalized === "python" || normalized === "py") return "python";
  if (normalized === "rust" || normalized === "rs") return "rust";
  if (normalized === "c" || normalized === "objective-c") return "c";
  if (
    normalized === "cpp" ||
    normalized === "c++" ||
    normalized === "cc" ||
    normalized === "cxx" ||
    normalized === "hpp" ||
    normalized === "objective-cpp"
  ) {
    return "cpp";
  }
  if (normalized === "zig") return "zig";
  if (normalized === "json" || normalized === "jsonc") return "json";
  if (normalized === "yaml" || normalized === "yml") return "yaml";
  if (normalized === "toml") return "toml";
  if (normalized === "julia" || normalized === "jl") return "julia";
  if (normalized === "haskell" || normalized === "hs") return "haskell";
  if (
    normalized === "bash" ||
    normalized === "sh" ||
    normalized === "shell" ||
    normalized === "zsh"
  ) {
    return "bash";
  }
  if (normalized === "go" || normalized === "golang") return "go";
  if (normalized === "java") return "java";
  if (normalized === "ruby" || normalized === "rb") return "ruby";
  if (normalized === "php") return "php";
  if (normalized === "css") return "css";
  if (normalized === "html") return "html";
  if (normalized === "regex" || normalized === "regexp") return "regex";
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
    const parser = treeSitterParser(runtime, languageKey, language);
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
    runtime.parsers.delete(languageKey);
    return { lines: [], styled: false };
  }

  return highlightedLinesFromStyles(cleanLines, lineStyles);
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

    preparedJobs.push({ side: job.side, ...prepared });
  }

  if (preparedJobs.length === 0) return results;

  const captureSets = await treeSitterWorkerCapturesBatch(
    languageKey,
    preparedJobs.map((job) => ({
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

async function treeSitterWorkerCapturesBatch(
  languageKey: string,
  jobs: Array<{ lines: string[]; indexes: number[] }>,
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
  jobs: Array<{ lines: string[]; indexes: number[] }>,
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
  if (treeSitterWorkerClient) return treeSitterWorkerClient;

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
  treeSitterWorkerClient = client;

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
    if (treeSitterWorkerClient === client) treeSitterWorkerClient = undefined;
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
  if (treeSitterWorkerClient === client) treeSitterWorkerClient = undefined;
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
  return envValue("PI_TREE_SITTER_NODE");
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

function treeSitterParser(
  runtime: TreeSitterRuntime,
  languageKey: string,
  language: TreeSitterLanguage,
): TreeSitterParser {
  const cached = runtime.parsers.get(languageKey);
  if (cached) return cached;

  const parser = new runtime.Parser();
  parser.setLanguage(language);
  runtime.parsers.set(languageKey, parser);
  return parser;
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
