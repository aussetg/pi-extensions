import { Ajv } from "ajv";
import type { JsonSchema, JsonValue } from "../types.js";
import { WorkflowScriptError } from "../runtime/errors.js";
import { canonicalJsonObject, deepFreezeJson, scalarLength } from "./canonical-json.js";
import { DEFINITION_LIMITS, FLOW_NAME_PATTERN } from "./limits.js";
import {
  WORKFLOW_CAPABILITIES,
  type StructuredWorkflowDefinition,
  type StructuredWorkflowMetadata,
  type WorkflowCapability,
} from "./types.js";
import {
  evaluateStaticJson,
  location,
  objectProperties,
  type WorkflowAstNode,
} from "./workflow-ast.js";

export const WORKFLOW_DEFINITION_KEYS = new Set([
  "name",
  "title",
  "description",
  "inputSchema",
  "outputSchema",
  "capabilities",
  "modelVisible",
  "maxParallelism",
  "run",
]);

const REQUIRED_DEFINITION_KEYS = [
  "name",
  "description",
  "inputSchema",
  "outputSchema",
  "capabilities",
  "modelVisible",
  "run",
] as const;

export function extractWorkflowMetadata(
  definitionNode: WorkflowAstNode,
  constants: Map<string, JsonValue>,
): StructuredWorkflowMetadata {
  const properties = objectProperties(definitionNode, "workflow definition");
  for (const [key, property] of properties) {
    if (!WORKFLOW_DEFINITION_KEYS.has(key)) {
      throw new WorkflowScriptError(`Unknown workflow definition field: ${key}`, location(property));
    }
  }
  for (const key of REQUIRED_DEFINITION_KEYS) {
    if (!properties.has(key)) {
      throw new WorkflowScriptError(`Workflow definition is missing ${key}`, location(definitionNode));
    }
  }

  const resolve = (name: string): JsonValue => {
    if (!constants.has(name)) throw new WorkflowScriptError(`Metadata references non-data binding ${name}`);
    return constants.get(name)!;
  };
  const read = (key: string): unknown => {
    const property = properties.get(key);
    return property ? evaluateStaticJson(property.value, resolve, key) : undefined;
  };
  try {
    return canonicalWorkflowMetadata({
      name: read("name"),
      title: read("title"),
      description: read("description"),
      inputSchema: read("inputSchema"),
      outputSchema: read("outputSchema"),
      capabilities: read("capabilities"),
      modelVisible: read("modelVisible"),
      maxParallelism: read("maxParallelism"),
    });
  } catch (error) {
    if (!(error instanceof WorkflowScriptError) || error.location) throw error;
    const field = metadataFieldForError(error.message);
    throw new WorkflowScriptError(error.message, location(properties.get(field)?.value ?? definitionNode));
  }
}

export function validateWorkflowDefinitionObject(
  value: unknown,
): asserts value is StructuredWorkflowDefinition {
  if (!isPlainRecord(value)) throw new WorkflowScriptError("defineWorkflow() expects one plain object");
  for (const key of Object.keys(value)) {
    if (!WORKFLOW_DEFINITION_KEYS.has(key)) {
      throw new WorkflowScriptError(`Unknown workflow definition field: ${key}`);
    }
  }
  for (const key of REQUIRED_DEFINITION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new WorkflowScriptError(`Workflow definition is missing ${key}`);
    }
  }
  canonicalWorkflowMetadata({
    name: value.name,
    title: value.title,
    description: value.description,
    inputSchema: value.inputSchema,
    outputSchema: value.outputSchema,
    capabilities: value.capabilities,
    modelVisible: value.modelVisible,
    maxParallelism: value.maxParallelism,
  });
  if (typeof value.run !== "function") {
    throw new WorkflowScriptError("Workflow definition requires an async run(flow, args) function");
  }
}

