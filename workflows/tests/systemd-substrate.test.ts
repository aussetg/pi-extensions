import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { readCgroupMetrics, toResourceMeasurement } from "../src/systemd/cgroup-metrics.js";
import {
  discoverPhysicalCoreTopology,
  parseCpuList,
  physicalCoreAffinity,
} from "../src/systemd/cpu-topology.js";
import {
  assertWorkflowUnitName,
  parseWorkflowUnitName,
  SystemdUserUnitLauncher,
  workflowUnitName,
} from "../src/systemd/launcher.js";
import {
  unitPropertyAssignments,
  WORKFLOW_UNIT_KINDS,
  WORKFLOW_UNIT_POLICIES,
} from "../src/systemd/unit-properties.js";

const launcher = new SystemdUserUnitLauncher();
const launched = new Set<string>();
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all([...launched].map((unit) => launcher.stop(unit, 200).catch(() => undefined)));
  launched.clear();
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

describe("systemd unit contracts", () => {
  it("uses deterministic reserved names and a closed concrete property set", () => {
    for (const kind of WORKFLOW_UNIT_KINDS) {
      const prefix = kind === "coordinator" ? "flow" : kind;
      const id = `${prefix}_${"a".repeat(32)}`;
      const unit = workflowUnitName(kind, id);
      expect(unit).toBe(`pi-workflow-${kind}-${"a".repeat(32)}.service`);
      expect(parseWorkflowUnitName(unit)).toEqual({ kind, id });
      const properties = unitPropertyAssignments(kind);
      expect(properties).toEqual([
        `MemoryMax=${WORKFLOW_UNIT_POLICIES[kind].memoryMaxBytes}`,
        "MemorySwapMax=0",
        "MemoryZSwapMax=0",
        `TasksMax=${WORKFLOW_UNIT_POLICIES[kind].tasksMax}`,
        `CPUWeight=${WORKFLOW_UNIT_POLICIES[kind].cpuWeight}`,
        `CPUQuota=${WORKFLOW_UNIT_POLICIES[kind].cpuQuotaPercent}%`,
        `IOWeight=${WORKFLOW_UNIT_POLICIES[kind].ioWeight}`,
        "KillMode=mixed",
        `TimeoutStopSec=${WORKFLOW_UNIT_POLICIES[kind].timeoutStopMs}ms`,
        "CollectMode=inactive",
        ...(kind === "coordinator" ? ["Restart=on-failure", "RestartSec=250ms"] : []),
      ]);
    }
    expect(() => assertWorkflowUnitName("ssh.service")).toThrow(/not a workflow-owned/i);
    expect(() => assertWorkflowUnitName("pi-workflow-command-not-ours.service")).toThrow(/not a workflow-owned/i);
    expect(() => workflowUnitName("command", `agent_${"a".repeat(32)}`)).toThrow(/identity/i);
  });

  it("parses cgroup v2 accounting without mutating the hierarchy", async () => {
    const root = await temporary("cgroup-fixture-");
    const group = path.join(root, "user.slice", "fixture.service");
    await fs.promises.mkdir(group, { recursive: true });
    await Promise.all([
      write(group, "cpu.stat", "usage_usec 120\nuser_usec 80\nsystem_usec 40\nnr_throttled 2\nthrottled_usec 7\n"),
      write(group, "io.stat", "8:0 rbytes=10 wbytes=20 rios=1 wios=2\n8:1 rbytes=30 wbytes=40 rios=3 wios=4\n"),
      write(group, "memory.current", "4096\n"),
      write(group, "memory.peak", "8192\n"),
      write(group, "pids.current", "4\n"),
      write(group, "pids.peak", "6\n"),
      write(group, "memory.events", "low 0\nhigh 0\nmax 0\noom 1\noom_kill 1\n"),
      write(group, "pids.events", "max 3\n"),
      write(group, "cpu.pressure", pressure(11)),
      write(group, "io.pressure", pressure(12)),
      write(group, "memory.pressure", pressure(13)),
    ]);
    const metrics = await readCgroupMetrics("/user.slice/fixture.service", root);
    expect(metrics).toMatchObject({
      cpu: { usageUsec: 120, userUsec: 80, systemUsec: 40, throttledPeriods: 2, throttledUsec: 7 },
      io: { readBytes: 40, writeBytes: 60, readOperations: 4, writeOperations: 6 },
      memory: { currentBytes: 4096, peakBytes: 8192, oomEvents: 1, oomKillEvents: 1 },
      pids: { current: 4, peak: 6, limitEvents: 3 },
    });
    expect(toResourceMeasurement(metrics)).toMatchObject({
      cpuUsec: 120,
      ioReadBytes: 40,
      ioWriteBytes: 60,
      memoryPeakBytes: 8192,
      tasksCurrent: 4,
      tasksPeak: 6,
    });
    await expect(readCgroupMetrics("/../../etc", root)).rejects.toThrow(/invalid|escapes/i);
  });

  it("selects one allowed logical CPU from each physical core", async () => {
    const root = await temporary("cpu-topology-");
    await fs.promises.writeFile(path.join(root, "online"), "0-3\n");
    for (const [cpu, packageId, coreId] of [[0, 0, 0], [1, 0, 0], [2, 0, 1], [3, 1, 0]] as const) {
      const topology = path.join(root, `cpu${cpu}`, "topology");
      await fs.promises.mkdir(topology, { recursive: true });
      await fs.promises.writeFile(path.join(topology, "physical_package_id"), `${packageId}\n`);
      await fs.promises.writeFile(path.join(topology, "core_id"), `${coreId}\n`);
    }
    const status = path.join(root, "status");
    await fs.promises.writeFile(status, "Name:\ttest\nCpus_allowed_list:\t0-2\n");
    const topology = await discoverPhysicalCoreTopology({ sysfsRoot: root, processStatusPath: status });
    expect(topology.allowedCpus).toEqual([0, 1, 2]);
    expect(topology.cores).toEqual([
      { packageId: 0, coreId: 0, logicalCpus: [0, 1] },
      { packageId: 0, coreId: 1, logicalCpus: [2] },
    ]);
    expect(physicalCoreAffinity(topology, 2)).toEqual([0, 2]);
    expect(parseCpuList("0-2,4,6-7")).toEqual([0, 1, 2, 4, 6, 7]);
  });
});

