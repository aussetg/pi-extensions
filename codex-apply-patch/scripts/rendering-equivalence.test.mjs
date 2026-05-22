import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openAnsi, renderAnsiSegments } from "../src/pierre/ansi.ts";
import { continuationPrefixSegments } from "../src/pierre/gutter.ts";
import { buildPiHighlightedDiff } from "../src/pierre/highlight.ts";
import { DEFAULT_PIERRE_RENDERER_CONFIG } from "../src/pierre/config.ts";
import { buildCachedDiffRows, buildDiffRows } from "../src/pierre/rows.ts";
import { getPierrePalette } from "../src/pierre/theme.ts";
import {
  buildCreateFilePreview,
  buildUpdateFilePreview,
} from "../src/preview.ts";
import {
  baselineHighlightedDiff,
  changedFileMetadata,
  makeMetadata,
} from "./rendering-baseline.mjs";

const require = createRequire(import.meta.url);
const workerPath = fileURLToPath(
  new URL("../src/pierre/tree-sitter-worker.cjs", import.meta.url),
);

const config = {
  ...DEFAULT_PIERRE_RENDERER_CONFIG,
  syntaxHighlight: {
    ...DEFAULT_PIERRE_RENDERER_CONFIG.syntaxHighlight,
    enabled: true,
    maxLines: 20000,
    maxLineLength: 20000,
  },
};

const cases = [
  changedFileMetadata({
    name: "simple.ts",
    lang: "typescript",
    before: [
      "export function greet(name: string) {",
      "\treturn `hello ${name}`;",
      "}",
    ],
    after: [
      "export function greet(name: string): string {",
      "\tconst suffix = \"!\";",
      "\treturn `hello ${name}${suffix}`;",
      "}",
    ],
  }),
  changedFileMetadata({
    name: "unicode.ts",
    lang: "typescript",
    before: [
      "const café = \"☕\";",
      "const emoji = \"😀\";",
      "console.log(café, emoji);",
    ],
    after: [
      "const café = \"☕\";",
      "const emoji = \"😄\";",
      "console.log(café, emoji, 42);",
    ],
  }),
  changedFileMetadata({
    name: "component.tsx",
    lang: "tsx",
    before: [
      "type Props = { label: string };",
      "export function Button(props: Props) {",
      "  return <button>{props.label}</button>;",
      "}",
    ],
    after: [
      "type Props = { label: string; disabled?: boolean };",
      "export function Button(props: Props) {",
      "  return <button disabled={props.disabled}>{props.label}</button>;",
      "}",
    ],
  }),
  changedFileMetadata({
    name: "module.mjs",
    lang: "javascript",
    before: [
      "import fs from 'node:fs';",
      "export const answer = 41;",
      "console.log(answer);",
    ],
    after: [
      "import fs from 'node:fs';",
      "export const answer = 42;",
      "console.log(answer, fs.existsSync('.'));",
    ],
  }),
  makeMetadata({
    name: "multi-hunk.ts",
    lang: "typescript",
    deletionLines: [
      "export const a = 1;",
      "export const b = 2;",
      "export const c = 3;",
      "export const d = 4;",
    ],
    additionLines: [
      "export const a = 1;",
      "export const b = 22;",
      "export const c = 3;",
      "export const d = 44;",
    ],
    hunkContent: [
      { type: "context", lines: 1, deletionLineIndex: 0, additionLineIndex: 0 },
      {
        type: "change",
        deletions: 1,
        deletionLineIndex: 1,
        additions: 1,
        additionLineIndex: 1,
      },
      { type: "context", lines: 1, deletionLineIndex: 2, additionLineIndex: 2 },
      {
        type: "change",
        deletions: 1,
        deletionLineIndex: 3,
        additions: 1,
        additionLineIndex: 3,
      },
    ],
  }),
  makeMetadata({
    name: "sparse-comment.ts",
    lang: "typescript",
    deletionLines: [
      "const before = 1;",
      "/*",
      " * old value",
      " */",
      "const after = 2;",
    ],
    additionLines: [
      "const before = 1;",
      "/*",
      " * new value",
      " */",
      "const after = 2;",
    ],
    hunkContent: [
      {
        type: "change",
        deletions: 1,
        deletionLineIndex: 2,
        additions: 1,
        additionLineIndex: 2,
      },
    ],
  }),
  makeMetadata({
    name: "sparse-template.ts",
    lang: "typescript",
    deletionLines: [
      "const text = `",
      "  hello",
      "  old ${name}",
      "  goodbye",
      "`;",
      "console.log(text);",
    ],
    additionLines: [
      "const text = `",
      "  hello",
      "  new ${name}",
      "  goodbye",
      "`;",
      "console.log(text);",
    ],
    hunkContent: [
      {
        type: "change",
        deletions: 1,
        deletionLineIndex: 2,
        additions: 1,
        additionLineIndex: 2,
      },
    ],
  }),
  makeMetadata({
    name: "widely-spaced.ts",
    lang: "typescript",
    deletionLines: Array.from(
      { length: 80 },
      (_, index) => `export const value${index} = ${index};`,
    ),
    additionLines: Array.from(
      { length: 80 },
      (_, index) =>
        `export const value${index} = ${index === 5 || index === 60 ? index + 100 : index};`,
    ),
    hunkContent: [
      {
        type: "change",
        deletions: 1,
        deletionLineIndex: 5,
        additions: 1,
        additionLineIndex: 5,
      },
      {
        type: "change",
        deletions: 1,
        deletionLineIndex: 60,
        additions: 1,
        additionLineIndex: 60,
      },
    ],
  }),
];

