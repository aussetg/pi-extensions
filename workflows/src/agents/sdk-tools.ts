import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { AgentFinishRecord } from "../runtime/durable-types.js";
import type { JsonObject, JsonSchema, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import type { AgentWorkerProtocol } from "./sdk-protocol.js";
import { AGENT_PROGRESS_LIMITS } from "../runtime/agent-progress-limits.js";

export const SCHEMALESS_FINISH_RESULT_SCALARS = 32_000;

const SCHEMALESS_FINISH_SCHEMA = Type.Object({
  result: Type.String({
    minLength: 1,
    maxLength: SCHEMALESS_FINISH_RESULT_SCALARS,
    description: "The complete final result for this task",
  }),
}, { additionalProperties: false });

export interface FinishWorkContract {
  parameters: JsonSchema;
  schemaHash: string;
  schemaLess: boolean;
}

export interface AgentTerminalToolSet {
  tools: ToolDefinition[];
  finish: FinishWorkContract;
  committedFinish(): AgentFinishRecord | undefined;
}

/** The model sees the operation schema itself, not a permissive wrapper around it. */
export function buildFinishWorkContract(outputSchema?: JsonSchema): FinishWorkContract {
  const schema = outputSchema === undefined
    ? cloneJson(SCHEMALESS_FINISH_SCHEMA as unknown as JsonSchema)
    : cloneJson(outputSchema);
  if ((schema as Record<string, unknown>).type !== "object") {
    throw new TypeError("finish_work output schema must have object as its root type");
  }
  return Object.freeze({
    parameters: deepFreeze(schema),
    schemaHash: stableHash(schema),
    schemaLess: outputSchema === undefined,
  });
}

export function createAgentTerminalTools(
  protocol: AgentWorkerProtocol,
  outputSchema?: JsonSchema,
): AgentTerminalToolSet {
  const finish = buildFinishWorkContract(outputSchema);
  let committed: AgentFinishRecord | undefined;

  const finishWork = defineTool({
    name: "finish_work",
    label: "Finish Work",
    description: "Commit the final result and terminate this agent operation. This is the only way to complete the task successfully.",
    promptSnippet: "Commit the final task result and terminate the agent operation",
    promptGuidelines: [
      "Call finish_work exactly once as the final action when the task result is ready.",
      "Assistant prose does not complete the task; only an acknowledged finish_work call does.",
      "Call finish_work alone, without sibling tool calls in the same response.",
    ],
    parameters: finish.parameters as TSchema,
    executionMode: "sequential",
    async execute(toolCallId, params) {
      const response = await protocol.request("finish_work", toolCallId, json(params));
      const record = finishFromResponse(response);
      if (record.toolCallId !== toolCallId || record.schemaHash !== finish.schemaHash) {
        throw new Error("Coordinator acknowledged a different finish_work receipt");
      }
      committed = record;
      return {
        content: [{ type: "text", text: "Final result committed durably." }],
        details: { finish: record },
        terminate: true,
      };
    },
  });

  const reportProgress = defineTool({
    name: "report_progress",
    label: "Report Progress",
    description: "Replace the current concise progress message and optional counters or scalar metrics.",
    parameters: Type.Object({
      message: Type.String({ minLength: 1, maxLength: AGENT_PROGRESS_LIMITS.messageScalars }),
      current: Type.Optional(Type.Integer({ minimum: 0 })),
      total: Type.Optional(Type.Integer({ minimum: 0 })),
      metrics: Type.Optional(Type.Array(Type.Object({
        name: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9._:@+~-]{0,63}$" }),
        value: Type.Number({
          minimum: -AGENT_PROGRESS_LIMITS.metricAbsoluteValue,
          maximum: AGENT_PROGRESS_LIMITS.metricAbsoluteValue,
        }),
        unit: Type.Optional(Type.String({ minLength: 1, maxLength: AGENT_PROGRESS_LIMITS.metricUnitScalars })),
      }, { additionalProperties: false }), { maxItems: AGENT_PROGRESS_LIMITS.metrics })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(toolCallId, params) {
      await protocol.request("report_progress", toolCallId, json(params));
      return { content: [{ type: "text", text: "Progress recorded." }], details: {} };
    },
  });

  const logResult = defineTool({
    name: "log_result",
    label: "Log Result",
    description: "Persist a concise intermediate result or finding for inspectors and later evidence.",
    parameters: Type.Object({
      message: Type.String({ minLength: 1, maxLength: AGENT_PROGRESS_LIMITS.logScalars }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(toolCallId, params) {
      await protocol.request("log_result", toolCallId, json(params));
      return { content: [{ type: "text", text: "Intermediate result logged." }], details: {} };
    },
  });

  const publishArtifact = defineTool({
    name: "publish_artifact",
    label: "Publish Artifact",
    description: "Publish immutable run evidence from inline content or one safe file in this execution's output directory.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096, description: "Relative path below the execution output directory; exclusive with content" })),
      content: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000_000, description: "Inline text or JSON source; exclusive with path" })),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      format: Type.Optional(Type.String({ enum: ["file", "text", "json"] })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(toolCallId, params) {
      const response = await protocol.request("publish_artifact", toolCallId, json(params));
      const artifact = artifactFromResponse(response);
      return {
        content: [{ type: "text", text: `Published immutable artifact ${artifact.digest}.` }],
        details: { artifact },
      };
    },
  });

  return {
    tools: [finishWork, reportProgress, logResult, publishArtifact],
    finish,
    committedFinish: () => committed ? structuredClone(committed) : undefined,
  };
}

function finishFromResponse(value: JsonValue): AgentFinishRecord {
  const response = object(value, "finish_work response");
  const finish = object(response.finish, "finish_work receipt");
  if (
    typeof finish.toolCallId !== "string"
    || typeof finish.schemaHash !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(finish.schemaHash)
    || typeof finish.committedAt !== "string"
    || !Number.isFinite(Date.parse(finish.committedAt))
  ) {
    throw new Error("Coordinator returned an invalid finish_work receipt");
  }
  if (!Array.isArray(finish.artifacts)) throw new Error("Coordinator finish_work receipt has invalid artifacts");
  return {
    toolCallId: finish.toolCallId,
    schemaHash: finish.schemaHash,
    ...(Object.hasOwn(finish, "value") ? { value: finish.value as JsonValue } : {}),
    artifacts: finish.artifacts.map((artifact) => artifactRef(artifact)),
    committedAt: finish.committedAt,
  };
}

function artifactFromResponse(value: JsonValue): { digest: string; kind: string; mediaType: string; bytes: number } {
  const response = object(value, "publish_artifact response");
  const artifact = object(response.artifact, "published artifact");
  return artifactRef(artifact);
}

function artifactRef(artifactValue: unknown): AgentFinishRecord["artifacts"][number] {
  const artifact = object(artifactValue, "artifact reference");
  if (
    typeof artifact.digest !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)
    || typeof artifact.kind !== "string"
    || typeof artifact.mediaType !== "string"
    || !["text/plain; charset=utf-8", "application/json", "application/octet-stream"].includes(artifact.mediaType)
    || !Number.isSafeInteger(artifact.bytes)
    || (artifact.bytes as number) < 0
  ) throw new Error("Coordinator returned an invalid artifact reference");
  return artifact as unknown as AgentFinishRecord["artifacts"][number];
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as JsonObject;
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T extends JsonValue>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child as JsonValue);
    Object.freeze(value);
  }
  return value;
}
