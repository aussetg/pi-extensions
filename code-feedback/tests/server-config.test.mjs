import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadLanguageServerConfiguration } from "../src/lsp/server-config.ts";
import { resolveLanguageServers } from "../src/lsp/servers.ts";

test("trusted project language-server config replaces user entries and adds language-agnostic routes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-server-config-"));
  const agentDir = path.join(root, "agent");
  const projectRoot = path.join(root, "project");
  const configDirName = ".brand";
  await mkdir(agentDir, { recursive: true });
  await mkdir(path.join(projectRoot, configDirName), { recursive: true });

  await writeJson(path.join(agentDir, "code-feedback.json"), {
    servers: {
      custom: {
        command: [process.execPath, "user-server.mjs"],
        extensions: [".foo"],
        languageId: "foo-user",
      },
      disabled: {
        command: [process.execPath, "disabled.mjs"],
        extensions: [".disabled"],
      },
      inferred: {
        command: [process.execPath],
        extensions: [".zed"],
      },
    },
  });
  await writeJson(path.join(projectRoot, configDirName, "code-feedback.json"), {
    servers: {
      custom: {
        command: [process.execPath, "project-server.mjs", "--stdio"],
        extensions: [".foo", ".bar"],
        languageId: "fallback-language",
        languageIds: { ".foo": "foo-project" },
        env: { CUSTOM_LSP: "enabled" },
        initializationOptions: { client: "project" },
        workspaceConfiguration: { custom: { lint: true } },
      },
      disabled: { disabled: true },
      "python-ruff": { disabled: true },
    },
  });

  try {
    const configuration = loadLanguageServerConfiguration({
      agentDir,
      projectRoot,
      configDirName,
      projectTrusted: true,
    });

    assert.deepEqual(configuration.status.sources.map((source) => [source.scope, source.state]), [
      ["user", "loaded"],
      ["project", "loaded"],
    ]);
    assert.deepEqual(configuration.status.configuredServerIds, ["custom", "disabled", "inferred", "python-ruff"]);
    assert.deepEqual(configuration.status.errors, []);
    assert.deepEqual(configuration.servers.custom.command, [process.execPath, "project-server.mjs", "--stdio"]);
    assert.equal(configuration.servers.disabled.disabled, true);

    const fooPath = path.join(projectRoot, "main.foo");
    const barPath = path.join(projectRoot, "main.bar");
    const foo = resolveLanguageServers(fooPath, {
      projectRoot,
      serverConfiguration: configuration.servers,
      server: "custom",
    });
    const bar = resolveLanguageServers(barPath, {
      projectRoot,
      serverConfiguration: configuration.servers,
      server: "custom",
    });

    assert.equal(foo.length, 1);
    assert.equal(foo[0].definition.id, "custom");
    assert.equal(foo[0].definition.command, process.execPath);
    assert.deepEqual(foo[0].definition.args, ["project-server.mjs", "--stdio"]);
    assert.equal(foo[0].definition.languageId(fooPath), "foo-project");
    assert.equal(bar[0].definition.languageId(barPath), "fallback-language");
    assert.deepEqual(foo[0].definition.env, { CUSTOM_LSP: "enabled" });
    assert.deepEqual(foo[0].definition.initializationOptions, { client: "project" });
    assert.deepEqual(foo[0].definition.workspaceConfiguration, { custom: { lint: true } });

    const pythonRoutes = resolveLanguageServers(path.join(projectRoot, "main.py"), {
      projectRoot,
      serverConfiguration: configuration.servers,
      server: "python-ruff",
    });
    assert.equal(pythonRoutes.length, 1);
    assert.equal(pythonRoutes[0].available, false);
    assert.equal(pythonRoutes[0].unavailableReason, "disabled by config");

    const inferredPath = path.join(projectRoot, "main.zed");
    const inferred = resolveLanguageServers(inferredPath, {
      projectRoot,
      serverConfiguration: configuration.servers,
      server: "inferred",
    });
    assert.equal(inferred[0].definition.languageId(inferredPath), "zed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("untrusted project language-server config is not read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-server-config-untrusted-"));
  const agentDir = path.join(root, "agent");
  const projectRoot = path.join(root, "project");
  const configDirName = ".pi-test";
  await mkdir(agentDir, { recursive: true });
  await mkdir(path.join(projectRoot, configDirName), { recursive: true });
  await writeJson(path.join(agentDir, "code-feedback.json"), {
    servers: {
      user: { command: [process.execPath], extensions: [".user"] },
    },
  });
  await writeFile(path.join(projectRoot, configDirName, "code-feedback.json"), "{ definitely not valid JSON", "utf8");

  try {
    const configuration = loadLanguageServerConfiguration({
      agentDir,
      projectRoot,
      configDirName,
      projectTrusted: false,
    });

    assert.deepEqual(Object.keys(configuration.servers), ["user"]);
    assert.deepEqual(configuration.status.errors, []);
    assert.equal(configuration.status.sources[1].state, "ignored-untrusted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalid config source is rejected atomically with an actionable status error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-server-config-invalid-"));
  const agentDir = path.join(root, "agent");
  const projectRoot = path.join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await writeJson(path.join(agentDir, "code-feedback.json"), {
    servers: {
      valid: { command: [process.execPath], extensions: [".valid"] },
      broken: { command: "shell string", extensions: [".broken"] },
    },
  });

  try {
    const configuration = loadLanguageServerConfiguration({
      agentDir,
      projectRoot,
      configDirName: ".pi",
      projectTrusted: true,
    });

    assert.deepEqual(Object.keys(configuration.servers), []);
    assert.equal(configuration.status.sources[0].state, "invalid");
    assert.equal(configuration.status.sources[1].state, "missing");
    assert.equal(configuration.status.errors.length, 1);
    assert.match(configuration.status.errors[0], /servers\.broken\.command must be a non-empty string array/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
