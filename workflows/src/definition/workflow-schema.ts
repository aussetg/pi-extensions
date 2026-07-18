import { Ajv } from "ajv";
import type { JsonObject, JsonSchema, JsonValue } from "../types.js";
import { WorkflowScriptError } from "../runtime/errors.js";
import {
  canonicalJsonObject,
  canonicalJsonValue,
  deepFreezeJson,
} from "./canonical-json.js";
import { DEFINITION_LIMITS, FLOW_NAME_PATTERN } from "./limits.js";
import {
  location,
  objectProperties,
  type WorkflowAstNode,
} from "./workflow-ast.js";
import type { WorkflowSchemaResource } from "./workflow-types.js";

export const WORKFLOW_RESOURCE_KEY = "x-pi-workflow-resource";
export const WORKFLOW_SAFE_PATH_KEY = "x-pi-workflow-safe-path";

export interface WorkflowStaticSchema {
  readonly kind: "schema";
  readonly schema: JsonSchema;
  readonly optional: boolean;
}

type StaticValue =
  | { readonly kind: "json"; readonly value: JsonValue }
  | WorkflowStaticSchema;

export class WorkflowSchemaEvaluator {
  private readonly cache = new Map<string, StaticValue>();
  private readonly resolving = new Set<string>();

  constructor(
    private readonly schemaBinding: string,
    private readonly constants: ReadonlyMap<string, WorkflowAstNode>,
  ) {}

  schema(node: WorkflowAstNode, label: string): JsonSchema {
    const value = this.evaluateSchema(node, label);
    if (value.optional) {
      throw new WorkflowScriptError(`${label} may not be optional`, location(node));
    }
    return value.schema;
  }

  schemaValue(node: WorkflowAstNode, label: string): WorkflowStaticSchema {
    return this.evaluateSchema(node, label);
  }

  json(node: WorkflowAstNode, label: string): JsonValue {
    const value = this.evaluate(node, label);
    if (value.kind !== "json") {
      throw new WorkflowScriptError(`${label} must be static JSON`, location(node));
    }
    return value.value;
  }

  validateBinding(name: string): "schema" | "json" {
    const initializer = this.constants.get(name);
    if (!initializer) throw new WorkflowScriptError(`Unknown top-level binding ${name}`);
    return this.resolve(name, initializer, name).kind;
  }

  private evaluate(node: WorkflowAstNode, label: string): StaticValue {
    if (node?.type === "Identifier") return this.resolve(node.name, node, label);
    if (isSchemaCall(node, this.schemaBinding)) return this.evaluateSchemaCall(node, label);
    return { kind: "json", value: this.evaluateJsonExpression(node, label) };
  }

  private resolve(name: string, node: WorkflowAstNode, label: string): StaticValue {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const initializer = this.constants.get(name);
    if (!initializer) throw new WorkflowScriptError(`${label} references unknown static binding ${name}`, location(node));
    if (this.resolving.has(name)) throw new WorkflowScriptError(`Cyclic static binding ${name}`, location(initializer));
    this.resolving.add(name);
    try {
      const value = this.evaluate(initializer, name);
      this.cache.set(name, value);
      return value;
    } finally {
      this.resolving.delete(name);
    }
  }

  private evaluateSchema(node: WorkflowAstNode, label: string): WorkflowStaticSchema {
    const value = this.evaluate(node, label);
    if (value.kind !== "schema") {
      throw new WorkflowScriptError(`${label} must be a schema value`, location(node));
    }
    return value;
  }

