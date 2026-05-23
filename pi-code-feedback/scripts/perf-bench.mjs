#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { createDefaultConfig } from "../src/config.ts";
import { handleToolCall } from "../src/events/tool-call.ts";
import { handleToolResult } from "../src/events/tool-result.ts";
import { handleContext } from "../src/events/context.ts";
import { createFormatService } from "../src/format/service.ts";
import { createLspService } from "../src/lsp/service.ts";
import { beginTurn, createRuntime, setProjectRoot } from "../src/runtime.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);
const fakeLspServer = path.join(repoRoot, "tests", "fixtures", "fake-lsp-server.mjs");
const fakeFormatter = path.join(repoRoot, "scripts", "fixtures", "fake-formatter.mjs");
const lspStdioProxy = path.join(repoRoot, "scripts", "fixtures", "lsp-stdio-proxy.mjs");
const tsLanguageServer = path.join(repoRoot, "node_modules", ".bin", "typescript-language-server");

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}

const baseIterations = Math.max(1, Number.parseInt(args.iterations ?? "30", 10));
const filters = args.scenarios;
const results = [];

const scenarioSpecs = [
  ["hook/noop", () => runHookNoopScenario(baseIterations * 100)],
  ["tool/nontracked", () => runNontrackedToolScenario(baseIterations * 100)],
  ["edit/disabled", () => runEditScenario({ name: "edit/disabled", iterations: baseIterations, enabled: false, lsp: false, format: false })],
  ["edit/no-lsp-no-format", () => runEditScenario({ name: "edit/no-lsp-no-format", iterations: baseIterations, enabled: true, lsp: false, format: false })],
  ["edit/formatter-detect-none", () => runEditScenario({ name: "edit/formatter-detect-none", iterations: baseIterations, enabled: true, lsp: false, format: "detect-none" })],
  ["apply-patch/no-lsp-no-format", () => runApplyPatchScenario(Math.max(3, Math.ceil(baseIterations / 3)))],
  ["formatter/fake-unchanged", () => runEditScenario({ name: "formatter/fake-unchanged", iterations: Math.max(5, Math.ceil(baseIterations / 2)), enabled: true, lsp: false, format: "fake-noop", lineCount: 400, unchanged: true })],
  ["formatter/fake-noop", () => runEditScenario({ name: "formatter/fake-noop", iterations: Math.max(5, Math.ceil(baseIterations / 2)), enabled: true, lsp: false, format: "fake-noop", lineCount: 400 })],
  ["formatter/fake-change", () => runEditScenario({ name: "formatter/fake-change", iterations: Math.max(5, Math.ceil(baseIterations / 2)), enabled: true, lsp: false, format: "fake-change", lineCount: 400 })],
  ["formatter/fake-map-large", () => runEditScenario({ name: "formatter/fake-map-large", iterations: Math.max(2, Math.ceil(baseIterations / 15)), enabled: true, lsp: false, format: "fake-change", lineCount: 1800 })],
  ["lsp/fake-cold", () => runFakeLspScenario({ name: "lsp/fake-cold", iterations: 1, warmup: 0 })],
  ["lsp/fake-warm", () => runFakeLspScenario({ name: "lsp/fake-warm", iterations: baseIterations, warmup: 2 })],
  ["lsp/fake-delay-200", () => runFakeLspScenario({ name: "lsp/fake-delay-200", iterations: Math.max(3, Math.ceil(baseIterations / 10)), warmup: 1, mode: "diagnostics-delay-200", inlineTimeoutMs: 80, expectInline: false })],
  ["lsp/fake-timeout-120", () => runFakeLspScenario({ name: "lsp/fake-timeout-120", iterations: Math.max(3, Math.ceil(baseIterations / 10)), warmup: 0, mode: "no-diagnostics", timeoutMs: 120, inlineTimeoutMs: 80, inline: "off" })],
];

if (args.live) {
  scenarioSpecs.push(["lsp/typescript-live", () => runTypeScriptLiveScenario(Math.max(3, Math.ceil(baseIterations / 4)))]);
  scenarioSpecs.push(["lsp/typescript-incremental", () => runTypeScriptIncrementalScenario(Math.max(3, Math.ceil(baseIterations / 4)))]);
  scenarioSpecs.push(["lsp/typescript-hover", () => runTypeScriptHoverScenario(Math.max(5, Math.ceil(baseIterations / 2)))]);
}

for (const [name, run] of scenarioSpecs) {
  if (!shouldRun(name, filters)) continue;
  results.push(await run());
}

