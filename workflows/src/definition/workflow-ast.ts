import { parse } from "acorn";
import type { JsonValue } from "../types.js";
import { WorkflowScriptError } from "../runtime/errors.js";
import { canonicalJsonValue, deepFreezeJson } from "./canonical-json.js";
import { DEFINITION_LIMITS } from "./limits.js";

export type WorkflowAstNode = any;

export interface WorkflowAstDefinition {
  exportNode: WorkflowAstNode;
  definitionNode: WorkflowAstNode;
  runNode: WorkflowAstNode;
  flowName: string;
  argsName: string;
}

export function parseWorkflowModule(source: string): WorkflowAstNode {
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > DEFINITION_LIMITS.sourceBytes) {
    throw new WorkflowScriptError(`Workflow definition exceeds ${DEFINITION_LIMITS.sourceBytes} bytes`);
  }
  if (source.includes("\0")) throw new WorkflowScriptError("Workflow definition contains a NUL byte");
  try {
    return parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
      allowAwaitOutsideFunction: false,
      allowReturnOutsideFunction: false,
    } as any);
  } catch (error) {
    const parseError = error as Error & { loc?: { line: number; column: number } };
    const message = parseError.message.replace(/\s*\(\d+:\d+\)\s*$/, "");
    throw new WorkflowScriptError(
      `Invalid workflow JavaScript: ${message}`,
      parseError.loc ? { line: parseError.loc.line, column: parseError.loc.column + 1 } : undefined,
    );
  }
}

export function findWorkflowDefinition(ast: WorkflowAstNode): WorkflowAstDefinition {
  const exports = ast.body.filter((node: WorkflowAstNode) => node.type.startsWith("Export"));
  if (exports.length !== 1 || exports[0]?.type !== "ExportDefaultDeclaration") {
    throw new WorkflowScriptError("A .flow.ts file must export exactly one default workflow({...}) definition");
  }
  const exportNode = exports[0]!;
  const call = exportNode.declaration;
  if (
    call?.type !== "CallExpression" ||
    call.optional ||
    call.callee?.type !== "Identifier" ||
    call.callee.name !== "workflow" ||
    call.arguments.length !== 1 ||
    call.arguments[0]?.type !== "ObjectExpression"
  ) {
    throw new WorkflowScriptError("Default export must be workflow({...})", location(exportNode));
  }

  const definitionNode = call.arguments[0];
  const properties = objectProperties(definitionNode, "workflow definition");
  const runProperty = properties.get("run");
  const runNode = runProperty?.value;
  if (!runNode || !isFunction(runNode) || runNode.async !== true || runNode.generator) {
    throw new WorkflowScriptError("Workflow definition requires async run(flow, args) {...}", location(runProperty ?? definitionNode));
  }
  if (runNode.params.length !== 2 || runNode.params.some((param: WorkflowAstNode) => param.type !== "Identifier")) {
    throw new WorkflowScriptError("run must have exactly two simple parameters: run(flow, args)", location(runNode));
  }
  if (runNode.params[0].name === runNode.params[1].name) {
    throw new WorkflowScriptError("run flow and args parameters must have distinct names", location(runNode));
  }

  for (const statement of ast.body) {
    if (statement === exportNode || statement.type === "EmptyStatement") continue;
    if (statement.type === "VariableDeclaration" && statement.kind === "const") continue;
    if (statement.type === "FunctionDeclaration" && statement.id && !statement.async && !statement.generator) continue;
    throw new WorkflowScriptError(
      "Top level may contain only frozen JSON const data, pure function declarations, and the default definition",
      location(statement),
    );
  }

  return {
    exportNode,
    definitionNode,
    runNode,
    flowName: runNode.params[0].name,
    argsName: runNode.params[1].name,
  };
}

export function collectTopLevelConstants(
  ast: WorkflowAstNode,
  exportNode: WorkflowAstNode,
): {
  constants: Map<string, WorkflowAstNode>;
  values: Map<string, JsonValue>;
  initializers: Array<{ start: number; end: number }>;
} {
  const constants = new Map<string, WorkflowAstNode>();
  const initializers: Array<{ start: number; end: number }> = [];
  for (const statement of ast.body) {
    if (statement === exportNode || statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      if (declaration.id?.type !== "Identifier" || !declaration.init) {
        throw new WorkflowScriptError("Top-level const declarations require simple names and initializers", location(declaration));
      }
      if (constants.has(declaration.id.name)) {
        throw new WorkflowScriptError(`Duplicate top-level binding ${declaration.id.name}`, location(declaration));
      }
      constants.set(declaration.id.name, declaration.init);
      initializers.push({ start: declaration.init.start, end: declaration.init.end });
    }
  }

  const values = new Map<string, JsonValue>();
  const resolving = new Set<string>();
  const resolve = (name: string): JsonValue => {
    const cached = values.get(name);
    if (cached !== undefined || values.has(name)) return cached as JsonValue;
    const node = constants.get(name);
    if (!node) throw new WorkflowScriptError(`Unknown static constant ${name}`);
    if (resolving.has(name)) throw new WorkflowScriptError(`Cyclic top-level constant ${name}`, location(node));
    resolving.add(name);
    const raw = evaluateStaticJson(node, resolve, name);
    resolving.delete(name);
    const canonical = canonicalJsonValue(raw, schemaCanonicalLimits());
    deepFreezeJson(canonical);
    values.set(name, canonical);
    return canonical;
  };
  for (const name of constants.keys()) resolve(name);
  return { constants, values, initializers };
}

