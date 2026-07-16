import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { readCgroupMetrics, type CgroupMetrics } from "./cgroup-metrics.js";
import {
  WORKFLOW_UNIT_KINDS,
  unitPropertyAssignments,
  type UnitResourcePolicy,
  type WorkflowUnitKind,
} from "./unit-properties.js";

const UNIT_PREFIX = "pi-workflow";
const UNIT_PATTERN = /^pi-workflow-(coordinator|agent|command|verification|measurement)-([a-f0-9]{32})\.service$/;
const ID_PREFIX: Readonly<Record<WorkflowUnitKind, string>> = Object.freeze({
  coordinator: "flow_",
  agent: "agent_",
  command: "command_",
  verification: "verification_",
  measurement: "measurement_",
});

export interface WorkflowUnitIdentity {
  kind: WorkflowUnitKind;
  id: string;
}

export interface WorkflowUnitState {
  unit: string;
  description?: string;
  loadState: string;
  activeState: string;
  subState: string;
  result: string;
  mainPid?: number;
  controlGroup?: string;
  execMainCode?: number;
  execMainStatus?: number;
}

export type WorkflowUnitOutcome =
  | "success"
  | "exit-code"
  | "signal"
  | "timeout"
  | "oom"
  | "tasks-max"
  | "cancelled"
  | "infrastructure-failure";

export interface WorkflowUnitCompletion {
  unit: string;
  outcome: WorkflowUnitOutcome;
  exitCode: number | null;
  signal?: NodeJS.Signals;
  helperExitCode: number | null;
  state: WorkflowUnitState;
  metrics?: CgroupMetrics;
  startedAt: string;
  endedAt: string;
}

export interface WorkflowUnitLaunchRequest extends WorkflowUnitIdentity {
  argv: readonly string[];
  workingDirectory?: string;
  environment?: Readonly<Record<string, string>>;
  pipe?: boolean;
  resourcePolicy?: UnitResourcePolicy;
  cpuAffinity?: readonly number[];
  /** Attach protocol/output readers before a short-lived service can exit. */
  onSpawn?: (handle: WorkflowUnitHandle) => void | Promise<void>;
}

export interface UnitCleanupResult {
  unit: string;
  metrics?: CgroupMetrics;
  termSent: boolean;
  killSent: boolean;
  collected: boolean;
}

export interface StaleUnitReconciliation extends UnitCleanupResult {
  priorState: WorkflowUnitState;
}

export interface SystemdUserUnitLauncherOptions {
  systemdRunPath?: string;
  systemctlPath?: string;
  cgroupRoot?: string;
  launchTimeoutMs?: number;
  pollIntervalMs?: number;
}

/** The systemd-run helper failed before this caller could prove unit ownership. */
export class WorkflowUnitClaimError extends Error {
  constructor(readonly unit: string, message = `Could not claim workflow unit ${unit}`) {
    super(message);
    this.name = "WorkflowUnitClaimError";
  }
}

/**
 * The one Linux process-lifetime primitive used by workflow services. Payloads
 * are services, never scopes: the user manager owns them after launch.
 */
export class SystemdUserUnitLauncher {
  readonly systemdRunPath: string;
  readonly systemctlPath: string;
  readonly cgroupRoot: string;
  private readonly launchTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private preflightPromise?: Promise<void>;
  private managerControlGroup?: string;

  constructor(options: SystemdUserUnitLauncherOptions = {}) {
    this.systemdRunPath = options.systemdRunPath ?? "/usr/bin/systemd-run";
    this.systemctlPath = options.systemctlPath ?? "/usr/bin/systemctl";
    this.cgroupRoot = options.cgroupRoot ?? "/sys/fs/cgroup";
    this.launchTimeoutMs = boundedInteger(options.launchTimeoutMs ?? 5_000, "systemd launch timeout", 100, 30_000);
    this.pollIntervalMs = boundedInteger(options.pollIntervalMs ?? 20, "systemd poll interval", 5, 1_000);
  }

  preflight(): Promise<void> {
    this.preflightPromise ??= this.runPreflight();
    return this.preflightPromise;
  }

