import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { createLspService } from "../src/lsp/service.ts";
import { resolveLanguageServers } from "../src/lsp/servers.ts";
import { LSP_RESULT_SERVER_ID_KEY } from "../src/types.ts";
import { readJsonLines } from "./helpers/json-lines.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeServer = path.join(here, "fixtures", "fake-lsp-server.mjs");

test("language-server roots use the nearest configured marker inside the trusted boundary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-root-resolution-"));
  const projectRoot = path.join(root, "project");
  const nestedRoot = path.join(projectRoot, "apps", "web");
  const sourceRoot = path.join(nestedRoot, "src");
  const filePath = path.join(sourceRoot, "main.ts");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "package.json"), "{}\n", "utf8");
  await writeFile(path.join(nestedRoot, "tsconfig.json"), "{}\n", "utf8");
  await writeFile(filePath, "export const value = 1;\n", "utf8");

  try {
    const [typescript] = resolveLanguageServers(filePath, {
      projectRoot,
      server: "typescript",
      serverOverrides: { typescript: { command: process.execPath, args: [fakeServer] } },
    });
    assert.equal(typescript.root, nestedRoot);
    assert.equal(typescript.definition.role, "language");

    const outsideMarkerRoot = path.join(root, "outside-boundary");
    const isolatedProject = path.join(outsideMarkerRoot, "project");
    const isolatedFile = path.join(isolatedProject, "src", "main.ts");
    await mkdir(path.dirname(isolatedFile), { recursive: true });
    await writeFile(path.join(outsideMarkerRoot, "package.json"), "{}\n", "utf8");
    await writeFile(isolatedFile, "export {};\n", "utf8");
    const [isolated] = resolveLanguageServers(isolatedFile, {
      projectRoot: isolatedProject,
      server: "typescript",
      serverOverrides: { typescript: { command: process.execPath, args: [fakeServer] } },
    });
    assert.equal(isolated.root, isolatedProject);

    const customMarker = path.join(projectRoot, "apps", "custom.root");
    const customFile = path.join(projectRoot, "apps", "nested", "main.foo");
    await mkdir(path.dirname(customFile), { recursive: true });
    await writeFile(customMarker, "", "utf8");
    await writeFile(customFile, "value\n", "utf8");
    const [custom] = resolveLanguageServers(customFile, {
      projectRoot,
      server: "custom",
      serverConfiguration: {
        custom: {
          command: [process.execPath, fakeServer],
          extensions: [".foo"],
          rootMarkers: ["custom.root"],
          role: "linter",
        },
      },
    });
    assert.equal(custom.root, path.join(projectRoot, "apps"));
    assert.equal(custom.definition.role, "linter");

    await writeFile(path.join(projectRoot, "outer.root"), "", "utf8");
    await writeFile(path.join(projectRoot, "apps", "inner.root"), "", "utf8");
    const perRouteRoots = resolveLanguageServers(customFile, {
      projectRoot,
      serverConfiguration: {
        outer: {
          command: [process.execPath, fakeServer],
          extensions: [".foo"],
          rootMarkers: ["outer.root"],
        },
        inner: {
          command: [process.execPath, fakeServer],
          extensions: [".foo"],
          rootMarkers: ["inner.root"],
        },
      },
    });
    assert.deepEqual(Object.fromEntries(perRouteRoots.map((route) => [route.definition.id, route.root])), {
      outer: projectRoot,
      inner: path.join(projectRoot, "apps"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one server id starts independent clients for nested workspace roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-nested-clients-"));
  const frontendRoot = path.join(root, "frontend");
  const backendRoot = path.join(root, "backend");
  const frontendFile = path.join(frontendRoot, "src", "main.ts");
  const backendFile = path.join(backendRoot, "src", "main.ts");
  const logPath = path.join(root, "lsp.jsonl");
  await mkdir(path.dirname(frontendFile), { recursive: true });
  await mkdir(path.dirname(backendFile), { recursive: true });
  await writeFile(path.join(frontendRoot, "package.json"), "{}\n", "utf8");
  await writeFile(path.join(backendRoot, "package.json"), "{}\n", "utf8");
  await writeFile(frontendFile, "export const frontend = 1;\n", "utf8");
  await writeFile(backendFile, "export const backend = 1;\n", "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      typescript: {
        command: process.execPath,
        args: [fakeServer, "ts", "T100", "1", "", "workspace-files-log", logPath],
      },
    },
  });

  try {
    for (const filePath of [frontendFile, backendFile]) {
      const refresh = await service.diagnosticsForFileDetailed(filePath, await readFile(filePath, "utf8"), {
        timeoutMs: 1000,
        settleMs: 0,
      });
      assert.equal(refresh?.fresh, true);
    }

    const clients = service.getStatus().clients;
    assert.equal(clients.length, 2);
    assert.deepEqual(clients.map((client) => client.id), ["typescript", "typescript"]);
    assert.deepEqual(clients.map((client) => client.role), ["language", "language"]);
    assert.deepEqual(clients.map((client) => client.root).sort(), [backendRoot, frontendRoot].sort());

    const entries = await waitForJsonLog(logPath, (items) => items.filter((entry) => entry.method === "initialize").length === 2);
    const initializedRoots = entries
      .filter((entry) => entry.method === "initialize")
      .map((entry) => entry.params?.rootUri)
      .sort();
    assert.deepEqual(initializedRoots, [pathToFileURL(backendRoot).href, pathToFileURL(frontendRoot).href].sort());
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("tracked root-marker mutations invalidate routing and move open documents to the new root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-root-mutation-"));
  const nestedRoot = path.join(root, "nested");
  const filePath = path.join(nestedRoot, "src", "main.ts");
  const markerPath = path.join(nestedRoot, "package.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "export const value = 1;\n", "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      typescript: {
        command: process.execPath,
        args: [fakeServer, "ts", "T100", "1"],
      },
    },
  });

  try {
    const content = await readFile(filePath, "utf8");
    assert.equal((await service.diagnosticsForFileDetailed(filePath, content, { timeoutMs: 1000, settleMs: 0 }))?.fresh, true);
    assert.equal(service.getStatus().clients[0]?.root, root);

    await writeFile(markerPath, "{}\n", "utf8");
    service.notifyFileMutations([{ type: "created", filePath: markerPath }]);
    assert.equal((await service.diagnosticsForFileDetailed(filePath, content, { timeoutMs: 1000, settleMs: 0 }))?.fresh, true);

    const clients = service.getStatus().clients;
    assert.deepEqual(clients.map((client) => client.root).sort(), [nestedRoot, root].sort());
    assert.equal(clients.find((client) => client.root === root)?.openDocuments, 0);
    assert.equal(clients.find((client) => client.root === nestedRoot)?.openDocuments, 1);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic semantic requests exclude linters while diagnostics and explicit selection retain them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-server-roles-"));
  const filePath = path.join(root, "probe.py");
  const languageLog = path.join(root, "language.jsonl");
  const linterLog = path.join(root, "linter.jsonl");
  const content = "value = 1\n";
  await writeFile(filePath, content, "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "language", "T100", "1", "", "position-log", languageLog],
      },
      "python-ruff": {
        command: process.execPath,
        args: [fakeServer, "linter", "R100", "2", "", "position-log", linterLog],
      },
    },
  });

  try {
    const hover = await service.hover(filePath, { line: 1, column: 1 });
    assert.equal(hover?.contents?.value, "language hover");
    assert.deepEqual(service.getStatus().clients.map((client) => client.id), ["python"]);

    const refresh = await service.diagnosticsForFileDetailed(filePath, content, {
      timeoutMs: 1000,
      settleMs: 0,
    });
    assert.equal(refresh?.fresh, true);
    assert.deepEqual(
      [...refresh.snapshot.byUri.values()].flat().map((diagnostic) => diagnostic.source).sort(),
      ["language", "linter"],
    );

    const actions = await service.codeActions(filePath, { line: 1, column: 1 });
    assert.deepEqual(actions.map((action) => action[LSP_RESULT_SERVER_ID_KEY]).sort(), ["python", "python-ruff"]);

    const rename = await service.rename(filePath, { line: 1, column: 1 }, "renamed");
    assert.equal(rename[LSP_RESULT_SERVER_ID_KEY], "python");

    const explicitLinterHover = await service.hover(filePath, { line: 1, column: 1 }, undefined, "python-ruff");
    assert.equal(explicitLinterHover?.contents?.value, "linter hover");

    const languageEntries = await waitForJsonLog(languageLog, (items) => items.some((entry) => entry.method === "textDocument/rename"));
    const linterEntries = await waitForJsonLog(linterLog, (items) => items.some((entry) => entry.method === "textDocument/hover"));
    assert.equal(languageEntries.filter((entry) => entry.method === "textDocument/hover").length, 1);
    assert.equal(languageEntries.filter((entry) => entry.method === "textDocument/rename").length, 1);
    assert.equal(linterEntries.filter((entry) => entry.method === "textDocument/hover").length, 1);
    assert.equal(linterEntries.filter((entry) => entry.method === "textDocument/rename").length, 0);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("rename still requires explicit selection when multiple language-role servers match", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-language-role-ambiguity-"));
  const filePath = path.join(root, "probe.foo");
  const newFilePath = path.join(root, "renamed.foo");
  await writeFile(filePath, "value\nvalue\n", "utf8");
  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverConfiguration: {
      servers: {
        first: {
          command: [process.execPath, fakeServer, "first", "F100", "1", "", "file-rename-no-edits"],
          extensions: [".foo"],
          role: "language",
        },
        second: {
          command: [process.execPath, fakeServer, "second", "S100", "1", "", "file-rename-no-edits"],
          extensions: [".foo"],
          role: "language",
        },
      },
      status: { sources: [], configuredServerIds: ["first", "second"], errors: [] },
    },
  });

  try {
    await assert.rejects(
      service.rename(filePath, { line: 1, column: 1 }, "renamed"),
      /Multiple language servers support .* Pass server to select one/,
    );
    await assert.rejects(
      service.prepareFileRename(filePath, newFilePath),
      /Multiple language servers support .* Pass server to select one/,
    );
    const selected = await service.prepareFileRename(filePath, newFilePath, undefined, "first");
    assert.equal(selected[LSP_RESULT_SERVER_ID_KEY], "first");
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForJsonLog(logPath, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await readJsonLines(logPath);
    if (predicate(entries)) return entries;
    await sleep(10);
  }
  const entries = await readJsonLines(logPath);
  assert.fail(`timed out waiting for fake LSP log (${entries.length} entries)`);
}
