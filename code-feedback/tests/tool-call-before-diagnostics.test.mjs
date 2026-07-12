import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createDefaultConfig } from "../src/config.ts";
import { createDiagnosticSnapshot } from "../src/diagnostics/snapshots.ts";
import { handleToolCall } from "../src/events/tool-call.ts";
import { handleToolResult } from "../src/events/tool-result.ts";
import { createRuntime, setProjectRoot } from "../src/runtime.ts";
import { CODE_FEEDBACK_DETAILS_KEY } from "../src/types.ts";

test("tool_call captures cached before diagnostics without refreshing the document", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-before-cache-"));
  const filePath = path.join(root, "probe.ts");
  await writeFile(filePath, "export const value = 1;\n", "utf8");

  const runtime = createRuntime(createDefaultConfig());
  setProjectRoot(runtime, root);

  const snapshot = createDiagnosticSnapshot([]);
  let prewarmedPath;
  const lspService = {
    cachedDiagnosticsIfKnown(requestedPath) {
      assert.equal(path.resolve(requestedPath), filePath);
      return snapshot;
    },
    prewarm(requestedPath) {
      prewarmedPath = path.resolve(requestedPath);
    },
    async diagnosticsForFile() {
      throw new Error("tool_call must not block on before diagnostic refresh");
    },
  };

  try {
    await handleToolCall(
      { toolName: "edit", toolCallId: "edit-1", input: { path: "probe.ts" } },
      { cwd: root },
      runtime,
      lspService,
    );

    const pending = runtime.pendingEdits.get("edit-1");
    assert.ok(pending);
    assert.equal(pending.beforeDiagnostics, snapshot);
    assert.equal(prewarmedPath, filePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cached before diagnostics preserve new-on-touched-file provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-before-provenance-"));
  const filePath = path.join(root, "probe.ts");
  await writeFile(filePath, "export const value = 1;\nexport const other = 2;\nexport const third = 3;\n", "utf8");

  const runtime = createRuntime(createDefaultConfig());
  runtime.config.autoFormat = false;
  runtime.config.diagnostics.settleMs = 0;
  setProjectRoot(runtime, root);

  const diagnostic = {
    uri: pathToFileURL(filePath).href,
    range: {
      start: { line: 3, character: 14 },
      end: { line: 3, character: 19 },
    },
    severity: "error",
    message: "New nearby diagnostic",
    source: "test-lsp",
    code: "TNEW",
  };

  const lspService = {
    cachedDiagnosticsIfKnown() {
      return createDiagnosticSnapshot([]);
    },
    prewarm() {},
    async diagnosticsForFileDetailed() {
      const now = Date.now();
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

    await writeFile(filePath, "export const value = 10;\nexport const other = 2;\nexport const third = 3;\n", "utf8");
    const result = await handleToolResult(
      {
        toolName: "edit",
        toolCallId: "edit-1",
        input: { path: "probe.ts" },
        details: {
          diff: "@@ -1,1 +1,1 @@\n-export const value = 1;\n+export const value = 10;\n",
        },
        content: [{ type: "text", text: "edited" }],
        isError: false,
      },
      { cwd: root },
      runtime,
      lspService,
    );

    const feedback = result.details[CODE_FEEDBACK_DETAILS_KEY];
    const linked = feedback.edits[0].diagnostics.linked;
    assert.equal(linked.length, 1);
    assert.equal(linked[0].linkReason, "new-on-touched-file");
    assert.equal(linked[0].isNewOrWorsened, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown before diagnostics do not mark nearby diagnostics as new", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-before-unknown-"));
  const filePath = path.join(root, "probe.ts");
  await writeFile(filePath, "export const value = 1;\nexport const other = 2;\nexport const third = 3;\n", "utf8");

  const runtime = createRuntime(createDefaultConfig());
  runtime.config.autoFormat = false;
  runtime.config.diagnostics.settleMs = 0;
  setProjectRoot(runtime, root);

  const diagnostic = {
    uri: pathToFileURL(filePath).href,
    range: {
      start: { line: 3, character: 14 },
      end: { line: 3, character: 19 },
    },
    severity: "error",
    message: "Possibly pre-existing nearby diagnostic",
    source: "test-lsp",
    code: "TOLD",
  };

  const lspService = {
    cachedDiagnosticsIfKnown() {
      return undefined;
    },
    prewarm() {},
    async diagnosticsForFileDetailed() {
      const now = Date.now();
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

    await writeFile(filePath, "export const value = 10;\nexport const other = 2;\nexport const third = 3;\n", "utf8");
    const result = await handleToolResult(
      {
        toolName: "edit",
        toolCallId: "edit-1",
        input: { path: "probe.ts" },
        details: {
          diff: "@@ -1,1 +1,1 @@\n-export const value = 1;\n+export const value = 10;\n",
        },
        content: [{ type: "text", text: "edited" }],
        isError: false,
      },
      { cwd: root },
      runtime,
      lspService,
    );

    assert.equal(result, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
