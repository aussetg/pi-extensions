import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { registerLspCommand } from "../src/commands/lsp.ts";
import { createDefaultConfig } from "../src/config.ts";
import { persistTrustedEnvironmentRoots, restoreTrustedEnvironmentRoots } from "../src/commands/trust.ts";
import { addTrustedEnvironmentRoot, createRuntime } from "../src/runtime.ts";

test("trusted external roots are persisted as session custom entries and restored from the active branch", () => {
  const runtime = createRuntime(createDefaultConfig());
  addTrustedEnvironmentRoot(runtime, "/tmp/pi-trusted-a");

  const entries = [];
  persistTrustedEnvironmentRoots({ appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) }, runtime);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].customType, "code-feedback-trust");
  assert.deepEqual(entries[0].data.roots, [path.resolve("/tmp/pi-trusted-a")]);

  const restored = createRuntime(createDefaultConfig());
  const changed = restoreTrustedEnvironmentRoots(restored, contextWithBranch(entries));

  assert.equal(changed, true);
  assert.deepEqual(restored.trustedEnvironmentRoots, [path.resolve("/tmp/pi-trusted-a")]);
});

test("the last trusted-root session entry wins, including an empty clear snapshot", () => {
  const restored = createRuntime(createDefaultConfig());
  addTrustedEnvironmentRoot(restored, "/tmp/stale");

  const changed = restoreTrustedEnvironmentRoots(restored, contextWithBranch([
    { type: "custom", customType: "code-feedback-trust", data: { version: 1, roots: ["/tmp/old"] } },
    { type: "custom", customType: "code-feedback-trust", data: { version: 1, roots: [] } },
  ]));

  assert.equal(changed, true);
  assert.deepEqual(restored.trustedEnvironmentRoots, []);
});

test("/lsp trust persists trusted roots without registering a separate /trust command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-trust-"));
  const external = path.join(root, "external");
  await mkdir(external);

  const runtime = createRuntime(createDefaultConfig());
  const commands = new Map();
  const entries = [];
  let restarts = 0;
  const lspService = {
    configure() {},
    getStatus() { return { activeClients: 0, clients: [], unavailableServers: [] }; },
    async restart() { restarts += 1; },
  };
  const formatService = {
    configure() {},
    getStatus() { return { recentRuns: [], commands: [] }; },
  };

  registerLspCommand({
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    registerCommand: (name, definition) => commands.set(name, definition),
  }, runtime, lspService, formatService);

  try {
    assert.ok(commands.has("lsp"));
    assert.equal(commands.has("trust"), false);

    await commands.get("lsp").handler(`trust add ${external}`, {
      cwd: root,
      isProjectTrusted: () => true,
      ui: { notify() {}, setStatus() {} },
    });

    assert.deepEqual(runtime.trustedEnvironmentRoots, [external]);
    assert.equal(restarts, 1);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].customType, "code-feedback-trust");
    assert.deepEqual(entries[0].data.roots, [external]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function contextWithBranch(entries) {
  return {
    ui: { notify() {} },
    sessionManager: {
      getBranch: () => entries,
    },
  };
}
