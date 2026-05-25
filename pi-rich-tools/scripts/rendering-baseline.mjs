import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);

export function baselineHighlightedDiff(metadata, config) {
  if (!config.syntaxHighlight.enabled) return emptyHighlightedDiffSet();

  const indexes = renderedLineIndexes(metadata);
  const lineCount = indexes.deletion.length + indexes.addition.length;
  if (lineCount === 0 || lineCount > config.syntaxHighlight.maxLines) {
    return emptyHighlightedDiffSet();
  }

  const languageKey = treeSitterLanguageKey(metadata.lang ?? "text");
  if (!languageKey) return emptyHighlightedDiffSet();

  const runtime = getTreeSitterRuntime();
  const language = runtime.languages.get(languageKey);
  const querySource = runtime.queries.get(languageKey);
  const deletion = baselineHighlightLines(
    runtime,
    languageKey,
    language,
    querySource,
    metadata.deletionLines,
    indexes.deletion,
    config,
  );
  const addition = baselineHighlightLines(
    runtime,
    languageKey,
    language,
    querySource,
    metadata.additionLines,
    indexes.addition,
    config,
  );

  if (!deletion.styled && !addition.styled) return emptyHighlightedDiffSet();
  const highlighted = {
    deletionLines: deletion.lines,
    additionLines: addition.lines,
  };
  return { dark: highlighted, light: highlighted };
}

export function makeMetadata({
  name = "fixture.ts",
  lang = "typescript",
  deletionLines,
  additionLines,
  hunkContent,
  cacheKey,
}) {
  const hunk = {
    collapsedBefore: 0,
    additionStart: 1,
    additionCount: additionLines.length,
    additionLines: hunkContent
      .filter((content) => content.type === "change")
      .reduce((sum, content) => sum + content.additions, 0),
    additionLineIndex: 0,
    deletionStart: 1,
    deletionCount: deletionLines.length,
    deletionLines: hunkContent
      .filter((content) => content.type === "change")
      .reduce((sum, content) => sum + content.deletions, 0),
    deletionLineIndex: 0,
    hunkContent,
    hunkSpecs: `@@ -1,${deletionLines.length} +1,${additionLines.length} @@`,
    splitLineStart: 0,
    splitLineCount: Math.max(deletionLines.length, additionLines.length),
    unifiedLineStart: 0,
    unifiedLineCount: deletionLines.length + additionLines.length,
    noEOFCRDeletions: false,
    noEOFCRAdditions: false,
  };

  return {
    name,
    lang,
    type: "change",
    hunks: [hunk],
    splitLineCount: hunk.splitLineCount,
    unifiedLineCount: hunk.unifiedLineCount,
    isPartial: true,
    deletionLines,
    additionLines,
    cacheKey,
  };
}

export function changedFileMetadata({ name, lang, before, after, cacheKey }) {
  const prefix = commonPrefixLength(before, after);
  const suffix = commonSuffixLength(before, after, prefix);
  const oldChanged = before.length - prefix - suffix;
  const newChanged = after.length - prefix - suffix;
  const hunkContent = [];
  if (prefix > 0) {
    hunkContent.push({
      type: "context",
      lines: prefix,
      deletionLineIndex: 0,
      additionLineIndex: 0,
    });
  }
  if (oldChanged > 0 || newChanged > 0) {
    hunkContent.push({
      type: "change",
      deletions: oldChanged,
      deletionLineIndex: prefix,
      additions: newChanged,
      additionLineIndex: prefix,
    });
  }
  if (suffix > 0) {
    hunkContent.push({
      type: "context",
      lines: suffix,
      deletionLineIndex: before.length - suffix,
      additionLineIndex: after.length - suffix,
    });
  }
  return makeMetadata({
    name,
    lang,
    deletionLines: before,
    additionLines: after,
    hunkContent,
    cacheKey,
  });
}

function baselineHighlightLines(
  runtime,
  languageKey,
  language,
  querySource,
  lines,
  indexes,
  config,
) {
  if (lines.length === 0 || indexes.length === 0) {
    return { lines: [], styled: false };
  }

  const cleanLines = lines.map(cleanDiffLine);
  const visible = new Set(indexes);
  const lineStyles = new Map();
  for (const index of indexes) {
    const line = cleanLines[index] ?? "";
    if (line.length > config.syntaxHighlight.maxLineLength) continue;
    lineStyles.set(index, new Array(line.length));
  }
  if (lineStyles.size === 0) return { lines: [], styled: false };

  const parser = new runtime.Parser();
  parser.setLanguage(language);
  const tree = parser.parse(cleanLines.join("\n"));
  const query = baselineQuery(runtime, languageKey, language, querySource);
  const captures = query
    .captures(tree.rootNode)
    .map((capture) => ({
      ...capture,
      category: syntaxCategoryForCapture(capture.name),
    }))
    .filter((capture) => Boolean(capture.category))
    .sort(
      (a, b) =>
        syntaxCategoryPriority(a.category) - syntaxCategoryPriority(b.category),
    );

  for (const capture of captures) {
    paintCapture(cleanLines, lineStyles, visible, capture.node, capture.category);
  }

  const out = [];
  let styled = false;
  for (const [index, styles] of lineStyles) {
    if (!styles.some(Boolean)) continue;
    const line = cleanLines[index] ?? "";
    out[index] = syntaxSpansNode(spansFromLineStyles(line, styles));
    styled = true;
  }

  return { lines: out, styled };
}

