import type { HighlightedDiffSet } from "./types.ts";

const GLOBAL_PI_HIGHLIGHT_CACHE_KEY = "__piRichToolsPierreHighlightCache";
const GLOBAL_PI_HIGHLIGHT_GENERATION_KEY = "__piRichToolsPierreHighlightGeneration";

export function globalPiHighlightCache(): Map<string, HighlightedDiffSet> {
  const scope = globalThis as typeof globalThis & {
    [GLOBAL_PI_HIGHLIGHT_CACHE_KEY]?: Map<string, HighlightedDiffSet>;
  };
  scope[GLOBAL_PI_HIGHLIGHT_CACHE_KEY] ??= new Map<string, HighlightedDiffSet>();
  return scope[GLOBAL_PI_HIGHLIGHT_CACHE_KEY];
}

export function globalPiHighlightGeneration(): number {
  const scope = globalThis as typeof globalThis & {
    [GLOBAL_PI_HIGHLIGHT_GENERATION_KEY]?: number;
  };
  scope[GLOBAL_PI_HIGHLIGHT_GENERATION_KEY] ??= 0;
  return scope[GLOBAL_PI_HIGHLIGHT_GENERATION_KEY];
}

export function resetPierreHighlightCache(): void {
  globalPiHighlightCache().clear();
  const scope = globalThis as typeof globalThis & {
    [GLOBAL_PI_HIGHLIGHT_GENERATION_KEY]?: number;
  };
  scope[GLOBAL_PI_HIGHLIGHT_GENERATION_KEY] = globalPiHighlightGeneration() + 1;
}
