import { performance } from "node:perf_hooks";
import { buildPiHighlightedDiff } from "../src/pierre/highlight.ts";
import { DEFAULT_PIERRE_RENDERER_CONFIG } from "../src/pierre/config.ts";
import {
  baselineHighlightedDiff,
  changedFileMetadata,
} from "./rendering-baseline.mjs";

const config = {
  ...DEFAULT_PIERRE_RENDERER_CONFIG,
  syntaxHighlight: {
    ...DEFAULT_PIERRE_RENDERER_CONFIG.syntaxHighlight,
    enabled: true,
    maxLines: 20000,
    maxLineLength: 20000,
  },
};

const metadata = changedFileMetadata({
  name: "large.ts",
  lang: "typescript",
  before: makeFile(220, false),
  after: makeFile(220, true),
  cacheKey: "benchmark-large-ts",
});

const iterations = Number(process.env.PI_RENDER_BENCH_ITERATIONS ?? 40);

if (global.gc) global.gc();
baselineHighlightedDiff(metadata, config);
buildPiHighlightedDiff(metadata, config);

const baseline = measure("baseline", () => baselineHighlightedDiff(metadata, config));
const optimized = measure("optimized", () => buildPiHighlightedDiff(metadata, config));

console.log(`fixture: ${metadata.additionLines.length} TypeScript lines, ${iterations} iterations`);
console.table([
  formatResult(baseline),
  formatResult(optimized),
  {
    name: "delta",
    "wall ms": (optimized.wallMs - baseline.wallMs).toFixed(1),
    "cpu ms": (optimized.cpuMs - baseline.cpuMs).toFixed(1),
    "heap MiB": (optimized.heapMiB - baseline.heapMiB).toFixed(2),
    "speedup": `${(baseline.wallMs / optimized.wallMs).toFixed(2)}×`,
  },
]);

function measure(name, fn) {
  if (global.gc) global.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  const wallBefore = performance.now();

  for (let i = 0; i < iterations; i++) fn();

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
