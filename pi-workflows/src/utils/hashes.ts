import crypto from "node:crypto";
import { stableJson } from "./stable-json.js";

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function sha256(input: string | Buffer): string {
  return `sha256:${sha256Hex(input)}`;
}

export function stableHash(value: unknown): string {
  return sha256(stableJson(value));
}

export function shortHash(value: string | Buffer, chars = 12): string {
  return sha256Hex(value).slice(0, chars);
}