export function evaluateStaticJson(
  node: WorkflowAstNode,
  resolve: (name: string) => JsonValue,
  label: string,
): JsonValue {
  switch (node?.type) {
    case "Literal":
      if (node.regex || typeof node.value === "bigint") {
        throw new WorkflowScriptError(`${label} contains an unsupported literal`, location(node));
      }
      if (node.value === null || ["string", "number", "boolean"].includes(typeof node.value)) {
        return node.value as JsonValue;
      }
      break;
    case "Identifier":
      return resolve(node.name);
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      break;
    case "TemplateLiteral":
      if (node.expressions.length === 0) return node.quasis[0]?.value?.cooked ?? "";
      break;
    case "ArrayExpression":
      return node.elements.map((entry: WorkflowAstNode, index: number) => {
        if (!entry || entry.type === "SpreadElement") {
          throw new WorkflowScriptError(`${label}[${index}] must be static JSON`, location(entry ?? node));
        }
        return evaluateStaticJson(entry, resolve, `${label}[${index}]`);
      });
    case "ObjectExpression": {
      const properties = objectProperties(node, label);
      const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      for (const [key, property] of properties) {
        result[key] = evaluateStaticJson(property.value, resolve, `${label}.${key}`);
      }
      return result;
    }
  }
  throw new WorkflowScriptError(`${label} must be frozen static JSON; found ${node?.type ?? "missing"}`, location(node));
}

const FORBIDDEN_PROPERTIES = new Set(["constructor", "prototype", "__proto__"]);

export function objectProperties(node: WorkflowAstNode, label: string): Map<string, WorkflowAstNode> {
  const result = new Map<string, WorkflowAstNode>();
  for (const property of node.properties ?? []) {
    if (property.type === "SpreadElement" || property.kind !== "init" || property.computed || property.type !== "Property") {
      throw new WorkflowScriptError(`${label} may not use spreads, accessors, or computed keys`, location(property));
    }
    const key = propertyName(property.key);
    if (FORBIDDEN_PROPERTIES.has(key)) {
      throw new WorkflowScriptError(`${label} contains reserved key ${key}`, location(property));
    }
    if (result.has(key)) throw new WorkflowScriptError(`${label} contains duplicate key ${key}`, location(property));
    result.set(key, property);
  }
  return result;
}

export function propertyName(node: WorkflowAstNode): string {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  throw new WorkflowScriptError("Object keys must be identifiers or string literals", location(node));
}

export function buildExecutableSource(
  source: string,
  exportNode: WorkflowAstNode,
  initializers: Array<{ start: number; end: number }>,
): string {
  const declaration = exportNode.declaration;
  const edits: Array<{ start: number; end: number; text: string }> = [
    { start: exportNode.start, end: declaration.start, text: "const __flowDefinition = " },
  ];
  for (const initializer of initializers) {
    edits.push({ start: initializer.start, end: initializer.start, text: "__flowDeepFreeze(" });
    edits.push({ start: initializer.end, end: initializer.end, text: ")" });
  }
  let result = source;
  for (const edit of edits.sort((left, right) => right.start - left.start || right.end - left.end)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return `${result}\n;__flowDefinition;`;
}

export function buildParentMap(
  ast: WorkflowAstNode,
): Map<WorkflowAstNode, { parent: WorkflowAstNode; key: string }> {
  const result = new Map<WorkflowAstNode, { parent: WorkflowAstNode; key: string }>();
  walk(ast, (node, parent, key) => {
    if (parent && key) result.set(node, { parent, key });
  });
  return result;
}

export function walk(
  node: WorkflowAstNode,
  visitor: (node: WorkflowAstNode, parent?: WorkflowAstNode, key?: string) => void | false,
  parent?: WorkflowAstNode,
  key?: string,
): void {
  if (!node || typeof node.type !== "string") return;
  if (visitor(node, parent, key) === false) return;
  for (const childKey of Object.keys(node)) {
    if (["loc", "range", "start", "end", "parent"].includes(childKey)) continue;
    const value = node[childKey];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === "string") walk(child, visitor, node, childKey);
      }
    } else if (value && typeof value.type === "string") {
      walk(value, visitor, node, childKey);
    }
  }
}

export function isFunction(node: WorkflowAstNode): boolean {
  return ["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration"].includes(node?.type);
}

export function memberPropertyName(node: WorkflowAstNode): string | undefined {
  if (node?.computed) {
    return node.property?.type === "Literal" && typeof node.property.value === "string"
      ? node.property.value
      : undefined;
  }
  return node?.property?.type === "Identifier" ? node.property.name : undefined;
}

/** Acorn columns are zero-based; all public workflow diagnostics are one-based. */
export function sourceLocation(node: WorkflowAstNode): { line: number; column: number } {
  return { line: node?.loc?.start?.line ?? 1, column: (node?.loc?.start?.column ?? 0) + 1 };
}

export function location(node: WorkflowAstNode | undefined): { line?: number; column?: number } | undefined {
  return node?.loc?.start
    ? { line: node.loc.start.line, column: node.loc.start.column + 1 }
    : undefined;
}

function schemaCanonicalLimits() {
  return {
    maxBytes: DEFINITION_LIMITS.schemaBytes,
    maxDepth: DEFINITION_LIMITS.schemaDepth,
    maxNodes: DEFINITION_LIMITS.schemaNodes,
    maxStringScalars: DEFINITION_LIMITS.invocationStringScalars,
  };
}
