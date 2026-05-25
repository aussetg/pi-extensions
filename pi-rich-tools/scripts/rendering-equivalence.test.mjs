import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openAnsi, renderAnsiSegments } from "../src/pierre/ansi.ts";
import { continuationPrefixSegments } from "../src/pierre/gutter.ts";
import {
  buildPiHighlightedDiff,
  cleanDiffLine,
  flattenHighlightedLine,
  hasHighlightedLines,
  loadHighlightedDiff,
  needsHighlightedDiffSupplement,
} from "../src/pierre/highlight.ts";
import {
  resetSharedSyntaxServiceForTests,
  sharedSyntaxServiceStats,
} from "../src/pierre/syntax-service.ts";
import { DEFAULT_PIERRE_RENDERER_CONFIG } from "../src/pierre/config.ts";
import { resetPierreRendererState } from "../src/pierre/reset.ts";
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

test("tree-sitter highlighting keeps Unicode columns aligned", () => {
  const lines = [
    '        return "hybrid→MIGraphX query"',
    '    print(f"• repos:     {len(repos)}", flush=True)',
  ];
  const metadata = makeMetadata({
    name: "unicode-columns.py",
    lang: "python",
    deletionLines: lines,
    additionLines: lines,
    hunkContent: [
      {
        type: "context",
        lines: lines.length,
        deletionLineIndex: 0,
        additionLineIndex: 0,
      },
    ],
  });
  const highlighted = buildPiHighlightedDiff(metadata, config).dark;

  assert.equal(
    hasSyntaxSpan(highlighted.additionLines[0], "string", '"hybrid→MIGraphX query"'),
    true,
  );
  assert.equal(
    hasSyntaxSpan(highlighted.additionLines[1], "string", 'f"• repos:     {len(repos)}"'),
    true,
  );
});

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

test("async TextMate fallback highlights languages outside the tree-sitter bundle", async () => {
  const samples = [
    [
      "md",
      "README.md",
      ["# Before", "", "- `old` value"],
      ["# After", "", "- `new` value"],
    ],
    [
      "dockerfile",
      "Dockerfile",
      ["FROM alpine:3.20", "RUN echo \"old\""],
      ["FROM alpine:3.20", "RUN echo \"new\""],
    ],
    [
      "nix",
      "flake.nix",
      ["{ pkgs }: pkgs.writeText \"name\" \"old\""],
      ["{ pkgs }: pkgs.writeText \"name\" \"new\""],
    ],
  ];

  for (const [lang, name, before, after] of samples) {
    const metadata = changedFileMetadata({ name, lang, before, after });
    assert.equal(hasHighlightedLines(buildPiHighlightedDiff(metadata, config)), false, lang);
    assert.equal(hasHighlightedLines(await loadHighlightedDiff(metadata, config)), true, lang);
  }
});

test("async TextMate fallback supplements sparse tree-sitter Rust snippets", async () => {
  const lines = [
    "        assert_eq!(",
    "            is_execution_provider_compiled(ExecutionProvider::MIGraphX),",
    "            cfg!(feature = \"migraphx\")",
    "        );",
    "    }",
    "",
    "    #[test]",
    "    fn test_compiled_gpu_execution_provider_order() {",
    "        let expected = GPU_PROVIDER_ORDER",
    "            .iter()",
  ];
  const metadata = makeMetadata({
    name: "fragment.rs",
    lang: "rust",
    deletionLines: lines,
    additionLines: lines,
    hunkContent: [
      {
        type: "context",
        lines: lines.length,
        deletionLineIndex: 0,
        additionLineIndex: 0,
      },
    ],
  });

  const direct = buildPiHighlightedDiff(metadata, config);
  const directLine = direct.dark.additionLines[7];
  const supplementedLine = (await loadHighlightedDiff(metadata, config)).dark.additionLines[7];

  assert.equal(needsHighlightedDiffSupplement(metadata, direct, config), true);
  assert.equal(hasSyntaxSpan(directLine, "function", "test_compiled_gpu_execution_provider_order"), false);
  assert.equal(hasSyntaxSpan(supplementedLine, "function", "test_compiled_gpu_execution_provider_order"), true);
});