export function canonicalWorkflowMetadata(value: Record<string, unknown>): StructuredWorkflowMetadata {
  if (typeof value.name !== "string" || !FLOW_NAME_PATTERN.test(value.name)) {
    throw new WorkflowScriptError(`Workflow name must match ${FLOW_NAME_PATTERN.source}`);
  }
  if (typeof value.description !== "string" || value.description.trim() === "") {
    throw new WorkflowScriptError("Workflow description must be a non-empty string");
  }
  if (scalarLength(value.description) > DEFINITION_LIMITS.descriptionScalars) {
    throw new WorkflowScriptError(`Workflow description exceeds ${DEFINITION_LIMITS.descriptionScalars} Unicode scalars`);
  }
  if (value.title !== undefined && (typeof value.title !== "string" || value.title.trim() === "")) {
    throw new WorkflowScriptError("Workflow title must be a non-empty string when present");
  }
  if (typeof value.title === "string" && scalarLength(value.title) > DEFINITION_LIMITS.titleScalars) {
    throw new WorkflowScriptError(`Workflow title exceeds ${DEFINITION_LIMITS.titleScalars} Unicode scalars`);
  }
  if (typeof value.modelVisible !== "boolean") throw new WorkflowScriptError("modelVisible must be a boolean");

  const inputSchema = canonicalSchema(value.inputSchema, "inputSchema");
  const outputSchema = canonicalSchema(value.outputSchema, "outputSchema");
  if ((inputSchema as Record<string, unknown>).type !== "object") {
    throw new WorkflowScriptError("inputSchema must have object as its root type");
  }
  const capabilities = canonicalCapabilities(value.capabilities);
  const maxParallelism = canonicalMaxParallelism(value.maxParallelism);

  const result: StructuredWorkflowMetadata = {
    name: value.name,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    description: value.description,
    inputSchema,
    outputSchema,
    capabilities,
    modelVisible: value.modelVisible,
    ...(maxParallelism !== undefined ? { maxParallelism } : {}),
  };
  deepFreezeJson(result as unknown as JsonValue);
  return result;
}

function canonicalSchema(value: unknown, label: string): JsonSchema {
  const schema = canonicalJsonObject(value, schemaCanonicalLimits()) as JsonSchema;
  const ajv = new Ajv({ strict: false, allErrors: true, validateSchema: true, allowUnionTypes: true });
  try {
    if (!ajv.validateSchema(schema)) {
      throw new WorkflowScriptError(`${label} is not a valid JSON Schema: ${ajv.errorsText(ajv.errors)}`);
    }
    ajv.compile(schema);
  } catch (error) {
    if (error instanceof WorkflowScriptError) throw error;
    throw new WorkflowScriptError(`${label} is not a compilable JSON Schema: ${(error as Error).message}`);
  }
  return schema;
}

function canonicalCapabilities(value: unknown): WorkflowCapability[] {
  if (!Array.isArray(value)) throw new WorkflowScriptError("capabilities must be an array");
  const allowed = new Set<string>(WORKFLOW_CAPABILITIES);
  const seen = new Set<string>();
  const result: WorkflowCapability[] = [];
  for (const capability of value) {
    if (typeof capability !== "string" || !allowed.has(capability)) {
      throw new WorkflowScriptError(`Unknown workflow capability: ${String(capability)}`);
    }
    if (seen.has(capability)) throw new WorkflowScriptError(`Duplicate workflow capability: ${capability}`);
    seen.add(capability);
    result.push(capability as WorkflowCapability);
  }
  return Object.freeze(result.sort()) as WorkflowCapability[];
}

function canonicalMaxParallelism(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new WorkflowScriptError("maxParallelism must be a positive safe integer");
  }
  if ((value as number) > DEFINITION_LIMITS.concurrency) {
    throw new WorkflowScriptError(
      `maxParallelism may only lower the host ceiling of ${DEFINITION_LIMITS.concurrency}`,
    );
  }
  return value as number;
}

function schemaCanonicalLimits() {
  return {
    maxBytes: DEFINITION_LIMITS.schemaBytes,
    maxDepth: DEFINITION_LIMITS.schemaDepth,
    maxNodes: DEFINITION_LIMITS.schemaNodes,
    maxStringScalars: DEFINITION_LIMITS.invocationStringScalars,
  };
}

function metadataFieldForError(message: string): string {
  if (/^Workflow name/.test(message)) return "name";
  if (/^Workflow description/.test(message)) return "description";
  if (/^Workflow title/.test(message)) return "title";
  if (/^inputSchema/.test(message)) return "inputSchema";
  if (/^outputSchema/.test(message)) return "outputSchema";
  if (/^(?:Unknown|Duplicate) workflow capability|^capabilities/.test(message)) return "capabilities";
  if (/^modelVisible/.test(message)) return "modelVisible";
  if (/^maxParallelism/.test(message)) return "maxParallelism";
  return "name";
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
