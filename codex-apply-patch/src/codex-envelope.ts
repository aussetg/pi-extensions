import * as path from "node:path";
import type { ApplyPatchOperation } from "./types.ts";
import { DiffError, normalizeLineEndings, normalizePatchPath } from "./util.ts";

const ENVELOPE_BEGIN_MARKER = "*** Begin Patch";
const ENVELOPE_END_MARKER = "*** End Patch";
const ENVELOPE_ENVIRONMENT_PREFIX = "*** Environment ID: ";
const ENVELOPE_UPDATE_PREFIX = "*** Update File:";
const ENVELOPE_ADD_PREFIX = "*** Add File:";
const ENVELOPE_DELETE_PREFIX = "*** Delete File:";
const ENVELOPE_MOVE_PREFIX = "*** Move to:";

/*
 * Codex apply_patch reference implementation:
 * - Format instructions/grammar:
 *   https://github.com/openai/codex/blob/main/codex-rs/apply-patch/apply_patch_tool_instructions.md
 * - Parser:
 *   https://github.com/openai/codex/blob/main/codex-rs/apply-patch/src/parser.rs
 * - Applier:
 *   https://github.com/openai/codex/blob/main/codex-rs/apply-patch/src/lib.rs
 *
 * The *** Add/Update/Delete File headers are Codex apply_patch envelope file
 * operations. *** Move to is an optional subheader of Update File, not a
 * standalone file operation. Our public JSON `operations[]` shape is Pi-specific
 * and stores each Codex section body in `diff`.
 */

export function isEnvelopeMarkerParseError(err: unknown): boolean {
  if (!(err instanceof DiffError)) return false;
  const msg = err.message;
  if (!msg.includes("***")) return false;

  return (
    msg.startsWith("Invalid diff (expected @@ section): ***") ||
    msg.startsWith("Invalid Line: ***") ||
    msg.includes("line='***") ||
    msg.includes(ENVELOPE_BEGIN_MARKER) ||
    msg.includes(ENVELOPE_END_MARKER) ||
    msg.includes("*** Update File:") ||
    msg.includes("*** Add File:") ||
    msg.includes("*** Delete File:")
  );
}

export interface NormalizedEnvelopeDiff {
  diff: string;
  markers: string[];
}

export function tryNormalizeUpdateDiffEnvelope(
  diff: string,
  rel: string,
): NormalizedEnvelopeDiff | undefined {
  const lines = normalizeLineEndings(diff).split("\n");

  let lo = 0;
  let hi = lines.length;
  while (lo < hi && lines[lo] === "") lo++;
  while (hi > lo && lines[hi - 1] === "") hi--;

  const markers: string[] = [];

  if (lo < hi && lines[lo] === ENVELOPE_BEGIN_MARKER) {
    markers.push(ENVELOPE_BEGIN_MARKER);
    lo++;
  }

  if (lo < hi && lines[hi - 1] === ENVELOPE_END_MARKER) {
    markers.push(ENVELOPE_END_MARKER);
    hi--;
  }

  if (lo < hi && lines[lo]!.startsWith(ENVELOPE_UPDATE_PREFIX)) {
    const rawPath = lines[lo]!.slice(ENVELOPE_UPDATE_PREFIX.length).trim();
    let normalizedRawPath = normalizePatchPath(rawPath);
    if (normalizedRawPath)
      normalizedRawPath = path.posix.normalize(normalizedRawPath);
    if (!normalizedRawPath || normalizedRawPath !== rel) {
      return undefined;
    }
    markers.push(`${ENVELOPE_UPDATE_PREFIX} ${rawPath}`);
    lo++;
  }

  if (markers.length === 0) return undefined;

  const candidateLines = lines.slice(lo, hi);
  for (const line of candidateLines) {
    if (!line.startsWith("***")) continue;
    if (line === "*** End of File") continue;
    // Keep recovery narrowly scoped: if envelope-style bare markers remain,
    // refuse fallback rather than guessing intent.
    return undefined;
  }

  return { diff: candidateLines.join("\n"), markers };
}

function isEnvelopeOperationMarker(line: string): boolean {
  return (
    line === ENVELOPE_BEGIN_MARKER ||
    line === ENVELOPE_END_MARKER ||
    line.startsWith(ENVELOPE_UPDATE_PREFIX) ||
    line.startsWith(ENVELOPE_ADD_PREFIX) ||
    line.startsWith(ENVELOPE_DELETE_PREFIX)
  );
}

