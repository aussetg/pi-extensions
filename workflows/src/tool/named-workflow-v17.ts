import { Type, type Static } from "typebox";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import {
  WORKFLOW_V17_RESOURCE_KEY,
  WORKFLOW_V17_SAFE_PATH_KEY,
} from "../definition/workflow-v17-schema.js";
import type { MeasurementProfileSnapshot } from "../measurements/profiles.js";
import type { WorkflowV17DefinitionRef } from "../registry/structured-workflows-v17.js";
import type { JsonObject, JsonSchema, JsonValue } from "../types.js";

export interface WorkflowV17NamedToolArguments {
  name: string;
  args: JsonObject;
  mode?: "await" | "async";
}

/**
 * Build the session-local model tool schema after project trust and registries are known. The
 * execution callback is installed only at the phase-16 cutover; this phase freezes presentation.
 */
export function workflowV17NamedToolParameters(options: {
  definitions: readonly WorkflowV17DefinitionRef[];
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
  return Type.Unsafe<WorkflowV17NamedToolArguments>(schema);
}

export type WorkflowV17NamedToolParameterType = Static<ReturnType<typeof workflowV17NamedToolParameters>>;

/** Replace protected authoring markers with the exact trust-filtered launch presentation. */
export function presentWorkflowV17InvocationSchema(
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
    if (record[WORKFLOW_V17_RESOURCE_KEY] === "measurement-profile") {
      const description = typeof record.description === "string" ? `${record.description} ` : "";
      return {
        type: "string",
        enum: [...profileIds],
        description: `${description}Exact trusted measurement profile available in this session.`.trim(),
      };
    }
    const result: JsonObject = {};
    for (const [key, child] of Object.entries(record)) {
      if (key === WORKFLOW_V17_RESOURCE_KEY || key === WORKFLOW_V17_SAFE_PATH_KEY) continue;
      result[key] = visit(child);
    }
    return result;
  };
  return visit(structuredClone(schema) as JsonValue) as JsonSchema;
}
