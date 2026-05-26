import assert from "node:assert/strict";
import test from "node:test";
import { firstChangedLineFromDiff } from "../src/diff-lines.ts";

test("first changed line handles CR-only line endings", () => {
  assert.equal(firstChangedLineFromDiff(" one\r two\r+three"), 3);
});
