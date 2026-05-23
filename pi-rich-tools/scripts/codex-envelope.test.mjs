import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCodexPatchEnvelopeDetailed,
  prepareApplyPatchArguments,
  takePreparedApplyPatchWarnings,
} from "../src/codex-envelope.ts";

test("full envelope parser surfaces missing end marker repair", () => {
  const parsed = parseCodexPatchEnvelopeDetailed(
    "*** Begin Patch\n*** Delete File: stale.txt\n",
  );

  assert.deepEqual(parsed?.operations, [
    { type: "delete_file", path: "stale.txt" },
  ]);
  assert.match(parsed?.warnings[0] ?? "", /added missing '\*\*\* End Patch'/);
});

test("prepared full-envelope repair warnings are available to execute", () => {
  const prepared = prepareApplyPatchArguments(
    "*** Begin Patch\n*** Delete File: stale.txt\n",
  );

  assert.deepEqual((prepared).operations, [
    { type: "delete_file", path: "stale.txt" },
  ]);
  assert.match(
    takePreparedApplyPatchWarnings(prepared)[0] ?? "",
    /added missing '\*\*\* End Patch'/,
  );
});

test("patch argument accepts a complete Codex envelope without repair warnings", () => {
  const prepared = prepareApplyPatchArguments({
    patch: "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch\n",
  });

  assert.deepEqual((prepared).operations, [
    { type: "create_file", path: "hello.txt", diff: "+hello" },
  ]);
  assert.deepEqual(takePreparedApplyPatchWarnings(prepared), []);
});

test("full envelope parser rejects non-repairable trailing garbage", () => {
  assert.equal(
    parseCodexPatchEnvelopeDetailed(
      "*** Begin Patch\n*** Delete File: stale.txt\n*** End Patch\nnot patch\n",
    ),
    undefined,
  );
});

test("full envelope parser repairs trailing markdown fence", () => {
  const parsed = parseCodexPatchEnvelopeDetailed(
    "*** Begin Patch\n*** Delete File: stale.txt\n*** End Patch\n```\n",
  );

  assert.deepEqual(parsed?.operations, [
    { type: "delete_file", path: "stale.txt" },
  ]);
  assert.match(parsed?.warnings[0] ?? "", /ignored trailing markdown fence/);
});

test("full envelope parser repairs missing end before trailing markdown fence", () => {
  const parsed = parseCodexPatchEnvelopeDetailed(
    "*** Begin Patch\n*** Delete File: stale.txt\n```\n",
  );

  assert.deepEqual(parsed?.operations, [
    { type: "delete_file", path: "stale.txt" },
  ]);
  assert.equal(parsed?.warnings.length, 2);
  assert.match(parsed?.warnings.join("\n") ?? "", /missing end marker/);
  assert.match(parsed?.warnings.join("\n") ?? "", /added missing/);
});

test("direct file sections are accepted with an envelope repair warning", () => {
  const parsed = parseCodexPatchEnvelopeDetailed("*** Delete File: stale.txt\n");

  assert.deepEqual(parsed?.operations, [
    { type: "delete_file", path: "stale.txt" },
  ]);
  assert.match(
    parsed?.warnings.join("\n") ?? "",
    /without '\*\*\* Begin Patch'\/\'\*\*\* End Patch'/,
  );
});
