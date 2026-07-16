import type { DiagnosticSeverity, DiagnosticSnapshot, LspDiagnostic } from "../types.ts";

export function createDiagnosticSnapshot(diagnostics: LspDiagnostic[], takenAt = Date.now()): DiagnosticSnapshot {
  const byUri = new Map<string, LspDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    const bucket = byUri.get(diagnostic.uri) ?? [];
    bucket.push(diagnostic);
    byUri.set(diagnostic.uri, bucket);
  }
  return { takenAt, byUri };
}

export function flattenDiagnosticSnapshot(snapshot: DiagnosticSnapshot): LspDiagnostic[] {
  return [...snapshot.byUri.values()].flat();
}

export function countDiagnosticSnapshotDiagnostics(snapshot: DiagnosticSnapshot): number {
  let count = 0;
  for (const diagnostics of snapshot.byUri.values()) count += diagnostics.length;
  return count;
}

export function diagnosticSeverityRank(severity: DiagnosticSeverity): number {
  switch (severity) {
    case "error":
      return 4;
    case "warning":
      return 3;
    case "information":
      return 2;
    case "hint":
      return 1;
  }
}

