import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LIMITS, WORKFLOW_CHILD_CGROUP, WORKFLOW_RESOURCE_LIMITS } from "../constants.js";
import type { SandboxGlobals } from "./sandbox-types.js";
import { WorkflowAbortError } from "./errors.js";
import { validateWorkflowExecutableSource } from "./parser.js";
import { BoundedTextAccumulator, byteLength, truncateBytes } from "../utils/truncate.js";

export { type SandboxGlobals } from "./sandbox-types.js";

const RPC_METHODS = ["agent", "workflow", "phase", "log", "ui.define", "ui.update", "ui.dashboard", "ui.patch", "ui.close", "ui.flush", "budget.spent", "budget.remaining"] as const;
const RPC_METHOD_SET = new Set<string>(RPC_METHODS);
const CRITICAL_RPC_METHODS = new Set<string>(["agent", "workflow"]);

type RpcMethod = (typeof RPC_METHODS)[number];

type ProtocolMessage =
  | { type: "heartbeat" }
  | { type: "request"; id: number; method: RpcMethod; params?: Record<string, unknown>; critical: boolean; fanoutGroupIds: number[] }
  | { type: "cancel"; fanoutGroupId: number; reason?: { name?: string; message?: string } }
  | { type: "done"; result?: unknown }
  | { type: "failed"; error?: string; name?: string; stack?: string };

interface PendingRequestIndex {
  readonly size: number;
  has(id: number): boolean;
}

interface PendingRequest {
  method: string;
  critical: boolean;
  startedAt: number;
  controller: AbortController;
  fanoutGroupIds: number[];
}

export async function executeWorkflowSandbox(source: string, globals: SandboxGlobals, signal: AbortSignal): Promise<unknown> {
  validateWorkflowExecutableSource(source);
  const runnerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "child-runner.mjs");
  if (!fs.existsSync(runnerPath)) throw new Error(`Workflow child runner missing: ${runnerPath}`);

  const unitBase = `pi-workflow-${crypto.randomBytes(6).toString("hex")}`;
  const unitName = `${unitBase}.scope`;
  const child = spawnSandboxedRunner(runnerPath, unitBase);
  const pending = new Map<number, PendingRequest>();
  const stderr = new BoundedTextAccumulator(WORKFLOW_RESOURCE_LIMITS.workflowChildStderrBytes, "\n… workflow child stderr truncated …");
  let stdoutBuffer = "";
  let lastHeartbeat = Date.now();
  let settled = false;

  return await new Promise<unknown>((resolve, reject) => {
    const finish = (err: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      const pendingAbortReason = signal.aborted && err instanceof Error ? err : err instanceof WorkflowAbortError ? err : new WorkflowAbortError("Workflow RPC canceled");
      abortPendingRequests(pending, pendingAbortReason);
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
      if (byteLength(stdoutBuffer) > WORKFLOW_RESOURCE_LIMITS.workflowProtocolLineBytes) {
        finish(new Error(`Workflow child protocol line exceeded ${WORKFLOW_RESOURCE_LIMITS.workflowProtocolLineBytes} bytes`));
        return;
      }
      for (const line of lines) handleProtocolLine(line, globals, child, pending, () => (lastHeartbeat = Date.now()), finish);
    });

    child.stderr.on("data", (chunk) => stderr.append(chunk.toString("utf8")));
    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      if (settled) return;
      if (stdoutBuffer.trim()) handleProtocolLine(stdoutBuffer, globals, child, pending, () => (lastHeartbeat = Date.now()), finish);
      if (!settled) {
        const tail = stderr.toString().trim();
        finish(new Error(`Workflow child exited before completion (${code ?? "signal"})${tail ? `: ${tail.slice(0, 4000)}` : ""}`));
      }
    });

    const started = writeMessage(child, {
      type: "start",
      source,
      args: globals.args,
      cwd: globals.cwd,
      budgetTotal: readBudgetTotal(globals.budget),
      budgetSpent: readBudgetSpent(globals.budget),
      pipelineLimit: DEFAULT_LIMITS.pipelineSchedulingLimit,
      heartbeatMs: DEFAULT_LIMITS.workflowHeartbeatMs,
    });
    if (!started) finish(new Error(`Workflow start message exceeded ${WORKFLOW_RESOURCE_LIMITS.workflowParentMessageBytes} bytes`));
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
  if (byteLength(line) > WORKFLOW_RESOURCE_LIMITS.workflowProtocolLineBytes) {
    return finish(new Error(`Workflow child protocol line exceeded ${WORKFLOW_RESOURCE_LIMITS.workflowProtocolLineBytes} bytes`));
  }
  touch();
  let msg: ProtocolMessage;
  try {
    msg = decodeChildProtocolLine(line, pending);
  } catch (err) {
    return finish(err);
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
  if (msg.type === "cancel") {
    abortFanoutGroupRequests(pending, msg.fanoutGroupId, protocolAbortError(msg.reason));
    return;
  }
  if (msg.type === "request") {
    const controller = new AbortController();
    pending.set(msg.id, { method: msg.method, critical: msg.critical, startedAt: Date.now(), controller, fanoutGroupIds: msg.fanoutGroupIds });
    void dispatchRequest(globals, msg.method, msg.params, { signal: controller.signal })
      .then((result) => writeOkReply(child, msg.id, result))
      .catch((err) => writeErrorReply(child, msg.id, err))
      .finally(() => pending.delete(msg.id));
  }
}

