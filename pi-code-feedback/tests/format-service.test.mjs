import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFormatService } from "../src/format/service.ts";

test("formatter selection notices a newly added higher-priority config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-format-selection-"));
  const filePath = path.join(root, "probe.ts");
  const prettierPath = path.join(root, "prettier");
  const biomePath = path.join(root, "biome");
  await writeFile(filePath, "source\n", "utf8");
  await writeFile(path.join(root, ".prettierrc"), "{}\n", "utf8");
  await writeFormatter(prettierPath, "prettier\n");
  await writeFormatter(biomePath, "biome\n");

  const service = createFormatService({
    projectRoot: root,
    formatterOverrides: {
      prettier: { command: prettierPath },
      biome: { command: biomePath },
    },
  });

  try {
    const first = await service.formatFile(filePath, "source\n");
    assert.equal(first.formatterName, "Prettier");
    assert.equal(first.finalContent, "prettier\n");

    await writeFile(filePath, "source\n", "utf8");
    await writeFile(path.join(root, "biome.json"), "{}\n", "utf8");
    const second = await service.formatFile(filePath, "source\n");
    assert.equal(second.formatterName, "Biome");
    assert.equal(second.finalContent, "biome\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("formatter selection notices when an unavailable command is installed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-format-command-"));
  const filePath = path.join(root, "probe.go");
  const formatterPath = path.join(root, "gofmt");
  await writeFile(filePath, "source\n", "utf8");
  const service = createFormatService({
    projectRoot: root,
    formatterOverrides: { gofmt: { command: formatterPath } },
  });

  try {
    const unavailable = await service.formatFile(filePath, "source\n");
    assert.match(unavailable.skippedReason ?? "", /command not found/);

    await writeFormatter(formatterPath, "formatted\n");
    const selected = await service.formatFile(filePath, "source\n");
    assert.equal(selected.formatterName, "gofmt");
    assert.equal(selected.finalContent, "formatted\n");
    assert.equal(await readFile(filePath, "utf8"), "formatted\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeFormatter(filePath, content) {
  await writeFile(filePath, `#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.writeFileSync(process.argv.at(-1), ${JSON.stringify(content)});\n`, "utf8");
  await chmod(filePath, 0o755);
}
