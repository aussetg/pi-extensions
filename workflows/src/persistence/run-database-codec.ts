import type { JsonObject, JsonValue } from "../types.js";
import { canonicalJsonValue, deepFreezeJson, type CanonicalJsonLimits } from "../definition/canonical-json.js";
import type {
  ArtifactRecord,
  ArtifactRef,
  ResourceMeasurement,
  RunRecord,
  SafetyConfiguration,
  StructuredReason,
  UsageMeasurement,
  WorkspaceRef,
} from "../runtime/durable-types.js";

export type SqlRow = Record<string, null | number | bigint | string | Uint8Array>;

const SMALL_JSON_LIMITS: CanonicalJsonLimits = {
  maxBytes: 128 * 1024,
  maxDepth: 24,
  maxNodes: 5_000,
  maxStringScalars: 32_000,
};

const VALUE_JSON_LIMITS: CanonicalJsonLimits = {
  maxBytes: 512 * 1024,
  maxDepth: 32,
  maxNodes: 20_000,
  maxStringScalars: 100_000,
};

export type JsonSize = "small" | "value";

export function encodeCanonicalJson(value: unknown, size: JsonSize = "small"): string {
  return JSON.stringify(canonicalJsonValue(value, size === "small" ? SMALL_JSON_LIMITS : VALUE_JSON_LIMITS));
}

