import assert from "node:assert/strict";
import { mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createDefaultConfig } from "../src/config.ts";
import { createDiagnosticSnapshot } from "../src/diagnostics/snapshots.ts";
import { handleContext } from "../src/events/context.ts";
import { handleToolCall } from "../src/events/tool-call.ts";
import { handleToolResult, processAppliedLspFileMutations } from "../src/events/tool-result.ts";
import {
  contentHash,
  createRuntime,
  enqueueDelayedFeedback,
  recordFileMutation,
  setProjectRoot,
} from "../src/runtime.ts";
import { inactiveFormatService, inactiveLspService } from "./helpers/inactive-services.mjs";

test("a newer mutation aborts an in-flight delayed diagnostic refresh", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-stale-running-"));
  const filePath = path.join(root, "probe.ts");
  await writeFile(filePath, "export const value = 1;\n", "utf8");

  const runtime = runtimeFor(root);
  let delayedSignal;
  let resolveDelayed;
  const lspService = {
    notifyFileMutations() {},
    cachedDiagnosticsIfKnown() {
      return createDiagnosticSnapshot([]);
    },
    prewarm() {},
    async diagnosticsForFileDetailed(_filePath, content, options) {
      const now = Date.now();
      if (content.includes("value = 2") && !options.signal) return timedOutRefresh(now);
      if (content.includes("value = 2")) {
        delayedSignal = options.signal;
        return await new Promise((resolve) => {
          resolveDelayed = resolve;
        });
      }
      return freshRefresh(now, []);
    },
  };

  try {
    await editFileThroughHooks(root, filePath, "edit-1", "export const value = 2;\n", runtime, lspService);
    assert.ok(delayedSignal);
    assert.equal(delayedSignal.aborted, false);

    await editFileThroughHooks(root, filePath, "edit-2", "export const value = 3;\n", runtime, lspService);
    resolveDelayed(freshRefresh(Date.now(), [{
      uri: pathToFileURL(filePath).href,
      range: {
        start: { line: 1, character: 14 },
        end: { line: 1, character: 19 },
      },
      severity: "error",
      message: "stale delayed diagnostic",
      source: "test-lsp",
      code: "STALE",
    }]));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(delayedSignal.aborted, true);
    assert.equal(runtime.delayedDiagnosticRequests.size, 0);
    assert.equal(runtime.delayedFeedback.length, 0);
    assert.equal(runtime.lastError, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("queued feedback survives unrelated and failed mutations but not a newer mutation of its file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-stale-queued-"));
  const firstPath = path.join(root, "first.ts");
  const secondPath = path.join(root, "second.ts");
  const firstContent = "export const first = 1;\n";
  await writeFile(firstPath, firstContent, "utf8");
  await writeFile(secondPath, "export const second = 1;\n", "utf8");

  const runtime = runtimeFor(root);
  const firstMutation = recordFileMutation(runtime, firstPath);
  try {
    assert.equal(enqueueDelayedFeedback(runtime, feedbackFor(firstMutation, firstContent)), true);

    recordFileMutation(runtime, secondPath);
    assert.equal(runtime.delayedFeedback.length, 1);

    await handleToolResult(
      { toolName: "edit", toolCallId: "failed-edit", input: { path: "first.ts" }, isError: true },
      { cwd: root },
      runtime,
      inactiveLspService,
      inactiveFormatService,
    );
    assert.equal(runtime.fileMutationGenerations.get(firstPath), firstMutation.generation);
    assert.equal(runtime.delayedFeedback.length, 1);

    runtime.config.contextInjection = false;
    assert.equal(handleContext({ messages: [] }, runtime), undefined);
    recordFileMutation(runtime, firstPath);
    assert.equal(runtime.delayedFeedback.length, 0);

    runtime.config.contextInjection = true;
    assert.equal(handleContext({ messages: [] }, runtime), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context injection rejects feedback when the file changed outside tracked mutation hooks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-stale-disk-"));
  const filePath = path.join(root, "probe.ts");
  const originalContent = "export const value = 1;\n";
  await writeFile(filePath, originalContent, "utf8");

  const runtime = runtimeFor(root);
  const mutation = recordFileMutation(runtime, filePath);
  assert.equal(enqueueDelayedFeedback(runtime, feedbackFor(mutation, originalContent)), true);
  await writeFile(filePath, "export const value = 2;\n", "utf8");

  try {
    assert.equal(handleContext({ messages: [{ role: "user", content: "next" }] }, runtime), undefined);
    assert.equal(runtime.delayedFeedback.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("apply_patch moves and deletes invalidate delayed feedback for every affected path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-stale-patch-"));
  const oldPath = path.join(root, "old.ts");
  const newPath = path.join(root, "new.ts");
  const content = "export const value = 1;\n";
  await writeFile(oldPath, content, "utf8");

  const runtime = runtimeFor(root);
  runtime.config.lsp.enabled = false;
  const oldMutation = recordFileMutation(runtime, oldPath);
  assert.equal(enqueueDelayedFeedback(runtime, feedbackFor(oldMutation, content)), true);

  const moveInput = {
    operations: [{ type: "update_file", path: "old.ts", move_path: "new.ts" }],
  };

  try {
    await handleToolCall({ toolName: "apply_patch", toolCallId: "move", input: moveInput }, { cwd: root }, runtime, inactiveLspService);
    await rename(oldPath, newPath);
    await handleToolResult(
      {
        toolName: "apply_patch",
        toolCallId: "move",
        input: moveInput,
        details: {
          stage: "done",
          results: [{
            type: "update_file",
            path: "new.ts",
            status: "completed",
            change: { type: "update", unifiedDiff: "", movePath: "new.ts" },
          }],
        },
        isError: false,
      },
      { cwd: root },
      runtime,
      inactiveLspService,
      inactiveFormatService,
    );

    assert.equal(runtime.delayedFeedback.length, 0);
    assert.ok(runtime.fileMutationGenerations.get(oldPath) > oldMutation.generation);
    assert.ok(runtime.fileMutationGenerations.get(newPath) > oldMutation.generation);

    const newMutation = recordFileMutation(runtime, newPath);
    assert.equal(enqueueDelayedFeedback(runtime, feedbackFor(newMutation, content)), true);
    const deleteInput = { operations: [{ type: "delete_file", path: "new.ts" }] };
    await handleToolCall({ toolName: "apply_patch", toolCallId: "delete", input: deleteInput }, { cwd: root }, runtime, inactiveLspService);
    await unlink(newPath);
    await handleToolResult(
      {
        toolName: "apply_patch",
        toolCallId: "delete",
        input: deleteInput,
        details: {
          stage: "done",
          results: [{ type: "delete_file", path: "new.ts", status: "completed", change: { type: "delete", content } }],
        },
        isError: false,
      },
      { cwd: root },
      runtime,
      inactiveLspService,
      inactiveFormatService,
    );
    assert.equal(runtime.delayedFeedback.length, 0);
    assert.ok(runtime.fileMutationGenerations.get(newPath) > newMutation.generation);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applied LSP WorkspaceEdit mutations invalidate older delayed feedback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-stale-lsp-edit-"));
  const filePath = path.join(root, "probe.ts");
  const beforeContent = "export const value = 1;\n";
  const afterContent = "export const value = 2;\n";
  await writeFile(filePath, beforeContent, "utf8");

  const runtime = runtimeFor(root);
  runtime.config.lsp.enabled = false;
  const oldMutation = recordFileMutation(runtime, filePath);
  assert.equal(enqueueDelayedFeedback(runtime, feedbackFor(oldMutation, beforeContent)), true);
  await writeFile(filePath, afterContent, "utf8");

  try {
    await processAppliedLspFileMutations(
      { content: [{ type: "text", text: "applied" }] },
      [{ id: "workspace-edit:1", filePath, beforeContent, afterAgentContent: afterContent }],
      runtime,
      inactiveLspService,
      inactiveFormatService,
    );
    assert.equal(runtime.delayedFeedback.length, 0);
    assert.ok(runtime.fileMutationGenerations.get(filePath) > oldMutation.generation);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the mutation-generation ledger is bounded without reusing generations", () => {
  const runtime = runtimeFor("/tmp/code-feedback-generation-ledger");
  const first = recordFileMutation(runtime, "/tmp/code-feedback-generation-ledger/0.ts");
  let last = first;
  for (let index = 1; index <= 1_000; index += 1) {
    last = recordFileMutation(runtime, `/tmp/code-feedback-generation-ledger/${index}.ts`);
  }

  assert.equal(runtime.fileMutationGenerations.size, 1_000);
  assert.equal(runtime.fileMutationGenerations.has(first.filePath), false);
  assert.equal(last.generation, 1_001);
});

async function editFileThroughHooks(root, filePath, id, content, runtime, lspService) {
  await handleToolCall({ toolName: "edit", toolCallId: id, input: { path: path.basename(filePath) } }, { cwd: root }, runtime, lspService);
  await writeFile(filePath, content, "utf8");
  await handleToolResult(
    {
      toolName: "edit",
      toolCallId: id,
      input: { path: path.basename(filePath) },
      details: { diff: "@@ -1,1 +1,1 @@\n-old\n+new\n" },
      isError: false,
    },
    { cwd: root },
    runtime,
    lspService,
    inactiveFormatService,
  );
}

function runtimeFor(root) {
  const runtime = createRuntime(createDefaultConfig());
  runtime.config.autoFormat = false;
  runtime.config.diagnostics.inlineTimeoutMs = 5;
  runtime.config.diagnostics.timeoutMs = 100;
  runtime.config.diagnostics.delayedTimeoutMs = 200;
  runtime.config.diagnostics.settleMs = 0;
  setProjectRoot(runtime, root);
  return runtime;
}

function feedbackFor(mutation, content) {
  return {
    id: `delayed:${path.basename(mutation.filePath)}:${mutation.generation}`,
    editId: `edit:${mutation.generation}`,
    filePath: mutation.filePath,
    mutationGeneration: mutation.generation,
    contentHash: contentHash(content),
    turnIndex: 1,
    writeIndex: mutation.generation,
    queuedAt: Date.now(),
    text: `code-feedback delayed LSP diagnostics for ${path.basename(mutation.filePath)}`,
  };
}

function timedOutRefresh(now) {
  return {
    snapshot: createDiagnosticSnapshot([], now),
    fresh: false,
    timedOut: true,
    requestedAt: now,
    completedAt: now,
  };
}

function freshRefresh(now, diagnostics) {
  return {
    snapshot: createDiagnosticSnapshot(diagnostics, now),
    fresh: true,
    timedOut: false,
    requestedAt: now,
    completedAt: now,
  };
}
