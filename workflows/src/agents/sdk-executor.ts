import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { zeroUsage } from "../runtime/durable-types.js";
import {
  SystemdUserUnitLauncher,
  workflowUnitName,
  type WorkflowUnitHandle,
} from "../systemd/launcher.js";
import { unitResourcePolicy } from "../systemd/unit-properties.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import type {
  AgentCancellationReason,
  AgentEventSink,
  AgentExecutionHandle,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentExecutor,
  AgentExecutorDescriptor,
  AgentToolDescriptor,
} from "./executor.js";
import { sdkSemanticToolDescriptors } from "./sdk-semantic-tools.js";
import { agentWorkerEntryPath, type SdkAgentWorkerConfig } from "./sdk-worker.js";
import {
  AgentSessionSupervisor,
  type AgentSupervisionStore,
  type AgentWorkerCycleExecutor,
} from "./supervisor.js";

const MAX_WORKER_RESULT_BYTES = 1024 * 1024;
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface SdkAgentWorkerExecutorOptions {
  nodePath?: string;
  entryPath?: string;
  agentDir?: string;
  bwrapPath?: string;
  launcher?: SystemdUserUnitLauncher;
  maximumInfrastructureFailures?: number;
  backoffMs?: readonly number[];
  supervisionStore?: (request: AgentExecutionRequest) => AgentSupervisionStore;
  /** Focused tests can replace only the physical-cycle boundary. */
  cycleExecutor?: AgentWorkerCycleExecutor;
}

/** The production executor is one supervised logical Pi session. */
export class SdkAgentWorkerExecutor implements AgentExecutor {
  private readonly descriptor = sdkWorkerDescriptor();
  private readonly cycleExecutor: AgentWorkerCycleExecutor;
  private readonly maximumInfrastructureFailures?: number;
  private readonly backoffMs?: readonly number[];
  private readonly supervisionStore?: SdkAgentWorkerExecutorOptions["supervisionStore"];

  constructor(options: SdkAgentWorkerExecutorOptions = {}) {
    this.cycleExecutor = options.cycleExecutor ?? new SystemdSandboxedSdkCycleExecutor(options);
    this.maximumInfrastructureFailures = options.maximumInfrastructureFailures;
    this.backoffMs = options.backoffMs;
    this.supervisionStore = options.supervisionStore;
  }

  describe(): AgentExecutorDescriptor { return structuredClone(this.descriptor); }

  async start(request: AgentExecutionRequest, sink: AgentEventSink): Promise<AgentExecutionHandle> {
    validateLogicalRequest(request);
    return new AgentSessionSupervisor({
      cycleExecutor: this.cycleExecutor,
      request,
      sink,
      ...(this.supervisionStore ? { store: this.supervisionStore(request) } : {}),
      ...(this.maximumInfrastructureFailures !== undefined
        ? { maximumInfrastructureFailures: this.maximumInfrastructureFailures }
        : {}),
      ...(this.backoffMs ? { backoffMs: this.backoffMs } : {}),
    });
  }
}

export interface AgentSandboxLaunch {
  config: SdkAgentWorkerConfig;
  configPath: string;
  resultPath: string;
  unitId: string;
  argv: string[];
  workingDirectory: "/";
}

