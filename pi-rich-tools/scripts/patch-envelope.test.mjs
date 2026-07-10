import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePatchEnvelopeDetailed,
  prepareApplyPatchArguments,
  takePreparedApplyPatchWarnings,
} from "../src/patch-envelope.ts";

test("full envelope parser surfaces missing end marker repair", () => {
  const parsed = parsePatchEnvelopeDetailed(
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

test("patch argument accepts a complete patch envelope without repair warnings", () => {
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
    parsePatchEnvelopeDetailed(
      "*** Begin Patch\n*** Delete File: stale.txt\n*** End Patch\nnot patch\n",
    ),
    undefined,
  );
});

test("full envelope parser repairs trailing markdown fence", () => {
  const parsed = parsePatchEnvelopeDetailed(
    "*** Begin Patch\n*** Delete File: stale.txt\n*** End Patch\n```\n",
  );

  assert.deepEqual(parsed?.operations, [
    { type: "delete_file", path: "stale.txt" },
  ]);
  assert.match(parsed?.warnings[0] ?? "", /ignored trailing markdown fence/);
});

test("full envelope parser repairs missing end before trailing markdown fence", () => {
  const parsed = parsePatchEnvelopeDetailed(
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
  const parsed = parsePatchEnvelopeDetailed("*** Delete File: stale.txt\n");

  assert.deepEqual(parsed?.operations, [
    { type: "delete_file", path: "stale.txt" },
  ]);
  assert.match(
    parsed?.warnings.join("\n") ?? "",
    /without '\*\*\* Begin Patch'\/\'\*\*\* End Patch'/,
  );
});

test("file-header text in a context line is not parsed as another operation", () => {
  const parsed = parsePatchEnvelopeDetailed(
    "*** Begin Patch\n*** Update File: a.md\n@@\n *** Update File: b.md\n-old\n+new\n*** End Patch\n",
  );

  assert.deepEqual(parsed?.operations, [
    {
      type: "update_file",
      path: "a.md",
      diff: "@@\n *** Update File: b.md\n-old\n+new",
    },
  ]);
});

test("end-marker text in a context line does not terminate the envelope", () => {
  const parsed = parsePatchEnvelopeDetailed(
    "*** Begin Patch\n*** Update File: a.md\n@@\n *** End Patch\n-old\n+new\n*** End Patch\n",
  );

  assert.deepEqual(parsed?.operations, [
    {
      type: "update_file",
      path: "a.md",
      diff: "@@\n *** End Patch\n-old\n+new",
    },
  ]);
});
