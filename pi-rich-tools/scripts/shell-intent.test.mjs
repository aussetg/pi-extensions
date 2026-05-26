import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseShellCommand } from "../src/shell-intent.ts";

test("classifies simple file listing commands", () => {
  assert.deepEqual(parseShellCommand("ls"), [
    { type: "list_files", cmd: "ls" },
  ]);
  assert.deepEqual(parseShellCommand("rg --files | head -n 50"), [
    { type: "list_files", cmd: "rg --files" },
  ]);
});

test("classifies file reads", () => {
  assert.deepEqual(parseShellCommand("sed -n '1,40p' README.md"), [
    { type: "read", cmd: "sed -n 1,40p README.md", name: "README.md", path: "README.md" },
  ]);
  assert.deepEqual(parseShellCommand("sed -n -e '1,40p' README.md"), [
    { type: "read", cmd: "sed -n -e 1,40p README.md", name: "README.md", path: "README.md" },
  ]);
  assert.deepEqual(parseShellCommand("sed -n '/function foo/,+20p' src/file.ts"), [
    { type: "read", cmd: "sed -n '/function foo/,+20p' src/file.ts", name: "file.ts", path: "src/file.ts" },
  ]);
  assert.deepEqual(parseShellCommand("cat -- ./-strange-file-name"), [
    { type: "read", cmd: "cat -- ./-strange-file-name", name: "-strange-file-name", path: "./-strange-file-name" },
  ]);
  assert.deepEqual(parseShellCommand("nl -ba README.md"), [
    { type: "read", cmd: "nl -ba README.md", name: "README.md", path: "README.md" },
  ]);
  assert.deepEqual(parseShellCommand("awk '{print}' README.md"), [
    { type: "read", cmd: "awk '{print}' README.md", name: "README.md", path: "README.md" },
  ]);
});

test("classifies searches while dropping tiny pipeline formatters", () => {
  assert.deepEqual(parseShellCommand('rg -n "foo bar" src | head -n 20'), [
    { type: "search", cmd: "rg -n 'foo bar' src", query: "foo bar", path: "src" },
  ]);
  assert.deepEqual(parseShellCommand('rg -n "foo bar" packages/coding-agent/src | head -n 20'), [
    { type: "search", cmd: "rg -n 'foo bar' packages/coding-agent/src", query: "foo bar", path: "packages/coding-agent/src" },
  ]);
  assert.deepEqual(parseShellCommand("rg foo | tee"), [
    { type: "search", cmd: "rg foo", query: "foo" },
  ]);
  assert.deepEqual(parseShellCommand("rg foo src | sed -n '1,20p'"), [
    { type: "search", cmd: "rg foo src", query: "foo", path: "src" },
  ]);
  assert.deepEqual(parseShellCommand("git grep TODO src"), [
    { type: "search", cmd: "git grep TODO src", query: "TODO", path: "src" },
  ]);
  assert.deepEqual(parseShellCommand("find -name foo"), [
    { type: "search", cmd: "find -name foo", query: "foo" },
  ]);
  assert.deepEqual(parseShellCommand("find src -name foo"), [
    { type: "search", cmd: "find src -name foo", query: "foo", path: "src" },
  ]);
});

test("search summaries use shell argv semantics for double quoted backslashes", () => {
  const doubleQuoted = parseShellCommand(String.raw`rg -n "join\(\"\\n\"\)" src`);
  assert.equal(doubleQuoted[0]?.type, "search");
  assert.equal(doubleQuoted[0].query, String.raw`join\("\n"\)`);

  const singleQuoted = parseShellCommand(String.raw`rg -n 'join\("\\n"\)' src`);
  assert.equal(singleQuoted[0]?.type, "search");
  assert.equal(singleQuoted[0].query, String.raw`join\("\\n"\)`);
});

