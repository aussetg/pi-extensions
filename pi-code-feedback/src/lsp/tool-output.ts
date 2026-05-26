import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const LSP_TOOL_MAX_BYTES = 50 * 1024;
export const LSP_TOOL_MAX_LINES = 2000;
export const LSP_TOOL_DETAILS_MAX_BYTES = 32 * 1024;
export const LSP_TOOL_DETAILS_MAX_STRING_BYTES = 8 * 1024;
export const LSP_TOOL_DETAILS_MAX_ARRAY_ITEMS = 100;
export const LSP_TOOL_DETAILS_MAX_OBJECT_PROPERTIES = 80;
export const LSP_TOOL_DETAILS_MAX_DEPTH = 8;
export const LSP_TOOL_VISIBLE_JSON_MAX_BYTES = 40 * 1024;
export const LSP_TOOL_VISIBLE_JSON_MAX_STRING_BYTES = 8 * 1024;
export const LSP_TOOL_VISIBLE_JSON_MAX_ARRAY_ITEMS = 120;
export const LSP_TOOL_VISIBLE_JSON_MAX_OBJECT_PROPERTIES = 100;
export const LSP_TOOL_VISIBLE_JSON_MAX_DEPTH = 8;

export interface LspToolTruncation {
  truncated: true;
  maxBytes: number;
  maxLines: number;
  outputBytes: number;
  outputLines: number;
  totalBytes: number;
  totalLines: number;
  fullOutputPath: string;
}

export interface LspToolJsonLimits {
  maxBytes: number;
  maxStringBytes: number;
  maxArrayItems: number;
  maxObjectProperties: number;
  maxDepth: number;
}

export interface LspToolJsonTruncation {
  truncated: true;
  maxBytes: number;
  maxStringBytes: number;
  maxArrayItems: number;
  maxObjectProperties: number;
  maxDepth: number;
  estimatedBytes: number;
  omitted: {
    strings: number;
    arrayItems: number;
    objectProperties: number;
    depth: number;
    circular: number;
    budget: number;
    unsupported: number;
  };
}

export type LspToolDetailsTruncation = LspToolJsonTruncation;

interface JsonLimitState {
  limits: LspToolJsonLimits;
  remainingBytes: number;
  estimatedBytes: number;
  seen: WeakSet<object>;
  omitted: LspToolJsonTruncation["omitted"];
}

interface BoundedRecordKeys {
  keys: string[];
  hasMore: boolean;
}

export const LSP_TOOL_DETAILS_JSON_LIMITS = {
  maxBytes: LSP_TOOL_DETAILS_MAX_BYTES,
  maxStringBytes: LSP_TOOL_DETAILS_MAX_STRING_BYTES,
  maxArrayItems: LSP_TOOL_DETAILS_MAX_ARRAY_ITEMS,
  maxObjectProperties: LSP_TOOL_DETAILS_MAX_OBJECT_PROPERTIES,
  maxDepth: LSP_TOOL_DETAILS_MAX_DEPTH,
} satisfies LspToolJsonLimits;

export const LSP_TOOL_VISIBLE_JSON_LIMITS = {
  maxBytes: LSP_TOOL_VISIBLE_JSON_MAX_BYTES,
  maxStringBytes: LSP_TOOL_VISIBLE_JSON_MAX_STRING_BYTES,
  maxArrayItems: LSP_TOOL_VISIBLE_JSON_MAX_ARRAY_ITEMS,
  maxObjectProperties: LSP_TOOL_VISIBLE_JSON_MAX_OBJECT_PROPERTIES,
  maxDepth: LSP_TOOL_VISIBLE_JSON_MAX_DEPTH,
} satisfies LspToolJsonLimits;

const JSON_BUDGET_MARKER = "[truncated: JSON byte budget exceeded]";

