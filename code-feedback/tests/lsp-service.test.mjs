import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { LspClient } from "../src/lsp/client.ts";
import { loadLanguageServerConfiguration } from "../src/lsp/server-config.ts";
import { createLspService } from "../src/lsp/service.ts";
import { LSP_RESULT_CODE_ACTION_CAN_RESOLVE_KEY, LSP_RESULT_SERVER_ID_KEY, LSP_RESULT_SERVER_SESSION_ID_KEY } from "../src/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeServer = path.join(here, "fixtures", "fake-lsp-server.mjs");
const realTypeScriptLanguageServer = path.join(here, "..", "node_modules", ".bin", "typescript-language-server");

test("diagnostic refresh concurrency is configurable and clamped", () => {
  const root = os.tmpdir();
  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    diagnosticRefreshConcurrency: 3,
  });

  assert.equal(service.getStatus().diagnosticRefreshes?.concurrency, 3);

  service.configure({ projectRoot: root, idleTimeoutMs: 0 });
  assert.equal(service.getStatus().diagnosticRefreshes?.concurrency, 3);

  service.configure({ projectRoot: root, idleTimeoutMs: 0, diagnosticRefreshConcurrency: 99 });
  assert.equal(service.getStatus().diagnosticRefreshes?.concurrency, 16);

  service.configure({ projectRoot: root, idleTimeoutMs: 0, diagnosticRefreshConcurrency: 0 });
  assert.equal(service.getStatus().diagnosticRefreshes?.concurrency, 1);
});

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

