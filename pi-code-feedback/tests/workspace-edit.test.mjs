import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { applyWorkspaceEdit } from "../src/lsp/workspace-edit.ts";

test("workspace edit preserves LSP array order for same-position inserts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-inserts-"));
  const filePath = path.join(root, "probe.txt");
  await writeFile(filePath, "base", "utf8");

  try {
    const result = await applyWorkspaceEdit({
      changes: {
        [pathToFileURL(filePath).href]: [
          textEdit(0, 0, 0, 0, "A"),
          textEdit(0, 0, 0, 0, "B"),
        ],
      },
    }, root);

    assert.equal(result.applied, true);
    assert.equal(await readFile(filePath, "utf8"), "ABbase");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace edit applies same-start inserts before a following replace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-insert-replace-"));
  const filePath = path.join(root, "probe.txt");
  await writeFile(filePath, "abcdef", "utf8");

  try {
    const result = await applyWorkspaceEdit({
      changes: {
        [pathToFileURL(filePath).href]: [
          textEdit(0, 1, 0, 1, "X"),
          textEdit(0, 1, 0, 1, "Y"),
          textEdit(0, 1, 0, 3, "R"),
        ],
      },
    }, root);

    assert.equal(result.applied, true);
    assert.equal(await readFile(filePath, "utf8"), "aXYRdef");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace edit rejects malformed same-start replace before insert", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-bad-order-"));
  const filePath = path.join(root, "probe.txt");
  await writeFile(filePath, "abcdef", "utf8");

  try {
    const result = await applyWorkspaceEdit({
      changes: {
        [pathToFileURL(filePath).href]: [
          textEdit(0, 1, 0, 3, "R"),
          textEdit(0, 1, 0, 1, "X"),
        ],
      },
    }, root);

    assert.equal(result.applied, false);
    assert.match(result.rejected ?? "", /Invalid same-position LSP text edit order/);
    assert.equal(await readFile(filePath, "utf8"), "abcdef");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function textEdit(startLine, startCharacter, endLine, endCharacter, newText) {
  return {
    range: {
      start: { line: startLine, character: startCharacter },
      end: { line: endLine, character: endCharacter },
    },
    newText,
  };
}