export function limitLspToolText(text: string): { text: string; truncation?: LspToolTruncation } {
  const totalBytes = Buffer.byteLength(text, "utf8");
  const totalLines = countLines(text);
  if (totalBytes <= LSP_TOOL_MAX_BYTES && totalLines <= LSP_TOOL_MAX_LINES) {
    return { text };
  }

  const content = takeHeadByLinesAndBytes(text, LSP_TOOL_MAX_LINES, LSP_TOOL_MAX_BYTES);
  const fullOutputPath = writeTempOutput(text);
  const outputBytes = Buffer.byteLength(content, "utf8");
  const outputLines = countLines(content);
  const truncation: LspToolTruncation = {
    truncated: true,
    maxBytes: LSP_TOOL_MAX_BYTES,
    maxLines: LSP_TOOL_MAX_LINES,
    outputBytes,
    outputLines,
    totalBytes,
    totalLines,
    fullOutputPath,
  };

  return {
    text: `${content.trimEnd()}\n\n${formatTruncationNotice(truncation)}`,
    truncation,
  };
}

export function limitLspToolDetails(details: unknown): { details: unknown; truncation?: LspToolDetailsTruncation } {
  const limited = limitLspJsonValue(details, LSP_TOOL_DETAILS_JSON_LIMITS);
  return { details: limited.value, truncation: limited.truncation };
}

export function formatLspToolJson(value: unknown, limits: LspToolJsonLimits = LSP_TOOL_VISIBLE_JSON_LIMITS): { text: string; truncation?: LspToolJsonTruncation } {
  const limited = limitLspJsonValue(value, limits);
  const text = JSON.stringify(limited.value, null, 2) ?? String(limited.value);
  return {
    text: limited.truncation ? `${text}\n... truncated` : text,
    truncation: limited.truncation,
  };
}

export function limitLspJsonValue(value: unknown, limits: LspToolJsonLimits): { value: unknown; truncation?: LspToolJsonTruncation } {
  const state: JsonLimitState = {
    limits,
    remainingBytes: limits.maxBytes,
    estimatedBytes: 0,
    seen: new WeakSet<object>(),
    omitted: {
      strings: 0,
      arrayItems: 0,
      objectProperties: 0,
      depth: 0,
      circular: 0,
      budget: 0,
      unsupported: 0,
    },
  };

  const limited = limitJsonValue(value, state, 0);
  const omitted = state.omitted;
  const truncated = Object.values(omitted).some((count) => count > 0);
  return {
    value: limited,
    truncation: truncated
      ? {
        truncated: true,
        maxBytes: limits.maxBytes,
        maxStringBytes: limits.maxStringBytes,
        maxArrayItems: limits.maxArrayItems,
        maxObjectProperties: limits.maxObjectProperties,
        maxDepth: limits.maxDepth,
        estimatedBytes: state.estimatedBytes,
        omitted,
      }
      : undefined,
  };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}

function limitJsonValue(value: unknown, state: JsonLimitState, depth: number): unknown {
  if (value === null) return chargeLiteral(state, "null") ? null : budgetMarker();

  switch (typeof value) {
    case "string":
      return limitJsonString(value, state);
    case "number":
      if (!Number.isFinite(value)) {
        state.omitted.unsupported += 1;
        return chargeLiteral(state, "null") ? null : budgetMarker();
      }
      return chargeLiteral(state, JSON.stringify(value)) ? value : budgetMarker();
    case "boolean":
      return chargeLiteral(state, JSON.stringify(value)) ? value : budgetMarker();
    case "undefined":
      return undefined;
    case "bigint":
      state.omitted.unsupported += 1;
      return limitJsonString(value.toString(), state);
    case "symbol":
    case "function":
      state.omitted.unsupported += 1;
      return limitJsonMarker(`[${typeof value}]`, state);
    case "object":
      return limitJsonObject(value as object, state, depth);
  }
}

function limitJsonObject(value: object, state: JsonLimitState, depth: number): unknown {
  if (state.seen.has(value)) {
    state.omitted.circular += 1;
    return limitJsonMarker("[circular]", state);
  }
  if (depth >= state.limits.maxDepth) {
    state.omitted.depth += 1;
    const marker = Array.isArray(value) ? `[array depth limit: ${value.length} item${value.length === 1 ? "" : "s"}]` : "[object depth limit]";
    return limitJsonMarker(marker, state);
  }

  if (value instanceof Date) return limitJsonString(Number.isFinite(value.getTime()) ? value.toISOString() : "[invalid date]", state);

  state.seen.add(value);
  try {
    return Array.isArray(value)
      ? limitJsonArray(value, state, depth + 1)
      : limitJsonRecord(value as Record<string, unknown>, state, depth + 1);
  } finally {
    state.seen.delete(value);
  }
}

