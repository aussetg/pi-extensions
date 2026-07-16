import fs from "node:fs";
import path from "node:path";
import type { ResourceMeasurement } from "../runtime/durable-types.js";

export interface PressureValues {
  avg10: number;
  avg60: number;
  avg300: number;
  totalUsec: number;
}

export interface PressureSnapshot {
  some: PressureValues;
  full?: PressureValues;
}

export interface CgroupMetrics {
  sampledAt: string;
  controlGroup: string;
  cpu: {
    usageUsec: number;
    userUsec: number;
    systemUsec: number;
    throttledUsec: number;
    throttledPeriods: number;
    pressure: PressureSnapshot;
  };
  io: {
    readBytes: number;
    writeBytes: number;
    readOperations: number;
    writeOperations: number;
    pressure: PressureSnapshot;
  };
  memory: {
    currentBytes: number;
    peakBytes: number;
    oomEvents: number;
    oomKillEvents: number;
    pressure: PressureSnapshot;
  };
  pids: {
    current: number;
    peak: number;
    limitEvents: number;
  };
}

export class CgroupMetricsUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CgroupMetricsUnavailableError";
  }
}

/** Read-only cgroup v2 accounting. This module never creates or mutates a cgroup. */
export async function readCgroupMetrics(
  controlGroup: string,
  cgroupRoot = "/sys/fs/cgroup",
): Promise<CgroupMetrics> {
  const directory = cgroupDirectory(cgroupRoot, controlGroup);
  try {
    const [
      cpuStatText,
      ioStatText,
      memoryCurrentText,
      memoryPeakText,
      pidsCurrentText,
      pidsPeakText,
      cpuPressureText,
      ioPressureText,
      memoryPressureText,
      memoryEventsText,
      pidsEventsText,
    ] = await Promise.all([
      boundedRead(path.join(directory, "cpu.stat")),
      boundedRead(path.join(directory, "io.stat")),
      boundedRead(path.join(directory, "memory.current")),
      boundedRead(path.join(directory, "memory.peak")),
      boundedRead(path.join(directory, "pids.current")),
      boundedRead(path.join(directory, "pids.peak")),
      boundedRead(path.join(directory, "cpu.pressure")),
      boundedRead(path.join(directory, "io.pressure")),
      boundedRead(path.join(directory, "memory.pressure")),
      boundedRead(path.join(directory, "memory.events")),
      boundedRead(path.join(directory, "pids.events")),
    ]);
    const cpu = parseKeyValues(cpuStatText, "cpu.stat");
    const io = parseIoStat(ioStatText);
    const memoryEvents = parseKeyValues(memoryEventsText, "memory.events");
    const pidsEvents = parseKeyValues(pidsEventsText, "pids.events");
    return {
      sampledAt: new Date().toISOString(),
      controlGroup,
      cpu: {
        usageUsec: required(cpu, "usage_usec", "cpu.stat"),
        userUsec: required(cpu, "user_usec", "cpu.stat"),
        systemUsec: required(cpu, "system_usec", "cpu.stat"),
        throttledUsec: cpu.throttled_usec ?? 0,
        throttledPeriods: cpu.nr_throttled ?? 0,
        pressure: parsePressure(cpuPressureText, "cpu.pressure"),
      },
      io: {
        readBytes: io.rbytes,
        writeBytes: io.wbytes,
        readOperations: io.rios,
        writeOperations: io.wios,
        pressure: parsePressure(ioPressureText, "io.pressure"),
      },
      memory: {
        currentBytes: parseScalar(memoryCurrentText, "memory.current"),
        peakBytes: parseScalar(memoryPeakText, "memory.peak"),
        oomEvents: memoryEvents.oom ?? 0,
        oomKillEvents: memoryEvents.oom_kill ?? 0,
        pressure: parsePressure(memoryPressureText, "memory.pressure"),
      },
      pids: {
        current: parseScalar(pidsCurrentText, "pids.current"),
        peak: parseScalar(pidsPeakText, "pids.peak"),
        limitEvents: pidsEvents.max ?? 0,
      },
    };
  } catch (error) {
    if (error instanceof CgroupMetricsUnavailableError) throw error;
    throw new CgroupMetricsUnavailableError(`Unable to read cgroup metrics for ${controlGroup}`, { cause: error });
  }
}

