import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { DEFAULT_LSP_SOURCE_FILE_MAX_BYTES } from "../src/fs.ts";
import { createLspService } from "../src/lsp/service.ts";
import {
  discoverWorkspaceDiagnosticFiles,
  MAX_WORKSPACE_DIAGNOSTIC_FILE_LIMIT,
  MAX_WORKSPACE_DIAGNOSTIC_TOTAL_SOURCE_BYTES,
  normalizeWorkspaceDiagnosticFileLimit,
  readWorkspaceDiagnosticSource,
} from "../src/lsp/workspace-diagnostics.ts";
import { readJsonLines as readJsonLog } from "./helpers/json-lines.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeServer = path.join(here, "fixtures", "fake-lsp-server.mjs");

test("active workspace diagnostics skip ignored directories and symbolic links", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-diagnostics-"));
  const root = path.join(base, "project");
  const outside = path.join(base, "outside");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await mkdir(path.join(root, "dist"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, "src", "a.py"), "a = 1\n", "utf8");
  await writeFile(path.join(root, "src", "b.py"), "b = 2\n", "utf8");
  await writeFile(path.join(root, "src", "notes.txt"), "not LSP source\n", "utf8");
  await writeFile(path.join(root, "node_modules", "dependency.py"), "bad = 1\n", "utf8");
  await writeFile(path.join(root, "dist", "generated.py"), "bad = 1\n", "utf8");
  await writeFile(path.join(outside, "escaped.py"), "bad = 1\n", "utf8");
  await symlink("a.py", path.join(root, "src", "linked.py"));
  await symlink(outside, path.join(root, "outside-link"));

  const service = fakePythonService(root, "pull-diagnostics");
  try {
    const result = await service.diagnosticsForWorkspace(".", {
      limit: 10,
      timeoutMs: 1000,
      settleMs: 0,
      server: "python",
    });

    assert.equal(result.summary.complete, true);
    assert.equal(result.summary.selectedFiles, 2);
    assert.equal(result.summary.freshFiles, 2);
    assert.equal(result.summary.timedOutFiles, 0);
    assert.equal(result.summary.unavailableFiles, 0);
    assert.equal(result.summary.skippedFiles, 0);
    assert.equal(result.summary.diagnostics, 2);
    assert.equal(result.summary.ignoredDirectories, 2);
    assert.equal(result.summary.symlinksSkipped, 2);
    assert.equal(result.summary.fileLimitReached, false);
    assert.deepEqual(
      result.files.map((file) => path.relative(root, file.filePath)),
      [path.join("src", "a.py"), path.join("src", "b.py")],
    );
    assert.ok(result.files.every((file) => file.outcome === "fresh" && file.diagnostics === 1));
    assert.deepEqual(
      [...result.snapshot.byUri.keys()].sort(),
      [pathToFileURL(path.join(root, "src", "a.py")).href, pathToFileURL(path.join(root, "src", "b.py")).href].sort(),
    );
  } finally {
    await service.shutdownAll();
    await rm(base, { recursive: true, force: true });
  }
});

