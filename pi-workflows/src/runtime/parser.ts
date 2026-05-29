import { parse } from "acorn";
import { sha256 } from "../utils/hashes.js";
import type { JsonValue, WorkflowMeta } from "../types.js";
import { SCRIPT_MAX_BYTES } from "../constants.js";
import { WorkflowScriptError } from "./errors.js";

export interface ParsedWorkflowScript {
  meta: WorkflowMeta;
  executableSource: string;
  scriptHash: string;
}

type Node = any;

const FORBIDDEN_IDENTIFIERS = new Set([
  "process",
  "require",
  "Buffer",
  "global",
  "globalThis",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "fs",
  "child_process",
  "http",
  "https",
  "net",
  "tls",
  "dns",
  "module",
  "exports",
  "__dirname",
  "__filename",
  "Deno",
  "Bun",
]);

const FORBIDDEN_CALLEES = new Set(["require", "eval", "Function"]);
const FORBIDDEN_PROPERTIES = new Set(["constructor", "prototype", "__proto__"]);

export function parseWorkflowScript(source: string): ParsedWorkflowScript {
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > SCRIPT_MAX_BYTES) throw new WorkflowScriptError(`Workflow script is too large (${bytes} bytes)`);

  let ast: Node;
  try {
    ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      locations: true,
    } as any);
  } catch (err) {
    const e = err as Error & { loc?: { line: number; column: number } };
    throw new WorkflowScriptError(`Invalid workflow JavaScript: ${e.message}`, e.loc);
  }

  const first = ast.body?.[0];
  if (!first) throw new WorkflowScriptError("Workflow script must begin with literal export const meta = {...}");
  const meta = extractMeta(first);
  validateBody(ast, first);

  return {
    meta,
    executableSource: source.slice(first.end),
    scriptHash: sha256(source),
  };
}

function extractMeta(first: Node): WorkflowMeta {
  if (first.type !== "ExportNamedDeclaration" || !first.declaration) {
    throw new WorkflowScriptError("First statement must be literal export const meta = {...}", loc(first));
  }
  const declaration = first.declaration;
  if (declaration.type !== "VariableDeclaration" || declaration.kind !== "const" || declaration.declarations.length !== 1) {
    throw new WorkflowScriptError("Metadata must be exported as exactly: export const meta = {...}", loc(first));
  }
  const declarator = declaration.declarations[0];
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta" || declarator.init?.type !== "ObjectExpression") {
    throw new WorkflowScriptError("Metadata must be a pure object literal named meta", loc(declarator));
  }
  const value = literalValue(declarator.init, "meta") as Record<string, JsonValue>;
  if (typeof value.name !== "string" || value.name.trim() === "") {
    throw new WorkflowScriptError("meta.name is required and must be a non-empty string", loc(declarator.init));
  }
  if (typeof value.description !== "string" || value.description.trim() === "") {
    throw new WorkflowScriptError("meta.description is required and must be a non-empty string", loc(declarator.init));
  }
  return value as unknown as WorkflowMeta;
}

function literalValue(node: Node, path: string): JsonValue {
  switch (node.type) {
    case "Literal": {
      if (node.regex) throw new WorkflowScriptError(`${path} may not contain regular expressions`, loc(node));
      if (typeof node.value === "bigint") throw new WorkflowScriptError(`${path} may not contain bigint values`, loc(node));
      if (node.value === null || ["string", "number", "boolean"].includes(typeof node.value)) return node.value as JsonValue;
      throw new WorkflowScriptError(`${path} contains unsupported literal`, loc(node));
    }
    case "ArrayExpression": {
      return node.elements.map((element: Node, index: number) => {
        if (!element) throw new WorkflowScriptError(`${path}[${index}] may not be a sparse array hole`, loc(node));
        return literalValue(element, `${path}[${index}]`);
      });
    }
    case "ObjectExpression": {
      const out: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      for (const property of node.properties) {
        if (property.type === "SpreadElement") throw new WorkflowScriptError(`${path} may not use spreads`, loc(property));
        if (property.kind !== "init" || property.method || property.computed) {
          throw new WorkflowScriptError(`${path} may not use computed keys, methods, or accessors`, loc(property));
        }
        const key = propertyKey(property.key);
        if (FORBIDDEN_PROPERTIES.has(key)) throw new WorkflowScriptError(`${path} may not contain reserved key ${key}`, loc(property));
        out[key] = literalValue(property.value, `${path}.${key}`);
      }
      return out;
    }
    default:
      throw new WorkflowScriptError(`${path} must be a JSON literal; found ${node.type}`, loc(node));
  }
}

