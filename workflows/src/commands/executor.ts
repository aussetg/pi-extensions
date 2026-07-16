import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import type { CgroupMetrics } from "../systemd/cgroup-metrics.js";
import { discoverPhysicalCoreTopology, physicalCoreAffinity } from "../systemd/cpu-topology.js";
import {
  SystemdUserUnitLauncher,
  workflowUnitName,
  type WorkflowUnitHandle,
} from "../systemd/launcher.js";
import {
  unitResourcePolicy,
  type UnitResourcePolicy,
  type WorkflowUnitKind,
} from "../systemd/unit-properties.js";
import { bubblewrapProjectViewArgs } from "../workspaces/bubblewrap-project-view.js";
import {
  resolveCommandInvocation,
  type CommandArgumentValues,
  type CommandProfileSnapshot,
  type ResolvedCommandInvocation,
} from "./profiles.js";

export interface HostCommandRequest {
  runId: string;
  operationPath: string;
  attempt: number;
  executionId: string;
  runDir: string;
  /** Immutable launch snapshot or the exact candidate workspace root. */
  workspaceRoot: string;
  /** Exact cwd inside workspaceRoot, chosen by the coordinator rather than workflow arguments. */
  cwd: string;
  profile: CommandProfileSnapshot;
  arguments: CommandArgumentValues;
  effect: "read-only" | "temporary" | "candidate";
  /** Host safety may lower the profile's reviewed output ceiling. */
  maximumOutputBytes: number;
  /** Per-stream bytes returned inline before an immutable overflow artifact is used. */
  inlineLimitBytes: number;
  /** Host-selected service class; workflow source cannot set this. */
  unitKind?: Extract<WorkflowUnitKind, "command" | "verification" | "measurement">;
  /** Measurement-only physical-core pinning resolved from this machine's topology. */
  physicalCoreAffinity?: number;
}

export type HostCommandStatus =
  | "completed"
  | "timed-out"
  | "output-limited"
  | "infrastructure-failure"
  | "cancelled";

export interface CommandOverflowArtifact {
  path: string;
  digest: string;
  bytes: number;
  truncated: boolean;
}

export interface CommandStreamEvidence {
  bytes: number;
  digest: string;
  inlineBytes: number;
  truncated: boolean;
  overflowArtifact?: CommandOverflowArtifact;
}

export interface CommandExitEvidence {
  kind: "exit" | "signal" | "timeout" | "cancelled" | "output-limit" | "spawn-error";
  code: number | null;
  signal?: NodeJS.Signals;
}

export interface HostCommandResult {
  status: HostCommandStatus;
  exitCode: number | null;
  signal?: NodeJS.Signals;
  timedOut: boolean;
  stdout: Buffer;
  stderr: Buffer;
  stdoutEvidence: CommandStreamEvidence;
  stderrEvidence: CommandStreamEvidence;
  exitEvidence: CommandExitEvidence;
  invocation: ResolvedCommandInvocation;
  executor: HostCommandExecutorDescriptor;
  startedAt: string;
  endedAt: string;
  pid?: number;
  unit: string;
  cgroup?: string;
  resources?: CgroupMetrics;
  unitCleaned: boolean;
  message?: string;
}

export interface HostCommandExecutor {
  describe(): HostCommandExecutorDescriptor;
  execute(
    request: HostCommandRequest,
    signal: AbortSignal,
    onStart?: (pid: number, unit: string) => void | Promise<void>,
  ): Promise<HostCommandResult>;
}

export interface CommandExecutableDiagnostic {
  path: string;
  version?: string;
}

export interface HostCommandExecutorDescriptor {
  id: string;
  protocolVersion: 1;
  sandbox: "bwrap-systemd" | "fake";
  executables?: {
    bubblewrap: CommandExecutableDiagnostic;
    systemdRun: CommandExecutableDiagnostic;
    systemctl: CommandExecutableDiagnostic;
  };
  containment?: {
    memoryMax: string;
    memorySwapMax: "0";
    memoryZSwapMax: "0";
    cpuQuota: string;
    cpuWeight: number;
    ioWeight: number;
    tasksMax: number;
    killMode: "mixed";
    timeoutStopMs: number;
    collectMode: "inactive";
  };
}

