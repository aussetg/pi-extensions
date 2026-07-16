import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { applyFileRenameWorkspaceEdit, applyWorkspaceEdit, readWorkspaceEditFileState, resolveFileRenameOperation } from "../src/lsp/workspace-edit.ts";

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

test("workspace edit safely coalesces duplicate identical replacement edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-duplicate-replace-"));
  const filePath = path.join(root, "probe.txt");
  await writeFile(filePath, "source", "utf8");

  try {
    const duplicate = textEdit(0, 0, 0, 6, "renamed");
    const result = await applyWorkspaceEdit({
      changes: {
        [pathToFileURL(filePath).href]: [duplicate, structuredClone(duplicate)],
      },
    }, root);

    assert.equal(result.applied, true);
    assert.equal(result.editCount, 2);
    assert.equal(await readFile(filePath, "utf8"), "renamed");
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

test("workspace edit cancellation while queued prevents a late mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-cancel-"));
  const filePath = path.join(root, "probe.txt");
  await writeFile(filePath, "base", "utf8");

  let releaseQueue;
  const queueGate = new Promise((resolve) => {
    releaseQueue = resolve;
  });
  const enteredQueue = Promise.withResolvers();
  const mutationQueue = async (_filePath, run) => {
    enteredQueue.resolve();
    await queueGate;
    return run();
  };
  const controller = new AbortController();

  try {
    const applying = applyWorkspaceEdit(singleFileEdit(filePath, "changed"), root, {
      mutationQueue,
      signal: controller.signal,
    });
    await enteredQueue.promise;
    controller.abort();

    await assert.rejects(applying, (error) => error?.name === "AbortError");
    assert.equal(await readFile(filePath, "utf8"), "base");

    releaseQueue();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await readFile(filePath, "utf8"), "base");
  } finally {
    releaseQueue?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent multi-file workspace edits acquire mutation queues without deadlocking", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-concurrent-"));
  const firstPath = path.join(root, "first.txt");
  const secondPath = path.join(root, "second.txt");
  await writeFile(firstPath, "base", "utf8");
  await writeFile(secondPath, "base", "utf8");
  const mutationQueue = createMutationQueue();
  let timeout;

  try {
    const left = applyWorkspaceEdit(multiFileEdit([
      [firstPath, "L"],
      [secondPath, "L"],
    ]), root, { mutationQueue });
    const right = applyWorkspaceEdit(multiFileEdit([
      [secondPath, "R"],
      [firstPath, "R"],
    ]), root, { mutationQueue });

    const results = await Promise.race([
      Promise.all([left, right]),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("concurrent WorkspaceEdits deadlocked")), 1000);
      }),
    ]);

    assert.deepEqual(results.map((result) => result.applied), [true, true]);
    assert.equal(await readFile(firstPath, "utf8"), "RLbase");
    assert.equal(await readFile(secondPath, "utf8"), "RLbase");
  } finally {
    clearTimeout(timeout);
    await rm(root, { recursive: true, force: true });
  }
});

