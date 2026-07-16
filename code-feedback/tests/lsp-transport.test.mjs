import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LspClient } from "../src/lsp/client.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeServer = path.join(here, "fixtures", "fake-lsp-server.mjs");

test("server requests receive safe results or method-not-found errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-server-requests-"));
  const logPath = path.join(root, "lsp.jsonl");
  const client = fakeClient(root, "server-requests-log", logPath);

  try {
    await client.start();
    const entries = await waitForJsonLog(
      logPath,
      (items) => items.filter((entry) => entry.method === "server/response").length === 4,
    );
    const responses = new Map(
      entries
        .filter((entry) => entry.method === "server/response")
        .map((entry) => [entry.id, entry]),
    );

    assert.deepEqual(responses.get("server-request-show-document")?.result, { success: false });
    assert.equal(responses.get("server-request-refresh")?.result, null);
    assert.deepEqual(responses.get("server-request-apply-edit")?.result, {
      applied: false,
      failureReason: "code-feedback does not let language servers apply edits directly",
    });
    assert.deepEqual(responses.get("server-request-unknown")?.error, {
      code: -32601,
      message: "Method not found: fake/unknownServerRequest",
    });
    assert.equal(client.getStatus().state, "ready");
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("server request ids do not collide with client request ids", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-request-id-collision-"));
  const logPath = path.join(root, "lsp.jsonl");
  const client = fakeClient(root, "request-id-collision", logPath);

  try {
    const hover = await client.request("textDocument/hover", {});
    assert.deepEqual(hover, { contents: { kind: "plaintext", value: "py hover" } });

    const entries = await waitForJsonLog(
      logPath,
      (items) => items.some((entry) => entry.method === "server/colliding-response"),
    );
    assert.deepEqual(entries.find((entry) => entry.method === "server/colliding-response"), {
      method: "server/colliding-response",
      id: 2,
      result: { success: false },
    });
    assert.equal(client.getStatus().state, "ready");
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("deterministic initialization failures are cooled down without relaunching", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-initialize-cooldown-"));
  const logPath = path.join(root, "processes.jsonl");
  const client = fakeClient(root, "initialize-error", logPath, {
    initializationFailureCooldownMs: 120,
  });

  try {
    await assert.rejects(client.start(), /initialize: fake deterministic initialization failure/);
    const firstEntries = await waitForJsonLog(logPath, (items) => items.length === 1);
    assert.equal(firstEntries.length, 1);
    const retryAt = client.getStatus().initializationRetryAt;
    assert.equal(typeof retryAt, "number");
    assert.ok(retryAt > Date.now());
    assert.equal(client.getStatus().startCount, 1);
    assert.equal(client.getStatus().restartCount, 0);
    assert.equal(client.getStatus().initializationCooldownCount, 1);

    await assert.rejects(client.start(), /LSP initialization is cooling down for python/);
    assert.equal((await readJsonLog(logPath)).length, 1);

    await client.shutdown();
    await assert.rejects(client.start(), /initialize: fake deterministic initialization failure/);
    const retriedEntries = await waitForJsonLog(logPath, (items) => items.length === 2);
    assert.equal(retriedEntries.length, 2);
    assert.equal(client.getStatus().startCount, 2);
    assert.equal(client.getStatus().restartCount, 1);
    assert.equal(client.getStatus().initializationCooldownCount, 2);
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling initialization does not enter failure cooldown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-initialize-abort-"));
  const logPath = path.join(root, "processes.jsonl");
  const client = fakeClient(root, "initialize-delay-once-500", logPath, {
    initializeTimeoutMs: 1_000,
    initializationFailureCooldownMs: 10_000,
  });

  try {
    const controller = new AbortController();
    const starting = client.start(controller.signal);
    await waitForJsonLog(logPath, (items) => items.length >= 1);
    controller.abort();
    await assert.rejects(starting, (error) => error?.name === "AbortError");
    assert.equal(client.getStatus().initializationRetryAt, undefined);

    await client.start();
    assert.equal(client.getStatus().state, "ready");
    assert.equal((await waitForJsonLog(logPath, (items) => items.length >= 2)).length, 2);
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling one coalesced initialization waiter does not cancel the others", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-initialize-coalesced-abort-"));
  const logPath = path.join(root, "processes.jsonl");
  const client = fakeClient(root, "initialize-delay-150", logPath, {
    initializeTimeoutMs: 1_000,
  });

  try {
    const controller = new AbortController();
    const first = client.start(controller.signal);
    const started = await waitForJsonLog(logPath, (items) => items.some((entry) => entry.method === "initialize/start"));
    assert.equal(started.some((entry) => entry.method === "initialize/start"), true);

    const second = client.start();
    controller.abort();

    await assert.rejects(first, (error) => error?.name === "AbortError");
    await second;
    assert.equal(client.getStatus().state, "ready");
    assert.equal(client.getStatus().startCount, 1);
    assert.equal(client.getStatus().restartCount, 0);
    assert.equal((await readJsonLog(logPath)).filter((entry) => entry.method === "process/start").length, 1);
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("aborting a queued request drops it without killing a healthy client", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-queued-abort-"));
  const logPath = path.join(root, "lsp.jsonl");
  const releasePath = `${logPath}.release`;
  const client = fakeClient(root, "stdin-gate", logPath, {
    writeTimeoutMs: 2_000,
    maxQueuedWriteBytes: 12 * 1024 * 1024,
  });

  try {
    await client.start();
    await waitForJsonLog(logPath, (items) => items.some((entry) => entry.method === "stdin/paused"));
    const pid = client.getStatus().pid;

    const blocking = client.request("fake/large", { text: "x".repeat(4 * 1024 * 1024) }, 3_000);
    const controller = new AbortController();
    const queued = client.request("fake/queued", {}, 3_000, controller.signal);
    controller.abort();

    await assert.rejects(queued, (error) => error?.name === "AbortError");
    assert.equal(client.getStatus().state, "ready");
    assert.equal(client.getStatus().pid, pid);

    await writeFile(releasePath, "", "utf8");
    assert.equal(await blocking, null);

    const entries = await waitForJsonLog(logPath, (items) => items.some((entry) => entry.method === "fake/large"));
    assert.equal(entries.some((entry) => entry.method === "fake/queued"), false);
    assert.equal(entries.some((entry) => entry.method === "$/cancelRequest" && entry.params?.id === 3), false);
    assert.equal(client.getStatus().state, "ready");
  } finally {
    await writeFile(releasePath, "", "utf8").catch(() => undefined);
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("the outbound byte budget rejects oversized messages without killing the client", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-outbound-budget-"));
  const logPath = path.join(root, "lsp.jsonl");
  const client = fakeClient(root, "diagnostics", logPath, { maxQueuedWriteBytes: 4_096 });

  try {
    await client.start();
    await assert.rejects(
      client.request("fake/oversized", { text: "x".repeat(8_192) }),
      /LSP outbound queue limit exceeded for python/,
    );
    assert.equal(client.getStatus().state, "ready");
    assert.equal(await client.request("fake/small", {}), null);
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("an in-flight write that exceeds its deadline fails and kills the wedged client", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-write-timeout-"));
  const logPath = path.join(root, "lsp.jsonl");
  const releasePath = `${logPath}.release`;
  const client = fakeClient(root, "stdin-gate", logPath, {
    writeTimeoutMs: 40,
    maxQueuedWriteBytes: 12 * 1024 * 1024,
  });

  try {
    await client.start();
    await waitForJsonLog(logPath, (items) => items.some((entry) => entry.method === "stdin/paused"));

    await assert.rejects(
      client.request("fake/wedged", { text: "x".repeat(4 * 1024 * 1024) }, 2_000),
      /LSP write timed out after 40ms: fake\/wedged/,
    );
    assert.equal(client.getStatus().state, "failed");
    assert.equal(client.getStatus().pid, undefined);
  } finally {
    await writeFile(releasePath, "", "utf8").catch(() => undefined);
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("a closed server stdin fails the active client instead of leaving pending requests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-stdin-error-"));
  const logPath = path.join(root, "lsp.jsonl");
  const client = fakeClient(root, "close-stdin", logPath, { writeTimeoutMs: 500 });

  try {
    await client.start();
    await waitForJsonLog(logPath, (items) => items.some((entry) => entry.method === "stdin/closed"));

    await assert.rejects(client.request("fake/after-close", {}, 1_000));
    assert.equal(client.getStatus().state, "failed");
    assert.equal(client.getStatus().pid, undefined);
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized inbound frames fail the client before buffering their declared body", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-inbound-budget-"));
  const logPath = path.join(root, "lsp.jsonl");
  const client = fakeClient(root, "oversized-inbound", logPath);

  try {
    await client.start();
    for (let attempt = 0; attempt < 50 && client.getStatus().state === "ready"; attempt += 1) {
      await sleep(10);
    }
    assert.equal(client.getStatus().state, "failed");
    assert.match(client.getStatus().lastError ?? "", /LSP message exceeds 16777216 bytes/);
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("non-object JSON-RPC frames fail only the client", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-inbound-shape-"));
  const logPath = path.join(root, "lsp.jsonl");
  const client = fakeClient(root, "non-object-inbound", logPath);

  try {
    await client.start();
    for (let attempt = 0; attempt < 50 && client.getStatus().state === "ready"; attempt += 1) {
      await sleep(10);
    }
    assert.equal(client.getStatus().state, "failed");
    assert.match(client.getStatus().lastError ?? "", /LSP message must be a JSON object/);
    assert.equal(client.getStatus().pid, undefined);
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

function fakeClient(root, mode, logPath, options = {}) {
  return new LspClient({
    id: "python",
    role: "language",
    command: process.execPath,
    args: [fakeServer, "py", "T100", "1", "", mode, logPath],
    extensions: [".py"],
    rootMarkers: [],
    languageId: () => "python",
  }, root, options);
}

async function waitForJsonLog(filePath, predicate) {
  let entries = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    entries = await readJsonLog(filePath);
    if (predicate(entries)) return entries;
    await sleep(10);
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