export interface SandboxedCommandExecutorOptions {
  bwrapPath?: string;
  systemdRunPath?: string;
  systemctlPath?: string;
  memoryMax?: string;
  cpuQuota?: string;
  tasksMax?: number;
  terminationGraceMs?: number;
}

/** Executable paths/versions and cgroup properties are evidence, not replay identity. */
export function sameCommandExecutorProtocol(
  left: HostCommandExecutorDescriptor,
  right: HostCommandExecutorDescriptor,
): boolean {
  return left.id === right.id && left.protocolVersion === right.protocolVersion && left.sandbox === right.sandbox;
}

/**
 * Linux-only command containment. There is intentionally no direct-spawn or
 * portable fallback: every command is a transient systemd service whose payload
 * is a networkless Bubblewrap process.
 */
export class SandboxedCommandExecutor implements HostCommandExecutor {
  private readonly bwrap: string;
  private readonly systemdRun: string;
  private readonly systemctl: string;
  private readonly memoryMax: string;
  private readonly cpuQuota: string;
  private readonly tasksMax: number;
  private readonly terminationGraceMs: number;
  private readonly resourcePolicy: UnitResourcePolicy;
  private readonly launcher: SystemdUserUnitLauncher;
  private readonly descriptor: HostCommandExecutorDescriptor;

  constructor(options: SandboxedCommandExecutorOptions = {}) {
    this.bwrap = options.bwrapPath ?? "/usr/bin/bwrap";
    this.systemdRun = options.systemdRunPath ?? "/usr/bin/systemd-run";
    this.systemctl = options.systemctlPath ?? "/usr/bin/systemctl";
    this.memoryMax = options.memoryMax ?? "4G";
    this.cpuQuota = options.cpuQuota ?? "400%";
    this.tasksMax = options.tasksMax ?? 512;
    this.terminationGraceMs = options.terminationGraceMs ?? 1_000;
    if (
      !/^\d+(?:K|M|G)$/.test(this.memoryMax) || !/^\d{1,4}%$/.test(this.cpuQuota) ||
      !Number.isSafeInteger(this.tasksMax) || this.tasksMax < 1 || this.tasksMax > 4_096 ||
      !Number.isSafeInteger(this.terminationGraceMs) || this.terminationGraceMs < 1 || this.terminationGraceMs > 30_000
    ) throw new Error("Invalid command containment limits");
    this.resourcePolicy = {
      ...unitResourcePolicy("command"),
      memoryMaxBytes: parseMemoryBytes(this.memoryMax),
      cpuQuotaPercent: Number.parseInt(this.cpuQuota, 10),
      tasksMax: this.tasksMax,
      timeoutStopMs: this.terminationGraceMs,
    };
    this.launcher = new SystemdUserUnitLauncher({
      systemdRunPath: this.systemdRun,
      systemctlPath: this.systemctl,
    });
    this.descriptor = Object.freeze({
      id: "sandboxed-command",
      protocolVersion: 1,
      sandbox: "bwrap-systemd",
      executables: {
        bubblewrap: executableDiagnostic(this.bwrap, ["--version"]),
        systemdRun: executableDiagnostic(this.systemdRun, ["--version"]),
        systemctl: executableDiagnostic(this.systemctl, ["--version"]),
      },
      containment: {
        memoryMax: this.memoryMax,
        memorySwapMax: "0",
        memoryZSwapMax: "0",
        cpuQuota: this.cpuQuota,
        cpuWeight: this.resourcePolicy.cpuWeight,
        ioWeight: this.resourcePolicy.ioWeight,
        tasksMax: this.tasksMax,
        killMode: "mixed",
        timeoutStopMs: this.terminationGraceMs,
        collectMode: "inactive",
      },
    } satisfies HostCommandExecutorDescriptor);
  }

  describe(): HostCommandExecutorDescriptor {
    return structuredClone(this.descriptor);
  }

