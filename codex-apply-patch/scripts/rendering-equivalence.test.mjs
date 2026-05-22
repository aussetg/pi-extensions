import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPiHighlightedDiff } from "../src/pierre/highlight.ts";
import { DEFAULT_PIERRE_RENDERER_CONFIG } from "../src/pierre/config.ts";
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

function workerCaptures(languageKey, lines, indexes) {
  const result = spawnSync(process.execPath, [workerPath], {
    input: JSON.stringify({ languageKey, lines, indexes }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).captures;
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
