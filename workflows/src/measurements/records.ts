import type { HostCommandStatus } from "../commands/executor.js";
import type { ArtifactRef, ResourceMeasurement, WorkspaceRef } from "../runtime/durable-types.js";
import type { JsonObject } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import type {
  MetricCohortDelta,
  MetricObservation,
} from "./metrics.js";

export interface MeasurementCommandBinding {
  argv: string[];
  env: Record<string, string>;
  timeoutMs: number;
}

export interface MeasurementSamplingBinding {
  warmups: number;
  samples: number;
  mappings: Array<{ outputId: string; metricId: string; definitionHash: string }>;
}

export interface MeasurementSampleRecord {
  ordinal: number;
  kind: "warmup" | "sample";
  sampleIndex: number;
  executionId: string;
  status: HostCommandStatus;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  stdout: ArtifactRef;
  stderr: ArtifactRef;
  cgroup?: JsonObject;
  hostPressure: JsonObject;
  startedAt: string;
  endedAt: string;
}

export interface MeasurementRecord {
  measurementId: string;
  runId: string;
  operationId: string;
  attemptId?: string;
  profileId: string;
  profileHash: string;
  command: MeasurementCommandBinding;
  commandHash: string;
  workspace: WorkspaceRef;
  candidateId?: string;
  sampling: MeasurementSamplingBinding;
  samplingHash: string;
  cpuAffinity?: { physicalCores: number };
  environment: JsonObject;
  environmentHash: string;
  bindingHash: string;
  cohortArtifact: ArtifactRef;
  diagnosticsArtifact?: ArtifactRef;
  diagnostics: Array<{ sample: number; data: JsonObject }>;
  samples: MeasurementSampleRecord[];
  delta: MetricCohortDelta;
  startedAt: string;
  endedAt: string;
}

export interface MeasurementDispositionRecord {
  measurementId: string;
  runId: string;
  operationId: string;
  candidateId: string;
  disposition: "accepted" | "rejected";
  disposedAt: string;
}

export interface MeasurementWorkflowResult {
  measurementId: string;
  profile: string;
  profileHash: string;
  environmentHash: string;
  diagnostics: Array<{ sample: number; data: JsonObject }>;
  diagnosticsArtifact?: object;
  observation?: MetricObservation;
  observations?: Record<string, MetricObservation>;
}

export function measurementBindingHash(value: Pick<
  MeasurementRecord,
  "profileHash" | "commandHash" | "workspace" | "samplingHash" | "cpuAffinity" | "environmentHash"
>): string {
  return stableHash({
    formatVersion: 1,
    profileHash: value.profileHash,
    commandHash: value.commandHash,
    workspaceTreeHash: value.workspace.treeHash,
    samplingHash: value.samplingHash,
    cpuAffinity: value.cpuAffinity ?? null,
    environmentHash: value.environmentHash,
  });
}

export function aggregateMeasurementResources(samples: readonly MeasurementSampleRecord[]): ResourceMeasurement | undefined {
  const cgroups = samples.flatMap((sample) => sample.cgroup ? [sample.cgroup as any] : []);
  if (cgroups.length === 0) return undefined;
  const sum = (read: (value: any) => unknown): number | undefined => {
    const values = cgroups.map(read).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return values.length ? values.reduce((left, right) => left + right, 0) : undefined;
  };
  const maximum = (read: (value: any) => unknown): number | undefined => {
    const values = cgroups.map(read).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return values.length ? Math.max(...values) : undefined;
  };
  const result: ResourceMeasurement = {
    cpuUsec: sum((value) => value.cpu?.usageUsec),
    ioReadBytes: sum((value) => value.io?.readBytes),
    ioWriteBytes: sum((value) => value.io?.writeBytes),
    memoryCurrentBytes: maximum((value) => value.memory?.currentBytes),
    memoryPeakBytes: maximum((value) => value.memory?.peakBytes),
    tasksCurrent: maximum((value) => value.pids?.current),
    tasksPeak: maximum((value) => value.pids?.peak),
    cpuPressure: maximum((value) => value.cpu?.pressure?.some?.avg10),
    ioPressure: maximum((value) => value.io?.pressure?.some?.avg10),
    memoryPressure: maximum((value) => value.memory?.pressure?.some?.avg10),
  };
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined)) as ResourceMeasurement;
}