  async execute(
    request: HostCommandRequest,
    signal: AbortSignal,
    onStart?: (pid: number, unit: string) => void | Promise<void>,
  ): Promise<HostCommandResult> {
    validateRequest(request);
    const invocation = resolveCommandInvocation(request.profile, request.arguments, request.effect);
    await Promise.all([assertExecutable(this.bwrap), this.launcher.preflight()]);
    await assertExecutionDirectories(request.runDir, request.workspaceRoot, request.cwd);

    const relativeCwd = path.relative(request.workspaceRoot, request.cwd).split(path.sep).join("/");
    const sandboxCwd = relativeCwd && relativeCwd !== "." ? `/workspace/${relativeCwd}` : "/workspace";
    const scratchRoot = path.join(request.runDir, "workspaces", "overlays", "commands", request.executionId);
    const home = path.join(scratchRoot, "home");
    const temporary = path.join(scratchRoot, "tmp");
    const outputRoot = path.join(request.runDir, "outputs", request.executionId);
    const unitKind = request.unitKind ?? "command";
    const unitIdentity = `${unitKind}_${request.executionId.slice("command_".length)}`;
    const unit = workflowUnitName(unitKind, unitIdentity);
    const stale = await this.launcher.inspect(unit);
    if (["active", "activating", "deactivating", "reloading"].includes(stale.activeState)) {
      await this.launcher.stop(unit, this.terminationGraceMs);
    } else if (stale.loadState !== "not-found") {
      await this.launcher.collect(unit);
    }
    await Promise.all([
      fs.promises.rm(scratchRoot, { recursive: true, force: true }),
      fs.promises.rm(outputRoot, { recursive: true, force: true }),
    ]);
    await createExecutionDirectories(home, temporary, outputRoot);

    const stdoutCapture = new StreamCapture("stdout", outputRoot, request.runDir, request.inlineLimitBytes);
    const stderrCapture = new StreamCapture("stderr", outputRoot, request.runDir, request.inlineLimitBytes);
    const projectView = request.effect === "candidate"
      ? ["--bind", request.workspaceRoot, "/workspace"]
      : bubblewrapProjectViewArgs(
          request.workspaceRoot,
          "/workspace",
          request.effect === "read-only" ? "inspection" : "temporary",
        );
    const bwrapArgs = [
      "--die-with-parent",
      "--new-session",
      "--unshare-pid",
      "--unshare-uts",
      "--unshare-ipc",
      "--unshare-net",
      "--tmpfs", "/",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/sbin", "/sbin",
      "--ro-bind", "/lib", "/lib",
      "--ro-bind", "/lib64", "/lib64",
      "--ro-bind", "/etc", "/etc",
      "--ro-bind-try", "/opt", "/opt",
      "--dir", "/home",
      "--dir", "/home/workflow",
      ...projectView,
      "--bind", home, "/home/workflow",
      "--bind", temporary, "/tmp",
      "--proc", "/proc",
      "--dev", "/dev",
      "--chdir", sandboxCwd,
      "--clearenv",
      "--setenv", "HOME", "/home/workflow",
      "--setenv", "PATH", "/usr/local/sbin:/usr/local/bin:/usr/bin",
      "--setenv", "LANG", "C.UTF-8",
      "--setenv", "LC_ALL", "C.UTF-8",
    ];
    for (const [key, value] of Object.entries(invocation.env).sort(([left], [right]) => left.localeCompare(right))) {
      bwrapArgs.push("--setenv", key, value);
    }
    bwrapArgs.push("--", ...invocation.argv);

    const cpuAffinity = request.physicalCoreAffinity === undefined
      ? undefined
      : physicalCoreAffinity(await discoverPhysicalCoreTopology(), request.physicalCoreAffinity);
    const startedAt = new Date().toISOString();
    let stopReason: "timeout" | "cancel" | "output" | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let outputBytes = 0;
    const maximumOutputBytes = Math.min(invocation.outputLimitBytes, request.maximumOutputBytes);
    let service!: WorkflowUnitHandle;
    let stopPromise: Promise<unknown> | undefined;
    let timeout!: NodeJS.Timeout;
    let startCallback: Promise<void> | undefined;

    const killTree = async (reason: "timeout" | "cancel" | "output"): Promise<void> => {
      stopReason ??= reason;
      stopPromise ??= service.stop(this.terminationGraceMs).catch(() => undefined);
      await stopPromise;
    };
    const collect = (capture: StreamCapture, chunk: Buffer): void => {
      if (outputBytes >= maximumOutputBytes) {
        capture.markTruncated();
        void killTree("output");
        return;
      }
      const permitted = Math.min(chunk.length, maximumOutputBytes - outputBytes);
      if (permitted > 0) {
        capture.append(chunk.subarray(0, permitted));
        outputBytes += permitted;
      }
      if (permitted < chunk.length) {
        capture.markTruncated();
        void killTree("output");
      }
    };
    const abort = () => void killTree("cancel");
    service = await this.launcher.launch({
      kind: unitKind,
      id: unitIdentity,
      argv: [this.bwrap, ...bwrapArgs],
      workingDirectory: "/",
      pipe: true,
      resourcePolicy: this.resourcePolicy,
      ...(cpuAffinity ? { cpuAffinity } : {}),
      onSpawn: (spawned) => {
        service = spawned;
        spawned.stdout!.on("data", (chunk: Buffer) => collect(stdoutCapture, Buffer.from(chunk)));
        spawned.stderr!.on("data", (chunk: Buffer) => collect(stderrCapture, Buffer.from(chunk)));
        timeout = setTimeout(() => void killTree("timeout"), invocation.timeoutMs);
        timeout.unref?.();
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        if (spawned.helper.pid && onStart) {
          startCallback = Promise.resolve(onStart(spawned.helper.pid, unit));
        }
      },
    });
    const cgroup = service.controlGroup;
    const completionPromise = service.wait();

    if (startCallback) {
      try {
        await startCallback;
      } catch (error) {
        await killTree("cancel");
        await completionPromise;
        await settleCommandTimers(timeout, escalation, signal, abort);
        await service.collect();
        stdoutCapture.discard();
        stderrCapture.discard();
        await cleanupScratch(scratchRoot, outputRoot);
        throw error;
      }
    }

    const completion = await completionPromise;
    if (stopPromise) await stopPromise;
    await settleCommandTimers(timeout, escalation, signal, abort);
    let stdout: Awaited<ReturnType<StreamCapture["finish"]>>;
    let stderr: Awaited<ReturnType<StreamCapture["finish"]>>;
    try {
      [stdout, stderr] = await Promise.all([stdoutCapture.finish(), stderrCapture.finish()]);
    } catch (error) {
      stdoutCapture.discard();
      stderrCapture.discard();
      await service.collect();
      await cleanupScratch(scratchRoot, outputRoot);
      throw error;
    }
    const stderrText = stderr.inline.toString("utf8");
    const containmentFailure = /Failed to (?:connect to bus|start transient scope unit|set unit properties)|bwrap: (?:Creating new namespace failed|No permissions to create a new namespace|setting up uid map)/i.test(stderrText);
    const serviceFailed = !["success", "exit-code"].includes(completion.outcome) || completion.signal !== undefined;
    const status: HostCommandStatus = stopReason === "cancel"
      ? "cancelled"
      : stopReason === "timeout"
        ? "timed-out"
        : stopReason === "output"
          ? "output-limited"
          : serviceFailed || containmentFailure
            ? "infrastructure-failure"
            : "completed";
    const exitKind: CommandExitEvidence["kind"] = stopReason === "cancel"
      ? "cancelled"
      : stopReason === "timeout"
        ? "timeout"
        : stopReason === "output"
          ? "output-limit"
          : completion.outcome === "infrastructure-failure"
            ? "spawn-error"
            : completion.signal
              ? "signal"
              : "exit";
    const cleanup = await service.collect();
    const unitCleaned = cleanup.collected;
    await fs.promises.rm(scratchRoot, { recursive: true, force: true }).catch(() => undefined);
    await removeEmptyDirectory(outputRoot);
    const message = containmentFailure
        ? "Command containment failed before verified execution"
        : completion.outcome === "oom"
          ? "Command exceeded its memory limit"
          : completion.outcome === "tasks-max"
            ? "Command exceeded its task limit"
            : completion.outcome === "infrastructure-failure"
              ? "Command service failed before verified execution"
        : status === "output-limited"
          ? `Command output exceeded ${maximumOutputBytes} bytes`
          : status === "timed-out"
            ? "Command timed out"
            : status === "cancelled"
              ? "Command cancelled"
              : undefined;
    return {
      status,
      exitCode: completion.exitCode,
      ...(completion.signal ? { signal: completion.signal } : {}),
      timedOut: status === "timed-out",
      stdout: stdout.inline,
      stderr: stderr.inline,
      stdoutEvidence: stdout.evidence,
      stderrEvidence: stderr.evidence,
      exitEvidence: {
        kind: exitKind,
        code: completion.exitCode,
        ...(completion.signal ? { signal: completion.signal } : {}),
      },
      invocation,
      executor: this.describe(),
      startedAt,
      endedAt: new Date().toISOString(),
      ...(service.mainPid ? { pid: service.mainPid } : {}),
      unit,
      ...(cgroup ? { cgroup } : {}),
      ...((cleanup.metrics ?? completion.metrics) ? { resources: cleanup.metrics ?? completion.metrics } : {}),
      unitCleaned,
      ...(message ? { message } : {}),
    };
  }
}

