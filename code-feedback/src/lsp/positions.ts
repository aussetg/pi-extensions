import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Position, Range } from "../types.ts";

export interface LspPosition {
  line: number;      // 0-based
  character: number; // 0-based
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

const MAX_LSP_UINTEGER = 2_147_483_647;

export function filePathToUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

export function uriToFilePath(uri: string): string | undefined {
  try {
    if (!uri.startsWith("file:")) return undefined;
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

export function externalPositionToLsp(line: unknown, character: unknown): LspPosition | undefined {
  const externalLine = readOneBasedInteger(line);
  const externalCharacter = readOneBasedInteger(character);
  if (externalLine === undefined || externalCharacter === undefined) return undefined;
  return {
    line: externalLine - 1,
    character: externalCharacter - 1,
  };
}

function readOneBasedInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_LSP_UINTEGER + 1
    ? value
    : undefined;
}

export function lspPositionToExternal(position: unknown): Position | undefined {
  if (!isLspPosition(position)) return undefined;
  return {
    line: position.line + 1,
    character: position.character + 1,
  };
}

export function lspRangeToExternal(range: unknown): Range | undefined {
  if (!isLspRange(range)) return undefined;
  return {
    start: { line: range.start.line + 1, character: range.start.character + 1 },
    end: { line: range.end.line + 1, character: range.end.character + 1 },
  };
}

export function isLspPosition(value: unknown): value is LspPosition {
  if (!value || typeof value !== "object") return false;
  const position = value as { line?: unknown; character?: unknown };
  return isLspUInteger(position.line) && isLspUInteger(position.character);
}

export function isLspRange(value: unknown): value is LspRange {
  if (!value || typeof value !== "object") return false;
  const range = value as { start?: unknown; end?: unknown };
  if (!isLspPosition(range.start) || !isLspPosition(range.end)) return false;
  return range.start.line < range.end.line ||
    (range.start.line === range.end.line && range.start.character <= range.end.character);
}

export function isLspUInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_LSP_UINTEGER;
}

export function oneLineLspRange(position: LspPosition): LspRange {
  return { start: position, end: position };
}