describe("systemd user-manager integration", () => {
  it("keeps the payload alive after the launching helper dies and applies every resource property", async () => {
    const handle = await launch("coordinator", ["/usr/bin/sleep", "30"]);
    const properties = await show(handle.unit, [
      "MemoryMax", "MemorySwapMax", "MemoryZSwapMax", "TasksMax", "CPUWeight",
      "CPUQuotaPerSecUSec", "IOWeight", "KillMode", "TimeoutStopUSec", "CollectMode",
    ]);
    const policy = WORKFLOW_UNIT_POLICIES.coordinator;
    expect(properties).toMatchObject({
      MemoryMax: String(policy.memoryMaxBytes),
      MemorySwapMax: "0",
      MemoryZSwapMax: "0",
      TasksMax: String(policy.tasksMax),
      CPUWeight: String(policy.cpuWeight),
      CPUQuotaPerSecUSec: `${policy.cpuQuotaPercent / 100}s`,
      IOWeight: String(policy.ioWeight),
      KillMode: "mixed",
      TimeoutStopUSec: `${policy.timeoutStopMs / 1_000}s`,
      CollectMode: "inactive",
    });
    if (handle.helper.pid) process.kill(handle.helper.pid, "SIGKILL");
    await delay(100);
    expect((await launcher.inspect(handle.unit)).activeState).toBe("active");
    const stopped = await handle.stop(250);
    expect(stopped).toMatchObject({ termSent: true, collected: true });
    expect((await launcher.inspect(handle.unit)).loadState).toBe("not-found");
  }, 15_000);

  it("cancels the complete process tree with TERM before bounded KILL", async () => {
    const root = await temporary("systemd-tree-");
    const childFile = path.join(root, "child.pid");
    const handle = await launch("agent", [
      "/usr/bin/bash", "-c", `/usr/bin/sleep 30 & echo $! > ${shellQuote(childFile)}; wait`,
    ]);
    await waitForFile(childFile);
    const childPid = Number(await fs.promises.readFile(childFile, "utf8"));
    expect(await exists(`/proc/${childPid}`)).toBe(true);
    const stopped = await handle.stop(500);
    expect(stopped.termSent).toBe(true);
    await waitUntil(async () => !(await exists(`/proc/${childPid}`)), 2_000);
    expect(await exists(`/proc/${childPid}`)).toBe(false);
    expect(stopped.collected).toBe(true);
  }, 15_000);

  it("collects cgroup v2 CPU, IO, memory, task, and pressure metrics before cleanup", async () => {
    const root = await temporary("systemd-metrics-");
    const output = path.join(root, "output.bin");
    const affinity = physicalCoreAffinity(await discoverPhysicalCoreTopology(), 1);
    const handle = await launch("measurement", [
      "/usr/bin/bash", "-c",
      `/usr/bin/dd if=/dev/zero of=${shellQuote(output)} bs=4096 count=64 status=none; while :; do :; done`,
    ], { cpuAffinity: affinity });
    await delay(150);
    const metricState = await launcher.inspect(handle.unit);
    expect(metricState.mainPid).toBeTypeOf("number");
    const processStatus = await fs.promises.readFile(`/proc/${metricState.mainPid}/status`, "utf8");
    expect(/^Cpus_allowed_list:\s*(\S+)$/m.exec(processStatus)?.[1]).toBe(String(affinity[0]));
    const live = await readCgroupMetrics(metricState.controlGroup!, "/sys/fs/cgroup");
    expect(live).toMatchObject({
      controlGroup: expect.stringContaining(handle.unit),
      cpu: { usageUsec: expect.any(Number), pressure: { some: expect.any(Object) } },
      io: { readBytes: expect.any(Number), writeBytes: expect.any(Number), pressure: { some: expect.any(Object) } },
      memory: { currentBytes: expect.any(Number), peakBytes: expect.any(Number), pressure: { some: expect.any(Object) } },
      pids: { peak: expect.any(Number) },
    });
    const cleanup = await handle.stop(100);
    expect(cleanup.metrics?.cpu.usageUsec).toBeGreaterThan(0);
    expect(cleanup.metrics?.memory.peakBytes).toBeGreaterThan(0);
    expect(cleanup.metrics?.pids.peak).toBeGreaterThan(0);
    expect(cleanup.collected).toBe(true);
  }, 15_000);

  it("classifies OOM kills and task-limit hits, then reconciles stale owned units only", async () => {
    const oom = await launch("verification", [
      process.execPath,
      "-e",
      "const held=[]; setInterval(() => held.push(Buffer.alloc(8*1024*1024, 1)), 1)",
    ], { resourcePolicy: { ...WORKFLOW_UNIT_POLICIES.verification, memoryMaxBytes: 64 * 1024 * 1024 } });
    const oomResult = await oom.wait();
    expect(oomResult.outcome).toBe("oom");
    expect(oomResult.state.result).toBe("oom-kill");
    expect(oomResult.metrics?.memory.peakBytes).toBeGreaterThan(0);
    expect((await oom.collect()).collected).toBe(true);

    const tasks = await launch("command", [
      "/usr/bin/bash",
      "-c",
      "for i in $(/usr/bin/seq 1 32); do /usr/bin/sleep 0.3 & done; wait",
    ], { resourcePolicy: { ...WORKFLOW_UNIT_POLICIES.command, tasksMax: 4 } });
    const taskResult = await tasks.wait();
    expect(taskResult.outcome).toBe("tasks-max");
    expect(taskResult.metrics?.pids.limitEvents).toBeGreaterThan(0);
    expect((await tasks.collect()).collected).toBe(true);

    const expected = await launch("agent", ["/usr/bin/sleep", "30"]);
    const stale = await launch("measurement", ["/usr/bin/sleep", "30"]);
    const reconciled = await launcher.reconcileStale([expected.unit]);
    expect(reconciled.map((entry) => entry.unit)).toContain(stale.unit);
    expect(reconciled.every((entry) => entry.collected)).toBe(true);
    expect((await launcher.inspect(expected.unit)).activeState).toBe("active");
    await expect(launcher.stop("dbus.service")).rejects.toThrow(/not a workflow-owned/i);
    await expected.stop(100);
  }, 30_000);
});

