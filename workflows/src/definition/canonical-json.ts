import type { JsonObject, JsonValue } from "../types.js";

export interface CanonicalJsonLimits {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxStringScalars: number;
}

export class CanonicalJsonError extends Error {
  readonly jsonPath: string;

  constructor(message: string, jsonPath = "$") {
    super(`${message} at ${jsonPath}`);
    this.name = "CanonicalJsonError";
    this.jsonPath = jsonPath;
  }
}

export function canonicalJsonValue(value: unknown, limits: CanonicalJsonLimits): JsonValue {
  let nodes = 0;
  const seen = new Set<object>();

  const visit = (input: unknown, jsonPath: string, depth: number): JsonValue => {
    nodes++;
    if (nodes > limits.maxNodes) throw new CanonicalJsonError(`JSON value exceeds ${limits.maxNodes} nodes`, jsonPath);
    if (depth > limits.maxDepth) throw new CanonicalJsonError(`JSON value exceeds depth ${limits.maxDepth}`, jsonPath);

    if (input === null) return null;
    if (typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new CanonicalJsonError("Non-finite numbers are not JSON", jsonPath);
      return Object.is(input, -0) ? 0 : input;
    }
    if (typeof input === "string") {
      for (const scalar of input) {
        const codePoint = scalar.codePointAt(0)!;
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) throw new CanonicalJsonError("String contains an unpaired surrogate", jsonPath);
      }
      if (scalarLength(input) > limits.maxStringScalars) {
        throw new CanonicalJsonError(`String exceeds ${limits.maxStringScalars} Unicode scalars`, jsonPath);
      }
      return input;
    }
    if (["undefined", "function", "symbol", "bigint"].includes(typeof input)) {
      throw new CanonicalJsonError(`Unsupported JSON value ${typeof input}`, jsonPath);
    }

    if (Array.isArray(input)) {
      if (seen.has(input)) throw new CanonicalJsonError("Cyclic arrays are not JSON", jsonPath);
      assertPlainArray(input, jsonPath);
      seen.add(input);
      const result = input.map((entry, index) => visit(entry, `${jsonPath}[${index}]`, depth + 1));
      seen.delete(input);
      return result;
    }

    if (typeof input === "object") {
      const object = input as Record<string, unknown>;
      const prototype = Object.getPrototypeOf(object);
      if (!isPlainJsonPrototype(prototype)) {
        throw new CanonicalJsonError("Only plain JSON objects are accepted", jsonPath);
      }
      if (seen.has(object)) throw new CanonicalJsonError("Cyclic objects are not JSON", jsonPath);
      const descriptors = Object.getOwnPropertyDescriptors(object);
      seen.add(object);
      const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      for (const key of Object.keys(descriptors).sort()) {
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable || descriptor.get || descriptor.set || !("value" in descriptor)) {
          throw new CanonicalJsonError("JSON objects may contain only enumerable data properties", `${jsonPath}.${key}`);
        }
        if (key === "__proto__" || key === "prototype" || key === "constructor") {
          throw new CanonicalJsonError(`Reserved object key ${key}`, `${jsonPath}.${key}`);
        }
        result[key] = visit(descriptor.value, `${jsonPath}.${key}`, depth + 1);
      }
      seen.delete(object);
      return result;
    }

    throw new CanonicalJsonError(`Unsupported JSON value ${typeof input}`, jsonPath);
  };

  const result = visit(value, "$", 0);
  const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (bytes > limits.maxBytes) throw new CanonicalJsonError(`JSON value exceeds ${limits.maxBytes} bytes`);
  return result;
}

function isPlainJsonPrototype(prototype: object | null): boolean {
  if (prototype === null || prototype === Object.prototype) return true;
  // Values crossing a Node vm realm have that realm's Object.prototype. It is
  // still a plain object prototype: its own prototype is null and its own
  // constructor is the native Object function for that realm.
  if (Object.getPrototypeOf(prototype) !== null) return false;
  const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor");
  return Boolean(
    constructor &&
      "value" in constructor &&
      typeof constructor.value === "function" &&
      constructor.value.name === "Object",
  );
}

export function canonicalJsonObject(value: unknown, limits: CanonicalJsonLimits): JsonObject {
  const result = canonicalJsonValue(value, limits);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new CanonicalJsonError("Expected a JSON object");
  }
  return result as JsonObject;
}

export function canonicalJson(value: unknown, limits: CanonicalJsonLimits): string {
  return JSON.stringify(canonicalJsonValue(value, limits));
}

export function deepFreezeJson<T extends JsonValue>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Array.isArray(value) ? value : Object.values(value)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

export function scalarLength(value: string): number {
  return Array.from(value).length;
}

function assertPlainArray(value: unknown[], jsonPath: string): void {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || !("value" in descriptor)) {
      throw new CanonicalJsonError("Sparse or accessor arrays are not JSON", `${jsonPath}[${index}]`);
    }
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      throw new CanonicalJsonError("Arrays may not contain extra properties", jsonPath);
    }
  }
}

