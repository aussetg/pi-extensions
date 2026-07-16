import fs from "node:fs";
import path from "node:path";
import type { RunCatalogEntry } from "../persistence/run-catalog.js";
import { RunDatabaseReader } from "../persistence/run-database.js";
import { readWorkflowRunProjection } from "../projection/run-projection.js";
import type { JsonValue } from "../types.js";
import { sha256 } from "../utils/hashes.js";
import type { RunRecord } from "./durable-types.js";
import type { WorkflowRunDetails, WorkflowRunSummary } from "./named-workflow-types.js";

const RESULT_LIMIT = 64 * 1024 * 1024;

export function summarizeRun(run: RunRecord, shortRunId = run.runId.slice(5, 13)): WorkflowRunSummary {
  return {
    runId: run.runId,
    shortRunId,
    workflowId: run.workflow.id,
    workflowName: run.workflow.name,
    status: run.status,
    revision: run.revision,
    ...(run.reason ? { reason: structuredClone(run.reason) } : {}),
    ...(run.currentOperationId ? { currentOperationId: run.currentOperationId } : {}),
    ...(run.result ? { result: structuredClone(run.result) } : {}),
    usage: structuredClone(run.usage),
    ...(run.replay ? {
      replay: {
        sourceRunId: run.replay.sourceRunId,
        matchedCalls: run.replay.matchedCalls,
        ...(run.replay.firstMissOrdinal !== undefined ? { firstMissOrdinal: run.replay.firstMissOrdinal } : {}),
        fresh: run.replay.fresh,
      },
    } : {}),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
  };
}

export function readRunDetails(entry: RunCatalogEntry, shortRunId?: string): WorkflowRunDetails {
  const reader = RunDatabaseReader.open(entry.paths.database);
  try {
    return readWorkflowRunProjection(reader, { ...(shortRunId ? { shortRunId } : {}) });
  } finally {
    reader.close();
  }
}

export async function readWorkflowResult(entry: RunCatalogEntry, run: RunRecord): Promise<JsonValue | undefined> {
  if (!run.result) return undefined;
  if (run.result.mediaType !== "application/json" || run.result.bytes > RESULT_LIMIT) {
    throw new Error("Workflow result artifact is not bounded canonical JSON");
  }
  const reader = RunDatabaseReader.open(entry.paths.database);
  try {
    const record = reader.readArtifact(run.result.digest);
    if (!record || record.bodyPath !== `artifacts/${run.result.digest.slice(7)}/body`) {
      throw new Error("Workflow result artifact row is missing or noncanonical");
    }
    const bodyPath = path.resolve(entry.paths.root, record.bodyPath);
    if (!inside(entry.paths.root, bodyPath)) throw new Error("Workflow result artifact escapes its run");
    const body = await fs.promises.readFile(bodyPath);
    if (body.length !== record.bytes || sha256(body) !== record.digest) throw new Error("Workflow result artifact is corrupt");
    const envelope = JSON.parse(body.toString("utf8")) as unknown;
    if (!plainRecord(envelope) || envelope.formatVersion !== 1 || !Object.hasOwn(envelope, "result")) {
      throw new Error("Workflow result artifact envelope is invalid");
    }
    return envelope.result as JsonValue;
  } finally {
    reader.close();
  }
}

function inside(rootInput: string, targetInput: string): boolean {
  const root = path.resolve(rootInput);
  const relative = path.relative(root, path.resolve(targetInput));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function plainRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
