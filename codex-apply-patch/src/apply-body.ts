import type { LineReplacement } from "./types.ts";
import { DiffError, normalizeLineEndings } from "./util.ts";
import {
  findContext,
  findLineFrom,
  getTrimmedLines,
  getUnicodeLines,
  matchDeletedLines,
  normalizeLineForUnicodeMatch,
  peekNextSection,
  type FuzzyMatchKind,
  type LineMatchCache,
} from "./context-match.ts";
import {
  isEnvelopeMarkerParseError,
  tryNormalizeUpdateDiffEnvelope,
} from "./codex-envelope.ts";

export interface ApplyUpdateResult {
  output: string;
  fuzz: number;
  fuzzKinds: FuzzyMatchKind[];
  replacements: LineReplacement[];
  normalizedMarkers?: string[];
}

export function applyCodexUpdateWithRecovery(
  input: string,
  diff: string,
  rel: string,
): ApplyUpdateResult {
  try {
    const strict = applyCodexUpdateBody(input, diff);
    return {
      output: strict.output,
      fuzz: strict.fuzz,
      fuzzKinds: strict.fuzzKinds,
      replacements: strict.replacements,
    };
  } catch (err) {
    if (!isEnvelopeMarkerParseError(err)) throw err;

    const normalized = tryNormalizeUpdateDiffEnvelope(diff, rel);
    if (!normalized) throw err;

    const recovered = applyCodexUpdateBody(input, normalized.diff);
    return {
      output: recovered.output,
      fuzz: recovered.fuzz,
      fuzzKinds: recovered.fuzzKinds,
      replacements: recovered.replacements,
      normalizedMarkers: normalized.markers,
    };
  }
}

