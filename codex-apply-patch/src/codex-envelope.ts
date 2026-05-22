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
const PREPARED_REPAIR_WARNINGS = Symbol("apply_patch_repair_warnings");
const PREPARED_WARNING_TTL_MS = 60_000;

const preparedWarningsByOperationsKey = new Map<
  string,
  { warnings: string[]; expiresAt: number }
>();

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

export interface ParsedCodexPatchEnvelope {
  operations: ApplyPatchOperation[];
  warnings: string[];
}

export interface PrepareApplyPatchArgumentsOptions {
  /**
   * Store repair warnings for execute() to surface. Renderers call argument
   * preparation too, so they pass false to avoid stale warning side effects.
   */
  recordRepairs?: boolean;
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

function markerText(line: string): string {
  return line.trimStart();
}

function isMarkerLine(line: string, marker: string): boolean {
  return line.trim() === marker;
}

function isEnvelopeOperationMarker(line: string): boolean {
  const marker = markerText(line);
  return (
    isMarkerLine(line, ENVELOPE_BEGIN_MARKER) ||
    isMarkerLine(line, ENVELOPE_END_MARKER) ||
    marker.startsWith(ENVELOPE_UPDATE_PREFIX) ||
    marker.startsWith(ENVELOPE_ADD_PREFIX) ||
    marker.startsWith(ENVELOPE_DELETE_PREFIX)
  );
}

function trimBlankEdges(lines: string[]): { lo: number; hi: number } {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi && lines[lo]!.trim() === "") lo++;
  while (hi > lo && lines[hi - 1]!.trim() === "") hi--;
  return { lo, hi };
}