for (const [index, metadata] of cases.entries()) {
  test(`tree-sitter highlighting matches baseline fixture ${index + 1}`, () => {
    assert.deepEqual(
      buildPiHighlightedDiff(metadata, config),
      baselineHighlightedDiff(metadata, config),
    );
  });
}

test("line limits keep the same empty-highlight behavior", () => {
  const metadata = cases[0];
  const limited = {
    ...config,
    syntaxHighlight: { ...config.syntaxHighlight, maxLineLength: 8 },
  };
  assert.deepEqual(
    buildPiHighlightedDiff(metadata, limited),
    baselineHighlightedDiff(metadata, limited),
  );
});

test("unsupported languages keep the same empty-highlight behavior", () => {
  const metadata = changedFileMetadata({
    name: "README.md",
    lang: "markdown",
    before: ["# before"],
    after: ["# after"],
  });
  assert.deepEqual(
    buildPiHighlightedDiff(metadata, config),
    baselineHighlightedDiff(metadata, config),
  );
});

test("best-effort preview builders do not throw for unpreviewable diffs", () => {
  assert.equal(
    buildCreateFilePreview({ path: "empty.txt", newContent: "" }),
    undefined,
  );
  assert.equal(
    buildUpdateFilePreview({
      oldPath: "a.txt",
      newPath: "b.txt",
      oldContent: "same\n",
      newContent: "same\n",
    }),
    undefined,
  );
});

test("tree-sitter worker range queries match full-query captures", () => {
  const lines = [
    "const before = 1;",
    "/*",
    " * old value",
    " */",
    "const text = `",
    "  hello",
    "  old ${name}",
    "  goodbye",
    "`;",
    "const after = 2;",
  ];
  const indexes = [2, 6];
  assert.deepEqual(
    sortedCaptureKeys(workerCaptures("typescript", lines, indexes)),
    sortedCaptureKeys(fullQueryCaptures("typescript", lines, indexes)),
  );
});

test("tree-sitter worker batch output matches single-job output", () => {
  const deletionLines = [
    "const before = 1;",
    "/*",
    " * old value",
    " */",
    "const after = 2;",
  ];
  const additionLines = [
    "const before = 1;",
    "/*",
    " * new value",
    " */",
    "const after = 2;",
  ];
  const deletionIndexes = [2];
  const additionIndexes = [2];

  const batch = batchWorkerCaptures("typescript", [
    { lines: deletionLines, indexes: deletionIndexes },
    { lines: additionLines, indexes: additionIndexes },
  ]);

  assert.deepEqual(
    sortedCaptureKeys(batch[0]),
    sortedCaptureKeys(workerCaptures("typescript", deletionLines, deletionIndexes)),
  );
  assert.deepEqual(
    sortedCaptureKeys(batch[1]),
    sortedCaptureKeys(workerCaptures("typescript", additionLines, additionIndexes)),
  );
});

test("cached diff rows match uncached rows and reuse exact row arrays", () => {
  const metadata = cases[0];
  const highlighted = buildPiHighlightedDiff(metadata, config).dark;
  const palette = getPierrePalette({ name: "dark" }, config);
  const options = { expandCollapsed: false };
  const cacheKey = "row-cache-basic";

  const uncached = buildDiffRows(metadata, highlighted, palette, config, options);
  const cached = buildCachedDiffRows(
    metadata,
    highlighted,
    palette,
    config,
    options,
    cacheKey,
  );
  const cachedAgain = buildCachedDiffRows(
    metadata,
    highlighted,
    palette,
    config,
    options,
    cacheKey,
  );

  assert.deepEqual(cached, uncached);
  assert.strictEqual(cachedAgain, cached);
});

