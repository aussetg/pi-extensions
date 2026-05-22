import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultConfig } from "../src/config.ts";
import { renderFooterStatus } from "../src/render.ts";
import { createRuntime } from "../src/runtime.ts";

function runtime(overrides = {}) {
  const config = createDefaultConfig();
  Object.assign(config, overrides);
  return createRuntime(config);
}

function client(overrides) {
  return {
    id: "typescript",
    root: "/tmp/project",
    command: "typescript-language-server",
    args: [],
    state: "ready",
    openDocuments: 1,
    diagnosticFiles: 1,
    ...overrides,
  };
}

test("footer shows disabled LSP with a readable prefix", () => {
  const rt = runtime();
  rt.config.lsp.enabled = false;
  assert.equal(renderFooterStatus(rt), "lsp: off");
});

test("footer shows active servers and last diagnostic latency", () => {
  const rt = runtime();
  const status = {
    activeClients: 2,
    clients: [
      client({ id: "python", command: "ty", lastDiagnosticDurationMs: 120, lastDiagnosticTimedOut: false }),
      client({ id: "python-ruff", command: "ruff", lastDiagnosticDurationMs: 32.4, lastDiagnosticTimedOut: false }),
    ],
    unavailableServers: [],
  };

  assert.equal(renderFooterStatus(rt, undefined, status), "lsp: ruff (32 ms) ty (120 ms)");
});

test("footer marks diagnostic timeouts", () => {
  const rt = runtime();
  const status = {
    activeClients: 1,
    clients: [client({ id: "typescript", lastDiagnosticDurationMs: 98.2, lastDiagnosticTimedOut: true })],
    unavailableServers: [],
  };

  assert.equal(renderFooterStatus(rt, undefined, status), "lsp: typescript (timeout 98 ms)");
});
