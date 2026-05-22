import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createDefaultConfig } from "../src/config.ts";
import { createDiagnosticSnapshot } from "../src/diagnostics/snapshots.ts";
import { handleToolResult } from "../src/events/tool-result.ts";
import { createRuntime, setProjectRoot } from "../src/runtime.ts";
import { CODE_FEEDBACK_DETAILS_KEY } from "../src/types.ts";

test("inline diagnostics are mirrored into structured tool-result details", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-details-"));
  const filePath = path.join(root, "probe.ts");
  await writeFile(filePath, "export const value: number = 'nope';\n", "utf8");

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
    const result = await handleToolResult(
      {
        toolName: "write",
        toolCallId: "write-1",
        input: { path: "probe.ts" },
        content: [{ type: "text", text: "Wrote probe.ts" }],
        details: { existing: "preserved" },
        isError: false,
      },
      { cwd: root },
      runtime,
      lspService,
    );

    assert.ok(result);
    assert.equal(result.details.existing, "preserved");

    const feedback = result.details[CODE_FEEDBACK_DETAILS_KEY];
    assert.equal(feedback.version, 1);
    assert.match(feedback.inlineText, /pi-code-feedback:/);
    assert.match(feedback.inlineText, /typescript\/2322/);
    assert.equal(result.content.at(-1).text, feedback.inlineText);

    assert.equal(feedback.edits.length, 1);
    assert.equal(feedback.edits[0].displayPath, "probe.ts");
    assert.equal(feedback.edits[0].diagnostics.label, "touched diagnostics");
    assert.equal(feedback.edits[0].diagnostics.linked.length, 1);
    assert.equal(feedback.edits[0].diagnostics.linked[0].diagnostic.code, 2322);
    assert.deepEqual(feedback.edits[0].diagnostics.summary, {
      totalDiagnostics: 1,
      linkedDiagnostics: 1,
      shownDiagnostics: 1,
      hiddenUnrelated: 0,
      hiddenByLimit: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