export function decodeCanonicalJson<T extends JsonValue>(source: string, size: JsonSize = "small"): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new RunDatabaseCorruptionError(`Stored JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const canonical = canonicalJsonValue(parsed, size === "small" ? SMALL_JSON_LIMITS : VALUE_JSON_LIMITS);
  if (JSON.stringify(canonical) !== source) throw new RunDatabaseCorruptionError("Stored JSON is not canonical");
  return deepFreezeJson(canonical) as T;
}

export class RunDatabaseCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunDatabaseCorruptionError";
  }
}

export function assertRunRecord(run: RunRecord): void {
  assertIdentifier(run.runId, "run id");
  assertPositiveInteger(run.revision, "run revision");
  assertIdentifier(run.workflow.id, "workflow id");
  if (!/^(builtin|user|project):[a-z][a-z0-9_-]{0,63}$/.test(run.workflow.id)) {
    throw new TypeError("Invalid workflow id");
  }
  assertText(run.workflow.name, "workflow name", 128);
  assertHash(run.workflow.sourceHash, "workflow source hash");
  assertHash(run.workflow.definitionHash, "workflow definition hash");
  assertHash(run.invocationHash, "invocation hash");
  assertHash(run.projectSnapshotHash, "project snapshot hash");
  assertHash(run.routeSnapshotHash, "route snapshot hash");
  assertHash(run.contextIdentityHash, "context identity hash");
  if (!new Set(["queued", "running", "waiting", "paused", "completed", "failed", "stopped"]).has(run.status)) {
    throw new TypeError("Invalid run status");
  }
  const capabilities = new Set(run.workflow.capabilities);
  if (capabilities.size !== run.workflow.capabilities.length) throw new TypeError("Run capabilities must be unique");
  for (const capability of capabilities) {
    if (!new Set(["read-project", "candidate-write", "host-command", "mediated-network", "human-input"]).has(capability)) {
      throw new TypeError(`Invalid workflow capability ${capability}`);
    }
  }
  if (run.reason) assertStructuredReason(run.reason);
  assertSafety(run.safety);
  assertUsage(run.usage);
  if (run.currentOperationId) assertIdentifier(run.currentOperationId, "current operation id");
  if (run.result) assertArtifactRef(run.result);
  if (run.error) assertArtifactRef(run.error);
  if (run.replay) {
    if (run.replay.mode !== "same-run" && run.replay.mode !== "cross-revision-prefix") {
      throw new TypeError("Invalid run replay mode");
    }
    assertIdentifier(run.replay.sourceRunId, "replay source run id");
    assertNonNegativeInteger(run.replay.matchedCalls, "matched replay calls");
    if (run.replay.firstMissOrdinal !== undefined) {
      assertNonNegativeInteger(run.replay.firstMissOrdinal, "first replay miss ordinal");
      assertText(run.replay.firstMissReason ?? "", "first replay miss reason", 2_048);
    } else if (run.replay.firstMissReason !== undefined) {
      throw new TypeError("Replay miss reason has no ordinal");
    }
    if (typeof run.replay.fresh !== "boolean") throw new TypeError("Invalid fresh replay flag");
    if (run.replay.mode === "same-run" && run.replay.sourceRunId !== run.runId) {
      throw new TypeError("Same-run replay source differs from its run");
    }
    if (run.replay.mode === "cross-revision-prefix" && run.replay.sourceRunId === run.runId) {
      throw new TypeError("Cross-revision replay source is the target run");
    }
    if (run.replay.fresh && (run.replay.mode !== "cross-revision-prefix" || run.replay.matchedCalls !== 0 || run.replay.firstMissOrdinal !== undefined)) {
      throw new TypeError("Fresh replay metadata contains consumed prefix state");
    }
    encodeCanonicalJson(run.replay as unknown as JsonValue);
  }
  assertIsoDate(run.createdAt, "run createdAt");
  if (run.startedAt) assertIsoDate(run.startedAt, "run startedAt");
  assertIsoDate(run.updatedAt, "run updatedAt");
  if (run.endedAt) assertIsoDate(run.endedAt, "run endedAt");
}

export function assertSafety(value: SafetyConfiguration): void {
  assertPositiveInteger(value.concurrency, "safety concurrency");
  assertPositiveInteger(value.maximumAgentLaunches, "maximum agent launches");
  assertPositiveInteger(value.memoryBytes, "memory bytes");
  assertPositiveInteger(value.tasks, "tasks");
  assertPositiveInteger(value.cpuQuotaPercent, "CPU quota percent");
  assertPositiveInteger(value.cpuWeight, "CPU weight");
  assertPositiveInteger(value.outputBytes, "output bytes");
  assertPositiveInteger(value.commandTimeoutMs, "command timeout");
}

export function assertUsage(value: UsageMeasurement): void {
  for (const [name, observed] of Object.entries(value)) {
    if (name === "complete") continue;
    if (typeof observed !== "number" || !Number.isFinite(observed) || observed < 0) {
      throw new TypeError(`Invalid usage ${name}`);
    }
    if (name !== "cost" && !Number.isSafeInteger(observed)) throw new TypeError(`Invalid usage ${name}`);
  }
  if (typeof value.complete !== "boolean") throw new TypeError("Invalid usage completeness");
}

export function addUsage(left: UsageMeasurement, right: UsageMeasurement): UsageMeasurement {
  assertUsage(left);
  assertUsage(right);
  const added = (name: keyof Omit<UsageMeasurement, "complete" | "cost">): number => {
    const value = left[name] + right[name];
    if (!Number.isSafeInteger(value)) throw new RangeError(`Usage ${name} overflow`);
    return value;
  };
  const cost = left.cost + right.cost;
  if (!Number.isFinite(cost) || cost < 0) throw new RangeError("Usage cost overflow");
  return {
    inputTokens: added("inputTokens"),
    outputTokens: added("outputTokens"),
    cacheReadTokens: added("cacheReadTokens"),
    cacheWriteTokens: added("cacheWriteTokens"),
    providerRequests: added("providerRequests"),
    cost,
    elapsedMs: added("elapsedMs"),
    complete: left.complete && right.complete,
  };
}

export function assertArtifactRef(value: ArtifactRef): void {
  assertDigest(value.digest);
  assertText(value.kind, "artifact kind", 128);
  if (!new Set(["text/plain; charset=utf-8", "application/json", "application/octet-stream"]).has(value.mediaType)) {
    throw new TypeError("Invalid artifact media type");
  }
  assertNonNegativeInteger(value.bytes, "artifact bytes");
}

export function assertArtifactRecord(value: ArtifactRecord, runId: string): void {
  assertArtifactRef(value);
  if (value.runId !== runId) throw new TypeError("Artifact belongs to a different run");
  assertText(value.bodyPath, "artifact body path", 4_096);
  encodeCanonicalJson(value.metadata);
  assertIsoDate(value.createdAt, "artifact createdAt");
}

export function assertWorkspace(value: WorkspaceRef, label = "workspace"): void {
  if (value.kind !== "snapshot" && value.kind !== "candidate") throw new TypeError(`Invalid ${label} kind`);
  assertIdentifier(value.workspaceId, `${label} id`);
  assertHash(value.treeHash, `${label} tree hash`);
  if (value.lineageHash) assertHash(value.lineageHash, `${label} lineage hash`);
  if (value.writeScopeHash) assertHash(value.writeScopeHash, `${label} write-scope hash`);
}

export function assertResources(value: ResourceMeasurement | undefined): void {
  if (!value) return;
  for (const [name, observed] of Object.entries(value)) {
    if (typeof observed !== "number" || !Number.isFinite(observed) || observed < 0) {
      throw new TypeError(`Invalid resource measurement ${name}`);
    }
    if (!name.endsWith("Pressure") && !Number.isSafeInteger(observed)) {
      throw new TypeError(`Invalid resource measurement ${name}`);
    }
  }
}

export function assertStructuredReason(value: StructuredReason): void {
  if (!new Set(["control", "human-input", "approval", "safety", "agent-protocol", "provider", "infrastructure", "workflow", "effect", "workspace", "replay"]).has(value.category)) {
    throw new TypeError("Invalid structured-reason category");
  }
  assertIdentifier(value.code, "structured-reason code");
  assertText(value.summary, "structured-reason summary", 4_000);
  if (typeof value.retryable !== "boolean") throw new TypeError("Invalid structured-reason retryable flag");
  if (value.operationId) assertIdentifier(value.operationId, "structured-reason operation id");
  if (value.evidence) {
    if (value.evidence.length > 64) throw new TypeError("Too many structured-reason evidence artifacts");
    for (const artifact of value.evidence) assertArtifactRef(artifact);
  }
  if (value.details) encodeCanonicalJson(value.details);
}

export function optionalReasonJson(value: StructuredReason | null | undefined): string | null {
  if (value == null) return null;
  assertStructuredReason(value);
  return encodeCanonicalJson(value as unknown as JsonValue);
}

export function assertIdentifier(value: string, label: string): void {
  assertText(value, label, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(value)) throw new TypeError(`Invalid ${label}`);
}

/** Provider-owned tool call IDs are opaque, bounded text rather than host identifiers. */
export function assertAgentToolCallId(value: string, label = "agent tool call id"): void {
  assertText(value, label, 256);
}

export function assertHash(value: string, label: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new TypeError(`Invalid ${label}`);
}

export function assertDigest(value: string): void {
  assertHash(value, "artifact digest");
}

export function assertIsoDate(value: string, label: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new TypeError(`Invalid ${label}`);
}

export function assertText(value: string, label: string, maximumScalars: number): void {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > maximumScalars || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
}

export function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid ${label}`);
}

