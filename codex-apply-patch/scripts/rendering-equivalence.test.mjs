import assert from "node:assert/strict";
import test from "node:test";
import { buildPiHighlightedDiff } from "../src/pierre/highlight.ts";
import { DEFAULT_PIERRE_RENDERER_CONFIG } from "../src/pierre/config.ts";
import {
  baselineHighlightedDiff,
  changedFileMetadata,
  makeMetadata,
} from "./rendering-baseline.mjs";

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
