import { WorkflowScriptError } from "../runtime/errors.js";

export type WorkflowAstNode = any;

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

function propertyName(node: WorkflowAstNode): string {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  throw new WorkflowScriptError("Object keys must be identifiers or string literals", location(node));
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
