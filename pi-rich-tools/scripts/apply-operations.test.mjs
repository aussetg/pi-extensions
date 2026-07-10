import assert from "node:assert/strict";
import { existsSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";
import { applyOperations } from "../src/apply.ts";

const toolDependencyStub = new URL("./test-tool-dependencies.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-ai" || specifier === "typebox") {
      return { shortCircuit: true, url: toolDependencyStub };
    }
    return nextResolve(specifier, context);
  },
});

const { registerApplyPatchTool } = await import("../src/tool.ts");

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "apply-patch-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function applyPatchTool() {
  let registered;
  registerApplyPatchTool({
    registerTool(tool) {
      registered = tool;
    },
  });
  assert.ok(registered);
  return registered;
}

test("apply_patch throws when every operation fails", async (t) => {
  const cwd = await tempDir(t);
  const tool = applyPatchTool();

  await assert.rejects(
    tool.execute(
      "all-failed",
      {
        operations: [
          {
            type: "update_file",
            path: "missing.txt",
            diff: "@@\n-missing\n+found\n",
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    ),
    (error) => {
      assert.equal(error?.name, "DiffError");
      assert.match(error?.message ?? "", /^Patch was not applied:/);
      assert.match(error?.message ?? "", /✗ update missing\.txt/);
      assert.match(error?.message ?? "", /File not found/);
      return true;
    },
  );
});

test("apply_patch returns normally when an independent operation succeeds", async (t) => {
  const cwd = await tempDir(t);
  const tool = applyPatchTool();

  const result = await tool.execute(
    "partially-applied",
    {
      operations: [
        { type: "create_file", path: "created.txt", diff: "+created" },
        {
          type: "update_file",
          path: "missing.txt",
          diff: "@@\n-missing\n+found\n",
        },
      ],
    },
    undefined,
    undefined,
    { cwd },
  );

  assert.match(result.content[0].text, /^Patch partially applied:/);
  assert.equal(result.details.results[0].status, "completed");
  assert.equal(result.details.results[1].status, "failed");
  assert.equal(await readFile(join(cwd, "created.txt"), "utf8"), "created\n");
});

test("applyOperations creates empty files without requiring a preview", async (t) => {
  const cwd = await tempDir(t);

  const result = await applyOperations(
    [{ type: "create_file", path: "empty.txt", diff: "" }],
    cwd,
  );

  assert.equal(result.results[0].status, "completed");
  assert.deepEqual(result.results[0].change, { type: "add", content: "" });
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
  assert.equal(result.results[0].change.type, "update");
  assert.match(result.results[0].change.unifiedDiff, /--- a\.txt/);
  assert.match(result.results[0].change.unifiedDiff, /\+\+\+ b\.txt/);
  assert.equal(existsSync(join(cwd, "a.txt")), false);
  assert.equal(await readFile(join(cwd, "b.txt"), "utf8"), "same\n");
});

test("applyOperations commits independent writes after a preflight failure", async (t) => {
  const cwd = await tempDir(t);

  const result = await applyOperations(
    [
      { type: "create_file", path: "created.txt", diff: "+created" },
      { type: "update_file", path: "missing.txt", diff: "@@\n-missing\n+found\n" },
    ],
    cwd,
  );

  assert.equal(result.results[0].status, "completed");
  assert.equal(result.results[1].status, "failed");
  assert.match(result.results[1].output ?? "", /File not found/);
  assert.equal(await readFile(join(cwd, "created.txt"), "utf8"), "created\n");
});

test("applyOperations skips later operations on a path with a preflight failure", async (t) => {
  const cwd = await tempDir(t);
  await writeFile(join(cwd, "a.txt"), "old\n", "utf8");
  await writeFile(join(cwd, "b.txt"), "old\n", "utf8");

  const result = await applyOperations(
    [
      { type: "update_file", path: "a.txt", diff: "@@\n-missing\n+new\n" },
      { type: "update_file", path: "a.txt", diff: "@@\n-old\n+new\n" },
      { type: "update_file", path: "b.txt", diff: "@@\n-old\n+new\n" },
    ],
    cwd,
  );

  assert.equal(result.results[0].status, "failed");
  assert.match(result.results[0].output ?? "", /Invalid Context|missing/);
  assert.equal(result.results[1].status, "failed");
  assert.match(result.results[1].output ?? "", /same path failed preflight/);
  assert.equal(result.results[2].status, "completed");
  assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "old\n");
  assert.equal(await readFile(join(cwd, "b.txt"), "utf8"), "new\n");
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

test("applyOperations surfaces a trailing patch end marker in update diffs", async (t) => {
  const cwd = await tempDir(t);
  await writeFile(join(cwd, "marker.txt"), "old\n", "utf8");

  const result = await applyOperations(
    [
      {
        type: "update_file",
        path: "marker.txt",
        diff: "@@\n-old\n+new\n*** End Patch\n",
      },
    ],
    cwd,
  );

  assert.equal(result.results[0].status, "completed");
  assert.equal(await readFile(join(cwd, "marker.txt"), "utf8"), "new\n");
  assert.match(result.warnings.join("\n"), /\*\*\* End Patch/);
});
