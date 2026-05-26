import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  hashStringArrayPart,
  hashTextParts,
  hashUnknown,
} from "../src/hash.ts";

test("hashTextParts keeps part boundaries explicit", () => {
  assert.equal(hashTextParts(["a", "b"]), hashTextParts(["a", "b"]));
  assert.notEqual(hashTextParts(["a\0b"]), hashTextParts(["a", "b"]));
  assert.notEqual(hashTextParts(["ab", "c"]), hashTextParts(["a", "bc"]));
});

test("hashStringArrayPart keeps array boundaries explicit", () => {
  assert.notEqual(
    digest((hash) => {
      hashStringArrayPart(hash, []);
      hashStringArrayPart(hash, [""]);
    }),
    digest((hash) => {
      hashStringArrayPart(hash, [""]);
      hashStringArrayPart(hash, []);
    }),
  );
});

test("hashUnknown is deterministic for object key order", () => {
  assert.equal(
    digest((hash) => hashUnknown(hash, { b: 2, a: 1 })),
    digest((hash) => hashUnknown(hash, { a: 1, b: 2 })),
  );
  assert.notEqual(
    digest((hash) => hashUnknown(hash, 0)),
    digest((hash) => hashUnknown(hash, -0)),
  );
});

function digest(write) {
  const hash = createHash("sha256");
  write(hash);
  return hash.digest("hex");
}
