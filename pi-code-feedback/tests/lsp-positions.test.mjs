import assert from "node:assert/strict";
import { test } from "node:test";
import {
  externalPositionToLsp,
  isLspPosition,
  isLspRange,
  lspPositionToExternal,
  lspRangeToExternal,
} from "../src/lsp/positions.ts";
import { renderLspActionResult } from "../src/lsp/render.ts";

test("LSP position conversion rejects malformed coordinates instead of clamping", () => {
  assert.deepEqual(lspPositionToExternal({ line: 0, character: 4 }), { line: 1, character: 5 });

  for (const position of [
    { line: -1, character: 0 },
    { line: 0, character: -1 },
    { line: 0.5, character: 0 },
    { line: Number.NaN, character: 0 },
    { line: Number.POSITIVE_INFINITY, character: 0 },
    { line: 2_147_483_648, character: 0 },
    { line: "0", character: 0 },
  ]) {
    assert.equal(isLspPosition(position), false, JSON.stringify(position));
    assert.equal(lspPositionToExternal(position), undefined, JSON.stringify(position));
  }
});

test("LSP range conversion rejects malformed and backwards ranges", () => {
  const valid = {
    start: { line: 2, character: 3 },
    end: { line: 2, character: 8 },
  };
  assert.equal(isLspRange(valid), true);
  assert.deepEqual(lspRangeToExternal(valid), {
    start: { line: 3, character: 4 },
    end: { line: 3, character: 9 },
  });

  for (const range of [
    { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } },
    { start: { line: 3, character: 0 }, end: { line: 2, character: 9 } },
    { start: { line: 2, character: 9 }, end: { line: 2, character: 8 } },
  ]) {
    assert.equal(isLspRange(range), false);
    assert.equal(lspRangeToExternal(range), undefined);
  }
});

test("position-scoped requests reject coordinates outside the LSP uinteger range", () => {
  assert.deepEqual(externalPositionToLsp(2_147_483_648, 1), { line: 2_147_483_647, character: 0 });
  assert.equal(externalPositionToLsp(2_147_483_649, 1), undefined);
});

test("rendering drops locations with malformed LSP ranges", () => {
  const result = renderLspActionResult("definition", [{
    uri: "file:///tmp/probe.ts",
    range: {
      start: { line: -1, character: 5 },
      end: { line: 0, character: 8 },
    },
  }], "/tmp");

  assert.equal(result, "No definition result.");
});
