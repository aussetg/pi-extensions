import * as path from "node:path";
import { uriToFilePath } from "../lsp/positions.ts";
import { diagnosticSeverityRank, flattenDiagnosticSnapshot } from "./snapshots.ts";
import type {
  DiagnosticFilterResult,
  DiagnosticLinkReason,
  DiagnosticSnapshot,
  LinkedDiagnostic,
  LspDiagnostic,
  TouchedRange,
  WorkspaceDiagnosticDelta,
} from "../types.ts";

const NEARBY_TOUCHED_LINES = 2;
export const MAX_WORKSPACE_DELTA_DIAGNOSTICS = 20;
const MAX_WORKSPACE_DELTA_URI_CHARS = 2_048;
const MAX_WORKSPACE_DELTA_MESSAGE_CHARS = 1_000;
const MAX_WORKSPACE_DELTA_SOURCE_CHARS = 128;
const MAX_WORKSPACE_DELTA_CODE_CHARS = 256;

export interface LinkDiagnosticsInput {
  beforeSnapshot?: DiagnosticSnapshot;
  afterSnapshot: DiagnosticSnapshot;
  touchedRanges: TouchedRange[];
  maxInline: number;
  includeCrossFileRelated: boolean;
}

export function linkDiagnosticsToTouchedRanges(input: LinkDiagnosticsInput): DiagnosticFilterResult {
  const allAfter = flattenDiagnosticSnapshot(input.afterSnapshot);
  if (allAfter.length === 0 || input.touchedRanges.length === 0) {
    return emptyResult(allAfter.length);
  }

  const hasBeforeSnapshot = input.beforeSnapshot !== undefined;
  const beforeSeverityByIdentity = buildBeforeSeverityMap(input.beforeSnapshot);
  const allLinked: LinkedDiagnostic[] = [];

  for (const diagnostic of allAfter) {
    const isNewOrWorsened = diagnosticIsNewOrWorsened(diagnostic, beforeSeverityByIdentity, hasBeforeSnapshot);
    const link = findDiagnosticLink(diagnostic, input.touchedRanges, isNewOrWorsened, input.includeCrossFileRelated);
    if (!link) continue;
    allLinked.push({
      diagnostic,
      linkReason: link.reason,
      touchedRange: link.touchedRange,
      isNewOrWorsened,
    });
  }

  allLinked.sort(compareLinkedDiagnostics);
  const linked = allLinked.slice(0, Math.max(0, input.maxInline));

  return {
    linked,
    allLinked,
    summary: {
      totalDiagnostics: allAfter.length,
      linkedDiagnostics: allLinked.length,
      shownDiagnostics: linked.length,
      hiddenUnrelated: Math.max(0, allAfter.length - allLinked.length),
      hiddenByLimit: Math.max(0, allLinked.length - linked.length),
    },
  };
}

export interface WorkspaceDiagnosticDeltaInput {
  beforeSnapshot?: DiagnosticSnapshot;
  afterSnapshot: DiagnosticSnapshot;
  touchedRanges: TouchedRange[];
  linkedDiagnostics?: LinkedDiagnostic[];
  maxDiagnostics: number;
}

/**
 * Returns a bounded, deliberately non-causal view of diagnostics that appeared
 * or worsened on files other than the edited file. These are useful project
 * signals, but they must not be treated as touched-range attribution.
 */
export function workspaceDiagnosticDelta(input: WorkspaceDiagnosticDeltaInput): WorkspaceDiagnosticDelta | undefined {
  if (!input.beforeSnapshot || input.touchedRanges.length === 0) return undefined;

  const beforeSeverityByIdentity = buildBeforeSeverityMap(input.beforeSnapshot);
  const linked = new Set((input.linkedDiagnostics ?? []).map((entry) => entry.diagnostic));
  const seen = new Set<string>();
  const candidates: LspDiagnostic[] = [];

  for (const diagnostic of flattenDiagnosticSnapshot(input.afterSnapshot)) {
    if (linked.has(diagnostic)) continue;
    if (input.touchedRanges.some((range) => sameLocation(diagnostic.uri, range.uri, range.filePath))) continue;
    if (!diagnosticIsNewOrWorsened(diagnostic, beforeSeverityByIdentity, true)) continue;

    const identity = diagnosticIdentity(diagnostic);
    if (seen.has(identity)) continue;
    seen.add(identity);
    candidates.push(diagnostic);
  }

  if (candidates.length === 0) return undefined;
  candidates.sort(compareDiagnostics);
  const limit = Math.min(MAX_WORKSPACE_DELTA_DIAGNOSTICS, Math.max(0, Math.floor(input.maxDiagnostics)));
  const diagnostics = candidates.slice(0, limit);
  return {
    label: "possible workspace impact",
    diagnostics: diagnostics.map(boundWorkspaceDeltaDiagnostic),
    summary: {
      totalNewOrWorsened: candidates.length,
      shownDiagnostics: diagnostics.length,
      hiddenByLimit: Math.max(0, candidates.length - diagnostics.length),
    },
  };
}