const output = {
  meta: {
    timestamp: new Date().toISOString(),
    repoRoot,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    pid: process.pid,
    baseIterations,
    live: args.live,
    exposeGc: typeof globalThis.gc === "function",
  },
  results,
};

if (args.json) {
  console.log(JSON.stringify(output, null, 2));
} else {
  printHuman(output);
}

function parseArgs(argv) {
  const parsed = { json: false, live: false, help: false, iterations: undefined, scenarios: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--live") parsed.live = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg.startsWith("--iterations=")) parsed.iterations = arg.slice("--iterations=".length);
    else if (arg === "--iterations" || arg === "-n") parsed.iterations = argv[++index];
    else if (arg.startsWith("--scenario=")) parsed.scenarios.push(...splitFilters(arg.slice("--scenario=".length)));
    else if (arg === "--scenario" || arg === "-s") parsed.scenarios.push(...splitFilters(argv[++index] ?? ""));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function splitFilters(value) {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function printUsage() {
  console.log(`Usage: node --expose-gc scripts/perf-bench.mjs [options]\n\nOptions:\n  -n, --iterations N   Base iteration count for edit scenarios (default: 30)\n  -s, --scenario NAME  Run scenarios whose name contains NAME; comma-separated is ok\n      --live           Include real TypeScript language-server scenarios\n      --json           Emit machine-readable JSON\n      --help           Show this help\n`);
}

function shouldRun(name, requested) {
  return requested.length === 0 || requested.some((filter) => name.includes(filter));
}

async function runHookNoopScenario(iterations) {
  const runtime = makeRuntime(process.cwd(), { enabled: true, lsp: true, format: false });
  return runScenario({
    name: "hook/noop",
    iterations,
    notes: "turn_start plus context hook with no delayed diagnostics",
    operation: async () => {
      const turn = await timed("turn_start", () => beginTurn(runtime));
      const context = await timed("context", () => handleContext({ messages: [{ role: "user", content: "noop" }] }, runtime));
      return withTotal([turn, context]);
    },
  });
}

async function runNontrackedToolScenario(iterations) {
  const runtime = makeRuntime(process.cwd(), { enabled: true, lsp: true, format: false });
  return runScenario({
    name: "tool/nontracked",
    iterations,
    notes: "tool_call/tool_result for a tool this extension must ignore",
    operation: async (index) => {
      const event = { toolName: "bash", toolCallId: `bash-${index}`, input: { command: "true" }, content: [{ type: "text", text: "" }] };
      const call = await timed("tool_call", () => handleToolCall(event, { cwd: process.cwd() }, runtime));
      const result = await timed("tool_result", () => handleToolResult(event, { cwd: process.cwd() }, runtime));
      return withTotal([call, result]);
    },
  });
}

async function runEditScenario(options) {
  const root = await mkdtemp(path.join(os.tmpdir(), `pi-code-feedback-perf-${sanitizeName(options.name)}-`));
  const filePath = path.join(root, "probe.ts");
  const lineCount = options.lineCount ?? 40;
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2), "utf8");
  await writeFile(filePath, makeTsContent(0, lineCount), "utf8");

  const runtime = makeRuntime(root, { enabled: options.enabled, lsp: options.lsp, format: options.format !== false });
  const formatService = makeFormatService(root, runtime, options.format);
  const operation = makeEditOperation({
    root,
    runtime,
    filePath,
    formatService,
    content: (version) => makeTsContent(version, lineCount),
    unchanged: options.unchanged === true,
    expectCompletedEdit: options.enabled,
    expectTouchedRanges: options.unchanged !== true,
    expectFormatted: options.format === "fake-change",
  });

  try {
    return await runScenario({
      name: options.name,
      iterations: options.iterations,
      notes: editScenarioNotes(options),
      operation,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runApplyPatchScenario(iterations) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-perf-apply-patch-"));
  const filePaths = Array.from({ length: 5 }, (_, index) => path.join(root, `probe-${index}.ts`));
  await Promise.all(filePaths.map((filePath) => writeFile(filePath, makeTsContent(0, 20), "utf8")));

  const runtime = makeRuntime(root, { enabled: true, lsp: false, format: false });
  let version = 0;

  try {
    return await runScenario({
      name: "apply-patch/no-lsp-no-format",
      iterations,
      notes: "single apply_patch result with five update_file operations",
      operation: async (index) => {
        beginTurn(runtime);
        const toolCallId = `patch-${index}`;
        const before = makeTsContent(version, 20);
        const after = makeTsContent(version + 1, 20);
        const operations = filePaths.map((filePath) => ({ type: "update_file", path: path.relative(root, filePath) }));

        const call = await timed("tool_call", () => handleToolCall({ toolName: "apply_patch", toolCallId, input: { operations } }, { cwd: root }, runtime));
        await Promise.all(filePaths.map((filePath) => writeFile(filePath, after, "utf8")));
        const results = filePaths.map((filePath) => ({
          type: "update_file",
          path: path.relative(root, filePath),
          status: "completed",
          diff: firstLineDiff(before, after),
        }));
        const result = await timed("tool_result", () => handleToolResult({
          toolName: "apply_patch",
          toolCallId,
          input: { operations },
          details: { stage: "done", results },
          content: [{ type: "text", text: "patched" }],
          isError: false,
        }, { cwd: root }, runtime));
        version += 1;
        return withTotal([call, result]);
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runFakeLspScenario(options) {
  const root = await mkdtemp(path.join(os.tmpdir(), `pi-code-feedback-perf-${sanitizeName(options.name)}-`));
  const filePath = path.join(root, "probe.ts");
  await writeFile(filePath, makeTsContent(0, 30), "utf8");

  const runtime = makeRuntime(root, { enabled: true, lsp: true, format: false });
  runtime.config.diagnostics.timeoutMs = options.timeoutMs ?? 1000;
  runtime.config.diagnostics.inlineTimeoutMs = options.inlineTimeoutMs ?? runtime.config.diagnostics.inlineTimeoutMs;
  runtime.config.diagnostics.delayedTimeoutMs = options.delayedTimeoutMs ?? runtime.config.diagnostics.timeoutMs;
  runtime.config.diagnostics.settleMs = 0;
  if (options.inline) runtime.config.diagnostics.inline = options.inline;
  const lspService = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      typescript: {
        command: process.execPath,
        args: [fakeLspServer, "fake-ts", "TS100", "1", "", options.mode ?? "diagnostics"],
      },
    },
  });
  const operation = makeEditOperation({
    root,
    runtime,
    lspService,
    filePath,
    content: (version) => makeTsContent(version, 30),
    expectCompletedEdit: true,
    expectFeedback: options.expectInline ?? ((options.inline ?? runtime.config.diagnostics.inline) !== "off" && options.mode !== "no-diagnostics"),
  });

  try {
    return await runScenario({
      name: options.name,
      iterations: options.iterations,
      warmup: options.warmup,
      notes: fakeLspNotes(options),
      resources: () => lspRootPids(lspService),
      operation,
    });
  } finally {
    await lspService.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
}

function fakeLspNotes(options) {
  if (options.mode === "diagnostics-delay-200") return `fake LSP delays diagnostics by 200ms; inline budget is ${options.inlineTimeoutMs ?? 200}ms and delayed diagnostics continue in the background`;
  if (options.mode === "no-diagnostics") return `fake LSP never publishes diagnostics; inline wall time should track the ${options.inlineTimeoutMs ?? options.timeoutMs ?? 200}ms budget`;
  return "deterministic stdio LSP with one diagnostic; includes before and after diagnostic refresh";
}

async function runTypeScriptLiveScenario(iterations) {
  if (!fs.existsSync(tsLanguageServer)) {
    return {
      name: "lsp/typescript-live",
      iterations: 0,
      skipped: true,
      notes: `missing ${path.relative(repoRoot, tsLanguageServer)}`,
      metrics: [],
    };
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-perf-ts-live-"));
  const filePath = path.join(root, "probe.ts");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", devDependencies: { typescript: "^5.9.3" } }, null, 2), "utf8");
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }, null, 2), "utf8");
  await writeFile(filePath, makeTsErrorContent(0, 30), "utf8");

  const runtime = makeRuntime(root, { enabled: true, lsp: true, format: false });
  runtime.config.diagnostics.timeoutMs = 2500;
  runtime.config.diagnostics.settleMs = 0;
  const lspService = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      typescript: {
        command: tsLanguageServer,
        args: ["--stdio"],
      },
    },
  });
  const operation = makeEditOperation({
    root,
    runtime,
    lspService,
    filePath,
    content: (version) => makeTsErrorContent(version, 30),
    expectCompletedEdit: true,
  });

  try {
    return await runScenario({
      name: "lsp/typescript-live",
      iterations,
      warmup: 1,
      notes: "real typescript-language-server; intentionally optional because machine state affects it",
      resources: () => lspRootPids(lspService),
      operation,
    });
  } finally {
    await lspService.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
}

async function runTypeScriptIncrementalScenario(iterations) {
  if (!fs.existsSync(tsLanguageServer)) {
    return {
      name: "lsp/typescript-incremental",
      iterations: 0,
      skipped: true,
      notes: `missing ${path.relative(repoRoot, tsLanguageServer)}`,
      metrics: [],
    };
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-perf-ts-incremental-"));
  const filePath = path.join(root, "probe.ts");
  const logPath = path.join(root, "lsp-proxy.jsonl");
  const lineCount = 1000;
  const warmup = 1;
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", devDependencies: { typescript: "^5.9.3" } }, null, 2), "utf8");
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }, null, 2), "utf8");
  await writeFile(filePath, makeTsErrorContent(0, lineCount), "utf8");
  await writeFile(logPath, "", "utf8");

  const runtime = makeRuntime(root, { enabled: true, lsp: true, format: false });
  runtime.config.diagnostics.timeoutMs = 5000;
  runtime.config.diagnostics.inlineTimeoutMs = 1500;
  runtime.config.diagnostics.settleMs = 0;
  const lspService = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      typescript: {
        command: process.execPath,
        args: [lspStdioProxy, logPath, "--", tsLanguageServer, "--stdio"],
      },
    },
  });
  const operation = makeEditOperation({
    root,
    runtime,
    lspService,
    filePath,
    content: (version) => makeTsErrorContent(version, lineCount),
    expectCompletedEdit: true,
  });

  try {
    return await runScenario({
      name: "lsp/typescript-incremental",
      iterations,
      warmup,
      notes: `real typescript-language-server behind a stdio proxy; ${lineCount}-line file with one edited string literal; protocol counters exclude warmup`,
      beforeMeasure: () => fs.writeFileSync(logPath, "", "utf8"),
      counters: () => summarizeLspProxyCounters(logPath, {
        fullTextForDidChange: (index) => makeTsErrorContent(warmup + index + 1, lineCount),
      }),
      resources: () => lspRootPids(lspService),
      operation,
    });
  } finally {
    await lspService.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
}

