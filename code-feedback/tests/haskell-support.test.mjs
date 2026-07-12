import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { selectFormatter } from "../src/format/formatters.ts";
import { resolveLanguageServers } from "../src/lsp/servers.ts";

test("HLS is selected for Haskell source, literate source, boot, and Cabal files", () => {
  const root = path.join(os.tmpdir(), "pi-code-feedback-haskell-lsp");
  const overrides = { haskell: { command: process.execPath, args: [] } };

  const cases = [
    ["Main.hs", "haskell"],
    ["Main.lhs", "literate haskell"],
    ["Main.hs-boot", "haskell"],
    ["package.cabal", "cabal"],
  ];

  for (const [basename, languageId] of cases) {
    const filePath = path.join(root, basename);
    const servers = resolveLanguageServers(filePath, overrides, root);

    assert.equal(servers.length, 1);
    assert.equal(servers[0].available, true);
    assert.equal(servers[0].definition.id, "haskell");
    assert.equal(servers[0].definition.command, process.execPath);
    assert.deepEqual(servers[0].definition.args, []);
    assert.equal(servers[0].definition.languageId(filePath), languageId);
  }
});

test("Haskell formatters are selected by project formatter config", async () => {
  await withHaskellProject("fourmolu.yaml", async ({ root, filePath, configPath }) => {
    const selection = selectFormatter(filePath, root, {
      fourmolu: { command: process.execPath },
    });

    assert.equal(selection.kind, "selected");
    assert.equal(selection.formatter.id, "fourmolu");
    assert.equal(selection.formatter.command, process.execPath);
    assert.deepEqual(selection.formatter.args, ["--mode", "inplace", filePath]);
    assert.equal(selection.formatter.configPath, configPath);
  });

  await withHaskellProject(".ormolu", async ({ root, filePath, configPath }) => {
    const selection = selectFormatter(filePath, root, {
      ormolu: { command: process.execPath },
    });

    assert.equal(selection.kind, "selected");
    assert.equal(selection.formatter.id, "ormolu");
    assert.equal(selection.formatter.command, process.execPath);
    assert.deepEqual(selection.formatter.args, ["--mode", "inplace", filePath]);
    assert.equal(selection.formatter.configPath, configPath);
  });

  await withHaskellProject(".stylish-haskell.yaml", async ({ root, filePath, configPath }) => {
    const selection = selectFormatter(filePath, root, {
      "stylish-haskell": { command: process.execPath },
    });

    assert.equal(selection.kind, "selected");
    assert.equal(selection.formatter.id, "stylish-haskell");
    assert.equal(selection.formatter.command, process.execPath);
    assert.deepEqual(selection.formatter.args, ["--inplace", filePath]);
    assert.equal(selection.formatter.configPath, configPath);
  });
});

test("Literate Haskell is not auto-formatted by non-literate Haskell formatters", async () => {
  await withHaskellProject("fourmolu.yaml", async ({ root }) => {
    const filePath = path.join(root, "Main.lhs");
    await writeFile(filePath, "> module Main where\n> main = pure ()\n", "utf8");

    const selection = selectFormatter(filePath, root, {
      fourmolu: { command: process.execPath },
    });

    assert.deepEqual(selection, { kind: "none", reason: "no formatter for extension" });
  });
});

test("Haskell formatters can be forced without a project formatter config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-haskell-format-force-"));
  const filePath = path.join(root, "Main.hs");

  try {
    await writeFile(filePath, "main = pure ()\n", "utf8");

    const selection = selectFormatter(filePath, root, {
      ormolu: { enabled: true, command: process.execPath },
    });

    assert.equal(selection.kind, "selected");
    assert.equal(selection.formatter.id, "ormolu");
    assert.equal(selection.formatter.configPath, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function withHaskellProject(configName, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-haskell-format-"));
  const src = path.join(root, "src");
  const filePath = path.join(src, "Main.hs");
  const configPath = path.join(root, configName);

  try {
    await mkdir(src, { recursive: true });
    await writeFile(configPath, "", "utf8");
    await writeFile(filePath, "main = pure ()\n", "utf8");
    await run({ root, filePath, configPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
