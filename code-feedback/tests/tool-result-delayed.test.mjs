import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createDefaultConfig } from "../src/config.ts";
import { createDiagnosticSnapshot } from "../src/diagnostics/snapshots.ts";
import { handleToolCall } from "../src/events/tool-call.ts";
import { handleContext } from "../src/events/context.ts";
import { handleToolResult } from "../src/events/tool-result.ts";
import { createRuntime, setProjectRoot } from "../src/runtime.ts";

test("slow after diagnostics use the inline budget and arrive through delayed context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-delayed-"));
  const filePath = path.join(root, "probe.ts");
  await writeFile(filePath, "export const value = 1;\n", "utf8");

  const runtime = createRuntime(createDefaultConfig());
  runtime.config.autoFormat = false;
  runtime.config.diagnostics.inlineTimeoutMs = 25;
  runtime.config.diagnostics.timeoutMs = 500;
  runtime.config.diagnostics.delayedTimeoutMs = 900;
  runtime.config.diagnostics.settleMs = 0;
  setProjectRoot(runtime, root);

  const diagnostic = {
    uri: pathToFileURL(filePath).href,
    range: {
      start: { line: 1, character: 14 },
      end: { line: 1, character: 19 },
    },
    severity: "error",
    message: "Delayed diagnostic",
    source: "test-lsp",
    code: "TDELAY",
  };

  const refreshOptions = [];
  const lspService = {
    cachedDiagnosticsIfKnown() {
      return createDiagnosticSnapshot([]);
    },
    prewarm() {},
    async diagnosticsForFileDetailed(_filePath, _content, options) {
      refreshOptions.push(options);
      const now = Date.now();
      if (refreshOptions.length === 1) {
        return {
          snapshot: createDiagnosticSnapshot([], now),
          fresh: false,
          timedOut: true,
          requestedAt: now,
          completedAt: now,
        };
      }
      return {
        snapshot: createDiagnosticSnapshot([diagnostic], now),
        fresh: true,
        timedOut: false,
        requestedAt: now,
        completedAt: now,
      };
    },
  };

  try {
    await handleToolCall(
      { toolName: "edit", toolCallId: "edit-1", input: { path: "probe.ts" } },
      { cwd: root },
      runtime,
      lspService,
    );

    await writeFile(filePath, "export const value = 2;\n", "utf8");
    const result = await handleToolResult(
      {
        toolName: "edit",
        toolCallId: "edit-1",
        input: { path: "probe.ts" },
        details: {
          diff: "@@ -1,1 +1,1 @@\n-export const value = 1;\n+export const value = 2;\n",
        },
        content: [{ type: "text", text: "edited" }],
        isError: false,
      },
      { cwd: root },
      runtime,
      lspService,
    );

    assert.equal(result, undefined);
    assert.equal(refreshOptions[0].timeoutMs, 25);
    assert.equal(refreshOptions[0].settleMs, 0);

    await waitFor(() => runtime.delayedFeedback.length === 1);
    assert.equal(refreshOptions[1].timeoutMs, 900);
    assert.equal(refreshOptions[1].settleMs, 0);

    const context = handleContext({ messages: [{ role: "user", content: "next" }] }, runtime);
    assert.ok(context);
    assert.match(context.messages[0].content, /Delayed code-feedback LSP feedback/);
    assert.match(context.messages[0].content, /test-lsp\/TDELAY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strict mode keeps the full after-diagnostic wait budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-strict-budget-"));
  const filePath = path.join(root, "probe.ts");
  await writeFile(filePath, "export const value = 1;\n", "utf8");

  const runtime = createRuntime(createDefaultConfig());
  runtime.config.autoFormat = false;
  runtime.config.strict = true;
  runtime.config.diagnostics.inlineTimeoutMs = 25;
  runtime.config.diagnostics.timeoutMs = 500;
  runtime.config.diagnostics.settleMs = 17;
  setProjectRoot(runtime, root);

  const refreshOptions = [];
  const lspService = {
    cachedDiagnosticsIfKnown() {
      return createDiagnosticSnapshot([]);
    },
    prewarm() {},
    async diagnosticsForFileDetailed(_filePath, _content, options) {
      refreshOptions.push(options);
      const now = Date.now();
      return {
        snapshot: createDiagnosticSnapshot([], now),
        fresh: true,
        timedOut: false,
        requestedAt: now,
        completedAt: now,
      };
    },
  };

  try {
    await handleToolCall(
      { toolName: "edit", toolCallId: "edit-1", input: { path: "probe.ts" } },
      { cwd: root },
      runtime,
      lspService,
    );

    await writeFile(filePath, "export const value = 2;\n", "utf8");
    await handleToolResult(
      {
        toolName: "edit",
        toolCallId: "edit-1",
        input: { path: "probe.ts" },
        details: {
          diff: "@@ -1,1 +1,1 @@\n-export const value = 1;\n+export const value = 2;\n",
        },
        content: [{ type: "text", text: "edited" }],
        isError: false,
      },
      { cwd: root },
      runtime,
      lspService,
    );

    assert.equal(refreshOptions[0].timeoutMs, 500);
    assert.equal(refreshOptions[0].settleMs, 17);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate) {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true);
}
