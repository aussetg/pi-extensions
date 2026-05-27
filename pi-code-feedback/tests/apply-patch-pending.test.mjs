import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDefaultConfig } from "../src/config.ts";
import { handleToolCall } from "../src/events/tool-call.ts";
import { handleToolResult } from "../src/events/tool-result.ts";
import { createRuntime, setProjectRoot } from "../src/runtime.ts";

test("failed apply_patch results discard pending edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-apply-patch-failed-"));
  await writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
  await writeFile(path.join(root, "b.ts"), "export const b = 1;\n", "utf8");

  const runtime = runtimeFor(root);
  const input = {
    operations: [
      { type: "update_file", path: "a.ts" },
      { type: "update_file", path: "b.ts" },
    ],
  };

  try {
    await handleToolCall({ toolName: "apply_patch", toolCallId: "patch-1", input }, { cwd: root }, runtime);
    assert.equal(runtime.pendingEdits.size, 2);

    await handleToolResult(
      {
        toolName: "apply_patch",
        toolCallId: "patch-1",
        input,
        details: {
          stage: "done",
          results: [
            { type: "update_file", path: "a.ts", status: "failed" },
            { type: "update_file", path: "b.ts", status: "failed" },
          ],
        },
        isError: false,
      },
      { cwd: root },
      runtime,
    );

    assert.equal(runtime.pendingEdits.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("errored or malformed apply_patch results discard the pending batch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-apply-patch-error-"));
  await writeFile(path.join(root, "probe.ts"), "export const value = 1;\n", "utf8");

  const runtime = runtimeFor(root);
  const input = { operations: [{ type: "update_file", path: "probe.ts" }] };

  try {
    await handleToolCall({ toolName: "apply_patch", toolCallId: "patch-error", input }, { cwd: root }, runtime);
    assert.equal(runtime.pendingEdits.size, 1);
    await handleToolResult({ toolName: "apply_patch", toolCallId: "patch-error", input, isError: true }, { cwd: root }, runtime);
    assert.equal(runtime.pendingEdits.size, 0);

    await handleToolCall({ toolName: "apply_patch", toolCallId: "patch-empty", input }, { cwd: root }, runtime);
    assert.equal(runtime.pendingEdits.size, 1);
    await handleToolResult({ toolName: "apply_patch", toolCallId: "patch-empty", input, details: {}, isError: false }, { cwd: root }, runtime);
    assert.equal(runtime.pendingEdits.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completed apply_patch results use persisted unifiedDiff changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-apply-patch-change-"));
  const filePath = path.join(root, "probe.ts");
  await writeFile(filePath, "export const a = 1;\nexport const b = 1;\n", "utf8");

  const runtime = runtimeFor(root);
  const input = { operations: [{ type: "update_file", path: "probe.ts" }] };

  try {
    await handleToolCall({ toolName: "apply_patch", toolCallId: "patch-change", input }, { cwd: root }, runtime);
    await writeFile(filePath, "export const a = 1;\nexport const b = 2;\n", "utf8");

    await handleToolResult(
      {
        toolName: "apply_patch",
        toolCallId: "patch-change",
        input,
        details: {
          stage: "done",
          results: [
            {
              type: "update_file",
              path: "probe.ts",
              status: "completed",
              change: {
                type: "update",
                unifiedDiff:
                  "Index: probe.ts\n" +
                  "===================================================================\n" +
                  "--- probe.ts\n" +
                  "+++ probe.ts\n" +
                  "@@ -1,2 +1,2 @@\n" +
                  " export const a = 1;\n" +
                  "-export const b = 1;\n" +
                  "+export const b = 2;\n",
              },
            },
          ],
        },
        isError: false,
      },
      { cwd: root },
      runtime,
    );

    assert.equal(runtime.completedEdits.length, 1);
    assert.equal(runtime.completedEdits[0].rangeComputation.toolDiff.used, true);
    assert.deepEqual(
      runtime.completedEdits[0].touchedRanges.map((range) => [range.startLine, range.endLine]),
      [[2, 2]],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runtimeFor(root) {
  const runtime = createRuntime(createDefaultConfig());
  runtime.config.autoFormat = false;
  runtime.config.lsp.enabled = false;
  setProjectRoot(runtime, root);
  return runtime;
}
