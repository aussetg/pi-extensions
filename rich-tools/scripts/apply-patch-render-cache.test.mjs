import assert from "node:assert/strict";
import test from "node:test";
import { renderApplyPatchResult } from "../src/render.ts";

const theme = {
  name: "dark",
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

test("apply_patch result rendering reuses cached rows on unchanged frames", () => {
  const result = {
    content: [{ type: "text", text: "✓ update src/example.ts" }],
    details: {
      stage: "done",
      fuzz: 0,
      results: [
        {
          type: "update_file",
          path: "src/example.ts",
          status: "completed",
          change: {
            type: "update",
            unifiedDiff:
              "Index: src/example.ts\n" +
              "===================================================================\n" +
              "--- src/example.ts\n" +
              "+++ src/example.ts\n" +
              "@@ -1,2 +1,2 @@\n" +
              " export const before = 1;\n" +
              "-export const value = 1;\n" +
              "+export const value = 2;\n",
          },
        },
      ],
      warnings: [],
    },
  };

  const context = { invalidate() {} };
  const firstComponent = renderApplyPatchResult(
    result,
    { expanded: false, isPartial: false },
    theme,
    context,
  );
  context.lastComponent = firstComponent;
  const firstRows = firstComponent.render(100);

  const secondComponent = renderApplyPatchResult(
    result,
    { expanded: false, isPartial: false },
    theme,
    context,
  );
  context.lastComponent = secondComponent;
  const secondRows = secondComponent.render(100);

  assert.equal(secondComponent, firstComponent);
  assert.equal(secondRows, firstRows);
});

test("apply_patch renders previewable results when siblings are unpreviewable", () => {
  const result = {
    content: [{ type: "text", text: "✓ create empty.txt\n✓ update src/example.ts" }],
    details: {
      stage: "done",
      fuzz: 0,
      results: [
        {
          type: "create_file",
          path: "empty.txt",
          status: "completed",
          change: { type: "add", content: "" },
        },
        {
          type: "update_file",
          path: "src/example.ts",
          status: "completed",
          change: {
            type: "update",
            unifiedDiff:
              "Index: src/example.ts\n" +
              "===================================================================\n" +
              "--- src/example.ts\n" +
              "+++ src/example.ts\n" +
              "@@ -1,2 +1,2 @@\n" +
              " export const before = 1;\n" +
              "-export const value = 1;\n" +
              "+export const value = 2;\n",
          },
        },
      ],
      warnings: [],
    },
  };

  const component = renderApplyPatchResult(
    result,
    { expanded: false, isPartial: false },
    theme,
    { invalidate() {} },
  );
  const text = stripAnsi(component.render(500).join("\n"));

  assert.match(text, /export const value = 2;/);
  assert.match(text, /create:\s+empty\.txt/);
});

test("move-only apply_patch results render the operation summary", () => {
  const result = {
    content: [{ type: "text", text: "✓ update b.txt — Moved from a.txt" }],
    details: {
      stage: "done",
      fuzz: 0,
      results: [
        {
          type: "update_file",
          path: "b.txt",
          status: "completed",
          output: "Moved from a.txt",
          change: {
            type: "update",
            movePath: "b.txt",
            unifiedDiff:
              "===================================================================\n" +
              "--- a.txt\n" +
              "+++ b.txt\n",
          },
        },
      ],
      warnings: [],
    },
  };

  const component = renderApplyPatchResult(
    result,
    { expanded: false, isPartial: false },
    theme,
    { invalidate() {} },
  );
  const text = stripAnsi(component.render(120).join("\n"));

  assert.match(text, /update:\s+b\.txt\s+— Moved from a\.txt/);
  assert.doesNotMatch(text, /No diff/);
});

test("partial apply_patch results render completed diffs and failed operations", () => {
  const result = {
    content: [
      {
        type: "text",
        text:
          "Patch partially applied:\n" +
          "✓ update src/example.ts\n" +
          "✗ update missing.txt — File not found at path 'missing.txt'",
      },
    ],
    details: {
      stage: "done",
      fuzz: 0,
      results: [
        {
          type: "update_file",
          path: "src/example.ts",
          status: "completed",
          change: {
            type: "update",
            unifiedDiff:
              "Index: src/example.ts\n" +
              "===================================================================\n" +
              "--- src/example.ts\n" +
              "+++ src/example.ts\n" +
              "@@ -1,2 +1,2 @@\n" +
              " export const before = 1;\n" +
              "-export const value = 1;\n" +
              "+export const value = 2;\n",
          },
        },
        {
          type: "update_file",
          path: "missing.txt",
          status: "failed",
          output: "File not found at path 'missing.txt'",
        },
      ],
      warnings: [],
    },
  };

  const component = renderApplyPatchResult(
    result,
    { expanded: false, isPartial: false },
    theme,
    { invalidate() {} },
  );
  const text = stripAnsi(component.render(500).join("\n"));

  assert.match(text, /export const value = 2;/);
  assert.match(text, /✗\s+update:\s+missing\.txt\s+— File not found/);
});

test("code feedback stays left-aligned on the full-width settled tool surface", () => {
  const feedbackTheme = {
    name: "dark",
    fg: (_color, text) => text,
    bg: (color, text) => {
      const rgb = color === "toolPendingBg" ? "50;48;47" : "45;59;45";
      return `\x1b[48;2;${rgb}m${text}\x1b[49m`;
    },
    bold: (text) => text,
  };
  const result = {
    content: [{ type: "text", text: "✓ update src/example.ts" }],
    details: {
      stage: "done",
      fuzz: 0,
      results: [
        {
          type: "update_file",
          path: "src/example.ts",
          status: "completed",
          change: {
            type: "update",
            unifiedDiff:
              "--- src/example.ts\n" +
              "+++ src/example.ts\n" +
              "@@ -1 +1 @@\n" +
              "-export const value = 1;\n" +
              "+export const value = 2;\n",
          },
        },
      ],
      warnings: [],
      piCodeFeedback: {
        edits: [
          {
            displayPath: "src/example.ts",
            diagnostics: {
              linked: [
                {
                  diagnostic: {
                    severity: "error",
                    message: "Example diagnostic",
                    range: { start: { line: 1, character: 1 } },
                  },
                },
              ],
              summary: {},
            },
          },
        ],
      },
    },
  };

  const lines = renderApplyPatchResult(
    result,
    { expanded: false, isPartial: false },
    feedbackTheme,
    { invalidate() {} },
  ).render(80);
  const trayStart = lines.findIndex((line) => stripAnsi(line).includes("code feedback"));

  assert.ok(trayStart > 0, "expected feedback after the diff");
  assert.equal(stripAnsi(lines[trayStart - 1]).trim(), "", "the edit should keep its trailing breathing room");
  assert.match(stripAnsi(lines.slice(trayStart).join("\n")), /code feedback.*1 error/);
  assert.doesNotMatch(stripAnsi(lines.slice(trayStart).join("\n")), /[╭╮╰╯│]/);
  for (const line of lines.slice(trayStart)) {
    assert.ok(
      line.startsWith("\x1b[48;2;45;59;45m"),
      "feedback should retain the settled tool background",
    );
    assert.equal(stripAnsi(line).length, 80);
  }
  assert.ok(stripAnsi(lines[trayStart]).startsWith(" code feedback"));
});

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}
