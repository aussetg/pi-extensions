export {
  PierreInlineDiffComponent,
  PierreStatusComponent,
  type PierreInlineDiffOptions,
} from "./component.ts";
export {
  hasHighlightedLines,
  loadHighlightedDiff,
  normalizeHighlightedDiffSet,
} from "./highlight.ts";
export {
  querySharedSyntaxCaptures,
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
  buildPierreUpdatePayload,
  normalizeDiffMetadataLanguage,
  type BuildPierreCreatePayloadOptions,
  type BuildPierreDeletePayloadOptions,
  type BuildPierreNumberedDiffPayloadOptions,
  type BuildPierreUpdatePayloadOptions,
} from "./metadata.ts";
export { getPierreAppearance, getPierrePalette } from "./theme.ts";
export type {
  HighlightedDiffCode,
  HighlightedDiffSet,
  PierreAppearance,
  PierreDiffPayload,
} from "./types.ts";