/** Build the exact persistent-mount Bubblewrap boundary without launching it. */
export async function buildAgentSandboxLaunch(
  request: AgentExecutionRequest,
  options: {
    nodePath?: string;
    entryPath?: string;
    agentDir?: string;
    bwrapPath?: string;
  } = {},
): Promise<AgentSandboxLaunch> {
  validateLogicalRequest(request);
  const nodePath = path.resolve(options.nodePath ?? process.execPath);
  const entryPath = path.resolve(options.entryPath ?? agentWorkerEntryPath());
  const bwrapPath = path.resolve(options.bwrapPath ?? "/usr/bin/bwrap");
  const agentDir = path.resolve(options.agentDir ?? process.env.PI_CODING_AGENT_DIR
    ?? path.join(process.env.HOME ?? "/", ".pi", "agent"));
  const runDir = runDirectory(request);
  const sessionRoot = path.join(runDir, "sessions", request.executionId);
  const outputRoot = path.join(runDir, "outputs", request.executionId);
  const inputRoot = path.resolve(request.inputs.root);
  await Promise.all([
    realDirectory(runDir, "run"),
    realDirectory(request.workspace.root, "workspace"),
    ensureRealDirectory(sessionRoot),
    ensureRealDirectory(outputRoot),
    ensureRealDirectory(inputRoot),
    fs.promises.access(nodePath, fs.constants.X_OK),
    fs.promises.access(entryPath, fs.constants.R_OK),
    fs.promises.access(bwrapPath, fs.constants.X_OK),
  ]);

  const relativeCwd = containedRelative(request.workspace.root, request.workspace.cwd, "workspace cwd");
  const sandboxCwd = relativeCwd ? `/workspace/${portable(relativeCwd)}` : "/workspace";
  const sandboxRunDir = `/run/pi-workflows/${request.runId}`;
  const sandboxSessionRoot = `${sandboxRunDir}/sessions/${request.executionId}`;
  const sandboxResultPath = `${sandboxSessionRoot}/worker-result.json`;
  const sandboxEntryPath = entryPath.startsWith(`${PACKAGE_ROOT}${path.sep}`)
    ? `/app/${portable(path.relative(PACKAGE_ROOT, entryPath))}`
    : `/entry/${path.basename(entryPath)}`;
  const configPath = path.join(sessionRoot, "worker-config.json");
  const resultPath = path.join(sessionRoot, "worker-result.json");
  const sandboxRequest = mapRequestIntoSandbox(request, sandboxRunDir, sandboxCwd, inputRoot);
  const config: SdkAgentWorkerConfig = {
    runDir: sandboxRunDir,
    agentDir: "/agent",
    resultPath: sandboxResultPath,
    request: sandboxRequest,
  };
  const home = path.join(sessionRoot, "home");
  await ensureRealDirectory(home);
  const providerEnvironment = operationalProviderEnvironment();

  const argv = [
    bwrapPath,
    "--new-session",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
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
    "--bind", home, "/home/workflow",
    "--dir", "/agent",
    "--bind-try", path.join(agentDir, "auth.json"), "/agent/auth.json",
    "--ro-bind-try", path.join(agentDir, "models.json"), "/agent/models.json",
    "--dir", "/run",
    "--dir", "/run/pi-workflows",
    "--dir", sandboxRunDir,
    "--dir", `${sandboxRunDir}/sessions`,
    "--bind", sessionRoot, sandboxSessionRoot,
    "--dir", `${sandboxRunDir}/outputs`,
    "--dir", `${sandboxRunDir}/outputs/${request.executionId}`,
    "--ro-bind", request.protocol.socketPath, `${sandboxRunDir}/agent-protocol.sock`,
    request.workspace.mode === "candidate" ? "--bind" : "--ro-bind",
    request.workspace.root, "/workspace",
    "--ro-bind", inputRoot, "/inputs",
    "--bind", outputRoot, "/outputs",
    "--ro-bind", PACKAGE_ROOT, "/app",
    ...(sandboxEntryPath.startsWith("/entry/")
      ? ["--dir", "/entry", "--ro-bind", entryPath, sandboxEntryPath]
      : []),
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--chdir", sandboxCwd,
    "--clearenv",
    "--setenv", "HOME", "/home/workflow",
    "--setenv", "PATH", "/usr/local/sbin:/usr/local/bin:/usr/bin:/bin",
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "LC_ALL", "C.UTF-8",
    "--setenv", "PI_CODING_AGENT_DIR", "/agent",
    "--setenv", "NODE_NO_WARNINGS", "1",
    ...Object.entries(providerEnvironment).flatMap(([name, value]) => ["--setenv", name, value]),
    "--",
    nodePath,
    "--experimental-transform-types",
    sandboxEntryPath,
    "--config",
    `${sandboxSessionRoot}/worker-config.json`,
  ];
  if (argv.includes("--unshare-net")) throw new Error("The SDK worker must retain provider network for mediated tools");
  return {
    config,
    configPath,
    resultPath,
    unitId: agentUnitIdentity(request.runId, request.executionId),
    argv,
    workingDirectory: "/",
  };
}

export class SystemdSandboxedSdkCycleExecutor implements AgentWorkerCycleExecutor {
  private readonly launcher: SystemdUserUnitLauncher;
  private readonly paths: Pick<SdkAgentWorkerExecutorOptions, "nodePath" | "entryPath" | "agentDir" | "bwrapPath">;

  constructor(options: SdkAgentWorkerExecutorOptions = {}) {
    this.launcher = options.launcher ?? new SystemdUserUnitLauncher();
    this.paths = {
      nodePath: options.nodePath,
      entryPath: options.entryPath,
      agentDir: options.agentDir,
      bwrapPath: options.bwrapPath,
    };
  }

  async start(request: AgentExecutionRequest, _sink: AgentEventSink): Promise<AgentExecutionHandle> {
    const launch = await buildAgentSandboxLaunch(request, this.paths);
    await this.launcher.preflight();
    const unit = workflowUnitName("agent", launch.unitId);
    const state = await this.launcher.inspect(unit);
    if (active(state.activeState)) {
      return new ExistingSystemdCycle(this.launcher, unit, request, launch.resultPath);
    }
    if (state.loadState !== "not-found") await this.launcher.collect(unit);
    if (await exists(launch.resultPath)) {
      return new SettledCycle(request, launch.resultPath);
    }
    await writeConfig(launch.configPath, launch.config);
    await fs.promises.rm(launch.resultPath, { force: true });
    const service = await this.launcher.launch({
      kind: "agent",
      id: launch.unitId,
      argv: launch.argv,
      workingDirectory: launch.workingDirectory,
      resourcePolicy: unitResourcePolicy("agent", request.safety),
    });
    return new LaunchedSystemdCycle(service, request, launch.resultPath);
  }
}