test("active workspace diagnostics prefer one capability-gated workspace pull", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-protocol-pull-"));
  const logPath = path.join(root, "lsp.jsonl");
  await writeFile(path.join(root, "a.py"), "a = 1\n", "utf8");
  await writeFile(path.join(root, "b.py"), "b = 2\n", "utf8");

  const service = fakePythonService(root, "workspace-pull-clean", 4, logPath);
  try {
    const result = await service.diagnosticsForWorkspace(".", {
      limit: 10,
      timeoutMs: 1000,
      settleMs: 0,
      server: "python",
    });

    assert.equal(result.summary.complete, true);
    assert.equal(result.summary.freshFiles, 2);
    assert.equal(result.summary.diagnostics, 0);
    assert.equal(result.summary.workspacePullRequests, 1);
    assert.equal(result.summary.workspacePullFailures, 0);
    assert.equal(result.summary.workspacePullFiles, 2);
    assert.equal(result.summary.documentPullFiles, 0);
    assert.equal(result.summary.pushBatchFiles, 0);

    const entries = await readJsonLog(logPath);
    const initialize = entries.find((entry) => entry.method === "initialize");
    assert.equal(initialize?.params?.capabilities?.workspace?.diagnostics?.refreshSupport, true);
    const workspacePulls = entries.filter((entry) => entry.method === "workspace/diagnostic");
    assert.equal(workspacePulls.length, 1);
    assert.equal(workspacePulls[0].params.identifier, "fake-workspace-pull");
    assert.deepEqual(workspacePulls[0].params.previousResultIds, []);
    assert.equal(typeof workspacePulls[0].params.partialResultToken, "string");
    assert.equal(entries.some((entry) => entry.method === "textDocument/diagnostic"), false);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace pull diagnostics refresh a source that changes while the pull is pending", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-protocol-source-change-"));
  const logPath = path.join(root, "lsp.jsonl");
  const filePath = path.join(root, "a.py");
  await writeFile(filePath, "old = 1\n", "utf8");

  const service = fakePythonService(root, "workspace-pull-delay-100", 4, logPath);
  try {
    const scan = service.diagnosticsForWorkspace(".", {
      limit: 10,
      timeoutMs: 1000,
      settleMs: 0,
      server: "python",
    });
    let pullStarted = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      pullStarted = (await readJsonLog(logPath)).some((entry) => entry.method === "workspace/diagnostic");
      if (pullStarted) break;
      await sleep(5);
    }
    assert.equal(pullStarted, true);
    await writeFile(filePath, "current = 2\n", "utf8");

    const result = await scan;
    assert.equal(result.summary.complete, true);
    assert.equal(result.summary.freshFiles, 1);
    assert.equal(result.summary.workspacePullFiles, 0);
    assert.equal(result.summary.documentPullFiles, 1);
    assert.equal(result.summary.pushBatchFiles, 0);
    assert.equal(result.files[0]?.outcome, "fresh");

    const entries = await readJsonLog(logPath);
    assert.equal(entries.filter((entry) => entry.method === "workspace/diagnostic").length, 1);
    assert.equal(entries.filter((entry) => entry.method === "textDocument/diagnostic").length, 1);
    const didOpen = entries.find((entry) => entry.method === "textDocument/didOpen");
    assert.equal(didOpen?.params?.textDocument?.text, "current = 2\n");
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace pull diagnostics combine bounded partial results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-protocol-partial-"));
  for (const name of ["a.py", "b.py", "c.py"]) await writeFile(path.join(root, name), `${name} = 1\n`, "utf8");

  const service = fakePythonService(root, "workspace-pull-partial");
  try {
    const result = await service.diagnosticsForWorkspace(".", {
      limit: 10,
      timeoutMs: 1000,
      settleMs: 0,
      server: "python",
    });
    assert.equal(result.summary.complete, true);
    assert.equal(result.summary.workspacePullRequests, 1);
    assert.equal(result.summary.workspacePullFiles, 3);
    assert.equal(result.summary.documentPullFiles, 0);
    assert.equal(result.summary.pushBatchFiles, 0);
    assert.equal(result.summary.diagnostics, 3);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace pull diagnostics issue one request per nested routed client within process limits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-protocol-nested-"));
  const firstRoot = path.join(root, "first");
  const secondRoot = path.join(root, "second");
  const logPath = path.join(root, "lsp.jsonl");
  await mkdir(firstRoot);
  await mkdir(secondRoot);
  await writeFile(path.join(firstRoot, "pyproject.toml"), "[project]\nname='first'\n", "utf8");
  await writeFile(path.join(secondRoot, "pyproject.toml"), "[project]\nname='second'\n", "utf8");
  await writeFile(path.join(firstRoot, "a.py"), "a = 1\n", "utf8");
  await writeFile(path.join(secondRoot, "b.py"), "b = 2\n", "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    maxActiveClients: 1,
    initializationConcurrency: 1,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "python", "T100", "1", "", "workspace-pull-clean", logPath],
      },
      "python-ruff": { disabled: true },
    },
  });
  try {
    const result = await service.diagnosticsForWorkspace(".", {
      limit: 10,
      timeoutMs: 1000,
      settleMs: 0,
      server: "python",
    });

    assert.equal(result.summary.complete, true);
    assert.equal(result.summary.workspacePullRequests, 2);
    assert.equal(result.summary.workspacePullFiles, 2);
    assert.equal((await readJsonLog(logPath)).filter((entry) => entry.method === "workspace/diagnostic").length, 2);
    assert.equal(service.getStatus().clientResources.capacityEvictions, 1);
    assert.deepEqual(service.getStatus().clients.map((client) => client.root), [secondRoot]);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace pull diagnostics reuse result ids for unchanged reports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-protocol-unchanged-"));
  const logPath = path.join(root, "lsp.jsonl");
  await writeFile(path.join(root, "a.py"), "a = 1\n", "utf8");
  await writeFile(path.join(root, "b.py"), "b = 2\n", "utf8");

  const service = fakePythonService(root, "workspace-pull-unchanged", 4, logPath);
  try {
    const first = await service.diagnosticsForWorkspace(".", {
      limit: 10,
      timeoutMs: 1000,
      settleMs: 0,
      server: "python",
    });
    const second = await service.diagnosticsForWorkspace(".", {
      limit: 10,
      timeoutMs: 1000,
      settleMs: 0,
      server: "python",
    });
    service.notifyFileMutations([{ type: "changed", filePath: path.join(root, "a.py") }]);
    const third = await service.diagnosticsForWorkspace(".", {
      limit: 10,
      timeoutMs: 1000,
      settleMs: 0,
      server: "python",
    });

    assert.equal(first.summary.diagnostics, 2);
    assert.equal(second.summary.diagnostics, 2);
    assert.equal(third.summary.diagnostics, 2);
    assert.equal(second.summary.workspacePullFiles, 2);
    const pulls = (await readJsonLog(logPath)).filter((entry) => entry.method === "workspace/diagnostic");
    assert.equal(pulls.length, 3);
    assert.equal(pulls[1].params.previousResultIds.length, 2);
    assert.ok(pulls[1].params.previousResultIds.every((entry) => entry.value.endsWith("-full")));
    assert.equal(pulls[2].params.previousResultIds.length, 1);
    assert.ok(pulls[2].params.previousResultIds[0].uri.endsWith("/b.py"));
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("missing, malformed, oversized, and unsupported workspace reports fall back within the shared deadline", async () => {
  for (const mode of ["workspace-pull-missing", "workspace-pull-malformed", "workspace-pull-partial-overflow", "workspace-pull-unsupported"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), `pi-code-feedback-workspace-protocol-${mode}-`));
    const logPath = path.join(root, "lsp.jsonl");
    await writeFile(path.join(root, "a.py"), "a = 1\n", "utf8");
    await writeFile(path.join(root, "b.py"), "b = 2\n", "utf8");

    const service = fakePythonService(root, mode, 4, logPath);
    try {
      const result = await service.diagnosticsForWorkspace(".", {
        limit: 10,
        timeoutMs: 1000,
        settleMs: 0,
        server: "python",
      });
      assert.equal(result.summary.complete, true, mode);
      assert.equal(result.summary.freshFiles, 2, mode);
      assert.equal(result.summary.diagnostics, 2, mode);
      assert.equal(result.summary.workspacePullRequests, 1, mode);
      assert.equal(result.summary.workspacePullFailures, mode === "workspace-pull-missing" ? 0 : 1, mode);
      assert.equal(result.summary.workspacePullFiles, mode === "workspace-pull-missing" ? 1 : 0, mode);
      const expectedDocumentPulls = mode === "workspace-pull-missing" ? 1 : 2;
      assert.equal(result.summary.documentPullFiles, expectedDocumentPulls, mode);
      assert.equal(result.summary.pushBatchFiles, 0, mode);
      const entries = await readJsonLog(logPath);
      assert.equal(entries.filter((entry) => entry.method === "textDocument/diagnostic").length, expectedDocumentPulls, mode);
    } finally {
      await service.shutdownAll();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("a timed-out native workspace pull does not start fallback work after the scan deadline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-protocol-deadline-"));
  const logPath = path.join(root, "lsp.jsonl");
  await writeFile(path.join(root, "a.py"), "a = 1\n", "utf8");
  await writeFile(path.join(root, "b.py"), "b = 2\n", "utf8");

  const service = fakePythonService(root, "workspace-pull-delay-80", 4, logPath);
  try {
    const result = await service.diagnosticsForWorkspace(".", {
      limit: 10,
      timeoutMs: 30,
      settleMs: 0,
      server: "python",
    });
    assert.equal(result.summary.complete, false);
    assert.equal(result.summary.deadlineReached, true);
    assert.equal(result.summary.freshFiles, 0);
    assert.equal(result.summary.timedOutFiles, 2);
    assert.equal(result.summary.workspacePullRequests, 1);
    assert.equal(result.summary.workspacePullFailures, 1);
    assert.equal(result.summary.documentPullFiles, 0);
    assert.equal(result.summary.pushBatchFiles, 0);
    const entries = await readJsonLog(logPath);
    assert.equal(entries.filter((entry) => entry.method === "workspace/diagnostic").length, 1);
    assert.equal(entries.some((entry) => entry.method === "textDocument/diagnostic"), false);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("a falsely advertised document pull falls back to one push batch within the shared deadline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-document-pull-fallback-"));
  const logPath = path.join(root, "lsp.jsonl");
  await writeFile(path.join(root, "a.py"), "a = 1\n", "utf8");
  await writeFile(path.join(root, "b.py"), "b = 2\n", "utf8");

  const service = fakePythonService(root, "pull-unsupported", 2, logPath);
  try {
    const result = await service.diagnosticsForWorkspace(".", {
      limit: 10,
      timeoutMs: 1000,
      settleMs: 0,
      server: "python",
    });
    assert.equal(result.summary.complete, true);
    assert.equal(result.summary.freshFiles, 2);
    assert.equal(result.summary.documentPullFiles, 0);
    assert.equal(result.summary.pushBatchFiles, 2);
    assert.equal((await readJsonLog(logPath)).filter((entry) => entry.method === "textDocument/diagnostic").length, 2);
    assert.equal(service.getStatus().clients[0]?.openDocuments, 0);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling workspace pull diagnostics cancels the request without starting fallback work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-protocol-cancel-"));
  const logPath = path.join(root, "lsp.jsonl");
  await writeFile(path.join(root, "a.py"), "a = 1\n", "utf8");
  await writeFile(path.join(root, "b.py"), "b = 2\n", "utf8");
  const service = fakePythonService(root, "workspace-pull-delay-500", 4, logPath);
  const controller = new AbortController();
  try {
    const scan = service.diagnosticsForWorkspace(".", {
      limit: 10,
      timeoutMs: 1000,
      settleMs: 0,
      server: "python",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(scan, (error) => error?.name === "AbortError");
    await sleep(20);

    const entries = await readJsonLog(logPath);
    assert.equal(entries.filter((entry) => entry.method === "workspace/diagnostic").length, 1);
    assert.equal(entries.some((entry) => entry.method === "$/cancelRequest"), true);
    assert.equal(entries.some((entry) => entry.method === "textDocument/diagnostic"), false);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("active workspace diagnostics enforce file and traversal bounds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-bounds-"));
  for (const name of ["a.py", "b.py", "c.py", "d.py"]) {
    await writeFile(path.join(root, name), `${name} = 1\n`, "utf8");
  }

  const discovery = await discoverWorkspaceDiagnosticFiles({
    projectRoot: root,
    targetPath: ".",
    extensions: new Set([".py"]),
    limit: 10,
    maxEntries: 2,
  });
  assert.equal(discovery.files.length, 2);
  assert.equal(discovery.entriesVisited, 2);
  assert.equal(discovery.entryLimitReached, true);

  const expiredDiscovery = await discoverWorkspaceDiagnosticFiles({
    projectRoot: root,
    targetPath: ".",
    extensions: new Set([".py"]),
    limit: 10,
    deadlineAt: 0,
  });
  assert.equal(expiredDiscovery.deadlineReached, true);
  assert.equal(expiredDiscovery.files.length, 0);

  const service = fakePythonService(root, "pull-clean");
  try {
    const result = await service.diagnosticsForWorkspace(".", {
      limit: 2,
      timeoutMs: 1000,
      settleMs: 0,
      server: "python",
    });
    assert.equal(result.summary.selectedFiles, 2);
    assert.equal(result.summary.freshFiles, 2);
    assert.equal(result.summary.fileLimitReached, true);
    assert.equal(result.summary.complete, false);
    assert.equal(result.summary.diagnostics, 0);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }

  assert.equal(normalizeWorkspaceDiagnosticFileLimit(1), 1);
  assert.equal(normalizeWorkspaceDiagnosticFileLimit(MAX_WORKSPACE_DIAGNOSTIC_FILE_LIMIT), MAX_WORKSPACE_DIAGNOSTIC_FILE_LIMIT);
  assert.throws(() => normalizeWorkspaceDiagnosticFileLimit(0), /positive integer/);
  assert.throws(() => normalizeWorkspaceDiagnosticFileLimit(1.5), /positive integer/);
  assert.throws(() => normalizeWorkspaceDiagnosticFileLimit(MAX_WORKSPACE_DIAGNOSTIC_FILE_LIMIT + 1), /at most/);
});

test("active workspace diagnostics report oversized and binary sources as skipped", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-source-skips-"));
  await writeFile(path.join(root, "binary.py"), Buffer.from("value = 1\0\n"));
  await writeFile(path.join(root, "generated.py"), Buffer.alloc(DEFAULT_LSP_SOURCE_FILE_MAX_BYTES + 1, 0x61));

  const service = fakePythonService(root, "pull-clean");
  try {
    const result = await service.diagnosticsForWorkspace(".", {
      limit: 10,
      timeoutMs: 1000,
      settleMs: 0,
      server: "python",
    });
    assert.equal(result.summary.selectedFiles, 2);
    assert.equal(result.summary.freshFiles, 0);
    assert.equal(result.summary.skippedFiles, 2);
    assert.equal(result.summary.complete, false);
    assert.match(result.files.find((file) => file.filePath.endsWith("binary.py"))?.reason ?? "", /binary/);
    assert.match(result.files.find((file) => file.filePath.endsWith("generated.py"))?.reason ?? "", /2\.0 MiB limit/);
    assert.equal(service.getStatus().clients.length, 0);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("active workspace diagnostics enforce a total source-byte bound", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-total-source-bound-"));
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  for (let index = 0; index < 9; index += 1) {
    await writeFile(path.join(root, `${String(index).padStart(2, "0")}.py`), chunk);
  }

  const service = fakePythonService(root, "workspace-pull-clean");
  try {
    const result = await service.diagnosticsForWorkspace(".", {
      limit: 20,
      timeoutMs: 1000,
      settleMs: 0,
      server: "python",
    });
    assert.equal(result.summary.selectedFiles, 9);
    assert.equal(result.summary.freshFiles, 8);
    assert.equal(result.summary.skippedFiles, 1);
    assert.equal(result.summary.sourceByteLimit, MAX_WORKSPACE_DIAGNOSTIC_TOTAL_SOURCE_BYTES);
    assert.equal(result.summary.sourceBytes, MAX_WORKSPACE_DIAGNOSTIC_TOTAL_SOURCE_BYTES);
    assert.equal(result.summary.sourceByteLimitReached, true);
    assert.match(result.files.find((file) => file.outcome === "skipped")?.reason ?? "", /total source limit/);
    assert.equal(result.summary.complete, false);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("active workspace diagnostics reject paths outside the project and explicit symlink targets", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-boundary-"));
  const root = path.join(base, "project");
  const outside = path.join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "escaped.py"), "bad = 1\n", "utf8");
  await symlink(outside, path.join(root, "linked-directory"));

  const service = fakePythonService(root, "pull-clean");
  try {
    await assert.rejects(
      service.diagnosticsForWorkspace("../outside", { limit: 10, timeoutMs: 100, settleMs: 0, server: "python" }),
      /outside the project root/,
    );
    await assert.rejects(
      service.diagnosticsForWorkspace("linked-directory", { limit: 10, timeoutMs: 100, settleMs: 0, server: "python" }),
      /must not be a symbolic link/,
    );
  } finally {
    await service.shutdownAll();
    await rm(base, { recursive: true, force: true });
  }
});

test("workspace source reads reject symlink swaps after discovery", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-source-race-"));
  const root = path.join(base, "project");
  const outside = path.join(base, "outside");
  const parentPath = path.join(root, "parent");
  const heldParentPath = path.join(root, "held-parent");
  const nestedFile = path.join(parentPath, "nested.py");
  const directFile = path.join(root, "direct.py");
  await mkdir(parentPath, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(nestedFile, "safe = 1\n", "utf8");
  await writeFile(directFile, "safe = 2\n", "utf8");
  await writeFile(path.join(outside, "nested.py"), "escaped = 1\n", "utf8");
  await writeFile(path.join(outside, "direct.py"), "escaped = 2\n", "utf8");

  try {
    const discovery = await discoverWorkspaceDiagnosticFiles({
      projectRoot: root,
      targetPath: ".",
      extensions: new Set([".py"]),
      limit: 10,
    });
    assert.deepEqual(discovery.files, [directFile, nestedFile]);

    await rename(parentPath, heldParentPath);
    await symlink(outside, parentPath);
    await unlink(directFile);
    await symlink(path.join(outside, "direct.py"), directFile);

    const parentSwap = readWorkspaceDiagnosticSource(discovery, nestedFile, DEFAULT_LSP_SOURCE_FILE_MAX_BYTES);
    const finalSwap = readWorkspaceDiagnosticSource(discovery, directFile, DEFAULT_LSP_SOURCE_FILE_MAX_BYTES);
    assert.equal(parentSwap.content, undefined);
    assert.equal(parentSwap.skippedReason, "unsafe-path");
    assert.equal(finalSwap.content, undefined);
    assert.equal(finalSwap.skippedReason, "unsafe-path");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("document pulls share one absolute workspace diagnostic deadline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-timeouts-"));
  for (const name of ["a.py", "b.py", "c.py"]) {
    await writeFile(path.join(root, name), `${name} = 1\n`, "utf8");
  }

  const service = fakePythonService(root, "pull-delay-80", 1);
  try {
    const result = await service.diagnosticsForWorkspace(".", {
      limit: 10,
      timeoutMs: 150,
      settleMs: 0,
      server: "python",
    });
    assert.equal(result.summary.selectedFiles, 3);
    assert.equal(result.summary.freshFiles, 1);
    assert.equal(result.summary.timedOutFiles, 2);
    assert.equal(result.summary.documentPullFiles, 3);
    assert.equal(result.summary.pushBatchFiles, 0);
    assert.ok(result.summary.durationMs >= 120);
    assert.ok(result.summary.durationMs < 250);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("push-only workspace diagnostics synchronize once, publish as a batch, and close transient documents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-push-batch-"));
  const logPath = path.join(root, "lsp.jsonl");
  for (const name of ["a.py", "b.py", "c.py", "d.py", "e.py"]) {
    await writeFile(path.join(root, name), `${name} = 1\n`, "utf8");
  }

  const service = fakePythonService(root, "diagnostics-delay-80", 1, logPath);
  try {
    const result = await service.diagnosticsForWorkspace(".", {
      limit: 10,
      timeoutMs: 180,
      settleMs: 0,
      server: "python",
    });
    assert.equal(result.summary.complete, true);
    assert.equal(result.summary.freshFiles, 5);
    assert.equal(result.summary.timedOutFiles, 0);
    assert.equal(result.summary.documentPullFiles, 0);
    assert.equal(result.summary.pushBatchFiles, 5);
    assert.ok(result.summary.durationMs < 180);
    assert.equal(service.getStatus().clients[0]?.openDocuments, 0);

    await sleep(20);
    const entries = await readJsonLog(logPath);
    assert.equal(entries.filter((entry) => entry.method === "textDocument/didOpen").length, 5);
    assert.equal(entries.filter((entry) => entry.method === "textDocument/didClose").length, 5);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("push diagnostic batches preserve documents that were already open", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-push-existing-"));
  const logPath = path.join(root, "lsp.jsonl");
  const firstPath = path.join(root, "a.py");
  const secondPath = path.join(root, "b.py");
  await writeFile(firstPath, "a = 1\n", "utf8");
  await writeFile(secondPath, "b = 2\n", "utf8");

  const service = fakePythonService(root, "diagnostics-delay-20", 2, logPath);
  try {
    const initial = await service.diagnosticsForFileDetailed(firstPath, undefined, {
      timeoutMs: 500,
      settleMs: 0,
      server: "python",
    });
    assert.equal(initial?.fresh, true);

    const result = await service.diagnosticsForWorkspace(".", {
      limit: 10,
      timeoutMs: 500,
      settleMs: 0,
      server: "python",
    });
    assert.equal(result.summary.complete, true);
    assert.equal(service.getStatus().clients[0]?.openDocuments, 1);
    const closes = (await readJsonLog(logPath)).filter((entry) => entry.method === "textDocument/didClose");
    assert.deepEqual(closes.map((entry) => entry.params.textDocument.uri), [pathToFileURL(secondPath).href]);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace diagnostics report per-file timeouts explicitly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-timeout-summary-"));
  await writeFile(path.join(root, "a.py"), "a = 1\n", "utf8");
  await writeFile(path.join(root, "b.py"), "b = 2\n", "utf8");

  const service = fakePythonService(root, "no-diagnostics", 2);
  try {
    const result = await service.diagnosticsForWorkspace(".", {
      limit: 10,
      timeoutMs: 30,
      settleMs: 0,
      server: "python",
    });
    assert.equal(result.summary.freshFiles, 0);
    assert.equal(result.summary.timedOutFiles, 2);
    assert.equal(result.summary.unavailableFiles, 0);
    assert.equal(result.summary.deadlineReached, true);
    assert.equal(result.summary.pushBatchFiles, 2);
    assert.ok(result.files.every((file) => file.outcome === "timed-out"));
    assert.equal(service.getStatus().clients[0]?.state, "stopped");
    assert.equal(service.getStatus().clients[0]?.openDocuments, 0);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace diagnostic timeouts exclude previously cached diagnostics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-timeout-no-cache-"));
  const filePath = path.join(root, "a.py");
  const content = "a = 1\n";
  await writeFile(filePath, content, "utf8");

  const service = fakePythonService(root, "diagnostics-delay-80", 2);
  try {
    const initial = await service.diagnosticsForFileDetailed(filePath, content, {
      timeoutMs: 1000,
      settleMs: 0,
      server: "python",
    });
    assert.equal(initial?.fresh, true);
    assert.equal(initial && [...initial.snapshot.byUri.values()].flat().length, 1);

    const result = await service.diagnosticsForWorkspace(".", {
      limit: 10,
      timeoutMs: 10,
      settleMs: 0,
      server: "python",
    });
    assert.equal(result.summary.freshFiles, 0);
    assert.equal(result.summary.timedOutFiles, 1);
    assert.equal(result.summary.diagnostics, 0);
    assert.equal(result.snapshot.byUri.size, 0);
    assert.equal(result.files[0]?.diagnostics, 0);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling an active workspace scan drains its diagnostic work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-cancel-"));
  const logPath = path.join(root, "lsp.jsonl");
  for (const name of ["a.py", "b.py", "c.py", "d.py"]) {
    await writeFile(path.join(root, name), `${name} = 1\n`, "utf8");
  }

  const service = fakePythonService(root, "diagnostics-delay-500", 2, logPath);
  const controller = new AbortController();
  try {
    const scan = service.diagnosticsForWorkspace(".", {
      limit: 10,
      timeoutMs: 1000,
      settleMs: 0,
      server: "python",
      signal: controller.signal,
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await readJsonLog(logPath)).some((entry) => entry.method === "textDocument/didOpen")) break;
      await sleep(5);
    }
    controller.abort();
    await assert.rejects(scan, (error) => error?.name === "AbortError");

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const refreshes = service.getStatus().diagnosticRefreshes;
      if (refreshes?.active === 0 && refreshes.queued === 0) break;
      await sleep(10);
    }
    assert.equal(service.getStatus().diagnosticRefreshes?.active, 0);
    assert.equal(service.getStatus().diagnosticRefreshes?.queued, 0);
    assert.equal(service.getStatus().clients[0]?.state, "stopped");
    assert.equal(service.getStatus().clients[0]?.openDocuments, 0);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

function fakePythonService(root, mode, diagnosticRefreshConcurrency = 4, logPath) {
  return createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    diagnosticRefreshConcurrency,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "python", "T100", "1", "", mode, ...(logPath ? [logPath] : [])],
      },
      "python-ruff": { disabled: true },
    },
  });
}
