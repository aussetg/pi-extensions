import { isRecord } from "./types.ts";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function isErrorCode(error: unknown, ...codes: string[]): boolean {
  return isRecord(error) && typeof error.code === "string" && codes.includes(error.code);
}
