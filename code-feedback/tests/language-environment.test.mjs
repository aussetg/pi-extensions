import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";
import { createFormatService } from "../src/format/service.ts";
import { createLspService } from "../src/lsp/service.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeServer = path.join(here, "fixtures", "fake-lsp-server.mjs");

test("Python LSPs prefer the project virtual environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-env-"));
  const venv = await createPythonVenv(root, { uv: true });
  const filePath = path.join(root, "probe.py");
  const envLog = path.join(root, "ty-env.json");
  const tyPath = path.join(venv, "bin", "ty");
  await writeExecutable(tyPath, lspWrapperScript(envLog, "py", "T100"));
  await writeFile(filePath, "value = 1\n", "utf8");
  const oldCondaPrefix = process.env.CONDA_PREFIX;
  const oldPythonPath = process.env.PYTHONPATH;
  process.env.CONDA_PREFIX = path.join(root, "stale-conda");
  process.env.PYTHONPATH = path.join(root, "stale-pythonpath");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      "python-ruff": { disabled: true },
    },
  });

  try {
    const refresh = await service.diagnosticsForFileDetailed(filePath, await readFile(filePath, "utf8"), {
      timeoutMs: 1000,
      settleMs: 0,
    });

    assert.equal(refresh?.fresh, true);

    const status = service.getStatus();
    assert.equal(status.clients.length, 1);
    assert.equal(status.clients[0].command, tyPath);
    assert.match(status.clients[0].environment ?? "", /python uv: \.venv/);

    const logged = JSON.parse(await readFile(envLog, "utf8"));
    assert.equal(logged.venv, venv);
    assert.equal(logged.conda, undefined);
    assert.equal(logged.pythonpath, undefined);
    assert.equal(logged.argv[0], "server");
    assert.equal(logged.path.split(path.delimiter)[0], path.join(venv, "bin"));
  } finally {
    restoreProcessEnv("CONDA_PREFIX", oldCondaPrefix);
    restoreProcessEnv("PYTHONPATH", oldPythonPath);
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("Python formatters prefer the project virtual environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-format-env-"));
  const venv = await createPythonVenv(root, { uv: true });
  const filePath = path.join(root, "probe.py");
  const envLog = path.join(root, "ruff-env.json");
  const ruffPath = path.join(venv, "bin", "ruff");
  await writeFile(path.join(root, "pyproject.toml"), "[tool.ruff]\n", "utf8");
  await writeFile(filePath, "x=1\n", "utf8");
  await writeExecutable(ruffPath, formatterWrapperScript(envLog, "x = 1\n"));
  const oldCondaPrefix = process.env.CONDA_PREFIX;
  const oldPythonPath = process.env.PYTHONPATH;
  process.env.CONDA_PREFIX = path.join(root, "stale-conda");
  process.env.PYTHONPATH = path.join(root, "stale-pythonpath");

  const service = createFormatService({ projectRoot: root });

  try {
    const result = await service.formatFile(filePath, "x=1\n");
    assert.equal(result.changed, true);
    assert.equal(result.command, ruffPath);
    assert.equal(result.finalContent, "x = 1\n");

    const logged = JSON.parse(await readFile(envLog, "utf8"));
    assert.equal(logged.venv, venv);
    assert.equal(logged.conda, undefined);
    assert.equal(logged.pythonpath, undefined);
    assert.deepEqual(logged.argv, ["format", filePath]);
    assert.equal(logged.path.split(path.delimiter)[0], path.join(venv, "bin"));
  } finally {
    restoreProcessEnv("CONDA_PREFIX", oldCondaPrefix);
    restoreProcessEnv("PYTHONPATH", oldPythonPath);
    await rm(root, { recursive: true, force: true });
  }
});

