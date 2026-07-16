import fs from "node:fs";
import path from "node:path";

export interface PhysicalCore {
  packageId: number;
  coreId: number;
  logicalCpus: number[];
}

export interface PhysicalCoreTopology {
  onlineCpus: number[];
  allowedCpus: number[];
  cores: PhysicalCore[];
}

/** Discover this process's usable physical cores from Linux sysfs and procfs. */
export async function discoverPhysicalCoreTopology(options: {
  sysfsRoot?: string;
  processStatusPath?: string;
} = {}): Promise<PhysicalCoreTopology> {
  const root = options.sysfsRoot ?? "/sys/devices/system/cpu";
  const online = parseCpuList(await fs.promises.readFile(path.join(root, "online"), "utf8"));
  const status = await fs.promises.readFile(options.processStatusPath ?? "/proc/self/status", "utf8");
  const allowedLine = /^Cpus_allowed_list:\s*(\S+)\s*$/m.exec(status)?.[1];
  if (!allowedLine) throw new Error("/proc/self/status has no Cpus_allowed_list");
  const allowedSet = new Set(parseCpuList(allowedLine));
  const allowed = online.filter((cpu) => allowedSet.has(cpu));
  if (allowed.length === 0) throw new Error("No online CPUs are available to the workflow process");
  const groups = new Map<string, PhysicalCore>();
  for (const cpu of allowed) {
    const topology = path.join(root, `cpu${cpu}`, "topology");
    const [packageText, coreText] = await Promise.all([
      fs.promises.readFile(path.join(topology, "physical_package_id"), "utf8"),
      fs.promises.readFile(path.join(topology, "core_id"), "utf8"),
    ]);
    const packageId = nonnegativeInteger(packageText, "physical package id");
    const coreId = nonnegativeInteger(coreText, "physical core id");
    const key = `${packageId}:${coreId}`;
    const core = groups.get(key) ?? { packageId, coreId, logicalCpus: [] };
    core.logicalCpus.push(cpu);
    groups.set(key, core);
  }
  const cores = [...groups.values()]
    .map((core) => ({ ...core, logicalCpus: core.logicalCpus.sort((left, right) => left - right) }))
    .sort((left, right) => left.packageId - right.packageId || left.coreId - right.coreId);
  return { onlineCpus: online, allowedCpus: allowed, cores };
}

/** Select one logical CPU from each physical core, never SMT siblings. */
export function physicalCoreAffinity(topology: PhysicalCoreTopology, physicalCores: number): number[] {
  if (!Number.isSafeInteger(physicalCores) || physicalCores < 1 || physicalCores > topology.cores.length) {
    throw new Error(`Requested ${physicalCores} physical cores, but ${topology.cores.length} are available`);
  }
  return topology.cores.slice(0, physicalCores).map((core) => core.logicalCpus[0]!);
}

export function parseCpuList(value: string): number[] {
  const text = value.trim();
  if (!text) throw new Error("CPU list is empty");
  const cpus = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) throw new Error(`Invalid CPU list segment ${part}`);
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > last || last > 1_048_575) {
      throw new Error(`Invalid CPU list segment ${part}`);
    }
    if (last - first > 4_095) throw new Error("CPU list range is unreasonably large");
    for (let cpu = first; cpu <= last; cpu++) cpus.add(cpu);
  }
  return [...cpus].sort((left, right) => left - right);
}

function nonnegativeInteger(value: string, label: string): number {
  const text = value.trim();
  if (!/^\d+$/.test(text)) throw new Error(`Invalid ${label}`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${label}`);
  return parsed;
}