test("partial multi-file commit failure rolls back already replaced files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-rollback-"));
  const firstPath = path.join(root, "first.txt");
  const secondPath = path.join(root, "second.txt");
  await writeFile(firstPath, "first", "utf8");
  await writeFile(secondPath, "second", "utf8");
  const capturedChanges = [];
  let renameCount = 0;

  try {
    const result = await applyWorkspaceEdit(multiFileEdit([
      [firstPath, "changed-"],
      [secondPath, "changed-"],
    ]), root, {
      captureAppliedChanges: capturedChanges,
      renameFile(sourcePath, targetPath) {
        renameCount += 1;
        if (renameCount === 2) throw new Error("injected second-file commit failure");
        renameSync(sourcePath, targetPath);
      },
    });

    assert.equal(result.applied, false);
    assert.match(result.rejected ?? "", /WorkspaceEdit commit failed: injected second-file commit failure; committed files were rolled back/);
    assert.deepEqual(result.changedFiles, []);
    assert.equal(result.rollbackFailedFiles, undefined);
    assert.equal(renameCount, 3);
    assert.deepEqual(capturedChanges, []);
    assert.equal(await readFile(firstPath, "utf8"), "first");
    assert.equal(await readFile(secondPath, "utf8"), "second");
    assert.equal((await readdir(root)).some((name) => name.startsWith(".code-feedback-")), false);
  } finally {
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

test("file rename transaction applies server edits before moving the source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-file-rename-"));
  const oldPath = path.join(root, "source.ts");
  const newPath = path.join(root, "renamed.ts");
  const consumerPath = path.join(root, "consumer.ts");
  await writeFile(oldPath, "export const value = 1;\n", "utf8");
  await writeFile(consumerPath, 'import { value } from "./source";\n', "utf8");
  await chmod(oldPath, 0o754);
  const captured = [];

  try {
    const result = await applyFileRenameWorkspaceEdit({
      changes: {
        [pathToFileURL(oldPath).href]: [textEdit(0, 0, 0, 0, "// moved\n")],
        [pathToFileURL(consumerPath).href]: [textEdit(0, 25, 0, 31, "renamed")],
      },
    }, root, { oldFilePath: oldPath, newFilePath: newPath }, {
      captureAppliedChanges: captured,
    });

    assert.equal(result.applied, true);
    assert.deepEqual(result.fileRename, { oldFilePath: oldPath, newFilePath: newPath });
    assert.deepEqual(result.changedFiles, [consumerPath, newPath]);
    assert.equal(result.editCount, 2);
    assert.equal(await readFile(newPath, "utf8"), "// moved\nexport const value = 1;\n");
    assert.equal(await readFile(consumerPath, "utf8"), 'import { value } from "./renamed";\n');
    await assert.rejects(readFile(oldPath, "utf8"), (error) => error?.code === "ENOENT");
    assert.equal((await stat(newPath)).mode & 0o777, 0o754);
    assert.deepEqual(captured, [
      {
        filePath: newPath,
        originalFilePath: oldPath,
        beforeContent: "export const value = 1;\n",
        afterContent: "// moved\nexport const value = 1;\n",
      },
      {
        filePath: consumerPath,
        beforeContent: 'import { value } from "./source";\n',
        afterContent: 'import { value } from "./renamed";\n',
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file rename transaction rolls back text edits when the filesystem move fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-file-rename-rollback-"));
  const oldPath = path.join(root, "source.ts");
  const newPath = path.join(root, "renamed.ts");
  const consumerPath = path.join(root, "consumer.ts");
  await writeFile(oldPath, "source\n", "utf8");
  await writeFile(consumerPath, "source\n", "utf8");
  const captured = [];

  try {
    const result = await applyFileRenameWorkspaceEdit(multiFileEdit([
      [oldPath, "edited-"],
      [consumerPath, "edited-"],
    ]), root, { oldFilePath: oldPath, newFilePath: newPath }, {
      captureAppliedChanges: captured,
      renameResource() {
        throw new Error("injected resource rename failure");
      },
    });

    assert.equal(result.applied, false);
    assert.match(result.rejected ?? "", /File rename transaction commit failed: injected resource rename failure; committed files were rolled back/);
    assert.deepEqual(result.changedFiles, []);
    assert.deepEqual(captured, []);
    assert.equal(await readFile(oldPath, "utf8"), "source\n");
    assert.equal(await readFile(consumerPath, "utf8"), "source\n");
    await assert.rejects(readFile(newPath, "utf8"), (error) => error?.code === "ENOENT");
    assert.equal((await readdir(root)).some((name) => name.startsWith(".code-feedback-")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file rename cancellation while queued cannot move the source later", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-file-rename-cancel-"));
  const oldPath = path.join(root, "source.ts");
  const newPath = path.join(root, "renamed.ts");
  await writeFile(oldPath, "source\n", "utf8");
  const controller = new AbortController();
  const enteredQueue = Promise.withResolvers();
  const queueGate = Promise.withResolvers();
  let first = true;
  const mutationQueue = async (_filePath, run) => {
    if (first) {
      first = false;
      enteredQueue.resolve();
      await queueGate.promise;
    }
    return run();
  };

  try {
    const applying = applyFileRenameWorkspaceEdit({ changes: {} }, root, {
      oldFilePath: oldPath,
      newFilePath: newPath,
    }, {
      mutationQueue,
      signal: controller.signal,
    });
    await enteredQueue.promise;
    controller.abort();

    await assert.rejects(applying, (error) => error?.name === "AbortError");
    queueGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await readFile(oldPath, "utf8"), "source\n");
    await assert.rejects(readFile(newPath, "utf8"), (error) => error?.code === "ENOENT");
  } finally {
    queueGate.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test("file rename transaction never overwrites a destination created during commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-file-rename-no-clobber-"));
  const oldPath = path.join(root, "source.ts");
  const newPath = path.join(root, "renamed.ts");
  const consumerPath = path.join(root, "consumer.ts");
  await writeFile(oldPath, "source\n", "utf8");
  await writeFile(consumerPath, "consumer\n", "utf8");
  let injected = false;

  try {
    const result = await applyFileRenameWorkspaceEdit(singleFileEdit(consumerPath, "edited-"), root, {
      oldFilePath: oldPath,
      newFilePath: newPath,
    }, {
      renameFile(sourcePath, targetPath) {
        renameSync(sourcePath, targetPath);
        if (!injected) {
          injected = true;
          writeFileSync(newPath, "occupied\n", { flag: "wx" });
        }
      },
    });

    assert.equal(result.applied, false);
    assert.match(result.rejected ?? "", /File rename transaction commit failed: .*EEXIST/);
    assert.equal(await readFile(oldPath, "utf8"), "source\n");
    assert.equal(await readFile(newPath, "utf8"), "occupied\n");
    assert.equal(await readFile(consumerPath, "utf8"), "consumer\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file rename path validation rejects destinations, directories, and symlink sources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-file-rename-paths-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-file-rename-outside-"));
  const sourcePath = path.join(root, "source.ts");
  const destinationPath = path.join(root, "destination.ts");
  const linkedPath = path.join(root, "linked.ts");
  const linkedDirectory = path.join(root, "outside-link");
  await writeFile(sourcePath, "source\n", "utf8");
  await writeFile(destinationPath, "destination\n", "utf8");
  await symlink(sourcePath, linkedPath);
  await symlink(outsideRoot, linkedDirectory, "dir");

  try {
    const existing = resolveFileRenameOperation(sourcePath, destinationPath, root);
    assert.equal(existing.ok, false);
    assert.match(existing.reason, /destination already exists/);

    const outside = resolveFileRenameOperation(sourcePath, path.join(root, "..", "outside.ts"), root);
    assert.equal(outside.ok, false);
    assert.match(outside.reason, /destination is outside project root/);

    const escapedThroughParent = resolveFileRenameOperation(sourcePath, path.join(linkedDirectory, "new.ts"), root);
    assert.equal(escapedThroughParent.ok, false);
    assert.match(escapedThroughParent.reason, /destination is outside project root/);

    const linked = resolveFileRenameOperation(linkedPath, path.join(root, "new.ts"), root);
    assert.equal(linked.ok, false);
    assert.match(linked.reason, /source must not be a symbolic link/);

    const directory = resolveFileRenameOperation(root, path.join(root, "new.ts"), root);
    assert.equal(directory.ok, false);
    assert.match(directory.reason, /source is not a regular file/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("file rename keeps canonical paths inside a symlinked project root", async () => {
  const container = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-file-rename-root-link-"));
  const realRoot = path.join(container, "real-project");
  const linkedRoot = path.join(container, "linked-project");
  const oldPath = path.join(realRoot, "source.ts");
  const newPath = path.join(realRoot, "renamed.ts");
  await mkdir(realRoot);
  await symlink(realRoot, linkedRoot, "dir");
  await writeFile(oldPath, "source\n", "utf8");

  try {
    const resolved = resolveFileRenameOperation(oldPath, newPath, linkedRoot);
    assert.deepEqual(resolved, { ok: true, oldFilePath: oldPath, newFilePath: newPath });

    const applied = await applyFileRenameWorkspaceEdit({ changes: {} }, linkedRoot, resolved);
    assert.equal(applied.applied, true);
    assert.equal(await readFile(newPath, "utf8"), "source\n");
    await assert.rejects(readFile(oldPath, "utf8"), (error) => error?.code === "ENOENT");
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});

function singleFileEdit(filePath, newText) {
  return {
    changes: {
      [pathToFileURL(filePath).href]: [textEdit(0, 0, 0, 0, newText)],
    },
  };
}

function multiFileEdit(entries) {
  return {
    changes: Object.fromEntries(entries.map(([filePath, newText]) => [
      pathToFileURL(filePath).href,
      [textEdit(0, 0, 0, 0, newText)],
    ])),
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
