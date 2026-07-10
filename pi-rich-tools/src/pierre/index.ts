export {
  PierreInlineDiffComponent,
  PierreStatusComponent,
  type PierreInlineDiffOptions,
  type PierreLimitedRenderResult,
} from "./component.ts";
export { resetPierreHighlightCache } from "./highlight-cache.ts";
export {
  hasHighlightedLines,
  loadHighlightedDiff,
  normalizeHighlightedDiffSet,
  resetPierreHighlighter,
} from "./highlight.ts";
export { resetPierreRendererState } from "./reset.ts";
export {
  querySharedSyntaxCaptures,
  resetSharedSyntaxService,
  resetSharedSyntaxServiceForTests,
  sharedSyntaxServiceStats,
  treeSitterLanguageKey,
  type SharedSyntaxCaptureRequest,
  type SharedSyntaxServiceStats,
  type TreeSitterCapture,
  type TreeSitterNode,
  type TreeSitterPoint,
  type TreeSitterRange,
} from "./syntax-service.ts";
export {
  MAX_DIFF_INPUT_BYTES,
  buildPierreCreatePayload,
  buildPierreDeletePayload,
  buildPierreNumberedDiffPayload,
  buildPierreUnifiedPatchPayload,
  buildPierreUpdatePayload,
  normalizeDiffMetadataLanguage,
  type BuildPierreCreatePayloadOptions,
  type BuildPierreDeletePayloadOptions,
  type BuildPierreNumberedDiffPayloadOptions,
  type BuildPierreUnifiedPatchPayloadOptions,
  type BuildPierreUpdatePayloadOptions,
} from "./metadata.ts";
export { getPierreAppearance, getPierrePalette } from "./theme.ts";
export type {
  HighlightedDiffCode,
  HighlightedDiffSet,
  PierreAppearance,
  PierreDiffPayload,
} from "./types.ts";