export function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid ${label}`);
}

export function requiredString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new RunDatabaseCorruptionError(`Column ${key} is not text`);
  return value;
}

export function optionalString(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new RunDatabaseCorruptionError(`Column ${key} is not nullable text`);
  return value;
}

export function requiredNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new RunDatabaseCorruptionError(`Column ${key} is not numeric`);
  return value;
}

export function optionalNumber(row: SqlRow, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number") throw new RunDatabaseCorruptionError(`Column ${key} is not nullable numeric`);
  return value;
}

export function rowReason(row: SqlRow, key = "reason_json"): StructuredReason | undefined {
  const source = optionalString(row, key);
  if (source === undefined) return undefined;
  const reason = decodeCanonicalJson(source) as unknown as StructuredReason;
  assertStructuredReason(reason);
  return reason;
}

export function rowWorkspace(row: SqlRow, prefix: string): WorkspaceRef | undefined {
  const kind = optionalString(row, `${prefix}_kind`);
  if (!kind) return undefined;
  const workspace: WorkspaceRef = {
    kind: kind as WorkspaceRef["kind"],
    workspaceId: requiredString(row, `${prefix}_id`),
    treeHash: requiredString(row, `${prefix}_tree_hash`),
    ...(optionalString(row, `${prefix}_lineage_hash`) ? { lineageHash: optionalString(row, `${prefix}_lineage_hash`)! } : {}),
    ...(optionalString(row, `${prefix}_write_scope_hash`) ? { writeScopeHash: optionalString(row, `${prefix}_write_scope_hash`)! } : {}),
  };
  assertWorkspace(workspace);
  return workspace;
}

export function rowUsage(row: SqlRow, prefix = "usage"): UsageMeasurement {
  const usage: UsageMeasurement = {
    inputTokens: requiredNumber(row, `${prefix}_input_tokens`),
    outputTokens: requiredNumber(row, `${prefix}_output_tokens`),
    cacheReadTokens: requiredNumber(row, `${prefix}_cache_read_tokens`),
    cacheWriteTokens: requiredNumber(row, `${prefix}_cache_write_tokens`),
    providerRequests: requiredNumber(row, `${prefix}_provider_requests`),
    cost: requiredNumber(row, `${prefix}_cost`),
    elapsedMs: requiredNumber(row, `${prefix}_elapsed_ms`),
    complete: requiredNumber(row, `${prefix}_complete`) === 1,
  };
  assertUsage(usage);
  return usage;
}

export function rowResources(row: SqlRow, prefix = "resource"): ResourceMeasurement | undefined {
  const resources: ResourceMeasurement = {
    ...(optionalNumber(row, `${prefix}_cpu_usec`) !== undefined ? { cpuUsec: optionalNumber(row, `${prefix}_cpu_usec`)! } : {}),
    ...(optionalNumber(row, `${prefix}_io_read_bytes`) !== undefined ? { ioReadBytes: optionalNumber(row, `${prefix}_io_read_bytes`)! } : {}),
    ...(optionalNumber(row, `${prefix}_io_write_bytes`) !== undefined ? { ioWriteBytes: optionalNumber(row, `${prefix}_io_write_bytes`)! } : {}),
    ...(optionalNumber(row, `${prefix}_memory_current_bytes`) !== undefined ? { memoryCurrentBytes: optionalNumber(row, `${prefix}_memory_current_bytes`)! } : {}),
    ...(optionalNumber(row, `${prefix}_memory_peak_bytes`) !== undefined ? { memoryPeakBytes: optionalNumber(row, `${prefix}_memory_peak_bytes`)! } : {}),
    ...(optionalNumber(row, `${prefix}_tasks_current`) !== undefined ? { tasksCurrent: optionalNumber(row, `${prefix}_tasks_current`)! } : {}),
    ...(optionalNumber(row, `${prefix}_tasks_peak`) !== undefined ? { tasksPeak: optionalNumber(row, `${prefix}_tasks_peak`)! } : {}),
    ...(optionalNumber(row, `${prefix}_cpu_pressure`) !== undefined ? { cpuPressure: optionalNumber(row, `${prefix}_cpu_pressure`)! } : {}),
    ...(optionalNumber(row, `${prefix}_io_pressure`) !== undefined ? { ioPressure: optionalNumber(row, `${prefix}_io_pressure`)! } : {}),
    ...(optionalNumber(row, `${prefix}_memory_pressure`) !== undefined ? { memoryPressure: optionalNumber(row, `${prefix}_memory_pressure`)! } : {}),
  };
  if (Object.keys(resources).length === 0) return undefined;
  assertResources(resources);
  return resources;
}

export function jsonObject(value: unknown): JsonObject {
  const canonical = canonicalJsonValue(value, SMALL_JSON_LIMITS);
  if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) throw new TypeError("Expected JSON object");
  return canonical as JsonObject;
}
