import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { LspClient } from "../src/lsp/client.ts";
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

test("semantic tokens are exposed as a lazy cached overlay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-semantic-overlay-"));
  const filePath = path.join(root, "probe.py");
  const logPath = path.join(root, "lsp.jsonl");
  await writeFile(filePath, "value = 1\nprint(value)\n", "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "py", "T100", "1", "", "semantic-delay-80", logPath],
      },
      "python-ruff": { disabled: true },
    },
  });

  try {
    const first = await service.semanticTokens(filePath, { waitMs: 0, timeoutMs: 1000 });
    assert.equal(first.state, "refreshing");
    assert.equal(first.stale, false);
    assert.deepEqual(first.tokens, []);

    await waitForJsonLog(logPath, (entries) => entries.some((entry) => entry.method === "textDocument/semanticTokens/full"));
    await sleep(110);

    const second = await service.semanticTokens(filePath, { waitMs: 20, timeoutMs: 1000 });
    assert.equal(second.state, "ready");
    assert.equal(second.stale, false);
    assert.equal(second.tokens.length, 3);
    assert.deepEqual(second.tokens[0], {
      line: 0,
      character: 0,
      length: 5,
      type: "variable",
      modifiers: ["declaration"],
    });

    const countAfterFill = (await readJsonLog(logPath)).filter((entry) => entry.method === "textDocument/semanticTokens/full").length;
    const third = await service.semanticTokens(filePath, { waitMs: 0, timeoutMs: 1000 });
    assert.equal(third.state, "ready");
    assert.equal(third.tokens.length, 3);
    await sleep(30);
    assert.equal((await readJsonLog(logPath)).filter((entry) => entry.method === "textDocument/semanticTokens/full").length, countAfterFill);

    await writeFile(filePath, "value = 2\nprint(value)\n", "utf8");
    const stale = await service.semanticTokens(filePath, { waitMs: 0, timeoutMs: 1000 });
    assert.equal(stale.state, "refreshing");
    assert.equal(stale.stale, true);
    assert.equal(stale.tokens.length, 3);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic token refresh restarts when the document changes while a request is in flight", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-semantic-restart-"));
  const filePath = path.join(root, "probe.py");
  const logPath = path.join(root, "lsp.jsonl");
  await writeFile(filePath, "value = 1\nprint(value)\n", "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "py", "T100", "1", "", "semantic-delay-80", logPath],
      },
      "python-ruff": { disabled: true },
    },
  });

  try {
    const first = await service.semanticTokens(filePath, { waitMs: 0, timeoutMs: 1000 });
    assert.equal(first.state, "refreshing");
    assert.equal(first.version, 1);

    await sleep(10);
    await writeFile(filePath, "value = 2\nprint(value)\n", "utf8");

    const second = await service.semanticTokens(filePath, { waitMs: 0, timeoutMs: 1000 });
    assert.equal(second.state, "refreshing");
    assert.equal(second.version, 2);

    const entries = await waitForJsonLog(logPath, (items) => semanticTokenRequestCount(items) >= 2);
    assert.equal(semanticTokenRequestCount(entries), 2);

    await sleep(110);

    const ready = await service.semanticTokens(filePath, { waitMs: 20, timeoutMs: 1000 });
    assert.equal(ready.state, "ready");
    assert.equal(ready.stale, false);
    assert.equal(ready.version, 2);
    assert.equal(ready.tokens.length, 3);
    assert.equal(semanticTokenRequestCount(await readJsonLog(logPath)), 2);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent diagnostics refreshes for the same file are coalesced", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-diagnostic-queue-"));
  const filePath = path.join(root, "probe.py");
  const logPath = path.join(root, "lsp.jsonl");
  const content = "value = 1\n";
  await writeFile(filePath, content, "utf8");

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
    const refreshes = await Promise.all(Array.from({ length: 5 }, () => service.diagnosticsForFileDetailed(filePath, content, {
      timeoutMs: 1000,
      settleMs: 0,
    })));

    assert.equal(refreshes.length, 5);
    assert.equal(refreshes.every((refresh) => refresh?.fresh), true);

    const entries = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    assert.deepEqual(entries.map((entry) => entry.method), ["textDocument/didOpen", "textDocument/didSave"]);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("timed out LSP requests send a cancel notification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-cancel-"));
  const filePath = path.join(root, "probe.py");
  const logPath = path.join(root, "lsp.jsonl");
  await writeFile(filePath, "value = 1\n", "utf8");

  const client = new LspClient({
    id: "python",
    command: process.execPath,
    args: [fakeServer, "py", "T100", "1", "", "hover-delay-200", logPath],
    extensions: [".py"],
    languageId: () => "python",
  }, root);

  try {
    await assert.rejects(
      () => client.request("textDocument/hover", {
        textDocument: { uri: pathToFileURL(filePath).href },
        position: { line: 0, character: 0 },
      }, 20),
      /LSP request timed out: textDocument\/hover/,
    );

    const entries = await waitForJsonLog(logPath, (entries) => entries.some((entry) => entry.method === "$/cancelRequest"));
    const cancellations = entries.filter((entry) => entry.method === "$/cancelRequest");
    assert.equal(cancellations.length, 1);
    assert.deepEqual(cancellations[0].params, { id: 2 });
  } finally {
    await client.shutdown();
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

async function waitForJsonLog(filePath, predicate) {
  let entries = [];
  for (let attempt = 0; attempt < 50; attempt += 1) {
    entries = await readJsonLog(filePath);
    if (predicate(entries)) return entries;
    await sleep(10);
  }
  return entries;
}

async function readJsonLog(filePath) {
  try {
    return (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function semanticTokenRequestCount(entries) {
  return entries.filter((entry) => entry.method === "textDocument/semanticTokens/full").length;
}
