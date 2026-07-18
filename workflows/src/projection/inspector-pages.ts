import type { WorkflowRunDatabaseReader } from "../persistence/run-database.js";
import type { JsonObject } from "../types.js";
import {
  WORKFLOW_PROJECTION_LIMITS as LIMITS,
  type WorkflowInspectorPage,
  type WorkflowInspectorPageKind,
} from "./types.js";

export interface WorkflowInspectorPageOptions { cursor?: string; limit?: number }

export function readWorkflowInspectorPage(
  reader: WorkflowRunDatabaseReader,
  kind: WorkflowInspectorPageKind,
  options: WorkflowInspectorPageOptions = {},
): WorkflowInspectorPage {
  const limit = pageLimit(options.limit);
  const cursor = decodeCursor(kind, options.cursor);
  return reader.readSnapshot(database => {
    const run = database.readRun();
    switch (kind) {
      case "operations": {
        const rows = database.listOperations({ afterOrdinal: integerCursor(cursor, -1), limit: limit + 1 })
          .map(operation => boundedEntry({
            ...operation,
            scope: database.readScope(operation.scopeId),
            call: database.readScopeCall(operation.operationId),
            join: database.readStructuralJoin(operation.operationId),
            artifacts: database.listOperationArtifacts(operation.operationId),
          }));
        return page(run.runId, run.revision, kind, rows, limit, entry => (entry as any).ordinal);
      }
      case "events": {
        const rows = database.listEvents({ afterSequence: integerCursor(cursor, 0), limit: limit + 1 })
          .map(boundedEntry);
        return page(run.runId, run.revision, kind, rows, limit, entry => (entry as any).sequence);
      }
      case "attempts": {
        const after = pairCursor(cursor, "createdAt", "attemptId");
        const rows = database.listAttempts({ ...(after ? { after } : {}), limit: limit + 1 }).map(boundedEntry);
        return page(run.runId, run.revision, kind, rows, limit, entry => ({
          createdAt: (entry as any).createdAt,
          attemptId: (entry as any).attemptId,
        }));
      }
      case "artifacts": {
        const after = pairCursor(cursor, "createdAt", "digest");
        const rows = database.listArtifacts({ ...(after ? { after } : {}), limit: limit + 1 }).map(record => boundedEntry({
          digest: record.digest,
          kind: record.kind,
          mediaType: record.mediaType,
          bytes: record.bytes,
          metadata: record.metadata,
          createdAt: record.createdAt,
        }));
        return page(run.runId, run.revision, kind, rows, limit, entry => ({
          createdAt: (entry as any).createdAt,
          digest: (entry as any).digest,
        }));
      }
      case "measurements": {
        const after = pairCursor(cursor, "createdAt", "measurementId");
        const rows = database.listMeasurementsPage({ ...(after ? { after } : {}), limit: limit + 1 })
          .map(measurement => boundedEntry({
            measurementId: measurement.measurementId,
            operationId: measurement.operationId,
            metricSetId: measurement.metricSetId,
            profileId: measurement.profile.id,
            profileHash: measurement.profileHash,
            candidateId: measurement.candidateId ?? null,
            workspaceTreeHash: measurement.workspaceTreeHash,
            observations: measurement.observations,
            sampleCount: measurement.samples.length,
            artifactDigest: measurement.artifactDigest,
            createdAt: measurement.createdAt,
          }));
        return page(run.runId, run.revision, kind, rows, limit, entry => ({
          createdAt: (entry as any).createdAt,
          measurementId: (entry as any).measurementId,
        }));
      }
      case "experiments": {
        const after = pairCursor(cursor, "createdAt", "experimentId");
        const rows = database.listExperimentsPage({ ...(after ? { after } : {}), limit: limit + 1 })
          .map(boundedEntry);
        return page(run.runId, run.revision, kind, rows, limit, entry => ({
          createdAt: (entry as any).createdAt,
          experimentId: (entry as any).experimentId,
        }));
      }
      case "candidates": {
        const after = pairCursor(cursor, "frozenAt", "candidateId");
        const rows = database.listCandidatesPage({ ...(after ? { after } : {}), limit: limit + 1 })
          .map(candidate => boundedEntry({
            ...candidate,
            verifications: database.listCandidateVerifications(candidate.candidateId),
            measurement: database.readCandidateMeasurement(candidate.candidateId) ?? null,
            apply: database.readCandidateApply(candidate.candidateId) ?? null,
          }));
        return page(run.runId, run.revision, kind, rows, limit, entry => ({
          frozenAt: (entry as any).frozenAt,
          candidateId: (entry as any).candidateId,
        }));
      }
      case "resources": {
        const after = cursor === undefined ? "" : stringCursor(cursor);
        const rows = database.listInvocationResources()
          .filter(resource => resource.inputPath > after)
          .slice(0, limit + 1)
          .map(boundedEntry);
        return page(run.runId, run.revision, kind, rows, limit, entry => (entry as any).inputPath);
      }
    }
  });
}

