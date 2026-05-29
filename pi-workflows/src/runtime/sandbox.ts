import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LIMITS, WORKFLOW_CHILD_CGROUP } from "../constants.js";
import type { SandboxGlobals } from "./sandbox-types.js";
import { WorkflowAbortError } from "./errors.js";

export { type SandboxGlobals } from "./sandbox-types.js";

type ProtocolMessage =
  | { type: "heartbeat" }
  | { type: "request"; id: number; method: string; params?: unknown; critical?: boolean }
  | { type: "done"; result?: unknown }
  | { type: "failed"; error?: string; name?: string; stack?: string };

interface PendingRequest {
  method: string;
  critical: boolean;
  startedAt: number;
}

export async function executeWorkflowSandbox(source: string, globals: SandboxGlobals, signal: AbortSignal): Promise<unknown> {
  const runnerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "child-runner.mjs");
  if (!fs.existsSync(runnerPath)) throw new Error(`Workflow child runner missing: ${runnerPath}`);

  const unitBase = `pi-workflow-${crypto.randomBytes(6).toString("hex")}`;
  const unitName = `${unitBase}.scope`;
  const child = spawnSandboxedRunner(runnerPath, unitBase);
  const pending = new Map<number, PendingRequest>();
  const stderr: string[] = [];
  let stdoutBuffer = "";
  let lastHeartbeat = Date.now();
  let settled = false;

  return await new Promise<unknown>((resolve, reject) => {
    const finish = (err: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      terminateWorkflowChild(child, unitName, err instanceof WorkflowAbortError ? "abort" : "finish");
      if (err) reject(err);
      else resolve(value);
    };

    const heartbeatTimer = setInterval(() => {
      if (settled) return;
      const silenceMs = Date.now() - lastHeartbeat;
      if (silenceMs > DEFAULT_LIMITS.workflowHeartbeatTimeoutMs) {
        finish(new Error(`Workflow child stopped heartbeating for ${silenceMs}ms`));
      }
    }, DEFAULT_LIMITS.workflowHeartbeatMs).unref?.();

    const hardTimer = setTimeout(() => {
      finish(new Error(`Workflow exceeded hard runtime limit (${DEFAULT_LIMITS.workflowHardTimeoutMs}ms)`));
    }, DEFAULT_LIMITS.workflowHardTimeoutMs).unref?.();

    const cleanup = () => {
      clearInterval(heartbeatTimer);
      clearTimeout(hardTimer);
      signal.removeEventListener("abort", abort);
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
    };

    const abort = () => finish(signal.reason instanceof Error ? signal.reason : new WorkflowAbortError("Workflow aborted"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) handleProtocolLine(line, globals, child, pending, () => (lastHeartbeat = Date.now()), finish);
    });

    child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      if (settled) return;
      if (stdoutBuffer.trim()) handleProtocolLine(stdoutBuffer, globals, child, pending, () => (lastHeartbeat = Date.now()), finish);
      if (!settled) {
        const tail = stderr.join("").trim();
        finish(new Error(`Workflow child exited before completion (${code ?? "signal"})${tail ? `: ${tail.slice(0, 4000)}` : ""}`));
      }
    });

    writeMessage(child, {
      type: "start",
      source,
      args: globals.args,
      cwd: globals.cwd,
      budgetTotal: readBudgetTotal(globals.budget),
      pipelineLimit: DEFAULT_LIMITS.pipelineSchedulingLimit,
      heartbeatMs: DEFAULT_LIMITS.workflowHeartbeatMs,
    });
  });
}

function spawnSandboxedRunner(runnerPath: string, unitBase: string): ChildProcessWithoutNullStreams {
  const systemdRun = requireExecutable("/usr/bin/systemd-run", "systemd-run");
  const bwrap = requireExecutable("/usr/bin/bwrap", "bwrap");
  const node = fs.existsSync("/usr/bin/node") ? "/usr/bin/node" : process.execPath;

  const args = [
    "--user",
    "--scope",
    "--quiet",
    `--unit=${unitBase}`,
    `--property=MemoryMax=${WORKFLOW_CHILD_CGROUP.memoryMax}`,
    `--property=TasksMax=${WORKFLOW_CHILD_CGROUP.tasksMax}`,
    `--property=CPUQuota=${WORKFLOW_CHILD_CGROUP.cpuQuota}`,
    bwrap,
    "--unshare-user",
    "--unshare-all",
    "--disable-userns",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/tmp",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind-try",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
    "--ro-bind-try",
    "/bin",
    "/bin",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/run",
    "--ro-bind",
    runnerPath,
    "/runner.mjs",
    "--chdir",
    "/tmp",
    "--",
    node,
    "/runner.mjs",
  ];

  return spawn(systemdRun, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: systemdEnv(),
  });
}

