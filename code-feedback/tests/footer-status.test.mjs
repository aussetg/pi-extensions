import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultConfig } from "../src/config.ts";
import { renderFooterStatus, renderStatus } from "../src/render.ts";
import { createRuntime } from "../src/runtime.ts";

function runtime(overrides = {}) {
  const config = createDefaultConfig();
  Object.assign(config, overrides);
  return createRuntime(config);
}

function client(overrides) {
  return {
    id: "typescript",
    role: "language",
    root: "/tmp/project",
    command: "typescript-language-server",
    args: [],
    state: "ready",
    openDocuments: 1,
    diagnosticFiles: 1,
    ...overrides,
  };
}

test("default config exposes only implemented formatting and service settings", () => {
  const rt = runtime();

  assert.equal(Object.hasOwn(rt.config, "formatMode"), false);
  assert.equal(Object.hasOwn(rt.config, "formatters"), false);
  assert.equal(Object.hasOwn(rt.config.lsp, "servers"), false);
  assert.match(renderStatus(rt), /^  auto format: immediate$/m);
  assert.match(renderStatus(rt), /^  delayed context injection: enabled$/m);

  rt.config.autoFormat = false;
  rt.config.contextInjection = false;
  assert.match(renderStatus(rt), /^  auto format: disabled$/m);
  assert.match(renderStatus(rt), /^  delayed context injection: disabled$/m);
});

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
      client({ id: "python", command: "ty", lastDiagnosticDurationMs: 120, lastDiagnosticOutcome: "fresh" }),
      client({ id: "python-ruff", command: "ruff", lastDiagnosticDurationMs: 32.4, lastDiagnosticOutcome: "fresh" }),
    ],
    unavailableServers: [],
  };

  assert.equal(renderFooterStatus(rt, undefined, status), "lsp: ruff (32 ms) ty (120 ms)");
});

test("footer marks diagnostic timeouts", () => {
  const rt = runtime();
  const status = {
    activeClients: 1,
    clients: [client({ id: "typescript", lastDiagnosticDurationMs: 98.2, lastDiagnosticOutcome: "timeout" })],
    unavailableServers: [],
  };

  assert.equal(renderFooterStatus(rt, undefined, status), "lsp: typescript (timeout 98 ms)");
});

test("footer distinguishes cancelled diagnostic work from timeouts", () => {
  const rt = runtime();
  const status = {
    activeClients: 1,
    clients: [client({ id: "typescript", lastDiagnosticDurationMs: 21.6, lastDiagnosticOutcome: "cancelled" })],
    unavailableServers: [],
  };

  assert.equal(renderFooterStatus(rt, undefined, status), "lsp: typescript (cancelled 22 ms)");
});

test("footer labels eventually consistent push diagnostics without calling them timeouts", () => {
  const rt = runtime();
  const status = {
    activeClients: 1,
    clients: [client({ id: "clangd", command: "clangd", lastDiagnosticDurationMs: 51.2, lastDiagnosticOutcome: "eventual" })],
    unavailableServers: [],
  };

  assert.equal(renderFooterStatus(rt, undefined, status), "lsp: clangd (push 51 ms)");
});

test("footer and full status label unavailable diagnostic refreshes", () => {
  const rt = runtime();
  const status = {
    activeClients: 1,
    clients: [client({ id: "python", command: "ty", lastDiagnosticDurationMs: 43.6, lastDiagnosticOutcome: "unavailable" })],
    unavailableServers: [],
  };

  assert.equal(renderFooterStatus(rt, undefined, status), "lsp: ty (unavailable 44 ms)");
  assert.match(renderStatus(rt, status), /diag_latency=unavailable 44 ms/);
});

test("footer includes trusted external roots after LSP status", () => {
  const rt = runtime();
  rt.trustedEnvironmentRoots = ["/tmp/external-a", "/tmp/external-b"];
  const status = {
    activeClients: 1,
    clients: [client({ id: "typescript", lastDiagnosticDurationMs: 1228, lastDiagnosticOutcome: "timeout" })],
    unavailableServers: [],
  };

  assert.equal(renderFooterStatus(rt, undefined, status), "lsp: typescript (timeout 1228 ms) trusted: /tmp/external-a, /tmp/external-b");
});

test("footer caps trusted external roots", () => {
  const rt = runtime();
  rt.trustedEnvironmentRoots = ["/tmp/a", "/tmp/b", "/tmp/c", "/tmp/d", "/tmp/e"];

  assert.equal(renderFooterStatus(rt), "lsp: idle trusted: /tmp/a, /tmp/b, /tmp/c, +2 more");
});

test("status reports trusted language-server config sources and parse failures", () => {
  const rt = runtime();
  const status = {
    activeClients: 0,
    clients: [],
    unavailableServers: [],
    serverConfiguration: {
      sources: [
        { scope: "user", path: "/tmp/agent/code-feedback.json", state: "loaded" },
        { scope: "project", path: "/tmp/project/.pi/code-feedback.json", state: "invalid" },
      ],
      configuredServerIds: ["gleam"],
      errors: ["/tmp/project/.pi/code-feedback.json: invalid JSON"],
    },
  };

  const rendered = renderStatus(rt, status);
  assert.match(rendered, /^  server config: user=loaded, project=invalid$/m);
  assert.match(rendered, /^  configured server entries: gleam$/m);
  assert.match(rendered, /server config errors:\n    \/tmp\/project\/\.pi\/code-feedback\.json: invalid JSON/);
});

test("status identifies client roles and nested workspace roots", () => {
  const rt = runtime();
  rt.projectRoot = "/tmp/project";
  const status = {
    activeClients: 1,
    clients: [client({ id: "python-ruff", role: "linter", root: "/tmp/project/packages/api" })],
    unavailableServers: [],
  };

  const rendered = renderStatus(rt, status);
  assert.match(rendered, /^    python-ruff: ready role=linter root=packages\/api /m);
});

test("status reports bounded client resources and lifecycle counters", () => {
  const rt = runtime();
  const status = {
    activeClients: 1,
    clients: [client({ busy: true })],
    unavailableServers: [],
    clientResources: {
      idleTimeoutMs: 240_000,
      maxActiveClients: 8,
      initializationConcurrency: 2,
      activeClients: 1,
      initializingClients: 1,
      queuedStarts: 3,
      starts: 5,
      restarts: 1,
      evictions: 2,
      idleEvictions: 1,
      capacityEvictions: 1,
      initializationCooldowns: 4,
    },
  };

  const rendered = renderStatus(rt, status);
  assert.match(rendered, /^  lsp client budget: idle=240000ms active=1\/8 initializing=1\/2 queued=3 starts=5 restarts=1 evictions=2\(idle=1,capacity=1\) cooldowns=4$/m);
  assert.match(rendered, /^    typescript: ready busy role=language /m);
});
