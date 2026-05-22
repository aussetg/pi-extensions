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

test("direct file sections remain accepted without an envelope", () => {
  const parsed = parseCodexPatchEnvelopeDetailed("*** Delete File: stale.txt\n");

  assert.deepEqual(parsed?.operations, [
    { type: "delete_file", path: "stale.txt" },
  ]);
  assert.deepEqual(parsed?.warnings, []);
});
