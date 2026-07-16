import { scalarLength } from "../definition/canonical-json.js";
import { RunDatabaseStateError } from "../persistence/run-database.js";
import { AGENT_PROGRESS_LIMITS } from "../runtime/agent-progress-limits.js";
import type {
  AgentFinishRecord,
  AgentProgress,
  AgentToolReceiptRecord,
  ArtifactRef,
} from "../runtime/durable-types.js";
import type { JsonValue } from "../types.js";

export function parseProgressPayload(value: JsonValue): {
  message: string;
  current?: number;
  total?: number;
  metrics?: AgentProgress["metrics"];
} {
  const payload = exactAgentObject(value, ["message", "current", "total", "metrics"], "report_progress", true);
  const message = boundedAgentText(payload.message, "progress message", AGENT_PROGRESS_LIMITS.messageScalars);
  const current = optionalNonnegativeInteger(payload.current, "progress current");
  const total = optionalNonnegativeInteger(payload.total, "progress total");
  if (current !== undefined && total !== undefined && current > total) throw new TypeError("Progress current exceeds total");
  let metrics: AgentProgress["metrics"] | undefined;
  if (payload.metrics !== undefined) {
    if (!Array.isArray(payload.metrics) || payload.metrics.length > AGENT_PROGRESS_LIMITS.metrics) {
      throw new TypeError("Invalid progress metrics");
    }
    const names = new Set<string>();
    metrics = payload.metrics.map((value, index) => {
      const metric = exactAgentObject(value, ["name", "value", "unit"], `progress metric ${index}`, true);
      const name = boundedAgentIdentifier(metric.name, "progress metric name", AGENT_PROGRESS_LIMITS.metricNameScalars);
      if (names.has(name)) throw new TypeError(`Duplicate progress metric ${name}`);
      names.add(name);
      if (typeof metric.value !== "number"
        || !Number.isFinite(metric.value)
        || Math.abs(metric.value) > AGENT_PROGRESS_LIMITS.metricAbsoluteValue) {
        throw new TypeError(`Invalid progress metric ${name} value`);
      }
      const unit = metric.unit === undefined
        ? undefined
        : boundedAgentText(metric.unit, `progress metric ${name} unit`, AGENT_PROGRESS_LIMITS.metricUnitScalars);
      return { name, value: metric.value, ...(unit ? { unit } : {}) };
    });
  }
  return {
    message,
    ...(current !== undefined ? { current } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(metrics ? { metrics } : {}),
  };
}

export function publishedArtifacts(receipts: AgentToolReceiptRecord[]): ArtifactRef[] {
  const artifacts = new Map<string, ArtifactRef>();
  for (const receipt of receipts) {
    if (receipt.toolName !== "publish_artifact") continue;
    const response = exactAgentObject(receipt.response, ["artifact"], "published artifact receipt");
    const artifact = exactAgentObject(response.artifact, ["digest", "kind", "mediaType", "bytes"], "published artifact");
    if (typeof artifact.digest !== "string"
      || typeof artifact.kind !== "string"
      || typeof artifact.mediaType !== "string"
      || !Number.isSafeInteger(artifact.bytes)) {
      throw new RunDatabaseStateError("Published artifact receipt is corrupt");
    }
    artifacts.set(artifact.digest, artifact as unknown as ArtifactRef);
  }
  return [...artifacts.values()];
}

export function finishResponse(finish: AgentFinishRecord): JsonValue {
  return {
    finish: {
      toolCallId: finish.toolCallId,
      schemaHash: finish.schemaHash,
      ...(finish.value !== undefined ? { value: finish.value } : {}),
      artifacts: finish.artifacts as unknown as JsonValue,
      committedAt: finish.committedAt,
    },
  };
}

export function exactAgentObject(
  value: unknown,
  allowed: string[],
  label: string,
  optional = false,
): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} arguments must be an object`);
  const object = value as Record<string, unknown>;
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`${label} arguments contain unknown fields: ${unknown.sort().join(", ")}`);
  if (!optional && Object.keys(object).length !== allowed.length) throw new TypeError(`${label} arguments are incomplete`);
  return object;
}

export function boundedAgentText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || scalarLength(value) > maximum) throw new TypeError(`${label} is invalid`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new TypeError(`${label} contains control characters`);
  return value;
}

function boundedAgentIdentifier(value: unknown, label: string, maximum: number): string {
  const text = boundedAgentText(value, label, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@+~-]*$/.test(text)) throw new TypeError(`${label} is invalid`);
  return text;
}

function optionalNonnegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} is invalid`);
  return value as number;
}