class StreamCapture {
  private readonly descriptor: number;
  private readonly temporaryPath: string;
  private readonly hash = crypto.createHash("sha256");
  private readonly inline: Buffer[] = [];
  private inlineBytes = 0;
  private bytes = 0;
  private truncated = false;
  private closed = false;

  constructor(
    private readonly stream: "stdout" | "stderr",
    private readonly outputRoot: string,
    private readonly runDir: string,
    private readonly inlineLimitBytes: number,
  ) {
    this.temporaryPath = path.join(outputRoot, `.${stream}-${crypto.randomUUID()}.tmp`);
    this.descriptor = fs.openSync(this.temporaryPath, "wx", 0o600);
  }

  append(chunk: Buffer): void {
    if (this.closed) throw new Error(`${this.stream} capture is already closed`);
    if (chunk.length === 0) return;
    fs.writeSync(this.descriptor, chunk);
    this.hash.update(chunk);
    this.bytes += chunk.length;
    if (this.inlineBytes < this.inlineLimitBytes) {
      const retained = chunk.subarray(0, Math.min(chunk.length, this.inlineLimitBytes - this.inlineBytes));
      this.inline.push(Buffer.from(retained));
      this.inlineBytes += retained.length;
    }
  }

  markTruncated(): void {
    this.truncated = true;
  }

