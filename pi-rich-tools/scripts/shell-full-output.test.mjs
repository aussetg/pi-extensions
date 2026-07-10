import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  cleanShellFullOutputFilePath,
  contextShellText,
} from "../src/rich-tools/shell-full-output.ts";

const BTRFS_SUPER_MAGIC = 0x9123683e;

test("clean full output leaves already-clean files untouched", async () => {
  const dir = await mkdtemp(path.join("/tmp", "pi-rich-tools-clean-"));
  const outputPath = path.join(dir, "output.log");
  const content = Buffer.concat([
    Buffer.from("plain output\n".repeat(10_000)),
    Buffer.from([0xff]),
  ]);

  try {
    await writeFile(outputPath, content);
    const before = await stat(outputPath);
    const result = await cleanShellFullOutputFilePath(outputPath);
    const after = await stat(outputPath);

    assert.equal(result, "unchanged");
    assert.equal(after.ino, before.ino);
    assert.deepEqual(await readFile(outputPath), content);
    assert.deepEqual(await readdir(dir), ["output.log"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clean full output atomically rewrites dirty output without reflink support", async () => {
  const dir = await mkdtemp(path.join("/tmp", "pi-rich-tools-clean-"));
  const outputPath = path.join(dir, "output.log");
  const content = `${"plain prefix\n".repeat(10_000)}\u001b[31mred\u001b[0m\r\n`;

  try {
    await writeFile(outputPath, content);
    const result = await cleanShellFullOutputFilePath(outputPath);

    assert.equal(result, "rewrite");
    assert.equal(await readFile(outputPath, "utf8"), contextShellText(content));
    assert.deepEqual(await readdir(dir), ["output.log"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clean full output uses a Btrfs reflink for dirty output", async (t) => {
  const fs = await statfs(process.cwd());
  if (fs.type !== BTRFS_SUPER_MAGIC) {
    t.skip("working tree is not on Btrfs");
    return;
  }

  const dir = await mkdtemp(path.join(process.cwd(), ".shell-clean-test-"));
  const outputPath = path.join(dir, "output.log");
  const baselinePath = path.join(dir, "baseline.log");
  const prefix = `${"shared prefix 🚀\n".repeat(20_000)}`;
  const content = `${prefix}\u001b[32mgreen\u001b[0m\r\n`;

  try {
    await writeFile(outputPath, content);
    // Keep another reflink alive so the cleaned file's untouched prefix remains
    // observably shared rather than merely eligible for sharing.
    await copyFile(outputPath, baselinePath, constants.COPYFILE_FICLONE_FORCE);

    const result = await cleanShellFullOutputFilePath(outputPath);

    assert.equal(result, "reflink");
    assert.equal(await readFile(outputPath, "utf8"), `${prefix}green\n`);
    assert.equal(await readFile(baselinePath, "utf8"), content);
    assert.deepEqual((await readdir(dir)).sort(), ["baseline.log", "output.log"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