async function runTypeScriptHoverScenario(iterations) {
  if (!fs.existsSync(tsLanguageServer)) {
    return {
      name: "lsp/typescript-hover",
      iterations: 0,
      skipped: true,
      notes: `missing ${path.relative(repoRoot, tsLanguageServer)}`,
      metrics: [],
    };
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "pi-code-feedback-perf-ts-hover-"));
  const filePath = path.join(root, "probe.ts");
  const logPath = path.join(root, "lsp-proxy.jsonl");
  const lineCount = 1000;
  const warmup = 2;
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", devDependencies: { typescript: "^5.9.3" } }, null, 2), "utf8");
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }, null, 2), "utf8");
  await writeFile(filePath, makeTsContent(0, lineCount), "utf8");
  await writeFile(logPath, "", "utf8");

  const lspService = createLspService({
    projectRoot: root,
    idleTimeoutMs: 0,
    serverOverrides: {
      typescript: {
        command: process.execPath,
        args: [lspStdioProxy, logPath, "--", tsLanguageServer, "--stdio"],
      },
    },
  });

  try {
    return await runScenario({
      name: "lsp/typescript-hover",
      iterations,
      warmup,
      notes: `real typescript-language-server hover requests behind a stdio proxy; ${lineCount}-line file; protocol counters exclude warmup`,
      beforeMeasure: () => fs.writeFileSync(logPath, "", "utf8"),
      counters: () => summarizeLspProxyCounters(logPath),
      resources: () => lspRootPids(lspService),
      operation: async () => {
        const hover = await timed("hover", () => lspService.hover(filePath, 1, 15));
        assertHoverResult(hover.value);
        return withTotal([hover]);
      },
    });
  } finally {
    await lspService.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
}