export function toResourceMeasurement(metrics: CgroupMetrics): ResourceMeasurement {
  return {
    cpuUsec: metrics.cpu.usageUsec,
    ioReadBytes: metrics.io.readBytes,
    ioWriteBytes: metrics.io.writeBytes,
    memoryCurrentBytes: metrics.memory.currentBytes,
    memoryPeakBytes: metrics.memory.peakBytes,
    tasksCurrent: metrics.pids.current,
    tasksPeak: metrics.pids.peak,
    cpuPressure: metrics.cpu.pressure.some.avg10,
    ioPressure: metrics.io.pressure.some.avg10,
    memoryPressure: metrics.memory.pressure.some.avg10,
  };
}

function cgroupDirectory(root: string, controlGroup: string): string {
  if (!path.isAbsolute(root)) throw new CgroupMetricsUnavailableError("Cgroup root must be absolute");
  if (!/^\/(?:[A-Za-z0-9_.:@-]+\/)*[A-Za-z0-9_.:@-]+$/.test(controlGroup)) {
    throw new CgroupMetricsUnavailableError("Invalid cgroup path");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, `.${controlGroup}`);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new CgroupMetricsUnavailableError("Cgroup path escapes the cgroup v2 mount");
  }
  return resolved;
}

async function boundedRead(filePath: string): Promise<string> {
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (stat.size > 64 * 1024) throw new Error(`${path.basename(filePath)} exceeds 64 KiB`);
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 64 * 1024) throw new Error(`${path.basename(filePath)} exceeds 64 KiB`);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function parseKeyValues(text: string, label: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of lines(text)) {
    const match = /^([a-z0-9_.]+) ([0-9]+)$/.exec(line);
    if (!match || result[match[1]!] !== undefined) throw new Error(`Malformed ${label}`);
    result[match[1]!] = safeCounter(match[2]!, label);
  }
  return result;
}

function parseIoStat(text: string): { rbytes: number; wbytes: number; rios: number; wios: number } {
  const total = { rbytes: 0, wbytes: 0, rios: 0, wios: 0 };
  for (const line of lines(text)) {
    const fields = line.split(/\s+/);
    if (!/^\d+:\d+$/.test(fields.shift() ?? "")) throw new Error("Malformed io.stat device");
    const seen = new Set<string>();
    for (const field of fields) {
      const match = /^([a-z]+)=([0-9]+)$/.exec(field);
      if (!match || seen.has(match[1]!)) throw new Error("Malformed io.stat field");
      seen.add(match[1]!);
      if (match[1] in total) total[match[1] as keyof typeof total] = addCounter(
        total[match[1] as keyof typeof total],
        safeCounter(match[2]!, "io.stat"),
        "io.stat",
      );
    }
  }
  return total;
}

function parsePressure(text: string, label: string): PressureSnapshot {
  const result: Partial<PressureSnapshot> = {};
  for (const line of lines(text)) {
    const match = /^(some|full) avg10=([0-9]+(?:\.[0-9]+)?) avg60=([0-9]+(?:\.[0-9]+)?) avg300=([0-9]+(?:\.[0-9]+)?) total=([0-9]+)$/.exec(line);
    if (!match || result[match[1] as "some" | "full"]) throw new Error(`Malformed ${label}`);
    result[match[1] as "some" | "full"] = {
      avg10: finiteDecimal(match[2]!, label),
      avg60: finiteDecimal(match[3]!, label),
      avg300: finiteDecimal(match[4]!, label),
      totalUsec: safeCounter(match[5]!, label),
    };
  }
  if (!result.some) throw new Error(`${label} has no some record`);
  return result as PressureSnapshot;
}

function parseScalar(text: string, label: string): number {
  const value = text.trim();
  if (!/^[0-9]+$/.test(value)) throw new Error(`Malformed ${label}`);
  return safeCounter(value, label);
}

function required(values: Record<string, number>, key: string, label: string): number {
  const value = values[key];
  if (value === undefined) throw new Error(`${label} is missing ${key}`);
  return value;
}

function lines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

function safeCounter(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} counter exceeds exact integer range`);
  return parsed;
}

function addCounter(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new Error(`${label} aggregate exceeds exact integer range`);
  return value;
}

function finiteDecimal(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Malformed ${label}`);
  return parsed;
}
