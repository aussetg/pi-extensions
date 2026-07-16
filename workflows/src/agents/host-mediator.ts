import fs from "node:fs";
import path from "node:path";
import { resolveCommandExecutionLimits } from "../commands/run-safety.js";
import {
  SystemdUserUnitLauncher,
  workflowUnitName,
  type WorkflowUnitHandle,
} from "../systemd/launcher.js";
import { unitResourcePolicy } from "../systemd/unit-properties.js";
import type { JsonObject, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import type {
  AgentMediatedToolCancellation,
  AgentMediatedToolExecutor,
  AgentMediatedToolRequest,
} from "./mediation.js";

export interface AgentWebMediator {
  search(input: { query: string; maxResults: number }, signal: AbortSignal): Promise<JsonValue>;
  fetch(input: { url: string; maxBytes: number }, signal: AbortSignal): Promise<JsonValue>;
}

export interface HostAgentMediatedToolExecutorOptions {
  web?: AgentWebMediator;
  launcher?: SystemdUserUnitLauncher;
  bwrapPath?: string;
  maximumCommandOutputBytes?: number;
}

/** Coordinator-side implementation. Raw argv runs in its own networkless unit. */
export class HostAgentMediatedToolExecutor implements AgentMediatedToolExecutor {
  private readonly web?: AgentWebMediator;
  private readonly launcher: SystemdUserUnitLauncher;
  private readonly bwrapPath: string;
  private readonly maximumCommandOutputBytes: number;

  constructor(options: HostAgentMediatedToolExecutorOptions = {}) {
    this.web = options.web;
    this.launcher = options.launcher ?? new SystemdUserUnitLauncher();
    this.bwrapPath = path.resolve(options.bwrapPath ?? "/usr/bin/bwrap");
    this.maximumCommandOutputBytes = options.maximumCommandOutputBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.maximumCommandOutputBytes)
      || this.maximumCommandOutputBytes < 1_024
      || this.maximumCommandOutputBytes > 8 * 1024 * 1024) {
      throw new TypeError("Mediated command output limit is invalid");
    }
  }

  async execute(request: AgentMediatedToolRequest): Promise<JsonValue> {
    request.signal.throwIfAborted();
    if (request.toolName === "workspace_command") return await this.workspaceCommand(request);
    if (!this.web) throw new Error(`${request.toolName} has no configured host mediator`);
    const payload = request.payload as JsonObject;
    if (request.toolName === "web_search") {
      return await this.web.search({
        query: String(payload.query),
        maxResults: typeof payload.maxResults === "number" ? payload.maxResults : 10,
      }, request.signal);
    }
    return await this.web.fetch({
      url: String(payload.url),
      maxBytes: typeof payload.maxBytes === "number" ? payload.maxBytes : 512 * 1024,
    }, request.signal);
  }

  async cancel(request: AgentMediatedToolCancellation): Promise<void> {
    if (request.toolName !== "workspace_command") return;
    const grace = unitResourcePolicy("command", request.safety).timeoutStopMs;
    await this.launcher.stop(workflowUnitName("command", workspaceCommandId(request)), grace);
  }

  private async workspaceCommand(request: AgentMediatedToolRequest): Promise<JsonValue> {
    const payload = request.payload as unknown as { argv: string[]; timeoutMs?: number };
    const argv = [...payload.argv];
    const limits = resolveCommandExecutionLimits(
      "command",
      request.safety,
      payload.timeoutMs ?? 60_000,
      this.maximumCommandOutputBytes,
    );
    await Promise.all([
      fs.promises.access(this.bwrapPath, fs.constants.X_OK),
      this.launcher.preflight(),
    ]);
    request.signal.throwIfAborted();
    const relativeCwd = path.relative(request.workspace.root, request.workspace.cwd);
    const cwd = relativeCwd && relativeCwd !== "." ? `/workspace/${relativeCwd.split(path.sep).join("/")}` : "/workspace";
    const id = workspaceCommandId(request);
    const bwrap = [
      this.bwrapPath,
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
      "--bind", request.workspace.root, "/workspace",
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/tmp",
      "--chdir", cwd,
      "--clearenv",
      "--setenv", "HOME", "/tmp",
      "--setenv", "PATH", "/usr/local/sbin:/usr/local/bin:/usr/bin:/bin",
      "--setenv", "LANG", "C.UTF-8",
      "--setenv", "LC_ALL", "C.UTF-8",
      "--",
      ...argv,
    ];
    let service!: WorkflowUnitHandle;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let stopped: "timeout" | "output" | "cancel" | undefined;
    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const used = stdout.length + stderr.length;
      const remaining = Math.max(0, limits.outputBytes - used);
      const retained = chunk.subarray(0, remaining);
      if (stream === "stdout") stdout = Buffer.concat([stdout, retained]);
      else stderr = Buffer.concat([stderr, retained]);
      if (retained.length !== chunk.length) {
        truncated = true;
        stopped ??= "output";
        void service.stop(limits.resourcePolicy.timeoutStopMs);
      }
    };
    service = await this.launcher.launch({
      kind: "command",
      id,
      argv: bwrap,
      workingDirectory: "/",
      pipe: true,
      resourcePolicy: limits.resourcePolicy,
      onSpawn: (handle) => {
        service = handle;
        handle.stdout!.on("data", (chunk: Buffer) => append("stdout", Buffer.from(chunk)));
        handle.stderr!.on("data", (chunk: Buffer) => append("stderr", Buffer.from(chunk)));
      },
    });
    const abort = () => {
      stopped ??= "cancel";
      void service.stop(limits.resourcePolicy.timeoutStopMs);
    };
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const timer = setTimeout(() => {
      stopped ??= "timeout";
      void service.stop(limits.resourcePolicy.timeoutStopMs);
    }, limits.timeoutMs);
    timer.unref?.();
    let completion: Awaited<ReturnType<WorkflowUnitHandle["wait"]>>;
    let cleanup: Awaited<ReturnType<WorkflowUnitHandle["collect"]>>;
    try {
      completion = await service.wait();
      cleanup = await service.collect();
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
    }
    if (stopped === "cancel") request.signal.throwIfAborted();
    return {
      ok: stopped === undefined && completion.outcome === "success",
      exitCode: completion.exitCode,
      ...(completion.signal ? { signal: completion.signal } : {}),
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      truncated,
      timedOut: stopped === "timeout",
      network: "unshared",
      unit: completion.unit,
      unitCleaned: cleanup.collected,
    } as unknown as JsonValue;
  }
}

function workspaceCommandId(request: Pick<AgentMediatedToolRequest, "executionId" | "toolCallId">): string {
  return `command_${stableHash({
    executionId: request.executionId,
    toolCallId: request.toolCallId,
  }).slice(7, 39)}`;
}
