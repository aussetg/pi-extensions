import assert from "node:assert/strict";
import { test } from "node:test";
import { registerLspCommand } from "../src/commands/lsp.ts";
import { createDefaultConfig, registerFlags, resolveConfig } from "../src/config.ts";
import { handleContext } from "../src/events/context.ts";
import { createRuntime } from "../src/runtime.ts";

test("delayed context injection is enabled by default and has a CLI opt-out", () => {
  const flags = new Map();
  registerFlags({
    registerFlag(name, definition) {
      flags.set(name, definition);
    },
  });

  assert.equal(createDefaultConfig().contextInjection, true);
  assert.match(flags.get("code-feedback-no-context").description, /delayed LSP diagnostics/);

  const config = resolveConfig({
    getFlag(name) {
      return name === "code-feedback-no-context";
    },
  });
  assert.equal(config.contextInjection, false);
  assert.equal(config.lsp.enabled, true);
  assert.equal(config.autoFormat, true);
});

test("/lsp context controls injection without consuming queued feedback while disabled", async () => {
  const runtime = createRuntime(createDefaultConfig());
  runtime.delayedFeedback.push({
    id: "delayed:edit-1",
    editId: "edit-1",
    filePath: "/tmp/probe.ts",
    turnIndex: 1,
    writeIndex: 1,
    queuedAt: Date.now(),
    text: "code-feedback delayed LSP diagnostics:\n  probe.ts: 1 error",
  });

  const commands = new Map();
  const notifications = [];
  const lspService = {
    configure() {},
    getStatus() {
      return { activeClients: 0, clients: [], unavailableServers: [] };
    },
  };
  registerLspCommand({
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
  }, runtime, lspService);

  const command = commands.get("lsp");
  assert.ok(command);
  assert.deepEqual(
    command.getArgumentCompletions("context ").map((entry) => entry.value),
    ["status", "on", "off", "toggle"],
  );

  const ctx = {
    cwd: "/tmp",
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      setStatus() {},
    },
  };

  await command.handler(["context", "off"], ctx);
  assert.equal(runtime.config.contextInjection, false);
  assert.equal(handleContext({ messages: [{ role: "user", content: "next" }] }, runtime), undefined);
  assert.equal(runtime.delayedFeedback.length, 1);
  assert.match(notifications.at(-1).message, /disabled/);

  await command.handler(["context", "on"], ctx);
  assert.equal(runtime.config.contextInjection, true);
  const injected = handleContext({ messages: [{ role: "user", content: "next" }] }, runtime);
  assert.ok(injected);
  assert.match(injected.messages[0].content, /Delayed code-feedback LSP feedback/);
  assert.deepEqual(injected.messages.at(-1), { role: "user", content: "next" });
  assert.equal(runtime.delayedFeedback.length, 0);

  await command.handler(["context", "toggle"], ctx);
  assert.equal(runtime.config.contextInjection, false);
  await command.handler(["context", "status"], ctx);
  assert.match(notifications.at(-1).message, /context injection: disabled/);
});
