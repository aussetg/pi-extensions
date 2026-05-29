import type { JsonValue } from "../types.js";

export class NonJsonValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonJsonValueError";
  }
}

export function stableJson(value: unknown): string {
  return JSON.stringify(toStableJsonValue(value, new Set()));
}

export function toStableJsonValue(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value as JsonValue;
  if (t === "number") {
    if (!Number.isFinite(value)) throw new NonJsonValueError(`Non-finite number is not JSON: ${value}`);
    return value as JsonValue;
  }
  if (t === "undefined" || t === "function" || t === "symbol" || t === "bigint") {
    throw new NonJsonValueError(`Value is not JSON-serializable: ${t}`);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) throw new NonJsonValueError("Cannot stable-serialize cyclic arrays");
    seen.add(value);
    const out = value.map((item) => toStableJsonValue(item, seen));
    seen.delete(value);
    return out;
  }

  if (t === "object") {
    const object = value as Record<string, unknown>;
    if (seen.has(object)) throw new NonJsonValueError("Cannot stable-serialize cyclic objects");
    seen.add(object);
    const out: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(object).sort()) {
      const child = object[key];
      if (child === undefined) throw new NonJsonValueError(`Property ${key} is undefined`);
      out[key] = toStableJsonValue(child, seen);
    }
    seen.delete(object);
    return out;
  }

  throw new NonJsonValueError(`Unsupported value type: ${t}`);
}
