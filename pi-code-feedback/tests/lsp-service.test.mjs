import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createLspService } from "../src/lsp/service.ts";
import { selectCodeActionForApply } from "../src/lsp/workspace-edit.ts";
import { LSP_RESULT_SERVER_ID_KEY } from "../src/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeServer = path.join(here, "fixtures", "fake-lsp-server.mjs");

test("diagnostics for a Python file are merged from ty and Ruff clients", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-"));
  const filePath = path.join(root, "probe.py");
  await writeFile(filePath, "value: int = 'nope'\n", "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "ty", "invalid-argument-type", "1", "warn"],
      },
      "python-ruff": {
        command: process.execPath,
        args: [fakeServer, "Ruff", "F401", "2"],
      },
    },
  });

  try {
    const refresh = await service.diagnosticsForFileDetailed(filePath, await readFile(filePath, "utf8"), {
      timeoutMs: 1000,
      settleMs: 0,
    });

    assert.ok(refresh);
    assert.equal(refresh.fresh, true);

    const diagnostics = [...refresh.snapshot.byUri.values()].flat();
    assert.equal(diagnostics.length, 2);
    assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.source).sort(), ["Ruff", "ty"]);
    assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.code).sort(), ["F401", "invalid-argument-type"]);

    const status = service.getStatus();
    assert.equal(status.activeClients, 2);
    assert.deepEqual(status.clients.map((client) => client.id).sort(), ["python", "python-ruff"]);

    const tyClient = status.clients.find((client) => client.id === "python");
    assert.equal(tyClient?.lastError, undefined);
    assert.equal(tyClient?.lastServerLog?.level, "warning");
    assert.match(tyClient?.lastServerLog?.message ?? "", /WARN fake server warning/);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("LSP document changes use incremental sync when the server supports it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-incremental-"));
  const filePath = path.join(root, "probe.py");
  const logPath = path.join(root, "lsp.jsonl");
  await writeFile(filePath, "one\nthree\n", "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "py", "T100", "1", "", "incremental-log", logPath],
      },
      "python-ruff": { disabled: true },
    },
  });

  try {
    await service.diagnosticsForFileDetailed(filePath, await readFile(filePath, "utf8"), {
      timeoutMs: 1000,
      settleMs: 0,
    });

    const nextContent = "one\nabc\nthree\n";
    await writeFile(filePath, nextContent, "utf8");
    const refresh = await service.diagnosticsForFileDetailed(filePath, nextContent, {
      timeoutMs: 1000,
      settleMs: 0,
    });

    assert.equal(refresh?.fresh, true);

    const entries = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(entries.length, 1);

    const change = entries[0].params.contentChanges[0];
    assert.deepEqual(change.range, {
      start: { line: 1, character: 0 },
      end: { line: 1, character: 0 },
    });
    assert.equal(change.rangeLength, 0);
    assert.equal(change.text, "abc\n");
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("document requests sync the file without forcing a save or diagnostic refresh", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-document-request-"));
  const filePath = path.join(root, "probe.py");
  const logPath = path.join(root, "lsp.jsonl");
  await writeFile(filePath, "value = 1\n", "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "py", "T100", "1", "", "sync-log", logPath],
      },
      "python-ruff": { disabled: true },
    },
  });

  try {
    assert.deepEqual(await service.hover(filePath, 1, 1), { contents: { kind: "plaintext", value: "py hover" } });
    assert.deepEqual(await service.hover(filePath, 1, 1), { contents: { kind: "plaintext", value: "py hover" } });

    const entries = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    assert.deepEqual(entries.map((entry) => entry.method), ["textDocument/didOpen"]);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("code actions for a Python file are merged from ty and Ruff clients", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-actions-"));
  const filePath = path.join(root, "probe.py");
  await writeFile(filePath, "import os\n", "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "ty", "T100", "1", "", "actions-require-diagnostics"],
      },
      "python-ruff": {
        command: process.execPath,
        args: [fakeServer, "Ruff", "F401", "2", "", "actions-resolve-require-diagnostics"],
      },
    },
  });

  try {
    const actions = await service.codeActions(filePath, 1, 1);
    assert.ok(Array.isArray(actions));
    assert.equal(actions.length, 2);
    assert.deepEqual(actions.map((action) => action[LSP_RESULT_SERVER_ID_KEY]).sort(), ["python", "python-ruff"]);
    assert.deepEqual(actions.map((action) => action.title).sort(), ["Ruff fix F401", "ty fix T100"]);
    assert.equal(actions.every((action) => action.edit), true);

    const selection = selectCodeActionForApply(actions, "python-ruff");
    assert.equal(selection.action?.title, "Ruff fix F401");
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});