test("tree-sitter highlighting supports common coding languages", () => {
  const samples = [
    ["python", "sample.py", ["def f(x):", "    return x + 1"], ["def f(x):", "    return x + 2"]],
    ["rust", "sample.rs", ["fn main() {", "    let x = 1;", "}"], ["fn main() {", "    let x = 2;", "}"]],
    ["c", "sample.c", ["int main(void) {", "  return 1;", "}"], ["int main(void) {", "  return 2;", "}"]],
    ["cpp", "sample.cpp", ["int main() {", "  auto x = 1;", "}"], ["int main() {", "  auto x = 2;", "}"]],
    ["zig", "sample.zig", ["pub fn main() void {", "    const x = 1;", "}"], ["pub fn main() void {", "    const x = 2;", "}"]],
    ["json", "sample.json", ["{\"x\": 1}"], ["{\"x\": 2}"]],
    ["yaml", "sample.yaml", ["x: 1"], ["x: 2"]],
    ["toml", "sample.toml", ["x = 1"], ["x = 2"]],
    ["julia", "sample.jl", ["function f(x)", "  x + 1", "end"], ["function f(x)", "  x + 2", "end"]],
    ["haskell", "sample.hs", ["main = print 1"], ["main = print 2"]],
    ["bash", "sample.sh", ["echo 1"], ["echo 2"]],
    ["go", "sample.go", ["package main", "func main() { println(1) }"], ["package main", "func main() { println(2) }"]],
    ["java", "sample.java", ["class A { int x = 1; }"], ["class A { int x = 2; }"]],
    ["ruby", "sample.rb", ["def f", "  1", "end"], ["def f", "  2", "end"]],
    ["php", "sample.php", ["<?php echo 1;"], ["<?php echo 2;"]],
    ["css", "sample.css", ["body { color: red; }"], ["body { color: blue; }"]],
    ["html", "sample.html", ["<p>one</p>"], ["<p>two</p>"]],
    ["regex", "sample.regex", ["a+"], ["b+"]],
  ];

  for (const [lang, name, before, after] of samples) {
    const highlighted = buildPiHighlightedDiff(
      changedFileMetadata({ name, lang, before, after }),
      config,
    );
    assert.equal(hasHighlightedLines(highlighted), true, lang);
  }
});

test("tree-sitter highlighting reuses shared incremental syntax snapshots", () => {
  resetSharedSyntaxServiceForTests();
  const revisions = [
    makeIncrementalTypeScriptFile(1),
    makeIncrementalTypeScriptFile(2),
    makeIncrementalTypeScriptFile(3),
  ];

  const first = changedFileMetadata({
    name: "shared-syntax.ts",
    lang: "typescript",
    before: revisions[0],
    after: revisions[1],
  });
  const second = changedFileMetadata({
    name: "shared-syntax.ts",
    lang: "typescript",
    before: revisions[1],
    after: revisions[2],
  });

  assert.deepEqual(buildPiHighlightedDiff(first, config), baselineHighlightedDiff(first, config));
  const firstStats = sharedSyntaxServiceStats();
  assert.equal(firstStats.fullParses, 2);
  assert.equal(firstStats.incrementalParses, 0);

  assert.deepEqual(buildPiHighlightedDiff(second, config), baselineHighlightedDiff(second, config));
  const secondStats = sharedSyntaxServiceStats();
  assert.equal(secondStats.fullParses, 2);
  assert.equal(secondStats.incrementalParses, 2);
});

