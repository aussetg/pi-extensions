import assert from "node:assert/strict";
import test from "node:test";
import { ByteLruCache } from "../src/byte-lru.ts";
import {
  cachedPiHighlight,
  pierreHighlightCacheStats,
  rememberPiHighlight,
  resetPierreHighlightCache,
} from "../src/pierre/highlight-cache.ts";
import { DEFAULT_PIERRE_RENDERER_CONFIG } from "../src/pierre/config.ts";
import {
  buildCachedDiffRows,
  pierreRowCacheStats,
  resetPierreRowCache,
} from "../src/pierre/rows.ts";
import { getPierrePalette } from "../src/pierre/theme.ts";
import { makeMetadata } from "./rendering-baseline.mjs";

test("byte LRU evicts by retained bytes and touches cache hits", () => {
  const cache = new ByteLruCache({ maxEntries: 10, maxBytes: 10 });
  const a = { name: "a" };
  const b = { name: "b" };
  const c = { name: "c" };

  assert.equal(cache.set("a", a, 4), true);
  assert.equal(cache.set("b", b, 4), true);
  assert.equal(cache.get("a"), a);
  assert.equal(cache.set("c", c, 4), true);

  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), a);
  assert.equal(cache.get("c"), c);
  assert.deepEqual(cache.stats(), {
    entries: 2,
    bytes: 8,
    maxEntries: 10,
    maxBytes: 10,
    evictions: 1,
  });

  assert.equal(cache.set("oversized", {}, 11), false);
  assert.equal(cache.get("oversized"), undefined);
});

test("Pierre row cache stays inside its byte budget", () => {
  withEnv("PI_RICH_TOOLS_PIERRE_ROW_CACHE_MAX_BYTES", "16384", () => {
    resetPierreRowCache();
    const config = DEFAULT_PIERRE_RENDERER_CONFIG;
    const palette = getPierrePalette({ name: "dark" }, config);
    const highlighted = { deletionLines: [], additionLines: [] };
    const firstMetadata = cacheMetadata(0);
    const first = buildCachedDiffRows(
      firstMetadata,
      highlighted,
      palette,
      config,
      {},
      "row-budget-0",
    );

    for (let index = 1; index < 40; index += 1) {
      buildCachedDiffRows(
        cacheMetadata(index),
        highlighted,
        palette,
        config,
        {},
        `row-budget-${index}`,
      );
    }

    const stats = pierreRowCacheStats();
    assert.equal(stats.maxBytes, 16384);
    assert.ok(stats.bytes <= stats.maxBytes);
    assert.ok(stats.entries < 40);
    assert.ok(stats.evictions > 0);

    const rebuilt = buildCachedDiffRows(
      firstMetadata,
      highlighted,
      palette,
      config,
      {},
      "row-budget-0",
    );
    assert.notStrictEqual(rebuilt, first);
  });
  resetPierreRowCache();
});

test("Pierre highlight cache stays inside its byte budget", () => {
  withEnv("PI_RICH_TOOLS_PIERRE_HIGHLIGHT_CACHE_MAX_BYTES", "8192", () => {
    resetPierreHighlightCache();
    const first = highlightedSet(0);
    rememberPiHighlight("highlight-budget-0", first);

    for (let index = 1; index < 12; index += 1) {
      rememberPiHighlight(`highlight-budget-${index}`, highlightedSet(index));
    }

    const stats = pierreHighlightCacheStats();
    assert.equal(stats.maxBytes, 8192);
    assert.ok(stats.bytes <= stats.maxBytes);
    assert.ok(stats.entries < 12);
    assert.ok(stats.evictions > 0);
    assert.equal(cachedPiHighlight("highlight-budget-0"), undefined);
    assert.ok(cachedPiHighlight("highlight-budget-11"));
    assert.equal(
      rememberPiHighlight("highlight-oversized", highlightedSet(12, 10_000)),
      false,
    );
    assert.equal(cachedPiHighlight("highlight-oversized"), undefined);
  });
  resetPierreHighlightCache();
});

function cacheMetadata(index) {
  const suffix = String(index).padStart(3, "0");
  return makeMetadata({
    name: `cache-${suffix}.txt`,
    lang: "text",
    deletionLines: [`old ${suffix} ${"x".repeat(120)}`],
    additionLines: [`new ${suffix} ${"y".repeat(120)}`],
    hunkContent: [
      {
        type: "change",
        deletions: 1,
        deletionLineIndex: 0,
        additions: 1,
        additionLineIndex: 0,
      },
    ],
    cacheKey: `cache-budget-${suffix}`,
  });
}

function highlightedSet(index, textLength = 1000) {
  const line = {
    type: "element",
    tagName: "span",
    properties: { "data-pi-syntax": "string" },
    children: [{ type: "text", value: `${index}:${"z".repeat(textLength)}` }],
  };
  const code = { deletionLines: [], additionLines: [line] };
  return { dark: code, light: code };
}

function withEnv(name, value, fn) {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}
