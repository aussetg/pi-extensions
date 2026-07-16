import type { RunDatabaseReader } from "../persistence/run-database-reader.js";
import type { JsonObject } from "../types.js";
import { projectOperationRecords } from "./run-projection.js";
import {
  WORKFLOW_PROJECTION_LIMITS as LIMITS,
  type WorkflowInspectorPage,
  type WorkflowInspectorPageKind,
  type WorkflowMeasurementPageEntry,
} from "./types.js";

export interface WorkflowInspectorPageOptions {
  cursor?: string;
  limit?: number;
}

/** Every branch is one keyset query with LIMIT page-size + 1. */
export function readWorkflowInspectorPage(
  reader: RunDatabaseReader,
  kind: WorkflowInspectorPageKind,
  options: WorkflowInspectorPageOptions = {},
): WorkflowInspectorPage {
  const limit = pageLimit(options.limit);
  const cursor = decodeCursor(kind, options.cursor);
  return reader.readSnapshot((snapshot) => {
    const run = snapshot.readRun();
    switch (kind) {
      case "operations": {
        const after = integerCursor(cursor, -1);
        const rows = snapshot.listOperations({ afterOrdinal: after, limit: limit + 1 });
        return page(run.runId, run.revision, kind, projectOperationRecords(rows).map((entry) => boundedEntry(entry)), limit, (entry: any) => entry.ordinal);
      }
      case "logs": {
        const after = integerCursor(cursor, 0);
        const rows = snapshot.listAgentProgressHistory({ afterSequence: after, limit: limit + 1 })
          .map((entry) => boundedEntry(entry));
        return page(run.runId, run.revision, kind, rows, limit, (entry: any) => entry.sequence);
      }
      case "artifacts": {
        const after = artifactCursor(cursor);
        const rows = snapshot.listArtifactsPage({ ...(after ? { after } : {}), limit: limit + 1 }).map((record) => boundedEntry({
          digest: record.digest,
          kind: record.kind,
          mediaType: record.mediaType,
          bytes: record.bytes,
          metadata: record.metadata,
          createdAt: record.createdAt,
        }));
        return page(run.runId, run.revision, kind, rows, limit, (entry: any) => ({ createdAt: entry.createdAt, digest: entry.digest }));
      }
      case "measurements": {
        const after = pairCursor(cursor);
        const rows = snapshot.listMeasurementsPage({ ...(after ? { after } : {}), limit: limit + 1 }).map((record): WorkflowMeasurementPageEntry => ({
          measurementId: record.measurementId,
          operationId: record.operationId,
          profileId: record.profileId,
          ...(record.candidateId ? { candidateId: record.candidateId } : {}),
          environmentHash: record.environmentHash,
          observationCount: record.delta.observations.length,
          sampleCount: record.samples.length,
          startedAt: record.startedAt,
          endedAt: record.endedAt,
        }));
        return page(run.runId, run.revision, kind, rows, limit, (entry) => ({
          endedAt: entry.endedAt,
          measurementId: entry.measurementId,
        }));
      }
      case "events": {
        const after = integerCursor(cursor, 0);
        const rows = snapshot.listEvents({ afterSequence: after, limit: limit + 1 }).map((entry) => boundedEntry(entry));
        return page(run.runId, run.revision, kind, rows, limit, (entry: any) => entry.sequence);
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
    const nextBytes = Buffer.byteLength(JSON.stringify(entry), "utf8") + (entries.length ? 1 : 0);
    if (entryBytes + nextBytes > LIMITS.pageBytes - 4_096) break;
    entries.push(entry);
    entryBytes += nextBytes;
  }
  const more = source.length > entries.length;
  const result: WorkflowInspectorPage<any> = {
    formatVersion: 1,
    runId,
    revision,
    kind,
    entries,
    ...(more && entries.length > 0 ? { nextCursor: encodeCursor(kind, key(entries.at(-1)!)) } : {}),
    bytes: 0,
  };
  result.bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (result.bytes > LIMITS.pageBytes) throw new Error("Inspector page exceeds its serialized byte bound");
  return result;
}

function boundedEntry<T>(entry: T): T | JsonObject {
  if (Buffer.byteLength(JSON.stringify(entry), "utf8") <= LIMITS.pageBytes / 2) return entry;
  const record = entry as Record<string, unknown>;
  const identity = Object.fromEntries(
    ["runId", "sequence", "revision", "type", "operationId", "attemptId", "agentSessionId", "at", "digest", "kind", "mediaType", "bytes", "createdAt"]
      .flatMap((key) => record[key] === undefined ? [] : [[key, record[key]]]),
  );
  return { ...identity, detailOmitted: true } as JsonObject;
}

function encodeCursor(kind: WorkflowInspectorPageKind, value: unknown): string {
  return Buffer.from(JSON.stringify({ v: 1, kind, value }), "utf8").toString("base64url");
}

function decodeCursor(kind: WorkflowInspectorPageKind, cursor: string | undefined): unknown {
  if (!cursor) return undefined;
  if (cursor.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new TypeError("Invalid inspector cursor");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new TypeError("Invalid inspector cursor"); }
  if (!plainRecord(value) || value.v !== 1 || value.kind !== kind || !("value" in value)) {
    throw new TypeError("Inspector cursor belongs to another page");
  }
  return value.value;
}

function integerCursor(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("Invalid inspector sequence cursor");
  return value as number;
}

function pairCursor(value: unknown): { endedAt: string; measurementId: string } | undefined {
  if (value === undefined) return undefined;
  if (!plainRecord(value) || typeof value.endedAt !== "string" || typeof value.measurementId !== "string") {
    throw new TypeError("Invalid measurement cursor");
  }
  return { endedAt: value.endedAt, measurementId: value.measurementId };
}

function artifactCursor(value: unknown): { createdAt: string; digest: string } | undefined {
  if (value === undefined) return undefined;
  if (!plainRecord(value) || typeof value.createdAt !== "string" || typeof value.digest !== "string") {
    throw new TypeError("Invalid artifact cursor");
  }
  return { createdAt: value.createdAt, digest: value.digest };
}

function pageLimit(value: number | undefined): number {
  const limit = value ?? 32;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Inspector page limit must be a positive integer");
  return Math.min(limit, LIMITS.pageEntries);
}

function plainRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
