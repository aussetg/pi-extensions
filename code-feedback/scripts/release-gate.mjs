#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(here);

export const CONFORMANCE_REQUIREMENTS = [
  requirement("authoritative document diagnostics", [
    evidence("tests/lsp-service.test.mjs", "an empty pull diagnostic report is fresh and authoritatively clean"),
    evidence("tests/lsp-service.test.mjs", "a malformed pull response is never interpreted as clean"),
    evidence("tests/lsp-tool.test.mjs", "explicit diagnostic timeouts fail without returning cached diagnostics"),
  ]),
  requirement("stale-safe delayed feedback", [
    evidence("tests/delayed-staleness.test.mjs", "a newer mutation aborts an in-flight delayed diagnostic refresh"),
    evidence("tests/delayed-staleness.test.mjs", "context injection rejects feedback when the file changed outside tracked mutation hooks"),
  ]),
  requirement("active-client filesystem mutation propagation", [
    evidence("tests/file-mutation-notifications.test.mjs", "watched-file notifications use LSP event types, clear stale diagnostics, and never start a client"),
    evidence("tests/file-mutation-notifications.test.mjs", "apply_patch announces the complete sibling batch before diagnostics and re-announces formatter writes"),
  ]),
  requirement("bounded and cancellable JSON-RPC transport", [
    evidence("tests/lsp-transport.test.mjs", "aborting a queued request drops it without killing a healthy client"),
    evidence("tests/lsp-transport.test.mjs", "an in-flight write that exceeds its deadline fails and kills the wedged client"),
    evidence("tests/lsp-transport.test.mjs", "oversized inbound frames fail the client before buffering their declared body"),
  ]),
  requirement("exact symbol occurrence targeting", [
    evidence("tests/lsp-positions.test.mjs", "symbol position targets resolve exact case-sensitive occurrences with LSP UTF-16 offsets"),
    evidence("tests/lsp-tool.test.mjs", "lsp position methods resolve exact symbols and explicit occurrences"),
  ]),
  requirement("nested roots and language/linter routing", [
    evidence("tests/lsp-routing.test.mjs", "one server id starts independent clients for nested workspace roots"),
    evidence("tests/lsp-routing.test.mjs", "automatic semantic requests exclude linters while diagnostics and explicit selection retain them"),
  ]),
  requirement("bounded client process resources", [
    evidence("tests/lsp-resources.test.mjs", "initialization concurrency bounds simultaneous process startups"),
    evidence("tests/lsp-resources.test.mjs", "the active-client budget evicts the least recently used idle client"),
    evidence("tests/lsp-resources.test.mjs", "service shutdown cancels queued starts without launching an orphan process"),
  ]),
  requirement("capability-gated workspace diagnostics", [
    evidence("tests/workspace-diagnostics.test.mjs", "active workspace diagnostics prefer one capability-gated workspace pull"),
    evidence("tests/workspace-diagnostics.test.mjs", "missing, malformed, oversized, timed-out, and unsupported workspace reports fall back without false clean results"),
    evidence("tests/workspace-diagnostics.test.mjs", "active workspace diagnostics enforce file and traversal bounds"),
  ]),
  requirement("preview-first transactional file rename", [
    evidence("tests/lsp-tool.test.mjs", "lsp file rename previews server edits and applies one safe transaction"),
    evidence("tests/workspace-edit.test.mjs", "file rename transaction rolls back text edits when the filesystem move fails"),
    evidence("tests/workspace-edit.test.mjs", "file rename transaction never overwrites a destination created during commit"),
  ]),
  requirement("bounded external mutation reconciliation", [
    evidence("tests/external-mutation-reconciliation.test.mjs", "successful bash results reconcile changed open documents and invalidate delayed feedback"),
    evidence("tests/external-mutation-reconciliation.test.mjs", "open-document reconciliation is file-bounded, handles deletions, and never launches a client"),
  ]),
  requirement("non-causal workspace impact reporting", [
    evidence("tests/workspace-delta.test.mjs", "new cross-file diagnostics are labeled as possible workspace impact and never fail strict edits"),
    evidence("tests/workspace-delta.test.mjs", "late possible workspace impacts use the stale-safe delayed context queue"),
  ]),
  requirement("trusted atomic server configuration", [
    evidence("tests/server-config.test.mjs", "untrusted project language-server config is not read"),
    evidence("tests/server-config.test.mjs", "an invalid config source is rejected atomically with an actionable status error"),
  ]),
  requirement("preview-first rollback-safe WorkspaceEdits", [
    evidence("tests/workspace-edit.test.mjs", "partial multi-file commit failure rolls back already replaced files"),
    evidence("tests/workspace-edit.test.mjs", "workspace edit rejects target changes made after preview"),
    evidence("tests/workspace-edit.test.mjs", "workspace edit cancellation while queued prevents a late mutation"),
  ]),
  requirement("bounded tool and source data", [
    evidence("tests/lsp-tool.test.mjs", "lsp tool text is truncated and saved to a temp file"),
    evidence("tests/lsp-tool.test.mjs", "lsp tool details are summarized under a bounded budget"),
    evidence("tests/lsp-tool.test.mjs", "explicit LSP operations reject oversized source files before starting a server"),
  ]),
];

