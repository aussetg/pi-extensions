import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  MAX_ACTIVE_LSP_CLIENTS,
  MAX_LSP_INITIALIZATION_CONCURRENCY,
} from "../src/lsp/client-resources.ts";
import { createLspService } from "../src/lsp/service.ts";
import { readJsonLines } from "./helpers/json-lines.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeServer = path.join(here, "fixtures", "fake-lsp-server.mjs");

test("client resource limits are configurable and clamped", () => {
  const service = createLspService({
    projectRoot: os.tmpdir(),
    idleTimeoutMs: 0,
    maxActiveClients: 3,
    initializationConcurrency: 2,
  });

  assert.equal(service.getStatus().clientResources?.maxActiveClients, 3);
  assert.equal(service.getStatus().clientResources?.initializationConcurrency, 2);

  service.configure({
    projectRoot: os.tmpdir(),
    idleTimeoutMs: 0,
    maxActiveClients: 999,
    initializationConcurrency: 999,
  });
  assert.equal(service.getStatus().clientResources?.maxActiveClients, MAX_ACTIVE_LSP_CLIENTS);
  assert.equal(service.getStatus().clientResources?.initializationConcurrency, MAX_LSP_INITIALIZATION_CONCURRENCY);

  service.configure({
    projectRoot: os.tmpdir(),
    idleTimeoutMs: 0,
    maxActiveClients: 0,
    initializationConcurrency: 0,
  });
  assert.equal(service.getStatus().clientResources?.maxActiveClients, 1);
  assert.equal(service.getStatus().clientResources?.initializationConcurrency, 1);
});