function markdownFenceInfo(line: string): { marker: string } | undefined {
  const trimmed = line.trim();
  const match = /^(```+|~~~+)/.exec(trimmed);
  return match ? { marker: match[1]! } : undefined;
}

function isMarkdownFenceClose(line: string, marker: string): boolean {
  return line.trim() === marker;
}

function heredocInfo(line: string): { terminator: string } | undefined {
  const trimmed = line.trim();
  const match = /^<<(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\1|([A-Za-z_][A-Za-z0-9_]*))$/.exec(
    trimmed,
  );
  const terminator = match?.[2] ?? match?.[3];
  return terminator ? { terminator } : undefined;
}

function normalizeEnvelopeLines(patch: string): {
  lines: string[];
  warnings: string[];
} {
  let lines = normalizeLineEndings(patch).split("\n");
  const warnings: string[] = [];

  let edges = trimBlankEdges(lines);
  lines = lines.slice(edges.lo, edges.hi);
  if (lines.length === 0) return { lines, warnings };

  const fence = markdownFenceInfo(lines[0]!);
  if (
    fence &&
    lines.length >= 3 &&
    isMarkdownFenceClose(lines[lines.length - 1]!, fence.marker)
  ) {
    lines = lines.slice(1, -1);
    warnings.push(
      "Warning: repaired apply_patch envelope: stripped markdown code fence wrapper.",
    );
    edges = trimBlankEdges(lines);
    lines = lines.slice(edges.lo, edges.hi);
  }

  const heredoc = lines.length >= 4 ? heredocInfo(lines[0]!) : undefined;
  if (heredoc && lines[lines.length - 1]!.trim() === heredoc.terminator) {
    lines = lines.slice(1, -1);
    warnings.push(
      `Warning: repaired apply_patch envelope: stripped heredoc wrapper (${heredoc.terminator}).`,
    );
    edges = trimBlankEdges(lines);
    lines = lines.slice(edges.lo, edges.hi);
  }

  return { lines, warnings };
}

function repairEnvelopeBounds(lines: string[]): {
  lo: number;
  hi: number;
  hadBegin: boolean;
  warnings: string[];
} | undefined {
  const { lo, hi } = trimBlankEdges(lines);
  if (lo >= hi) return undefined;

  const warnings: string[] = [];
  const hadBegin = isMarkerLine(lines[lo]!, ENVELOPE_BEGIN_MARKER);
  if (!hadBegin) return { lo, hi, hadBegin, warnings };

  let endIndex = -1;
  for (let i = hi - 1; i > lo; i--) {
    if (isMarkerLine(lines[i]!, ENVELOPE_END_MARKER)) {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    let repairedHi = hi;
    const lastLine = lines[hi - 1]!;
    const fence = markdownFenceInfo(lastLine);
    if (fence && isMarkdownFenceClose(lastLine, fence.marker)) {
      warnings.push(
        "Warning: repaired apply_patch envelope: ignored trailing markdown fence after missing end marker.",
      );
      repairedHi = hi - 1;
    }
    warnings.push(
      `Warning: repaired apply_patch envelope: added missing '${ENVELOPE_END_MARKER}'.`,
    );
    return { lo, hi: repairedHi, hadBegin, warnings };
  }

  const trailing = lines.slice(endIndex + 1, hi);
  const nonBlankTrailing = trailing.filter((line) => line.trim() !== "");
  if (nonBlankTrailing.length === 0) return { lo, hi: endIndex, hadBegin, warnings };

  if (
    nonBlankTrailing.length === 1 &&
    markdownFenceInfo(nonBlankTrailing[0]!) &&
    isMarkdownFenceClose(
      nonBlankTrailing[0]!,
      markdownFenceInfo(nonBlankTrailing[0]!)!.marker,
    )
  ) {
    warnings.push(
      `Warning: repaired apply_patch envelope: ignored trailing markdown fence after '${ENVELOPE_END_MARKER}'.`,
    );
    return { lo, hi: endIndex, hadBegin, warnings };
  }

  return undefined;
}

function operationsKey(operations: ApplyPatchOperation[]): string | undefined {
  try {
    return JSON.stringify(operations);
  } catch {
    return undefined;
  }
}

function prunePreparedWarnings(): void {
  const now = Date.now();
  for (const [key, entry] of preparedWarningsByOperationsKey) {
    if (entry.expiresAt <= now) preparedWarningsByOperationsKey.delete(key);
  }
}

function withPreparedRepairWarnings(
  args: { operations: unknown[] },
  warnings: string[],
  record: boolean,
): { operations: unknown[] } {
  if (warnings.length === 0) return args;

  Object.defineProperty(args, PREPARED_REPAIR_WARNINGS, {
    value: warnings,
    enumerable: false,
  });

  if (record) {
    prunePreparedWarnings();
    const key = operationsKey(args.operations as ApplyPatchOperation[]);
    if (key) {
      preparedWarningsByOperationsKey.set(key, {
        warnings,
        expiresAt: Date.now() + PREPARED_WARNING_TTL_MS,
      });
    }
  }

  return args;
}

export function takePreparedApplyPatchWarnings(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const direct = (input as { [PREPARED_REPAIR_WARNINGS]?: unknown })[
    PREPARED_REPAIR_WARNINGS
  ];
  if (Array.isArray(direct)) {
    const operations = (input as { operations?: unknown }).operations;
    if (Array.isArray(operations)) {
      const key = operationsKey(operations as ApplyPatchOperation[]);
      if (key) preparedWarningsByOperationsKey.delete(key);
    }
    return direct.filter((warning): warning is string => typeof warning === "string");
  }

  const operations = (input as { operations?: unknown }).operations;
  if (!Array.isArray(operations)) return [];

  prunePreparedWarnings();
  const key = operationsKey(operations as ApplyPatchOperation[]);
  if (!key) return [];
  const entry = preparedWarningsByOperationsKey.get(key);
  preparedWarningsByOperationsKey.delete(key);
  return entry?.warnings ?? [];
}

export function parseCodexPatchEnvelope(
  patch: string,
): ApplyPatchOperation[] | undefined {
  return parseCodexPatchEnvelopeDetailed(patch)?.operations;
}

export function parseCodexPatchEnvelopeDetailed(
  patch: string,
): ParsedCodexPatchEnvelope | undefined {
  const normalized = normalizeEnvelopeLines(patch);
  const lines = normalized.lines;
  const bounds = repairEnvelopeBounds(lines);
  if (!bounds) return undefined;

  const { lo, hi, hadBegin } = bounds;
  const warnings = [...normalized.warnings, ...bounds.warnings];
  if (lo >= hi) return undefined;

  const first = markerText(lines[lo]!);
  const looksLikeEnvelope =
    hadBegin ||
    first.startsWith(ENVELOPE_ADD_PREFIX) ||
    first.startsWith(ENVELOPE_UPDATE_PREFIX) ||
    first.startsWith(ENVELOPE_DELETE_PREFIX);
  if (!looksLikeEnvelope) return undefined;

  const ops: ApplyPatchOperation[] = [];
  let i = lo;
  if (hadBegin) i++;
  if (i < hi && markerText(lines[i]!).startsWith(ENVELOPE_ENVIRONMENT_PREFIX)) {
    i++;
  }

  while (i < hi) {
    while (i < hi && lines[i]!.trim() === "") i++;
    if (i >= hi) break;

    const line = lines[i]!;
    if (isMarkerLine(line, ENVELOPE_END_MARKER)) break;
    const opLine = markerText(line);

    if (opLine.startsWith(ENVELOPE_ADD_PREFIX)) {
      const rawPath = opLine.slice(ENVELOPE_ADD_PREFIX.length).trim();
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

    if (opLine.startsWith(ENVELOPE_UPDATE_PREFIX)) {
      const rawPath = opLine.slice(ENVELOPE_UPDATE_PREFIX.length).trim();
      if (!rawPath) return undefined;
      i++;

      let movePath: string | undefined;
      if (i < hi && markerText(lines[i]!).startsWith(ENVELOPE_MOVE_PREFIX)) {
        movePath = markerText(lines[i]!).slice(ENVELOPE_MOVE_PREFIX.length).trim();
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

    if (opLine.startsWith(ENVELOPE_DELETE_PREFIX)) {
      const rawPath = opLine.slice(ENVELOPE_DELETE_PREFIX.length).trim();
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

  return ops.length > 0 ? { operations: ops, warnings } : undefined;
}

export function prepareApplyPatchArguments(
  input: unknown,
  options: PrepareApplyPatchArgumentsOptions = {},
): unknown {
  const recordRepairs = options.recordRepairs ?? true;

  if (typeof input === "string") {
    const envelope = parseCodexPatchEnvelopeDetailed(input);
    return envelope
      ? withPreparedRepairWarnings(
          { operations: envelope.operations },
          envelope.warnings,
          recordRepairs,
        )
      : input;
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

    const envelope = parseCodexPatchEnvelopeDetailed(args.operations);
    if (envelope)
      return withPreparedRepairWarnings(
        { operations: envelope.operations },
        envelope.warnings,
        recordRepairs,
      );
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
    const envelope = parseCodexPatchEnvelopeDetailed(patchText);
    if (envelope)
      return withPreparedRepairWarnings(
        { operations: envelope.operations },
        envelope.warnings,
        recordRepairs,
      );
  }

  return input;
}

