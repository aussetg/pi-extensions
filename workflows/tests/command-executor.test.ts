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

    const cancellable = commandProfile({
      name: "cancellable",
      argv: ["/usr/bin/sleep", "${seconds}"],
      arguments: { seconds: { type: "integer", minimum: 1, maximum: 10 } },
      timeoutMs: 5_000,
      effects: ["read-only"],
    });
    const controller = new AbortController();
    const cancelled = await execute(fixture, cancellable, { seconds: 5 }, "read-only", controller, () => {
      setTimeout(() => controller.abort(new Error("test cancellation")), 50);
    });
    expect(cancelled).toMatchObject({ status: "cancelled", timedOut: false, unitCleaned: true });
    expect(cancelled.exitEvidence.kind).toBe("cancelled");
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
    const result = await execute(fixture, output, { bytes: 4_096 }, "read-only", undefined, undefined, 64, 16_384);
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
      outputLimitBytes: 512,
      effects: ["read-only"],
    }), {}, "read-only", undefined, undefined, 64, 1_024);
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
    expect(Object.keys(descriptor).sort()).toEqual(["containment", "executables", "id", "protocolVersion", "sandbox"]);
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
    }), {}, "read-only", undefined, undefined, undefined, undefined, executor);
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
  controller = new AbortController(),
  onStart?: () => void,
  inlineLimitBytes = 4_096,
  maximumOutputBytes = 64 * 1024,
  executor = fixture.executor,
): Promise<HostCommandResult> {
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
    maximumOutputBytes,
    inlineLimitBytes,
  };
  return await executor.execute(request, controller.signal, async () => onStart?.());
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

async function makeWritable(root: string): Promise<void> {
  await fs.promises.chmod(root, 0o700).catch(() => undefined);
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) await makeWritable(target);
    else await fs.promises.chmod(target, 0o600).catch(() => undefined);
  }));
}
