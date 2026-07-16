import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRecord, type Position, type Range } from "../types.ts";

export interface LspPosition {
  line: number;      // 0-based
  character: number; // 0-based
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface ExternalPositionTarget {
  line: unknown;
  column?: unknown;
  symbol?: unknown;
  occurrence?: unknown;
}

const MAX_LSP_UINTEGER = 2_147_483_647;
export const MAX_POSITION_SYMBOL_LENGTH = 512;
const BARE_IDENTIFIER_RE = /^[$_\p{ID_Start}][$\u200C\u200D_\p{ID_Continue}]*$/u;
const IDENTIFIER_CHARACTER_RE = /^[$\u200C\u200D_\p{ID_Continue}]$/u;

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

export function resolveExternalPositionTarget(content: string, target: ExternalPositionTarget): LspPosition {
  const externalLine = readOneBasedInteger(target.line);
  if (externalLine === undefined) {
    throw new Error("requires 1-based line and column, or 1-based line and symbol");
  }

  const hasColumn = target.column !== undefined;
  const hasSymbol = target.symbol !== undefined;
  if (target.occurrence !== undefined && !hasSymbol) {
    throw new Error("requires symbol when occurrence is provided");
  }
  if (hasColumn && hasSymbol) {
    throw new Error("accepts either column or symbol, not both");
  }
  if (!hasColumn && !hasSymbol) {
    throw new Error("requires 1-based line and column, or 1-based line and symbol");
  }

  if (hasColumn) {
    const position = externalPositionToLsp(externalLine, target.column);
    if (!position) throw new Error("requires 1-based line and column");
    return position;
  }

  const symbol = readPositionSymbol(target.symbol);
  if (symbol === undefined) {
    throw new Error(`requires symbol to be a non-empty single-line string no longer than ${MAX_POSITION_SYMBOL_LENGTH} characters`);
  }
  const occurrence = target.occurrence === undefined ? 1 : readOneBasedInteger(target.occurrence);
  if (occurrence === undefined) throw new Error("requires occurrence to be a 1-based integer");

  const lines = content.split(/\r\n|\n|\r/);
  const lineText = lines[externalLine - 1];
  if (lineText === undefined) {
    throw new Error(`cannot resolve symbol on line ${externalLine}; file has ${lines.length} line${lines.length === 1 ? "" : "s"}`);
  }

  const match = findSymbolMatch(lineText, symbol, occurrence);
  if (match.count === 0) {
    throw new Error(`cannot find exact symbol ${JSON.stringify(symbol)} on line ${externalLine}`);
  }
  if (match.index === undefined) {
    throw new Error(`cannot find occurrence ${occurrence} of exact symbol ${JSON.stringify(symbol)} on line ${externalLine}; found ${match.count}`);
  }

  return { line: externalLine - 1, character: match.index };
}

function readPositionSymbol(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_POSITION_SYMBOL_LENGTH) return undefined;
  return /[\0\r\n]/.test(value) ? undefined : value;
}

function findSymbolMatch(lineText: string, symbol: string, occurrence: number): { index?: number; count: number } {
  const requireIdentifierBoundary = BARE_IDENTIFIER_RE.test(symbol);
  let count = 0;
  let fromIndex = 0;

  while (fromIndex <= lineText.length - symbol.length) {
    const matchIndex = lineText.indexOf(symbol, fromIndex);
    if (matchIndex < 0) break;
    const afterIndex = matchIndex + symbol.length;
    if (!requireIdentifierBoundary || (
      !isIdentifierCharacter(codePointBefore(lineText, matchIndex)) &&
      !isIdentifierCharacter(codePointAt(lineText, afterIndex))
    )) {
      count += 1;
      if (count === occurrence) return { index: matchIndex, count };
    }
    fromIndex = matchIndex + Math.max(1, symbol.length);
  }

  return { count };
}

function isIdentifierCharacter(value: string): boolean {
  return value.length > 0 && IDENTIFIER_CHARACTER_RE.test(value);
}

function codePointBefore(value: string, index: number): string {
  if (index <= 0) return "";
  const finalCodeUnit = value.charCodeAt(index - 1);
  if (finalCodeUnit >= 0xdc00 && finalCodeUnit <= 0xdfff && index >= 2) {
    const firstCodeUnit = value.charCodeAt(index - 2);
    if (firstCodeUnit >= 0xd800 && firstCodeUnit <= 0xdbff) return value.slice(index - 2, index);
  }
  return value[index - 1] ?? "";
}

function codePointAt(value: string, index: number): string {
  if (index >= value.length) return "";
  const codePoint = value.codePointAt(index);
  return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
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
  return isRecord(value) && isLspUInteger(value.line) && isLspUInteger(value.character);
}

export function isLspRange(value: unknown): value is LspRange {
  if (!isRecord(value) || !isLspPosition(value.start) || !isLspPosition(value.end)) return false;
  return value.start.line < value.end.line ||
    (value.start.line === value.end.line && value.start.character <= value.end.character);
}

export function isLspUInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_LSP_UINTEGER;
}

export function oneLineLspRange(position: LspPosition): LspRange {
  return { start: position, end: position };
}