function propertyKey(key: Node): string {
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  throw new WorkflowScriptError("Metadata object keys must be simple identifiers or string literals", loc(key));
}

function validateBody(ast: Node, metaNode: Node): void {
  walk(ast, undefined, undefined, (node, parent, key) => {
    if (node === metaNode) return;
    switch (node.type) {
      case "ImportDeclaration":
      case "ImportExpression":
      case "ExportDefaultDeclaration":
      case "ExportAllDeclaration":
        throw new WorkflowScriptError("Workflow scripts may not import or export beyond the first meta declaration", loc(node));
      case "ExportNamedDeclaration":
        throw new WorkflowScriptError("Workflow scripts may not export beyond the first meta declaration", loc(node));
      case "MetaProperty":
        throw new WorkflowScriptError("import.meta and other meta properties are not available in workflows", loc(node));
      case "Identifier": {
        if (isNonComputedPropertyKey(node, parent, key)) return;
        if (FORBIDDEN_IDENTIFIERS.has(node.name)) throw new WorkflowScriptError(`Forbidden global/API: ${node.name}`, loc(node));
        break;
      }
      case "MemberExpression": {
        const prop = memberPropertyName(node);
        if (prop && FORBIDDEN_PROPERTIES.has(prop)) throw new WorkflowScriptError(`Forbidden property access: ${prop}`, loc(node));
        if (isMember(node, "Date", "now")) throw new WorkflowScriptError("Date.now() is not deterministic", loc(node));
        if (isMember(node, "Math", "random")) throw new WorkflowScriptError("Math.random() is not deterministic", loc(node));
        break;
      }
      case "CallExpression": {
        if (node.callee.type === "Identifier" && FORBIDDEN_CALLEES.has(node.callee.name)) {
          throw new WorkflowScriptError(`Forbidden call: ${node.callee.name}()`, loc(node));
        }
        if (isMember(node.callee, "Date", "now")) throw new WorkflowScriptError("Date.now() is not deterministic", loc(node));
        if (isMember(node.callee, "Math", "random")) throw new WorkflowScriptError("Math.random() is not deterministic", loc(node));
        break;
      }
      case "NewExpression": {
        if (node.callee.type === "Identifier" && node.callee.name === "Date" && node.arguments.length === 0) {
          throw new WorkflowScriptError("argless new Date() is not deterministic", loc(node));
        }
        if (node.callee.type === "Identifier" && node.callee.name === "Function") {
          throw new WorkflowScriptError("new Function() is not allowed", loc(node));
        }
        break;
      }
    }
  });
}

function walk(node: Node, parent: Node | undefined, key: string | undefined, visit: (node: Node, parent?: Node, key?: string) => void): void {
  visit(node, parent, key);
  for (const childKey of Object.keys(node)) {
    if (childKey === "parent" || childKey === "loc" || childKey === "range" || childKey === "start" || childKey === "end") continue;
    const value = node[childKey];
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === "string") walk(child, node, childKey, visit);
    } else if (value && typeof value.type === "string") {
      walk(value, node, childKey, visit);
    }
  }
}

function isMember(node: Node, objectName: string, propertyName: string): boolean {
  return node?.type === "MemberExpression" && node.object?.type === "Identifier" && node.object.name === objectName && memberPropertyName(node) === propertyName;
}

function memberPropertyName(node: Node): string | undefined {
  if (node.computed) return node.property?.type === "Literal" && typeof node.property.value === "string" ? node.property.value : undefined;
  return node.property?.type === "Identifier" ? node.property.name : undefined;
}

function isNonComputedPropertyKey(node: Node, parent: Node | undefined, key: string | undefined): boolean {
  if (!parent) return false;
  if (parent.type === "Property" && key === "key" && !parent.computed) return true;
  if (parent.type === "MemberExpression" && key === "property" && !parent.computed) return true;
  return false;
}

function loc(node: Node | undefined): { line?: number; column?: number } | undefined {
  return node?.loc?.start ? { line: node.loc.start.line, column: node.loc.start.column } : undefined;
}
