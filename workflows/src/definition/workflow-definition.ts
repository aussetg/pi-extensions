import { sha256, stableHash } from "../utils/hashes.js";
import type { JsonObject, JsonValue } from "../types.js";
import { deepFreezeJson } from "./canonical-json.js";
import type { ParsedStructuredWorkflow, StructuredWorkflowDefinition } from "./types.js";
import {
  buildExecutableSource,
  buildParentMap,
  collectTopLevelConstants,
  findWorkflowDefinition,
  parseWorkflowModule,
} from "./workflow-ast.js";
import {
  extractWorkflowMetadata,
  validateWorkflowDefinitionObject,
} from "./workflow-metadata.js";
import { analyzeWorkflowSource } from "./workflow-source-analysis.js";

export const STRUCTURED_RUNTIME_API_VERSION = 13;

export const STRUCTURED_RUNTIME_API_DESCRIPTOR = deepFreezeJson({
  formatVersion: 1,
  availableOperations: [
    "stage", "loop", "parallel", "fanOut", "checkpoint", "agent", "command", "metric", "measure",
    "candidate", "verify", "accept", "reject", "recordExperiment", "apply",
  ],
  definitionFields: [
    "name", "title", "description", "inputSchema", "outputSchema", "capabilities", "modelVisible",
    "maxParallelism", "run",
  ],
  operationIdPattern: "^[a-z][a-z0-9_-]{0,63}$",
  control: "constrained-deterministic-javascript",
  concurrency: "host-ceiling-with-workflow-lower-request",
  command: "reviewed-profile-plus-bounded-scalar-arguments",
} as unknown as JsonValue);

export const STRUCTURED_RUNTIME_API_HASH = stableHash(STRUCTURED_RUNTIME_API_DESCRIPTOR);

export function defineWorkflow<TArgs extends JsonObject, TResult extends JsonValue>(
  definition: StructuredWorkflowDefinition<TArgs, TResult>,
): StructuredWorkflowDefinition<TArgs, TResult> {
  validateWorkflowDefinitionObject(definition);
  for (const [key, value] of Object.entries(definition)) {
    if (key !== "run" && value && typeof value === "object") deepFreezeJson(value as JsonValue);
  }
  return Object.freeze(definition);
}

/** Parse and review source without evaluating any workflow expression. */
export function parseStructuredWorkflow(source: string): ParsedStructuredWorkflow {
  const ast = parseWorkflowModule(source);
  const parents = buildParentMap(ast);
  const { exportNode, definitionNode, runNode, flowName, argsName } = findWorkflowDefinition(ast);
  const { constants, values: constantValues, initializers } = collectTopLevelConstants(ast, exportNode);
  const metadata = extractWorkflowMetadata(definitionNode, constantValues);
  const analysis = analyzeWorkflowSource({
    ast,
    definitionNode,
    runNode,
    flowName,
    argsName,
    metadata,
    constants,
    constantValues,
    parents,
  });

  const parsed: ParsedStructuredWorkflow = {
    metadata,
    source,
    sourceHash: sha256(source),
    executableSource: buildExecutableSource(source, exportNode, initializers),
    runFlowParameter: flowName,
    runArgsParameter: argsName,
    topLevelConstantInitializers: [...initializers],
    ...analysis,
  };
  return deepFreezeJson(parsed as unknown as JsonValue) as unknown as ParsedStructuredWorkflow;
}

