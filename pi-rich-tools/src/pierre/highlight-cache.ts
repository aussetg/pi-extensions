import { ByteLruCache, type ByteLruCacheStats } from "../byte-lru.ts";
import { estimateCacheEntryBytes } from "./cache-size.ts";
import type { HighlightedDiffSet } from "./types.ts";

const GLOBAL_PI_HIGHLIGHT_CACHE_KEY = "__piRichToolsPierreHighlightCache";
const GLOBAL_PI_HIGHLIGHT_GENERATION_KEY = "__piRichToolsPierreHighlightGeneration";
const PI_HIGHLIGHT_CACHE_MAX_ENTRIES = 512;
const PI_HIGHLIGHT_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const PI_HIGHLIGHT_CACHE_MAX_BYTES_ENV = "PI_RICH_TOOLS_PIERRE_HIGHLIGHT_CACHE_MAX_BYTES";

function globalPiHighlightCache(): ByteLruCache<HighlightedDiffSet> {
  const scope = globalThis as typeof globalThis & {
    [GLOBAL_PI_HIGHLIGHT_CACHE_KEY]?: ByteLruCache<HighlightedDiffSet>;
  };
  const current = scope[GLOBAL_PI_HIGHLIGHT_CACHE_KEY];
  if (!current || typeof current.stats !== "function") {
    scope[GLOBAL_PI_HIGHLIGHT_CACHE_KEY] = new ByteLruCache<HighlightedDiffSet>({
      maxEntries: PI_HIGHLIGHT_CACHE_MAX_ENTRIES,
      maxBytes: cacheMaxBytes(PI_HIGHLIGHT_CACHE_MAX_BYTES_ENV, PI_HIGHLIGHT_CACHE_MAX_BYTES),
    });
  }
  return scope[GLOBAL_PI_HIGHLIGHT_CACHE_KEY];
}

export function cachedPiHighlight(key: string): HighlightedDiffSet | undefined {
  return globalPiHighlightCache().get(key);
}

export function rememberPiHighlight(key: string, highlighted: HighlightedDiffSet): boolean {
  return globalPiHighlightCache().set(
    key,
    highlighted,
    estimateCacheEntryBytes(key, highlighted),
  );
}

export function forgetPiHighlight(key: string): void {
  globalPiHighlightCache().delete(key);
}

export function pierreHighlightCacheStats(): ByteLruCacheStats {
  return globalPiHighlightCache().stats();
}

export function globalPiHighlightGeneration(): number {
  const scope = globalThis as typeof globalThis & {
    [GLOBAL_PI_HIGHLIGHT_GENERATION_KEY]?: number;
  };
  scope[GLOBAL_PI_HIGHLIGHT_GENERATION_KEY] ??= 0;
  return scope[GLOBAL_PI_HIGHLIGHT_GENERATION_KEY];
}

export function resetPierreHighlightCache(): void {
  const scope = globalThis as typeof globalThis & {
    [GLOBAL_PI_HIGHLIGHT_CACHE_KEY]?: ByteLruCache<HighlightedDiffSet>;
    [GLOBAL_PI_HIGHLIGHT_GENERATION_KEY]?: number;
  };
  delete scope[GLOBAL_PI_HIGHLIGHT_CACHE_KEY];
  scope[GLOBAL_PI_HIGHLIGHT_GENERATION_KEY] = globalPiHighlightGeneration() + 1;
}

function cacheMaxBytes(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
