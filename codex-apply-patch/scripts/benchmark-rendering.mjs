import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { renderAnsiSegments } from "../src/pierre/ansi.ts";
import {
  buildPiHighlightedDiff,
  loadHighlightedDiff,
} from "../src/pierre/highlight.ts";
import { DEFAULT_PIERRE_RENDERER_CONFIG } from "../src/pierre/config.ts";
import { buildCachedDiffRows, buildDiffRows } from "../src/pierre/rows.ts";
import { getPierrePalette } from "../src/pierre/theme.ts";
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
const ansiIterations = Number(process.env.PI_RENDER_ANSI_BENCH_ITERATIONS ?? 5000);

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

  const highlighted = buildPiHighlightedDiff(metadata, config).dark;
  const palette = getPierrePalette({ name: "dark" }, config);
  const rowCacheKey = `bench:rows:${fixture.name}`;
  buildDiffRows(metadata, highlighted, palette, config);
  buildCachedDiffRows(metadata, highlighted, palette, config, {}, rowCacheKey);
  const uncachedRows = measure("rows uncached", () =>
    buildDiffRows(metadata, highlighted, palette, config),
  );
  const cachedRows = measure("rows cached", () =>
    buildCachedDiffRows(metadata, highlighted, palette, config, {}, rowCacheKey),
  );

  console.log(
    `fixture: ${fixture.name} rows, ${metadata.additionLines.length} TypeScript lines, ${iterations} iterations`,
  );
  console.table([
    formatResult(uncachedRows),
    formatResult(cachedRows),
    {
      name: "delta",
      "wall ms": (cachedRows.wallMs - uncachedRows.wallMs).toFixed(1),
      "cpu ms": (cachedRows.cpuMs - uncachedRows.cpuMs).toFixed(1),
      "heap MiB": (cachedRows.heapMiB - uncachedRows.heapMiB).toFixed(2),
      speedup: `${(uncachedRows.wallMs / cachedRows.wallMs).toFixed(2)}×`,
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
  "blocking batch spawn",
  () => workerBatchCaptures("typescript", workerJobs),
  workerIterations,
);
await forceTreeSitterWorker(() => loadHighlightedDiff(workerMetadata, config));
const persistentWorker = await measureAsync(
  "persistent async worker",
  () => forceTreeSitterWorker(() => loadHighlightedDiff(workerMetadata, config)),
  workerIterations,
);

console.log(
  `fixture: worker fallback, ${workerMetadata.additionLines.length} TypeScript lines, ${workerIterations} iterations`,
);
console.table([
  formatResult(singleWorker),
  formatResult(batchWorker),
  formatResult(persistentWorker),
  {
    name: "delta",
    "wall ms": (persistentWorker.wallMs - batchWorker.wallMs).toFixed(1),
    "cpu ms": (persistentWorker.cpuMs - batchWorker.cpuMs).toFixed(1),
    "heap MiB": (persistentWorker.heapMiB - batchWorker.heapMiB).toFixed(2),
    speedup: `${(batchWorker.wallMs / persistentWorker.wallMs).toFixed(2)}×`,
  },
]);

const ansiBase = { fg: "#102030", bg: "#405060" };
const ansiSegments = makeAnsiSegments(240);
baselineRenderAnsiSegments(ansiSegments, ansiBase);
renderAnsiSegments(ansiSegments, ansiBase);
const uncachedAnsi = measure(
  "ansi uncached",
  () => baselineRenderAnsiSegments(ansiSegments, ansiBase),
  ansiIterations,
);
const cachedAnsi = measure(
  "ansi cached",
  () => renderAnsiSegments(ansiSegments, ansiBase),
  ansiIterations,
);

console.log(`fixture: ANSI segment rendering, ${ansiIterations} iterations`);
console.table([
  formatResult(uncachedAnsi),
  formatResult(cachedAnsi),
  {
    name: "delta",
    "wall ms": (cachedAnsi.wallMs - uncachedAnsi.wallMs).toFixed(1),
    "cpu ms": (cachedAnsi.cpuMs - uncachedAnsi.cpuMs).toFixed(1),
    "heap MiB": (cachedAnsi.heapMiB - uncachedAnsi.heapMiB).toFixed(2),
    speedup: `${(uncachedAnsi.wallMs / cachedAnsi.wallMs).toFixed(2)}×`,
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

async function measureAsync(name, fn, count = iterations) {
  if (global.gc) global.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  const wallBefore = performance.now();

  for (let i = 0; i < count; i++) await fn();

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

async function forceTreeSitterWorker(fn) {
  const previous = process.env.PI_TREE_SITTER_FORCE_WORKER;
  process.env.PI_TREE_SITTER_FORCE_WORKER = "1";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PI_TREE_SITTER_FORCE_WORKER;
    else process.env.PI_TREE_SITTER_FORCE_WORKER = previous;
  }
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

function makeAnsiSegments(count) {
  const styles = [
    {},
    { fg: "#112233" },
    { bg: "#445566" },
    { fg: "#778899", bg: "#010203" },
    { fg: "\u001b[31m", bg: "\u001b[42m" },
    { bold: true },
    { bold: false, fg: "#abcdef" },
  ];
  return Array.from({ length: count }, (_, index) => ({
    text: `segment-${index} `,
    ...styles[index % styles.length],
  }));
}

function baselineRenderAnsiSegments(segments, base) {
  let output = baselineOpenAnsi(base);
  for (const segment of segments) {
    output += baselineOpenAnsi({
      fg: segment.fg ?? base.fg,
      bg: segment.bg ?? base.bg,
      bold: "bold" in segment ? segment.bold ?? base.bold : base.bold,
    });
    output += segment.text;
  }
  output += baselineOpenAnsi(base);
  return output;
}

function baselineOpenAnsi(style) {
  return [
    `\u001b[${style.bold ? "1" : "22"}m`,
    baselineColorToAnsi(style.fg, "fg"),
    baselineColorToAnsi(style.bg, "bg"),
  ].join("");
}

function baselineColorToAnsi(color, slot) {
  const reset = slot === "fg" ? "\u001b[39m" : "\u001b[49m";
  const normalized = color?.trim();
  if (!normalized) return reset;

  if (normalized.includes("\u001b[")) return normalized;

  const rgb = baselineToRgb(normalized);
  if (!rgb) return reset;

  const prefix = slot === "fg" ? "38" : "48";
  return `\u001b[${prefix};2;${rgb.r};${rgb.g};${rgb.b}m`;
}

function baselineToRgb(hex) {
  const normalized = hex.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) return undefined;

  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
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
