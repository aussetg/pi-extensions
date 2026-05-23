const fs = require("node:fs");
const TREE_SITTER_QUERY_RANGE_GAP = 2;
const TREE_SITTER_QUERY_RANGE_END_COLUMN = 0x7fffffff;
const TREE_SITTER_QUERY_FULL_COVERAGE_NUMERATOR = 3;
const TREE_SITTER_QUERY_FULL_COVERAGE_DENOMINATOR = 4;
const runtimes = new Map();
const documents = new Map();

const LANGUAGE_SPECS = [
  spec("javascript", "tree-sitter-javascript"),
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
  spec("python", "tree-sitter-python"),
  spec("rust", "tree-sitter-rust"),
  spec("c", "tree-sitter-c"),
  spec("cpp", "tree-sitter-cpp"),
  spec("zig", "@tree-sitter-grammars/tree-sitter-zig"),
  spec("json", "tree-sitter-json"),
  spec("yaml", "@tree-sitter-grammars/tree-sitter-yaml"),
  spec("toml", "@tree-sitter-grammars/tree-sitter-toml"),
  spec("julia", "tree-sitter-julia"),
  spec("haskell", "tree-sitter-haskell"),
  spec("bash", "tree-sitter-bash"),
  spec("go", "tree-sitter-go"),
  spec("java", "tree-sitter-java"),
  spec("ruby", "tree-sitter-ruby"),
  spec("php", "tree-sitter-php", "php"),
  spec("css", "tree-sitter-css"),
  spec("html", "tree-sitter-html"),
  spec("regex", "tree-sitter-regex"),
];

function spec(key, packageName, exportName) {
  return {
    key,
    packageName,
    exportName,
    queryPaths: [`${packageName}/queries/highlights.scm`],
  };
}

function readInput() {
  return JSON.parse(fs.readFileSync(0, "utf8"));
}

function loadLanguage(languageKey) {
  const cached = runtimes.get(languageKey);
  if (cached) return cached;

  const Parser = require("tree-sitter");
  const languageSpec = LANGUAGE_SPECS.find((spec) => spec.key === languageKey);
  if (languageSpec) {
    const module = require(languageSpec.packageName);
    const language = languageSpec.exportName
      ? module[languageSpec.exportName]
      : module;
    const querySource = languageSpec.queryPaths
      .map(readQuerySource)
      .join("\n");
    const query = new Parser.Query(language, querySource);
    const parser = new Parser();
    parser.setLanguage(language);
    const runtime = { Parser, language, querySource, query, parser };
    runtimes.set(languageKey, runtime);
    return runtime;
  }

  throw new Error(`Unsupported language: ${languageKey}`);
}

function readQuerySource(queryPath) {
  return sanitizeQuerySource(fs.readFileSync(require.resolve(queryPath), "utf8"));
}

