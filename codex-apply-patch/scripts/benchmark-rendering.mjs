import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { buildPiHighlightedDiff } from "../src/pierre/highlight.ts";
import { DEFAULT_PIERRE_RENDERER_CONFIG } from "../src/pierre/config.ts";
import {
  baselineHighlightedDiff,
  changedFileMetadata,
  makeMetadata,
} from "./rendering-baseline.mjs";

const workerPath = fileURLToPath(
  new URL("../src/pierre/tree-sitter-worker.cjs", import.meta.url),
);

const config = {
  ...DEFAULT_PIERRE_RENDERER_CONFIG,
  syntaxHighlight: {
    ...DEFAULT_PIERRE_RENDERER_CONFIG.syntaxHighlight,
    enabled: true,
    maxLines: 20000,
    maxLineLength: 20000,
  },
};

const fixtures = [
  {
    name: "dense",
    metadata: changedFileMetadata({
      name: "large.ts",
      lang: "typescript",
      before: makeFile(220, false),
      after: makeFile(220, true),
      cacheKey: "benchmark-large-ts-dense",
    }),
  },
  {
    name: "sparse",
    metadata: sparseMetadata(),
  },
];

const iterations = Number(process.env.PI_RENDER_BENCH_ITERATIONS ?? 40);
const workerIterations = Number(
  process.env.PI_RENDER_WORKER_BENCH_ITERATIONS ?? Math.min(8, iterations),
);

for (const fixture of fixtures) {
  const { metadata } = fixture;
  if (global.gc) global.gc();
  baselineHighlightedDiff(metadata, config);
  buildPiHighlightedDiff(metadata, config);

  const baseline = measure("baseline", () => baselineHighlightedDiff(metadata, config));
  const optimized = measure("optimized", () => buildPiHighlightedDiff(metadata, config));

  console.log(
    `fixture: ${fixture.name}, ${metadata.additionLines.length} TypeScript lines, ${iterations} iterations`,
  );
  console.table([
    formatResult(baseline),
    formatResult(optimized),
    {
      name: "delta",
      "wall ms": (optimized.wallMs - baseline.wallMs).toFixed(1),
      "cpu ms": (optimized.cpuMs - baseline.cpuMs).toFixed(1),
      "heap MiB": (optimized.heapMiB - baseline.heapMiB).toFixed(2),
      speedup: `${(baseline.wallMs / optimized.wallMs).toFixed(2)}×`,
    },
  ]);
}

const workerMetadata = sparseMetadata();
const workerIndexes = renderedLineIndexes(workerMetadata);
const workerJobs = [
  { lines: workerMetadata.deletionLines, indexes: workerIndexes.deletion },
  { lines: workerMetadata.additionLines, indexes: workerIndexes.addition },
];
const singleWorker = measure(
  "two single spawns",
  () => {
    workerCaptures("typescript", workerJobs[0].lines, workerJobs[0].indexes);
    workerCaptures("typescript", workerJobs[1].lines, workerJobs[1].indexes);
  },
  workerIterations,
);
const batchWorker = measure(
  "one batch spawn",
  () => workerBatchCaptures("typescript", workerJobs),
  workerIterations,
);

console.log(
  `fixture: worker fallback, ${workerMetadata.additionLines.length} TypeScript lines, ${workerIterations} iterations`,
);
console.table([
  formatResult(singleWorker),
  formatResult(batchWorker),
  {
    name: "delta",
    "wall ms": (batchWorker.wallMs - singleWorker.wallMs).toFixed(1),
    "cpu ms": (batchWorker.cpuMs - singleWorker.cpuMs).toFixed(1),
    "heap MiB": (batchWorker.heapMiB - singleWorker.heapMiB).toFixed(2),
    speedup: `${(singleWorker.wallMs / batchWorker.wallMs).toFixed(2)}×`,
  },
]);

function measure(name, fn, count = iterations) {
  if (global.gc) global.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  const wallBefore = performance.now();

  for (let i = 0; i < count; i++) fn();

  const wallMs = performance.now() - wallBefore;
  const cpu = process.cpuUsage(cpuBefore);
  const heapAfter = process.memoryUsage().heapUsed;
  return {
    name,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    heapMiB: (heapAfter - heapBefore) / 1024 / 1024,
  };
}

function workerCaptures(languageKey, lines, indexes) {
  const result = spawnSync(process.execPath, [workerPath], {
    input: JSON.stringify({ languageKey, lines, indexes }),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout).captures;
}

function workerBatchCaptures(languageKey, jobs) {
  const result = spawnSync(process.execPath, [workerPath], {
    input: JSON.stringify({ languageKey, jobs }),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout).jobs;
}

function formatResult(result) {
  return {
    name: result.name,
    "wall ms": result.wallMs.toFixed(1),
    "cpu ms": result.cpuMs.toFixed(1),
    "heap MiB": result.heapMiB.toFixed(2),
    speedup: "",
  };
}

function makeFile(count, changed) {
  const lines = [];
  lines.push("type Item = { id: number; label: string; enabled: boolean };");
  lines.push("export class Registry {");
  lines.push("  private items = new Map<number, Item>();");
  for (let i = 0; i < count; i++) {
    const value = changed && i % 7 === 0 ? i + 1000 : i;
    const enabled = changed && i % 11 === 0 ? "false" : "true";
    lines.push(`  item${i}(): Item {`);
    lines.push(
      `    const item: Item = { id: ${value}, label: "item-${i}", enabled: ${enabled} };`,
    );
    lines.push("    this.items.set(item.id, item);");
    lines.push("    return item;");
    lines.push("  }");
  }
  lines.push("}");
  lines.push("export const registry = new Registry();");
  return lines;
}

function sparseMetadata() {
  const before = makeFile(220, false);
  const after = [...before];
  const changedRows = [8, 103, 257, 509, 801, 1002];
  for (const row of changedRows) {
    after[row] = before[row].replace(/\d+/, (value) => String(Number(value) + 1000));
  }

  return makeMetadata({
    name: "large-sparse.ts",
    lang: "typescript",
    deletionLines: before,
    additionLines: after,
    hunkContent: changedRows.map((row) => ({
      type: "change",
      deletions: 1,
      deletionLineIndex: row,
      additions: 1,
      additionLineIndex: row,
    })),
    cacheKey: "benchmark-large-ts-sparse",
  });
}

function renderedLineIndexes(metadata) {
  const deletion = new Set();
  const addition = new Set();

  for (const hunk of metadata.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        addRange(addition, content.additionLineIndex, content.lines);
        continue;
      }

      addRange(deletion, content.deletionLineIndex, content.deletions);
      addRange(addition, content.additionLineIndex, content.additions);
    }
  }

  return {
    deletion: [...deletion].sort((a, b) => a - b),
    addition: [...addition].sort((a, b) => a - b),
  };
}

function addRange(target, start, count) {
  for (let i = 0; i < count; i++) target.add(start + i);
}