function page<T>(
  runId: string,
  revision: number,
  kind: WorkflowInspectorPageKind,
  source: T[],
  limit: number,
  key: (entry: T) => unknown,
): WorkflowInspectorPage<any> {
  const entries: T[] = [];
  let entryBytes = 2;
  for (const entry of source.slice(0, limit)) {
    const next = Buffer.byteLength(JSON.stringify(entry), "utf8") + (entries.length ? 1 : 0);
    if (entryBytes + next > LIMITS.pageBytes - 4_096) break;
    entries.push(entry);
    entryBytes += next;
  }
  const more = source.length > entries.length;
  const result: WorkflowInspectorPage<any> = {
    runId,
    revision,
    kind,
    entries,
    ...(more && entries.length ? { nextCursor: encodeCursor(kind, key(entries.at(-1)!)) } : {}),
    bytes: 0,
  };
  result.bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (result.bytes > LIMITS.pageBytes) throw new Error("Workflow inspector page exceeds its byte bound");
  return result;
}

function boundedEntry<T>(entry: T): T | JsonObject {
  if (Buffer.byteLength(JSON.stringify(entry), "utf8") <= LIMITS.pageBytes / 2) return entry;
  const value = entry as Record<string, unknown>;
  return Object.fromEntries([
    "sequence", "revision", "type", "operationId", "attemptId", "candidateId", "measurementId",
    "experimentId", "resourceId", "digest", "kind", "status", "createdAt", "frozenAt", "at",
  ].flatMap(key => value[key] === undefined ? [] : [[key, value[key]]]).concat([["detailOmitted", true]])) as JsonObject;
}

function encodeCursor(kind: WorkflowInspectorPageKind, value: unknown): string {
  return Buffer.from(JSON.stringify({ kind, value }), "utf8").toString("base64url");
}

function decodeCursor(kind: WorkflowInspectorPageKind, cursor: string | undefined): unknown {
  if (!cursor) return undefined;
  if (cursor.length > 2_048 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new TypeError("Invalid workflow inspector cursor");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); }
  catch { throw new TypeError("Invalid workflow inspector cursor"); }
  if (!plainRecord(value) || Object.keys(value).sort().join(",") !== "kind,value"
    || value.kind !== kind || !("value" in value)) {
    throw new TypeError("Workflow inspector cursor belongs to another page");
  }
  return value.value;
}

function integerCursor(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("Invalid workflow integer cursor");
  return value as number;
}

function stringCursor(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Invalid workflow string cursor");
  return value;
}

function pairCursor<A extends string, B extends string>(
  value: unknown,
  first: A,
  second: B,
): Record<A | B, string> | undefined {
  if (value === undefined) return undefined;
  if (!plainRecord(value) || typeof value[first] !== "string" || typeof value[second] !== "string") {
    throw new TypeError("Invalid workflow pair cursor");
  }
  return { [first]: value[first], [second]: value[second] } as Record<A | B, string>;
}

function pageLimit(value: number | undefined): number {
  const limit = value ?? 32;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Workflow inspector page limit must be positive");
  return Math.min(limit, LIMITS.pageEntries);
}

function plainRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
