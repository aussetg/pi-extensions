import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createLspService } from "../src/lsp/service.ts";

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
