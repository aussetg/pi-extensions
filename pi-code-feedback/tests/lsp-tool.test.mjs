import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createDefaultConfig } from "../src/config.ts";
import { createLspService } from "../src/lsp/service.ts";
import { renderLspToolResult } from "../src/lsp/tool-renderer.ts";
import { registerLspTool } from "../src/lsp/tool.ts";
import { limitLspToolText } from "../src/lsp/tool-output.ts";
import { createRuntime, setProjectRoot } from "../src/runtime.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeServer = path.join(here, "fixtures", "fake-lsp-server.mjs");

test("lsp status explains lazy clients instead of exposing an ambiguous active-client count", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-tool-status-"));
  const { tool, service } = createRegisteredTool(root);

  try {
    const result = await tool.execute("lsp-1", { method: "server/status" }, undefined, undefined, { cwd: root });
    const text = result.content[0].text;
    assert.match(text, /clients: none yet — starts lazily when you query a source file/);
    assert.doesNotMatch(text, /active LSP clients/);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("lsp code actions return stable ids and apply by id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-tool-actions-"));
  const filePath = path.join(root, "probe.py");
  await writeFile(filePath, "import os\n", "utf8");

  const { tool, service } = createRegisteredTool(root);

  try {
    const listResult = await tool.execute("lsp-1", {
      method: "textDocument/codeAction",
      path: "probe.py",
      line: 1,
      column: 1,
    }, undefined, undefined, { cwd: root });

    const listPayload = JSON.parse(listResult.content[0].text);
    assert.equal(listPayload.ok, true);
    assert.equal(listPayload.method, "textDocument/codeAction");
    assert.equal(listPayload.actions.length, 1);
    assert.match(listPayload.actions[0].id, /^ca_[0-9a-z]{4}$/);
    assert.equal(listPayload.actions[0].applyable, true);
    assert.equal(listPayload.actions[0].title, "py fix T100");

    const applyResult = await tool.execute("lsp-2", {
      method: "codeAction/apply",
      id: listPayload.actions[0].id,
    }, undefined, undefined, { cwd: root });

    const applyPayload = JSON.parse(applyResult.content[0].text);
    assert.equal(applyPayload.ok, true);
    assert.equal(applyPayload.method, "codeAction/apply");
    assert.equal(applyPayload.editCount, 1);
    assert.deepEqual(applyPayload.changedFiles, ["probe.py"]);
    assert.match(await readFile(filePath, "utf8"), /^# fixed by py\nimport os\n/);

    const secondApply = await tool.execute("lsp-3", {
      method: "codeAction/apply",
      id: listPayload.actions[0].id,
    }, undefined, undefined, { cwd: root });

    assert.equal(secondApply.isError, true);
    assert.match(secondApply.content[0].text, /Unknown code action id/);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("lsp code action ids are rejected when file state changes before apply", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-tool-actions-stale-"));
  const filePath = path.join(root, "probe.py");
  await writeFile(filePath, "import os\n", "utf8");

  const { tool, service } = createRegisteredTool(root);

  try {
    const listResult = await tool.execute("lsp-1", {
      method: "textDocument/codeAction",
      path: "probe.py",
      line: 1,
      column: 1,
    }, undefined, undefined, { cwd: root });

    const id = JSON.parse(listResult.content[0].text).actions[0].id;
    await writeFile(filePath, "changed\nimport os\n", "utf8");

    const applyResult = await tool.execute("lsp-2", {
      method: "codeAction/apply",
      id,
    }, undefined, undefined, { cwd: root });

    assert.equal(applyResult.isError, true);
    assert.match(applyResult.content[0].text, /stale: file state changed since textDocument\/codeAction: probe\.py/);
    assert.match(applyResult.content[0].text, /Call textDocument\/codeAction again/);
    assert.equal(await readFile(filePath, "utf8"), "changed\nimport os\n");

    const secondApply = await tool.execute("lsp-3", {
      method: "codeAction/apply",
      id,
    }, undefined, undefined, { cwd: root });
    assert.equal(secondApply.isError, true);
    assert.match(secondApply.content[0].text, /Unknown code action id/);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("lsp rename apply returns structured JSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-tool-rename-"));
  const filePath = path.join(root, "probe.py");
  await writeFile(filePath, "const oldName = 1;\noldName;\n", "utf8");

  const { tool, service } = createRegisteredTool(root, "diagnostics");

  try {
    const result = await tool.execute("lsp-1", {
      method: "textDocument/rename",
      path: "probe.py",
      line: 1,
      column: 8,
      newName: "newName",
      apply: true,
    }, undefined, undefined, { cwd: root });

    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.method, "textDocument/rename");
    assert.equal(payload.newName, "newName");
    assert.equal(payload.editCount, 2);
    assert.deepEqual(payload.changedFiles, ["probe.py"]);
    assert.equal(await readFile(filePath, "utf8"), "const newName = 1;\nnewName;\n");
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("lsp tool text is truncated and saved to a temp file", async () => {
  const huge = Array.from({ length: 2100 }, (_, index) => `line ${index + 1}`).join("\n");
  const result = limitLspToolText(huge);

  assert.ok(result.truncation?.truncated);
  assert.match(result.text, /Output truncated/);
  assert.match(result.text, /Full output saved to:/);
  assert.equal(await readFile(result.truncation.fullOutputPath, "utf8"), huge);

  await rm(path.dirname(result.truncation.fullOutputPath), { recursive: true, force: true });
});

test("lsp errors are concise text while keeping structured details", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-tool-error-"));
  const { tool, service } = createRegisteredTool(root);

  try {
    const result = await tool.execute("lsp-1", {
      method: "textDocument/hover",
      path: "missing.py",
      line: 1,
      column: 1,
    }, undefined, undefined, { cwd: root });

    const text = result.content[0].text;
    assert.equal(result.isError, true);
    assert.equal(result.details.ok, false);
    assert.match(text, /lsp textDocument\/hover failed: Cannot read file for LSP request: missing\.py/);
    assert.match(text, /hint: Check that the path exists/);
    assert.doesNotMatch(text, /^\s*\{/);
    assert.doesNotMatch(text, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("lsp position inputs reject non-1-based values instead of clamping", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-tool-position-"));
  await writeFile(path.join(root, "probe.py"), "value = 1\n", "utf8");
  const { tool, service } = createRegisteredTool(root, "hover-code");

  try {
    const cases = [
      { method: "textDocument/hover", path: "probe.py", line: 0, column: 1 },
      { method: "textDocument/hover", path: "probe.py", line: 1, column: 0 },
      { method: "textDocument/hover", path: "probe.py", line: 1 },
      { method: "textDocument/definition", path: "probe.py", line: 1.5, column: 1 },
      { method: "textDocument/codeAction", path: "probe.py", line: 0, column: 1 },
    ];

    for (const input of cases) {
      const result = await tool.execute("lsp-invalid-position", input, undefined, undefined, { cwd: root });
      assert.equal(result.isError, true, JSON.stringify(input));
      assert.match(result.content[0].text, /requires 1-based line and column/, JSON.stringify(input));
      assert.match(result.content[0].text, /hint: Pass line and column as 1-based numbers\./, JSON.stringify(input));
    }

    const legacyCharacterResult = await tool.execute("lsp-legacy-character", {
      method: "textDocument/hover",
      path: "probe.py",
      line: 1,
      character: 1,
    }, undefined, undefined, { cwd: root });
    assert.equal(legacyCharacterResult.isError, undefined);
    assert.equal(legacyCharacterResult.content[0].text, "function fakeHover(value: number): number");
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("lsp error renderer handles structured JSON errors even when isError is absent", () => {
  const theme = {
    fg: (color, text) => `<${color}>${text}</${color}>`,
    bold: (text) => text,
  };
  const rendered = renderLspToolResult({
    content: [{ type: "text", text: JSON.stringify({ ok: false, method: "textDocument/hover", error: "broken", hint: "try again" }, null, 2) }],
    details: { ok: false, method: "textDocument/hover", error: "broken", hint: "try again" },
  }, { expanded: false }, theme, { args: { method: "textDocument/hover" } })
    .render(500)
    .join("\n");

  assert.equal(rendered, "<error>broken</error>\n<dim>try again</dim>");
});

test("lsp hover renderer strips a single markdown code fence and renders raw text", () => {
  const line = "interface DirectRawHover { value: number }";
  const theme = {
    fg: (color, text) => `<${color}>${text}</${color}>`,
    bold: (text) => text,
  };
  const rendered = renderLspToolResult({
    content: [{ type: "text", text: `\`\`\`typescript\n${line}\n\`\`\`` }],
  }, { expanded: false }, theme, { args: { method: "textDocument/hover" } })
    .render(500)
    .join("\n");

  assert.equal(rendered, `<toolOutput>${line}</toolOutput>`);
  assert.doesNotMatch(rendered, /```|textmate|syntax|code ·/);
});

test("lsp hover execution returns raw unfenced hover text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-tool-hover-"));
  await writeFile(path.join(root, "probe.py"), "value = 1\n", "utf8");
  const { tool, service } = createRegisteredTool(root, "hover-code");

  try {
    const result = await tool.execute("lsp-1", {
      method: "textDocument/hover",
      path: "probe.py",
      line: 1,
      column: 1,
    }, undefined, undefined, { cwd: root });

    assert.equal(result.details.method, "textDocument/hover");
    assert.equal(result.content[0].text, "function fakeHover(value: number): number");
    assert.doesNotMatch(result.content[0].text, /```/);
    assert.equal(result.details.highlight, undefined);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

function createRegisteredTool(root, mode = "actions-require-diagnostics") {
  const runtime = createRuntime(createDefaultConfig());
  setProjectRoot(runtime, root);
  runtime.config.autoFormat = false;
  runtime.config.lsp.servers = {
    python: {
      command: process.execPath,
      args: [fakeServer, "py", "T100", "1", "", mode],
    },
    "python-ruff": { disabled: true },
  };

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: runtime.config.lsp.servers,
  });

  let tool;
  registerLspTool({
    registerTool(definition) {
      tool = definition;
    },
    registerCommand() {},
  }, runtime, service);

  assert.ok(tool);
  return { runtime, service, tool };
}