abstract class SystemdCycle implements AgentExecutionHandle {
  protected cancelled = false;
  protected settled?: AgentExecutionResult;

  constructor(
    protected readonly request: AgentExecutionRequest,
    protected readonly resultPath: string,
  ) {}

  abstract wait(): Promise<AgentExecutionResult>;
  abstract cancel(reason: AgentCancellationReason): Promise<void>;

  async dispose(): Promise<void> {
    await fs.promises.rm(this.resultPath, { force: true }).catch(() => undefined);
  }

  protected async resultOrFailure(summary: string): Promise<AgentExecutionResult> {
    if (this.settled) return this.settled;
    const reported = await readWorkerResult(this.resultPath);
    this.settled = reconcileWorkerResult(this.request, reported, this.cancelled, summary);
    return this.settled;
  }
}

class LaunchedSystemdCycle extends SystemdCycle {
  constructor(
    private readonly service: WorkflowUnitHandle,
    request: AgentExecutionRequest,
    resultPath: string,
  ) { super(request, resultPath); }

  async wait(): Promise<AgentExecutionResult> {
    if (this.settled) return this.settled;
    const completion = await this.service.wait();
    const result = await this.resultOrFailure(`SDK worker unit ended with ${completion.outcome}`);
    await this.service.collect().catch(() => undefined);
    return result;
  }

  async cancel(_reason: AgentCancellationReason): Promise<void> {
    if (this.settled || this.cancelled) return;
    this.cancelled = true;
    await this.service.stop(1_000).catch(() => undefined);
  }
}

class ExistingSystemdCycle extends SystemdCycle {
  constructor(
    private readonly launcher: SystemdUserUnitLauncher,
    private readonly unit: string,
    request: AgentExecutionRequest,
    resultPath: string,
  ) { super(request, resultPath); }

  async wait(): Promise<AgentExecutionResult> {
    while (active((await this.launcher.inspect(this.unit)).activeState)) await delay(50);
    const result = await this.resultOrFailure("Recovered SDK worker unit emitted no result receipt");
    await this.launcher.collect(this.unit).catch(() => undefined);
    return result;
  }

  async cancel(_reason: AgentCancellationReason): Promise<void> {
    if (this.settled || this.cancelled) return;
    this.cancelled = true;
    await this.launcher.stop(this.unit, 1_000).catch(() => undefined);
  }
}

class SettledCycle extends SystemdCycle {
  wait(): Promise<AgentExecutionResult> {
    return this.resultOrFailure("Persisted SDK worker result is invalid");
  }
  async cancel(_reason: AgentCancellationReason): Promise<void> { this.cancelled = true; }
}

function sdkWorkerDescriptor(): AgentExecutorDescriptor {
  const builtins = [
    createReadTool("/workspace"),
    createGrepTool("/workspace"),
    createFindTool("/workspace"),
    createLsTool("/workspace"),
    createEditTool("/workspace"),
    createWriteTool("/workspace"),
  ];
  const mutating = new Set(["edit", "write"]);
  const toolCatalog: AgentToolDescriptor[] = [
    ...builtins.map((tool) => ({
      name: tool.name,
      schemaHash: stableHash(tool.parameters).slice(7),
      mutatesWorkspace: mutating.has(tool.name),
      usesMediatedNetwork: false,
    })),
    ...sdkSemanticToolDescriptors(),
  ];
  return {
    id: "pi-sdk-worker",
    capabilities: {
      persistentSessions: true,
      candidateWorkspace: true,
      mediatedNetwork: true,
      liveProgress: true,
      artifactPublication: true,
    },
    toolCatalog,
  };
}

function mapRequestIntoSandbox(
  request: AgentExecutionRequest,
  sandboxRunDir: string,
  sandboxCwd: string,
  inputRoot: string,
): AgentExecutionRequest {
  const inputs = request.inputs.entries.map((entry) => ({
    ...entry,
    path: `/inputs/${portable(containedRelative(inputRoot, entry.path, `input ${entry.id}`))}`,
  }));
  return {
    ...request,
    workspace: {
      ...request.workspace,
      root: "/workspace",
      cwd: sandboxCwd,
    },
    inputs: { ...request.inputs, root: "/inputs", entries: inputs },
    protocol: { ...request.protocol, socketPath: `${sandboxRunDir}/agent-protocol.sock` },
  } as AgentExecutionRequest;
}

