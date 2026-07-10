import assert from "node:assert/strict";
import test from "node:test";
import { reconcileInlineImageComponents } from "../src/rich-tools/read-image-cache.ts";

test("unchanged read images keep their component instances", () => {
  const first = entry("first", "image/png");
  const second = entry("second", "image/jpeg");
  let creations = 0;

  const reconciled = reconcileInlineImageComponents(
    [first, second],
    [
      { data: "first", mimeType: "image/png" },
      { data: "second", mimeType: "image/jpeg" },
    ],
    (image) => {
      creations += 1;
      return entry(image.data, image.mimeType);
    },
  );

  assert.deepEqual(reconciled, [first, second]);
  assert.equal(creations, 0);
});

test("read image reconciliation replaces changed images", () => {
  const first = entry("first", "image/png");
  const second = entry("second", "image/jpeg");
  const created = [];

  const reconciled = reconcileInlineImageComponents(
    [first, second],
    [
      { data: "first", mimeType: "image/png" },
      { data: "changed", mimeType: "image/png" },
    ],
    (image) => {
      const next = entry(image.data, image.mimeType);
      created.push(next);
      return next;
    },
  );

  assert.strictEqual(reconciled[0], first);
  assert.strictEqual(reconciled[1], created[0]);
  assert.equal(created.length, 1);
});

function entry(data, mimeType) {
  return { data, mimeType, component: {} };
}
