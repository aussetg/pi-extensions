import type { JsonValue } from "../types.js";

const JSON_POINTER_RE = /^(\/(?:[^/~]|~0|~1)*)*$/;

export function isJsonPointer(pointer: string): boolean {
  return JSON_POINTER_RE.test(pointer);
}

export function decodePointer(pointer: string): string[] {
  if (!isJsonPointer(pointer)) throw new Error(`Invalid JSON Pointer: ${pointer}`);
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function getByPointer(root: unknown, pointer: string): unknown {
  let current = root;
  for (const segment of decodePointer(pointer)) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) return undefined;
      current = current[index];
      continue;
    }
    if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

export interface JsonPatchOperation {
  op: "add" | "replace" | "remove";
  path: string;
  value?: JsonValue;
}

export function applyJsonPatch<T extends JsonValue>(root: T, patch: JsonPatchOperation[]): T {
  const clone = structuredClone(root) as JsonValue;
  for (const op of patch) applyOne(clone, op);
  return clone as T;
}

function applyOne(root: JsonValue, op: JsonPatchOperation): void {
  const parts = decodePointer(op.path);
  if (parts.length === 0) throw new Error("Patching the root document is not supported in v1");
  const key = parts.pop()!;
  const parentPointer = parts.length === 0 ? "" : `/${parts.map((p) => p.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
  const parent = getByPointer(root, parentPointer);
  if (!parent || typeof parent !== "object") throw new Error(`Patch parent not found: ${op.path}`);
  if (Array.isArray(parent)) {
    const index = key === "-" ? parent.length : Number(key);
    if (!Number.isInteger(index) || index < 0 || index > parent.length) throw new Error(`Invalid array patch index: ${op.path}`);
    if (op.op === "remove") parent.splice(index, 1);
    else if (op.op === "add") parent.splice(index, 0, op.value ?? null);
    else parent[index] = op.value ?? null;
    return;
  }
  const object = parent as Record<string, JsonValue>;
  if (op.op === "remove") delete object[key];
  else object[key] = op.value ?? null;
}
