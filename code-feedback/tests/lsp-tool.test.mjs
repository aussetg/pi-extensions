import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createDefaultConfig } from "../src/config.ts";
import { createDiagnosticSnapshot } from "../src/diagnostics/snapshots.ts";
import { DEFAULT_LSP_SOURCE_FILE_MAX_BYTES } from "../src/fs.ts";
import { createLspService } from "../src/lsp/service.ts";
import { renderLspToolCall, renderLspToolResult } from "../src/lsp/tool-renderer.ts";
import { registerLspTool } from "../src/lsp/tool.ts";
import { LSP_TOOL_DETAILS_MAX_BYTES, formatLspToolJson, limitLspToolDetails, limitLspToolText } from "../src/lsp/tool-output.ts";
import { createRuntime, setProjectRoot } from "../src/runtime.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeServer = path.join(here, "fixtures", "fake-lsp-server.mjs");
const directMutationQueue = (_filePath, run) => run();
const inactiveFormatService = {
  configure() {},
  getStatus() { return { recentRuns: [], commands: [] }; },
};

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

test("lsp agent schema excludes legacy aliases and unrestricted methods", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-tool-schema-"));
  const { tool, service } = createRegisteredTool(root);

  try {
    const properties = tool.parameters.properties;
    for (const removed of ["action", "character", "apply", "all", "waitMs", "timeoutMs", "refresh", "request", "params"]) {
      assert.equal(Object.hasOwn(properties, removed), false, removed);
    }
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(tool.parameters.required, ["method"]);
    assert.equal(properties.method.enum.includes("textDocument/semanticTokens"), false);
    assert.equal(properties.method.enum.includes("raw/request"), false);
    assert.equal(properties.method.enum.includes("codeAction/apply"), false);
    assert.equal(properties.method.enum.includes("workspaceEdit/apply"), true);
    assert.equal(properties.method.enum.includes("workspace/renameFile"), true);
    assert.equal(properties.newPath.type, "string");
    assert.equal(properties.server.type, "string");
    assert.equal(properties.server.minLength, 1);
    assert.equal(properties.limit.type, "number");
    assert.equal(properties.limit.minimum, 1);
    assert.equal(properties.limit.maximum, 200);
    assert.equal(properties.symbol.type, "string");
    assert.equal(properties.symbol.maxLength, 512);
    assert.equal(properties.occurrence.type, "number");
    assert.equal(properties.occurrence.minimum, 1);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("lsp tool preserves trusted roots when reconfiguring services", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-tool-trust-"));
  const trusted = path.join(root, "trusted");
  const runtime = createRuntime(createDefaultConfig());
  setProjectRoot(runtime, root);
  runtime.trustedEnvironmentRoots = [trusted];

  const lspConfigureCalls = [];
  const formatConfigureCalls = [];
  const lspService = {
    configure(options) { lspConfigureCalls.push(options); },
    getStatus() { return { activeClients: 0, clients: [], unavailableServers: [] }; },
  };
  const formatService = {
    configure(options) { formatConfigureCalls.push(options); },
    getStatus() { return { recentRuns: [], commands: [] }; },
  };

  let tool;
  registerLspTool({
    registerTool(definition) { tool = definition; },
    registerCommand() {},
    on() {},
  }, runtime, lspService, formatService, directMutationQueue);

  try {
    await tool.execute("lsp-1", { method: "server/status" }, undefined, undefined, { cwd: root });

    assert.deepEqual(lspConfigureCalls[0].trustedEnvironmentRoots, [trusted]);
    assert.deepEqual(formatConfigureCalls[0].trustedEnvironmentRoots, [trusted]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lsp tool blocks project-local LSP work when Pi project trust is declined", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-tool-untrusted-"));
  const runtime = createRuntime(createDefaultConfig());
  setProjectRoot(runtime, root);
  runtime.projectTrusted = false;

  let hoverCalled = false;
  const lspService = {
    configure() {},
    getStatus() { return { activeClients: 0, clients: [], unavailableServers: [], diagnosticRefreshes: { active: 0, queued: 0 } }; },
    hover() { hoverCalled = true; throw new Error("hover should not run"); },
  };

  let tool;
  registerLspTool({
    registerTool(definition) { tool = definition; },
    registerCommand() {},
    on() {},
  }, runtime, lspService, inactiveFormatService, directMutationQueue);

  try {
    const result = await tool.execute("lsp-untrusted", {
      method: "textDocument/hover",
      path: "probe.py",
      line: 1,
      column: 1,
    }, undefined, undefined, { cwd: root });

    assert.equal(hoverCalled, false);
    assert.equal(result.isError, true);
    assert.equal(result.details.ok, false);
    assert.match(result.content[0].text, /Project is not trusted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit diagnostic timeouts fail without returning cached diagnostics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-tool-diagnostic-timeout-"));
  const runtime = createRuntime(createDefaultConfig());
  setProjectRoot(runtime, root);
  let requestedTimeoutMs;
  const snapshot = createDiagnosticSnapshot([{
    uri: pathToFileURL(path.join(root, "probe.py")).href,
    range: { start: { line: 1, character: 1 }, end: { line: 1, character: 2 } },
    severity: "error",
    source: "stale-cache",
    code: "STALE",
    message: "stale diagnostic must not leak",
  }]);
  const lspService = {
    configure() {},
    getStatus() { return { activeClients: 0, clients: [], unavailableServers: [] }; },
    async diagnosticsForFileDetailed(_filePath, _content, options) {
      requestedTimeoutMs = options.timeoutMs;
      return {
        snapshot,
        fresh: false,
        timedOut: true,
        requestedAt: 100,
        completedAt: 10_100,
      };
    },
  };
  let tool;
  registerLspTool({
    registerTool(definition) { tool = definition; },
    registerCommand() {},
    on() {},
  }, runtime, lspService, inactiveFormatService, directMutationQueue);

  try {
    const result = await tool.execute("lsp-timeout", {
      method: "textDocument/diagnostic",
      path: "probe.py",
    }, undefined, undefined, { cwd: root });

    assert.equal(result.isError, true);
    assert.equal(result.details.ok, false);
    assert.equal(result.details.authoritative, false);
    assert.equal(result.details.diagnosticsReturned, false);
    assert.equal(result.details.diagnosticRefresh.outcome, "timed-out");
    assert.equal(result.details.diagnosticRefresh.durationMs, 10_000);
    assert.equal(requestedTimeoutMs, 10_000);
    assert.match(result.content[0].text, /timed out after 10000ms; no diagnostics returned/);
    assert.match(result.details.hint, /never substitute cached or stale diagnostics/);
    assert.doesNotMatch(result.content[0].text, /stale diagnostic must not leak|STALE/);

    const theme = {
      fg: (color, text) => `<${color}>${text}</${color}>`,
      bold: (text) => text,
    };
    const rendered = renderLspToolResult(result, { expanded: false }, theme, {
      args: { method: "textDocument/diagnostic", path: "probe.py" },
    }).render(500).join("\n");
    assert.match(rendered, /^<error>lsp textDocument\/diagnostic/);
    assert.match(rendered, /timed out/);

    lspService.diagnosticsForFileDetailed = async () => undefined;
    const unavailable = await tool.execute("lsp-unavailable", {
      method: "textDocument/diagnostic",
      path: "probe.py",
    }, undefined, undefined, { cwd: root });
    assert.equal(unavailable.isError, true);
    assert.equal(unavailable.details.diagnosticsReturned, false);
    assert.equal(unavailable.details.diagnosticRefresh.outcome, "unavailable");
    assert.match(unavailable.content[0].text, /was unavailable; no diagnostics returned/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lsp code actions return stable ids and apply by id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-tool-actions-"));
  const filePath = path.join(root, "probe.py");
  const logPath = path.join(root, "lsp.jsonl");
  await writeFile(filePath, "import os\n", "utf8");

  const { tool, service, runtime } = createRegisteredTool(root, "actions-resolve-log-require-diagnostics", logPath);

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
    assert.match(listPayload.actions[0].id, /^we_[0-9a-z]{4}$/);
    assert.equal(listPayload.actions[0].applyable, true);
    assert.equal(listPayload.actions[0].requiresResolve, true);
    assert.equal(listPayload.actions[0].title, "py fix T100");
    assert.equal((await readJsonLog(logPath)).some((entry) => entry.method === "codeAction/resolve"), false);

    const applyResult = await tool.execute("lsp-2", {
      method: "workspaceEdit/apply",
      id: listPayload.actions[0].id,
    }, undefined, undefined, { cwd: root });

    const applyPayload = JSON.parse(applyResult.content[0].text);
    assert.equal(applyPayload.ok, true);
    assert.equal(applyPayload.method, "workspaceEdit/apply");
    assert.equal(applyPayload.kind, "codeAction");
    assert.equal(applyPayload.editCount, 1);
    assert.deepEqual(applyPayload.changedFiles, ["probe.py"]);
    assert.match(await readFile(filePath, "utf8"), /^# fixed by py\nimport os\n/);
    assert.equal(runtime.completedEdits.length, 1);
    assert.equal(runtime.completedEdits[0].toolName, "lsp");
    assert.deepEqual(runtime.completedEdits[0].touchedRanges.map((range) => [range.startLine, range.endLine]), [[1, 1]]);
    assert.match(applyResult.content[1].text, /touched diagnostics: 1 error/);
    assert.match(applyResult.content[1].text, /py\/T100/);
    assert.equal(applyResult.details.piCodeFeedback.edits[0].toolName, "lsp");
    const entries = await waitForJsonLog(logPath, (entries) => entries.some((entry) => entry.method === "codeAction/resolve"));
    assert.equal(entries.filter((entry) => entry.method === "codeAction/resolve").length, 1);

    const secondApply = await tool.execute("lsp-3", {
      method: "workspaceEdit/apply",
      id: listPayload.actions[0].id,
    }, undefined, undefined, { cwd: root });

    assert.equal(secondApply.isError, true);
    assert.match(secondApply.content[0].text, /Unknown WorkspaceEdit id/);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("lsp WorkspaceEdit application runs formatting before inline diagnostics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-tool-format-"));
  const filePath = path.join(root, "probe.py");
  await writeFile(filePath, "import os\n", "utf8");

  const formatService = {
    configure() {},
    getStatus() { return { recentRuns: [], commands: [] }; },
    async formatFile(target, content) {
      const finalContent = `${content}# formatted\n`;
      await writeFile(target, finalContent, "utf8");
      return {
        formatterName: "testfmt",
        changed: true,
        finalContent,
        errors: [],
        durationMs: 1,
      };
    },
  };
  const { tool, service, runtime } = createRegisteredTool(root, "actions-require-diagnostics", undefined, undefined, formatService);

  try {
    const preview = await tool.execute("lsp-1", {
      method: "textDocument/codeAction",
      path: "probe.py",
      line: 1,
      column: 1,
    }, undefined, undefined, { cwd: root });
    const id = JSON.parse(preview.content[0].text).actions[0].id;

    const applied = await tool.execute("lsp-2", {
      method: "workspaceEdit/apply",
      id,
    }, undefined, undefined, { cwd: root });

    assert.equal(await readFile(filePath, "utf8"), "# fixed by py\nimport os\n# formatted\n");
    assert.match(applied.content[1].text, /formatted: probe\.py with testfmt/);
    assert.match(applied.content[1].text, /touched diagnostics: 1 error/);
    assert.equal(runtime.completedEdits[0].formatter.changed, true);
    assert.equal(runtime.completedEdits[0].afterAgentContent, "# fixed by py\nimport os\n");
    assert.equal(runtime.completedEdits[0].afterContent, "# fixed by py\nimport os\n# formatted\n");
    const rendered = renderLspToolResult(applied, { expanded: false }, {
      fg: (_color, text) => text,
      bold: (text) => text,
    }, { args: { method: "workspaceEdit/apply" } }).render(500).join("\n");
    assert.match(rendered, /code-feedback:/);
    assert.match(rendered, /py\/T100/);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("lsp code action listing keeps top-level commands preview-only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-tool-command-actions-"));
  await writeFile(path.join(root, "probe.py"), "import os\n", "utf8");

  const { tool, service } = createRegisteredTool(root, "actions-resolve-command");

  try {
    const result = await tool.execute("lsp-1", {
      method: "textDocument/codeAction",
      path: "probe.py",
      line: 1,
      column: 1,
    }, undefined, undefined, { cwd: root });

    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.actions.length, 1);
    assert.equal(payload.actions[0].title, "py command T100");
    assert.equal(payload.actions[0].applyable, false);
    assert.equal(payload.actions[0].requiresResolve, undefined);
    assert.equal(payload.hint, undefined);
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
      method: "workspaceEdit/apply",
      id,
    }, undefined, undefined, { cwd: root });

    assert.equal(applyResult.isError, true);
    assert.match(applyResult.content[0].text, /stale: file state changed since textDocument\/codeAction: probe\.py/);
    assert.match(applyResult.content[0].text, /Call textDocument\/codeAction again/);
    assert.equal(await readFile(filePath, "utf8"), "changed\nimport os\n");

    const secondApply = await tool.execute("lsp-3", {
      method: "workspaceEdit/apply",
      id,
    }, undefined, undefined, { cwd: root });
    assert.equal(secondApply.isError, true);
    assert.match(secondApply.content[0].text, /Unknown WorkspaceEdit id/);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("lsp rename previews and applies through the shared WorkspaceEdit cache", async () => {
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
    }, undefined, undefined, { cwd: root });

    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.workspaceEdit.kind, "rename");
    assert.equal(payload.workspaceEdit.applyable, true);
    assert.equal(payload.workspaceEdit.editSummary, "2 text edits across 1 file");
    assert.match(payload.workspaceEdit.id, /^we_[0-9a-z]{4}$/);
    assert.equal(await readFile(filePath, "utf8"), "const oldName = 1;\noldName;\n");

    const applied = await tool.execute("lsp-2", {
      method: "workspaceEdit/apply",
      id: payload.workspaceEdit.id,
    }, undefined, undefined, { cwd: root });

    const appliedPayload = JSON.parse(applied.content[0].text);
    assert.equal(appliedPayload.ok, true);
    assert.equal(appliedPayload.kind, "rename");
    assert.equal(appliedPayload.editCount, 2);
    assert.deepEqual(appliedPayload.changedFiles, ["probe.py"]);
    assert.equal(await readFile(filePath, "utf8"), "const newName = 1;\nnewName;\n");
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("lsp rename WorkspaceEdit ids reject stale targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-tool-rename-stale-"));
  const filePath = path.join(root, "probe.py");
  await writeFile(filePath, "const oldName = 1;\noldName;\n", "utf8");
  const { tool, service } = createRegisteredTool(root, "diagnostics");

  try {
    const preview = await tool.execute("lsp-1", {
      method: "textDocument/rename",
      path: "probe.py",
      line: 1,
      column: 8,
      newName: "newName",
    }, undefined, undefined, { cwd: root });
    const id = JSON.parse(preview.content[0].text).workspaceEdit.id;

    await writeFile(filePath, "changed while preview was pending\n", "utf8");
    const applied = await tool.execute("lsp-2", {
      method: "workspaceEdit/apply",
      id,
    }, undefined, undefined, { cwd: root });

    assert.equal(applied.isError, true);
    assert.match(applied.content[0].text, /stale: file state changed since textDocument\/rename: probe\.py/);
    assert.equal(await readFile(filePath, "utf8"), "changed while preview was pending\n");
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("lsp file rename previews server edits and applies one safe transaction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-file-rename-"));
  const sourcePath = path.join(root, "source.py");
  const destinationPath = path.join(root, "renamed.py");
  const consumerPath = path.join(root, "consumer.py");
  const logPath = path.join(root, "lsp.jsonl");
  await writeFile(sourcePath, "value = 1\n", "utf8");
  await writeFile(consumerPath, "from source import value\n", "utf8");
  const { tool, service, runtime } = createRegisteredTool(root, "file-rename-log", logPath);

  try {
    const previewResult = await tool.execute("lsp-file-rename-preview", {
      method: "workspace/renameFile",
      path: "source.py",
      newPath: "renamed.py",
    }, undefined, undefined, { cwd: root });

    assert.equal(previewResult.isError, undefined);
    const previewPayload = JSON.parse(previewResult.content[0].text);
    assert.equal(previewPayload.workspaceEdit.kind, "fileRename");
    assert.equal(previewPayload.workspaceEdit.applyable, true);
    assert.equal(previewPayload.workspaceEdit.oldPath, "source.py");
    assert.equal(previewPayload.workspaceEdit.newPath, "renamed.py");
    assert.equal(previewPayload.workspaceEdit.editSummary, "2 text edits across 2 files");
    assert.match(previewPayload.workspaceEdit.id, /^we_[0-9a-z]{4}$/);
    assert.equal(await readFile(sourcePath, "utf8"), "value = 1\n");
    await assert.rejects(readFile(destinationPath, "utf8"), (error) => error?.code === "ENOENT");

    const previewLog = await waitForJsonLog(logPath, (entries) => entries.some((entry) => entry.method === "workspace/willRenameFiles"));
    assert.deepEqual(previewLog.find((entry) => entry.method === "workspace/willRenameFiles")?.params, {
      files: [{
        oldUri: pathToFileURL(sourcePath).href,
        newUri: pathToFileURL(destinationPath).href,
      }],
    });

    const applied = await tool.execute("lsp-file-rename-apply", {
      method: "workspaceEdit/apply",
      id: previewPayload.workspaceEdit.id,
    }, undefined, undefined, { cwd: root });

    assert.equal(applied.isError, undefined);
    const appliedPayload = JSON.parse(applied.content[0].text);
    assert.equal(appliedPayload.ok, true);
    assert.equal(appliedPayload.kind, "fileRename");
    assert.equal(appliedPayload.editCount, 2);
    assert.deepEqual(appliedPayload.changedFiles, ["consumer.py", "renamed.py"]);
    assert.deepEqual(appliedPayload.renamedFile, { oldPath: "source.py", newPath: "renamed.py" });
    assert.equal(await readFile(destinationPath, "utf8"), "# moved by py\nvalue = 1\n");
    assert.equal(await readFile(consumerPath, "utf8"), "from renamed import value\n");
    await assert.rejects(readFile(sourcePath, "utf8"), (error) => error?.code === "ENOENT");
    assert.equal(runtime.completedEdits.length, 2);
    assert.equal(runtime.completedEdits[0].filePath, destinationPath);
    assert.equal(runtime.completedEdits[0].originalPath, sourcePath);

    const appliedLog = await waitForJsonLog(logPath, (entries) => (
      entries.some((entry) => entry.method === "workspace/didRenameFiles") &&
      entries.some((entry) => entry.method === "workspace/didChangeWatchedFiles")
    ));
    const didRename = appliedLog.find((entry) => entry.method === "workspace/didRenameFiles");
    assert.deepEqual(didRename?.params?.files, [{
      oldUri: pathToFileURL(sourcePath).href,
      newUri: pathToFileURL(destinationPath).href,
    }]);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("lsp file rename safely supports an authoritative empty server edit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-file-rename-empty-"));
  const sourcePath = path.join(root, "source.py");
  const destinationPath = path.join(root, "renamed.py");
  await writeFile(sourcePath, "value = 1\n", "utf8");
  const { tool, service, runtime } = createRegisteredTool(root, "file-rename-no-edits");

  try {
    const preview = await tool.execute("lsp-file-rename-preview", {
      method: "workspace/renameFile",
      path: "source.py",
      newPath: "renamed.py",
    }, undefined, undefined, { cwd: root });
    const previewPayload = JSON.parse(preview.content[0].text);
    assert.equal(previewPayload.workspaceEdit.applyable, true);
    assert.equal(previewPayload.workspaceEdit.editSummary, "0 text edits across 0 files");

    const applied = await tool.execute("lsp-file-rename-apply", {
      method: "workspaceEdit/apply",
      id: previewPayload.workspaceEdit.id,
    }, undefined, undefined, { cwd: root });
    const payload = JSON.parse(applied.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.editCount, 0);
    assert.deepEqual(payload.changedFiles, ["renamed.py"]);
    assert.equal(await readFile(destinationPath, "utf8"), "value = 1\n");
    await assert.rejects(readFile(sourcePath, "utf8"), (error) => error?.code === "ENOENT");
    assert.deepEqual(runtime.completedEdits[0]?.touchedRanges.map((range) => ({
      path: range.filePath,
      lines: [range.startLine, range.endLine],
      source: range.source,
    })), [{ path: destinationPath, lines: [1, 1], source: "whole-file" }]);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("lsp file rename rejects unsupported servers and stale destinations without moving files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-file-rename-guard-"));
  const sourcePath = path.join(root, "source.py");
  const destinationPath = path.join(root, "renamed.py");
  await writeFile(sourcePath, "value = 1\n", "utf8");

  const unsupported = createRegisteredTool(root, "file-rename-unsupported");
  try {
    const result = await unsupported.tool.execute("lsp-file-rename-unsupported", {
      method: "workspace/renameFile",
      path: "source.py",
      newPath: "renamed.py",
    }, undefined, undefined, { cwd: root });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /does not support workspace\/willRenameFiles/);
    assert.equal(await readFile(sourcePath, "utf8"), "value = 1\n");
  } finally {
    await unsupported.service.shutdownAll();
  }

  const filterMiss = createRegisteredTool(root, "file-rename-filter-miss");
  try {
    const result = await filterMiss.tool.execute("lsp-file-rename-filter-miss", {
      method: "workspace/renameFile",
      path: "source.py",
      newPath: "renamed.py",
    }, undefined, undefined, { cwd: root });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /does not support workspace\/willRenameFiles/);
    assert.equal(await readFile(sourcePath, "utf8"), "value = 1\n");
  } finally {
    await filterMiss.service.shutdownAll();
  }

  const supported = createRegisteredTool(root, "file-rename-no-edits");
  try {
    const preview = await supported.tool.execute("lsp-file-rename-preview", {
      method: "workspace/renameFile",
      path: "source.py",
      newPath: "renamed.py",
    }, undefined, undefined, { cwd: root });
    const id = JSON.parse(preview.content[0].text).workspaceEdit.id;
    await writeFile(destinationPath, "occupied\n", "utf8");

    const applied = await supported.tool.execute("lsp-file-rename-apply", {
      method: "workspaceEdit/apply",
      id,
    }, undefined, undefined, { cwd: root });
    assert.equal(applied.isError, true);
    assert.match(applied.content[0].text, /stale: file state changed since workspace\/renameFile: renamed\.py/);
    assert.equal(await readFile(sourcePath, "utf8"), "value = 1\n");
    assert.equal(await readFile(destinationPath, "utf8"), "occupied\n");
  } finally {
    await supported.service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("lsp file rename rejects server resource operations and expired source sessions", async () => {
  const resourceRoot = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-file-rename-resource-"));
  const resourceSource = path.join(resourceRoot, "source.py");
  await writeFile(resourceSource, "value = 1\n", "utf8");
  const resource = createRegisteredTool(resourceRoot, "file-rename-resource-operation");

  try {
    const preview = await resource.tool.execute("lsp-file-rename-resource", {
      method: "workspace/renameFile",
      path: "source.py",
      newPath: "renamed.py",
    }, undefined, undefined, { cwd: resourceRoot });
    const previewPayload = JSON.parse(preview.content[0].text);
    assert.equal(previewPayload.workspaceEdit.applyable, false);
    assert.match(previewPayload.workspaceEdit.editSummary, /1 resource operation/);

    const applied = await resource.tool.execute("lsp-file-rename-resource-apply", {
      method: "workspaceEdit/apply",
      id: previewPayload.workspaceEdit.id,
    }, undefined, undefined, { cwd: resourceRoot });
    assert.equal(applied.isError, true);
    assert.match(applied.content[0].text, /is not safely applyable/);
    assert.equal(await readFile(resourceSource, "utf8"), "value = 1\n");
  } finally {
    await resource.service.shutdownAll();
    await rm(resourceRoot, { recursive: true, force: true });
  }

  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-file-rename-session-"));
  const sessionSource = path.join(sessionRoot, "source.py");
  await writeFile(sessionSource, "value = 1\n", "utf8");
  const session = createRegisteredTool(sessionRoot, "file-rename-no-edits");

  try {
    const preview = await session.tool.execute("lsp-file-rename-session", {
      method: "workspace/renameFile",
      path: "source.py",
      newPath: "renamed.py",
    }, undefined, undefined, { cwd: sessionRoot });
    const id = JSON.parse(preview.content[0].text).workspaceEdit.id;
    await session.service.restart();

    const applied = await session.tool.execute("lsp-file-rename-session-apply", {
      method: "workspaceEdit/apply",
      id,
    }, undefined, undefined, { cwd: sessionRoot });
    assert.equal(applied.isError, true);
    assert.match(applied.content[0].text, /source language-server session is no longer live/);
    assert.equal(await readFile(sessionSource, "utf8"), "value = 1\n");
  } finally {
    await session.service.shutdownAll();
    await rm(sessionRoot, { recursive: true, force: true });
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

test("lsp tool details are summarized under a bounded budget", () => {
  const result = limitLspToolDetails({
    ok: true,
    method: "textDocument/hover",
    blob: "x".repeat(100_000),
    result: {
      items: Array.from({ length: 1000 }, (_, index) => ({
        index,
        label: `item ${index}`,
        text: "y".repeat(1000),
      })),
    },
  });

  assert.equal(result.truncation?.truncated, true);
  assert.equal(result.details.ok, true);
  assert.equal(result.details.method, "textDocument/hover");
  assert.match(result.details.blob, /truncated string/);
  assert.ok(result.details.result.items.length < 1000);
  assert.equal(result.details.result.items.at(-1).__truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result.details), "utf8") <= LSP_TOOL_DETAILS_MAX_BYTES + 4096);
});

test("lsp tool details budget covers generated depth markers", () => {
  function nestedArrays(depth, breadth) {
    if (depth === 0) return [];
    return Array.from({ length: breadth }, () => nestedArrays(depth - 1, breadth));
  }

  const result = limitLspToolDetails(nestedArrays(8, 3));

  assert.equal(result.truncation?.truncated, true);
  assert.ok(result.truncation.omitted.depth > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(result.details), "utf8") <= LSP_TOOL_DETAILS_MAX_BYTES + 4096);
});

test("lsp tool details reads only capped object properties and catches getters", () => {
  const details = { ok: true };
  let throwingReads = 0;
  let skippedReads = 0;

  Object.defineProperty(details, "bad", {
    enumerable: true,
    get() {
      throwingReads += 1;
      throw new Error("boom");
    },
  });

  for (let index = 0; index < 78; index += 1) details[`safe${index}`] = index;
  for (let index = 0; index < 50; index += 1) {
    Object.defineProperty(details, `skipped${index}`, {
      enumerable: true,
      get() {
        skippedReads += 1;
        throw new Error("should not be read");
      },
    });
  }

  const result = limitLspToolDetails(details);

  assert.equal(throwingReads, 1);
  assert.equal(skippedReads, 0);
  assert.equal(result.details.bad, "[property read failed]");
  assert.ok(result.details.__truncated.omittedPropertiesAtLeast >= 1);
  assert.equal(result.truncation?.omitted.unsupported, 1);
});

test("lsp tool JSON rendering summarizes before stringifying", () => {
  let toJsonCalls = 0;
  const details = { ok: true, blob: "x".repeat(100_000) };
  Object.defineProperty(details, "toJSON", {
    enumerable: false,
    value() {
      toJsonCalls += 1;
      throw new Error("full stringify should not run");
    },
  });

  const result = formatLspToolJson(details);

  assert.equal(toJsonCalls, 0);
  assert.equal(result.truncation?.truncated, true);
  assert.match(result.text, /truncated string/);
  assert.match(result.text, /\.\.\. truncated/);
});

test("lsp tool details budget accounts for JSON string escaping", () => {
  const result = limitLspToolDetails({ blob: "\u0000".repeat(100_000) });

  assert.equal(result.truncation?.truncated, true);
  assert.match(result.details.blob, /truncated string/);
  assert.ok(Buffer.byteLength(JSON.stringify(result.details), "utf8") <= LSP_TOOL_DETAILS_MAX_BYTES + 4096);
});

test("lsp tool details serializes invalid dates safely", () => {
  const result = limitLspToolDetails({ when: new Date(NaN) });

  assert.equal(result.details.when, "[invalid date]");
  assert.equal(result.truncation, undefined);
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

test("explicit LSP operations reject oversized source files before starting a server", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-tool-source-limit-"));
  const filePath = path.join(root, "generated.py");
  await writeFile(filePath, Buffer.alloc(DEFAULT_LSP_SOURCE_FILE_MAX_BYTES + 1024 * 1024, 0x61));
  const { tool, service } = createRegisteredTool(root);

  const cases = [
    { method: "textDocument/diagnostic", path: "generated.py" },
    { method: "textDocument/hover", path: "generated.py", line: 1, column: 1 },
    { method: "textDocument/documentSymbol", path: "generated.py" },
    { method: "textDocument/codeAction", path: "generated.py", line: 1, column: 1 },
    { method: "textDocument/rename", path: "generated.py", line: 1, column: 1, newName: "renamed" },
  ];

  try {
    for (const input of cases) {
      const result = await tool.execute("lsp-source-limit", input, undefined, undefined, { cwd: root });
      assert.equal(result.isError, true, input.method);
      assert.match(result.content[0].text, /LSP source file is too large \(3\.0 MiB > 2\.0 MiB limit\): generated\.py/, input.method);
      assert.match(result.content[0].text, /hint: Use a smaller source file or exclude generated output/, input.method);
    }
    const clients = service.getStatus().clients;
    assert.equal(clients.length, 1);
    assert.ok(clients.every((client) => client.pid === undefined && client.state === "stopped"));
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
      { method: "textDocument/hover", path: "probe.py", line: 1, column: 1, symbol: "value" },
      { method: "textDocument/hover", path: "probe.py", line: 1, occurrence: 1 },
      { method: "textDocument/hover", path: "probe.py", line: 1, symbol: "value", occurrence: 0 },
    ];

    for (const input of cases) {
      const result = await tool.execute("lsp-invalid-position", input, undefined, undefined, { cwd: root });
      assert.equal(result.isError, true, JSON.stringify(input));
      assert.match(result.content[0].text, /requires 1-based line and column|accepts either column or symbol|requires symbol when occurrence|requires occurrence to be/, JSON.stringify(input));
      assert.match(result.content[0].text, /hint: Pass a 1-based line with either a 1-based column or exact symbol/, JSON.stringify(input));
    }

    const removedCharacterResult = await tool.execute("lsp-removed-character", {
      method: "textDocument/hover",
      path: "probe.py",
      line: 1,
      character: 1,
    }, undefined, undefined, { cwd: root });
    assert.equal(removedCharacterResult.isError, true);
    assert.match(removedCharacterResult.content[0].text, /requires 1-based line and column/);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("lsp position methods resolve exact symbols and explicit occurrences", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-tool-symbol-position-"));
  const logPath = path.join(root, "lsp.jsonl");
  await writeFile(path.join(root, "probe.py"), "targetLong target = target;\n", "utf8");
  const { tool, service } = createRegisteredTool(root, "position-log", logPath);
  const methods = [
    "textDocument/hover",
    "textDocument/definition",
    "textDocument/references",
    "textDocument/implementation",
    "textDocument/typeDefinition",
    "textDocument/codeAction",
    "textDocument/rename",
  ];

  try {
    for (const method of methods) {
      const result = await tool.execute(`lsp-symbol-${method}`, {
        method,
        path: "probe.py",
        line: 1,
        symbol: "target",
        occurrence: 2,
        ...(method === "textDocument/rename" ? { newName: "renamed" } : {}),
      }, undefined, undefined, { cwd: root });
      assert.equal(result.isError, undefined, method);
    }

    const entries = await waitForJsonLog(logPath, (items) => (
      methods.every((method) => items.some((entry) => entry.method === method))
    ));
    for (const method of methods) {
      const entry = entries.find((item) => item.method === method);
      assert.deepEqual(entry?.params?.position ?? entry?.params?.range?.start, {
        line: 0,
        character: 20,
      }, method);
    }

    const codeAction = entries.find((entry) => entry.method === "textDocument/codeAction");
    assert.deepEqual(codeAction?.params?.range?.end, { line: 0, character: 20 });

    const missing = await tool.execute("lsp-symbol-missing", {
      method: "textDocument/hover",
      path: "probe.py",
      line: 1,
      symbol: "Target",
    }, undefined, undefined, { cwd: root });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /cannot find exact symbol "Target" on line 1/);
    assert.match(missing.content[0].text, /hint: Check the exact case-sensitive symbol text/);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("lsp tool cancellation reaches the active language-server request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-tool-cancel-"));
  const filePath = path.join(root, "probe.py");
  const logPath = path.join(root, "lsp.jsonl");
  await writeFile(filePath, "value = 1\n", "utf8");
  const { tool, service } = createRegisteredTool(root, "hover-delay-500", logPath);

  try {
    await service.capabilities(filePath);
    const controller = new AbortController();
    const request = tool.execute("lsp-cancel", {
      method: "textDocument/hover",
      path: "probe.py",
      line: 1,
      column: 1,
    }, controller.signal, undefined, { cwd: root });

    setTimeout(() => controller.abort(), 20);
    await assert.rejects(request, (error) => error?.name === "AbortError");

    const entries = await waitForJsonLog(logPath, (items) => items.some((entry) => entry.method === "$/cancelRequest"));
    assert.deepEqual(entries.find((entry) => entry.method === "$/cancelRequest")?.params, { id: 2 });
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

test("lsp call renderer shows symbol occurrences without pretending they are columns", () => {
  const theme = {
    fg: (_color, text) => text,
    bold: (text) => text,
  };
  const rendered = renderLspToolCall({
    method: "textDocument/references",
    path: "probe.ts",
    line: 7,
    symbol: "target",
    occurrence: 2,
  }, theme).render(500).join("\n");

  assert.equal(rendered, "lsp textDocument/references probe.ts 7:\"target\"#2");
});

test("lsp call renderer shows file rename source and destination", () => {
  const theme = {
    fg: (_color, text) => text,
    bold: (text) => text,
  };
  const rendered = renderLspToolCall({
    method: "workspace/renameFile",
    path: "src/old.ts",
    newPath: "src/new.ts",
  }, theme).render(500).join("\n");

  assert.equal(rendered, "lsp workspace/renameFile src/old.ts → src/new.ts");
});

test("lsp collapsed expand hint uses the normal hint color", () => {
  const theme = {
    fg: (color, text) => `<${color}>${text}</${color}>`,
    bold: (text) => text,
  };
  const rendered = renderLspToolResult({
    content: [{ type: "text", text: "code-feedback / LSP status\n  lsp feedback: enabled\n  clients: none yet — starts lazily when you query a source file\n" }],
    details: { method: "server/status" },
  }, { expanded: false }, theme, { args: { method: "server/status" } })
    .render(500)
    .join("\n");

  assert.match(rendered, /<dim>… \(ctrl\+o to expand\)<\/dim>/);
  assert.doesNotMatch(rendered, /<accent>ctrl\+o<\/accent>/);
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

test("lsp custom rendering obeys terminal width for Unicode and ANSI text", () => {
  const theme = {
    fg: (color, text) => `\x1b[3${color === "toolOutput" ? "2" : "6"}m${text}\x1b[0m`,
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
  };
  const rendered = renderLspToolResult({
    content: [{ type: "text", text: "A👩‍💻漢字étail" }],
  }, { expanded: false }, theme, { args: { method: "textDocument/hover" } }).render(6);

  assert.equal(rendered.length, 1);
  assert.ok(visibleWidth(rendered[0]) <= 6, `rendered width was ${visibleWidth(rendered[0])}`);
  assert.equal(rendered[0].replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""), "A👩‍💻漢…");
});

test("lsp raw payload renderer does not masquerade as method-specific pretty output", () => {
  const theme = {
    fg: (color, text) => `<${color}>${text}</${color}>`,
    bold: (text) => text,
  };
  const text = JSON.stringify({ contents: { kind: "plaintext", value: "hover" }, range: { start: { line: 1 } } }, null, 2);
  const rendered = renderLspToolResult({
    content: [{ type: "text", text }],
    details: { ok: true, method: "textDocument/hover", raw: true },
  }, { expanded: false }, theme, { args: { method: "textDocument/hover", raw: true } })
    .render(500)
    .join("\n");

  assert.match(rendered, /<success>Raw LSP<\/success> <muted>textDocument\/hover · 2 fields<\/muted>/);
  assert.doesNotMatch(rendered, /^\{/m);
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

test("lsp tool server selects one matching language server", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-tool-server-"));
  await writeFile(path.join(root, "probe.py"), "value = 1\n", "utf8");
  const runtime = createRuntime(createDefaultConfig());
  setProjectRoot(runtime, root);
  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "ty", "T100", "1"],
      },
      "python-ruff": {
        command: process.execPath,
        args: [fakeServer, "ruff", "R100", "2"],
      },
    },
  });
  let tool;
  registerLspTool({
    registerTool(definition) { tool = definition; },
    registerCommand() {},
    on() {},
  }, runtime, service, inactiveFormatService, directMutationQueue);

  try {
    const result = await tool.execute("lsp-1", {
      method: "textDocument/hover",
      path: "probe.py",
      line: 1,
      column: 1,
      server: "python-ruff",
    }, undefined, undefined, { cwd: root });

    assert.equal(result.content[0].text, "ruff hover");
    assert.equal(result.details.server, "python-ruff");
    assert.deepEqual(service.getStatus().clients.map((client) => client.id), ["python-ruff"]);

    const missing = await tool.execute("lsp-2", {
      method: "textDocument/hover",
      path: "probe.py",
      line: 1,
      column: 1,
      server: "missing-server",
    }, undefined, undefined, { cwd: root });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Unknown language server "missing-server"/);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("lsp workspace diagnostics require an active path and return fresh-only scan results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-tool-workspace-"));
  await writeFile(path.join(root, "a.py"), "a = 1\n", "utf8");
  await writeFile(path.join(root, "b.py"), "b = 2\n", "utf8");
  const runtime = createRuntime(createDefaultConfig());
  setProjectRoot(runtime, root);
  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "ty", "T100", "1", "", "workspace-pull-diagnostics"],
      },
      "python-ruff": {
        command: process.execPath,
        args: [fakeServer, "ruff", "R100", "2", "", "workspace-pull-diagnostics"],
      },
    },
  });
  let tool;
  registerLspTool({
    registerTool(definition) { tool = definition; },
    registerCommand() {},
    on() {},
  }, runtime, service, inactiveFormatService, directMutationQueue);

  try {
    const active = await tool.execute("lsp-workspace-active", {
      method: "workspace/diagnostic",
      path: ".",
      limit: 1,
      server: "python-ruff",
    }, undefined, undefined, { cwd: root });

    assert.equal(active.isError, undefined);
    assert.match(active.content[0].text, /target: \./);
    assert.match(active.content[0].text, /known LSP diagnostics: 1/);
    assert.match(active.content[0].text, /scan: bounded\/incomplete/);
    assert.match(active.content[0].text, /files: 1 selected · 1 fresh · 0 timed out · 0 unavailable · 0 skipped/);
    assert.match(active.content[0].text, /protocol: 1 workspace pull · 1 workspace-covered · 0 document-pulled · 0 push-batched · 0 pull failures/);
    assert.equal(active.details.ok, true);
    assert.equal(active.details.method, "workspace/diagnostic");
    assert.equal(active.details.mode, "workspace");
    assert.equal(active.details.server, "python-ruff");
    assert.equal(active.details.freshDiagnosticsOnly, true);
    assert.equal(active.details.workspaceScan.selectedFiles, 1);
    assert.equal(active.details.workspaceScan.fileLimitReached, true);
    assert.equal(active.details.workspaceScan.workspacePullRequests, 1);
    assert.equal(active.details.workspaceScan.workspacePullFiles, 1);
    assert.equal(active.details.workspaceScan.documentPullFiles, 0);
    assert.equal(active.details.workspaceScan.pushBatchFiles, 0);
    assert.equal(active.details.workspaceScan.files[0].outcome, "fresh");
    assert.deepEqual(service.getStatus().clients.map((client) => client.id), ["python-ruff"]);

    const invalidLimit = await tool.execute("lsp-workspace-limit", {
      method: "workspace/diagnostic",
      path: ".",
      limit: 201,
    }, undefined, undefined, { cwd: root });
    assert.equal(invalidLimit.isError, true);
    assert.match(invalidLimit.content[0].text, /file limit must be at most 200/);
    assert.match(invalidLimit.content[0].text, /hint: Pass limit as an integer from 1 to 200/);

    const missingPath = await tool.execute("lsp-workspace-missing-path", {
      method: "workspace/diagnostic",
      server: "python-ruff",
    }, undefined, undefined, { cwd: root });
    assert.equal(missingPath.isError, true);
    assert.equal(missingPath.details.ok, false);
    assert.match(missingPath.content[0].text, /workspace\/diagnostic requires path for an active fresh scan/);
    assert.match(missingPath.content[0].text, /hint: Pass path="\."/);

    runtime.projectTrusted = false;
    const untrustedActive = await tool.execute("lsp-workspace-untrusted", {
      method: "workspace/diagnostic",
      path: ".",
    }, undefined, undefined, { cwd: root, isProjectTrusted: () => false });
    assert.equal(untrustedActive.isError, true);
    assert.match(untrustedActive.content[0].text, /Project is not trusted/);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForJsonLog(filePath, predicate) {
  let entries = [];
  for (let attempt = 0; attempt < 50; attempt += 1) {
    entries = await readJsonLog(filePath);
    if (predicate(entries)) return entries;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return entries;
}

async function readJsonLog(filePath) {
  try {
    return (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function createRegisteredTool(root, mode = "actions-require-diagnostics", logPath = undefined, mutationQueue = directMutationQueue, formatService = undefined) {
  const runtime = createRuntime(createDefaultConfig());
  setProjectRoot(runtime, root);
  runtime.config.autoFormat = formatService !== undefined;
  const serverOverrides = {
    python: {
      command: process.execPath,
      args: [fakeServer, "py", "T100", "1", "", mode, logPath].filter((value) => value !== undefined),
    },
    "python-ruff": { disabled: true },
  };

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides,
  });

  let tool;
  registerLspTool({
    registerTool(definition) {
      tool = definition;
    },
    registerCommand() {},
    on() {},
  }, runtime, service, formatService ?? inactiveFormatService, mutationQueue);

  assert.ok(tool);
  return { runtime, service, tool };
}