function makeRuntime(root, options) {
  const config = createDefaultConfig();
  config.enabled = options.enabled;
  config.lsp.enabled = options.lsp;
  config.autoFormat = options.format;
  config.diagnostics.settleMs = 0;
  const runtime = createRuntime(config);
  setProjectRoot(runtime, root);
  return runtime;
}

function makeFormatService(root, runtime, mode) {
  if (mode === false) return undefined;
  if (mode === "fake-noop" || mode === "fake-change") {
    runtime.config.formatters = {
      prettier: {
        enabled: true,
        command: process.execPath,
        args: [fakeFormatter, mode === "fake-noop" ? "--mode=noop" : "--mode=top-comment", "{file}"],
      },
    };
  }
  return createFormatService({ projectRoot: root, formatterOverrides: runtime.config.formatters });
}

function makeEditOperation({ root, runtime, filePath, lspService, formatService, content, unchanged = false, expectCompletedEdit = false, expectTouchedRanges = true, expectFeedback = false, expectFormatted = false }) {
  let version = 0;
  return async (index) => {
    beginTurn(runtime);
    const nextVersion = unchanged ? version : version + 1;
    const toolCallId = `edit-${index}-${nextVersion}`;
    const before = content(version);
    const after = content(nextVersion);
    const input = { path: path.relative(root, filePath) };

    const call = await timed("tool_call", () => handleToolCall({ toolName: "edit", toolCallId, input }, { cwd: root }, runtime, lspService));
    await writeFile(filePath, after, "utf8");
    const result = await timed("tool_result", () => handleToolResult({
      toolName: "edit",
      toolCallId,
      input,
      details: unchanged ? {} : { diff: firstLineDiff(before, after) },
      content: [{ type: "text", text: "edited" }],
      isError: false,
    }, { cwd: root }, runtime, lspService, formatService));
    if (expectCompletedEdit) assertCompletedEdit(runtime, { expectTouchedRanges });
    if (expectFeedback) assertPiFeedback(result.value);
    if (expectFormatted) await assertFormatted(filePath);
    version = nextVersion;
    return withTotal([call, result]);
  };
}

