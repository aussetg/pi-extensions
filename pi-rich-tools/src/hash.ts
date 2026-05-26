import { createHash, type Hash } from "node:crypto";

export function hashStringPart(hash: Hash, value: string): void {
  hash.update(String(value.length));
  hash.update("\0");
  hash.update(value);
  hash.update("\0");
}

export function hashStringArrayPart(hash: Hash, values: readonly string[]): void {
  hashStringPart(hash, String(values.length));
  for (const value of values) hashStringPart(hash, value);
}

export function hashText(text: string, length = 24): string {
  return createHash("sha256").update(text).digest("hex").slice(0, length);
}

export function hashTextParts(parts: Iterable<string>): string {
  const hash = createHash("sha256");
  for (const part of parts) hashStringPart(hash, part);
  return hash.digest("hex").slice(0, 24);
}

export function hashUnknown(hash: Hash, value: unknown, maxDepth = 32): void {
  hashUnknownInner(hash, value, new WeakSet<object>(), 0, maxDepth);
}

function hashUnknownInner(
  hash: Hash,
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  maxDepth: number,
): void {
  if (depth > maxDepth) {
    hash.update("depth\0");
    return;
  }
  if (value === null) {
    hash.update("null\0");
    return;
  }

  switch (typeof value) {
    case "string":
      hash.update("string\0");
      hashStringPart(hash, value);
      return;
    case "number":
      hash.update(`number\0${Object.is(value, -0) ? "-0" : String(value)}\0`);
      return;
    case "boolean":
    case "bigint":
    case "undefined":
      hash.update(`${typeof value}\0${String(value)}\0`);
      return;
    case "symbol":
    case "function":
      hash.update(`${typeof value}\0`);
      return;
    case "object": {
      if (seen.has(value)) {
        hash.update("cycle\0");
        return;
      }
      seen.add(value);
      if (Array.isArray(value)) {
        hash.update(`array\0${value.length}\0`);
        for (const item of value) {
          hashUnknownInner(hash, item, seen, depth + 1, maxDepth);
        }
      } else {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        hash.update(`object\0${keys.length}\0`);
        for (const key of keys) {
          hashStringPart(hash, key);
          hashUnknownInner(hash, record[key], seen, depth + 1, maxDepth);
        }
      }
      seen.delete(value);
    }
  }
}
