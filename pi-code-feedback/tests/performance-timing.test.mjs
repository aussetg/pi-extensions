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
import { renderDiagnosticsStatus } from "../src/render.ts";
import { createRuntime, setProjectRoot } from "../src/runtime.ts";
import { CODE_FEEDBACK_DETAILS_KEY } from "../src/types.ts";

test("edit phase timings are recorded and mirrored into feedback details", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-timing-"));
  const filePath = path.join(root, "probe.ts");
  const before = "export const value: number = 1;\n";
  const after = "export const value: number = 'nope';\n";
  await writeFile(filePath, before, "utf8");

  const runtime = createRuntime(createDefaultConfig());
  runtime.config.autoFormat = false;
  runtime.config.diagnostics.settleMs = 0;
  setProjectRoot(runtime, root);

  const diagnostic = {
    uri: pathToFileURL(filePath).href,
    range: {
      start: { line: 1, character: 30 },
      end: { line: 1, character: 36 },
    },
    severity: "error",
    message: "Type 'string' is not assignable to type 'number'.",
    source: "typescript",
    code: 2322,
  };

  const lspService = {
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
    );
    await writeFile(filePath, after, "utf8");

    const result = await handleToolResult(
      {
        toolName: "edit",
        toolCallId: "edit-1",
        input: { path: "probe.ts" },
        details: { diff: `@@ -1,1 +1,1 @@\n-${before.trimEnd()}\n+${after.trimEnd()}\n` },
        content: [{ type: "text", text: "edited" }],
        isError: false,
      },
      { cwd: root },
      runtime,
      lspService,
    );

    const edit = runtime.completedEdits.at(-1);
    assert.ok(edit?.timing);
    assert.ok(edit.timing.totalMs >= 0);

    const phaseNames = edit.timing.phases.map((phase) => phase.name);
    assert.ok(phaseNames.includes("tool_call.read_before"));
    assert.ok(phaseNames.includes("tool_result.read_after"));
    assert.ok(phaseNames.includes("tool_result.touched_ranges"));
    assert.ok(phaseNames.includes("tool_result.after_diagnostics"));
    assert.ok(phaseNames.includes("tool_result.render"));

    const detailsTiming = result.details[CODE_FEEDBACK_DETAILS_KEY].edits[0].timing;
    assert.deepEqual(detailsTiming, edit.timing);

    const diagnosticsStatus = renderDiagnosticsStatus(runtime, "probe.ts", createDiagnosticSnapshot([diagnostic]));
    assert.doesNotMatch(diagnosticsStatus, /timing: total/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnostic rendering keeps external paths absolute instead of parent-relative", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-render-root-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-render-external-"));
  const filePath = path.join(external, "probe.ts");
  const runtime = createRuntime(createDefaultConfig());
  setProjectRoot(runtime, root);

  const diagnostic = {
    uri: pathToFileURL(filePath).href,
    range: {
      start: { line: 1, character: 1 },
      end: { line: 1, character: 2 },
    },
    severity: "error",
    message: "external diagnostic",
    source: "typescript",
  };

  try {
    const rendered = renderDiagnosticsStatus(runtime, filePath, createDiagnosticSnapshot([diagnostic]));
    assert.match(rendered, new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(rendered, /\.\.\/.*probe\.ts/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});