function validateLogicalRequest(request: AgentExecutionRequest): void {
  if (!request || typeof request !== "object") throw new TypeError("SDK worker request is missing");
  const socketPath = path.resolve(request.protocol.socketPath);
  if (path.basename(socketPath) !== "agent-protocol.sock") throw new Error("SDK worker protocol socket is not canonical");
  const runDir = path.dirname(socketPath);
  if (path.basename(runDir) !== request.runId || !/^flow_[a-f0-9]{32}$/.test(request.runId)) {
    throw new Error("SDK worker request and run directory differ");
  }
  const expectedSession = `sessions/${request.executionId}/session.jsonl`;
  if (request.session.piSessionPath !== expectedSession) throw new Error(`Pi session path must be ${expectedSession}`);
  if (request.workspace.mode === "read-only" && request.tools.some((tool) => tool.mutatesWorkspace)) {
    throw new Error("Read-only SDK agent received a mutating tool");
  }
  if (request.network === "none" && request.tools.some((tool) => tool.usesMediatedNetwork)) {
    throw new Error("Networkless SDK agent received a mediated network tool");
  }
}

function runDirectory(request: AgentExecutionRequest): string {
  return path.dirname(path.resolve(request.protocol.socketPath));
}

function agentUnitIdentity(runId: string, executionId: string): string {
  if (/^agent_[a-f0-9]{32}$/.test(executionId)) return executionId;
  return `agent_${stableHash({ runId, executionId }).slice(7, 39)}`;
}

export function agentWorkerUnitName(runId: string, executionId: string): string {
  return workflowUnitName("agent", agentUnitIdentity(runId, executionId));
}

async function writeConfig(filePath: string, config: SdkAgentWorkerConfig): Promise<void> {
  const temporary = `${filePath}.tmp-${process.pid}`;
  await fs.promises.rm(temporary, { force: true });
  const handle = await fs.promises.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(stableJson(config), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(temporary, filePath);
  const directory = await fs.promises.open(path.dirname(filePath), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function readWorkerResult(resultPath: string): Promise<AgentExecutionResult | undefined> {
  try {
    const stat = await fs.promises.lstat(resultPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_WORKER_RESULT_BYTES) return undefined;
    const source = await fs.promises.readFile(resultPath, "utf8");
    const lines = source.trim().split("\n");
    if (lines.length !== 1) return undefined;
    return parseWorkerResult(JSON.parse(lines[0]!));
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    return undefined;
  }
}

function parseWorkerResult(value: unknown): AgentExecutionResult {
  if (!value || typeof value !== "object"
    || !["finished", "yielded", "failed", "paused", "stopped"].includes((value as any).outcome)) {
    throw new Error("SDK worker result is malformed");
  }
  return value as AgentExecutionResult;
}

function reconcileWorkerResult(
  request: AgentExecutionRequest,
  reported: AgentExecutionResult | undefined,
  cancelled: boolean,
  summary: string,
): AgentExecutionResult {
  if (reported?.outcome === "finished") return reported;
  if (reported) return reported;
  if (cancelled) return { outcome: "stopped", usage: zeroUsage(false), transcriptComplete: false };
  return failed(request, summary);
}

function failed(request: AgentExecutionRequest, summary: string): AgentExecutionResult {
  return {
    outcome: "failed",
    reason: {
      category: "infrastructure",
      code: "sdk-worker-process-failed",
      summary: Array.from(summary).slice(0, 2_000).join("") || "SDK worker process failed",
      retryable: true,
      operationId: request.operationId,
    },
    usage: zeroUsage(false),
    transcriptComplete: false,
  };
}

async function ensureRealDirectory(directory: string): Promise<void> {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  await realDirectory(directory, "persistent mount");
}

async function realDirectory(directory: string, label: string): Promise<void> {
  const absolute = path.resolve(directory);
  const [stat, real] = await Promise.all([fs.promises.lstat(absolute), fs.promises.realpath(absolute)]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== absolute) throw new Error(`SDK worker ${label} must be a real directory`);
}

/** Exact credential values are process input only and are absent from config, descriptors, and call keys. */
function operationalProviderEnvironment(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "AZURE_OPENAI_API_KEY",
  ]) {
    const value = process.env[name];
    if (value && value.length <= 16_384 && !/[\u0000\r\n]/.test(value)) result[name] = value;
  }
  return result;
}

function containedRelative(rootInput: string, targetInput: string, label: string): string {
  const root = path.resolve(rootInput);
  const target = path.resolve(targetInput);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its root`);
  }
  return relative === "." ? "" : relative;
}

function portable(value: string): string { return value.split(path.sep).join("/"); }
function active(state: string): boolean { return ["active", "activating", "deactivating", "reloading"].includes(state); }
async function exists(filePath: string): Promise<boolean> { try { await fs.promises.access(filePath); return true; } catch { return false; } }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