async function launch(
  kind: "coordinator" | "agent" | "command" | "verification" | "measurement",
  argv: string[],
  options: Parameters<SystemdUserUnitLauncher["launch"]>[0] extends infer _ ? {
    resourcePolicy?: typeof WORKFLOW_UNIT_POLICIES.command;
    cpuAffinity?: number[];
  } : never = {},
) {
  const prefix = kind === "coordinator" ? "flow" : kind;
  const id = `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
  const unit = workflowUnitName(kind, id);
  launched.add(unit);
  const handle = await launcher.launch({ kind, id, argv, ...options });
  return handle;
}

async function show(unit: string, properties: string[]): Promise<Record<string, string>> {
  const result = await processResult("/usr/bin/systemctl", [
    "--user", "show", unit, `--property=${properties.join(",")}`, "--no-pager",
  ]);
  if (result.code !== 0) throw new Error(result.stderr);
  return Object.fromEntries(result.stdout.trim().split("\n").map((line) => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(at + 1)];
  }));
}

async function processResult(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function temporary(prefix: string): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function write(root: string, name: string, body: string): Promise<void> {
  await fs.promises.writeFile(path.join(root, name), body);
}

function pressure(total: number): string {
  return `some avg10=0.10 avg60=0.20 avg300=0.30 total=${total}\nfull avg10=0.01 avg60=0.02 avg300=0.03 total=${total - 1}\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitForFile(filePath: string): Promise<void> {
  await waitUntil(() => exists(filePath), 2_000);
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for integration fixture");
}

async function exists(filePath: string): Promise<boolean> {
  try { await fs.promises.access(filePath); return true; } catch { return false; }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