test("cached diff rows keep palette, word-diff config, and expansion separate", () => {
  const metadata = collapsedMetadata();
  const highlighted = buildPiHighlightedDiff(metadata, config).dark;
  const darkPalette = getPierrePalette({ name: "dark" }, config);
  const lightPalette = getPierrePalette({ name: "light" }, config);
  const noWordDiffConfig = {
    ...config,
    wordDiff: { ...config.wordDiff, enabled: false },
  };
  const cacheKey = "row-cache-variants";

  const darkRows = buildCachedDiffRows(
    metadata,
    highlighted,
    darkPalette,
    config,
    { expandCollapsed: false },
    cacheKey,
  );
  const lightRows = buildCachedDiffRows(
    metadata,
    highlighted,
    lightPalette,
    config,
    { expandCollapsed: false },
    cacheKey,
  );
  const noWordRows = buildCachedDiffRows(
    metadata,
    highlighted,
    darkPalette,
    noWordDiffConfig,
    { expandCollapsed: false },
    cacheKey,
  );
  const expandedRows = buildCachedDiffRows(
    metadata,
    highlighted,
    darkPalette,
    config,
    { expandCollapsed: true },
    cacheKey,
  );

  assert.deepEqual(
    lightRows,
    buildDiffRows(metadata, highlighted, lightPalette, config, {
      expandCollapsed: false,
    }),
  );
  assert.deepEqual(
    noWordRows,
    buildDiffRows(metadata, highlighted, darkPalette, noWordDiffConfig, {
      expandCollapsed: false,
    }),
  );
  assert.deepEqual(
    expandedRows,
    buildDiffRows(metadata, highlighted, darkPalette, config, {
      expandCollapsed: true,
    }),
  );
  assert.notStrictEqual(lightRows, darkRows);
  assert.notStrictEqual(noWordRows, darkRows);
  assert.notStrictEqual(expandedRows, darkRows);
});

test("cached ANSI style rendering matches the previous uncached behavior", () => {
  const styles = [
    {},
    { fg: "#123456" },
    { bg: "#abcdef" },
    { fg: " #ABCDEF ", bg: " #010203 ", bold: true },
    { fg: "not-a-color", bg: "also-not-a-color", bold: false },
    { fg: "\u001b[31m", bg: "\u001b[42m" },
    { fg: " \u001b[38;2;1;2;3m ", bg: " \u001b[48;2;4;5;6m " },
  ];

  for (const style of styles) {
    assert.equal(openAnsi(style), baselineOpenAnsi(style));
    assert.equal(openAnsi(style), baselineOpenAnsi(style));
  }
});

test("cached ANSI segment rendering preserves base and override behavior", () => {
  const base = { fg: "#102030", bg: "#405060" };
  const segments = [
    { text: "plain" },
    { text: "fg", fg: "#112233" },
    { text: "bg", bg: "#445566" },
    { text: "bold", bold: true },
    { text: "reset-bold", bold: false },
    { text: "ansi", fg: "\u001b[35m", bg: "\u001b[46m" },
  ];

  assert.equal(
    renderAnsiSegments(segments, base),
    baselineRenderAnsiSegments(segments, base),
  );
  assert.equal(
    renderAnsiSegments(segments, { ...base, bold: true }),
    baselineRenderAnsiSegments(segments, { ...base, bold: true }),
  );
});

test("wrapped line continuation prefixes keep the row gutter bar", () => {
  const palette = getPierrePalette({ name: "dark" }, config);
  const additionRow = {
    kind: "line",
    lineType: "addition",
    lineNumber: 5,
    spans: [],
    rowFg: palette.additionFg,
    rowBg: palette.additionRowBg,
    lineNumberFg: palette.additionLineNumberFg,
  };
  const deletionRow = {
    ...additionRow,
    lineType: "deletion",
    rowFg: palette.deletionFg,
    rowBg: palette.deletionRowBg,
    lineNumberFg: palette.deletionLineNumberFg,
  };
  const visibleWidth = (text) => [...text].length;

  const additionBeforeNumber = continuationPrefixSegments(
    8,
    additionRow,
    palette,
    config,
    visibleWidth,
  );
  const deletionBeforeNumber = continuationPrefixSegments(
    8,
    deletionRow,
    palette,
    config,
    visibleWidth,
  );
  const additionAfterNumber = continuationPrefixSegments(
    8,
    additionRow,
    palette,
    { ...config, gutter: { ...config.gutter, barPosition: "after-number" } },
    visibleWidth,
  );

  assert.equal(additionBeforeNumber[1].text, config.gutter.additionBar);
  assert.equal(additionBeforeNumber[1].fg, palette.additionBarFg);
  assert.equal(additionBeforeNumber[1].bg, palette.additionBarBg);
  assert.equal(deletionBeforeNumber[1].text, config.gutter.deletionBar);
  assert.equal(additionAfterNumber[2].text, config.gutter.additionBar);
});

