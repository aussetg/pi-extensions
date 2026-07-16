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
import { CODE_FEEDBACK_DETAILS_KEY } from "../src/types.ts";
import { inactiveFormatService } from "./helpers/inactive-services.mjs";

test("new cross-file diagnostics are labeled as possible workspace impact and never fail strict edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-workspace-delta-"));
  const sourcePath = path.join(root, "source.ts");
  const targetPath = path.join(root, "target.ts");
  await writeFile(sourcePath, "export const value = 1;\n", "utf8");
  await writeFile(targetPath, "export const target = 1;\n", "utf8");

  const existing = diagnostic(targetPath, "OLD", "existing warning", "warning");
  const possible = diagnostic(targetPath, "NEW", "new project failure", "error");
  const before = createDiagnosticSnapshot([existing]);
  const after = createDiagnosticSnapshot([existing, possible]);
  const capturedScopes = [];
  const lspService = {
    notifyFileMutations() {},
    cachedDiagnosticsIfKnown(_filePath, _server, scope) {
      capturedScopes.push(scope);
      return before;
    },
    prewarm() {},
    async diagnosticsForFileDetailed() {
      const now = Date.now();
      return {
        snapshot: after,
        fresh: true,
        timedOut: false,
        requestedAt: now,
        completedAt: now,
      };
    },
  };
  const runtime = createRuntime(createDefaultConfig());
  runtime.config.autoFormat = false;
  runtime.config.strict = true;
  runtime.config.diagnostics.settleMs = 0;
  setProjectRoot(runtime, root);

  try {
    await handleToolCall({
      toolName: "edit",
      toolCallId: "edit-source",
      input: { path: "source.ts" },
    }, { cwd: root }, runtime, lspService);
    await writeFile(sourcePath, "export const value = 2;\n", "utf8");

    const result = await handleToolResult({
      toolName: "edit",
      toolCallId: "edit-source",
      input: { path: "source.ts" },
      details: { diff: "@@ -1,1 +1,1 @@\n-export const value = 1;\n+export const value = 2;\n" },
      content: [{ type: "text", text: "edited" }],
      isError: false,
    }, { cwd: root }, runtime, lspService, inactiveFormatService);

    assert.deepEqual(capturedScopes, ["workspace"]);
    assert.ok(result);
    assert.equal(Object.hasOwn(result, "isError"), false, "possible impact must not participate in strict attribution");
    assert.match(result.content.at(-1).text, /possible workspace impact \(not attributed\): 1 error/);
    assert.match(result.content.at(-1).text, /target\.ts:1:1/);

    const edit = runtime.completedEdits.at(-1);
    assert.equal(edit?.diagnosticFilter?.linked.length, 0);
    assert.deepEqual(edit?.workspaceDelta?.diagnostics.map((entry) => entry.code), ["NEW"]);
    assert.deepEqual(edit?.workspaceDelta?.summary, {
      totalNewOrWorsened: 1,
      shownDiagnostics: 1,
      hiddenByLimit: 0,
    });

    const details = result.details[CODE_FEEDBACK_DETAILS_KEY].edits[0];
    assert.equal(details.workspaceDelta.label, "possible workspace impact");
    assert.equal(details.workspaceDelta.diagnostics[0].code, "NEW");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("late possible workspace impacts use the stale-safe delayed context queue", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-delayed-workspace-delta-"));
  const sourcePath = path.join(root, "source.ts");
  const targetPath = path.join(root, "target.ts");
  const beforeContent = "export const value = 1;\n";
  const afterContent = "export const value = 2;\n";
  await writeFile(sourcePath, beforeContent, "utf8");
  await writeFile(targetPath, "export const target = 1;\n", "utf8");

  const possible = diagnostic(targetPath, "LATE", "late project failure", "error");
  let refreshCount = 0;
  const lspService = {
    notifyFileMutations() {},
    cachedDiagnosticsIfKnown() {
      return createDiagnosticSnapshot([]);
    },
    prewarm() {},
    async diagnosticsForFileDetailed() {
      refreshCount += 1;
      const now = Date.now();
      return refreshCount === 1
        ? {
            snapshot: createDiagnosticSnapshot([], now),
            fresh: false,
            timedOut: true,
            requestedAt: now,
            completedAt: now,
          }
        : {
            snapshot: createDiagnosticSnapshot([possible], now),
            fresh: true,
            timedOut: false,
            requestedAt: now,
            completedAt: now,
          };
    },
  };
  const runtime = createRuntime(createDefaultConfig());
  runtime.config.autoFormat = false;
  runtime.config.diagnostics.settleMs = 0;
  setProjectRoot(runtime, root);

  try {
    await handleToolCall({
      toolName: "edit",
      toolCallId: "edit-source",
      input: { path: "source.ts" },
    }, { cwd: root }, runtime, lspService);
    await writeFile(sourcePath, afterContent, "utf8");
    const result = await handleToolResult({
      toolName: "edit",
      toolCallId: "edit-source",
      input: { path: "source.ts" },
      details: { diff: "@@ -1,1 +1,1 @@\n-export const value = 1;\n+export const value = 2;\n" },
      isError: false,
    }, { cwd: root }, runtime, lspService, inactiveFormatService);

    assert.equal(result, undefined);
    await waitFor(() => runtime.delayedFeedback.length === 1);
    assert.match(runtime.delayedFeedback[0].text, /possible workspace impact \(not attributed\): 1 error/);
    assert.match(runtime.delayedFeedback[0].text, /test-lsp\/LATE/);
    assert.deepEqual(runtime.delayedFeedback[0].validationContentHashes?.map((entry) => entry.filePath), [targetPath]);

    await writeFile(targetPath, "export const target = 2;\n", "utf8");
    assert.equal(handleContext({ messages: [{ role: "user", content: "continue" }] }, runtime), undefined);
    assert.equal(runtime.delayedFeedback.length, 0, "a changed cross-file diagnostic target must stale the delayed delta");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function diagnostic(filePath, code, message, severity) {
  return {
    uri: pathToFileURL(filePath).href,
    range: {
      start: { line: 1, character: 1 },
      end: { line: 1, character: 5 },
    },
    severity,
    message,
    source: "test-lsp",
    code,
  };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true);
}