async function runScenario({ name, iterations, operation, warmup = 0, beforeMeasure, counters, resources, notes }) {
  for (let index = 0; index < warmup; index += 1) {
    await operation(index, true);
  }

  if (beforeMeasure) await beforeMeasure();

  collectGarbageIfAvailable();
  const metricValues = new Map();
  const processCpuStart = process.cpuUsage();
  const mainRssStart = process.memoryUsage().rss;
  let peakMainRss = mainRssStart;
  let peakChildRss = 0;
  const childStart = resources ? collectProcessTree(resources()) : emptyProcessSnapshot();

  for (let index = 0; index < iterations; index += 1) {
    const entries = await operation(index, false);
    for (const entry of entries) recordMetric(metricValues, entry);
    peakMainRss = Math.max(peakMainRss, process.memoryUsage().rss);
    if (resources) {
      peakChildRss = Math.max(peakChildRss, collectProcessTree(resources()).rssBytes);
    }
  }

  const processCpu = process.cpuUsage(processCpuStart);
  const mainRssEnd = process.memoryUsage().rss;
  peakMainRss = Math.max(peakMainRss, mainRssEnd);
  const childRootPidsEnd = resources ? resources() : [];
  const childRootPidExists = childRootPidsEnd.filter((pid) => fs.existsSync(`/proc/${pid}`));
  const childEnd = resources ? collectProcessTree(childRootPidsEnd) : emptyProcessSnapshot();

  const counterValues = counters ? await counters() : undefined;

  return {
    name,
    iterations,
    warmup,
    notes,
    metrics: [...metricValues.entries()].map(([label, values]) => ({
      label,
      wallMs: summarize(values.wallMs),
      cpuMs: summarize(values.cpuMs),
    })),
    resources: {
      processCpuMs: microsecondsToMilliseconds(processCpu.user + processCpu.system),
      mainRssStartMb: bytesToMiB(mainRssStart),
      mainRssEndMb: bytesToMiB(mainRssEnd),
      mainRssPeakMb: bytesToMiB(peakMainRss),
      childCpuMs: diffProcessCpuMs(childStart, childEnd),
      childRssEndMb: bytesToMiB(childEnd.rssBytes),
      childRssPeakMb: bytesToMiB(Math.max(peakChildRss, childEnd.rssBytes)),
      childRootPids: childRootPidsEnd,
      childRootPidExists,
      childPids: childEnd.pids,
    },
    counters: counterValues,
  };
}

async function timed(label, fn) {
  const cpuStart = process.cpuUsage();
  const startedAt = performance.now();
  const value = await fn();
  const wallMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuStart);
  return { label, wallMs, cpuMs: microsecondsToMilliseconds(cpu.user + cpu.system), value };
}

function assertCompletedEdit(runtime, options = {}) {
  const edit = runtime.completedEdits.at(-1);
  if (!edit) throw new Error("benchmark sanity check failed: edit was not recorded");
  if (options.expectTouchedRanges !== false && edit.touchedRanges.length === 0) throw new Error("benchmark sanity check failed: edit was not recorded with touched ranges");
}

function assertPiFeedback(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const found = content.some((part) => part?.type === "text" && typeof part.text === "string" && part.text.includes("pi-code-feedback:"));
  if (!found) throw new Error("benchmark sanity check failed: expected inline pi-code-feedback diagnostics");
}