test("shared incremental syntax snapshots use UTF-16 tree-sitter edit positions", () => {
  resetSharedSyntaxServiceForTests();
  const revisions = [
    ['const café = "one";', 'const emoji = "😀";', 'const value = 1;'],
    ['const café = "two";', 'const emoji = "😀";', 'const value = 2;'],
    ['const café = "three";', 'const emoji = "😀";', 'const value = 3;'],
  ];

  const first = changedFileMetadata({
    name: "unicode-incremental.ts",
    lang: "typescript",
    before: revisions[0],
    after: revisions[1],
  });
  const second = changedFileMetadata({
    name: "unicode-incremental.ts",
    lang: "typescript",
    before: revisions[1],
    after: revisions[2],
  });

  buildPiHighlightedDiff(first, config);
  const incremental = buildPiHighlightedDiff(second, config);
  const incrementalStats = sharedSyntaxServiceStats();

  resetSharedSyntaxServiceForTests();
  const full = buildPiHighlightedDiff(second, config);

  assert.equal(incrementalStats.fullParses, 2);
  assert.equal(incrementalStats.incrementalParses, 2);
  assert.deepEqual(incremental, full);
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

test("async tree-sitter worker fallback matches direct highlighting", async () => {
  const metadata = cases[7];
  const previous = process.env.PI_TREE_SITTER_FORCE_WORKER;
  process.env.PI_TREE_SITTER_FORCE_WORKER = "1";
  try {
    assert.deepEqual(
      await loadHighlightedDiff(metadata, config),
      buildPiHighlightedDiff(metadata, config),
    );
  } finally {
    if (previous === undefined) delete process.env.PI_TREE_SITTER_FORCE_WORKER;
    else process.env.PI_TREE_SITTER_FORCE_WORKER = previous;
  }
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

test("plain spans inside highlighted lines use syntax text foreground", () => {
  const palette = getPierrePalette({ name: "dark" }, config);
  const spans = flattenHighlightedLine(
    {
      type: "element",
      tagName: "span",
      properties: {},
      children: [
        { type: "text", value: "    " },
        {
          type: "element",
          tagName: "span",
          properties: { "data-pi-syntax": "keyword" },
          children: [{ type: "text", value: "fn" }],
        },
        { type: "text", value: " test_name()" },
      ],
    },
    "dark",
    palette,
    palette.contextRowBg,
    "    fn test_name()",
  );

  assert.equal(spans[0].fg, palette.syntaxText);
  assert.equal(spans[1].fg, palette.syntaxKeyword);
  assert.equal(spans[2].fg, palette.syntaxText);
});

test("diff rendering visualizes terminal control characters", () => {
  assert.equal(cleanDiffLine('\x00a\x0cb\x1bc\x7f'), "␀a␌b␛c␡");
  assert.equal(cleanDiffLine('\tpage\ffooter\r'), "    page␌footer");
  assert.equal(cleanDiffLine('left\rright'), "left␍right");
});

test("highlighted spans visualize terminal control characters", () => {
  const palette = getPierrePalette({ name: "dark" }, config);
  const spans = flattenHighlightedLine(
    { type: "text", value: 'before\fafter\x1b' },
    "dark",
    palette,
    palette.contextRowBg,
    "before␌after␛",
  );

  assert.deepEqual(
    spans.map((span) => span.text),
    ["before␌after␛"],
  );
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

test("Pierre renderer reset clears syntax and row caches", () => {
  resetPierreRendererState();

  const metadata = cases[0];
  const highlightedSet = buildPiHighlightedDiff(metadata, config);
  const highlighted = highlightedSet.dark;
  const palette = getPierrePalette({ name: "dark" }, config);
  const cacheKey = "renderer-reset";

  const firstRows = buildCachedDiffRows(
    metadata,
    highlighted,
    palette,
    config,
    { expandCollapsed: false },
    cacheKey,
  );
  const cachedRows = buildCachedDiffRows(
    metadata,
    highlighted,
    palette,
    config,
    { expandCollapsed: false },
    cacheKey,
  );
  assert.strictEqual(cachedRows, firstRows);
  assert.equal(sharedSyntaxServiceStats().documents > 0, true);

  resetPierreRendererState();

  assert.deepEqual(sharedSyntaxServiceStats(), {
    documents: 0,
    fullParses: 0,
    incrementalParses: 0,
    reusedParses: 0,
    evictions: 0,
  });
  const rowsAfterReset = buildCachedDiffRows(
    metadata,
    highlighted,
    palette,
    config,
    { expandCollapsed: false },
    cacheKey,
  );
  assert.notStrictEqual(rowsAfterReset, firstRows);
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

function hasSyntaxSpan(node, category, text) {
  let found = false;
  const visit = (current, inherited) => {
    if (!current || found) return;
    if (current.type === "text") {
      if (inherited === category && current.value === text) found = true;
      return;
    }
    const next = current.properties?.["data-pi-syntax"] ?? inherited;
    for (const child of current.children ?? []) visit(child, next);
  };
  visit(node);
  return found;
}

function makeIncrementalTypeScriptFile(revision) {
  const lines = [
    "type Item = { id: number; label: string; enabled: boolean };",
    "export class Registry {",
    "  private items = new Map<number, Item>();",
  ];
  for (let i = 0; i < 80; i++) {
    const value = i === 37 ? revision : i;
    lines.push(`  item${i}(): Item {`);
    lines.push(
      `    const item: Item = { id: ${value}, label: "item-${i}", enabled: true };`,
    );
    lines.push("    this.items.set(item.id, item);");
    lines.push("    return item;");
    lines.push("  }");
  }
  lines.push("}");
  lines.push("export const registry = new Registry();");
  return lines;
}

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