function stripCodexHeredocWrapper(patch: string): string {
  const trimmed = normalizeLineEndings(patch).trim();
  const lines = trimmed.split("\n");
  if (lines.length < 4) return patch;

  const first = lines[0];
  const last = lines[lines.length - 1];
  if (
    (first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') &&
    typeof last === "string" &&
    last.endsWith("EOF")
  ) {
    return lines.slice(1, -1).join("\n").trim();
  }

  return patch;
}

export function parseCodexPatchEnvelope(
  patch: string,
): ApplyPatchOperation[] | undefined {
  const lines = normalizeLineEndings(stripCodexHeredocWrapper(patch)).split("\n");

  let lo = 0;
  let hi = lines.length;
  while (lo < hi && lines[lo] === "") lo++;
  while (hi > lo && lines[hi - 1] === "") hi--;
  if (lo >= hi) return undefined;

  const ops: ApplyPatchOperation[] = [];
  let i = lo;
  if (lines[i] === ENVELOPE_BEGIN_MARKER) i++;
  if (i < hi && lines[i]!.trimStart().startsWith(ENVELOPE_ENVIRONMENT_PREFIX)) {
    i++;
  }

  while (i < hi) {
    while (i < hi && lines[i] === "") i++;
    if (i >= hi) break;

    const line = lines[i]!;
    if (line === ENVELOPE_END_MARKER) break;

    if (line.startsWith(ENVELOPE_ADD_PREFIX)) {
      const rawPath = line.slice(ENVELOPE_ADD_PREFIX.length).trim();
      if (!rawPath) return undefined;
      i++;

      const diffLines: string[] = [];
      while (i < hi && !isEnvelopeOperationMarker(lines[i]!)) {
        diffLines.push(lines[i]!);
        i++;
      }

      ops.push({
        type: "create_file",
        path: rawPath,
        diff: diffLines.join("\n"),
      });
      continue;
    }

    if (line.startsWith(ENVELOPE_UPDATE_PREFIX)) {
      const rawPath = line.slice(ENVELOPE_UPDATE_PREFIX.length).trim();
      if (!rawPath) return undefined;
      i++;

      let movePath: string | undefined;
      if (i < hi && lines[i]!.startsWith(ENVELOPE_MOVE_PREFIX)) {
        movePath = lines[i]!.slice(ENVELOPE_MOVE_PREFIX.length).trim();
        if (!movePath) return undefined;
        i++;
      }

      const diffLines: string[] = [];
      while (i < hi && !isEnvelopeOperationMarker(lines[i]!)) {
        diffLines.push(lines[i]!);
        i++;
      }

      ops.push({
        type: "update_file",
        path: rawPath,
        diff: diffLines.join("\n"),
        ...(movePath ? { move_path: movePath } : {}),
      });
      continue;
    }

    if (line.startsWith(ENVELOPE_DELETE_PREFIX)) {
      const rawPath = line.slice(ENVELOPE_DELETE_PREFIX.length).trim();
      if (!rawPath) return undefined;
      i++;

      const bodyLines: string[] = [];
      while (i < hi && !isEnvelopeOperationMarker(lines[i]!)) {
        bodyLines.push(lines[i]!);
        i++;
      }
      if (bodyLines.some((bodyLine) => bodyLine.trim().length > 0)) {
        return undefined;
      }

      ops.push({ type: "delete_file", path: rawPath });
      continue;
    }

    return undefined;
  }

  return ops.length > 0 ? ops : undefined;
}

export function prepareApplyPatchArguments(input: unknown): unknown {
  if (typeof input === "string") {
    const envelopeOps = parseCodexPatchEnvelope(input);
    return envelopeOps ? { operations: envelopeOps } : input;
  }

  if (!input || typeof input !== "object") return input;
  const args = input as Record<string, unknown>;

  if (Array.isArray(args.operations)) {
    return { operations: args.operations };
  }

  if (typeof args.operations === "string") {
    try {
      const parsed = JSON.parse(args.operations) as unknown;
      if (Array.isArray(parsed)) return { operations: parsed };
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { operations?: unknown }).operations)
      ) {
        return { operations: (parsed as { operations: unknown[] }).operations };
      }
    } catch {
      // Fall through to Codex envelope parsing below.
    }

    const envelopeOps = parseCodexPatchEnvelope(args.operations);
    if (envelopeOps) return { operations: envelopeOps };
  }

  const patchText =
    typeof args.patch === "string"
      ? args.patch
      : typeof args.input === "string"
        ? args.input
        : typeof args.diff === "string"
          ? args.diff
          : typeof args.text === "string"
            ? args.text
            : undefined;

  if (patchText) {
    const envelopeOps = parseCodexPatchEnvelope(patchText);
    if (envelopeOps) return { operations: envelopeOps };
  }

  return input;
}

