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
  normalizeWorkspaceDiagnosticFileLimit,
  readWorkspaceDiagnosticSource,
} from "../src/lsp/workspace-diagnostics.ts";

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

test("workspace workers give each queued file its own diagnostic timeout budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-timeouts-"));
  for (const name of ["a.py", "b.py", "c.py"]) {
    await writeFile(path.join(root, name), `${name} = 1\n`, "utf8");
  }

  const service = fakePythonService(root, "diagnostics-delay-80", 1);
  try {
    const result = await service.diagnosticsForWorkspace(".", {
      limit: 10,
      timeoutMs: 150,
      settleMs: 0,
      server: "python",
    });
    assert.equal(result.summary.selectedFiles, 3);
    assert.equal(result.summary.freshFiles, 3);
    assert.equal(result.summary.timedOutFiles, 0);
    assert.ok(result.summary.durationMs >= 200);
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
    assert.ok(result.files.every((file) => file.outcome === "timed-out"));
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling an active workspace scan drains its diagnostic work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-cancel-"));
  for (const name of ["a.py", "b.py", "c.py", "d.py"]) {
    await writeFile(path.join(root, name), `${name} = 1\n`, "utf8");
  }

  const service = fakePythonService(root, "diagnostics-delay-500", 2);
  const controller = new AbortController();
  try {
    const scan = service.diagnosticsForWorkspace(".", {
      limit: 10,
      timeoutMs: 1000,
      settleMs: 0,
      server: "python",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(scan, (error) => error?.name === "AbortError");

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const refreshes = service.getStatus().diagnosticRefreshes;
      if (refreshes?.active === 0 && refreshes.queued === 0) break;
      await sleep(10);
    }
    assert.equal(service.getStatus().diagnosticRefreshes?.active, 0);
    assert.equal(service.getStatus().diagnosticRefreshes?.queued, 0);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

function fakePythonService(root, mode, diagnosticRefreshConcurrency = 4) {
  return createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    diagnosticRefreshConcurrency,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "python", "T100", "1", "", mode],
      },
      "python-ruff": { disabled: true },
    },
  });
}