  async launch(request: WorkflowUnitLaunchRequest): Promise<WorkflowUnitHandle> {
    validateLaunchRequest(request);
    await this.preflight();
    const unit = workflowUnitName(request.kind, request.id);
    const existing = await this.inspect(unit);
    if (existing.loadState !== "not-found") throw new Error(`Workflow unit already exists: ${unit}`);
    const description = `pi-workflow-launch-${crypto.randomUUID()}`;

    const args = [
      "--user",
      "--quiet",
      "--wait",
      "--service-type=exec",
      "--expand-environment=no",
      "--slice=app.slice",
      `--unit=${unit}`,
      `--description=${description}`,
      ...unitPropertyAssignments(request.kind, {
        ...(request.resourcePolicy ? { policy: request.resourcePolicy } : {}),
        ...(request.cpuAffinity ? { cpuAffinity: request.cpuAffinity } : {}),
      }).map((property) => `--property=${property}`),
      ...(request.workingDirectory ? [`--working-directory=${request.workingDirectory}`] : []),
      ...environmentArguments(request.environment),
      ...(request.pipe ? ["--pipe"] : []),
      "--",
      ...request.argv,
    ];
    if (!this.managerControlGroup) throw new Error("User service manager cgroup preflight was not retained");
    const child = spawn(this.systemdRunPath, args, {
      cwd: "/",
      stdio: request.pipe ? ["ignore", "pipe", "pipe"] : ["ignore", "ignore", "ignore"],
      env: serviceManagerEnvironment(),
    });
    if (!request.pipe) child.unref();
    const expectedControlGroup = `${this.managerControlGroup}/app.slice/${unit}`;
    const handle = new WorkflowUnitHandle(
      this,
      request.kind,
      unit,
      child,
      new Date().toISOString(),
      expectedControlGroup,
      description,
    );
    try {
      await request.onSpawn?.(handle);
      await handle.waitUntilStarted(this.launchTimeoutMs, this.pollIntervalMs);
    } catch (error) {
      // A same-name launch race may belong to another process. Never stop a
      // unit when our systemd-run helper failed before proving ownership.
      if (!(error instanceof WorkflowUnitClaimError)) await handle.stop().catch(() => undefined);
      throw error;
    }
    return handle;
  }

  async inspect(unit: string): Promise<WorkflowUnitState> {
    assertWorkflowUnitName(unit);
    const result = await this.systemctl([
      "show",
      unit,
      "--property=Description,LoadState,ActiveState,SubState,Result,MainPID,ControlGroup,ExecMainCode,ExecMainStatus",
      "--no-pager",
    ], 2_000, true);
    if (result.code !== 0) return missingState(unit);
    const values = parseProperties(result.stdout);
    const loadState = values.LoadState || "not-found";
    return {
      unit,
      ...(values.Description ? { description: values.Description } : {}),
      loadState,
      activeState: values.ActiveState || "inactive",
      subState: values.SubState || "dead",
      result: values.Result || "success",
      ...positiveProperty(values.MainPID),
      ...(values.ControlGroup?.startsWith("/") ? { controlGroup: values.ControlGroup } : {}),
      ...integerProperty(values.ExecMainCode, "execMainCode"),
      ...integerProperty(values.ExecMainStatus, "execMainStatus"),
    };
  }

  async metrics(unit: string): Promise<CgroupMetrics | undefined> {
    const state = await this.inspect(unit);
    return await this.metricsForState(state);
  }

