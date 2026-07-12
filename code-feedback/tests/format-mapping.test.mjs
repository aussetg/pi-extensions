import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { mapTouchedRangesThroughFormatting } from "../src/format/mapping.ts";

function touched(filePath, startLine, endLine = startLine) {
  return {
    uri: pathToFileURL(filePath).href,
    filePath,
    startLine,
    endLine,
    source: "tool-diff",
    confidence: "exact",
  };
}

function numberedLines(count) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`);
}

test("formatter mapping keeps exact small-file line shifts", () => {
  const filePath = "/tmp/pi-code-feedback-format-small.ts";
  const before = "line 1\nline 2\nline 3\n";
  const after = "// formatted\nline 1\nline 2\nline 3\n";

  const mapped = mapTouchedRangesThroughFormatting(filePath, before, after, [touched(filePath, 2)]);

  assert.deepEqual(mapped.map(({ startLine, endLine, confidence }) => ({ startLine, endLine, confidence })), [
    { startLine: 3, endLine: 3, confidence: "exact" },
  ]);
});

test("large formatter mapping uses bounded prefix/suffix mapping instead of whole-file LCS", () => {
  const filePath = "/tmp/pi-code-feedback-format-large.ts";
  const lines = numberedLines(1200);
  const before = `${lines.join("\n")}\n`;
  const after = `// formatted\n${lines.join("\n")}\n`;

  const mapped = mapTouchedRangesThroughFormatting(filePath, before, after, [touched(filePath, 1200)]);

  assert.deepEqual(mapped.map(({ startLine, endLine, confidence }) => ({ startLine, endLine, confidence })), [
    { startLine: 1201, endLine: 1201, confidence: "exact" },
  ]);
});

test("large formatter mapping conservatively covers changed middle regions", () => {
  const filePath = "/tmp/pi-code-feedback-format-large-middle.ts";
  const beforeLines = numberedLines(1200);
  const afterLines = [...beforeLines];
  afterLines[599] = "line 600 formatted";

  const mapped = mapTouchedRangesThroughFormatting(filePath, `${beforeLines.join("\n")}\n`, `${afterLines.join("\n")}\n`, [touched(filePath, 600)]);

  assert.deepEqual(mapped.map(({ startLine, endLine, confidence }) => ({ startLine, endLine, confidence })), [
    { startLine: 600, endLine: 600, confidence: "approximate" },
  ]);
});
