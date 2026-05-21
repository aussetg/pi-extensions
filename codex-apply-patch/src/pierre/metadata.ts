import {
  getFiletypeFromFileName,
  parsePatchFiles,
  setLanguageOverride,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import { normalizeLineEndings } from "../util.ts";
import type { PierreDiffPayload } from "./types.ts";

const DEFAULT_CONTEXT_LINES = 4;
export const MAX_DIFF_INPUT_BYTES = 1_000_000;

export interface BuildPierreUpdatePayloadOptions {
  oldPath: string;
  newPath: string;
  oldContent: string;
  newContent: string;
  contextLines?: number;
}

export interface BuildPierreCreatePayloadOptions {
  path: string;
  newContent: string;
  contextLines?: number;
}

export interface BuildPierreDeletePayloadOptions {
  path: string;
  oldContent: string;
  contextLines?: number;
}

export interface BuildPierreNumberedDiffPayloadOptions {
  path: string;
  diff: string;
  forcedType?: FileDiffMetadata["type"];
}

export function buildPierreUpdatePayload({
  oldPath,
  newPath,
  oldContent,
  newContent,
  contextLines = DEFAULT_CONTEXT_LINES,
}: BuildPierreUpdatePayloadOptions): PierreDiffPayload | undefined {
  return buildPierrePayload({
    oldPath,
    newPath,
    oldContent,
    newContent,
    contextLines,
  });
}

export function buildPierreCreatePayload({
  path,
  newContent,
  contextLines = DEFAULT_CONTEXT_LINES,
}: BuildPierreCreatePayloadOptions): PierreDiffPayload | undefined {
  return buildPierrePayload({
    oldPath: path,
    newPath: path,
    oldContent: "",
    newContent,
    contextLines,
    forcedType: "new",
  });
}

export function buildPierreDeletePayload({
  path,
  oldContent,
  contextLines = DEFAULT_CONTEXT_LINES,
}: BuildPierreDeletePayloadOptions): PierreDiffPayload | undefined {
  return buildPierrePayload({
    oldPath: path,
    newPath: path,
    oldContent,
    newContent: "",
    contextLines,
    forcedType: "deleted",
  });
}

export function buildPierreNumberedDiffPayload({
  path,
  diff,
  forcedType,
}: BuildPierreNumberedDiffPayloadOptions): PierreDiffPayload | undefined {
  const normalizedDiff = normalizeLineEndings(diff);
  if (Buffer.byteLength(normalizedDiff, "utf8") > MAX_DIFF_INPUT_BYTES) {
    return undefined;
  }

  try {
    const patch = numberedDiffToPatch(path, normalizedDiff);
    if (!patch) return undefined;

    const parsed = parsePatchFiles(
      patch,
      numberedDiffCacheKey(path, normalizedDiff),
      true,
    );
    const metadata = parsed[0]?.files[0];
    if (!metadata) return undefined;

    const typedMetadata = forcedType
      ? ({ ...metadata, type: forcedType } satisfies FileDiffMetadata)
      : metadata;

    return {
      path,
      metadata: normalizeDiffMetadataLanguage(typedMetadata, path),
    };
  } catch {
    return undefined;
  }
}

interface BuildPierrePayloadOptions extends BuildPierreUpdatePayloadOptions {
  forcedType?: FileDiffMetadata["type"];
}

function buildPierrePayload({
  oldPath,
  newPath,
  oldContent,
  newContent,
  contextLines,
  forcedType,
}: BuildPierrePayloadOptions): PierreDiffPayload | undefined {
  const oldNormalized = normalizeLineEndings(oldContent);
  const newNormalized = normalizeLineEndings(newContent);
  if (oldNormalized === newNormalized) return undefined;

  const inputBytes =
    Buffer.byteLength(oldNormalized, "utf8") +
    Buffer.byteLength(newNormalized, "utf8");
  if (inputBytes > MAX_DIFF_INPUT_BYTES) return undefined;

  try {
    const cacheKey = diffCacheKey(oldPath, newPath, oldNormalized, newNormalized);
    const patch = createTwoFilesPatch(
      oldPath,
      newPath,
      oldNormalized,
      newNormalized,
      "",
      "",
      { context: contextLines },
    );
    const parsed = parsePatchFiles(patch, cacheKey, true);
    const metadata = parsed[0]?.files[0];
    if (!metadata) return undefined;

    const typedMetadata = forcedType
      ? ({ ...metadata, type: forcedType } satisfies FileDiffMetadata)
      : metadata;

    return {
      path: newPath,
      metadata: normalizeDiffMetadataLanguage(typedMetadata, newPath),
    };
  } catch {
    return undefined;
  }
}

export function normalizeDiffMetadataLanguage(
  metadata: FileDiffMetadata,
  filePath: string,
): FileDiffMetadata {
  const language = metadata.lang ?? getFiletypeFromFileName(filePath);
  return language ? setLanguageOverride(metadata, language) : metadata;
}

function diffCacheKey(
  oldPath: string,
  newPath: string,
  oldContent: string,
  newContent: string,
): string {
  const hash = createHash("sha256");
  hash.update(oldPath);
  hash.update("\0");
  hash.update(newPath);
  hash.update("\0");
  hash.update(oldContent);
  hash.update("\0");
  hash.update(newContent);
  return `apply-patch-${hash.digest("hex").slice(0, 24)}`;
}

function numberedDiffCacheKey(path: string, diff: string): string {
  const hash = createHash("sha256");
  hash.update(path);
  hash.update("\0");
  hash.update(diff);
  return `apply-patch-numbered-${hash.digest("hex").slice(0, 24)}`;
}

type NumberedDiffLine =
  | {
      kind: "gap";
    }
  | {
      kind: "line";
      sign: " " | "+" | "-";
      lineNumber: number;
      content: string;
    };

function numberedDiffToPatch(path: string, diff: string): string | undefined {
  const lines = diff.split("\n");
  const parsed: NumberedDiffLine[] = [];

  for (const line of lines) {
    if (line === "") continue;
    const parsedLine = parseNumberedDiffLine(line);
    if (!parsedLine) return undefined;
    parsed.push(parsedLine);
  }

  const hunks: Array<Extract<NumberedDiffLine, { kind: "line" }>[]> = [];
  let current: Extract<NumberedDiffLine, { kind: "line" }>[] = [];
  for (const line of parsed) {
    if (line.kind === "gap") {
      if (current.length > 0) {
        hunks.push(current);
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) hunks.push(current);

  const changedHunks = hunks.filter((hunk) =>
    hunk.some((line) => line.sign === "+" || line.sign === "-"),
  );
  if (changedHunks.length === 0) return undefined;

  const safePath = sanitizePatchPath(path);
  const out = [
    `Index: ${safePath}`,
    "===================================================================",
    `--- ${safePath}`,
    `+++ ${safePath}`,
  ];

  for (const hunk of changedHunks) {
    out.push(numberedDiffHunkHeader(hunk));
    for (const line of hunk) {
      out.push(`${line.sign}${line.content}`);
    }
  }

  return `${out.join("\n")}\n`;
}

function parseNumberedDiffLine(
  line: string,
): NumberedDiffLine | undefined {
  const sign = line[0];
  if (sign !== " " && sign !== "+" && sign !== "-") return undefined;

  const rest = line.slice(1);
  if (sign === " " && /^ +\.\.\.$/.test(rest)) return { kind: "gap" };

  const match = /^ *(\d+) (.*)$/.exec(rest);
  if (!match) return undefined;

  return {
    kind: "line",
    sign,
    lineNumber: Number.parseInt(match[1]!, 10),
    content: match[2] ?? "",
  };
}

function numberedDiffHunkHeader(
  hunk: Array<Extract<NumberedDiffLine, { kind: "line" }>>,
): string {
  const oldLines = hunk.filter((line) => line.sign !== "+");
  const newLines = hunk.filter((line) => line.sign !== "-");
  const oldStart = hunkStart(oldLines, newLines);
  const newStart = hunkStart(newLines, oldLines);
  return `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`;
}

function hunkStart(
  primary: Array<Extract<NumberedDiffLine, { kind: "line" }>>,
  fallback: Array<Extract<NumberedDiffLine, { kind: "line" }>>,
): number {
  const firstPrimary = primary[0]?.lineNumber;
  if (typeof firstPrimary === "number") return firstPrimary;

  const firstFallback = fallback[0]?.lineNumber;
  if (typeof firstFallback === "number") return Math.max(0, firstFallback - 1);

  return 0;
}

function sanitizePatchPath(path: string): string {
  return path.replace(/[\r\n\t]/g, " ");
}
