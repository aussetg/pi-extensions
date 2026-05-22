const fs = require("node:fs");
const TREE_SITTER_QUERY_RANGE_GAP = 2;
const TREE_SITTER_QUERY_RANGE_END_COLUMN = 0x7fffffff;
const TREE_SITTER_QUERY_FULL_COVERAGE_NUMERATOR = 3;
const TREE_SITTER_QUERY_FULL_COVERAGE_DENOMINATOR = 4;

function readInput() {
  return JSON.parse(fs.readFileSync(0, "utf8"));
}

function loadLanguage(languageKey) {
  const Parser = require("tree-sitter");
  const JavaScript = require("tree-sitter-javascript");
  const TypeScript = require("tree-sitter-typescript");
  const jsQuery = fs.readFileSync(
    require.resolve("tree-sitter-javascript/queries/highlights.scm"),
    "utf8",
  );

  if (languageKey === "javascript") {
    return { Parser, language: JavaScript, querySource: jsQuery };
  }

  const tsQuery = fs.readFileSync(
    require.resolve("tree-sitter-typescript/queries/highlights.scm"),
    "utf8",
  );

  if (languageKey === "typescript") {
    return {
      Parser,
      language: TypeScript.typescript,
      querySource: `${jsQuery}\n${tsQuery}`,
    };
  }

  if (languageKey === "tsx") {
    return {
      Parser,
      language: TypeScript.tsx,
      querySource: `${jsQuery}\n${tsQuery}`,
    };
  }

  throw new Error(`Unsupported language: ${languageKey}`);
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
    lines: Array.isArray(input?.lines) ? input.lines : [],
    indexes: Array.isArray(input?.indexes) ? input.indexes : [],
  };
}

function capturesForJob(Parser, language, query, job) {
  const visible = new Set(job.indexes.filter((index) => Number.isInteger(index)));
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(job.lines.join("\n"));
  return queryCapturesForIndexes(
    query,
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

function main() {
  const input = readInput();
  const languageKey = input.languageKey;
  const isBatch = Array.isArray(input.jobs);
  const jobs = isBatch ? input.jobs.map(normalizeJob) : [normalizeJob(input)];

  const { Parser, language, querySource } = loadLanguage(languageKey);
  const query = new Parser.Query(language, querySource);
  const results = jobs.map((job) => {
    if (!isBatch) return { captures: capturesForJob(Parser, language, query, job) };
    try {
      return { captures: capturesForJob(Parser, language, query, job) };
    } catch {
      return { captures: [] };
    }
  });

  process.stdout.write(
    JSON.stringify(isBatch ? { jobs: results } : { captures: results[0].captures }),
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
}
