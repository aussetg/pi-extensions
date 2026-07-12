import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDefaultConfig } from "../src/config.ts";
import { handleToolCall } from "../src/events/tool-call.ts";
import { handleToolResult } from "../src/events/tool-result.ts";
import { beginTurn, createRuntime, setProjectRoot } from "../src/runtime.ts";

test("formatter is skipped when a tool result leaves file content unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-format-skip-"));
  const filePath = path.join(root, "probe.ts");
  const content = "export const value = 1;\n";
  await writeFile(filePath, content, "utf8");

  const runtime = createRuntime(createDefaultConfig());
  runtime.config.lsp.enabled = false;
  setProjectRoot(runtime, root);

  let formatCalls = 0;
  const formatService = {
    async formatFile(_filePath, beforeContent) {
      formatCalls += 1;
      return {
        changed: false,
        finalContent: beforeContent,
        errors: [],
      };
    },
  };

  try {
    beginTurn(runtime);
    await handleToolCall({ toolName: "edit", toolCallId: "edit-unchanged", input: { path: "probe.ts" } }, { cwd: root }, runtime);
    await writeFile(filePath, content, "utf8");
    await handleToolResult(
      {
        toolName: "edit",
        toolCallId: "edit-unchanged",
        input: { path: "probe.ts" },
        content: [{ type: "text", text: "edited" }],
        isError: false,
      },
      { cwd: root },
      runtime,
      undefined,
      formatService,
    );

    assert.equal(formatCalls, 0);
    assert.equal(runtime.completedEdits.at(-1)?.formatter?.skippedReason, "unchanged by tool");

    beginTurn(runtime);
    await handleToolCall({ toolName: "edit", toolCallId: "edit-changed", input: { path: "probe.ts" } }, { cwd: root }, runtime);
    await writeFile(filePath, "export const value = 2;\n", "utf8");
    await handleToolResult(
      {
        toolName: "edit",
        toolCallId: "edit-changed",
        input: { path: "probe.ts" },
        details: {
          diff: "@@ -1,1 +1,1 @@\n-export const value = 1;\n+export const value = 2;\n",
        },
        content: [{ type: "text", text: "edited" }],
        isError: false,
      },
      { cwd: root },
      runtime,
      undefined,
      formatService,
    );

    assert.equal(formatCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
