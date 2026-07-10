const ARRAY_HEADER_BYTES = 32;
const OBJECT_HEADER_BYTES = 48;
const PROPERTY_SLOT_BYTES = 16;
const STRING_HEADER_BYTES = 24;

export function estimateRetainedBytes(value: unknown): number {
  return estimate(value, new WeakSet<object>());
}

export function estimateCacheEntryBytes(key: string, value: unknown): number {
  return OBJECT_HEADER_BYTES + estimateStringBytes(key) + estimateRetainedBytes(value);
}

function estimate(value: unknown, seen: WeakSet<object>): number {
  if (value === null || value === undefined) return 0;

  switch (typeof value) {
    case "string":
      return estimateStringBytes(value);
    case "number":
    case "bigint":
      return 8;
    case "boolean":
      return 4;
    case "symbol":
    case "function":
      return 16;
    case "object":
      break;
    default:
      return 0;
  }

  if (seen.has(value)) return 0;
  seen.add(value);

  if (Array.isArray(value)) {
    let bytes = ARRAY_HEADER_BYTES + value.length * 8;
    for (const item of value) bytes += estimate(item, seen);
    return bytes;
  }

  let bytes = OBJECT_HEADER_BYTES;
  for (const item of Object.values(value as Record<string, unknown>)) {
    bytes += PROPERTY_SLOT_BYTES + estimate(item, seen);
  }
  return bytes;
}

function estimateStringBytes(value: string): number {
  // V8 may store Latin-1 strings in one byte, but two bytes per UTF-16 code unit
  // is a useful conservative bound for cache budgeting.
  return STRING_HEADER_BYTES + value.length * 2;
}