export const PERFORMANCE_GATES = [
  wallGate("idle hook overhead", "hook/noop", 0.1),
  wallGate("ignored tool overhead", "tool/nontracked", 0.1),
  wallGate("no-LSP edit overhead", "edit/no-lsp-no-format", 2),
  wallGate("five-file patch overhead", "apply-patch/no-lsp-no-format", 2),
  wallGate("warm fake-LSP edit", "lsp/fake-warm", 2.5),
  wallGate("watched notification without a client", "lsp/watched-no-client", 1, { requireNoChildProcess: true }),
  wallGate("watched notification with an active client", "lsp/watched-active", 1),
  wallGate("shell reconciliation without a client", "lsp/reconcile-no-client", 1, { requireNoChildProcess: true }),
  wallGate("one changed open-document reconciliation", "lsp/reconcile-open-change", 2),
  wallGate("20-file workspace pull", "lsp/workspace-pull-clean-20", 10),
  wallGate("delayed diagnostic inline budget", "lsp/fake-delay-200", 90),
  wallGate("diagnostic timeout budget", "lsp/fake-timeout-80", 90),
];

export function verifyConformanceCoverage(root = packageRoot) {
  const testsRoot = path.join(root, "tests");
  const testFiles = readdirSync(testsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => `tests/${entry.name}`)
    .sort();
  const discovered = new Map(testFiles.map((file) => [file, discoverTestNames(readFileSync(path.join(root, file), "utf8"))]));
  const failures = [];

  for (const entry of CONFORMANCE_REQUIREMENTS) {
    for (const item of entry.evidence) {
      const names = discovered.get(item.file);
      if (!names) failures.push(`${entry.capability}: missing test file ${item.file}`);
      else if (!names.has(item.test)) failures.push(`${entry.capability}: missing test ${item.file} — ${JSON.stringify(item.test)}`);
    }
  }

  return {
    requirementCount: CONFORMANCE_REQUIREMENTS.length,
    referencedTestCount: CONFORMANCE_REQUIREMENTS.reduce((total, entry) => total + entry.evidence.length, 0),
    discoveredTestCount: [...discovered.values()].reduce((total, names) => total + names.size, 0),
    failures,
  };
}

