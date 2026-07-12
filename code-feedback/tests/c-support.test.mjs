import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { selectFormatter } from "../src/format/formatters.ts";
import { resolveLanguageServers } from "../src/lsp/servers.ts";

test("clangd is selected for C sources and headers", () => {
  const root = path.join(os.tmpdir(), "pi-code-feedback-c-lsp");
  const overrides = { clangd: { command: process.execPath, args: [] } };

  const cFile = path.join(root, "probe.c");
  const header = path.join(root, "probe.h");
  const cppFile = path.join(root, "probe.cpp");

  const servers = resolveLanguageServers(cFile, overrides, root);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].available, true);
  assert.equal(servers[0].definition.id, "clangd");
  assert.equal(servers[0].definition.command, process.execPath);
  assert.equal(servers[0].definition.languageId(cFile), "c");

  assert.equal(resolveLanguageServers(header, overrides, root)[0].definition.languageId(header), "c");
  assert.equal(resolveLanguageServers(cppFile, overrides, root)[0].definition.languageId(cppFile), "cpp");
});

test("clang-format is selected for C files with clang-format config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-c-format-"));
  const configPath = path.join(root, ".clang-format");
  const filePath = path.join(root, "probe.c");

  try {
    await writeFile(configPath, "BasedOnStyle: LLVM\n", "utf8");
    await writeFile(filePath, "int main(){return 0;}\n", "utf8");

    const selection = selectFormatter(filePath, root, {
      "clang-format": { command: process.execPath },
    });

    assert.equal(selection.kind, "selected");
    assert.equal(selection.formatter.id, "clang-format");
    assert.equal(selection.formatter.command, process.execPath);
    assert.deepEqual(selection.formatter.args, ["-i", filePath]);
    assert.equal(selection.formatter.configPath, configPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
