import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export type TreeSitterLanguageKey = string;
export type TreeSitterPoint = { row: number; column: number };
export type TreeSitterRange = {
  startPosition: TreeSitterPoint;
  endPosition: TreeSitterPoint;
};
export type TreeSitterNode = {
  text: string;
  startPosition: TreeSitterPoint;
  endPosition: TreeSitterPoint;
};
export type TreeSitterCapture = { name: string; node: TreeSitterNode };
export type SharedSyntaxCaptureRequest = {
  documentId?: string;
  languageKey: TreeSitterLanguageKey;
  text: string;
  ranges?: TreeSitterRange[];
};
export type SharedSyntaxServiceStats = {
  documents: number;
  fullParses: number;
  incrementalParses: number;
  reusedParses: number;
  evictions: number;
};

type TreeSitterLanguage = unknown;
type TreeSitterEdit = {
  startIndex: number;
  oldEndIndex: number;
  newEndIndex: number;
  startPosition: TreeSitterPoint;
  oldEndPosition: TreeSitterPoint;
  newEndPosition: TreeSitterPoint;
};
type TreeSitterTree = {
  rootNode: unknown;
  edit?: (edit: TreeSitterEdit) => TreeSitterTree;
};
type TreeSitterQueryOptions = {
  startPosition?: TreeSitterPoint;
  endPosition?: TreeSitterPoint;
  matchLimit?: number;
};
type TreeSitterQuery = {
  captures: (
    node: unknown,
    options?: TreeSitterQueryOptions,
  ) => TreeSitterCapture[];
};
type TreeSitterParser = {
  setLanguage: (language: TreeSitterLanguage) => void;
  reset?: () => void;
  parse: (code: string, oldTree?: TreeSitterTree | null) => TreeSitterTree | null;
};
type TreeSitterParserConstructor = {
  new (): TreeSitterParser;
  Query: new (language: TreeSitterLanguage, source: string) => TreeSitterQuery;
};
type TreeSitterRuntime = {
  Parser: TreeSitterParserConstructor;
  languages: Map<string, TreeSitterLanguage>;
  querySources: Map<string, string>;
  queries: Map<string, TreeSitterQuery>;
  parsers: Map<string, TreeSitterParser>;
  failedLanguages: Set<string>;
};
type TreeSitterLanguageSpec = {
  key: string;
  packageName: string;
  exportName?: string;
  queryPaths: string[];
};
type SyntaxDocumentSnapshot = {
  cacheKey: string;
  languageKey: string;
  text: string;
  tree: TreeSitterTree;
};
type SharedSyntaxServiceState = {
  runtime: TreeSitterRuntime | null | undefined;
  documents: Map<string, SyntaxDocumentSnapshot>;
  stats: {
    fullParses: number;
    incrementalParses: number;
    reusedParses: number;
    evictions: number;
  };
};
type TextExtent = {
  index: number;
  position: TreeSitterPoint;
};

const nodeRequire = createRequire(import.meta.url);
const QUERY_MATCH_LIMIT = 64;
const SYNTAX_DOCUMENT_CACHE_LIMIT = 64;
const GLOBAL_SHARED_SYNTAX_SERVICE_STATE_KEY = "__piRichToolsSharedSyntaxServiceState";

function sharedSyntaxServiceState(): SharedSyntaxServiceState {
  const scope = globalThis as typeof globalThis & {
    [GLOBAL_SHARED_SYNTAX_SERVICE_STATE_KEY]?: SharedSyntaxServiceState;
  };
  scope[GLOBAL_SHARED_SYNTAX_SERVICE_STATE_KEY] ??= {
    runtime: undefined,
    documents: new Map<string, SyntaxDocumentSnapshot>(),
    stats: {
      fullParses: 0,
      incrementalParses: 0,
      reusedParses: 0,
      evictions: 0,
    },
  };
  return scope[GLOBAL_SHARED_SYNTAX_SERVICE_STATE_KEY];
}

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

export function querySharedSyntaxCaptures(
  request: SharedSyntaxCaptureRequest,
): TreeSitterCapture[] | undefined {
  if (request.text.length === 0) return [];

  const state = sharedSyntaxServiceState();
  const runtime = getTreeSitterRuntime(state);
  const language = runtime ? getTreeSitterLanguage(runtime, request.languageKey) : undefined;
  if (!runtime || !language) return undefined;

  const tree = parseSyntaxDocument(
    state,
    runtime,
    request.languageKey,
    language,
    request.documentId,
    request.text,
  );
  if (!tree) return undefined;

  const query = treeSitterQuery(runtime, request.languageKey, language);
  if (!query) return undefined;

  return queryCaptures(query, tree.rootNode, request.ranges);
}