function workerCaptures(languageKey, lines, indexes) {
  const result = spawnSync(process.execPath, [workerPath], {
    input: JSON.stringify({ languageKey, lines, indexes }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).captures;
}

function batchWorkerCaptures(languageKey, jobs) {
  const result = spawnSync(process.execPath, [workerPath], {
    input: JSON.stringify({ languageKey, jobs }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.jobs.length, jobs.length);
  return parsed.jobs.map((job) => job.captures);
}

function fullQueryCaptures(languageKey, lines, indexes) {
  const visible = new Set(indexes);
  const { Parser, language, querySource } = loadLanguage(languageKey);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(lines.join("\n"));
  const query = new Parser.Query(language, querySource);
  return query
    .captures(tree.rootNode)
    .filter((capture) => overlapsIndexes(capture.node, visible))
    .map((capture) => ({
      name: capture.name,
      startRow: capture.node.startPosition.row,
      startColumn: capture.node.startPosition.column,
      endRow: capture.node.endPosition.row,
      endColumn: capture.node.endPosition.column,
    }));
}

function loadLanguage(languageKey) {
  const Parser = require("tree-sitter");
  const JavaScript = require("tree-sitter-javascript");
  const TypeScript = require("tree-sitter-typescript");
  const jsQuery = readFileSync(
    require.resolve("tree-sitter-javascript/queries/highlights.scm"),
    "utf8",
  );

  if (languageKey === "javascript") {
    return { Parser, language: JavaScript, querySource: jsQuery };
  }

  const tsQuery = readFileSync(
    require.resolve("tree-sitter-typescript/queries/highlights.scm"),
    "utf8",
  );
  const language = languageKey === "tsx" ? TypeScript.tsx : TypeScript.typescript;
  return { Parser, language, querySource: `${jsQuery}\n${tsQuery}` };
}

function overlapsIndexes(node, visible) {
  for (let row = node.startPosition.row; row <= node.endPosition.row; row++) {
    if (visible.has(row)) return true;
  }
  return false;
}

function sortedCaptureKeys(captures) {
  return captures
    .map((capture) =>
      [
        capture.name,
        capture.startRow,
        capture.startColumn,
        capture.endRow,
        capture.endColumn,
      ].join(":"),
    )
    .sort();
}

function collapsedMetadata() {
  const metadata = makeMetadata({
    name: "collapsed.ts",
    lang: "typescript",
    deletionLines: [
      "export const keep0 = 0;",
      "export const keep1 = 1;",
      "export const keep2 = 2;",
      "export const oldValue = 3;",
    ],
    additionLines: [
      "export const keep0 = 0;",
      "export const keep1 = 1;",
      "export const keep2 = 2;",
      "export const newValue = 4;",
    ],
    hunkContent: [
      {
        type: "change",
        deletions: 1,
        deletionLineIndex: 3,
        additions: 1,
        additionLineIndex: 3,
      },
    ],
  });
  metadata.isPartial = false;
  metadata.hunks[0].collapsedBefore = 3;
  metadata.hunks[0].additionStart = 4;
  metadata.hunks[0].deletionStart = 4;
  metadata.hunks[0].additionLineIndex = 3;
  metadata.hunks[0].deletionLineIndex = 3;
  metadata.hunks[0].additionCount = 1;
  metadata.hunks[0].deletionCount = 1;
  return metadata;
}

function baselineRenderAnsiSegments(segments, base) {
  let output = baselineOpenAnsi(base);
  for (const segment of segments) {
    output += baselineOpenAnsi({
      fg: segment.fg ?? base.fg,
      bg: segment.bg ?? base.bg,
      bold: "bold" in segment ? segment.bold ?? base.bold : base.bold,
    });
    output += segment.text;
  }
  output += baselineOpenAnsi(base);
  return output;
}

function baselineOpenAnsi(style) {
  return [
    `\u001b[${style.bold ? "1" : "22"}m`,
    baselineColorToAnsi(style.fg, "fg"),
    baselineColorToAnsi(style.bg, "bg"),
  ].join("");
}

function baselineColorToAnsi(color, slot) {
  const reset = slot === "fg" ? "\u001b[39m" : "\u001b[49m";
  const normalized = color?.trim();
  if (!normalized) return reset;

  if (normalized.includes("\u001b[")) return normalized;

  const rgb = baselineToRgb(normalized);
  if (!rgb) return reset;

  const prefix = slot === "fg" ? "38" : "48";
  return `\u001b[${prefix};2;${rgb.r};${rgb.g};${rgb.b}m`;
}

function baselineToRgb(hex) {
  const normalized = hex.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) return undefined;

  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}