  discard(): void {
    if (!this.closed) {
      this.closed = true;
      try { fs.closeSync(this.descriptor); } catch {}
    }
    try { fs.rmSync(this.temporaryPath, { force: true }); } catch {}
  }

  async finish(): Promise<{ inline: Buffer; evidence: CommandStreamEvidence }> {
    if (this.closed) throw new Error(`${this.stream} capture already finalized`);
    this.closed = true;
    fs.fsyncSync(this.descriptor);
    fs.closeSync(this.descriptor);
    const digest = `sha256:${this.hash.digest("hex")}`;
    let overflowArtifact: CommandOverflowArtifact | undefined;
    if (this.bytes > this.inlineLimitBytes) {
      const finalPath = path.join(this.outputRoot, `${this.stream}.overflow`);
      await fs.promises.rename(this.temporaryPath, finalPath);
      await fs.promises.chmod(finalPath, 0o400);
      await syncDirectory(this.outputRoot);
      overflowArtifact = {
        path: relativePath(this.runDir, finalPath),
        digest,
        bytes: this.bytes,
        truncated: this.truncated,
      };
    } else {
      await fs.promises.rm(this.temporaryPath, { force: true });
    }
    return {
      inline: Buffer.concat(this.inline),
      evidence: {
        bytes: this.bytes,
        digest,
        inlineBytes: this.inlineBytes,
        truncated: this.truncated,
        ...(overflowArtifact ? { overflowArtifact } : {}),
      },
    };
  }
}

