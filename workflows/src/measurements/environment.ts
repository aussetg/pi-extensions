import os from "node:os";
import { canonicalJsonObject, deepFreezeJson } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import type { JsonObject } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import type { MeasurementProfileSnapshot } from "./profiles.js";

export interface MeasurementEnvironmentDescriptor {
  id: string;
  protocolVersion: 1;
}

export interface MeasurementEnvironmentContext {
  profile: MeasurementProfileSnapshot;
  workspaceTreeHash: string;
  commandHash: string;
}

export interface MeasurementEnvironmentFingerprint {
  data: JsonObject;
  hash: string;
}

export interface MeasurementEnvironmentProvider {
  describe(): MeasurementEnvironmentDescriptor;
  capture(context: MeasurementEnvironmentContext): Promise<MeasurementEnvironmentFingerprint>;
}

const HOST_ENVIRONMENT_DESCRIPTOR: MeasurementEnvironmentDescriptor = Object.freeze({
  id: "linux-host-v1",
  protocolVersion: 1,
});

/** Stable comparison identity only. Ambient load, PSI, free memory, and time are sample diagnostics. */
export class HostMeasurementEnvironmentProvider implements MeasurementEnvironmentProvider {
  describe(): MeasurementEnvironmentDescriptor {
    return structuredClone(HOST_ENVIRONMENT_DESCRIPTOR);
  }

  async capture(_context: MeasurementEnvironmentContext): Promise<MeasurementEnvironmentFingerprint> {
    const cpuModels = [...new Set(os.cpus().map((cpu) => cpu.model.trim()))].sort();
    const data = canonicalJsonObject({
      platform: process.platform,
      arch: process.arch,
      kernel: os.release(),
      cpuModels,
      cpuCount: os.cpus().length,
      totalMemory: os.totalmem(),
      endianness: os.endianness(),
      nodeVersion: process.version,
    }, environmentLimits());
    return deepFreezeJson({ data, hash: stableHash(data) } as unknown as JsonObject) as unknown as MeasurementEnvironmentFingerprint;
  }
}

export class StaticMeasurementEnvironmentProvider implements MeasurementEnvironmentProvider {
  private readonly descriptor: MeasurementEnvironmentDescriptor;
  private fingerprint: MeasurementEnvironmentFingerprint;

  constructor(data: JsonObject, options: { id?: string } = {}) {
    this.descriptor = { id: options.id ?? "static-environment", protocolVersion: 1 };
    assertMeasurementEnvironmentDescriptor(this.descriptor);
    this.fingerprint = normalizeMeasurementEnvironmentFingerprint({ data, hash: stableHash(data) });
  }

  describe(): MeasurementEnvironmentDescriptor {
    return structuredClone(this.descriptor);
  }

  set(data: JsonObject): void {
    this.fingerprint = normalizeMeasurementEnvironmentFingerprint({ data, hash: stableHash(data) });
  }

  async capture(): Promise<MeasurementEnvironmentFingerprint> {
    return structuredClone(this.fingerprint);
  }
}

export function assertMeasurementEnvironmentDescriptor(value: MeasurementEnvironmentDescriptor): void {
  if (
    !value || typeof value !== "object" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.id) ||
    value.protocolVersion !== 1 || Object.keys(value).sort().join(",") !== "id,protocolVersion"
  ) throw new Error("Measurement environment provider descriptor is invalid");
}

export function normalizeMeasurementEnvironmentFingerprint(value: MeasurementEnvironmentFingerprint): MeasurementEnvironmentFingerprint {
  if (!value || typeof value !== "object") throw new Error("Measurement environment fingerprint is missing");
  const data = deepFreezeJson(canonicalJsonObject(value.data, environmentLimits()));
  const hash = stableHash(data);
  if (value.hash !== hash) throw new Error("Measurement environment fingerprint hash is invalid");
  return Object.freeze({ data, hash });
}

function environmentLimits() {
  return {
    maxBytes: 64 * 1024,
    maxDepth: 12,
    maxNodes: 1_024,
    maxStringScalars: DEFINITION_LIMITS.invocationStringScalars,
  };
}
