import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { createDefaultConfig } from "../src/config.ts";
import { handleToolCall } from "../src/events/tool-call.ts";
import { handleToolResult, processAppliedLspFileMutations } from "../src/events/tool-result.ts";
import { createLspService } from "../src/lsp/service.ts";
import { createRuntime, setProjectRoot } from "../src/runtime.ts";
import { inactiveFormatService } from "./helpers/inactive-services.mjs";
import { readJsonLines as readJsonLog } from "./helpers/json-lines.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeServer = path.join(here, "fixtures", "fake-lsp-server.mjs");

test("watched-file notifications preserve push state, use LSP event types, and never start a client", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-watched-files-"));
  const filePath = path.join(root, "probe.ts");
  const configPath = path.join(root, "tsconfig.json");
  const createdPath = path.join(root, "generated.ts");
  const deletedPath = path.join(root, "deleted.ts");
  const outsidePath = path.join(path.dirname(root), "outside.ts");
  const logPath = path.join(root, "lsp.jsonl");
  const content = "export const value = 1;\n";
  await writeFile(filePath, content, "utf8");
  await writeFile(configPath, "{}\n", "utf8");
  await writeFile(deletedPath, content, "utf8");
  const service = fakeTypeScriptService(root, logPath);

  try {
    service.notifyFileMutations([{ type: "changed", filePath }]);
    assert.equal(service.getStatus().clients.length, 0, "a watched-file event must not launch a server");

    const refresh = await service.diagnosticsForFileDetailed(filePath, content, { timeoutMs: 1000, settleMs: 0 });
    assert.equal(refresh?.fresh, true);
    assert.ok(service.cachedDiagnosticsIfKnown(filePath));
    await waitForJsonLog(logPath, (entries) => entries.some((entry) => entry.method === "textDocument/didSave"));

    service.notifyFileMutations([
      { type: "created", filePath: createdPath },
      { type: "changed", filePath },
      { type: "changed", filePath: configPath },
      { type: "deleted", filePath: deletedPath },
      { type: "changed", filePath: outsidePath },
    ]);

    const entries = await waitForJsonLog(logPath, (items) => items.some((entry) => entry.method === "workspace/didChangeWatchedFiles"));
    const watched = entries.find((entry) => entry.method === "workspace/didChangeWatchedFiles");
    assert.deepEqual(watched?.params?.changes, [
      { uri: pathToFileURL(createdPath).href, type: 1 },
      { uri: pathToFileURL(filePath).href, type: 2 },
      { uri: pathToFileURL(configPath).href, type: 2 },
      { uri: pathToFileURL(deletedPath).href, type: 3 },
    ]);
    assert.ok(service.cachedDiagnosticsIfKnown(filePath), "push diagnostics remain current until the server replaces them");
    assert.equal(service.getStatus().clients.length, 1);

    const initialize = entries.find((entry) => entry.method === "initialize");
    assert.deepEqual(initialize?.params?.capabilities?.workspace?.fileOperations, {
      dynamicRegistration: false,
      willCreate: false,
      didCreate: false,
      willRename: true,
      didRename: true,
      willDelete: false,
      didDelete: false,
    });
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("rename notifications close the old document and announce delete/create watched events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-rename-files-"));
  const oldPath = path.join(root, "old.ts");
  const newPath = path.join(root, "new.ts");
  const logPath = path.join(root, "lsp.jsonl");
  const content = "export const value = 1;\n";
  await writeFile(oldPath, content, "utf8");
  const service = fakeTypeScriptService(root, logPath);

  try {
    await service.diagnosticsForFileDetailed(oldPath, content, { timeoutMs: 1000, settleMs: 0 });
    await waitForJsonLog(logPath, (entries) => entries.some((entry) => entry.method === "textDocument/didSave"));
    await writeFile(logPath, "", "utf8");
    await rename(oldPath, newPath);

    service.notifyFileMutations([{ type: "renamed", oldFilePath: oldPath, newFilePath: newPath }]);
    const entries = await waitForJsonLog(logPath, (items) => (
      items.some((entry) => entry.method === "workspace/didRenameFiles") &&
      items.some((entry) => entry.method === "workspace/didChangeWatchedFiles")
    ));

    const closeIndex = entries.findIndex((entry) => entry.method === "textDocument/didClose");
    const renameIndex = entries.findIndex((entry) => entry.method === "workspace/didRenameFiles");
    const watchedIndex = entries.findIndex((entry) => entry.method === "workspace/didChangeWatchedFiles");
    assert.ok(closeIndex >= 0 && closeIndex < renameIndex && renameIndex < watchedIndex);
    assert.deepEqual(entries[renameIndex].params.files, [{
      oldUri: pathToFileURL(oldPath).href,
      newUri: pathToFileURL(newPath).href,
    }]);
    assert.deepEqual(entries[watchedIndex].params.changes, [
      { uri: pathToFileURL(oldPath).href, type: 3 },
      { uri: pathToFileURL(newPath).href, type: 1 },
    ]);
    assert.equal(service.getStatus().clients[0]?.openDocuments, 0);
    assert.equal(service.getStatus().clients[0]?.diagnosticFiles, 0);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("apply_patch announces the complete sibling batch before diagnostics and re-announces formatter writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-patch-watched-files-"));
  const firstPath = path.join(root, "first.ts");
  const secondPath = path.join(root, "second.ts");
  const logPath = path.join(root, "lsp.jsonl");
  const before = "export const value = 1;\n";
  const after = "export const value = 2;\n";
  await writeFile(firstPath, before, "utf8");
  await writeFile(secondPath, before, "utf8");

  const runtime = runtimeFor(root);
  runtime.config.autoFormat = true;
  runtime.config.diagnostics.inline = "off";
  const service = fakeTypeScriptService(root, logPath);
  const formatService = {
    async formatFile(filePath, content) {
      const finalContent = `${content}// formatted\n`;
      await writeFile(filePath, finalContent, "utf8");
      return {
        formatterName: "fake formatter",
        command: "fake-formatter",
        changed: true,
        finalContent,
        errors: [],
        durationMs: 0,
      };
    },
  };
  const input = {
    operations: [
      { type: "update_file", path: "first.ts" },
      { type: "update_file", path: "second.ts" },
    ],
  };

  try {
    await service.diagnosticsForFileDetailed(firstPath, before, { timeoutMs: 1000, settleMs: 0 });
    await waitForJsonLog(logPath, (entries) => entries.some((entry) => entry.method === "textDocument/didSave"));
    await writeFile(logPath, "", "utf8");

    await handleToolCall({ toolName: "apply_patch", toolCallId: "patch", input }, { cwd: root }, runtime, service);
    await writeFile(firstPath, after, "utf8");
    await writeFile(secondPath, after, "utf8");
    await handleToolResult({
      toolName: "apply_patch",
      toolCallId: "patch",
      input,
      details: {
        stage: "done",
        results: [
          { type: "update_file", path: "first.ts", status: "completed" },
          { type: "update_file", path: "second.ts", status: "completed" },
        ],
      },
      content: [{ type: "text", text: "patched" }],
      isError: false,
    }, { cwd: root }, runtime, service, formatService);

    const entries = await waitForJsonLog(logPath, (items) => (
      items.filter((entry) => entry.method === "workspace/didChangeWatchedFiles").length >= 3 &&
      items.filter((entry) => entry.method === "textDocument/didSave").length >= 2
    ));
    const watched = entries.filter((entry) => entry.method === "workspace/didChangeWatchedFiles");
    assert.deepEqual(watched[0].params.changes, [
      { uri: pathToFileURL(firstPath).href, type: 2 },
      { uri: pathToFileURL(secondPath).href, type: 2 },
    ]);
    assert.deepEqual(watched[1].params.changes, [{ uri: pathToFileURL(firstPath).href, type: 2 }]);
    assert.deepEqual(watched[2].params.changes, [{ uri: pathToFileURL(secondPath).href, type: 2 }]);

    const firstDocumentSync = entries.findIndex((entry) => (
      entry.method === "textDocument/didOpen" ||
      entry.method === "textDocument/didChange" ||
      entry.method === "textDocument/didSave"
    ));
    assert.ok(firstDocumentSync > entries.indexOf(watched[0]), "the sibling batch must be sent before the first diagnostic document sync");
    assert.match(await readFile(firstPath, "utf8"), /\/\/ formatted/);
    assert.match(await readFile(secondPath, "utf8"), /\/\/ formatted/);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("write and applied WorkspaceEdit feedback classify and batch their mutations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-feedback-mutations-"));
  const createdPath = path.join(root, "created.ts");
  const otherPath = path.join(root, "other.ts");
  const runtime = runtimeFor(root);
  runtime.config.autoFormat = false;
  runtime.config.diagnostics.inline = "off";
  const notifications = [];
  const lspService = {
    prewarm() {},
    cachedDiagnosticsIfKnown() { return undefined; },
    notifyFileMutations(mutations) { notifications.push(mutations); },
    async diagnosticsForFileDetailed() { return undefined; },
  };

  try {
    await handleToolCall({ toolName: "write", toolCallId: "write", input: { path: "created.ts" } }, { cwd: root }, runtime, lspService);
    await writeFile(createdPath, "export const value = 1;\n", "utf8");
    await handleToolResult({
      toolName: "write",
      toolCallId: "write",
      input: { path: "created.ts" },
      isError: false,
    }, { cwd: root }, runtime, lspService, inactiveFormatService);
    assert.deepEqual(notifications.shift(), [{ type: "created", filePath: createdPath }]);

    await writeFile(createdPath, "export const value = 2;\n", "utf8");
    await writeFile(otherPath, "export const other = 2;\n", "utf8");
    await processAppliedLspFileMutations(
      { content: [{ type: "text", text: "applied" }] },
      [
        {
          id: "workspace-edit:1",
          filePath: createdPath,
          beforeContent: "export const value = 1;\n",
          afterAgentContent: "export const value = 2;\n",
        },
        {
          id: "workspace-edit:2",
          filePath: otherPath,
          beforeContent: "export const other = 1;\n",
          afterAgentContent: "export const other = 2;\n",
        },
      ],
      runtime,
      lspService,
      inactiveFormatService,
    );
    assert.deepEqual(notifications.shift(), [
      { type: "changed", filePath: createdPath },
      { type: "changed", filePath: otherPath },
    ]);
    assert.equal(notifications.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("apply_patch maps moves and deletes to filesystem notifications", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-patch-file-events-"));
  const oldPath = path.join(root, "old.ts");
  const newPath = path.join(root, "new.ts");
  const content = "export const value = 1;\n";
  await writeFile(oldPath, content, "utf8");
  const runtime = runtimeFor(root);
  runtime.config.autoFormat = false;
  runtime.config.diagnostics.inline = "off";
  const notifications = [];
  const lspService = {
    prewarm() {},
    forgetFile() {},
    cachedDiagnosticsIfKnown() { return undefined; },
    notifyFileMutations(mutations) { notifications.push(mutations); },
    async diagnosticsForFileDetailed() { return undefined; },
  };

  try {
    const moveInput = { operations: [{ type: "update_file", path: "old.ts", move_path: "new.ts" }] };
    await handleToolCall({ toolName: "apply_patch", toolCallId: "move", input: moveInput }, { cwd: root }, runtime, lspService);
    await rename(oldPath, newPath);
    await handleToolResult({
      toolName: "apply_patch",
      toolCallId: "move",
      input: moveInput,
      details: {
        stage: "done",
        results: [{
          type: "update_file",
          path: "new.ts",
          status: "completed",
          change: { type: "update", unifiedDiff: "", movePath: "new.ts" },
        }],
      },
      isError: false,
    }, { cwd: root }, runtime, lspService, inactiveFormatService);
    assert.deepEqual(notifications.shift(), [{ type: "renamed", oldFilePath: oldPath, newFilePath: newPath }]);

    const deleteInput = { operations: [{ type: "delete_file", path: "new.ts" }] };
    await handleToolCall({ toolName: "apply_patch", toolCallId: "delete", input: deleteInput }, { cwd: root }, runtime, lspService);
    await unlink(newPath);
    await handleToolResult({
      toolName: "apply_patch",
      toolCallId: "delete",
      input: deleteInput,
      details: {
        stage: "done",
        results: [{ type: "delete_file", path: "new.ts", status: "completed" }],
      },
      isError: false,
    }, { cwd: root }, runtime, lspService, inactiveFormatService);
    assert.deepEqual(notifications.shift(), [{ type: "deleted", filePath: newPath }]);
    assert.equal(notifications.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
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
  runtime.config.lsp.enabled = true;
  runtime.config.diagnostics.timeoutMs = 1000;
  runtime.config.diagnostics.inlineTimeoutMs = 1000;
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
