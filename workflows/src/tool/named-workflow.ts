import { Type, type Static } from "typebox";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import {
  WORKFLOW_RESOURCE_KEY,
  WORKFLOW_SAFE_PATH_KEY,
} from "../definition/workflow-schema.js";
import type { MeasurementProfileSnapshot } from "../measurements/profiles.js";
import type { WorkflowDefinitionRef } from "../registry/structured-workflows.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowNamedClient } from "../runtime/named-workflow-types.js";
import { stableJson } from "../utils/stable-json.js";
import { truncateBytes } from "../utils/truncate.js";
import { renderNamedWorkflowCall, renderNamedWorkflowResult } from "../ui/flow-tool-renderer.js";
import type { JsonObject, JsonSchema, JsonValue } from "../types.js";

export interface WorkflowNamedToolArguments {
  name: string;
  args: JsonObject;
  mode?: "await" | "async";
}

/**
 * Build the session-local model tool schema after project trust and registries are known.
 */
export function workflowNamedToolParameters(options: {
  definitions: readonly WorkflowDefinitionRef[];
  measurementProfiles: readonly MeasurementProfileSnapshot[];
}) {
  const definitions = options.definitions.filter(definition => definition.exposure === "model")
    .sort((left, right) => left.id.localeCompare(right.id));
  const profileIds = [...new Set(options.measurementProfiles.map(profile => profile.id))].sort();
  const unambiguous = new Map<string, number>();
  for (const definition of definitions) {
    unambiguous.set(definition.name, (unambiguous.get(definition.name) ?? 0) + 1);
  }
  const branches = definitions.map(definition => ({
    type: "object",
    additionalProperties: false,
    required: ["name", "args"],
    properties: {
      name: {
        type: "string",
        enum: [definition.id, ...(unambiguous.get(definition.name) === 1 ? [definition.name] : [])],
        description: `Reviewed workflow ${definition.id}: ${definition.description}`,
      },
      args: presentInvocationSchema(definition.input, profileIds),
      mode: {
        type: "string",
        enum: ["await", "async"],
        description: "Wait until the run settles, or launch it in the background.",
      },
    },
  }));
  const schema = branches.length > 0
    ? {
        oneOf: branches,
        description: "Run one reviewed model-exposed workflow. Each branch is its exact installed input schema.",
      }
    : {
        type: "object",
        additionalProperties: false,
        not: {},
        description: "No workflows are currently exposed to the model.",
      };
  if (Buffer.byteLength(JSON.stringify(schema), "utf8") > DEFINITION_LIMITS.schemaBytes * 3) {
    throw new Error("Workflow v17 model tool schema exceeds its session bound");
  }
  return Type.Unsafe<WorkflowNamedToolArguments>(schema);
}

export type WorkflowNamedToolParameterType = Static<ReturnType<typeof workflowNamedToolParameters>>;

export function registerWorkflowNamedTool(
  pi: ExtensionAPI,
  workflows: WorkflowNamedClient,
  options: { definitions: readonly WorkflowDefinitionRef[]; measurementProfiles: readonly MeasurementProfileSnapshot[] },
): void {
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: "Run one reviewed TypeScript workflow by name. Arguments are validated against the exact installed definition.",
    promptSnippet: "Run a reviewed named workflow",
    promptGuidelines: [
      "Use workflow only with a listed reviewed name and that workflow's exact argument object.",
      "Use mode=await unless background execution is explicitly requested.",
    ],
    parameters: workflowNamedToolParameters(options),
    executionMode: "sequential",
    renderCall: (args, theme) => renderNamedWorkflowCall(args, theme),
    renderResult: (result, options, theme, context) => renderNamedWorkflowResult(result as any, options, theme, context),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await workflows.invoke({
        name: params.name,
        args: params.args,
        mode: params.mode ?? "await",
      }, "model", ctx, {
        onUpdate: async summary => {
          if (signal?.aborted) return;
          onUpdate?.({ content: [{ type: "text", text: `${summary.workflowId} (${summary.shortRunId}) · ${summary.status} · r${summary.revision}` }],
            details: { runtimeVersion: 17, runId: summary.runId, status: summary.status, revision: summary.revision } });
        },
      });
      const projection = await workflows.open(result.runId, ctx);
      const text = truncateBytes(
        `${result.summary.workflowId} (${result.summary.shortRunId}) · ${result.status} · r${result.summary.revision}\n${stableJson({
          handoff: result.handoff,
          ...(result.result !== undefined ? { result: result.result } : {}),
          attention: projection.attention,
        })}`,
        48 * 1024,
        "\n[… workflow result truncated; inspect the run by id …]",
      );
      return { content: [{ type: "text", text }], details: {
        runtimeVersion: 17,
        runId: result.runId,
        status: result.status,
        handoff: result.handoff,
        projection,
        ...(result.result !== undefined ? { result: result.result } : {}),
      } };
    },
  });
}

/** Replace protected authoring markers with the exact trust-filtered launch presentation. */
export function presentWorkflowInvocationSchema(
  schema: JsonSchema,
  measurementProfiles: readonly MeasurementProfileSnapshot[],
): JsonSchema {
  return presentInvocationSchema(schema, [...new Set(measurementProfiles.map(profile => profile.id))].sort());
}

function presentInvocationSchema(schema: JsonSchema, profileIds: readonly string[]): JsonSchema {
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const record = value as JsonObject;
    if (record[WORKFLOW_RESOURCE_KEY] === "measurement-profile") {
      const description = typeof record.description === "string" ? `${record.description} ` : "";
      return {
        type: "string",
        enum: [...profileIds],
        description: `${description}Exact trusted measurement profile available in this session.`.trim(),
      };
    }
    const result: JsonObject = {};
    for (const [key, child] of Object.entries(record)) {
      if (key === WORKFLOW_RESOURCE_KEY || key === WORKFLOW_SAFE_PATH_KEY) continue;
      result[key] = visit(child);
    }
    return result;
  };
  return visit(structuredClone(schema) as JsonValue) as JsonSchema;
}