test("external Python environments are ignored until their root is trusted", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-trust-project-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-trust-external-"));
  const venv = await createPythonVenv(external);
  const filePath = path.join(external, "probe.py");
  const envLog = path.join(external, "external-env.json");
  const commandPath = path.join(venv, "bin", "external-ty");
  await writeExecutable(commandPath, lspWrapperScript(envLog, "external", "T200"));
  await writeFile(filePath, "value = 1\n", "utf8");

  const serverOverrides = {
    python: { command: "external-ty", args: ["server"] },
    "python-ruff": { disabled: true },
  };
  const untrusted = createLspService({
    projectRoot: project,
    idleTimeoutMs: 0,
    serverOverrides,
  });
  const trusted = createLspService({
    projectRoot: project,
    idleTimeoutMs: 0,
    serverOverrides,
    trustedEnvironmentRoots: [external],
  });

  try {
    const content = await readFile(filePath, "utf8");
    assert.equal(await untrusted.diagnosticsForFileDetailed(filePath, content, { timeoutMs: 1000, settleMs: 0 }), undefined);
    assert.equal(untrusted.getStatus().clients.length, 0);

    const refresh = await trusted.diagnosticsForFileDetailed(filePath, content, { timeoutMs: 1000, settleMs: 0 });
    assert.equal(refresh?.fresh, true);
    assert.equal(trusted.getStatus().clients[0].command, commandPath);
    assert.equal(trusted.getStatus().clients[0].root, external);

    const logged = JSON.parse(await readFile(envLog, "utf8"));
    assert.equal(logged.venv, venv);
  } finally {
    await untrusted.shutdownAll();
    await trusted.shutdownAll();
    await rm(project, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("trusted external roots act as formatter workspaces", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-format-project-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-format-external-"));
  const venv = await createPythonVenv(external);
  const filePath = path.join(external, "probe.py");
  const envLog = path.join(external, "external-ruff-env.json");
  const commandPath = path.join(venv, "bin", "external-ruff");
  await writeFile(path.join(external, "pyproject.toml"), "[tool.ruff]\n", "utf8");
  await writeFile(filePath, "x=1\n", "utf8");
  await writeExecutable(commandPath, formatterWrapperScript(envLog, "x = 1\n"));

  const service = createFormatService({
    projectRoot: project,
    trustedEnvironmentRoots: [external],
    formatterOverrides: {
      ruff: { command: "external-ruff" },
    },
  });

  try {
    const ruffStatus = service.getStatus().commands.find((command) => command.id === "ruff");
    assert.equal(ruffStatus?.available, true);
    assert.equal(ruffStatus?.command, "external-ruff");

    const result = await service.formatFile(filePath, "x=1\n");
    assert.equal(result.changed, true);
    assert.equal(result.command, commandPath);
    assert.equal(result.finalContent, "x = 1\n");

    const logged = JSON.parse(await readFile(envLog, "utf8"));
    assert.equal(logged.venv, venv);
    assert.equal(logged.path.split(path.delimiter)[0], path.join(venv, "bin"));
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("Python LSP workspace/configuration exposes the selected environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-lsp-config-"));
  const venv = await createPythonVenv(root, { uv: true });
  const filePath = path.join(root, "probe.py");
  const envLog = path.join(root, "ty-env.json");
  const lspLog = path.join(root, "ty-lsp.jsonl");
  const tyPath = path.join(venv, "bin", "ty");
  const pythonPath = path.join(venv, "bin", "python");
  await writeExecutable(tyPath, lspWrapperScript(envLog, "py", "T300", { mode: "configuration-log", logPath: lspLog }));
  await writeFile(filePath, "value = 1\n", "utf8");

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      "python-ruff": { disabled: true },
    },
  });

  try {
    const refresh = await service.diagnosticsForFileDetailed(filePath, await readFile(filePath, "utf8"), {
      timeoutMs: 1000,
      settleMs: 0,
    });
    assert.equal(refresh?.fresh, true);

    const entry = await waitForLoggedEntry(lspLog, (candidate) => candidate.method === "workspace/configuration/response");
    const result = entry.result;
    assert.ok(Array.isArray(result));

    assert.equal(result[0].pythonExtension.activeEnvironment.executable.sysPrefix, venv);
    assert.equal(result[1].activeEnvironment.executable.sysPrefix, venv);
    assert.equal(result[2].executable.sysPrefix, venv);
    assert.equal(result[2].executable.uri, pathToFileURL(pythonPath).href);
    assert.deepEqual(result[3], {});
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

async function createPythonVenv(root, options = {}) {
  const venv = path.join(root, ".venv");
  await mkdir(path.join(venv, "bin"), { recursive: true });
  await writeFile(path.join(venv, "pyvenv.cfg"), "home = /usr\n", "utf8");
  await writeExecutable(path.join(venv, "bin", "python"), "#!/bin/sh\nexit 0\n");
  if (options.uv) await writeFile(path.join(root, "uv.lock"), "", "utf8");
  return venv;
}

async function writeExecutable(filePath, content) {
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, 0o755);
}

function lspWrapperScript(envLog, source, code, options = {}) {
  const mode = options.mode ?? "diagnostics";
  const logPathArg = options.logPath ? `, ${JSON.stringify(options.logPath)}` : "";
  return `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(envLog)}, JSON.stringify({
  argv: process.argv.slice(2),
  venv: process.env.VIRTUAL_ENV,
  conda: process.env.CONDA_PREFIX,
  pythonpath: process.env.PYTHONPATH,
  path: process.env.PATH,
}) + "\\n", "utf8");
process.argv = [process.argv[0], ${JSON.stringify(fakeServer)}, ${JSON.stringify(source)}, ${JSON.stringify(code)}, "1", "", ${JSON.stringify(mode)}${logPathArg}];
import(${JSON.stringify(pathToFileURL(fakeServer).href)}).catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
}

async function waitForLoggedEntry(logPath, predicate) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    for (const entry of await readLoggedEntries(logPath)) {
      if (predicate(entry)) return entry;
    }
    await sleep(10);
  }
  assert.fail(`Timed out waiting for LSP log entry in ${logPath}`);
}

async function readLoggedEntries(logPath) {
  try {
    const text = await readFile(logPath, "utf8");
    return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function formatterWrapperScript(envLog, finalContent) {
  return `#!${process.execPath}
const fs = require("node:fs");
const target = process.argv.at(-1);
fs.writeFileSync(${JSON.stringify(envLog)}, JSON.stringify({
  argv: process.argv.slice(2),
  venv: process.env.VIRTUAL_ENV,
  conda: process.env.CONDA_PREFIX,
  pythonpath: process.env.PYTHONPATH,
  path: process.env.PATH,
}) + "\\n", "utf8");
fs.writeFileSync(target, ${JSON.stringify(finalContent)}, "utf8");
`;
}

function restoreProcessEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
