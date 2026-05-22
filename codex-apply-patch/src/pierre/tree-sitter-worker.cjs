const fs = require("node:fs");

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

function main() {
  const input = readInput();
  const languageKey = input.languageKey;
  const lines = Array.isArray(input.lines) ? input.lines : [];
  const indexes = Array.isArray(input.indexes) ? input.indexes : [];
  const visible = new Set(indexes.filter((index) => Number.isInteger(index)));

  const { Parser, language, querySource } = loadLanguage(languageKey);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(lines.join("\n"));
  const query = new Parser.Query(language, querySource);
  const captures = query
    .captures(tree.rootNode)
    .filter((capture) => overlapsIndexes(capture.node, visible))
    .map((capture) => ({
      name: capture.name,
      startRow: capture.node.startPosition.row,
      startColumn: capture.node.startPosition.column,
      endRow: capture.node.endPosition.row,
      endColumn: capture.node.endPosition.column,
    }));

  process.stdout.write(JSON.stringify({ captures }));
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
}