  private evaluateSchemaCall(call: WorkflowAstNode, label: string): WorkflowStaticSchema {
    const method = call.callee.property.name as string;
    const args = call.arguments ?? [];
    const schema = (value: unknown, optional = false): WorkflowStaticSchema => ({
      kind: "schema",
      schema: freezeSchema(value, label, call),
      optional,
    });
    switch (method) {
      case "string": {
        expectArguments(args, 0, 1, "schema.string", call);
        const options = args[0] ? this.optionObject(args[0], "schema.string options") : new Map();
        assertOptionKeys(options, new Set(["minLength", "maxLength", "pattern", "format"]), "schema.string options");
        const result: Record<string, JsonValue> = { type: "string" };
        copyIntegerOption(options, result, "minLength", 0);
        copyIntegerOption(options, result, "maxLength", 0);
        copyStringOption(options, result, "pattern", 2_000);
        copyStringOption(options, result, "format", 128);
        if (typeof result.pattern === "string") {
          try { new RegExp(result.pattern); }
          catch { throw new WorkflowScriptError("schema.string pattern is invalid", location(options.get("pattern"))); }
        }
        return schema(result);
      }
      case "number":
      case "integer": {
        expectArguments(args, 0, 1, `schema.${method}`, call);
        const options = args[0] ? this.optionObject(args[0], `schema.${method} options`) : new Map();
        assertOptionKeys(
          options,
          new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]),
          `schema.${method} options`,
        );
        const result: Record<string, JsonValue> = { type: method };
        for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
          const option = options.get(key);
          if (!option) continue;
          const value = this.json(option, `schema.${method}.${key}`);
          if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new WorkflowScriptError(`schema.${method}.${key} must be a finite number`, location(option));
          }
          result[key] = value;
        }
        return schema(result);
      }
      case "boolean":
        expectArguments(args, 0, 0, "schema.boolean", call);
        return schema({ type: "boolean" });
      case "literal": {
        expectArguments(args, 1, 1, "schema.literal", call);
        const value = this.json(args[0], "schema.literal value");
        if (value !== null && !["boolean", "number", "string"].includes(typeof value)) {
          throw new WorkflowScriptError("schema.literal requires a JSON primitive", location(args[0]));
        }
        return schema({ const: value });
      }
      case "enum": {
        expectArguments(args, 1, 1, "schema.enum", call);
        const values = this.json(args[0], "schema.enum values");
        if (!Array.isArray(values) || values.length === 0 || values.length > 256
          || values.some((value) => typeof value !== "string")
          || new Set(values).size !== values.length) {
          throw new WorkflowScriptError("schema.enum requires 1–256 unique strings", location(args[0]));
        }
        return schema({ type: "string", enum: values });
      }
      case "nullable": {
        expectArguments(args, 1, 1, "schema.nullable", call);
        const member = this.evaluateSchema(args[0], "schema.nullable value");
        rejectOptional(member, args[0], "schema.nullable");
        return schema({ anyOf: [member.schema, { type: "null" }] });
      }
      case "optional": {
        expectArguments(args, 1, 1, "schema.optional", call);
        const member = this.evaluateSchema(args[0], "schema.optional value");
        rejectOptional(member, args[0], "schema.optional");
        return schema(member.schema, true);
      }
      case "array": {
        expectArguments(args, 1, 2, "schema.array", call);
        const item = this.evaluateSchema(args[0], "schema.array items");
        rejectOptional(item, args[0], "schema.array");
        const options = args[1] ? this.optionObject(args[1], "schema.array options") : new Map();
        assertOptionKeys(options, new Set(["minItems", "maxItems", "uniqueItems"]), "schema.array options");
        const result: Record<string, JsonValue> = { type: "array", items: item.schema };
        copyIntegerOption(options, result, "minItems", 0);
        copyIntegerOption(options, result, "maxItems", 0);
        const unique = options.get("uniqueItems");
        if (unique) {
          const value = this.json(unique, "schema.array.uniqueItems");
          if (typeof value !== "boolean") {
            throw new WorkflowScriptError("schema.array.uniqueItems must be boolean", location(unique));
          }
          result.uniqueItems = value;
        }
        return schema(result);
      }
      case "object": {
        expectArguments(args, 1, 1, "schema.object", call);
        if (args[0]?.type !== "ObjectExpression") {
          throw new WorkflowScriptError("schema.object properties must be an object literal", location(args[0]));
        }
        const properties = objectProperties(args[0], "schema.object properties");
        const resultProperties: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
        const required: string[] = [];
        for (const [name, property] of properties) {
          const value = this.evaluateSchema(property.value, `schema.object.${name}`);
          resultProperties[name] = value.schema;
          if (!value.optional) required.push(name);
        }
        required.sort();
        return schema({
          type: "object",
          additionalProperties: false,
          properties: resultProperties,
          ...(required.length ? { required } : {}),
        });
      }
      case "union": {
        expectArguments(args, 1, 1, "schema.union", call);
        if (args[0]?.type !== "ArrayExpression" || args[0].elements.length < 1) {
          throw new WorkflowScriptError("schema.union requires a nonempty schema array literal", location(args[0]));
        }
        const members = args[0].elements.map((entry: WorkflowAstNode, index: number) => {
          if (!entry || entry.type === "SpreadElement") {
            throw new WorkflowScriptError("schema.union does not allow sparse arrays or spreads", location(entry ?? args[0]));
          }
          const member = this.evaluateSchema(entry, `schema.union[${index}]`);
          rejectOptional(member, entry, "schema.union");
          return member.schema;
        });
        return schema({ anyOf: members });
      }
      case "record": {
        expectArguments(args, 1, 1, "schema.record", call);
        const value = this.evaluateSchema(args[0], "schema.record values");
        rejectOptional(value, args[0], "schema.record");
        return schema({ type: "object", additionalProperties: value.schema });
      }
      case "id":
        expectArguments(args, 0, 0, "schema.id", call);
        return schema({ type: "string", pattern: FLOW_NAME_PATTERN.source });
      case "safePath":
        expectArguments(args, 0, 0, "schema.safePath", call);
        return schema({
          type: "string",
          minLength: 1,
          maxLength: DEFINITION_LIMITS.projectSnapshotPathBytes,
          pattern: "^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))(?!.*//)(?!.*\\\\)[^\\u0000-\\u001f\\u007f]+$",
          [WORKFLOW_SAFE_PATH_KEY]: true,
        });
      case "json":
        expectArguments(args, 0, 0, "schema.json", call);
        return schema({});
      case "measurementProfile":
        expectArguments(args, 0, 0, "schema.measurementProfile", call);
        return schema({
          type: "string",
          pattern: "^(?:builtin|user|project):[a-z][a-z0-9_-]{0,63}$",
          [WORKFLOW_RESOURCE_KEY]: "measurement-profile",
        });
      case "raw": {
        expectArguments(args, 1, 1, "schema.raw", call);
        const value = this.json(args[0], "schema.raw value");
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new WorkflowScriptError("schema.raw requires a JSON schema object", location(args[0]));
        }
        rejectReservedSchemaKeys(value, args[0]);
        return schema(value);
      }
      default:
        throw new WorkflowScriptError(`Unknown schema constructor ${method}`, location(call.callee.property));
    }
  }

  private optionObject(node: WorkflowAstNode, label: string): Map<string, WorkflowAstNode> {
    if (node?.type !== "ObjectExpression") {
      throw new WorkflowScriptError(`${label} must be an object literal`, location(node));
    }
    const result = new Map<string, WorkflowAstNode>();
    for (const [name, property] of objectProperties(node, label)) result.set(name, property.value);
    return result;
  }

  private evaluateJsonExpression(node: WorkflowAstNode, label: string): JsonValue {
    switch (node?.type) {
      case "Literal":
        if (!node.regex && typeof node.value !== "bigint"
          && (node.value === null || ["boolean", "number", "string"].includes(typeof node.value))) {
          return canonical(node.value);
        }
        break;
      case "Identifier": {
        const value = this.resolve(node.name, node, label);
        if (value.kind === "json") return value.value;
        break;
      }
      case "UnaryExpression":
        if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
          return canonical(-node.argument.value);
        }
        break;
      case "TemplateLiteral":
        if (node.expressions.length === 0) return node.quasis[0]?.value?.cooked ?? "";
        break;
      case "ArrayExpression": {
        const values = node.elements.map((entry: WorkflowAstNode, index: number) => {
          if (!entry || entry.type === "SpreadElement") {
            throw new WorkflowScriptError(`${label}[${index}] must be static JSON`, location(entry ?? node));
          }
          return this.evaluateJsonExpression(entry, `${label}[${index}]`);
        });
        return canonical(values);
      }
      case "ObjectExpression": {
        const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
        for (const [name, property] of objectProperties(node, label)) {
          result[name] = this.evaluateJsonExpression(property.value, `${label}.${name}`);
        }
        return canonical(result);
      }
    }
    throw new WorkflowScriptError(`${label} must be static JSON`, location(node));
  }
}