  async stop(unit: string, graceMs?: number): Promise<UnitCleanupResult> {
    assertWorkflowUnitName(unit);
    const timeout = graceMs === undefined
      ? unitTimeoutStopMs(parseWorkflowUnitName(unit).kind)
      : boundedInteger(graceMs, "systemd stop grace", 1, 30_000);
    const before = await this.inspect(unit);
    let metrics = await this.metricsForState(before);
    if (before.loadState === "not-found") {
      return { unit, ...(metrics ? { metrics } : {}), termSent: false, killSent: false, collected: true };
    }

    let termSent = false;
    let killSent = false;
    if (isActive(before)) {
      termSent = (await this.systemctl([
        "kill", "--kill-whom=all", "--signal=SIGTERM", unit,
      ], 5_000, true)).code === 0;
      const settled = await this.waitInactive(unit, timeout, (sample) => { metrics = newerMetrics(metrics, sample); });
      if (!settled) {
        killSent = (await this.systemctl([
          "kill", "--kill-whom=all", "--signal=SIGKILL", unit,
        ], 5_000, true)).code === 0;
        await this.systemctl(["stop", unit], 5_000, true);
        await this.waitInactive(unit, Math.max(250, timeout), (sample) => { metrics = newerMetrics(metrics, sample); });
      }
    }
    const cleanup = await this.collectInactive(unit, metrics);
    return { unit, ...(cleanup.metrics ? { metrics: cleanup.metrics } : {}), termSent, killSent, collected: cleanup.collected };
  }

  async collect(unit: string): Promise<UnitCleanupResult> {
    assertWorkflowUnitName(unit);
    const state = await this.inspect(unit);
    let metrics = await this.metricsForState(state);
    if (isActive(state)) return await this.stop(unit);
    const cleanup = await this.collectInactive(unit, metrics);
    metrics = newerMetrics(metrics, cleanup.metrics);
    return {
      unit,
      ...(metrics ? { metrics } : {}),
      termSent: false,
      killSent: false,
      collected: cleanup.collected,
    };
  }

  async list(): Promise<WorkflowUnitState[]> {
    await this.preflight();
    const result = await this.systemctl([
      "list-units",
      "--all",
      "--type=service",
      "--plain",
      "--no-legend",
      "--no-pager",
      `${UNIT_PREFIX}-*.service`,
    ], 5_000);
    const units = result.stdout.split("\n")
      .map((line) => line.trim().split(/\s+/, 1)[0] ?? "")
      .filter(isWorkflowUnitName)
      .sort();
    return await Promise.all(units.map((unit) => this.inspect(unit)));
  }

  async reconcileStale(expectedUnits: Iterable<string>): Promise<StaleUnitReconciliation[]> {
    const expected = new Set<string>();
    for (const unit of expectedUnits) {
      assertWorkflowUnitName(unit);
      expected.add(unit);
    }
    const stale = (await this.list()).filter((state) => !expected.has(state.unit));
    const reconciled: StaleUnitReconciliation[] = [];
    for (const priorState of stale) {
      const cleanup = await this.stop(priorState.unit);
      reconciled.push({ ...cleanup, priorState });
    }
    return reconciled;
  }

  async metricsForState(state: WorkflowUnitState): Promise<CgroupMetrics | undefined> {
    if (!state.controlGroup) return undefined;
    try {
      return await readCgroupMetrics(state.controlGroup, this.cgroupRoot);
    } catch (error: any) {
      const code = error?.code ?? error?.cause?.code;
      if (code === "ENOENT" || code === "ENODEV") return undefined;
      throw error;
    }
  }

  async systemctl(
    args: readonly string[],
    timeoutMs: number,
    allowFailure = false,
  ): Promise<ProcessResult> {
    const result = await spawnResult(this.systemctlPath, ["--user", ...args], timeoutMs);
    if (!allowFailure && result.code !== 0) {
      throw new Error(result.stderr.trim() || `systemctl ${args[0]} failed`);
    }
    return result;
  }

  private async runPreflight(): Promise<void> {
    await Promise.all([
      assertExecutable(this.systemdRunPath),
      assertExecutable(this.systemctlPath),
      fs.promises.access(path.join(this.cgroupRoot, "cgroup.controllers"), fs.constants.R_OK),
    ]);
    const stat = await fs.promises.statfs(this.cgroupRoot);
    if (stat.type !== 0x6367_7270) throw new Error(`${this.cgroupRoot} is not a cgroup v2 filesystem`);
    const manager = await this.systemctl(["show-environment"], 5_000, true);
    if (manager.code !== 0) {
      throw new Error(`User service manager is unavailable${manager.stderr.trim() ? `: ${manager.stderr.trim()}` : ""}`);
    }
    const controlGroup = await this.systemctl(["show", "--property=ControlGroup", "--value"], 5_000);
    this.managerControlGroup = controlGroup.stdout.trim();
    if (!this.managerControlGroup.startsWith("/")) throw new Error("User service manager has no cgroup v2 path");
  }

