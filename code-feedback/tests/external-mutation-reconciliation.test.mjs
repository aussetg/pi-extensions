import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { createDefaultConfig } from "../src/config.ts";
import { handleToolResult } from "../src/events/tool-result.ts";
import { createLspService } from "../src/lsp/service.ts";
import { contentHash, createRuntime, recordFileMutation, setProjectRoot } from "../src/runtime.ts";
import { inactiveFormatService } from "./helpers/inactive-services.mjs";
import { readJsonLines as readJsonLog } from "./helpers/json-lines.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeServer = path.join(here, "fixtures", "fake-lsp-server.mjs");

test("successful bash results reconcile changed open documents and invalidate delayed feedback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-external-reconcile-"));
  const filePath = path.join(root, "probe.ts");
  const logPath = path.join(root, "lsp.jsonl");
  const before = "export const value = 1;\n";
  const after = "export const value = 2;\n";
  await writeFile(filePath, before, "utf8");
  const service = fakeTypeScriptService(root, logPath);
  const runtime = runtimeFor(root);

  try {
    await service.diagnosticsForFileDetailed(filePath, before, { timeoutMs: 1000, settleMs: 0 });
    await waitForJsonLog(logPath, (entries) => entries.some((entry) => entry.method === "textDocument/didSave"));
    const oldMutation = recordFileMutation(runtime, filePath);
    runtime.delayedFeedback.push({
      id: "delayed:external",
      editId: "external",
      filePath,
      mutationGeneration: oldMutation.generation,
      contentHash: contentHash(before),
      turnIndex: 1,
      writeIndex: 1,
      queuedAt: Date.now(),
      text: "stale delayed feedback",
    });
    await writeFile(logPath, "", "utf8");
    await writeFile(filePath, after, "utf8");

    const result = await handleToolResult({
      toolName: "bash",
      toolCallId: "bash-change",
      input: { command: "sed -i s/1/2/ probe.ts" },
      isError: false,
    }, { cwd: root }, runtime, service, inactiveFormatService);
    assert.equal(result, undefined);

    const entries = await waitForJsonLog(logPath, (items) => (
      items.some((entry) => entry.method === "workspace/didChangeWatchedFiles") &&
      items.some((entry) => entry.method === "textDocument/didChange") &&
      items.some((entry) => entry.method === "textDocument/didSave")
    ));
    const watchedIndex = entries.findIndex((entry) => entry.method === "workspace/didChangeWatchedFiles");
    const changeIndex = entries.findIndex((entry) => entry.method === "textDocument/didChange");
    const saveIndex = entries.findIndex((entry) => entry.method === "textDocument/didSave");
    assert.ok(watchedIndex >= 0 && watchedIndex < changeIndex && changeIndex < saveIndex);
    assert.deepEqual(entries[watchedIndex].params.changes, [{ uri: pathToFileURL(filePath).href, type: 2 }]);
    assert.equal(entries[changeIndex].params.contentChanges[0].text, after);
    assert.equal(runtime.delayedFeedback.length, 0);
    assert.notEqual(runtime.fileMutationGenerations.get(filePath), oldMutation.generation);
    assert.equal(service.getStatus().clients.length, 1);
    assert.equal(service.getStatus().clients[0].openDocuments, 1);

    await writeFile(logPath, "", "utf8");
    await writeFile(filePath, "export const value = 3;\n", "utf8");
    const generation = runtime.fileMutationGenerations.get(filePath);
    await handleToolResult({
      toolName: "bash",
      toolCallId: "bash-failed",
      input: { command: "false" },
      isError: true,
    }, { cwd: root }, runtime, service, inactiveFormatService);
    await sleep(25);
    assert.deepEqual(await readJsonLog(logPath), []);
    assert.equal(runtime.fileMutationGenerations.get(filePath), generation);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("open-document reconciliation is file-bounded, handles deletions, and never launches a client", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-external-bounds-"));
  const firstPath = path.join(root, "first.ts");
  const secondPath = path.join(root, "second.ts");
  const outsidePath = `${root}-outside.ts`;
  const content = "export const value = 1;\n";
  await writeFile(firstPath, content, "utf8");
  await writeFile(secondPath, content, "utf8");
  const service = fakeTypeScriptService(root, path.join(root, "lsp.jsonl"));
  const idle = fakeTypeScriptService(root, path.join(root, "idle.jsonl"));

  try {
    const empty = await idle.reconcileOpenDocuments();
    assert.equal(empty.candidateFiles, 0);
    assert.equal(empty.mutations.length, 0);
    assert.equal(idle.getStatus().clients.length, 0, "reconciliation must not create or start a client");

    await service.diagnosticsForFileDetailed(firstPath, content, { timeoutMs: 1000, settleMs: 0 });
    await service.diagnosticsForFileDetailed(secondPath, content, { timeoutMs: 1000, settleMs: 0 });
    await writeFile(firstPath, "export const value = 2;\n", "utf8");
    await writeFile(secondPath, "export const value = 2;\n", "utf8");

    const bounded = await service.reconcileOpenDocuments({ limit: 1 });
    assert.equal(bounded.candidateFiles, 2);
    assert.equal(bounded.inspectedFiles, 1);
    assert.equal(bounded.changedFiles, 1);
    assert.equal(bounded.fileLimitReached, true);
    assert.equal(bounded.resynchronizedDocuments, 1);

    const remainder = await service.reconcileOpenDocuments({ limit: 1 });
    assert.equal(remainder.candidateFiles, 2);
    assert.equal(remainder.changedFiles, 1);
    assert.equal(remainder.fileLimitReached, true);

    await unlink(secondPath);
    const deleted = await service.reconcileOpenDocuments();
    assert.equal(deleted.deletedFiles, 1);
    assert.deepEqual(deleted.mutations, [{ type: "deleted", filePath: secondPath }]);
    assert.equal(service.getStatus().clients[0].openDocuments, 1);

    await writeFile(outsidePath, "export const secret = 42;\n", "utf8");
    await unlink(firstPath);
    await symlink(outsidePath, firstPath);
    const unsafe = await service.reconcileOpenDocuments();
    assert.equal(unsafe.changedFiles, 1);
    assert.equal(unsafe.skippedFiles, 1);
    assert.equal(unsafe.resynchronizedDocuments, 0);
    assert.equal(unsafe.closedDocuments, 1);
    assert.equal(service.getStatus().clients[0].openDocuments, 0);
  } finally {
    await service.shutdownAll();
    await idle.shutdownAll();
    await rm(root, { recursive: true, force: true });
    await rm(outsidePath, { force: true });
  }
});

function fakeTypeScriptService(root, logPath) {
  return createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      typescript: {
        command: process.execPath,
        args: [fakeServer, "fake-ts", "TS100", "1", "", "workspace-files-log", logPath],
      },
    },
  });
}

function runtimeFor(root) {
  const runtime = createRuntime(createDefaultConfig());
  runtime.config.autoFormat = false;
  runtime.config.diagnostics.settleMs = 0;
  setProjectRoot(runtime, root);
  return runtime;
}

async function waitForJsonLog(filePath, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const entries = await readJsonLog(filePath);
    if (predicate(entries)) return entries;
    await sleep(10);
  }
  const entries = await readJsonLog(filePath);
  assert.fail(`timed out waiting for fake LSP log condition; entries=${JSON.stringify(entries)}`);
}