const EMPTY_PENDING_INDEX: PendingRequestIndex = Object.freeze({ size: 0, has: () => false });

export function decodeChildProtocolLine(line: string, pending: PendingRequestIndex = EMPTY_PENDING_INDEX): ProtocolMessage {
  if (byteLength(line) > WORKFLOW_RESOURCE_LIMITS.workflowProtocolLineBytes) {
    throw new Error(`Workflow child protocol line exceeded ${WORKFLOW_RESOURCE_LIMITS.workflowProtocolLineBytes} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (err) {
    throw protocolViolation(`invalid JSON: ${(err as Error).message}`);
  }
  return decodeChildProtocolMessage(value, pending);
}

function decodeChildProtocolMessage(value: unknown, pending: PendingRequestIndex): ProtocolMessage {
  if (!isPlainRecord(value)) throw protocolViolation("message must be an object");
  if (typeof value.type !== "string") throw protocolViolation("message type must be a string");

  switch (value.type) {
    case "heartbeat": {
      assertOnlyKeys(value, ["type"], "heartbeat");
      return { type: "heartbeat" };
    }
    case "request":
      return decodeRequestMessage(value, pending);
    case "cancel":
      return decodeCancelMessage(value);
    case "done": {
      assertOnlyKeys(value, ["type", "result"], "done");
      return Object.prototype.hasOwnProperty.call(value, "result") ? { type: "done", result: value.result } : { type: "done" };
    }
    case "failed":
      return decodeFailedMessage(value);
    default:
      throw protocolViolation(`unsupported message type: ${value.type}`);
  }
}

function decodeRequestMessage(value: Record<string, unknown>, pending: PendingRequestIndex): Extract<ProtocolMessage, { type: "request" }> {
  assertOnlyKeys(value, ["type", "id", "method", "params", "critical", "fanoutGroupIds"], "request");
  if (!isPositiveSafeInteger(value.id)) throw protocolViolation("request id must be a positive safe integer");
  const id = value.id;
  if (pending.has(id)) throw protocolViolation(`duplicate request id: ${id}`);
  if (pending.size >= WORKFLOW_RESOURCE_LIMITS.workflowPendingRpcRequests) throw protocolViolation(`too many pending RPC requests (${pending.size}/${WORKFLOW_RESOURCE_LIMITS.workflowPendingRpcRequests})`);
  if (!isRpcMethod(value.method)) throw protocolViolation(`unsupported RPC method: ${String(value.method)}`);
  const method = value.method;
  if (typeof value.critical !== "boolean") throw protocolViolation("request critical must be a boolean");
  const expectedCritical = CRITICAL_RPC_METHODS.has(method);
  if (value.critical !== expectedCritical) throw protocolViolation(`${method} RPC must be ${expectedCritical ? "critical" : "non-critical"}`);
  const params = decodeRequestParams(value.params);
  const fanoutGroupIds = decodeFanoutGroupIds(value.fanoutGroupIds);
  return params === undefined ? { type: "request", id, method, critical: value.critical, fanoutGroupIds } : { type: "request", id, method, params, critical: value.critical, fanoutGroupIds };
}

function decodeCancelMessage(value: Record<string, unknown>): Extract<ProtocolMessage, { type: "cancel" }> {
  assertOnlyKeys(value, ["type", "fanoutGroupId", "reason"], "cancel");
  if (!isPositiveSafeInteger(value.fanoutGroupId)) throw protocolViolation("cancel fanoutGroupId must be a positive safe integer");
  const reason = decodeProtocolReason(value.reason, "cancel reason");
  return reason === undefined ? { type: "cancel", fanoutGroupId: value.fanoutGroupId } : { type: "cancel", fanoutGroupId: value.fanoutGroupId, reason };
}

function decodeFailedMessage(value: Record<string, unknown>): Extract<ProtocolMessage, { type: "failed" }> {
  assertOnlyKeys(value, ["type", "error", "name", "stack"], "failed");
  const error = decodeOptionalProtocolString(value.error, "failed.error", WORKFLOW_RESOURCE_LIMITS.workflowProtocolErrorBytes);
  const name = decodeOptionalProtocolString(value.name, "failed.name", 200);
  const stack = decodeOptionalProtocolString(value.stack, "failed.stack", WORKFLOW_RESOURCE_LIMITS.workflowProtocolErrorBytes);
  return {
    type: "failed",
    ...(error === undefined ? {} : { error }),
    ...(name === undefined ? {} : { name }),
    ...(stack === undefined ? {} : { stack }),
  };
}

function decodeRequestParams(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) throw protocolViolation("request params must be an object when present");
  return value;
}

function decodeFanoutGroupIds(value: unknown): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw protocolViolation("request fanoutGroupIds must be an array when present");
  if (value.length > WORKFLOW_RESOURCE_LIMITS.workflowFanoutGroupDepth) throw protocolViolation(`request fanoutGroupIds exceeds ${WORKFLOW_RESOURCE_LIMITS.workflowFanoutGroupDepth} entries`);
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const id of value) {
    if (!isPositiveSafeInteger(id)) throw protocolViolation("request fanoutGroupIds entries must be positive safe integers");
    if (seen.has(id)) throw protocolViolation(`duplicate fanout group id: ${id}`);
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function decodeProtocolReason(value: unknown, label: string): { name?: string; message?: string } | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) throw protocolViolation(`${label} must be an object when present`);
  assertOnlyKeys(value, ["name", "message"], label);
  const name = decodeOptionalProtocolString(value.name, `${label}.name`, 200);
  const message = decodeOptionalProtocolString(value.message, `${label}.message`, WORKFLOW_RESOURCE_LIMITS.workflowProtocolErrorBytes);
  if (name === undefined && message === undefined) return undefined;
  return { ...(name === undefined ? {} : { name }), ...(message === undefined ? {} : { message }) };
}

function decodeOptionalProtocolString(value: unknown, label: string, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw protocolViolation(`${label} must be a string when present`);
  return truncateBytes(value, maxBytes);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw protocolViolation(`${label} contains unknown field: ${key}`);
  }
}

function isRpcMethod(value: unknown): value is RpcMethod {
  return typeof value === "string" && RPC_METHOD_SET.has(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function protocolViolation(message: string): Error {
  return new Error(`Workflow child protocol violation: ${message}`);
}

async function dispatchRequest(globals: SandboxGlobals, method: string, params: unknown, context: { signal: AbortSignal }): Promise<unknown> {
  const p = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  switch (method) {
    case "agent": {
      const result = await abortable(Promise.resolve().then(() => globals.agent(p.prompt, p.opts, context)), context.signal);
      return { __piWorkflowRpc: "agentResult", result, budgetSpent: readBudgetSpent(globals.budget) };
    }
    case "workflow": {
      const result = await abortable(Promise.resolve().then(() => globals.workflow(p.nameOrRef, p.args, context)), context.signal);
      return { __piWorkflowRpc: "workflowResult", result, budgetSpent: readBudgetSpent(globals.budget) };
    }
    case "phase":
      return await abortable(Promise.resolve().then(() => globals.phase(String(p.title ?? ""))), context.signal);
    case "log":
      return await abortable(Promise.resolve().then(() => globals.log(String(p.message ?? ""))), context.signal);
    case "ui.define":
      return await abortable(Promise.resolve().then(() => (globals.ui as any).define(p.spec)), context.signal);
    case "ui.update":
      return await abortable(Promise.resolve().then(() => Object.prototype.hasOwnProperty.call(p, "state") ? (globals.ui as any).update(String(p.viewId ?? ""), p.state) : (globals.ui as any).update(p.viewId)), context.signal);
    case "ui.dashboard":
      return await abortable(Promise.resolve().then(() => (globals.ui as any).dashboard(p.doc)), context.signal);
    case "ui.patch":
      return await abortable(Promise.resolve().then(() => (globals.ui as any).patch(String(p.viewId ?? ""), p.patch)), context.signal);
    case "ui.close":
      return await abortable(Promise.resolve().then(() => (globals.ui as any).close(String(p.viewId ?? ""))), context.signal);
    case "ui.flush": {
      const ui = globals.ui as any;
      if (typeof ui.flush === "function") return await abortable(Promise.resolve().then(() => ui.flush()), context.signal);
      if (typeof ui.__flush === "function") return await abortable(Promise.resolve().then(() => ui.__flush()), context.signal);
      return undefined;
    }
    case "budget.spent":
      return readBudgetSpent(globals.budget);
    case "budget.remaining":
      return readBudgetRemaining(globals.budget);
    default:
      throw new Error(`Unsupported workflow child RPC method: ${method}`);
  }
}

function writeOkReply(child: ChildProcessWithoutNullStreams, id: number, result: unknown): void {
  const ok = writeMessage(child, { type: "reply", id, ok: true, result });
  if (!ok) writeErrorReply(child, id, new Error(`Workflow RPC reply exceeded ${WORKFLOW_RESOURCE_LIMITS.workflowParentMessageBytes} bytes`));
}

function writeErrorReply(child: ChildProcessWithoutNullStreams, id: number, err: unknown): void {
  writeMessage(child, { type: "reply", id, ok: false, error: serializeError(err) });
}

function abortPendingRequests(pending: Map<number, PendingRequest>, reason: Error): void {
  for (const request of pending.values()) {
    if (!request.controller.signal.aborted) request.controller.abort(reason);
  }
}

function abortFanoutGroupRequests(pending: Map<number, PendingRequest>, groupId: number, reason: Error): void {
  for (const request of pending.values()) {
    if (request.fanoutGroupIds.includes(groupId) && !request.controller.signal.aborted) request.controller.abort(reason);
  }
}

function protocolAbortError(reason: { name?: unknown; message?: unknown } | undefined): Error {
  const message = typeof reason?.message === "string" && reason.message.trim() ? reason.message : "Workflow fanout canceled";
  return new WorkflowAbortError(message);
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new WorkflowAbortError("Workflow RPC aborted");
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        abort = () => reject(signal.reason instanceof Error ? signal.reason : new WorkflowAbortError("Workflow RPC aborted"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

function writeMessage(child: ChildProcessWithoutNullStreams, message: unknown): boolean {
  if (!child.stdin.writable) return false;
  let line: string;
  try {
    line = JSON.stringify(message);
  } catch {
    return false;
  }
  if (byteLength(line) > WORKFLOW_RESOURCE_LIMITS.workflowParentMessageBytes) return false;
  try {
    child.stdin.write(`${line}\n`);
    return true;
  } catch {
    // The child may have been killed while an async RPC handler was resolving.
    return false;
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
    name: truncateBytes((err as Error)?.name ?? "Error", 200),
    message: truncateBytes((err as Error)?.message ?? String(err), 2000),
    stack: (err as Error)?.stack ? truncateBytes((err as Error).stack!, 4000) : undefined,
  };
}