function validateRequest(request: HostCommandRequest): void {
  if (
    !/^flow_(?:[a-f0-9]{32}|[0-9a-f-]{36})$/.test(request.runId) ||
    !/^command_[a-f0-9]{32}$/.test(request.executionId) ||
    !Number.isSafeInteger(request.attempt) || request.attempt < 1
  ) throw new Error("Command execution identity is invalid");
  if (!path.isAbsolute(request.runDir) || !path.isAbsolute(request.workspaceRoot) || !path.isAbsolute(request.cwd)) {
    throw new Error("Command execution roots must be absolute");
  }
  const relativeCwd = path.relative(request.workspaceRoot, request.cwd);
  if (relativeCwd === ".." || relativeCwd.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCwd)) {
    throw new Error("Command cwd escapes its workspace");
  }
  if (!request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments)) {
    throw new Error("Command arguments must be an object");
  }
  if (!Number.isSafeInteger(request.maximumOutputBytes) || request.maximumOutputBytes < 1 || request.maximumOutputBytes > DEFINITION_LIMITS.commandStreamBytes) {
    throw new Error("Command output ceiling is invalid");
  }
  if (!Number.isSafeInteger(request.inlineLimitBytes) || request.inlineLimitBytes < 1 || request.inlineLimitBytes > DEFINITION_LIMITS.commandInlineBytes) {
    throw new Error("Command inline output bound is invalid");
  }
  if (request.inlineLimitBytes > request.maximumOutputBytes) throw new Error("Command inline output bound exceeds its hard ceiling");
  if (request.unitKind !== undefined && !["command", "verification", "measurement"].includes(request.unitKind)) {
    throw new Error("Command unit kind is invalid");
  }
  if (
    request.physicalCoreAffinity !== undefined &&
    (!Number.isSafeInteger(request.physicalCoreAffinity) || request.physicalCoreAffinity < 1 || request.physicalCoreAffinity > 4_096)
  ) throw new Error("Command physical-core affinity is invalid");
}

async function createExecutionDirectories(home: string, temporary: string, outputRoot: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(outputRoot), { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(outputRoot, { mode: 0o700 });
  await Promise.all([
    fs.promises.mkdir(home, { recursive: true, mode: 0o700 }),
    fs.promises.mkdir(temporary, { recursive: true, mode: 0o700 }),
  ]);
}

async function assertExecutionDirectories(runDir: string, workspaceRoot: string, cwd: string): Promise<void> {
  for (const [label, directory] of [["run", runDir], ["workspace", workspaceRoot]] as const) {
    const stat = await fs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Command ${label} root must be a real directory`);
  }
  const realWorkspace = await fs.promises.realpath(workspaceRoot);
  if (realWorkspace !== path.resolve(workspaceRoot)) throw new Error("Command workspace root may not traverse symlinks");
  const realCwd = await fs.promises.realpath(cwd);
  const relative = path.relative(realWorkspace, realCwd);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Command cwd resolves outside its workspace");
  }
}

async function assertExecutable(filePath: string): Promise<void> {
  try {
    await fs.promises.access(filePath, fs.constants.X_OK);
  } catch {
    throw new Error(`Required command sandbox executable is unavailable: ${filePath}`);
  }
}

function executableDiagnostic(filePath: string, args: string[]): CommandExecutableDiagnostic {
  const result = spawnSync(filePath, args, { encoding: "utf8", timeout: 2_000, maxBuffer: 8_192 });
  const firstLine = `${result.stdout ?? ""}${result.stderr ?? ""}`.split(/\r?\n/, 1)[0]?.trim();
  return { path: filePath, ...(firstLine ? { version: firstLine.slice(0, 512) } : {}) };
}

function parseMemoryBytes(value: string): number {
  const match = /^(\d+)(K|M|G)$/.exec(value);
  if (!match) throw new Error("Invalid command MemoryMax");
  const multiplier = match[2] === "K" ? 1024 : match[2] === "M" ? 1024 ** 2 : 1024 ** 3;
  const bytes = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(bytes)) throw new Error("Command MemoryMax exceeds exact integer range");
  return bytes;
}

async function settleCommandTimers(
  timeout: NodeJS.Timeout,
  escalation: NodeJS.Timeout | undefined,
  signal: AbortSignal,
  abort: () => void,
): Promise<void> {
  clearTimeout(timeout);
  if (escalation) clearTimeout(escalation);
  signal.removeEventListener("abort", abort);
}

async function cleanupScratch(scratchRoot: string, outputRoot: string): Promise<void> {
  await Promise.all([
    fs.promises.rm(scratchRoot, { recursive: true, force: true }).catch(() => undefined),
    fs.promises.rm(outputRoot, { recursive: true, force: true }).catch(() => undefined),
  ]);
}

async function removeEmptyDirectory(directory: string): Promise<void> {
  try {
    if ((await fs.promises.readdir(directory)).length === 0) await fs.promises.rmdir(directory);
  } catch (error: any) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function relativePath(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Command overflow artifact escapes the run directory");
  }
  return relative.split(path.sep).join("/");
}