function assertHoverResult(result) {
  if (!markupHasText(result?.contents)) throw new Error("benchmark sanity check failed: expected a hover result");
}

function markupHasText(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(markupHasText);
  if (!value || typeof value !== "object") return false;
  if (typeof value.value === "string") return value.value.trim().length > 0;
  return false;
}

async function assertFormatted(filePath) {
  const content = await readFile(filePath, "utf8");
  if (!content.startsWith("// formatted\n")) throw new Error("benchmark sanity check failed: fake formatter did not rewrite the file");
}

function withTotal(entries) {
  return [
    ...entries,
    {
      label: "total",
      wallMs: entries.reduce((sum, entry) => sum + entry.wallMs, 0),
      cpuMs: entries.reduce((sum, entry) => sum + entry.cpuMs, 0),
    },
  ];
}

function recordMetric(metricValues, entry) {
  const values = metricValues.get(entry.label) ?? { wallMs: [], cpuMs: [] };
  values.wallMs.push(entry.wallMs);
  values.cpuMs.push(entry.cpuMs);
  metricValues.set(entry.label, values);
}

function summarize(values) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    min: sorted[0],
    p50: percentile(sorted, 0.50),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

function percentile(sorted, fraction) {
  if (sorted.length === 1) return sorted[0];
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function printHuman(output) {
  const meta = output.meta;
  console.log(`pi-code-feedback performance benchmark`);
  console.log(`node=${meta.node} platform=${meta.platform} baseIterations=${meta.baseIterations} live=${meta.live} exposeGc=${meta.exposeGc}`);
  for (const result of output.results) {
    console.log(`\n${result.name}  iterations=${result.iterations} warmup=${result.warmup ?? 0}${result.skipped ? " SKIPPED" : ""}`);
    if (result.notes) console.log(`  ${result.notes}`);
    if (result.skipped) continue;
    for (const metric of result.metrics) {
      console.log(`  ${metric.label.padEnd(12)} wall p50=${fmtMs(metric.wallMs.p50)} p95=${fmtMs(metric.wallMs.p95)} max=${fmtMs(metric.wallMs.max)} | cpu p50=${fmtMs(metric.cpuMs.p50)} p95=${fmtMs(metric.cpuMs.p95)}`);
    }
    const resources = result.resources;
    if (result.counters) {
      const entries = Object.entries(result.counters).filter(([, value]) => value !== undefined);
      if (entries.length > 0) {
        console.log(`  counters ${entries.map(([key, value]) => `${key}=${fmtCounter(key, value)}`).join(" ")}`);
      }
    }
    console.log(`  rss main ${fmtMiB(resources.mainRssStartMb)} → ${fmtMiB(resources.mainRssEndMb)} peak ${fmtMiB(resources.mainRssPeakMb)} | child peak ${fmtMiB(resources.childRssPeakMb)} roots=${resources.childRootPids.join(",") || "-"} liveRoots=${resources.childRootPidExists.join(",") || "-"} pids=${resources.childPids.join(",") || "-"}`);
    console.log(`  cpu process=${fmtMs(resources.processCpuMs)} child=${fmtMs(resources.childCpuMs)}`);
  }
}

function summarizeLspProxyCounters(logPath, options = {}) {
  const events = readJsonLines(logPath);
  const clientMessages = events.filter((event) => event.direction === "client-to-server");
  const didOpen = clientMessages.filter((event) => event.method === "textDocument/didOpen");
  const didChange = clientMessages.filter((event) => event.method === "textDocument/didChange");
  const didSave = clientMessages.filter((event) => event.method === "textDocument/didSave");
  const hover = clientMessages.filter((event) => event.method === "textDocument/hover");
  const didChangeBytes = sumNumbers(didChange.map((event) => event.bodyBytes));
  const documentSyncMessages = [...didOpen, ...didChange, ...didSave];
  const fullEquivalentBytes = options.fullTextForDidChange
    ? sumNumbers(didChange.map((event, index) => estimatedFullDidChangeBytes(event, options.fullTextForDidChange(index))))
    : undefined;

  return {
    lspMessagesClientToServer: clientMessages.length,
    lspBytesClientToServer: sumNumbers(clientMessages.map((event) => event.bodyBytes)),
    lspDocumentSyncCount: documentSyncMessages.length,
    lspDocumentSyncBytes: sumNumbers(documentSyncMessages.map((event) => event.bodyBytes)),
    lspHoverCount: hover.length,
    lspHoverBytes: sumNumbers(hover.map((event) => event.bodyBytes)),
    lspDidOpenCount: didOpen.length,
    lspDidOpenTextBytes: sumNumbers(didOpen.map((event) => event.textDocumentTextBytes)),
    lspDidSaveCount: didSave.length,
    lspDidSaveBytes: sumNumbers(didSave.map((event) => event.bodyBytes)),
    lspDidSaveTextBytes: sumNumbers(didSave.map((event) => event.paramsTextBytes)),
    lspDidChangeCount: didChange.length,
    lspDidChangeBytes: didChangeBytes,
    lspDidChangeMeanBytes: didChange.length > 0 ? didChangeBytes / didChange.length : undefined,
    lspDidChangeTextBytes: sumNumbers(didChange.map((event) => event.contentChangeTextBytes)),
    lspDidChangeRangedCount: sumNumbers(didChange.map((event) => event.contentChangeRangeCount)),
    lspDidChangeFullTextCount: sumNumbers(didChange.map((event) => event.contentChangeFullTextCount)),
    lspDidChangeFullEquivalentBytes: fullEquivalentBytes,
    lspDidChangeReductionRatio: fullEquivalentBytes && didChangeBytes > 0 ? fullEquivalentBytes / didChangeBytes : undefined,
  };
}

function readJsonLines(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function estimatedFullDidChangeBytes(event, text) {
  if (typeof event.uri !== "string" || typeof event.version !== "number") return 0;
  return Buffer.byteLength(JSON.stringify({
    jsonrpc: "2.0",
    method: "textDocument/didChange",
    params: {
      textDocument: { uri: event.uri, version: event.version },
      contentChanges: [{ text }],
    },
  }), "utf8");
}

function sumNumbers(values) {
  return values.reduce((total, value) => total + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0);
}

function editScenarioNotes(options) {
  if (!options.enabled) return "same edit workload with pi-code-feedback disabled";
  if (options.format === "detect-none") return "LSP disabled; auto-format enabled but no formatter is configured";
  if (options.unchanged) return "LSP disabled; fake formatter is configured, but the tool result leaves file content unchanged";
  if (options.format === "fake-noop") return "LSP disabled; fake formatter is configured and spawned but leaves the file unchanged";
  if (options.name === "formatter/fake-map-large") return "LSP disabled; fake formatter rewrites a large file so LCS touched-range remapping is stressed";
  if (options.format === "fake-change") return "LSP disabled; fake formatter rewrites the file so formatter mapping is exercised";
  return "LSP and formatter disabled; measures path resolution, file read, touched-range and details work";
}

function makeTsContent(version, lineCount) {
  const lines = [`export const value: number = ${version};`];
  for (let line = 2; line <= lineCount; line += 1) {
    lines.push(`export const filler${line}: number = ${line};`);
  }
  return `${lines.join("\n")}\n`;
}

function makeTsErrorContent(version, lineCount) {
  const lines = [`export const value: number = "version-${version}";`];
  for (let line = 2; line <= lineCount; line += 1) {
    lines.push(`export const filler${line}: number = ${line};`);
  }
  return `${lines.join("\n")}\n`;
}

function firstLineDiff(before, after) {
  return `@@ -1,1 +1,1 @@\n-${before.split("\n")[0]}\n+${after.split("\n")[0]}\n`;
}

function lspRootPids(lspService) {
  return lspService.getStatus().clients.map((client) => client.pid).filter((pid) => typeof pid === "number");
}

const clockTicksPerSecond = readClockTicksPerSecond();

function collectProcessTree(rootPids) {
  const roots = [...new Set(rootPids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (roots.length === 0) return emptyProcessSnapshot();

  const table = readProcTable();
  for (const root of roots) {
    if (!table.has(root)) {
      const info = readProcInfo(root, true);
      if (info) table.set(root, info);
    }
  }
  const childrenByPpid = new Map();
  for (const info of table.values()) {
    const children = childrenByPpid.get(info.ppid) ?? [];
    children.push(info.pid);
    childrenByPpid.set(info.ppid, children);
  }

  const wanted = new Set();
  const stack = roots.filter((pid) => table.has(pid));
  while (stack.length > 0) {
    const pid = stack.pop();
    if (wanted.has(pid)) continue;
    wanted.add(pid);
    for (const child of childrenByPpid.get(pid) ?? []) stack.push(child);
  }

  const byPid = new Map();
  let rssBytes = 0;
  let cpuMs = 0;
  for (const pid of wanted) {
    const info = table.get(pid);
    if (!info) continue;
    byPid.set(pid, info);
    rssBytes += info.rssBytes;
    cpuMs += info.cpuMs;
  }

  return { pids: [...byPid.keys()].sort((left, right) => left - right), byPid, rssBytes, cpuMs };
}

function emptyProcessSnapshot() {
  return { pids: [], byPid: new Map(), rssBytes: 0, cpuMs: 0 };
}

function readProcTable() {
  const table = new Map();
  let entries;
  try {
    entries = fs.readdirSync("/proc", { withFileTypes: true });
  } catch {
    return table;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number.parseInt(entry.name, 10);
    const info = readProcInfo(pid);
    if (info) table.set(pid, info);
  }
  return table;
}

function readProcInfo(pid, allowPsFallback = false) {
  let status = "";
  let stat = "";
  try {
    status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return allowPsFallback ? readPsInfo(pid) : undefined;
  }

  try {
    const ppid = numberFromStatus(status, "PPid") ?? 0;
    const rssKb = numberFromStatus(status, "VmRSS") ?? rssKbFromStatm(pid) ?? 0;
    const afterCommand = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const utimeTicks = Number.parseInt(afterCommand[11] ?? "0", 10);
    const stimeTicks = Number.parseInt(afterCommand[12] ?? "0", 10);
    return {
      pid,
      ppid,
      rssBytes: rssKb * 1024,
      cpuMs: ((utimeTicks + stimeTicks) / clockTicksPerSecond) * 1000,
    };
  } catch {
    return allowPsFallback ? readPsInfo(pid) : undefined;
  }
}

function readPsInfo(pid) {
  const result = spawnSync("ps", ["-o", "pid=,ppid=,rss=,time=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) return fs.existsSync(`/proc/${pid}`) ? { pid, ppid: 0, rssBytes: 0, cpuMs: 0 } : undefined;
  const line = result.stdout.trim().split("\n").at(-1)?.trim();
  if (!line) return undefined;
  const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) return undefined;
  return {
    pid: Number.parseInt(match[1], 10),
    ppid: Number.parseInt(match[2], 10),
    rssBytes: Number.parseInt(match[3], 10) * 1024,
    cpuMs: parsePsCpuTimeMs(match[4].trim()),
  };
}

function parsePsCpuTimeMs(value) {
  const dayParts = value.split("-");
  const days = dayParts.length === 2 ? Number.parseInt(dayParts[0], 10) : 0;
  const time = dayParts.at(-1) ?? "0:00";
  const parts = time.split(":").map((part) => Number.parseInt(part, 10));
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0] ?? 0, parts[1] ?? 0];
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function rssKbFromStatm(pid) {
  try {
    const statm = fs.readFileSync(`/proc/${pid}/statm`, "utf8").trim().split(/\s+/);
    const residentPages = Number.parseInt(statm[1] ?? "0", 10);
    return Number.isFinite(residentPages) ? residentPages * 4 : undefined;
  } catch {
    return undefined;
  }
}

function numberFromStatus(status, key) {
  const match = status.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function diffProcessCpuMs(before, after) {
  let total = 0;
  for (const [pid, info] of after.byPid.entries()) {
    const previous = before.byPid.get(pid)?.cpuMs ?? 0;
    total += Math.max(0, info.cpuMs - previous);
  }
  return total;
}

function readClockTicksPerSecond() {
  const result = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
  const value = Number.parseInt(result.stdout, 10);
  return Number.isFinite(value) && value > 0 ? value : 100;
}

function collectGarbageIfAvailable() {
  if (typeof globalThis.gc === "function") globalThis.gc();
}

function microsecondsToMilliseconds(value) {
  return value / 1000;
}

function bytesToMiB(value) {
  return value / 1024 / 1024;
}

function fmtMs(value) {
  if (value === undefined) return "n/a";
  if (value < 10) return `${value.toFixed(3)}ms`;
  if (value < 100) return `${value.toFixed(2)}ms`;
  return `${value.toFixed(1)}ms`;
}

function fmtCounter(key, value) {
  if (typeof value !== "number") return String(value);
  if (key.toLowerCase().includes("bytes")) return fmtBytes(value);
  if (key.toLowerCase().includes("ratio")) return `${value.toFixed(1)}x`;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function fmtBytes(value) {
  if (value < 1024) return `${Math.round(value)}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KiB`;
  return `${(value / 1024 / 1024).toFixed(2)}MiB`;
}

function fmtMiB(value) {
  return `${value.toFixed(1)}MiB`;
}

function sanitizeName(name) {
  return name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}