  private async waitInactive(
    unit: string,
    timeoutMs: number,
    onMetrics: (metrics: CgroupMetrics) => void,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.inspect(unit);
      const metrics = await this.metricsForState(state);
      if (metrics) onMetrics(metrics);
      if (!isActive(state)) return true;
      await delay(this.pollIntervalMs);
    }
    return !isActive(await this.inspect(unit));
  }

  private async collectInactive(
    unit: string,
    priorMetrics: CgroupMetrics | undefined,
  ): Promise<{ metrics?: CgroupMetrics; collected: boolean }> {
    let state = await this.inspect(unit);
    let metrics = newerMetrics(priorMetrics, await this.metricsForState(state));
    if (state.loadState !== "not-found") {
      await this.systemctl(["stop", unit], 5_000, true);
      state = await this.inspect(unit);
      metrics = newerMetrics(metrics, await this.metricsForState(state));
      await this.systemctl(["reset-failed", unit], 5_000, true);
    }
    for (let attempt = 0; attempt < 40; attempt++) {
      state = await this.inspect(unit);
      if (state.loadState === "not-found") return { ...(metrics ? { metrics } : {}), collected: true };
      await delay(this.pollIntervalMs);
    }
    return { ...(metrics ? { metrics } : {}), collected: false };
  }
}

export class WorkflowUnitHandle {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  private readonly closed: Promise<ProcessResult>;
  private stopped = false;
  private stopRequested = false;
  private latestState: WorkflowUnitState;
  private latestMetrics?: CgroupMetrics;
  private observedMainPid?: number;
  private observedControlGroup?: string;

  constructor(
    private readonly launcher: SystemdUserUnitLauncher,
    readonly kind: WorkflowUnitKind,
    readonly unit: string,
    readonly helper: ChildProcess,
    readonly startedAt: string,
    private readonly expectedControlGroup: string,
    private readonly expectedDescription: string,
  ) {
    this.stdout = helper.stdout;
    this.stderr = helper.stderr;
    this.latestState = missingState(unit);
    this.closed = childResult(helper, false);
    void this.monitor();
  }

  get mainPid(): number | undefined {
    return this.observedMainPid;
  }

  get controlGroup(): string | undefined {
    return this.observedControlGroup ?? this.expectedControlGroup;
  }