test("a configured custom extension routes through a language-agnostic server definition", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-custom-server-"));
  const agentDir = path.join(root, "agent");
  const projectRoot = path.join(root, "project");
  const configDir = path.join(projectRoot, ".pi-test");
  const filePath = path.join(projectRoot, "main.gleam");
  const logPath = path.join(root, "custom-server.jsonl");
  await mkdir(agentDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(filePath, "pub fn main() { Nil }\n", "utf8");
  await writeFile(path.join(configDir, "code-feedback.json"), JSON.stringify({
    servers: {
      gleam: {
        command: [process.execPath, fakeServer, "gleam-lsp", "G100", "1", "", "sync-log", logPath],
        extensions: [".gleam"],
        languageId: "gleam",
      },
    },
  }), "utf8");

  const serverConfiguration = loadLanguageServerConfiguration({
    agentDir,
    projectRoot,
    configDirName: ".pi-test",
    projectTrusted: true,
  });
  const service = createLspService({
    projectRoot,
    idleTimeoutMs: 0,
    serverConfiguration,
  });

  try {
    service.configure({ projectRoot, idleTimeoutMs: 0 });
    const refresh = await service.diagnosticsForFileDetailed(filePath, await readFile(filePath, "utf8"), {
      timeoutMs: 1000,
      settleMs: 0,
    });

    assert.equal(refresh?.fresh, true);
    const diagnostics = [...refresh.snapshot.byUri.values()].flat();
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].source, "gleam-lsp");
    assert.equal(service.getStatus().clients[0]?.id, "gleam");
    assert.deepEqual(service.getStatus().serverConfiguration?.configuredServerIds, ["gleam"]);

    const workspace = await service.diagnosticsForWorkspace(projectRoot, {
      limit: 10,
      timeoutMs: 1000,
      settleMs: 0,
      server: "gleam",
    });
    assert.equal(workspace.summary.selectedFiles, 1);
    assert.equal(workspace.summary.freshFiles, 1);
    assert.deepEqual(workspace.files.map((file) => path.basename(file.filePath)), ["main.gleam"]);

    const entries = await waitForJsonLog(logPath, (items) => items.some((entry) => entry.method === "textDocument/didOpen"));
    const didOpen = entries.find((entry) => entry.method === "textDocument/didOpen");
    assert.equal(didOpen?.params?.textDocument?.languageId, "gleam");
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit requests can select one of multiple matching language servers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-server-selection-"));
  const filePath = path.join(root, "probe.py");
  const content = "value = 1\n";
  await writeFile(filePath, content, "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "ty", "T100", "1"],
      },
      "python-ruff": {
        command: process.execPath,
        args: [fakeServer, "ruff", "R100", "2"],
      },
    },
  });

  try {
    const hover = await service.hover(filePath, { line: 1, column: 1 }, undefined, "python-ruff");
    assert.equal(hover?.contents?.value, "ruff hover");

    const refresh = await service.diagnosticsForFileDetailed(filePath, content, {
      timeoutMs: 1000,
      settleMs: 0,
      server: "python-ruff",
    });
    const diagnostics = [...refresh.snapshot.byUri.values()].flat();
    assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.source), ["ruff"]);

    await assert.rejects(
      service.hover(filePath, { line: 1, column: 1 }, undefined, "missing-server"),
      /Unknown language server "missing-server"/,
    );
    const automaticallyRoutedRename = await service.rename(filePath, { line: 1, column: 1 }, "renamed");
    assert.equal(automaticallyRoutedRename[LSP_RESULT_SERVER_ID_KEY], "python");

    const rename = await service.rename(filePath, { line: 1, column: 1 }, "renamed", undefined, "python");
    assert.equal(rename[LSP_RESULT_SERVER_ID_KEY], "python");
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("advertised document diagnostics use an authoritative pull response", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-pull-diagnostics-"));
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
        args: [fakeServer, "py", "T100", "1", "", "pull-related", logPath],
      },
      "python-ruff": { disabled: true },
    },
  });

  try {
    const refresh = await service.diagnosticsForFileDetailed(filePath, content, {
      timeoutMs: 1000,
      settleMs: 0,
      snapshotScope: "workspace",
    });

    assert.equal(refresh?.fresh, true);
    assert.equal(refresh?.timedOut, false);
    const diagnostics = [...refresh.snapshot.byUri.values()].flat();
    assert.equal(diagnostics.length, 2);
    const primary = refresh.snapshot.byUri.get(pathToFileURL(filePath).href);
    assert.equal(primary?.[0].code, "T100");
    assert.equal(primary?.[0].version, 1);
    const related = refresh.snapshot.byUri.get(pathToFileURL(path.join(root, "related.py")).href);
    assert.equal(related?.[0].code, "T100");
    assert.equal(related?.[0].version, undefined);

    const entries = await waitForJsonLog(logPath, (items) => items.some((entry) => entry.method === "textDocument/diagnostic"));
    const initialize = entries.find((entry) => entry.method === "initialize");
    assert.deepEqual(initialize?.params?.capabilities?.textDocument?.diagnostic, {
      dynamicRegistration: false,
      relatedDocumentSupport: true,
    });
    const pull = entries.find((entry) => entry.method === "textDocument/diagnostic");
    assert.deepEqual(pull?.params, {
      textDocument: { uri: pathToFileURL(filePath).href },
      identifier: "fake-pull",
    });
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty pull diagnostic report is fresh and authoritatively clean", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-pull-clean-"));
  const filePath = path.join(root, "probe.py");
  const content = "value = 1\n";
  await writeFile(filePath, content, "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "py", "T100", "1", "", "pull-clean"],
      },
      "python-ruff": { disabled: true },
    },
  });

  try {
    const refresh = await service.diagnosticsForFileDetailed(filePath, content, {
      timeoutMs: 1000,
      settleMs: 0,
    });

    assert.equal(refresh?.fresh, true);
    assert.equal(refresh?.timedOut, false);
    assert.equal(refresh?.snapshot.byUri.size, 0);
    assert.ok(service.cachedDiagnosticsIfKnown(filePath));
    assert.equal(service.getStatus().clients[0]?.lastDiagnosticOutcome, "fresh");
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("a falsely advertised pull method falls back to pushed diagnostics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-pull-fallback-"));
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
        args: [fakeServer, "py", "T100", "1", "", "pull-unsupported", logPath],
      },
      "python-ruff": { disabled: true },
    },
  });

  try {
    const refresh = await service.diagnosticsForFileDetailed(filePath, content, {
      timeoutMs: 1000,
      settleMs: 0,
    });

    assert.equal(refresh?.fresh, true);
    assert.equal(refresh?.timedOut, false);
    assert.equal([...refresh.snapshot.byUri.values()].flat().length, 1);
    const entries = await waitForJsonLog(logPath, (items) => items.some((entry) => entry.method === "textDocument/diagnostic"));
    assert.equal(entries.filter((entry) => entry.method === "textDocument/diagnostic").length, 1);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed pull response is never interpreted as clean", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-pull-invalid-"));
  const filePath = path.join(root, "probe.py");
  const content = "value = 1\n";
  await writeFile(filePath, content, "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "py", "T100", "1", "", "pull-invalid"],
      },
      "python-ruff": { disabled: true },
    },
  });

  try {
    const refresh = await service.diagnosticsForFileDetailed(filePath, content, {
      timeoutMs: 30,
      settleMs: 0,
    });

    assert.equal(refresh?.fresh, false);
    assert.equal(refresh?.timedOut, true);
    assert.equal(refresh?.snapshot.byUri.size, 0);
    for (let attempt = 0; attempt < 20 && service.getStatus().diagnosticRefreshes?.active !== 0; attempt += 1) {
      await sleep(10);
    }
    assert.equal(service.getStatus().clients[0]?.lastDiagnosticOutcome, "timeout");
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed diagnostic item arrays are never interpreted as clean", async () => {
  for (const mode of ["pull-malformed-items", "push-malformed-items"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), `pi-code-feedback-${mode}-`));
    const filePath = path.join(root, "probe.py");
    const content = "value = 1\n";
    await writeFile(filePath, content, "utf8");

    const service = createLspService({
      projectRoot: root,
      idleTimeoutMs: 0,
      serverOverrides: {
        python: {
          command: process.execPath,
          args: [fakeServer, "py", "T100", "1", "", mode],
        },
        "python-ruff": { disabled: true },
      },
    });

    try {
      const refresh = await service.diagnosticsForFileDetailed(filePath, content, {
        timeoutMs: 30,
        settleMs: 0,
      });

      assert.equal(refresh?.fresh, false, mode);
      assert.equal(refresh?.timedOut, true, mode);
      assert.equal(refresh?.snapshot.byUri.size, 0, mode);
      assert.equal(service.cachedDiagnosticsIfKnown(filePath), undefined, mode);
    } finally {
      await service.shutdownAll();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("service shutdown starts all client shutdowns in parallel", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-shutdown-parallel-"));
  const filePath = path.join(root, "probe.py");
  const logPath = path.join(root, "shutdown.jsonl");
  const releasePath = `${logPath}.release`;
  await writeFile(filePath, "value = 1\n", "utf8");

  const server = (source) => ({
    command: process.execPath,
    args: [fakeServer, source, "T100", "1", "", "shutdown-gate", logPath],
  });
  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      python: server("python"),
      "python-ruff": server("python-ruff"),
    },
  });
  let shutdown;

  try {
    await service.capabilities(filePath);
    shutdown = service.shutdownAll();
    const entries = await waitForJsonLog(logPath, (items) => items.filter((entry) => entry.method === "shutdown").length === 2);
    assert.deepEqual(entries.map((entry) => entry.source).sort(), ["python", "python-ruff"]);
    await writeFile(releasePath, "", "utf8");
    await shutdown;
  } finally {
    await writeFile(releasePath, "", "utf8").catch(() => undefined);
    await shutdown?.catch(() => undefined);
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed diagnostic positions do not make valid diagnostics authoritative", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-malformed-diagnostic-"));
  const filePath = path.join(root, "probe.py");
  await writeFile(filePath, "value = 1\n", "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "py", "T100", "1", "", "malformed-diagnostic-position"],
      },
      "python-ruff": { disabled: true },
    },
  });

  try {
    const result = await service.diagnosticsForFileDetailed(filePath, await readFile(filePath, "utf8"), {
      timeoutMs: 30,
      settleMs: 0,
    });
    const diagnostics = [...result.snapshot.byUri.values()].flat();
    assert.equal(result.fresh, false);
    assert.equal(result.timedOut, true);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, "T100");
    assert.deepEqual(diagnostics[0].range.start, { line: 1, character: 1 });
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("file diagnostic refresh snapshots only the requested URI unless workspace scope is requested", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-scope-"));
  const firstPath = path.join(root, "first.py");
  const secondPath = path.join(root, "second.py");
  await writeFile(firstPath, "first = 1\n", "utf8");
  await writeFile(secondPath, "second = 2\n", "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "py", "T100", "1"],
      },
      "python-ruff": { disabled: true },
    },
  });

  try {
    await service.diagnosticsForFileDetailed(firstPath, await readFile(firstPath, "utf8"), {
      timeoutMs: 1000,
      settleMs: 0,
    });

    const secondRefresh = await service.diagnosticsForFileDetailed(secondPath, await readFile(secondPath, "utf8"), {
      timeoutMs: 1000,
      settleMs: 0,
    });

    assert.deepEqual([...secondRefresh.snapshot.byUri.keys()], [pathToFileURL(secondPath).href]);
    assert.deepEqual([...service.cachedDiagnostics(secondPath).byUri.keys()], [pathToFileURL(secondPath).href]);

    const workspaceRefresh = await service.diagnosticsForFileDetailed(secondPath, await readFile(secondPath, "utf8"), {
      timeoutMs: 1000,
      settleMs: 0,
      snapshotScope: "workspace",
    });

    assert.deepEqual(
      [...workspaceRefresh.snapshot.byUri.keys()].sort(),
      [pathToFileURL(firstPath).href, pathToFileURL(secondPath).href].sort(),
    );
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

test("forced diagnostic refreshes resync push-only documents instead of accepting cached diagnostics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-force-fresh-diagnostic-"));
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
        args: [fakeServer, "py", "T100", "1", "", "workspace-files-log", logPath],
      },
      "python-ruff": { disabled: true },
    },
  });

  try {
    const first = await service.diagnosticsForFileDetailed(filePath, content, {
      timeoutMs: 1000,
      settleMs: 0,
    });
    const forced = await service.diagnosticsForFileDetailed(filePath, content, {
      timeoutMs: 1000,
      settleMs: 0,
      forceFresh: true,
    });

    assert.equal(first?.fresh, true);
    assert.equal(forced?.fresh, true);
    const entries = await waitForJsonLog(logPath, (current) => (
      current.filter((entry) => entry.method === "textDocument/didOpen").length === 1 &&
      current.some((entry) => entry.method === "textDocument/didChange")
    ));
    assert.equal(entries.filter((entry) => entry.method === "textDocument/didOpen").length, 1);
    assert.equal(entries.filter((entry) => entry.method === "textDocument/didChange").length, 1);
    assert.deepEqual(entries.find((entry) => entry.method === "textDocument/didChange")?.params.contentChanges, [{ text: content }]);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("TypeScript diagnostics use authoritative tsserver requests when the LSP suppresses repeated clean publications", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-typescript-direct-clean-"));
  const filePath = path.join(root, "probe.ts");
  const logPath = path.join(root, "lsp.jsonl");
  const content = "export const value = 1;\n";
  await writeFile(filePath, content, "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      typescript: {
        command: process.execPath,
        args: [fakeServer, "typescript", "TS100", "1", "", "typescript-direct-clean", logPath],
      },
    },
  });

  try {
    const first = await service.diagnosticsForFileDetailed(filePath, content, {
      timeoutMs: 1000,
      settleMs: 0,
      forceFresh: true,
    });
    const second = await service.diagnosticsForFileDetailed(filePath, content, {
      timeoutMs: 1000,
      settleMs: 0,
      forceFresh: true,
    });

    assert.equal(first?.fresh, true);
    assert.equal(second?.fresh, true);
    assert.equal([...second.snapshot.byUri.values()].flat().length, 0);
    const entries = await waitForJsonLog(logPath, (items) => (
      items.filter((entry) => entry.method === "workspace/executeCommand").length === 6
    ));
    assert.deepEqual(
      entries.filter((entry) => entry.method === "workspace/executeCommand").map((entry) => entry.command),
      [
        "syntacticDiagnosticsSync",
        "semanticDiagnosticsSync",
        "suggestionDiagnosticsSync",
        "syntacticDiagnosticsSync",
        "semanticDiagnosticsSync",
        "suggestionDiagnosticsSync",
      ],
    );
    assert.equal(entries.some((entry) => entry.method === "textDocument/didChange"), false);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("authoritative tsserver diagnostic responses are normalized as LSP diagnostics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-typescript-direct-items-"));
  const filePath = path.join(root, "probe.ts");
  const logPath = path.join(root, "lsp.jsonl");
  const content = "export const value: string = 1;\n";
  await writeFile(filePath, content, "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      typescript: {
        command: process.execPath,
        args: [fakeServer, "typescript", "TS100", "1", "", "typescript-direct-diagnostics", logPath],
      },
    },
  });

  try {
    const refresh = await service.diagnosticsForFileDetailed(filePath, content, {
      timeoutMs: 1000,
      settleMs: 0,
      forceFresh: true,
    });
    assert.equal(refresh?.fresh, true);
    const diagnostic = refresh?.snapshot.byUri.get(pathToFileURL(filePath).href)?.[0];
    assert.deepEqual(diagnostic, {
      uri: pathToFileURL(filePath).href,
      range: {
        start: { line: 2, character: 3 },
        end: { line: 2, character: 8 },
      },
      severity: "error",
      message: "typescript direct diagnostic",
      source: "typescript",
      code: 2322,
      relatedInformation: [{
        uri: pathToFileURL(path.join(root, "related.ts")).href,
        range: {
          start: { line: 1, character: 2 },
          end: { line: 1, character: 4 },
        },
        message: "related TypeScript location",
      }],
      version: 1,
    });
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("real typescript-language-server returns repeated clean diagnostics without waiting for a suppressed push", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-typescript-real-clean-"));
  const filePath = path.join(root, "probe.ts");
  const content = "export const value: number = 1;\n";
  await writeFile(filePath, content, "utf8");
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }), "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      typescript: {
        command: realTypeScriptLanguageServer,
        args: ["--stdio"],
      },
    },
  });

  try {
    const first = await service.diagnosticsForFileDetailed(filePath, content, {
      timeoutMs: 5000,
      settleMs: 0,
      forceFresh: true,
      server: "typescript",
    });
    const second = await service.diagnosticsForFileDetailed(filePath, content, {
      timeoutMs: 5000,
      settleMs: 0,
      forceFresh: true,
      server: "typescript",
    });
    assert.equal(first?.fresh, true);
    assert.equal(second?.fresh, true);
    assert.equal([...second.snapshot.byUri.values()].flat().length, 0);
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
    assert.deepEqual(await service.hover(filePath, { line: 1, column: 1 }), { contents: { kind: "plaintext", value: "py hover" } });
    assert.deepEqual(await service.hover(filePath, { line: 1, column: 1 }), { contents: { kind: "plaintext", value: "py hover" } });

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

test("diagnostic refresh cancellation stops waiting and drains the running job", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-diagnostic-cancel-"));
  const filePath = path.join(root, "probe.py");
  await writeFile(filePath, "value = 1\n", "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "py", "T100", "1", "", "diagnostics-delay-500"],
      },
      "python-ruff": { disabled: true },
    },
  });

  try {
    await service.capabilities(filePath);
    const controller = new AbortController();
    const refresh = service.diagnosticsForFileDetailed(filePath, await readFile(filePath, "utf8"), {
      timeoutMs: 1000,
      settleMs: 0,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);

    await assert.rejects(refresh, (error) => error?.name === "AbortError");
    for (let attempt = 0; attempt < 20 && service.getStatus().diagnosticRefreshes?.active !== 0; attempt += 1) {
      await sleep(10);
    }
    const status = service.getStatus();
    assert.equal(status.diagnosticRefreshes?.active, 0);
    assert.equal(status.diagnosticRefreshes?.queued, 0);
    assert.equal(status.clients[0]?.lastDiagnosticOutcome, "cancelled");
    assert.equal(typeof status.clients[0]?.lastDiagnosticDurationMs, "number");
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnostic refresh status distinguishes timeouts from cancellation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-diagnostic-timeout-status-"));
  const filePath = path.join(root, "probe.py");
  const content = "value = 1\n";
  await writeFile(filePath, content, "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "py", "T100", "1", "", "no-diagnostics"],
      },
      "python-ruff": { disabled: true },
    },
  });

  try {
    const result = await service.diagnosticsForFileDetailed(filePath, content, {
      timeoutMs: 30,
      settleMs: 0,
    });
    assert.equal(result?.timedOut, true);

    for (let attempt = 0; attempt < 20 && service.getStatus().diagnosticRefreshes?.active !== 0; attempt += 1) {
      await sleep(10);
    }
    const clientStatus = service.getStatus().clients[0];
    assert.equal(clientStatus?.lastDiagnosticOutcome, "timeout");
    assert.equal(typeof clientStatus?.lastDiagnosticDurationMs, "number");
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling one coalesced diagnostic waiter does not cancel the others", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-diagnostic-shared-cancel-"));
  const filePath = path.join(root, "probe.py");
  const content = "value = 1\n";
  await writeFile(filePath, content, "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "py", "T100", "1", "", "diagnostics-delay-80"],
      },
      "python-ruff": { disabled: true },
    },
  });

  try {
    await service.capabilities(filePath);
    const controller = new AbortController();
    const cancelled = service.diagnosticsForFileDetailed(filePath, content, {
      timeoutMs: 1000,
      settleMs: 0,
      signal: controller.signal,
    });
    const surviving = service.diagnosticsForFileDetailed(filePath, content, {
      timeoutMs: 1000,
      settleMs: 0,
    });
    setTimeout(() => controller.abort(), 20);

    await assert.rejects(cancelled, (error) => error?.name === "AbortError");
    assert.equal((await surviving)?.fresh, true);
    assert.equal(service.getStatus().clients[0]?.lastDiagnosticOutcome, "fresh");
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
    role: "language",
    command: process.execPath,
    args: [fakeServer, "py", "T100", "1", "", "hover-delay-200", logPath],
    extensions: [".py"],
    rootMarkers: [],
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

test("hung initialization is killed and obsolete child exits cannot corrupt replacement state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-initialize-retry-"));
  const processLog = path.join(root, "processes.jsonl");
  const client = new LspClient({
    id: "python",
    role: "language",
    command: process.execPath,
    args: [fakeServer, "py", "T100", "1", "", "initialize-delay-once-500", processLog],
    extensions: [".py"],
    rootMarkers: [],
    languageId: () => "python",
  }, root, { initializeTimeoutMs: 250 });

  let firstPid;
  try {
    await assert.rejects(() => client.start(), /LSP request timed out: initialize/);

    const firstLaunches = await waitForJsonLog(processLog, (entries) => entries.length >= 1);
    firstPid = firstLaunches[0]?.pid;
    assert.equal(typeof firstPid, "number");
    assert.equal(firstLaunches[0]?.delayedInitialization, true);

    await client.start();
    const recovered = client.getStatus();
    const recoveredSessionId = client.getSessionId();
    assert.equal(recovered.state, "ready");
    assert.equal(typeof recovered.pid, "number");
    assert.notEqual(recovered.pid, firstPid);
    assert.equal(typeof recoveredSessionId, "string");

    const launches = await waitForJsonLog(processLog, (entries) => entries.length >= 2);
    assert.equal(launches[1]?.pid, recovered.pid);
    assert.equal(launches[1]?.delayedInitialization, false);

    // The failed process ignores SIGTERM and emits a late initialize response
    // before the forced kill. Neither event may mutate the recovered client.
    await sleep(850);
    assert.equal(isProcessRunning(firstPid), false);
    assert.equal(client.getStatus().state, "ready");
    assert.equal(client.getStatus().pid, recovered.pid);
    assert.equal(client.getSessionId(), recoveredSessionId);
    assert.deepEqual(await client.request("textDocument/hover", {}), {
      contents: { kind: "plaintext", value: "py hover" },
    });
  } finally {
    await client.shutdown();
    if (typeof firstPid === "number" && isProcessRunning(firstPid)) process.kill(firstPid, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("code actions for a Python file are merged from ty and Ruff clients", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-actions-"));
  const filePath = path.join(root, "probe.py");
  const logPath = path.join(root, "lsp.jsonl");
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
        args: [fakeServer, "Ruff", "F401", "2", "", "actions-resolve-log-require-diagnostics", logPath],
      },
    },
  });

  try {
    const actions = await service.codeActions(filePath, { line: 1, column: 1 });
    assert.ok(Array.isArray(actions));
    assert.equal(actions.length, 2);
    assert.deepEqual(actions.map((action) => action[LSP_RESULT_SERVER_ID_KEY]).sort(), ["python", "python-ruff"]);
    assert.deepEqual(actions.map((action) => action.title).sort(), ["Ruff fix F401", "ty fix T100"]);
    assert.equal(actions.filter((action) => action.edit).length, 1);
    const deferred = actions.find((action) => action.title === "Ruff fix F401");
    assert.equal(deferred?.[LSP_RESULT_CODE_ACTION_CAN_RESOLVE_KEY], true);
    assert.equal((await readJsonLog(logPath)).some((entry) => entry.method === "codeAction/resolve"), false);

    const resolved = await service.resolveCodeAction(filePath, deferred);
    assert.ok(resolved.edit);
    const entries = await waitForJsonLog(logPath, (entries) => entries.some((entry) => entry.method === "codeAction/resolve"));
    assert.equal(entries.filter((entry) => entry.method === "codeAction/resolve").length, 1);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("edit-less code actions are not applyable unless the source server advertised resolve", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-actions-no-resolve-"));
  const filePath = path.join(root, "probe.py");
  await writeFile(filePath, "import os\n", "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "py", "T100", "1", "", "actions-defer-no-resolve"],
      },
      "python-ruff": { disabled: true },
    },
  });

  try {
    const actions = await service.codeActions(filePath, { line: 1, column: 1 });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].edit, undefined);
    assert.equal(actions[0][LSP_RESULT_CODE_ACTION_CAN_RESOLVE_KEY], undefined);

    await assert.rejects(
      () => service.resolveCodeAction(filePath, actions[0]),
      /not resolvable by its source language server/,
    );
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("top-level command actions are not treated as resolvable edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-actions-command-"));
  const filePath = path.join(root, "probe.py");
  await writeFile(filePath, "import os\n", "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "py", "T100", "1", "", "actions-resolve-command"],
      },
      "python-ruff": { disabled: true },
    },
  });

  try {
    const actions = await service.codeActions(filePath, { line: 1, column: 1 });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "py command T100");
    assert.equal(actions[0].command, "py.command.T100");
    assert.equal(actions[0].edit, undefined);
    assert.equal(actions[0][LSP_RESULT_CODE_ACTION_CAN_RESOLVE_KEY], undefined);

  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("deferred code actions are stale after their source LSP session is gone", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-actions-session-"));
  const filePath = path.join(root, "probe.py");
  const logPath = path.join(root, "lsp.jsonl");
  await writeFile(filePath, "import os\n", "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "py", "T100", "1", "", "actions-resolve-log-require-diagnostics", logPath],
      },
      "python-ruff": { disabled: true },
    },
  });

  try {
    const actions = await service.codeActions(filePath, { line: 1, column: 1 });
    const action = actions[0];
    assert.equal(action?.title, "py fix T100");
    assert.equal(typeof action?.[LSP_RESULT_SERVER_ID_KEY], "string");
    assert.equal(typeof action?.[LSP_RESULT_SERVER_SESSION_ID_KEY], "string");

    await service.shutdownAll();
    await assert.rejects(
      () => service.resolveCodeAction(filePath, action),
      /source server session is no longer live/,
    );
    assert.equal(service.getStatus().clients.length, 0);
    assert.equal((await readJsonLog(logPath)).some((entry) => entry.method === "codeAction/resolve"), false);
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

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
