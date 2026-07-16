#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createLspService } from "../src/lsp/service.ts";
import { resolveLanguageServers } from "../src/lsp/servers.ts";

const smokeCases = [
  {
    id: "typescript",
    file: "probe.ts",
    content: "export const answer: number = 42;\n",
    files: {
      "package.json": "{\"type\":\"module\"}\n",
      "tsconfig.json": "{\"compilerOptions\":{\"strict\":true,\"noEmit\":true}}\n",
    },
  },
  {
    id: "python",
    file: "probe.py",
    content: "answer: int = 42\n",
    files: { "pyproject.toml": "[project]\nname = \"code-feedback-smoke\"\nversion = \"0.0.0\"\n" },
  },
  {
    id: "python-ruff",
    file: "probe.py",
    content: "import os\n",
    files: { "pyproject.toml": "[project]\nname = \"code-feedback-smoke\"\nversion = \"0.0.0\"\n" },
  },
  {
    id: "clangd",
    file: "probe.c",
    content: "int answer = 42;\n",
    files: { "compile_flags.txt": "-std=c17\n" },
  },
  {
    id: "haskell",
    file: "Smoke.hs",
    content: "module Smoke where\nanswer :: Int\nanswer = 42\n",
    files: {},
  },
  {
    id: "rust",
    file: "src/lib.rs",
    content: "pub const ANSWER: i32 = 42;\n",
    files: { "Cargo.toml": "[package]\nname = \"code-feedback-smoke\"\nversion = \"0.0.0\"\nedition = \"2024\"\n" },
  },
];

const options = parseArgs(process.argv.slice(2));
const selected = options.servers.length === 0
  ? smokeCases
  : smokeCases.filter((entry) => options.servers.includes(entry.id));
const unknown = options.servers.filter((id) => !smokeCases.some((entry) => entry.id === id));
if (unknown.length > 0) throw new Error(`Unknown smoke server id${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);

const results = [];
for (const entry of selected) results.push(await runSmokeCase(entry));

const failures = results.filter((result) => result.status === "failed");
if (options.json) {
  console.log(JSON.stringify({ pass: failures.length === 0, results }, null, 2));
} else {
  for (const result of results) {
    const duration = result.durationMs === undefined ? "" : ` (${result.durationMs.toFixed(1)} ms)`;
    console.log(`${result.status === "passed" ? "PASS" : result.status === "skipped" ? "SKIP" : "FAIL"} ${result.id}: ${result.detail}${duration}`);
  }
}
if (failures.length > 0) process.exitCode = 1;

async function runSmokeCase(entry) {
  const root = await mkdtemp(path.join(os.tmpdir(), `pi-code-feedback-smoke-${entry.id}-`));
  const filePath = path.join(root, entry.file);
  await writeFixture(root, entry);

  const route = resolveLanguageServers(filePath, { projectRoot: root, server: entry.id })[0];
  if (!route?.available) {
    await rm(root, { recursive: true, force: true });
    return { id: entry.id, status: "skipped", detail: route?.unavailableReason ?? "route is unavailable" };
  }

  const service = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    maxActiveClients: 1,
    initializationConcurrency: 1,
  });
  const startedAt = performance.now();
  try {
    const capabilities = await service.capabilities(filePath, AbortSignal.timeout(20_000), entry.id);
    if (!isRecord(capabilities)) throw new Error("initialize returned no capability object");

    let probe = "initialize";
    if (capabilities.documentSymbolProvider) {
      const symbols = await service.documentSymbols(filePath, AbortSignal.timeout(20_000), entry.id);
      if (!Array.isArray(symbols)) throw new Error("document symbols returned a non-array response");
      probe = `document symbols (${symbols.length})`;
    } else if (capabilities.diagnosticProvider) {
      const diagnostics = await service.diagnosticsForFileDetailed(filePath, entry.content, {
        timeoutMs: 10_000,
        settleMs: 0,
        snapshotScope: "file",
        server: entry.id,
        signal: AbortSignal.timeout(20_000),
      });
      if (!diagnostics?.fresh) throw new Error("document diagnostics were not authoritative");
      probe = "authoritative document diagnostics";
    }

    return { id: entry.id, status: "passed", detail: probe, durationMs: performance.now() - startedAt };
  } catch (error) {
    return {
      id: entry.id,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startedAt,
    };
  } finally {
    await service.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFixture(root, entry) {
  const allFiles = { ...entry.files, [entry.file]: entry.content };
  for (const [relativePath, content] of Object.entries(allFiles)) {
    const filePath = path.join(root, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
}

function parseArgs(argv) {
  const parsed = { json: false, servers: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") parsed.json = true;
    else if (argument === "--server") parsed.servers.push(...splitIds(argv[++index] ?? ""));
    else if (argument.startsWith("--server=")) parsed.servers.push(...splitIds(argument.slice("--server=".length)));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return parsed;
}

function splitIds(value) {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