  async waitUntilStarted(timeoutMs: number, pollIntervalMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.launcher.inspect(this.unit);
      this.observeState(state);
      const metrics = await this.launcher.metricsForState(state);
      if (metrics) this.latestMetrics = newerMetrics(this.latestMetrics, metrics);
      if (state.loadState !== "not-found" && state.description !== this.expectedDescription) {
        throw new WorkflowUnitClaimError(this.unit, `Another launcher claimed workflow unit ${this.unit}`);
      }
      if (
        state.loadState !== "not-found" &&
        (state.mainPid !== undefined || ["inactive", "failed"].includes(state.activeState))
      ) return;
      const closed = await promiseState(this.closed);
      if (closed.settled) {
        if (closed.value.error || closed.value.code !== 0) throw new WorkflowUnitClaimError(this.unit);
        return;
      }
      await delay(pollIntervalMs);
    }
    await this.launcher.stop(this.unit).catch(() => undefined);
    throw new Error(`Timed out waiting for workflow unit ${this.unit}`);
  }

  async wait(): Promise<WorkflowUnitCompletion> {
    const helper = await this.closed;
    this.stopped = true;
    const state = await this.launcher.inspect(this.unit);
    this.observeState(state);
    const metrics = await this.launcher.metricsForState(state);
    if (metrics) this.latestMetrics = newerMetrics(this.latestMetrics, metrics);
    const exit = serviceExit(state, helper);
    return {
      unit: this.unit,
      outcome: this.stopRequested ? "cancelled" : classifyOutcome(state, helper, this.latestMetrics),
      exitCode: exit.exitCode,
      ...(exit.signal ? { signal: exit.signal } : {}),
      helperExitCode: helper.code,
      state,
      ...(this.latestMetrics ? { metrics: this.latestMetrics } : {}),
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
    };
  }

  async stop(graceMs?: number): Promise<UnitCleanupResult> {
    this.stopRequested = true;
    const cleanup = await this.launcher.stop(this.unit, graceMs);
    this.stopped = true;
    if (cleanup.metrics) this.latestMetrics = newerMetrics(this.latestMetrics, cleanup.metrics);
    return { ...cleanup, ...(this.latestMetrics ? { metrics: this.latestMetrics } : {}) };
  }

  async collect(): Promise<UnitCleanupResult> {
    const cleanup = await this.launcher.collect(this.unit);
    if (cleanup.metrics) this.latestMetrics = newerMetrics(this.latestMetrics, cleanup.metrics);
    return { ...cleanup, ...(this.latestMetrics ? { metrics: this.latestMetrics } : {}) };
  }

  private async monitor(): Promise<void> {
    while (!this.stopped) {
      const closed = await promiseState(this.closed);
      const state = await this.launcher.inspect(this.unit).catch(() => undefined);
      if (state) {
        this.observeState(state);
        const metrics = await this.launcher.metricsForState(state);
        if (metrics) this.latestMetrics = newerMetrics(this.latestMetrics, metrics);
      }
      if (closed.settled) return;
      await delay(25);
    }
  }

  private observeState(state: WorkflowUnitState): void {
    this.observedMainPid ??= state.mainPid;
    this.observedControlGroup ??= state.controlGroup;
    if (state.loadState !== "not-found" || this.latestState.loadState === "not-found") this.latestState = state;
  }
}

export function workflowUnitName(kind: WorkflowUnitKind, id: string): string {
  if (!WORKFLOW_UNIT_KINDS.includes(kind)) throw new Error(`Invalid workflow unit kind ${String(kind)}`);
  const prefix = ID_PREFIX[kind];
  if (!new RegExp(`^${prefix}[a-f0-9]{32}$`).test(id)) {
    throw new Error(`Invalid ${kind} unit identity`);
  }
  return `${UNIT_PREFIX}-${kind}-${id.slice(prefix.length)}.service`;
}

export function parseWorkflowUnitName(unit: string): WorkflowUnitIdentity {
  const match = UNIT_PATTERN.exec(unit);
  if (!match) throw new Error("Unit is not a workflow-owned transient service");
  const kind = match[1] as WorkflowUnitKind;
  return { kind, id: `${ID_PREFIX[kind]}${match[2]}` };
}

export function assertWorkflowUnitName(unit: string): void {
  parseWorkflowUnitName(unit);
}

export function isWorkflowUnitName(unit: string): boolean {
  return UNIT_PATTERN.test(unit);
}

function validateLaunchRequest(request: WorkflowUnitLaunchRequest): void {
  workflowUnitName(request.kind, request.id);
  if (!Array.isArray(request.argv) || request.argv.length < 1 || request.argv.length > 4_096) {
    throw new Error("Systemd launch argv must contain 1–4096 entries");
  }
  for (const [index, argument] of request.argv.entries()) {
    if (typeof argument !== "string" || argument.includes("\0") || Buffer.byteLength(argument) > 1024 * 1024) {
      throw new Error(`Invalid systemd launch argv[${index}]`);
    }
  }
  if (!path.isAbsolute(request.argv[0]!)) throw new Error("Systemd launch executable must be absolute");
  if (request.workingDirectory !== undefined && !path.isAbsolute(request.workingDirectory)) {
    throw new Error("Systemd working directory must be absolute");
  }
  environmentArguments(request.environment);
}