export function collectWorkflowSchemaResources(schema: JsonSchema): WorkflowSchemaResource[] {
  const result: WorkflowSchemaResource[] = [];
  const visit = (value: JsonValue, path: string): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as JsonObject;
    if (record[WORKFLOW_RESOURCE_KEY] === "measurement-profile") {
      result.push({ kind: "measurement-profile", inputPath: path || "/" });
    }
    const properties = record.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      for (const [name, child] of Object.entries(properties).sort(([left], [right]) => left.localeCompare(right))) {
        visit(child, `${path}/${escapePointer(name)}`);
      }
    }
    if (record.items) visit(record.items, `${path}/*`);
    if (Array.isArray(record.anyOf)) for (const child of record.anyOf) visit(child, path);
  };
  visit(schema, "");
  return result;
}

export function workflowSchemaAtPath(schema: JsonSchema, inputPath: string): JsonSchema | undefined {
  if (!inputPath.startsWith("/")) return undefined;
  if (inputPath === "/") return schema;
  let current: JsonValue = schema;
  for (const encoded of inputPath.slice(1).split("/")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    const properties: JsonValue | undefined = (current as JsonObject).properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
    current = (properties as JsonObject)[unescapePointer(encoded)]!;
  }
  return current && typeof current === "object" && !Array.isArray(current)
    ? current as JsonSchema
    : undefined;
}