function handleProtocolLine(line: string, globals: SandboxGlobals, child: ChildProcessWithoutNullStreams, pending: Map<number, PendingRequest>, touch: () => void, finish: (err: unknown, value?: unknown) => void): void {
  if (!line.trim()) return;
  touch();
  let msg: ProtocolMessage;
  try {
    msg = JSON.parse(line) as ProtocolMessage;
  } catch {
    // The protocol channel should be JSON only. Treat stray output as child stderr without granting it meaning.
    return;
  }

  if (msg.type === "heartbeat") return;
  if (msg.type === "done") {
    const criticalPending = [...pending.values()].filter((request) => request.critical);
    if (criticalPending.length > 0) {
      const labels = criticalPending.map((request) => request.method).join(", ");
      return finish(new Error(`Workflow child reported completion with pending critical RPC request(s): ${labels}`));
    }
    return finish(null, msg.result);
  }
  if (msg.type === "failed") {
    const err = new Error(msg.error ?? "Workflow child failed");
    err.name = msg.name ?? "WorkflowChildError";
    if (msg.stack) err.stack = msg.stack;
    return finish(err);
  }
  if (msg.type === "request") {
    pending.set(msg.id, { method: msg.method, critical: Boolean(msg.critical), startedAt: Date.now() });
    void dispatchRequest(globals, msg.method, msg.params)
      .then((result) => writeMessage(child, { type: "reply", id: msg.id, ok: true, result }))
      .catch((err) => writeMessage(child, { type: "reply", id: msg.id, ok: false, error: serializeError(err) }))
      .finally(() => pending.delete(msg.id));
  }
}

async function dispatchRequest(globals: SandboxGlobals, method: string, params: unknown): Promise<unknown> {
  const p = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  switch (method) {
    case "agent": {
      const result = await globals.agent(p.prompt, p.opts);
      return { __piWorkflowRpc: "agentResult", result, budgetSpent: readBudgetSpent(globals.budget) };
    }
    case "workflow":
      return await globals.workflow(p.nameOrRef, p.args);
    case "phase":
      return globals.phase(String(p.title ?? ""));
    case "log":
      return await globals.log(String(p.message ?? ""));
    case "ui.define":
      return await (globals.ui as any).define(p.spec);
    case "ui.update":
      return Object.prototype.hasOwnProperty.call(p, "state") ? await (globals.ui as any).update(String(p.viewId ?? ""), p.state) : await (globals.ui as any).update(p.viewId);
    case "ui.dashboard":
      return await (globals.ui as any).dashboard(p.doc);
    case "ui.patch":
      return await (globals.ui as any).patch(String(p.viewId ?? ""), p.patch);
    case "ui.close":
      return await (globals.ui as any).close(String(p.viewId ?? ""));
    case "budget.spent":
      return readBudgetSpent(globals.budget);
    case "budget.remaining":
      return readBudgetRemaining(globals.budget);
    default:
      throw new Error(`Unsupported workflow child RPC method: ${method}`);
  }
}

function writeMessage(child: ChildProcessWithoutNullStreams, message: unknown): void {
  if (!child.stdin.writable) return;
  try {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  } catch {
    // The child may have been killed while an async RPC handler was resolving.
  }
}

function terminateWorkflowChild(child: ChildProcessWithoutNullStreams, unitName: string, _reason: string): void {
  try {
    child.stdin.destroy();
  } catch {
    // ignored
  }
  void systemctl("kill", "--signal=SIGTERM", unitName);
  child.kill("SIGTERM");
  setTimeout(() => {
    void systemctl("kill", "--signal=SIGKILL", unitName);
    void systemctl("stop", unitName);
    child.kill("SIGKILL");
  }, 2_000).unref?.();
}

function systemctl(...args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const systemctlPath = fs.existsSync("/usr/bin/systemctl") ? "/usr/bin/systemctl" : "systemctl";
    const proc = spawn(systemctlPath, ["--user", ...args], { stdio: "ignore", env: systemdEnv() });
    proc.on("close", () => resolve());
    proc.on("error", () => resolve());
  });
}

function systemdEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
  };
}

function requireExecutable(absPath: string, name: string): string {
  if (fs.existsSync(absPath)) return absPath;
  throw new Error(`pi-workflows requires ${name} on this machine for workflow child sandboxing`);
}

function readBudgetTotal(budget: unknown): number | null {
  const value = (budget as { total?: unknown } | undefined)?.total;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBudgetSpent(budget: unknown): number {
  try {
    const value = (budget as { spent?: () => unknown } | undefined)?.spent?.();
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function readBudgetRemaining(budget: unknown): number | null {
  try {
    const value = (budget as { remaining?: () => unknown } | undefined)?.remaining?.();
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function serializeError(err: unknown): { name: string; message: string; stack?: string } {
  return {
    name: (err as Error)?.name ?? "Error",
    message: (err as Error)?.message ?? String(err),
    stack: (err as Error)?.stack,
  };
}