test("initialization concurrency bounds simultaneous process startups", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-start-budget-"));
  const logPath = path.join(root, "initialization.jsonl");
  const files = await nestedTypeScriptFiles(root, 4);
  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    maxActiveClients: 4,
    initializationConcurrency: 2,
    serverOverrides: {
      typescript: {
        command: process.execPath,
        args: [fakeServer, "ts", "T100", "1", "", "initialize-delay-100", logPath],
      },
    },
  });

  try {
    await Promise.all(files.map((filePath) => service.capabilities(filePath, undefined, "typescript")));
    const entries = await readJsonLines(logPath);
    let initializing = 0;
    let peak = 0;
    for (const entry of entries) {
      if (entry.method === "initialize/start") {
        initializing += 1;
        peak = Math.max(peak, initializing);
      } else if (entry.method === "initialize/end") {
        initializing -= 1;
      }
      assert.ok(initializing >= 0);
      assert.ok(initializing <= 2);
    }
    assert.equal(peak, 2);
    assert.equal(initializing, 0);

    const resources = service.getStatus().clientResources;
    assert.equal(resources?.activeClients, 4);
    assert.equal(resources?.starts, 4);
    assert.equal(resources?.restarts, 0);
    assert.equal(resources?.queuedStarts, 0);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("resource status retains process restart and initialization cooldown counters", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-client-lifecycle-"));
  const [filePath] = await nestedTypeScriptFiles(root, 1);
  const restartLog = path.join(root, "restart.jsonl");
  const restarting = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      typescript: {
        command: process.execPath,
        args: [fakeServer, "ts", "T100", "1", "", "exit-after-initialize-once", restartLog],
      },
    },
  });

  try {
    await restarting.capabilities(filePath, undefined, "typescript");
    await waitFor(() => restarting.getStatus().clients[0]?.state === "failed");
    await restarting.capabilities(filePath, undefined, "typescript");
    assert.equal(restarting.getStatus().clientResources?.starts, 2);
    assert.equal(restarting.getStatus().clientResources?.restarts, 1);
    assert.equal(restarting.getStatus().clients[0]?.startCount, 2);
    assert.equal(restarting.getStatus().clients[0]?.restartCount, 1);
  } finally {
    await restarting.shutdownAll();
  }

  const coolingDown = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      typescript: {
        command: process.execPath,
        args: [fakeServer, "ts", "T100", "1", "", "initialize-error", path.join(root, "cooldown.jsonl")],
      },
    },
  });

  try {
    await coolingDown.capabilities(filePath, undefined, "typescript");
    assert.equal(coolingDown.getStatus().clientResources?.starts, 1);
    assert.equal(coolingDown.getStatus().clientResources?.initializationCooldowns, 1);
    assert.equal(coolingDown.getStatus().clients[0]?.initializationCooldownCount, 1);
  } finally {
    await coolingDown.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("the active-client budget evicts the least recently used idle client", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-client-budget-"));
  const files = await nestedTypeScriptFiles(root, 3);
  const service = resourceTestService(root, { maxActiveClients: 2 });

  try {
    await service.capabilities(files[0], undefined, "typescript");
    await sleep(10);
    await service.capabilities(files[1], undefined, "typescript");
    await sleep(10);
    await service.capabilities(files[2], undefined, "typescript");

    const status = service.getStatus();
    assert.equal(status.clientResources?.activeClients, 2);
    assert.equal(status.clientResources?.capacityEvictions, 1);
    assert.deepEqual(
      status.clients.map((client) => path.basename(client.root)).sort(),
      ["package-1", "package-2"],
    );
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("busy clients are queued behind the active-client budget instead of being evicted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-client-busy-"));
  const files = await nestedTypeScriptFiles(root, 2);
  const service = resourceTestService(root, {
    maxActiveClients: 1,
    mode: "hover-delay-150",
  });

  try {
    await service.capabilities(files[0], undefined, "typescript");
    const hover = service.hover(files[0], { line: 1, column: 1 }, undefined, "typescript");
    await waitFor(() => service.getStatus().clients.some((client) => client.root === path.dirname(path.dirname(files[0])) && client.busy));

    const secondStart = service.capabilities(files[1], undefined, "typescript");
    await waitFor(() => (service.getStatus().clientResources?.queuedStarts ?? 0) === 1);
    const waiting = service.getStatus();
    assert.equal(waiting.clientResources?.activeClients, 1);
    assert.equal(waiting.clientResources?.evictions, 0);
    assert.equal(waiting.clients.find((client) => client.root.endsWith("package-0"))?.busy, true);

    await hover;
    await secondStart;
    const completed = service.getStatus();
    assert.equal(completed.clientResources?.activeClients, 1);
    assert.equal(completed.clientResources?.capacityEvictions, 1);
    assert.deepEqual(completed.clients.map((client) => path.basename(client.root)), ["package-1"]);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("multi-server diagnostics serialize at the client budget without evicting in-flight work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-client-diagnostics-budget-"));
  const filePath = path.join(root, "probe.py");
  const content = "value = 1\n";
  await writeFile(filePath, content, "utf8");
  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    maxActiveClients: 1,
    initializationConcurrency: 1,
    serverOverrides: {
      python: {
        command: process.execPath,
        args: [fakeServer, "language", "T100", "1"],
      },
      "python-ruff": {
        command: process.execPath,
        args: [fakeServer, "linter", "R100", "2"],
      },
    },
  });

  try {
    const refresh = await service.diagnosticsForFileDetailed(filePath, content, {
      timeoutMs: 1000,
      settleMs: 0,
    });
    assert.equal(refresh?.fresh, true);
    assert.deepEqual(
      [...refresh.snapshot.byUri.values()].flat().map((diagnostic) => diagnostic.source).sort(),
      ["language", "linter"],
    );
    assert.equal(service.getStatus().clientResources?.activeClients, 1);
    assert.equal(service.getStatus().clientResources?.capacityEvictions, 1);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("service shutdown cancels queued starts without launching an orphan process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-client-queued-shutdown-"));
  const files = await nestedTypeScriptFiles(root, 2);
  const logPath = path.join(root, "processes.jsonl");
  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    maxActiveClients: 1,
    initializationConcurrency: 1,
    serverOverrides: {
      typescript: {
        command: process.execPath,
        args: [fakeServer, "ts", "T100", "1", "", "hover-delay-150", logPath],
      },
    },
  });

  try {
    await service.capabilities(files[0], undefined, "typescript");
    const hover = service.hover(files[0], { line: 1, column: 1 }, undefined, "typescript");
    const hoverSettled = hover.then(() => undefined, () => undefined);
    await waitFor(() => service.getStatus().clients.some((client) => client.busy));
    const queued = service.capabilities(files[1], undefined, "typescript");
    const queuedSettled = queued.then(() => undefined, () => undefined);
    await waitFor(() => service.getStatus().clientResources?.queuedStarts === 1);

    await service.shutdownAll();
    await Promise.all([hoverSettled, queuedSettled]);
    await sleep(200);

    const starts = (await readJsonLines(logPath)).filter((entry) => entry.method === "process/start");
    assert.equal(starts.length, 1);
    assert.equal(service.getStatus().clientResources?.activeClients, 0);
    assert.equal(service.getStatus().clientResources?.queuedStarts, 0);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("idle expiry is per client rather than resetting every active server", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-client-idle-"));
  const files = await nestedTypeScriptFiles(root, 2);
  const service = resourceTestService(root, {
    idleTimeoutMs: 80,
    maxActiveClients: 2,
  });

  try {
    await service.capabilities(files[0], undefined, "typescript");
    await sleep(50);
    await service.capabilities(files[1], undefined, "typescript");

    await waitFor(() => {
      const status = service.getStatus();
      const roots = status.clients.map((client) => path.basename(client.root));
      return !roots.includes("package-0") &&
        roots.includes("package-1") &&
        status.clientResources?.idleEvictions === 1;
    });
    assert.equal(service.getStatus().clientResources?.idleEvictions, 1);

    await waitFor(() => (
      service.getStatus().clients.length === 0 &&
      service.getStatus().clientResources?.idleEvictions === 2
    ));
    assert.equal(service.getStatus().clientResources?.idleEvictions, 2);
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

function resourceTestService(root, options = {}) {
  return createLspService({
    projectRoot: root,
    idleTimeoutMs: options.idleTimeoutMs ?? 0,
    maxActiveClients: options.maxActiveClients ?? 8,
    initializationConcurrency: 2,
    serverOverrides: {
      typescript: {
        command: process.execPath,
        args: [fakeServer, "ts", "T100", "1", "", options.mode ?? "diagnostics"],
      },
    },
  });
}

async function nestedTypeScriptFiles(root, count) {
  const files = [];
  for (let index = 0; index < count; index += 1) {
    const packageRoot = path.join(root, `package-${index}`);
    const filePath = path.join(packageRoot, "src", "main.ts");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), "{}\n", "utf8");
    await writeFile(filePath, `export const value${index} = ${index};\n`, "utf8");
    files.push(filePath);
  }
  return files;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail("timed out waiting for LSP client resource state");
}