// Apply a Codex Update File body to existing file content.
// Returns updated content plus a fuzz score when context matching was inexact.
export function applyCodexUpdateBody(
  input: string,
  diff: string,
): {
  output: string;
  fuzz: number;
  fuzzKinds: FuzzyMatchKind[];
  replacements: LineReplacement[];
} {
  // IMPORTANT: do NOT trim() here. Codex context lines start with a leading space.
  const normalizedDiff = normalizeLineEndings(diff);
  const patchLines = normalizedDiff.split("\n");
  // Drop a single trailing newline to avoid creating an extra empty diff line.
  if (patchLines.length > 0 && patchLines[patchLines.length - 1] === "")
    patchLines.pop();

  const fileLines = normalizeLineEndings(input).split("\n");
  const fileLineCache: LineMatchCache = { raw: fileLines };

  let fuzz = 0;
  const fuzzKinds = new Set<FuzzyMatchKind>();
  let patchIndex = 0;
  let fileIndex = 0;
  const replacements: LineReplacement[] = [];
  let seenPrefixIndex = 0;
  const seenExact = new Set<string>();
  let seenTrimmed: Set<string> | undefined;
  let seenUnicode: Set<string> | undefined;

  const syncSeenPrefix = (toExclusive: number) => {
    const limit = Math.min(toExclusive, fileLines.length);
    if (seenPrefixIndex >= limit) return;

    if (seenTrimmed || seenUnicode) {
      const trimmedLines = seenTrimmed
        ? getTrimmedLines(fileLineCache)
        : undefined;
      const unicodeLines = seenUnicode
        ? getUnicodeLines(fileLineCache)
        : undefined;
      for (; seenPrefixIndex < limit; seenPrefixIndex++) {
        seenExact.add(fileLines[seenPrefixIndex]!);
        if (seenTrimmed && trimmedLines)
          seenTrimmed.add(trimmedLines[seenPrefixIndex]!);
        if (seenUnicode && unicodeLines)
          seenUnicode.add(unicodeLines[seenPrefixIndex]!);
      }
      return;
    }

    for (; seenPrefixIndex < limit; seenPrefixIndex++) {
      seenExact.add(fileLines[seenPrefixIndex]!);
    }
  };

  const getSeenTrimmed = (): Set<string> => {
    if (!seenTrimmed) {
      const trimmedLines = getTrimmedLines(fileLineCache);
      seenTrimmed = new Set<string>();
      for (let i = 0; i < seenPrefixIndex; i++) {
        seenTrimmed.add(trimmedLines[i]!);
      }
    }
    return seenTrimmed;
  };

  const getSeenUnicode = (): Set<string> => {
    if (!seenUnicode) {
      const unicodeLines = getUnicodeLines(fileLineCache);
      seenUnicode = new Set<string>();
      for (let i = 0; i < seenPrefixIndex; i++) {
        seenUnicode.add(unicodeLines[i]!);
      }
    }
    return seenUnicode;
  };

  while (patchIndex < patchLines.length) {
    // Section marker
    const line = patchLines[patchIndex] ?? "";
    let defStr = "";
    if (line.startsWith("@@ ")) {
      defStr = line.slice(3);
      patchIndex++;
    } else if (line === "@@") {
      patchIndex++;
    } else if (patchIndex === 0) {
      // Allow diffs without leading @@ (common in some examples)
    } else {
      throw new DiffError(`Invalid diff (expected @@ section): ${line}`);
    }

    if (defStr.trim()) {
      syncSeenPrefix(fileIndex);
      if (!seenExact.has(defStr)) {
        const exactPos = findLineFrom(fileLines, fileIndex, defStr);
        if (exactPos !== -1) {
          fileIndex = exactPos + 1;
        } else {
          const defStrTrimmed = defStr.trim();
          const trimmedLines = getTrimmedLines(fileLineCache);
          if (!getSeenTrimmed().has(defStrTrimmed)) {
            const trimPos = findLineFrom(
              trimmedLines,
              fileIndex,
              defStrTrimmed,
            );
            if (trimPos !== -1) {
              fileIndex = trimPos + 1;
              fuzz += 1;
              fuzzKinds.add("trim");
            } else {
              const defStrUnicode = normalizeLineForUnicodeMatch(defStr);
              const unicodeLines = getUnicodeLines(fileLineCache);
              if (!getSeenUnicode().has(defStrUnicode)) {
                const unicodePos = findLineFrom(
                  unicodeLines,
                  fileIndex,
                  defStrUnicode,
                );
                if (unicodePos !== -1) {
                  fileIndex = unicodePos + 1;
                  fuzz += 1000;
                  fuzzKinds.add("unicode");
                }
              }
            }
          }
        }
      }
    }

    const {
      context,
      chunks: sectionChunks,
      nextIndex,
      eof,
    } = peekNextSection(patchLines, patchIndex);
    const found = findContext(fileLineCache, context, fileIndex, eof);
    if (found.index === -1) {
      const nextChunkText = context.join("\n");
      if (eof)
        throw new DiffError(
          `Invalid EOF Context ${fileIndex}:\n${nextChunkText}`,
        );
      throw new DiffError(`Invalid Context ${fileIndex}:\n${nextChunkText}`);
    }

    fuzz += found.fuzz;
    for (const kind of found.fuzzKinds) fuzzKinds.add(kind);
    for (const ch of sectionChunks) {
      const chunkOrigIndex =
        ch.delLines.length === 0 && context.length === 0
          ? fileLines.length > 0 && fileLines[fileLines.length - 1] === ""
            ? fileLines.length - 1
            : fileLines.length
          : ch.origIndex + found.index;

      const expected = ch.delLines;
      const matchedDelete = matchDeletedLines(
        fileLineCache,
        chunkOrigIndex,
        expected,
      );
      if (!matchedDelete.matched) {
        throw new DiffError(
          `Patch conflict at line ${chunkOrigIndex + 1}. Expected:\n${expected.join("\n")}\n\nActual:\n${matchedDelete.actual.join("\n")}`,
        );
      }
      fuzz += matchedDelete.fuzz;
      for (const kind of matchedDelete.fuzzKinds) fuzzKinds.add(kind);

      replacements.push({
        oldStart: chunkOrigIndex,
        oldLines: matchedDelete.actual,
        newLines: ch.insLines,
      });
    }

    fileIndex = found.index + context.length;
    patchIndex = nextIndex;
  }

  const sortedReplacements = replacements
    .map((replacement, index) => ({ ...replacement, index }))
    .sort((a, b) => a.oldStart - b.oldStart || a.index - b.index);
  for (let i = 1; i < sortedReplacements.length; i++) {
    const previous = sortedReplacements[i - 1]!;
    const current = sortedReplacements[i]!;
    if (previous.oldStart + previous.oldLines.length > current.oldStart) {
      throw new DiffError(
        `Patch chunks overlap at line ${current.oldStart + 1}.`,
      );
    }
  }

  const outputLines = [...fileLines];
  for (let i = sortedReplacements.length - 1; i >= 0; i--) {
    const replacement = sortedReplacements[i]!;
    outputLines.splice(
      replacement.oldStart,
      replacement.oldLines.length,
      ...replacement.newLines,
    );
  }

  return {
    output: outputLines.join("\n"),
    fuzz,
    fuzzKinds: [...fuzzKinds],
    replacements: sortedReplacements.map(({ index: _index, ...rest }) => rest),
  };
}

// Apply a Codex Add File body (every line starts with '+') and return file content.
export function applyCodexCreateBody(diff: string): string {
  if (diff.length === 0) return "";

  const lines = normalizeLineEndings(diff).split("\n");
  // Drop trailing empty line to avoid an extra empty content line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const out = new Array<string>(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith("+")) {
      throw new DiffError(
        `Invalid create_file diff line (must start with '+'): ${line}`,
      );
    }
    out[i] = line.slice(1);
  }

  // Codex Add File lines are logical text lines; each line in the envelope is
  // newline-terminated. Keep that useful POSIX default for new files.
  return `${out.join("\n")}\n`;
}

