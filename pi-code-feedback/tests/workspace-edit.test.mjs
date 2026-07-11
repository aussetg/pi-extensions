import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { applyWorkspaceEdit, readWorkspaceEditFileState } from "../src/lsp/workspace-edit.ts";

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

test("workspace edit preserves file permissions across atomic replacement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-mode-"));
  const filePath = path.join(root, "probe.txt");
  await writeFile(filePath, "base", "utf8");
  await chmod(filePath, 0o764);

  try {
    const result = await applyWorkspaceEdit(singleFileEdit(filePath, "safe"), root);
    assert.equal(result.applied, true);
    assert.equal((await stat(filePath)).mode & 0o777, 0o764);
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

test("workspace edit waits in the shared mutation queue before reading or writing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-queue-"));
  const filePath = path.join(root, "probe.txt");
  await writeFile(filePath, "base", "utf8");
  const mutationQueue = createMutationQueue();

  let releaseBlocker;
  const blockerReady = Promise.withResolvers();
  const blocker = mutationQueue(filePath, async () => {
    blockerReady.resolve();
    await new Promise((resolve) => {
      releaseBlocker = resolve;
    });
  });

  try {
    await blockerReady.promise;
    let settled = false;
    const applying = applyWorkspaceEdit(singleFileEdit(filePath, "safe"), root, { mutationQueue })
      .finally(() => {
        settled = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false);
    assert.equal(await readFile(filePath, "utf8"), "base");

    releaseBlocker();
    await blocker;
    assert.equal((await applying).applied, true);
    assert.equal(await readFile(filePath, "utf8"), "safebase");
  } finally {
    releaseBlocker?.();
    await blocker;
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace edit rejects target changes made after preview", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-stale-"));
  const filePath = path.join(root, "probe.txt");
  await writeFile(filePath, "base", "utf8");
  const expected = readWorkspaceEditFileState(filePath);

  try {
    await writeFile(filePath, "changed", "utf8");
    const result = await applyWorkspaceEdit(singleFileEdit(filePath, "unsafe"), root, {
      expectedFileStates: [expected],
    });

    assert.equal(result.applied, false);
    assert.match(result.rejected ?? "", /target changed since preview/);
    assert.equal(await readFile(filePath, "utf8"), "changed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace edit validates TextDocumentEdit versions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-version-"));
  const filePath = path.join(root, "probe.txt");
  await writeFile(filePath, "base", "utf8");
  const edit = {
    documentChanges: [{
      textDocument: { uri: pathToFileURL(filePath).href, version: 3 },
      edits: [textEdit(0, 0, 0, 0, "V")],
    }],
  };

  try {
    const stale = await applyWorkspaceEdit(edit, root, { getDocumentVersion: () => 2 });
    assert.equal(stale.applied, false);
    assert.match(stale.rejected ?? "", /document version is stale/);
    assert.equal(await readFile(filePath, "utf8"), "base");

    const current = await applyWorkspaceEdit(edit, root, { getDocumentVersion: () => 3 });
    assert.equal(current.applied, true);
    assert.equal(await readFile(filePath, "utf8"), "Vbase");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace edit rejects malformed positions instead of clamping them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-position-"));
  const filePath = path.join(root, "probe.txt");
  await writeFile(filePath, "base", "utf8");

  try {
    for (const position of [
      { line: -1, character: 0 },
      { line: 0, character: -1 },
      { line: 0.5, character: 0 },
      { line: Number.NaN, character: 0 },
    ]) {
      const result = await applyWorkspaceEdit({
        changes: {
          [pathToFileURL(filePath).href]: [{ range: { start: position, end: { line: 0, character: 0 } }, newText: "bad" }],
        },
      }, root);
      assert.equal(result.applied, false, JSON.stringify(position));
      assert.match(result.rejected ?? "", /range is malformed/, JSON.stringify(position));
    }
    assert.equal(await readFile(filePath, "utf8"), "base");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace edit resolves symlinks before enforcing the project boundary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-outside-"));
  const outsideFile = path.join(outside, "outside.txt");
  const linkedFile = path.join(root, "linked.txt");
  await writeFile(outsideFile, "outside", "utf8");
  await symlink(outsideFile, linkedFile);

  try {
    const result = await applyWorkspaceEdit(singleFileEdit(linkedFile, "bad"), root);
    assert.equal(result.applied, false);
    assert.match(result.rejected ?? "", /outside project root/);
    assert.equal(await readFile(outsideFile, "utf8"), "outside");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

function singleFileEdit(filePath, newText) {
  return {
    changes: {
      [pathToFileURL(filePath).href]: [textEdit(0, 0, 0, 0, newText)],
    },
  };
}

function createMutationQueue() {
  const tails = new Map();
  return async (filePath, run) => {
    const key = path.resolve(filePath);
    const current = tails.get(key) ?? Promise.resolve();
    const gate = Promise.withResolvers();
    const tail = current.then(() => gate.promise);
    tails.set(key, tail);
    await current;
    try {
      return await run();
    } finally {
      gate.resolve();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

function textEdit(startLine, startCharacter, endLine, endCharacter, newText) {
  return {
    range: {
      start: { line: startLine, character: startCharacter },
      end: { line: endLine, character: endCharacter },
    },
    newText,
  };
}
