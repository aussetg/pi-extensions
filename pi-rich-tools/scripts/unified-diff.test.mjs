import assert from "node:assert/strict";
import test from "node:test";
import { unifiedPatchFromNumberedDiff } from "../src/unified-diff.ts";

test("numbered diff conversion keeps leading deletion newStart at line 1", () => {
  const patch = unifiedPatchFromNumberedDiff({
    oldPath: "file.txt",
    newPath: "file.txt",
    diff: [
      "-1 a",
      " 2 b",
      " 3 c",
      " 4 d",
      " 5 e",
    ].join("\n"),
  });

  assert.match(patch, /@@ -1,5 \+1,4 @@/);
});

test("numbered diff conversion carries deltas across separated hunks", () => {
  const patch = unifiedPatchFromNumberedDiff({
    oldPath: "file.txt",
    newPath: "file.txt",
    diff: [
      "-1 a",
      " 2 b",
      "   ...",
      " 10 j",
      "-11 k",
      "+10 K",
      " 12 l",
    ].join("\n"),
  });

  assert.match(patch, /@@ -1,2 \+1,1 @@/);
  assert.match(patch, /@@ -10,3 \+9,3 @@/);
});