function limitJsonArray(value: unknown[], state: JsonLimitState, depth: number): unknown[] {
  if (!chargeLiteral(state, "[]")) return [budgetMarker()];

  const out: unknown[] = [];
  const limit = Math.min(value.length, state.limits.maxArrayItems);
  for (let index = 0; index < limit; index += 1) {
    if (state.remainingBytes <= 0) {
      state.omitted.budget += 1;
      break;
    }
    if (out.length > 0 && !chargeLiteral(state, ",")) break;
    if (value[index] === undefined) {
      if (!chargeLiteral(state, "null")) break;
      out.push(null);
      continue;
    }
    out.push(limitJsonValue(value[index], state, depth));
  }

  const omittedItems = value.length - out.length;
  if (omittedItems > 0) {
    state.omitted.arrayItems += omittedItems;
    appendArrayTruncationMarker(out, state, { __truncated: true, omittedItems, totalItems: value.length });
  }
  return out;
}

function limitJsonRecord(value: Record<string, unknown>, state: JsonLimitState, depth: number): Record<string, unknown> {
  if (!chargeLiteral(state, "{}")) return { __truncated: true, reason: "JSON byte budget exceeded" };

  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const { keys, hasMore } = ownEnumerableStringKeysBounded(value, state.limits.maxObjectProperties);
  let copied = 0;
  let emitted = 0;

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    if (state.remainingBytes <= 0) {
      state.omitted.budget += 1;
      break;
    }
    if (emitted > 0 && !chargeLiteral(state, ",")) break;
    if (!chargeLiteral(state, JSON.stringify(key) + ":")) break;
    const entryValue = readJsonRecordProperty(value, key, state);
    const limited = limitJsonValue(entryValue, state, depth);
    if (limited !== undefined) {
      setJsonRecordProperty(out, key, limited);
      emitted += 1;
    }
    copied += 1;
  }

  const omittedProperties = keys.length - copied + (hasMore ? 1 : 0);
  if (omittedProperties > 0) {
    state.omitted.objectProperties += omittedProperties;
    appendRecordTruncationMarker(out, state, hasMore
      ? { omittedPropertiesAtLeast: omittedProperties, totalPropertiesAtLeast: copied + omittedProperties }
      : { omittedProperties, totalProperties: keys.length });
  }
  return out;
}

function readJsonRecordProperty(value: Record<string, unknown>, key: string, state: JsonLimitState): unknown {
  try {
    return value[key];
  } catch {
    state.omitted.unsupported += 1;
    return "[property read failed]";
  }
}

function ownEnumerableStringKeysBounded(value: object, maxKeys: number): BoundedRecordKeys {
  const keys: string[] = [];
  let scanned = 0;
  const maxScanned = Math.max(maxKeys * 4, maxKeys + 16);

  for (const key in value) {
    scanned += 1;
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      if (scanned >= maxScanned) break;
      continue;
    }
    if (keys.length >= maxKeys) return { keys, hasMore: true };
    keys.push(key);
  }

  return { keys, hasMore: false };
}

