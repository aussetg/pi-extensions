import type { SafetyConfiguration } from "../runtime/durable-types.js";

export const WORKFLOW_UNIT_KINDS = [
  "coordinator",
  "agent",
  "command",
  "verification",
  "measurement",
] as const;

export type WorkflowUnitKind = (typeof WORKFLOW_UNIT_KINDS)[number];

export interface UnitResourcePolicy {
  memoryMaxBytes: number;
  tasksMax: number;
  cpuQuotaPercent: number;
  cpuWeight: number;
  ioWeight: number;
  timeoutStopMs: number;
}

const GIB = 1024 ** 3;

/**
 * Machine policy for every transient workflow service. These are host policy,
 * not workflow semantics or replay identity.
 */
export const WORKFLOW_UNIT_POLICIES: Readonly<Record<WorkflowUnitKind, Readonly<UnitResourcePolicy>>> =
  Object.freeze({
    coordinator: policy(2 * GIB, 1_024, 400, 200, 100, 5_000),
    agent: policy(4 * GIB, 512, 400, 100, 100, 2_000),
    command: policy(4 * GIB, 512, 400, 100, 100, 1_000),
    verification: policy(4 * GIB, 512, 400, 150, 150, 2_000),
    measurement: policy(4 * GIB, 512, 400, 200, 200, 2_000),
  });

export interface UnitPropertyOptions {
  policy?: UnitResourcePolicy;
  cpuAffinity?: readonly number[];
}

export function unitResourcePolicy(
  kind: WorkflowUnitKind,
  safety?: SafetyConfiguration,
): UnitResourcePolicy {
  const base = WORKFLOW_UNIT_POLICIES[kind];
  if (!safety) return { ...base };
  return validateUnitResourcePolicy({
    memoryMaxBytes: safety.memoryBytes,
    tasksMax: safety.tasks,
    cpuQuotaPercent: safety.cpuQuotaPercent,
    cpuWeight: safety.cpuWeight,
    ioWeight: base.ioWeight,
    timeoutStopMs: kind === "command"
      ? Math.min(base.timeoutStopMs, safety.commandTimeoutMs)
      : base.timeoutStopMs,
  });
}

/** Closed property set used by the launcher for all workflow-owned services. */
export function unitPropertyAssignments(
  kind: WorkflowUnitKind,
  options: UnitPropertyOptions = {},
): readonly string[] {
  const resource = validateUnitResourcePolicy(options.policy ?? WORKFLOW_UNIT_POLICIES[kind]);
  const assignments = [
    `MemoryMax=${resource.memoryMaxBytes}`,
    "MemorySwapMax=0",
    "MemoryZSwapMax=0",
    `TasksMax=${resource.tasksMax}`,
    `CPUWeight=${resource.cpuWeight}`,
    `CPUQuota=${resource.cpuQuotaPercent}%`,
    `IOWeight=${resource.ioWeight}`,
    "KillMode=mixed",
    `TimeoutStopSec=${resource.timeoutStopMs}ms`,
    "CollectMode=inactive",
  ];
  if (kind === "coordinator") assignments.push("Restart=on-failure", "RestartSec=250ms");
  if (options.cpuAffinity !== undefined) {
    assignments.push(`CPUAffinity=${normalizeCpuAffinity(options.cpuAffinity).join(" ")}`);
  }
  return Object.freeze(assignments);
}

export function validateUnitResourcePolicy(value: UnitResourcePolicy): UnitResourcePolicy {
  if (!value || typeof value !== "object") throw new Error("Systemd resource policy is missing");
  integer(value.memoryMaxBytes, "MemoryMax", 16 * 1024 * 1024, 1024 ** 5);
  integer(value.tasksMax, "TasksMax", 1, 65_536);
  integer(value.cpuQuotaPercent, "CPUQuota", 1, 100_000);
  integer(value.cpuWeight, "CPUWeight", 1, 10_000);
  integer(value.ioWeight, "IOWeight", 1, 10_000);
  integer(value.timeoutStopMs, "TimeoutStopSec", 1, 30_000);
  return { ...value };
}

function normalizeCpuAffinity(value: readonly number[]): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4_096) {
    throw new Error("Systemd CPU affinity must contain 1–4096 CPUs");
  }
  const cpus = [...new Set(value)];
  for (const cpu of cpus) integer(cpu, "CPU affinity", 0, 1_048_575);
  cpus.sort((left, right) => left - right);
  return cpus;
}

function policy(
  memoryMaxBytes: number,
  tasksMax: number,
  cpuQuotaPercent: number,
  cpuWeight: number,
  ioWeight: number,
  timeoutStopMs: number,
): Readonly<UnitResourcePolicy> {
  return Object.freeze(validateUnitResourcePolicy({
    memoryMaxBytes,
    tasksMax,
    cpuQuotaPercent,
    cpuWeight,
    ioWeight,
    timeoutStopMs,
  }));
}

function integer(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
}
