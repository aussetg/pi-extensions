import assert from "node:assert/strict";
import test from "node:test";
import { applyPatchUpdateBody } from "../src/apply-body.ts";

test("update body reports trailing-whitespace fuzzy context matches", () => {
  const result = applyPatchUpdateBody(
    "a  \nb\n",
    "@@\n a\n-b\n+B\n",
  );

  assert.equal(result.output, "a  \nB\n");
  assert.equal(result.fuzz, 1);
  assert.deepEqual(result.fuzzKinds, ["trim-end"]);
});

test("update body reports Unicode-normalized fuzzy matches", () => {
  const result = applyPatchUpdateBody(
    'const x = "—";\n',
    '@@\n-const x = "-";\n+const x = "dash";\n',
  );

  assert.equal(result.output, 'const x = "dash";\n');
  assert.equal(result.fuzz, 2000);
  assert.deepEqual(result.fuzzKinds, ["unicode"]);
});

test("update body reports EOF fallback fuzzy matches", () => {
  const result = applyPatchUpdateBody(
    "a\nb\nc\n",
    "@@\n a\n-b\n+B\n*** End of File\n",
  );

  assert.equal(result.output, "a\nB\nc\n");
  assert.equal(result.fuzz, 10000);
  assert.deepEqual(result.fuzzKinds, ["eof"]);
});
