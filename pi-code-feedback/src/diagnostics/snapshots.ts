import { pathToFileURL } from "node:url";
import type { DiagnosticSeverity, DiagnosticSnapshot, LspDiagnostic, Range, RelatedLocation } from "../types.ts";

export function createDiagnosticSnapshot(diagnostics: LspDiagnostic[], takenAt = Date.now()): DiagnosticSnapshot {
  const byUri = new Map<string, LspDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    const bucket = byUri.get(diagnostic.uri) ?? [];
    bucket.push(diagnostic);
    byUri.set(diagnostic.uri, bucket);
  }
  return { takenAt, byUri };
}

export function readDiagnosticSnapshotFromDetails(details: unknown, keys: string[]): DiagnosticSnapshot | undefined {
  if (!details || typeof details !== "object") return undefined;
  const record = details as Record<string, unknown>;

  for (const key of keys) {
    const value = record[key];
    const snapshot = normalizeDiagnosticSnapshot(value);
    if (snapshot) return snapshot;
  }

  return undefined;
}

function normalizeDiagnosticSnapshot(value: unknown): DiagnosticSnapshot | undefined {
  if (!value) return undefined;

  if (Array.isArray(value)) {
    const diagnostics = value.map(normalizeDiagnostic).filter((diagnostic): diagnostic is LspDiagnostic => diagnostic !== undefined);
    return createDiagnosticSnapshot(diagnostics);
  }

  if (typeof value !== "object") return undefined;
  const candidate = value as { byUri?: unknown; diagnostics?: unknown; takenAt?: unknown };

  if (Array.isArray(candidate.diagnostics)) {
    const diagnostics = candidate.diagnostics.map(normalizeDiagnostic).filter((diagnostic): diagnostic is LspDiagnostic => diagnostic !== undefined);
    return createDiagnosticSnapshot(diagnostics, typeof candidate.takenAt === "number" ? candidate.takenAt : Date.now());
  }

  if (candidate.byUri instanceof Map) {
    const diagnostics: LspDiagnostic[] = [];
    for (const values of candidate.byUri.values()) {
      if (!Array.isArray(values)) continue;
      diagnostics.push(...values.map(normalizeDiagnostic).filter((diagnostic): diagnostic is LspDiagnostic => diagnostic !== undefined));
    }
    return createDiagnosticSnapshot(diagnostics, typeof candidate.takenAt === "number" ? candidate.takenAt : Date.now());
  }

  if (candidate.byUri && typeof candidate.byUri === "object") {
    const diagnostics: LspDiagnostic[] = [];
    for (const values of Object.values(candidate.byUri as Record<string, unknown>)) {
      if (!Array.isArray(values)) continue;
      diagnostics.push(...values.map(normalizeDiagnostic).filter((diagnostic): diagnostic is LspDiagnostic => diagnostic !== undefined));
    }
    return createDiagnosticSnapshot(diagnostics, typeof candidate.takenAt === "number" ? candidate.takenAt : Date.now());
  }

  return undefined;
}

function normalizeDiagnostic(value: unknown): LspDiagnostic | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const uri = readUri(candidate);
  const range = readRange(candidate);
  const severity = readSeverity(candidate.severity);
  const message = typeof candidate.message === "string" ? candidate.message : undefined;
  if (!uri || !range || !severity || !message) return undefined;

  return {
    uri,
    range,
    severity,
    message,
    source: typeof candidate.source === "string" ? candidate.source : undefined,
    code: typeof candidate.code === "string" || typeof candidate.code === "number" ? candidate.code : undefined,
    relatedInformation: readRelatedInformation(candidate.relatedInformation),
    version: typeof candidate.version === "number" ? candidate.version : undefined,
  };
}

function readUri(candidate: Record<string, unknown>): string | undefined {
  if (typeof candidate.uri === "string") return candidate.uri;
  const path = typeof candidate.filePath === "string" ? candidate.filePath : typeof candidate.path === "string" ? candidate.path : undefined;
  return path ? pathToFileURL(path).href : undefined;
}

function readRange(candidate: Record<string, unknown>): Range | undefined {
  const range = candidate.range;
  if (range && typeof range === "object") {
    const raw = range as { start?: unknown; end?: unknown };
    const start = readPosition(raw.start);
    const end = readPosition(raw.end);
    if (start && end) return { start, end };
  }

  const line = typeof candidate.line === "number" ? candidate.line : undefined;
  const character = typeof candidate.character === "number" ? candidate.character : typeof candidate.column === "number" ? candidate.column : 1;
  if (line === undefined) return undefined;
  return {
    start: { line: normalizeLine(line), character: normalizeCharacter(character) },
    end: { line: normalizeLine(line), character: normalizeCharacter(character) },
  };
}

function readPosition(value: unknown): { line: number; character: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const position = value as { line?: unknown; character?: unknown; column?: unknown };
  if (typeof position.line !== "number") return undefined;
  const character = typeof position.character === "number" ? position.character : typeof position.column === "number" ? position.column : 1;
  return { line: normalizeLine(position.line), character: normalizeCharacter(character) };
}

function readSeverity(value: unknown): DiagnosticSeverity | undefined {
  if (value === "error" || value === "warning" || value === "information" || value === "hint") return value;
  if (value === "info") return "information";
  if (value === 1) return "error";
  if (value === 2) return "warning";
  if (value === 3) return "information";
  if (value === 4) return "hint";
  return undefined;
}

function readRelatedInformation(value: unknown): LspDiagnostic["relatedInformation"] {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((entry): RelatedLocation | undefined => {
      if (!entry || typeof entry !== "object") return undefined;
      const candidate = entry as Record<string, unknown>;
      const uri = readUri(candidate);
      const range = readRange(candidate);
      if (!uri || !range) return undefined;
      const message = typeof candidate.message === "string" ? candidate.message : undefined;
      return message === undefined ? { uri, range } : { uri, range, message };
    })
    .filter((entry): entry is RelatedLocation => entry !== undefined);
}

function normalizeLine(line: number): number {
  if (!Number.isFinite(line)) return 1;
  return Math.max(1, Math.floor(line));
}

function normalizeCharacter(character: number): number {
  if (!Number.isFinite(character)) return 1;
  return Math.max(1, Math.floor(character));
}

