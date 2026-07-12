import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  buildPierreCreatePayload,
  buildPierreDeletePayload,
  buildPierreUpdatePayload,
} from "../src/pierre/metadata.ts";
import {
  createStats,
  migrateJsonValue,
} from "./migrate-apply-patch-sessions.mjs";

const execFileAsync = promisify(execFile);

test("session migration converts legacy apply_patch diff and strips Pierre previews", () => {
  const record = {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "apply_patch",
      details: {
        stage: "done",
        fuzz: 0,
        results: [
          {
            type: "update_file",
            path: "src/example.ts",
            status: "completed",
            diff: " 1 old\n-2 before\n+2 after\n",
            firstChangedLine: 2,
            pierre: fakePierre("src/example.ts", "before", "after"),
          },
        ],
        previews: [
          {
            path: "src/example.ts",
            diff: " 1 old\n-2 before\n+2 after\n",
            pierre: fakePierre("src/example.ts", "before", "after"),
          },
        ],
      },
    },
  };
  const stats = createStats();

  assert.equal(migrateJsonValue(record, stats), true);

  const details = record.message.details;
  const result = details.results[0];
  assert.equal("previews" in details, false);
  assert.equal("pierre" in result, false);
  assert.equal("diff" in result, false);
  assert.equal(result.change.type, "update");
  assert.match(result.change.unifiedDiff, /@@ -1,2 \+1,2 @@/);
  assert.match(result.change.unifiedDiff, /-before/);
  assert.match(result.change.unifiedDiff, /\+after/);
  assert.equal(stats.changesAdded, 1);
  assert.equal(stats.previewsRemoved, 1);
  assert.equal(stats.resultPierreRemoved, 1);
  assert.equal(stats.resultDiffRemoved, 1);
});

test("session migration can recover create/delete content from old Pierre payloads", () => {
  const record = {
    details: {
      stage: "done",
      fuzz: 0,
      results: [
        {
          type: "create_file",
          path: "new.txt",
          status: "completed",
          pierre: fakePierre("new.txt", "", "hello"),
        },
        {
          type: "delete_file",
          path: "old.txt",
          status: "completed",
          pierre: fakePierre("old.txt", "bye", "", "deleted"),
        },
      ],
    },
  };

  assert.equal(migrateJsonValue(record, createStats()), true);
  assert.deepEqual(record.details.results[0].change, {
    type: "add",
    content: "hello\n",
  });
  assert.deepEqual(record.details.results[1].change, {
    type: "delete",
    content: "bye\n",
  });
});

test("session migration preserves real Pierre line terminators", () => {
  const add = buildPierreCreatePayload({
    path: "new.txt",
    newContent: "hello\nworld\n",
  });
  const addNoEof = buildPierreCreatePayload({
    path: "no-eof.txt",
    newContent: "hello",
  });
  const del = buildPierreDeletePayload({
    path: "old.txt",
    oldContent: "bye\nnow\n",
  });
  const update = buildPierreUpdatePayload({
    oldPath: "edit.txt",
    newPath: "edit.txt",
    oldContent: "one\ntwo\n",
    newContent: "one\nthree\n",
  });
  const record = {
    details: {
      stage: "done",
      fuzz: 0,
      results: [
        { type: "create_file", path: "new.txt", status: "completed", pierre: add },
        {
          type: "create_file",
          path: "no-eof.txt",
          status: "completed",
          pierre: addNoEof,
        },
        { type: "delete_file", path: "old.txt", status: "completed", pierre: del },
        {
          type: "update_file",
          path: "edit.txt",
          status: "completed",
          pierre: update,
        },
      ],
    },
  };

  assert.equal(migrateJsonValue(record, createStats()), true);
  assert.equal(record.details.results[0].change.content, "hello\nworld\n");
  assert.equal(record.details.results[1].change.content, "hello");
  assert.equal(record.details.results[2].change.content, "bye\nnow\n");
  assert.match(record.details.results[3].change.unifiedDiff, / one\n-two\n\+three\n/);
  assert.doesNotMatch(record.details.results[3].change.unifiedDiff, /two\n\n\+three/);
});

test("session migration does not persist oversized reconstructed changes", () => {
  const payload = fakePierre("huge.txt", "", `${"x".repeat(1_000_001)}\n`, "new");
  const record = {
    details: {
      stage: "done",
      fuzz: 0,
      results: [
        {
          type: "create_file",
          path: "huge.txt",
          status: "completed",
          pierre: payload,
        },
      ],
    },
  };

  assert.equal(migrateJsonValue(record, createStats()), true);
  assert.equal("change" in record.details.results[0], false);
  assert.equal("pierre" in record.details.results[0], false);
});

test("session migration consumes same-path previews in result order", () => {
  const record = {
    details: {
      stage: "done",
      fuzz: 0,
      results: [
        { type: "update_file", path: "same.txt", status: "completed" },
        { type: "update_file", path: "same.txt", status: "completed" },
      ],
      previews: [
        { path: "same.txt", diff: " 1 keep\n-2 first\n+2 one\n" },
        { path: "same.txt", diff: " 1 keep\n-2 second\n+2 two\n" },
      ],
    },
  };

  assert.equal(migrateJsonValue(record, createStats()), true);
  assert.match(record.details.results[0].change.unifiedDiff, /-first\n\+one/);
  assert.doesNotMatch(record.details.results[0].change.unifiedDiff, /second/);
  assert.match(record.details.results[1].change.unifiedDiff, /-second\n\+two/);
});

test("session migration does not overwrite existing backups", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-session-migrate-"));
  try {
    const script = fileURLToPath(new URL("./migrate-apply-patch-sessions.mjs", import.meta.url));
    const session = path.join(dir, "session.jsonl");
    const original = `${JSON.stringify({
      details: {
        stage: "done",
        fuzz: 0,
        results: [
          {
            type: "create_file",
            path: "new.txt",
            status: "completed",
            pierre: fakePierre("new.txt", "", "hello", "new"),
          },
        ],
      },
    })}\n`;
    await writeFile(session, original);
    await writeFile(`${session}.bak`, "sentinel");

    await execFileAsync(process.execPath, [script, "--write", session]);

    assert.equal(await readFile(`${session}.bak`, "utf8"), "sentinel");
    assert.equal(await readFile(`${session}.bak.1`, "utf8"), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function fakePierre(path, before, after, type = "change") {
  const deletionLines = before ? [before] : [];
  const additionLines = after ? [after] : [];
  return {
    path,
    metadata: {
      name: path,
      type,
      lang: "text",
      isPartial: true,
      deletionLines,
      additionLines,
      splitLineCount: Math.max(deletionLines.length, additionLines.length),
      unifiedLineCount: deletionLines.length + additionLines.length,
      hunks: [
        {
          collapsedBefore: 0,
          deletionStart: 1,
          deletionCount: deletionLines.length,
          deletionLines: deletionLines.length,
          deletionLineIndex: 0,
          additionStart: 1,
          additionCount: additionLines.length,
          additionLines: additionLines.length,
          additionLineIndex: 0,
          hunkContent: [
            {
              type: "change",
              deletions: deletionLines.length,
              deletionLineIndex: 0,
              additions: additionLines.length,
              additionLineIndex: 0,
            },
          ],
        },
      ],
    },
  };
}