export function isWorkflowMeasurementProfileSchema(schema: JsonSchema | undefined): boolean {
  return schema?.[WORKFLOW_RESOURCE_KEY] === "measurement-profile";
}

export function isWorkflowSafePathSchema(schema: JsonSchema | undefined): boolean {
  return schema?.[WORKFLOW_SAFE_PATH_KEY] === true;
}

function isSchemaCall(node: WorkflowAstNode, schemaBinding: string): boolean {
  return Boolean(
    node?.type === "CallExpression"
    && !node.optional
    && node.callee?.type === "MemberExpression"
    && !node.callee.computed
    && !node.callee.optional
    && node.callee.object?.type === "Identifier"
    && node.callee.object.name === schemaBinding
    && node.callee.property?.type === "Identifier",
  );
}

function freezeSchema(value: unknown, label: string, node: WorkflowAstNode): JsonSchema {
  let schema: JsonSchema;
  try { schema = canonicalJsonObject(value, schemaLimits()) as JsonSchema; }
  catch (error) {
    throw new WorkflowScriptError(`${label} is not a canonical schema: ${errorMessage(error)}`, location(node));
  }
  const ajv = new Ajv({ strict: false, allErrors: true, validateSchema: true, validateFormats: false });
  try {
    if (!ajv.validateSchema(schema)) {
      throw new Error(ajv.errorsText(ajv.errors));
    }
    ajv.compile(schema);
  } catch (error) {
    throw new WorkflowScriptError(`${label} is not a valid JSON schema: ${errorMessage(error)}`, location(node));
  }
  return deepFreezeJson(schema);
}

function canonical(value: unknown): JsonValue {
  return deepFreezeJson(canonicalJsonValue(value, schemaLimits()));
}

function schemaLimits() {
  return {
    maxBytes: DEFINITION_LIMITS.schemaBytes,
    maxDepth: DEFINITION_LIMITS.schemaDepth,
    maxNodes: DEFINITION_LIMITS.schemaNodes,
    maxStringScalars: DEFINITION_LIMITS.invocationStringScalars,
  };
}

function expectArguments(
  args: WorkflowAstNode[],
  minimum: number,
  maximum: number,
  label: string,
  node: WorkflowAstNode,
): void {
  if (args.length < minimum || args.length > maximum || args.some((arg) => arg?.type === "SpreadElement")) {
    const range = minimum === maximum ? String(minimum) : `${minimum}–${maximum}`;
    throw new WorkflowScriptError(`${label} requires ${range} non-spread argument(s)`, location(node));
  }
}

function assertOptionKeys(
  options: ReadonlyMap<string, WorkflowAstNode>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const [name, node] of options) {
    if (!allowed.has(name)) throw new WorkflowScriptError(`${label} contains unknown field ${name}`, location(node));
  }
}

function copyIntegerOption(
  options: ReadonlyMap<string, WorkflowAstNode>,
  result: Record<string, JsonValue>,
  name: string,
  minimum: number,
): void {
  const node = options.get(name);
  if (!node) return;
  if (node.type !== "Literal" || !Number.isSafeInteger(node.value) || node.value < minimum) {
    throw new WorkflowScriptError(`${name} must be a safe integer ≥ ${minimum}`, location(node));
  }
  result[name] = node.value;
}

function copyStringOption(
  options: ReadonlyMap<string, WorkflowAstNode>,
  result: Record<string, JsonValue>,
  name: string,
  maximum: number,
): void {
  const node = options.get(name);
  if (!node) return;
  if (node.type !== "Literal" || typeof node.value !== "string" || node.value.length > maximum) {
    throw new WorkflowScriptError(`${name} must be a string of at most ${maximum} characters`, location(node));
  }
  result[name] = node.value;
}

function rejectOptional(value: WorkflowStaticSchema, node: WorkflowAstNode, label: string): void {
  if (value.optional) throw new WorkflowScriptError(`${label} may not contain an optional schema`, location(node));
}

function rejectReservedSchemaKeys(value: JsonValue, node: WorkflowAstNode): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) rejectReservedSchemaKeys(child, node);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith("x-pi-workflow-")) {
      throw new WorkflowScriptError(`schema.raw may not mint reserved authority field ${key}`, location(node));
    }
    rejectReservedSchemaKeys(child, node);
  }
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function unescapePointer(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