function environmentArguments(environment: Readonly<Record<string, string>> | undefined): string[] {
  if (!environment) return [];
  const entries = Object.entries(environment).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > 128) throw new Error("Systemd launch environment has too many entries");
  return entries.map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 64 * 1024) {
      throw new Error(`Invalid systemd launch environment entry ${key}`);
    }
    return `--setenv=${key}=${value}`;
  });
}

function parseProperties(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}

function positiveProperty(value: string | undefined): { mainPid?: number } {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? { mainPid: parsed } : {};
}

function integerProperty(value: string | undefined, key: "execMainCode" | "execMainStatus"): Partial<WorkflowUnitState> {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? { [key]: parsed } : {};
}

function missingState(unit: string): WorkflowUnitState {
  return { unit, loadState: "not-found", activeState: "inactive", subState: "dead", result: "success" };
}

function isActive(state: WorkflowUnitState): boolean {
  return state.loadState !== "not-found" && ["active", "activating", "deactivating", "reloading"].includes(state.activeState);
}

function serviceExit(
  state: WorkflowUnitState,
  helper: ProcessResult,
): { exitCode: number | null; signal?: NodeJS.Signals } {
  if (state.execMainCode === 1 && state.execMainStatus !== undefined) return { exitCode: state.execMainStatus };
  if ((state.execMainCode === 2 || state.execMainCode === 3) && state.execMainStatus !== undefined) {
    const signal = signalName(state.execMainStatus);
    return { exitCode: null, ...(signal ? { signal } : {}) };
  }
  return { exitCode: helper.code, ...(helper.signal ? { signal: helper.signal } : {}) };
}

function classifyOutcome(
  state: WorkflowUnitState,
  helper: ProcessResult,
  metrics: CgroupMetrics | undefined,
): WorkflowUnitOutcome {
  if (state.result === "oom-kill" || (metrics?.memory.oomKillEvents ?? 0) > 0) return "oom";
  if ((metrics?.pids.limitEvents ?? 0) > 0) return "tasks-max";
  if (["timeout", "watchdog"].includes(state.result)) return "timeout";
  const exit = serviceExit(state, helper);
  if (exit.signal) return "signal";
  if (exit.exitCode === 0 && !helper.error) return "success";
  if (exit.exitCode !== null) return "exit-code";
  return "infrastructure-failure";
}

function signalName(number: number): NodeJS.Signals | undefined {
  return Object.entries(os.constants.signals).find(([, value]) => value === number)?.[0] as NodeJS.Signals | undefined;
}

function unitTimeoutStopMs(kind: WorkflowUnitKind): number {
  return kind === "coordinator" ? 5_000 : kind === "command" ? 1_000 : 2_000;
}

function newerMetrics(left: CgroupMetrics | undefined, right: CgroupMetrics | undefined): CgroupMetrics | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right.sampledAt) >= Date.parse(left.sampledAt) ? right : left;
}

function serviceManagerEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
    ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}),
  };
}

async function assertExecutable(filePath: string): Promise<void> {
  await fs.promises.access(filePath, fs.constants.X_OK);
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function childResult(child: ChildProcess, captureOutput = true): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    if (captureOutput) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-64 * 1024); });
      child.stderr?.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-64 * 1024); });
    }
    let error: Error | undefined;
    child.once("error", (value) => { error = value; });
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr, ...(error ? { error } : {}) }));
  });
}

async function spawnResult(command: string, args: readonly string[], timeoutMs: number): Promise<ProcessResult> {
  const child = spawn(command, args, {
    cwd: "/",
    stdio: ["ignore", "pipe", "pipe"],
    env: serviceManagerEnvironment(),
  });
  const result = childResult(child);
  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  timeout.unref?.();
  try {
    return await result;
  } finally {
    clearTimeout(timeout);
  }
}

async function promiseState<T>(promise: Promise<T>): Promise<{ settled: false } | { settled: true; value: T }> {
  const pending = Symbol("pending");
  const value = await Promise.race([promise, Promise.resolve(pending)]);
  return value === pending ? { settled: false } : { settled: true, value: value as T };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}
