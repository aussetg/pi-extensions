import fs from "node:fs";
import path from "node:path";
import type { JsonObject } from "../types.js";

export interface HostPressureProvider {
  capture(): Promise<JsonObject>;
}

/** Reads host-wide PSI for diagnostics. These values must never enter a measurement binding hash. */
export class ProcHostPressureProvider implements HostPressureProvider {
  constructor(private readonly root = "/proc/pressure") {}

  async capture(): Promise<JsonObject> {
    const sampledAt = new Date().toISOString();
    const [cpu, io, memory] = await Promise.all([
      readPressure(path.join(this.root, "cpu")),
      readPressure(path.join(this.root, "io")),
      readPressure(path.join(this.root, "memory")),
    ]);
    return { sampledAt, cpu, io, memory } as unknown as JsonObject;
  }
}

async function readPressure(filePath: string): Promise<JsonObject> {
  const source = await fs.promises.readFile(filePath, "utf8");
  if (Buffer.byteLength(source) > 4_096) throw new Error(`Host PSI file is too large: ${filePath}`);
  const result: Record<string, JsonObject> = {};
  for (const line of source.split("\n").filter(Boolean)) {
    const match = /^(some|full) avg10=([0-9]+(?:\.[0-9]+)?) avg60=([0-9]+(?:\.[0-9]+)?) avg300=([0-9]+(?:\.[0-9]+)?) total=([0-9]+)$/.exec(line);
    if (!match || result[match[1]!]) throw new Error(`Malformed host PSI file: ${filePath}`);
    const values = match.slice(2).map(Number);
    if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error(`Malformed host PSI values: ${filePath}`);
    result[match[1]!] = {
      avg10: values[0]!, avg60: values[1]!, avg300: values[2]!, totalUsec: values[3]!,
    };
  }
  if (!result.some) throw new Error(`Host PSI file has no some record: ${filePath}`);
  return result as JsonObject;
}