function boundWorkspaceDeltaDiagnostic(diagnostic: LspDiagnostic): LspDiagnostic {
  return {
    uri: truncateText(diagnostic.uri, MAX_WORKSPACE_DELTA_URI_CHARS),
    range: diagnostic.range,
    severity: diagnostic.severity,
    message: truncateText(diagnostic.message, MAX_WORKSPACE_DELTA_MESSAGE_CHARS),
    source: diagnostic.source === undefined ? undefined : truncateText(diagnostic.source, MAX_WORKSPACE_DELTA_SOURCE_CHARS),
    code: typeof diagnostic.code === "string" ? truncateText(diagnostic.code, MAX_WORKSPACE_DELTA_CODE_CHARS) : diagnostic.code,
    version: diagnostic.version,
  };
}

function truncateText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function diagnosticOverlapsTouchedRange(diagnostic: LspDiagnostic, touchedRange: TouchedRange): boolean {
  if (!sameLocation(diagnostic.uri, touchedRange.uri, touchedRange.filePath)) return false;
  const diagnosticRange = externalRangeLineSpan(diagnostic.range);
  return diagnosticRange.startLine <= touchedRange.endLine && diagnosticRange.endLine >= touchedRange.startLine;
}

function findDiagnosticLink(
  diagnostic: LspDiagnostic,
  touchedRanges: TouchedRange[],
  isNewOrWorsened: boolean,
  includeCrossFileRelated: boolean,
): { reason: DiagnosticLinkReason; touchedRange: TouchedRange } | undefined {
  for (const touchedRange of touchedRanges) {
    if (diagnosticOverlapsTouchedRange(diagnostic, touchedRange)) {
      return { reason: "overlap", touchedRange };
    }
  }

  for (const touchedRange of touchedRanges) {
    if (relatedInformationOverlapsTouchedRange(diagnostic, touchedRange)) {
      if (sameLocation(diagnostic.uri, touchedRange.uri, touchedRange.filePath)) {
        return { reason: "related-information", touchedRange };
      }
      if (includeCrossFileRelated && isNewOrWorsened) {
        return { reason: "cascade-related", touchedRange };
      }
    }
  }

  if (!isNewOrWorsened) return undefined;

  for (const touchedRange of touchedRanges) {
    if (!sameLocation(diagnostic.uri, touchedRange.uri, touchedRange.filePath)) continue;
    const diagnosticRange = externalRangeLineSpan(diagnostic.range);
    if (diagnosticRange.startLine <= touchedRange.endLine + NEARBY_TOUCHED_LINES && diagnosticRange.endLine >= touchedRange.startLine - NEARBY_TOUCHED_LINES) {
      return { reason: "new-on-touched-file", touchedRange };
    }
  }

  return undefined;
}

function relatedInformationOverlapsTouchedRange(diagnostic: LspDiagnostic, touchedRange: TouchedRange): boolean {
  for (const related of diagnostic.relatedInformation ?? []) {
    if (!sameLocation(related.uri, touchedRange.uri, touchedRange.filePath)) continue;
    const relatedRange = externalRangeLineSpan(related.range);
    if (relatedRange.startLine <= touchedRange.endLine && relatedRange.endLine >= touchedRange.startLine) {
      return true;
    }
  }
  return false;
}

function diagnosticIsNewOrWorsened(diagnostic: LspDiagnostic, beforeSeverityByIdentity: Map<string, number>, hasBeforeSnapshot: boolean): boolean {
  if (!hasBeforeSnapshot) return false;
  const beforeSeverity = beforeSeverityByIdentity.get(diagnosticIdentity(diagnostic));
  return beforeSeverity === undefined || diagnosticSeverityRank(diagnostic.severity) > beforeSeverity;
}