export function evaluatePerformanceReport(report) {
  const failures = [];
  const results = [];
  if (!isRecord(report) || !isRecord(report.meta) || !Array.isArray(report.results)) {
    return { results, failures: ["benchmark report has an invalid shape"] };
  }
  if (typeof report.meta.baseIterations !== "number" || !Number.isFinite(report.meta.baseIterations) || report.meta.baseIterations < 30) {
    failures.push(`benchmark base iterations must be at least 30, got ${String(report.meta.baseIterations)}`);
  }
  if (report.meta.exposeGc !== true) failures.push("benchmark must run with --expose-gc");

  for (const gate of PERFORMANCE_GATES) {
    const scenario = report.results.find((candidate) => isRecord(candidate) && candidate.name === gate.scenario);
    const total = Array.isArray(scenario?.metrics)
      ? scenario.metrics.find((metric) => isRecord(metric) && metric.label === "total")
      : undefined;
    const actual = isRecord(total) && isRecord(total.wallMs) ? total.wallMs.p95 : undefined;
    const childRoots = isRecord(scenario?.resources) && Array.isArray(scenario.resources.childRootPids)
      ? scenario.resources.childRootPids
      : undefined;
    const errors = [];
    if (typeof actual !== "number" || !Number.isFinite(actual)) errors.push("missing finite total.wallMs.p95");
    else if (actual > gate.maximumMs) errors.push(`${actual.toFixed(3)} ms > ${gate.maximumMs.toFixed(3)} ms`);
    if (gate.requireNoChildProcess && childRoots?.length !== 0) errors.push(`started ${childRoots?.length ?? "unknown"} child process(es)`);
    if (gate.requireNoChildProcess && childRoots === undefined) errors.push("missing child-process accounting");
    results.push({ ...gate, actualMs: actual, pass: errors.length === 0, errors });
    failures.push(...errors.map((error) => `${gate.name}: ${error}`));
  }

  return { results, failures };
}

function discoverTestNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/\btest\(\s*"((?:\\.|[^"\\])*)"/g)) {
    names.add(JSON.parse(`"${match[1]}"`));
  }
  return names;
}

function requirement(capability, evidenceEntries) {
  return Object.freeze({ capability, evidence: Object.freeze(evidenceEntries) });
}

function evidence(file, test) {
  return Object.freeze({ file, test });
}

function wallGate(name, scenario, maximumMs, options = {}) {
  return Object.freeze({ name, scenario, maximumMs, requireNoChildProcess: options.requireNoChildProcess === true });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argv) {
  const options = { json: false, skipPerformance: false, performanceReport: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--skip-perf") options.skipPerformance = true;
    else if (argument === "--perf-report") options.performanceReport = argv[++index];
    else if (argument.startsWith("--perf-report=")) options.performanceReport = argument.slice("--perf-report=".length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.skipPerformance && options.performanceReport) throw new Error("--skip-perf and --perf-report are mutually exclusive");
  return options;
}

function collectPerformanceReport(options) {
  if (options.skipPerformance) return undefined;
  if (options.performanceReport) return JSON.parse(readFileSync(path.resolve(options.performanceReport), "utf8"));

  const benchmark = spawnSync(process.execPath, ["--expose-gc", path.join(here, "perf-bench.mjs"), "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (benchmark.error) throw benchmark.error;
  if (benchmark.status !== 0) {
    throw new Error(`performance benchmark failed with status ${String(benchmark.status)}\n${benchmark.stderr.trim()}`);
  }
  return JSON.parse(benchmark.stdout);
}

function renderHuman(conformance, performance) {
  const lines = [];
  lines.push(`${conformance.failures.length === 0 ? "PASS" : "FAIL"} conformance: ${conformance.requirementCount} contracts, ${conformance.referencedTestCount} references, ${conformance.discoveredTestCount} discovered tests`);
  for (const failure of conformance.failures) lines.push(`  FAIL ${failure}`);
  if (!performance) return lines.join("\n");
  lines.push(`${performance.failures.length === 0 ? "PASS" : "FAIL"} performance: ${performance.results.length} gates`);
  for (const result of performance.results) {
    const actual = typeof result.actualMs === "number" ? `${result.actualMs.toFixed(3)} ms` : "missing";
    lines.push(`  ${result.pass ? "PASS" : "FAIL"} ${result.name}: ${actual} ≤ ${result.maximumMs.toFixed(3)} ms`);
  }
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const conformance = verifyConformanceCoverage();
  const report = collectPerformanceReport(options);
  const performance = report ? evaluatePerformanceReport(report) : undefined;
  const pass = conformance.failures.length === 0 && (!performance || performance.failures.length === 0);
  const output = { pass, conformance, performance, benchmarkMeta: report?.meta };
  console.log(options.json ? JSON.stringify(output, null, 2) : renderHuman(conformance, performance));
  if (!pass) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
