import assert from "node:assert/strict";
import test from "node:test";
import { renderCodeFeedbackFromDetails } from "../src/code-feedback.ts";

const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => `\x1b[48;2;50;48;47m${text}\x1b[49m`,
  bold: (text) => text,
};

function visibleWidth(text) {
  return [...text.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

test("shared code-feedback rendering preserves structured panels", () => {
  const feedback = renderCodeFeedbackFromDetails({
    piCodeFeedback: {
      edits: [{
        displayPath: "fallback.ts",
        filePath: "/workspace/src/example.ts",
        formatter: {
          changed: true,
          formatterName: "prettier",
          command: "prettier --write",
        },
        diagnostics: {
          linked: [{
            diagnostic: {
              severity: "error",
              message: "Example diagnostic",
              source: "ts",
              code: 1234,
              uri: "file:///workspace/src/example.ts",
              range: { start: { line: 4, character: 2 } },
            },
            linkReason: "same-file",
          }],
          summary: { hiddenUnrelated: 2, hiddenByLimit: 1 },
        },
      }],
    },
  }, theme, { expanded: false, cwd: "/workspace" });

  assert.equal(typeof feedback, "object");
  assert.equal(feedback.attachesToPrevious, true);
  const lines = feedback.render(120);
  const text = lines.join("\n");
  const compactText = text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ");
  assert.match(compactText, /code feedback.*1 error.*1 formatted.*2 unrelated hidden, 1 more hidden/);
  assert.match(text, /formatted src\/example\.ts with prettier \(prettier --write\)/);
  assert.match(text, /ERROR src\/example\.ts:4:2 ts\/1234 \[same-file\]/);
  assert.match(text, /Example diagnostic/);
  assert.doesNotMatch(text, /[╭╮╰╯│]/);

  for (const line of lines) {
    assert.equal(visibleWidth(line), 120, "feedback card rows should preserve the tool width");
  }
  for (const line of feedback.render(5)) {
    assert.ok(visibleWidth(line) <= 5, `line exceeded narrow width: ${line}`);
  }
});

test("shared code-feedback rendering preserves inline fallback text", () => {
  const feedback = renderCodeFeedbackFromDetails({
    piCodeFeedback: { inlineText: "formatter unavailable", edits: [] },
  }, theme, { expanded: false });

  assert.equal(typeof feedback, "object");
  assert.match(
    feedback.render(40).join("\n"),
    /code feedback[\s\S]*formatter unavailable/,
  );
});