function buildBeforeSeverityMap(snapshot: DiagnosticSnapshot | undefined): Map<string, number> {
  const map = new Map<string, number>();
  if (!snapshot) return map;

  for (const diagnostic of flattenDiagnosticSnapshot(snapshot)) {
    const key = diagnosticIdentity(diagnostic);
    const rank = diagnosticSeverityRank(diagnostic.severity);
    const existing = map.get(key);
    if (existing === undefined || rank > existing) {
      map.set(key, rank);
    }
  }

  return map;
}

function diagnosticIdentity(diagnostic: LspDiagnostic): string {
  return [
    normalizeUri(diagnostic.uri),
    diagnostic.source ?? "",
    diagnostic.code ?? "",
    normalizeMessage(diagnostic.message),
  ].join("\0");
}

function normalizeMessage(message: string): string {
  return message.toLowerCase().replace(/\s+/g, " ").trim();
}

function compareLinkedDiagnostics(left: LinkedDiagnostic, right: LinkedDiagnostic): number {
  return (
    diagnosticSeverityRank(right.diagnostic.severity) - diagnosticSeverityRank(left.diagnostic.severity) ||
    linkReasonRank(left.linkReason) - linkReasonRank(right.linkReason) ||
    normalizeUri(left.diagnostic.uri).localeCompare(normalizeUri(right.diagnostic.uri)) ||
    externalRangeLineSpan(left.diagnostic.range).startLine - externalRangeLineSpan(right.diagnostic.range).startLine ||
    String(left.diagnostic.code ?? "").localeCompare(String(right.diagnostic.code ?? "")) ||
    left.diagnostic.message.localeCompare(right.diagnostic.message)
  );
}

function compareDiagnostics(left: LspDiagnostic, right: LspDiagnostic): number {
  return (
    diagnosticSeverityRank(right.severity) - diagnosticSeverityRank(left.severity) ||
    normalizeUri(left.uri).localeCompare(normalizeUri(right.uri)) ||
    externalRangeLineSpan(left.range).startLine - externalRangeLineSpan(right.range).startLine ||
    normalizeLine(left.range.start.character) - normalizeLine(right.range.start.character) ||
    String(left.code ?? "").localeCompare(String(right.code ?? "")) ||
    left.message.localeCompare(right.message)
  );
}

function linkReasonRank(reason: DiagnosticLinkReason): number {
  switch (reason) {
    case "overlap":
      return 0;
    case "related-information":
      return 1;
    case "cascade-related":
      return 2;
    case "new-on-touched-file":
      return 3;
    case "all-diagnostics":
      return 4;
  }
}

function externalRangeLineSpan(range: LspDiagnostic["range"]): { startLine: number; endLine: number } {
  const startLine = normalizeLine(range.start.line);
  const rawEndLine = normalizeLine(range.end.line);
  const endLine = rawEndLine > startLine && normalizeLine(range.end.character) <= 1 ? rawEndLine - 1 : rawEndLine;
  return { startLine: Math.min(startLine, endLine), endLine: Math.max(startLine, endLine) };
}

function emptyResult(totalDiagnostics: number): DiagnosticFilterResult {
  return {
    linked: [],
    allLinked: [],
    summary: {
      totalDiagnostics,
      linkedDiagnostics: 0,
      shownDiagnostics: 0,
      hiddenUnrelated: totalDiagnostics,
      hiddenByLimit: 0,
    },
  };
}

function sameLocation(leftUri: string, rightUri: string, rightFilePath?: string): boolean {
  const left = normalizeUri(leftUri);
  const right = normalizeUri(rightUri);
  if (left === right) return true;

  const leftPath = uriToPath(leftUri);
  const rightPath = rightFilePath ? path.resolve(rightFilePath) : uriToPath(rightUri);
  return leftPath !== undefined && rightPath !== undefined && path.resolve(leftPath) === path.resolve(rightPath);
}

function normalizeUri(uri: string): string {
  return uri.replace(/\\/g, "/");
}

function uriToPath(uri: string): string | undefined {
  return uriToFilePath(uri) ?? (path.isAbsolute(uri) ? uri : undefined);
}

function normalizeLine(line: number): number {
  if (!Number.isFinite(line)) return 1;
  return Math.max(1, Math.floor(line));
}

