import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  SandboxedCommandExecutor,
  sameCommandExecutorProtocol,
  type HostCommandRequest,
  type HostCommandResult,
} from "../src/commands/executor.js";
import {
  normalizeCommandProfile,
  type CommandArgumentDefinition,
  type CommandEffect,
  type CommandProfileSnapshot,
} from "../src/commands/profiles.js";
import type { SafetyConfiguration } from "../src/runtime/durable-types.js";
import { WORKFLOW_UNIT_POLICIES } from "../src/systemd/unit-properties.js";
import { sha256, stableHash } from "../src/utils/hashes.js";

const roots: string[] = [];
let executionSequence = 0;

afterEach(async () => {
  delete process.env.FLOW_COMMAND_TEST_CREDENTIAL;
  await Promise.all(roots.splice(0).map((root) => makeWritable(root).then(
    () => fs.promises.rm(root, { recursive: true, force: true }),
  )));
});

describe("systemd + Bubblewrap command execution", () => {
  it("passes declared arguments literally and selects exact workspace effects", async () => {
    const fixture = await setup("command-effects-");
    const literal = commandProfile({
      name: "literal",
      argv: ["/usr/bin/printf", "%s", "${value}"],
      arguments: { value: { type: "string", maximumBytes: 256 } },
      effects: ["candidate"],
    });
    const hostile = "$(touch /workspace/pwned); two words";
    const literalResult = await execute(fixture, literal, { value: hostile }, "candidate");
    expect(literalResult.status).toBe("completed");
    expect(literalResult.stdout.toString()).toBe(hostile);
    await expect(fs.promises.lstat(path.join(fixture.workspace, "pwned"))).rejects.toMatchObject({ code: "ENOENT" });

    const touch = commandProfile({
      name: "touch",
      argv: ["/usr/bin/touch", "${path}"],
      arguments: { path: { type: "project-path" } },
      effects: ["read-only", "temporary", "candidate"],
    });
    const temporary = await execute(fixture, touch, { path: "temporary.txt" }, "temporary");
    expect(temporary).toMatchObject({ status: "completed", exitCode: 0 });
    await expect(fs.promises.lstat(path.join(fixture.workspace, "temporary.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    const candidate = await execute(fixture, touch, { path: "candidate.txt" }, "candidate");
    expect(candidate).toMatchObject({ status: "completed", exitCode: 0 });
    expect(await fs.promises.readFile(path.join(fixture.workspace, "candidate.txt"), "utf8")).toBe("");

    const readOnly = await execute(fixture, touch, { path: "forbidden.txt" }, "read-only");
    expect(readOnly.status).toBe("completed");
    expect(readOnly.exitCode).not.toBe(0);
    await expect(fs.promises.lstat(path.join(fixture.workspace, "forbidden.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("classifies cancellation and timeout while cleaning complete process trees", async () => {
    const fixture = await setup("command-stop-");
    const sleep = commandProfile({
      name: "sleep",
      argv: ["/usr/bin/sleep", "${seconds}"],
      arguments: { seconds: { type: "integer", minimum: 1, maximum: 10 } },
      timeoutMs: 100,
      effects: ["read-only"],
    });
    const timedOut = await execute(fixture, sleep, { seconds: 5 }, "read-only");
    expect(timedOut).toMatchObject({ status: "timed-out", timedOut: true, unitCleaned: true });
    expect(timedOut.exitEvidence.kind).toBe("timeout");

    const safetyLimited = await execute(fixture, commandProfile({
      name: "safety-timeout",
      argv: ["/usr/bin/sleep", "${seconds}"],
      arguments: { seconds: { type: "integer", minimum: 1, maximum: 10 } },
      timeoutMs: 5_000,
      effects: ["read-only"],
    }), { seconds: 5 }, "read-only", {
      safety: commandSafety({ commandTimeoutMs: 100 }),
    });
    expect(safetyLimited).toMatchObject({ status: "timed-out", timedOut: true, unitCleaned: true });

    const cancellable = commandProfile({
      name: "cancellable",
      argv: ["/usr/bin/sleep", "${seconds}"],
      arguments: { seconds: { type: "integer", minimum: 1, maximum: 10 } },
      timeoutMs: 5_000,
      effects: ["read-only"],
    });
    const controller = new AbortController();
    const cancelled = await execute(fixture, cancellable, { seconds: 5 }, "read-only", {
      controller,
      onStart: () => { setTimeout(() => controller.abort(new Error("test cancellation")), 50); },
    });
    expect(cancelled).toMatchObject({ status: "cancelled", timedOut: false, unitCleaned: true });
    expect(cancelled.exitEvidence.kind).toBe("cancelled");
  }, 30_000);

  it("applies stored run resources with the selected command service class", async () => {
    const fixture = await setup("command-safety-");
    const safety = commandSafety({
      memoryBytes: 768 * 1024 * 1024,
      tasks: 48,
      cpuQuotaPercent: 200,
      cpuWeight: 321,
      commandTimeoutMs: 5_000,
    });
    let properties: Record<string, string> | undefined;
    const result = await execute(fixture, commandProfile({
      name: "resource-policy",
      argv: ["/usr/bin/sleep", "1"],
      timeoutMs: 5_000,
      effects: ["read-only"],
    }), {}, "read-only", {
      safety,
      unitKind: "measurement",
      onStart: async (_pid, unit) => {
        properties = await unitProperties(unit, [
          "MemoryMax", "TasksMax", "CPUWeight", "CPUQuotaPerSecUSec", "IOWeight", "TimeoutStopUSec",
        ]);
      },
    });
    expect(result.status).toBe("completed");
    expect(properties).toEqual({
      MemoryMax: String(safety.memoryBytes),
      TasksMax: String(safety.tasks),
      CPUWeight: String(safety.cpuWeight),
      CPUQuotaPerSecUSec: "2s",
      IOWeight: String(WORKFLOW_UNIT_POLICIES.measurement.ioWeight),
      TimeoutStopUSec: `${WORKFLOW_UNIT_POLICIES.measurement.timeoutStopMs / 1_000}s`,
    });
  }, 30_000);

  it("keeps streams bounded, publishes overflow artifacts, and records exact exit evidence", async () => {
    const fixture = await setup("command-output-");
    const output = commandProfile({
      name: "output",
      argv: ["/usr/bin/head", "-c", "${bytes}", "/dev/zero"],
      arguments: { bytes: { type: "integer", minimum: 1, maximum: 16_384 } },
      outputLimitBytes: 16_384,
      effects: ["read-only"],
    });
    const result = await execute(fixture, output, { bytes: 4_096 }, "read-only", {
      inlineLimitBytes: 64,
      maximumOutputBytes: 16_384,
    });
    expect(result).toMatchObject({ status: "completed", exitCode: 0, unitCleaned: true });
    expect(result.stdout).toHaveLength(64);
    expect(result.stdoutEvidence).toMatchObject({ bytes: 4_096, inlineBytes: 64, truncated: false });
    const overflow = result.stdoutEvidence.overflowArtifact!;
    expect(overflow).toMatchObject({ bytes: 4_096, digest: expect.stringMatching(/^sha256:/), truncated: false });
    const body = await fs.promises.readFile(path.join(fixture.runDir, overflow.path));
    expect(body).toHaveLength(4_096);
    expect(sha256(body)).toBe(overflow.digest);

    const limited = await execute(fixture, commandProfile({
      name: "limited-output",
      argv: ["/usr/bin/head", "-c", "4096", "/dev/zero"],
      outputLimitBytes: 4_096,
      effects: ["read-only"],
    }), {}, "read-only", {
      inlineLimitBytes: 64,
      maximumOutputBytes: 4_096,
      safety: commandSafety({ outputBytes: 512 }),
    });
    expect(limited).toMatchObject({ status: "output-limited", unitCleaned: true });
    expect(limited.stdoutEvidence).toMatchObject({ bytes: 512, inlineBytes: 64, truncated: true });
    expect(limited.stdoutEvidence.overflowArtifact).toMatchObject({ bytes: 512, truncated: true });

    const failed = await execute(fixture, commandProfile({
      name: "false",
      argv: ["/usr/bin/false"],
      effects: ["read-only"],
    }), {}, "read-only");
    expect(failed).toMatchObject({ status: "completed", exitCode: 1 });
    expect(failed.exitEvidence).toMatchObject({ kind: "exit", code: 1 });
    expect(failed.cgroup).toMatch(new RegExp(`/app\\.slice/${failed.unit.replaceAll(".", "\\.")}$`));
    expect(failed.executor.executables).toMatchObject({
      bubblewrap: { path: "/usr/bin/bwrap", version: expect.stringContaining("bubblewrap") },
    });
    expect(await unitLoadState(failed.unit)).toBe("not-found");
  }, 30_000);

  it("always unshares network and strips ambient credentials", async () => {
    const fixture = await setup("command-network-");
    process.env.FLOW_COMMAND_TEST_CREDENTIAL = "must-not-cross";
    const environment = await execute(fixture, commandProfile({
      name: "environment",
      argv: ["/usr/bin/env"],
      outputLimitBytes: 64 * 1024,
      effects: ["read-only"],
    }), {}, "read-only");
    expect(environment.status).toBe("completed");
    expect(environment.stdout.toString()).not.toContain("FLOW_COMMAND_TEST_CREDENTIAL");

    const network = await execute(fixture, commandProfile({
      name: "network",
      argv: ["/usr/bin/cat", "/proc/net/dev"],
      effects: ["read-only"],
    }), {}, "read-only");
    expect(network.status).toBe("completed");
    expect(network.stdout.toString()).toContain("lo:");
    expect(network.stdout.toString()).not.toMatch(/(?:eth|enp|wlan|wlp|tailscale|docker)\w*:/);
  }, 30_000);

  it("records executable versions only as diagnostics and never pins executable bytes", async () => {
    const fixture = await setup("command-diagnostics-");
    const wrapper = path.join(fixture.root, "bwrap-wrapper");
    await fs.promises.writeFile(wrapper, "#!/bin/sh\nexec /usr/bin/bwrap \"$@\"\n", { mode: 0o700 });
    const executor = new SandboxedCommandExecutor({ bwrapPath: wrapper });
    const descriptor = executor.describe();
    expect(Object.keys(descriptor).sort()).toEqual(["executables", "id", "sandbox"]);
    expect(descriptor.executables).toMatchObject({ bubblewrap: { path: wrapper, version: expect.stringContaining("bubblewrap") } });
    const changedDiagnostics = structuredClone(descriptor);
    changedDiagnostics.executables!.bubblewrap.version = "bubblewrap upgraded after command completion";
    changedDiagnostics.executables!.bubblewrap.path = "/different/diagnostic/path";
    expect(sameCommandExecutorProtocol(descriptor, changedDiagnostics)).toBe(true);
    await fs.promises.appendFile(wrapper, "# changed after descriptor capture\n");

    const result = await execute(fixture, commandProfile({
      name: "true",
      argv: ["/usr/bin/true"],
      effects: ["read-only"],
    }), {}, "read-only", { executor });
    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
  }, 30_000);
});

async function setup(prefix: string) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  const runDir = path.join(root, "run");
  const workspace = path.join(root, "workspace");
  await fs.promises.mkdir(runDir);
  await fs.promises.mkdir(workspace);
  await fs.promises.writeFile(path.join(workspace, "state.txt"), "launch\n");
  return { root, runDir, workspace, executor: new SandboxedCommandExecutor() };
}

async function execute(
  fixture: Awaited<ReturnType<typeof setup>>,
  profile: CommandProfileSnapshot,
  args: Record<string, string | number | boolean>,
  effect: CommandEffect,
  options: {
    controller?: AbortController;
    onStart?: (pid: number, unit: string) => void | Promise<void>;
    inlineLimitBytes?: number;
    maximumOutputBytes?: number;
    executor?: SandboxedCommandExecutor;
    safety?: SafetyConfiguration;
    unitKind?: HostCommandRequest["unitKind"];
  } = {},
): Promise<HostCommandResult> {
  const controller = options.controller ?? new AbortController();
  const executionId = `command_${(++executionSequence).toString(16).padStart(32, "0")}`;
  const request: HostCommandRequest = {
    runId: `flow_${"1".repeat(32)}`,
    operationPath: `run/command:${profile.name}`,
    attempt: 1,
    executionId,
    runDir: fixture.runDir,
    workspaceRoot: fixture.workspace,
    cwd: fixture.workspace,
    profile,
    arguments: args,
    effect,
    safety: options.safety ?? commandSafety(),
    maximumOutputBytes: options.maximumOutputBytes ?? 64 * 1024,
    inlineLimitBytes: options.inlineLimitBytes ?? 4_096,
    ...(options.unitKind ? { unitKind: options.unitKind } : {}),
  };
  return await (options.executor ?? fixture.executor).execute(request, controller.signal, options.onStart);
}

function commandSafety(patch: Partial<SafetyConfiguration> = {}): SafetyConfiguration {
  return {
    concurrency: 4,
    maximumAgentLaunches: 100,
    memoryBytes: 2 * 1024 * 1024 * 1024,
    tasks: 256,
    cpuQuotaPercent: 400,
    cpuWeight: 100,
    outputBytes: 64 * 1024,
    commandTimeoutMs: 10_000,
    ...patch,
  };
}

function commandProfile(patch: {
  name: string;
  argv: string[];
  arguments?: Record<string, CommandArgumentDefinition>;
  timeoutMs?: number;
  outputLimitBytes?: number;
  effects: CommandEffect[];
}): CommandProfileSnapshot {
  const definition = normalizeCommandProfile({
    description: "Command executor integration fixture.",
    timeoutMs: 5_000,
    outputLimitBytes: 64 * 1024,
    ...patch,
  });
  const namespace = "builtin" as const;
  return {
    ...definition,
    id: `${namespace}:${definition.name}`,
    namespace,
    path: `<builtin:${definition.name}>`,
    hash: stableHash({ namespace, definition }),
  };
}

async function unitLoadState(unit: string): Promise<string> {
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const process = spawn("/usr/bin/systemctl", ["--user", "show", unit, "--property=LoadState", "--value"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    process.stdout!.setEncoding("utf8");
    process.stdout!.on("data", (chunk: string) => { stdout += chunk; });
    process.on("close", (code) => resolve({ code, stdout }));
  });
  return result.code === 0 ? result.stdout.trim() || "not-found" : "not-found";
}

async function unitProperties(unit: string, names: string[]): Promise<Record<string, string>> {
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("/usr/bin/systemctl", [
      "--user", "show", unit, ...names.map((name) => `--property=${name}`),
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  if (result.code !== 0) throw new Error(`systemctl show failed: ${result.stderr.trim()}`);
  return Object.fromEntries(result.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

async function makeWritable(root: string): Promise<void> {
  await fs.promises.chmod(root, 0o700).catch(() => undefined);
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) await makeWritable(target);
    else await fs.promises.chmod(target, 0o600).catch(() => undefined);
  }));
}
