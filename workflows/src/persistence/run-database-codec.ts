import type { SafetyConfiguration } from "../runtime/durable-types.js";

export type SqlRow = Record<string, null | number | bigint | string | Uint8Array>;

export function assertSafety(value: SafetyConfiguration): void {
  assertPositiveInteger(value.concurrency, "safety concurrency");
  assertPositiveInteger(value.maximumAgentLaunches, "maximum agent launches");
  assertPositiveInteger(value.memoryBytes, "memory bytes");
  assertPositiveInteger(value.tasks, "tasks");
  assertPositiveInteger(value.cpuQuotaPercent, "CPU quota percent");
  assertPositiveInteger(value.cpuWeight, "CPU weight");
  assertPositiveInteger(value.outputBytes, "output bytes");
  assertPositiveInteger(value.commandTimeoutMs, "command timeout");
}

export function assertIdentifier(value: string, label: string): void {
  assertText(value, label, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/u.test(value)) throw new TypeError(`Invalid ${label}`);
}

export function assertHash(value: string, label: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new TypeError(`Invalid ${label}`);
}

export function assertIsoDate(value: string, label: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`Invalid ${label}`);
  }
}

export function assertText(value: string, label: string, maximumScalars: number): void {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > maximumScalars
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
}

export function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid ${label}`);
}

export function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid ${label}`);
}

export function requiredString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Corrupt SQLite text column ${key}`);
  return value;
}

export function optionalString(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Corrupt SQLite nullable text column ${key}`);
  return value;
}

export function requiredNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`Corrupt SQLite numeric column ${key}`);
  return value;
}
