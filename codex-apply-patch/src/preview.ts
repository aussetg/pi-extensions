import {
  MAX_DIFF_INPUT_BYTES,
  buildPierreCreatePayload,
  buildPierreDeletePayload,
  buildPierreUpdatePayload,
  type BuildPierreCreatePayloadOptions,
  type BuildPierreDeletePayloadOptions,
  type BuildPierreUpdatePayloadOptions,
} from "./pierre/metadata.ts";
import type { PierreDiffPayload } from "./pierre/types.ts";

// Rich previews are best-effort. An oversized diff or a Pierre parser edge
// case must never change whether a patch applies. Syntax highlighting is left
// to the renderer so tree-sitter cannot sit in the mutation path.
export const MAX_PREVIEW_INPUT_BYTES = MAX_DIFF_INPUT_BYTES;

export function buildCreateFilePreview(
  options: BuildPierreCreatePayloadOptions,
): PierreDiffPayload | undefined {
  return bestEffortPierrePreview(() => buildPierreCreatePayload(options));
}

export function buildUpdateFilePreview(
  options: BuildPierreUpdatePayloadOptions,
): PierreDiffPayload | undefined {
  return bestEffortPierrePreview(() => buildPierreUpdatePayload(options));
}

export function buildDeleteFilePreview(
  options: BuildPierreDeletePayloadOptions,
): PierreDiffPayload | undefined {
  return bestEffortPierrePreview(() => buildPierreDeletePayload(options));
}

function bestEffortPierrePreview(
  build: () => PierreDiffPayload | undefined,
): PierreDiffPayload | undefined {
  try {
    return build();
  } catch {
    return undefined;
  }
}