export function treeSitterLanguageKey(lang: string): string | undefined {
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

export function sharedSyntaxServiceStats(): SharedSyntaxServiceStats {
  const state = sharedSyntaxServiceState();
  return {
    documents: state.documents.size,
    fullParses: state.stats.fullParses,
    incrementalParses: state.stats.incrementalParses,
    reusedParses: state.stats.reusedParses,
    evictions: state.stats.evictions,
  };
}

export function resetSharedSyntaxService(): void {
  const state = sharedSyntaxServiceState();
  state.documents.clear();
  state.stats.fullParses = 0;
  state.stats.incrementalParses = 0;
  state.stats.reusedParses = 0;
  state.stats.evictions = 0;
  state.runtime = undefined;
}

export function resetSharedSyntaxServiceForTests(): void {
  resetSharedSyntaxService();
}

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

function getTreeSitterRuntime(
  state: SharedSyntaxServiceState,
): TreeSitterRuntime | undefined {
  if (state.runtime !== undefined) return state.runtime ?? undefined;

  try {
    state.runtime = {
      Parser: nodeRequire("tree-sitter") as TreeSitterParserConstructor,
      languages: new Map(),
      querySources: new Map(),
      queries: new Map(),
      parsers: new Map(),
      failedLanguages: new Set(),
    };
  } catch {
    state.runtime = null;
  }

  return state.runtime ?? undefined;
}

function getTreeSitterLanguage(
  runtime: TreeSitterRuntime,
  languageKey: string,
): TreeSitterLanguage | undefined {
  const cached = runtime.languages.get(languageKey);
  if (cached) return cached;
  if (runtime.failedLanguages.has(languageKey)) return undefined;

  const spec = TREE_SITTER_LANGUAGE_SPECS.find((candidate) => candidate.key === languageKey);
  if (!spec) return undefined;

  try {
    const module = nodeRequire(spec.packageName) as Record<string, unknown>;
    const language = spec.exportName ? module[spec.exportName] : module;
    if (!language) throw new Error(`missing tree-sitter grammar: ${languageKey}`);

    runtime.languages.set(languageKey, language as TreeSitterLanguage);
    runtime.querySources.set(languageKey, loadTreeSitterQuerySource(spec));
    return language as TreeSitterLanguage;
  } catch {
    runtime.failedLanguages.add(languageKey);
    return undefined;
  }
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

function parseSyntaxDocument(
  state: SharedSyntaxServiceState,
  runtime: TreeSitterRuntime,
  languageKey: string,
  language: TreeSitterLanguage,
  documentId: string | undefined,
  text: string,
): TreeSitterTree | undefined {
  const parser = treeSitterParser(runtime, languageKey, language);
  const cacheKey = documentId ? `${languageKey}\0${documentId}` : undefined;
  const canReuse = Boolean(cacheKey) && envValue("PI_TREE_SITTER_DISABLE_INCREMENTAL") !== "1";
  const cached = canReuse && cacheKey ? state.documents.get(cacheKey) : undefined;

  if (cached && cached.text === text) {
    state.stats.reusedParses += 1;
    touchSyntaxDocument(state, cacheKey!, cached);
    return cached.tree;
  }

  try {
    let tree: TreeSitterTree | null;
    if (cached) {
      cached.tree.edit?.(treeSitterEditForTextChange(cached.text, text));
      parser.reset?.();
      tree = parser.parse(text, cached.tree);
      state.stats.incrementalParses += 1;
    } else {
      parser.reset?.();
      tree = parser.parse(text);
      state.stats.fullParses += 1;
    }

    if (!tree) throw new Error("tree-sitter parse returned null");
    if (canReuse && cacheKey) {
      rememberSyntaxDocument(state, { cacheKey, languageKey, text, tree });
    }
    return tree;
  } catch {
    runtime.parsers.delete(languageKey);
    if (cacheKey) state.documents.delete(cacheKey);
    return undefined;
  }
}

function touchSyntaxDocument(
  state: SharedSyntaxServiceState,
  cacheKey: string,
  snapshot: SyntaxDocumentSnapshot,
): void {
  state.documents.delete(cacheKey);
  state.documents.set(cacheKey, snapshot);
}

function rememberSyntaxDocument(
  state: SharedSyntaxServiceState,
  snapshot: SyntaxDocumentSnapshot,
): void {
  state.documents.delete(snapshot.cacheKey);
  state.documents.set(snapshot.cacheKey, snapshot);

  while (state.documents.size > syntaxDocumentCacheLimit()) {
    const oldestKey = state.documents.keys().next().value;
    if (typeof oldestKey !== "string") break;
    state.documents.delete(oldestKey);
    state.stats.evictions += 1;
  }
}

function syntaxDocumentCacheLimit(): number {
  const raw = envValue("PI_TREE_SITTER_DOCUMENT_CACHE_LIMIT");
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : SYNTAX_DOCUMENT_CACHE_LIMIT;
}

function treeSitterQuery(
  runtime: TreeSitterRuntime,
  languageKey: string,
  language: TreeSitterLanguage,
): TreeSitterQuery | undefined {
  const cached = runtime.queries.get(languageKey);
  if (cached) return cached;

  const querySource = runtime.querySources.get(languageKey);
  if (!querySource) return undefined;

  try {
    const query = new runtime.Parser.Query(language, querySource);
    runtime.queries.set(languageKey, query);
    return query;
  } catch {
    return undefined;
  }
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

function queryCaptures(
  query: TreeSitterQuery,
  rootNode: unknown,
  ranges: TreeSitterRange[] | undefined,
): TreeSitterCapture[] {
  if (!ranges || ranges.length === 0) {
    return query.captures(rootNode, { matchLimit: QUERY_MATCH_LIMIT });
  }

  try {
    const captures: TreeSitterCapture[] = [];
    const seen = new Set<string>();
    for (const range of ranges) {
      for (const capture of query.captures(rootNode, {
        startPosition: range.startPosition,
        endPosition: range.endPosition,
        matchLimit: QUERY_MATCH_LIMIT,
      })) {
        const key = captureKey(capture);
        if (seen.has(key)) continue;
        seen.add(key);
        captures.push(capture);
      }
    }
    return captures;
  } catch {
    return query.captures(rootNode, { matchLimit: QUERY_MATCH_LIMIT });
  }
}

function captureKey(capture: TreeSitterCapture): string {
  return [
    capture.name,
    capture.node.startPosition.row,
    capture.node.startPosition.column,
    capture.node.endPosition.row,
    capture.node.endPosition.column,
  ].join(":");
}

function treeSitterEditForTextChange(oldText: string, newText: string): TreeSitterEdit {
  const [start, oldEnd, newEnd] = changedTextRange(oldText, newText);
  const startExtent = textExtent(oldText, start);
  const oldEndExtent = textExtent(oldText, oldEnd);
  const newEndExtent = textExtent(newText, newEnd);

  return {
    startIndex: startExtent.index,
    oldEndIndex: oldEndExtent.index,
    newEndIndex: newEndExtent.index,
    startPosition: startExtent.position,
    oldEndPosition: oldEndExtent.position,
    newEndPosition: newEndExtent.position,
  };
}

function changedTextRange(oldText: string, newText: string): [number, number, number] {
  const minLength = Math.min(oldText.length, newText.length);
  let start = 0;
  while (start < minLength && oldText.charCodeAt(start) === newText.charCodeAt(start)) {
    start++;
  }
  start = avoidSplitSurrogate(oldText, start);
  start = avoidSplitSurrogate(newText, start);

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }

  oldEnd = avoidSplitSurrogate(oldText, oldEnd);
  newEnd = avoidSplitSurrogate(newText, newEnd);
  return [start, oldEnd, newEnd];
}

function avoidSplitSurrogate(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const previous = text.charCodeAt(index - 1);
  const current = text.charCodeAt(index);
  if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
    return index - 1;
  }
  return index;
}

function textExtent(text: string, end: number): TextExtent {
  // node-tree-sitter's JS-string input uses UTF-16 code-unit offsets for both
  // edit indexes and Point.column values.
  let index = 0;
  let row = 0;
  let column = 0;

  for (let offset = 0; offset < end;) {
    const codePoint = text.codePointAt(offset);
    if (codePoint === undefined) break;

    const width = codePoint > 0xffff ? 2 : 1;
    index += width;
    if (codePoint === 0x0a) {
      row += 1;
      column = 0;
    } else {
      column += width;
    }
    offset += width;
  }

  return { index, position: { row, column } };
}

function envValue(name: string): string | undefined {
  return (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env?.[name];
}