test("keeps unknown shell commands conservative", () => {
  assert.deepEqual(parseShellCommand("git status --short"), [
    { type: "unknown", cmd: "git status --short" },
  ]);
  assert.deepEqual(parseShellCommand("date && rg --files"), [
    { type: "unknown", cmd: "date && rg --files" },
  ]);
  assert.deepEqual(parseShellCommand("echo foo > bar"), [
    { type: "unknown", cmd: "echo foo > bar" },
  ]);
  assert.deepEqual(parseShellCommand("sed -n '1,20p'"), [
    { type: "unknown", cmd: "sed -n '1,20p'" },
  ]);
  assert.deepEqual(parseShellCommand("sed -n '1,20p' one.txt two.txt"), [
    { type: "unknown", cmd: "sed -n '1,20p' one.txt two.txt" },
  ]);
  assert.deepEqual(parseShellCommand("sed -n '1,20p' nl -ba README.md"), [
    { type: "unknown", cmd: "sed -n '1,20p' nl -ba README.md" },
  ]);
  assert.deepEqual(parseShellCommand("nl nl -ba README.md"), [
    { type: "unknown", cmd: "nl nl -ba README.md" },
  ]);
  assert.deepEqual(parseShellCommand("rg --files | xargs rm -f"), [
    { type: "unknown", cmd: "rg --files | xargs rm -f" },
  ]);
  assert.deepEqual(parseShellCommand("rg foo | tee hits.txt"), [
    { type: "unknown", cmd: "rg foo | tee hits.txt" },
  ]);
  assert.deepEqual(parseShellCommand("find . -delete"), [
    { type: "unknown", cmd: "find . -delete" },
  ]);
  assert.deepEqual(parseShellCommand("find . -exec rm {} +"), [
    { type: "unknown", cmd: "find . -exec rm {} +" },
  ]);
  assert.deepEqual(parseShellCommand("find . -execdir rm {} +"), [
    { type: "unknown", cmd: "find . -execdir rm {} +" },
  ]);
  assert.deepEqual(parseShellCommand("find . -ok rm {} +"), [
    { type: "unknown", cmd: "find . -ok rm {} +" },
  ]);
  assert.deepEqual(parseShellCommand("fd foo -x rm {}"), [
    { type: "unknown", cmd: "fd foo -x rm {}" },
  ]);
  assert.deepEqual(parseShellCommand("fd foo -X rm {}"), [
    { type: "unknown", cmd: "fd foo -X rm {}" },
  ]);
  assert.deepEqual(parseShellCommand("fd foo --exec rm {}"), [
    { type: "unknown", cmd: "fd foo --exec rm {}" },
  ]);
  assert.deepEqual(parseShellCommand('awk \'BEGIN{system("touch /tmp/x")}{print}\' README.md'), [
    { type: "unknown", cmd: 'awk \'BEGIN{system("touch /tmp/x")}{print}\' README.md' },
  ]);
  assert.deepEqual(parseShellCommand('rg foo | awk \'BEGIN{system("touch /tmp/x")}{print}\''), [
    { type: "unknown", cmd: 'rg foo | awk \'BEGIN{system("touch /tmp/x")}{print}\'' },
  ]);
  assert.deepEqual(parseShellCommand("python -c 'import os; print(os.walk(\".\")); os.remove(\"x\")'"), [
    { type: "unknown", cmd: "python -c 'import os; print(os.walk(\".\")); os.remove(\"x\")'" },
  ]);
});

test("fallback tokenizer treats physical lines as command separators", () => {
  const command = [
    "sed -n '1,20p' README.md",
    "sed -n '20,40p' src/shell-intent.ts",
  ].join("\n");
  const script = `
    import assert from "node:assert/strict";
    import { parseShellCommand } from "./src/shell-intent.ts";
    assert.deepEqual(parseShellCommand(${JSON.stringify(command)}), ${JSON.stringify([
      { type: "read", cmd: "sed -n 1,20p README.md", name: "README.md", path: "README.md" },
      { type: "read", cmd: "sed -n 20,40p src/shell-intent.ts", name: "shell-intent.ts", path: "src/shell-intent.ts" },
    ])});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, PI_RICH_TOOLS_SHELL_INTENT_FALLBACK: "1" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