function setJsonRecordProperty(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function limitJsonString(value: string, state: JsonLimitState): string {
  const totalBytes = Buffer.byteLength(value, "utf8");
  if (totalBytes <= state.limits.maxStringBytes && chargeBytes(state, jsonStringBytes(value))) return value;

  state.omitted.strings += 1;
  if (totalBytes > state.limits.maxStringBytes && totalBytes + 2 > state.remainingBytes) state.omitted.budget += 1;

  const marker = `… [truncated string: ${formatSize(totalBytes)}]`;
  const markerEscapedBytes = jsonEscapedContentBytes(marker);
  const maxPrefixEscapedBytes = Math.max(0, state.remainingBytes - 2 - markerEscapedBytes);
  const prefix = maxPrefixEscapedBytes > 0 ? takeJsonStringPrefix(value, maxPrefixEscapedBytes, state.limits.maxStringBytes) : "";
  const limited = prefix ? `${prefix}${marker}` : `[truncated string: ${formatSize(totalBytes)}]`;
  chargeBytesBestEffort(state, jsonStringBytes(limited));
  return limited;
}

function jsonStringBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function jsonEscapedContentBytes(value: string): number {
  return jsonStringBytes(value) - 2;
}

function takeJsonStringPrefix(text: string, maxEscapedBytes: number, maxRawBytes: number): string {
  let escapedBytes = 0;
  let rawBytes = 0;
  let out = "";
  for (const char of text) {
    const nextRawBytes = Buffer.byteLength(char, "utf8");
    if (rawBytes + nextRawBytes > maxRawBytes) break;
    const nextEscapedBytes = jsonEscapedContentBytes(char);
    if (escapedBytes + nextEscapedBytes > maxEscapedBytes) break;
    out += char;
    rawBytes += nextRawBytes;
    escapedBytes += nextEscapedBytes;
  }
  return out;
}

function appendArrayTruncationMarker(out: unknown[], state: JsonLimitState, marker: Record<string, unknown>): void {
  if (out.length > 0 && !chargeLiteral(state, ",")) {
    replaceLastArrayItemWithTruncationMarker(out, state, marker);
    return;
  }
  if (!chargeJsonValue(state, marker)) {
    replaceLastArrayItemWithTruncationMarker(out, state, marker);
    return;
  }
  out.push(marker);
}

function replaceLastArrayItemWithTruncationMarker(out: unknown[], state: JsonLimitState, marker: Record<string, unknown>): void {
  if (out.length === 0) return;
  const replacement = { ...marker };
  if (typeof replacement.omittedItems === "number") {
    replacement.omittedItems += 1;
    state.omitted.arrayItems += 1;
  }
  out[out.length - 1] = replacement;
}

function appendRecordTruncationMarker(out: Record<string, unknown>, state: JsonLimitState, marker: Record<string, unknown>): void {
  if (Object.keys(out).length > 0 && !chargeLiteral(state, ",")) return;
  if (!chargeLiteral(state, `${JSON.stringify("__truncated")}:`)) return;
  if (!chargeJsonValue(state, marker)) return;
  setJsonRecordProperty(out, "__truncated", marker);
}

function limitJsonMarker(marker: string, state: JsonLimitState): string {
  return chargeJsonValue(state, marker) ? marker : budgetMarker();
}

function chargeJsonValue(state: JsonLimitState, value: unknown): boolean {
  return chargeLiteral(state, JSON.stringify(value));
}

function chargeLiteral(state: JsonLimitState, literal: string | undefined): boolean {
  return chargeBytes(state, Buffer.byteLength(literal ?? "undefined", "utf8"));
}

function chargeBytes(state: JsonLimitState, bytes: number): boolean {
  if (bytes > state.remainingBytes) {
    state.omitted.budget += 1;
    state.remainingBytes = 0;
    return false;
  }
  state.remainingBytes -= bytes;
  state.estimatedBytes += bytes;
  return true;
}

function chargeBytesBestEffort(state: JsonLimitState, bytes: number): void {
  const charged = Math.min(bytes, Math.max(0, state.remainingBytes));
  state.remainingBytes -= charged;
  state.estimatedBytes += charged;
}

function budgetMarker(): string {
  return JSON_BUDGET_MARKER;
}

function formatTruncationNotice(truncation: LspToolTruncation): string {
  return [
    `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`,
    `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`,
    `Full output saved to: ${truncation.fullOutputPath}]`,
  ].join(" ");
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

function takeHeadByLinesAndBytes(text: string, maxLines: number, maxBytes: number): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let bytes = 0;

  for (const line of lines) {
    if (out.length >= maxLines) break;
    const suffix = out.length < lines.length - 1 ? "\n" : "";
    const candidate = `${line}${suffix}`;
    const candidateBytes = Buffer.byteLength(candidate, "utf8");
    if (bytes + candidateBytes > maxBytes) {
      const remaining = maxBytes - bytes;
      if (remaining > 0) out.push(takeUtf8Prefix(candidate, remaining));
      break;
    }
    out.push(candidate);
    bytes += candidateBytes;
  }

  return out.join("");
}

function takeUtf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let out = "";
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    out += char;
    bytes += charBytes;
  }
  return out;
}

function writeTempOutput(text: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lsp-"));
  const tempFile = path.join(tempDir, "output.txt");
  fs.writeFileSync(tempFile, text, "utf8");
  return tempFile;
}
