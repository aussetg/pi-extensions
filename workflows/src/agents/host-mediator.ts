import fs from "node:fs";
import path from "node:path";
import {
  SystemdUserUnitLauncher,
  type WorkflowUnitHandle,
} from "../systemd/launcher.js";
import { unitResourcePolicy } from "../systemd/unit-properties.js";
import type { JsonObject, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import type { AgentMediatedToolExecutor, AgentMediatedToolRequest } from "./mediation.js";

export interface AgentWebMediator {
  search(input: { query: string; maxResults: number }): Promise<JsonValue>;
  fetch(input: { url: string; maxBytes: number }): Promise<JsonValue>;
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
    if (request.toolName === "workspace_command") return await this.workspaceCommand(request);
    if (!this.web) throw new Error(`${request.toolName} has no configured host mediator`);
    const payload = request.payload as JsonObject;
    if (request.toolName === "web_search") {
      return await this.web.search({
        query: String(payload.query),
        maxResults: typeof payload.maxResults === "number" ? payload.maxResults : 10,
      });
    }
    return await this.web.fetch({
      url: String(payload.url),
      maxBytes: typeof payload.maxBytes === "number" ? payload.maxBytes : 512 * 1024,
    });
  }

  private async workspaceCommand(request: AgentMediatedToolRequest): Promise<JsonValue> {
    const payload = request.payload as unknown as { argv: string[]; timeoutMs?: number };
    const argv = [...payload.argv];
    const timeoutMs = payload.timeoutMs ?? 60_000;
    await Promise.all([
      fs.promises.access(this.bwrapPath, fs.constants.X_OK),
      this.launcher.preflight(),
    ]);
    const relativeCwd = path.relative(request.workspace.root, request.workspace.cwd);
    const cwd = relativeCwd && relativeCwd !== "." ? `/workspace/${relativeCwd.split(path.sep).join("/")}` : "/workspace";
    const id = `command_${stableHash({
      executionId: request.executionId,
      toolCallId: request.toolCallId,
    }).slice(7, 39)}`;
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
    let stopped: "timeout" | "output" | undefined;
    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const used = stdout.length + stderr.length;
      const remaining = Math.max(0, this.maximumCommandOutputBytes - used);
      const retained = chunk.subarray(0, remaining);
      if (stream === "stdout") stdout = Buffer.concat([stdout, retained]);
      else stderr = Buffer.concat([stderr, retained]);
      if (retained.length !== chunk.length) {
        truncated = true;
        stopped ??= "output";
        void service.stop(1_000);
      }
    };
    service = await this.launcher.launch({
      kind: "command",
      id,
      argv: bwrap,
      workingDirectory: "/",
      pipe: true,
      resourcePolicy: { ...unitResourcePolicy("command"), timeoutStopMs: 1_000 },
      onSpawn: (handle) => {
        service = handle;
        handle.stdout!.on("data", (chunk: Buffer) => append("stdout", Buffer.from(chunk)));
        handle.stderr!.on("data", (chunk: Buffer) => append("stderr", Buffer.from(chunk)));
      },
    });
    const timer = setTimeout(() => {
      stopped ??= "timeout";
      void service.stop(1_000);
    }, timeoutMs);
    timer.unref?.();
    const completion = await service.wait();
    clearTimeout(timer);
    const cleanup = await service.collect();
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