let treeSitterRuntime;
const queryCache = new Map();

function baselineQuery(runtime, languageKey, language, querySource) {
  const cached = queryCache.get(languageKey);
  if (cached) return cached;

  const query = new runtime.Parser.Query(language, querySource);
  queryCache.set(languageKey, query);
  return query;
}

function getTreeSitterRuntime() {
  if (treeSitterRuntime) return treeSitterRuntime;

  const Parser = require("tree-sitter");
  const TypeScript = require("tree-sitter-typescript");
  const JavaScript = require("tree-sitter-javascript");
  const jsQuery = readFileSync(
    require.resolve("tree-sitter-javascript/queries/highlights.scm"),
    "utf8",
  );
  const tsQuery = readFileSync(
    require.resolve("tree-sitter-typescript/queries/highlights.scm"),
    "utf8",
  );
  treeSitterRuntime = {
    Parser,
    languages: new Map([
      ["javascript", JavaScript],
      ["typescript", TypeScript.typescript],
      ["tsx", TypeScript.tsx],
    ]),
    queries: new Map([
      ["javascript", jsQuery],
      ["typescript", `${jsQuery}\n${tsQuery}`],
      ["tsx", `${jsQuery}\n${tsQuery}`],
    ]),
  };
  return treeSitterRuntime;
}

function treeSitterLanguageKey(lang) {
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

function renderedLineIndexes(metadata) {
  const deletion = new Set();
  const addition = new Set();

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

function addRange(target, start, count) {
  for (let i = 0; i < count; i++) target.add(start + i);
}

function syntaxCategoryForCapture(name) {
  const head = name.split(".")[0];
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

function syntaxCategoryPriority(category) {
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

function paintCapture(lines, lineStyles, visible, node, category) {
  const startRow = node.startPosition.row;
  const endRow = node.endPosition.row;
  for (let row = startRow; row <= endRow; row++) {
    if (!visible.has(row)) continue;
    const styles = lineStyles.get(row);
    if (!styles) continue;

    const line = lines[row] ?? "";
    const start =
      row === startRow ? treeSitterColumnToStringIndex(line, node.startPosition.column) : 0;
    const end =
      row === endRow ? treeSitterColumnToStringIndex(line, node.endPosition.column) : line.length;
    for (let i = start; i < end; i++) styles[i] = category;
  }
}

function treeSitterColumnToStringIndex(line, column) {
  // node-tree-sitter parses JavaScript strings as UTF-16, so Point.column is
  // already a JS string index, not a UTF-8 byte offset.
  if (column <= 0) return 0;
  return avoidSplitSurrogateColumn(line, Math.min(column, line.length));
}

function avoidSplitSurrogateColumn(line, index) {
  if (index <= 0 || index >= line.length) return index;
  const previous = line.charCodeAt(index - 1);
  const current = line.charCodeAt(index);
  return previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
    ? index - 1
    : index;
}

function spansFromLineStyles(line, styles) {
  const spans = [];
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

function syntaxSpansNode(spans) {
  if (spans.length === 0) return undefined;
  return {
    type: "element",
    tagName: "span",
    properties: {},
    children: spans.map(syntaxSpanNode),
  };
}

function syntaxSpanNode(span) {
  const text = { type: "text", value: span.text };
  if (!span.category) return text;
  return {
    type: "element",
    tagName: "span",
    properties: { "data-pi-syntax": span.category },
    children: [text],
  };
}

function cleanDiffLine(line) {
  return tabify(cleanLastNewline(line ?? "").replace(/\r$/, ""));
}

function tabify(text) {
  return text.replace(/\t/g, "    ");
}

function cleanLastNewline(text) {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function commonPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLength(a, b, prefix) {
  const limit = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

function emptyHighlightedDiffSet() {
  return {
    dark: { deletionLines: [], additionLines: [] },
    light: { deletionLines: [], additionLines: [] },
  };
}