function sanitizeQuerySource(source) {
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

function parenBalance(line) {
  let balance = 0;
  for (const char of line) {
    if (char === "(") balance += 1;
    else if (char === ")") balance -= 1;
  }
  return balance;
}

function overlapsIndexes(node, visible) {
  for (let row = node.startPosition.row; row <= node.endPosition.row; row++) {
    if (visible.has(row)) return true;
  }
  return false;
}

function styledLineRanges(indexes, lineCount) {
  const ranges = [];
  let current;

  for (const row of [...indexes].sort((a, b) => a - b)) {
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

function captureKey(capture) {
  return [
    capture.name,
    capture.node.startPosition.row,
    capture.node.startPosition.column,
    capture.node.endPosition.row,
    capture.node.endPosition.column,
  ].join(":");
}

function shouldQueryFullTree(ranges, lineCount) {
  if (
    ranges.length === 1 &&
    ranges[0].start === 0 &&
    ranges[0].end >= lineCount - 1
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

function queryCapturesForIndexes(query, rootNode, indexes, lineCount) {
  const ranges = styledLineRanges(indexes, lineCount);
  if (ranges.length === 0) return [];
  if (shouldQueryFullTree(ranges, lineCount)) {
    return query.captures(rootNode);
  }

  try {
    const captures = [];
    const seen = new Set();
    for (const range of ranges) {
      for (const capture of query.captures(rootNode, {
        startPosition: { row: range.start, column: 0 },
        endPosition: {
          row: range.end,
          column: TREE_SITTER_QUERY_RANGE_END_COLUMN,
        },
      })) {
        const key = captureKey(capture);
        if (seen.has(key)) continue;
        seen.add(key);
        captures.push(capture);
      }
    }
    return captures;
  } catch {
    return query.captures(rootNode);
  }
}

function normalizeJob(input) {
  return {
    documentId: typeof input?.documentId === "string" ? input.documentId : undefined,
    lines: Array.isArray(input?.lines) ? input.lines : [],
    indexes: Array.isArray(input?.indexes) ? input.indexes : [],
  };
}

function parseJob(runtime, languageKey, job) {
  const text = job.lines.join("\n");
  const documentKey = job.documentId ? `${languageKey}\0${job.documentId}` : undefined;
  const cached = documentKey ? documents.get(documentKey) : undefined;

  if (cached?.text === text) return cached.tree;

  let tree;
  if (cached) {
    cached.tree.edit(treeSitterEditForTextChange(cached.text, text));
    runtime.parser.reset?.();
    tree = runtime.parser.parse(text, cached.tree);
  } else {
    runtime.parser.reset?.();
    tree = runtime.parser.parse(text);
  }

  if (documentKey && tree) {
    documents.delete(documentKey);
    documents.set(documentKey, { text, tree });
    while (documents.size > syntaxDocumentCacheLimit()) {
      const oldestKey = documents.keys().next().value;
      if (typeof oldestKey !== "string") break;
      documents.delete(oldestKey);
    }
  }
  return tree;
}

function capturesForJob(runtime, languageKey, job) {
  const visible = new Set(job.indexes.filter((index) => Number.isInteger(index)));
  const tree = parseJob(runtime, languageKey, job);
  return queryCapturesForIndexes(
    runtime.query,
    tree.rootNode,
    [...visible],
    job.lines.length,
  )
    .filter((capture) => overlapsIndexes(capture.node, visible))
    .map((capture) => ({
      name: capture.name,
      startRow: capture.node.startPosition.row,
      startColumn: capture.node.startPosition.column,
      endRow: capture.node.endPosition.row,
      endColumn: capture.node.endPosition.column,
    }));
}

function handleInput(input) {
  const languageKey = input.languageKey;
  const isBatch = Array.isArray(input.jobs);
  const jobs = isBatch ? input.jobs.map(normalizeJob) : [normalizeJob(input)];

  const runtime = loadLanguage(languageKey);
  const results = jobs.map((job) => {
    if (!isBatch) return { captures: capturesForJob(runtime, languageKey, job) };
    try {
      return { captures: capturesForJob(runtime, languageKey, job) };
    } catch {
      return { captures: [] };
    }
  });

  return isBatch ? { jobs: results } : { captures: results[0].captures };
}

function syntaxDocumentCacheLimit() {
  const parsed = Number.parseInt(process.env.PI_TREE_SITTER_DOCUMENT_CACHE_LIMIT ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 64;
}

function treeSitterEditForTextChange(oldText, newText) {
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

function changedTextRange(oldText, newText) {
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

function avoidSplitSurrogate(text, index) {
  if (index <= 0 || index >= text.length) return index;
  const previous = text.charCodeAt(index - 1);
  const current = text.charCodeAt(index);
  return previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
    ? index - 1
    : index;
}

function textExtent(text, end) {
  let index = 0;
  let row = 0;
  let column = 0;
  for (let offset = 0; offset < end;) {
    const codePoint = text.codePointAt(offset);
    if (codePoint === undefined) break;
    const width = codePoint > 0xffff ? 2 : 1;
    const bytes = Buffer.byteLength(text.slice(offset, offset + width), "utf8");
    index += bytes;
    if (codePoint === 0x0a) {
      row += 1;
      column = 0;
    } else {
      column += bytes;
    }
    offset += width;
  }
  return { index, position: { row, column } };
}

function main() {
  const input = readInput();

  process.stdout.write(JSON.stringify(handleInput(input)));
}

function mainIpc() {
  process.on("message", (input) => {
    const id = input && typeof input === "object" ? input.id : undefined;
    try {
      process.send({ id, ...handleInput(input) });
    } catch (err) {
      process.send({
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  process.on("disconnect", () => process.exit(0));
}

try {
  if (process.send) mainIpc();
  else main();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
}
