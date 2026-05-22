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
  if (typeof line !== "number" || !Number.isFinite(line)) return undefined;
  const rawCharacter = typeof character === "number" && Number.isFinite(character) ? character : 1;
  return {
    line: Math.max(0, Math.floor(line) - 1),
    character: Math.max(0, Math.floor(rawCharacter) - 1),
  };
}

export function lspPositionToExternal(position: LspPosition): Position {
  return {
    line: Math.max(1, Math.floor(position.line) + 1),
    character: Math.max(1, Math.floor(position.character) + 1),
  };
}

export function lspRangeToExternal(range: LspRange): Range {
  return {
    start: lspPositionToExternal(range.start),
    end: lspPositionToExternal(range.end),
  };
}

export function oneLineLspRange(position: LspPosition): LspRange {
  return { start: position, end: position };
}

