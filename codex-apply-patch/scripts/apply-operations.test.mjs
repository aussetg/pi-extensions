import assert from "node:assert/strict";
import { existsSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyOperations } from "../src/apply.ts";

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "apply-patch-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("applyOperations creates empty files without requiring a preview", async (t) => {
  const cwd = await tempDir(t);

  const result = await applyOperations(
    [{ type: "create_file", path: "empty.txt", diff: "" }],
    cwd,
  );

  assert.equal(result.results[0].status, "completed");
  assert.equal(result.results[0].pierre, undefined);
  assert.equal(await readFile(join(cwd, "empty.txt"), "utf8"), "");
});

test("applyOperations supports move-only updates without requiring a preview", async (t) => {
  const cwd = await tempDir(t);
  await writeFile(join(cwd, "a.txt"), "same\n", "utf8");

  const result = await applyOperations(
    [{ type: "update_file", path: "a.txt", move_path: "b.txt", diff: "" }],
    cwd,
  );

  assert.equal(result.results[0].status, "completed");
  assert.equal(result.results[0].path, "b.txt");
  assert.equal(result.results[0].pierre, undefined);
  assert.equal(existsSync(join(cwd, "a.txt")), false);
  assert.equal(await readFile(join(cwd, "b.txt"), "utf8"), "same\n");
});

test("applyOperations does not commit any writes after a preflight failure", async (t) => {
  const cwd = await tempDir(t);

  const result = await applyOperations(
    [
      { type: "create_file", path: "created.txt", diff: "+created" },
      { type: "update_file", path: "missing.txt", diff: "@@\n-missing\n+found\n" },
    ],
    cwd,
  );

  assert.equal(result.results[0].status, "failed");
  assert.match(result.results[0].output ?? "", /Skipped because preflight failed/);
  assert.equal(result.results[1].status, "failed");
  assert.match(result.results[1].output ?? "", /File not found/);
  assert.equal(existsSync(join(cwd, "created.txt")), false);
});

test("applyOperations rolls back committed files after a commit failure", async (t) => {
  const cwd = await tempDir(t);

  const result = await applyOperations(
    [
      { type: "create_file", path: "a.txt", diff: "+a" },
      { type: "create_file", path: "b.txt", diff: "+b" },
    ],
    cwd,
    undefined,
    (message) => {
      if (message === "2/2 commit create_file b.txt") {
        mkdirSync(join(cwd, "b.txt"));
      }
    },
  );

  assert.equal(result.results[0].status, "failed");
  assert.match(result.results[0].output ?? "", /Rolled back/);
  assert.equal(result.results[1].status, "failed");
  assert.match(result.results[1].output ?? "", /Rolled back applied changes/);
  assert.equal(existsSync(join(cwd, "a.txt")), false);
});

test("applyOperations refuses to update symlinks", async (t) => {
  const cwd = await tempDir(t);
  await writeFile(join(cwd, "target.txt"), "old\n", "utf8");
  symlinkSync("target.txt", join(cwd, "link.txt"));

  const result = await applyOperations(
    [{ type: "update_file", path: "link.txt", diff: "@@\n-old\n+new\n" }],
    cwd,
  );

  assert.equal(result.results[0].status, "failed");
  assert.match(result.results[0].output ?? "", /Refusing to update symlink/);
  assert.equal(readlinkSync(join(cwd, "link.txt")), "target.txt");
  assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), "old\n");
});

test("applyOperations surfaces fuzzy matching warnings", async (t) => {
  const cwd = await tempDir(t);
  await writeFile(join(cwd, "fuzzy.txt"), "a  \nb\n", "utf8");

  const result = await applyOperations(
    [{ type: "update_file", path: "fuzzy.txt", diff: "@@\n a\n-b\n+B\n" }],
    cwd,
  );

  assert.equal(result.results[0].status, "completed");
  assert.equal(await readFile(join(cwd, "fuzzy.txt"), "utf8"), "a  \nB\n");
  assert.match(result.warnings.join("\n"), /trailing whitespace/);
});
