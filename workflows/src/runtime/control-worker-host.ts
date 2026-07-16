import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import { describeOpaqueArtifactRef } from "../artifacts/store.js";
import {
  describeOpaqueAcceptedCandidateRef,
  describeOpaqueCandidateRef,
  describeOpaqueCandidateWorkspace,
  describeOpaqueLaunchSnapshotRef,
} from "../candidates/refs.js";
import { isCandidateWorkspaceCapability } from "../candidates/store.js";
import { FLOW_NAME_PATTERN } from "../definition/limits.js";
import { metricHandleState } from "../measurements/metrics.js";
import {
  ASYNC_FLOW_METHODS,
  CONTROL_PROTOCOL_VERSION,
  parseControlProcessMessage,
  type ControlProcessMessage,
  type HostProcessMessage,
  type MetricResponseMessage,
  type MetricStateUpdate,
  type SerializedError,
  type WireValue,
} from "./control-protocol.js";

const CONTROL_WIRE_BYTES = 4 * 1024 * 1024;
const CONTROL_WIRE_DEPTH = 48;
const CONTROL_WIRE_NODES = 50_000;
const CONTROL_SEGMENT_TIMEOUT_MS = 1_000;
const CONTROL_INITIALIZATION_TIMEOUT_MS = 5_000;
const CONTROL_OLD_GENERATION_MB = 64;
const CONTROL_YOUNG_GENERATION_MB = 16;

const ASYNC_FLOW_METHOD_SET = new Set<string>(ASYNC_FLOW_METHODS);

interface MetricMirrorState {
  metricId: string;
  definition: Record<string, unknown>;
  baseline: number | null;
  current: number | null;
  best: number | null;
  relativeGain: number | null;
  observationCount: number;
}


export interface ControlDefinitionOptions<TContext> {
  executableSource: string;
  workflowName: string;
  flow: Record<string, unknown>;
  args: Record<string, unknown>;
  snapshot?: unknown;
  signal: AbortSignal;
  rootContext: TContext;
  currentContext: () => TContext;
  runInContext: <T>(context: TContext, body: () => T) => T;
  segmentTimeoutMs?: number;
  onControlFailure?: (error: unknown) => void;
  /** Process observability only; the callback cannot affect protocol state. */
  onControlStart?: (pid: number) => void;
  /** Load and validate the definition object without invoking run(). */
  definitionOnly?: boolean;
}

export class ControlExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlExecutionError";
  }
}

export class ControlExecutionLimitError extends ControlExecutionError {
  constructor(message: string) {
    super(message);
    this.name = "ControlExecutionLimitError";
  }
}

/**
 * Executes reviewed control JavaScript in a memory-bounded child process. Every
 * flow operation and callback crosses this bridge, so a stuck continuation can
 * be terminated without blocking the Pi host event loop.
 */
export async function evaluateControlDefinition<TContext>(options: ControlDefinitionOptions<TContext>): Promise<unknown> {
  return await new ControlProcessBridge(options).run();
}

/**
 * Execute only the reviewed module's definition construction in the same
 * constrained process used by runs. No flow method is available or invoked.
 */
export async function loadControlDefinition(executableSource: string, workflowName: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new ControlExecutionLimitError(
    "Workflow definition-only control load timed out",
  )), 5_000);
  timeout.unref?.();
  try {
    const result = await evaluateControlDefinition({
      executableSource,
      workflowName,
      flow: {},
      args: {},
      signal: controller.signal,
      rootContext: undefined,
      currentContext: () => undefined,
      runInContext: (_context, body) => body(),
      definitionOnly: true,
    });
    if (
      !result || typeof result !== "object" ||
      (result as { loaded?: unknown }).loaded !== true ||
      (result as { name?: unknown }).name !== workflowName
    ) throw new ControlExecutionError("Workflow definition-only control load returned an invalid binding");
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

class ControlProcessBridge<TContext> {
  private readonly segmentTimeoutMs: number;
  private readonly hostReferences = new WeakMap<object, string>();
  private readonly referenceValues = new Map<string, object>();
  private readonly metricReferences = new Set<string>();
  private readonly callbackFunctions = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  private readonly callbackWaiters = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  private readonly invocationContexts = new Map<string, TContext>();
  private readonly invocationStates = new Map<string, "runnable" | "waiting">();
  private readonly hostErrors = new Map<string, unknown>();
  private readonly requestIds = new Set<string>();
  private readonly child: ChildProcess;
  private readonly syncInput: Writable;
  private readonly snapshot?: WireValue;
  private timer?: NodeJS.Timeout;
  private stderr = "";
  private nextReference = 1;
  private nextCallbackInvocation = 1;
  private nextHostError = 1;
  private closing = false;
  private settled = false;
  private phase: "starting" | "running" | "finished" = "starting";
  private resolveResult!: (value: unknown) => void;
  private rejectResult!: (error: unknown) => void;

  constructor(private readonly options: ControlDefinitionOptions<TContext>) {
    const sourceBytes = typeof options.executableSource === "string" ? Buffer.byteLength(options.executableSource) : 0;
    if (
      typeof options.executableSource !== "string" ||
      sourceBytes < 1 ||
      sourceBytes > CONTROL_WIRE_BYTES
    ) throw new ControlExecutionLimitError("Workflow control source exceeds its structural limit");
    if (!FLOW_NAME_PATTERN.test(options.workflowName)) throw new ControlExecutionError("Workflow control name is invalid");
    this.segmentTimeoutMs = boundedSegmentTimeout(options.segmentTimeoutMs);
    this.snapshot = options.snapshot === undefined ? undefined : this.encode(options.snapshot);
    this.child = fork(fileURLToPath(new URL("./control-worker.js", import.meta.url)), [], {
      execArgv: [
        `--max-old-space-size=${CONTROL_OLD_GENERATION_MB}`,
        `--max-semi-space-size=${CONTROL_YOUNG_GENERATION_MB}`,
        "--stack-size=4096",
      ],
      stdio: ["ignore", "ignore", "pipe", "ipc", "pipe"],
      serialization: "advanced",
      env: {
        PATH: process.env.PATH ?? "/usr/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TZ: "UTC",
      },
    });
    const syncInput = this.child.stdio[4];
    if (!syncInput || typeof (syncInput as Writable).write !== "function") {
      this.child.kill("SIGKILL");
      throw new ControlExecutionError("Workflow control process has no synchronous response pipe");
    }
    this.syncInput = syncInput as Writable;
    this.invocationContexts.set("root", options.rootContext);
    this.invocationStates.set("root", "waiting");
  }

  async run(): Promise<unknown> {
    const result = new Promise<unknown>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    this.child.on("message", (message) => this.onMessage(message));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-64 * 1024);
    });
    this.child.once("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const limited = /memory limit|heap out of memory|allocation failed/i.test(message);
      this.fail(limited
        ? new ControlExecutionLimitError("Workflow control exceeded its memory limit")
        : new ControlExecutionError(`Workflow control process failed: ${message}`));
    });
    this.child.once("exit", (code, signal) => {
      if (this.settled || this.closing) return;
      const limited = /heap out of memory|allocation failed|fatal process out of memory/i.test(this.stderr);
      this.fail(limited
        ? new ControlExecutionLimitError("Workflow control exceeded its memory limit")
        : new ControlExecutionError(`Workflow control process exited before completion (${signal ?? code ?? "unknown"})`));
    });
    const abort = () => this.fail(this.options.signal.reason instanceof Error
      ? this.options.signal.reason
      : new ControlExecutionError("Workflow control was aborted"));
    this.options.signal.addEventListener("abort", abort, { once: true });
    if (this.options.signal.aborted) abort();
    else {
      this.send({
        type: "initialize",
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        executableSource: this.options.executableSource,
        workflowName: this.options.workflowName,
        args: this.encode(this.options.args),
        ...(this.snapshot ? { snapshot: this.snapshot } : {}),
        segmentTimeoutMs: this.segmentTimeoutMs,
        definitionOnly: this.options.definitionOnly === true,
      });
      this.refreshTimer();
    }
    try {
      return await result;
    } finally {
      this.options.signal.removeEventListener("abort", abort);
      this.cleanup();
    }
  }

  private onMessage(raw: unknown): void {
    if (this.settled || this.closing) return;
    try {
      const message = parseControlProcessMessage(raw);
      if (message.type === "initialized") {
        if (this.phase !== "starting") throw new ControlExecutionError("Workflow control initialized more than once");
        this.phase = "running";
        this.invocationStates.set("root", "runnable");
        this.refreshTimer();
        const pid = this.child.pid;
        if (pid !== undefined) {
          try { this.options.onControlStart?.(pid); } catch { /* Observability cannot alter execution. */ }
        }
        return;
      }
      if (this.phase !== "running") throw new ControlExecutionError("Workflow control message arrived before initialization");
      if (message.type === "host-call") {
        this.claimRequestId(message.requestId);
        void this.handleHostCall(message);
        return;
      }
      if (message.type === "metric-call") {
        this.claimRequestId(message.requestId);
        this.handleMetricCall(message);
        return;
      }
      if (message.type === "callback-result") {
        this.handleCallbackResult(message);
        return;
      }
      this.invocationStates.delete("root");
      this.phase = "finished";
      if (message.error !== undefined) this.finishFailure(this.deserializeError(message.error));
      else this.finishSuccess(this.decode(message.value));
    } catch (error) {
      this.fail(error instanceof ControlExecutionError
        ? error
        : new ControlExecutionError(`Malformed workflow control message: ${errorMessage(error)}`));
    }
  }

  private async handleHostCall(message: Extract<ControlProcessMessage, { type: "host-call" }>): Promise<void> {
    const { requestId, invocationId, method } = message;
    if (!this.invocationContexts.has(invocationId)) {
      this.fail(new ControlExecutionError("Malformed workflow host call"));
      return;
    }
    const context = this.invocationContexts.get(invocationId)!;
    const callable = this.options.flow[method];
    if (!ASYNC_FLOW_METHOD_SET.has(method) || typeof callable !== "function") {
      this.fail(new ControlExecutionError(`Unavailable workflow host method ${String(method)}`));
      return;
    }
    this.invocationStates.set(invocationId, "waiting");
    this.refreshTimer();
    try {
      const decoded = this.decode(message.args);
      if (!Array.isArray(decoded)) throw new ControlExecutionError("Workflow host arguments are not an array");
      const value = await Promise.resolve(this.options.runInContext(context, () => callable(...decoded)));
      if (this.settled || this.closing) return;
      this.invocationStates.set(invocationId, "runnable");
      this.send({
        type: "host-response",
        requestId,
        value: this.encode(value),
        metricStates: this.metricStates(),
      });
      this.refreshTimer();
    } catch (error) {
      if (this.settled || this.closing) return;
      this.invocationStates.set(invocationId, "runnable");
      this.send({
        type: "host-response",
        requestId,
        error: this.serializeHostError(error),
        metricStates: this.metricStates(),
      });
      this.refreshTimer();
    }
  }

  private handleMetricCall(message: Extract<ControlProcessMessage, { type: "metric-call" }>): void {
    const { requestId, invocationId } = message;
    if (!this.invocationContexts.has(invocationId)) {
      this.fail(new ControlExecutionError("Malformed synchronous metric declaration"));
      return;
    }
    const context = this.invocationContexts.get(invocationId)!;
    this.invocationStates.set(invocationId, "waiting");
    this.refreshTimer();
    try {
      const decoded = this.decode(message.args);
      if (!Array.isArray(decoded)) throw new ControlExecutionError("Metric arguments are not an array");
      const callable = this.options.flow.metric;
      if (typeof callable !== "function") throw new ControlExecutionError("flow.metric is unavailable");
      const value = this.options.runInContext(context, () => callable(...decoded));
      if (value && typeof (value as PromiseLike<unknown>).then === "function") {
        throw new ControlExecutionError("flow.metric must be synchronous");
      }
      this.sendSync({ type: "metric-response", requestId, value: this.encode(value) });
    } catch (error) {
      this.sendSync({ type: "metric-response", requestId, error: this.serializeHostError(error) });
    } finally {
      this.invocationStates.set(invocationId, "runnable");
      this.refreshTimer();
    }
  }

  private handleCallbackResult(message: Extract<ControlProcessMessage, { type: "callback-result" }>): void {
    const { invocationId } = message;
    const waiter = this.callbackWaiters.get(invocationId);
    if (!waiter) {
      this.fail(new ControlExecutionError(`Unknown callback invocation ${invocationId}`));
      return;
    }
    this.callbackWaiters.delete(invocationId);
    this.invocationContexts.delete(invocationId);
    this.invocationStates.delete(invocationId);
    this.refreshTimer();
    try {
      if (message.error !== undefined) waiter.reject(this.deserializeError(message.error));
      else waiter.resolve(this.decode(message.value));
    } catch (error) {
      waiter.reject(error);
    }
  }

  private remoteCallback(callbackId: string): (...args: unknown[]) => Promise<unknown> {
    const existing = this.callbackFunctions.get(callbackId);
    if (existing) return existing;
    const callback = (...args: unknown[]): Promise<unknown> => {
      if (this.settled) return Promise.reject(new ControlExecutionError("Workflow control process is unavailable"));
      const invocationId = `callback-${this.nextCallbackInvocation++}`;
      const context = this.options.currentContext();
      this.invocationContexts.set(invocationId, context);
      this.invocationStates.set(invocationId, "runnable");
      const result = new Promise<unknown>((resolve, reject) => {
        this.callbackWaiters.set(invocationId, { resolve, reject });
      });
      this.send({
        type: "invoke-callback",
        invocationId,
        callbackId,
        args: this.encode(args),
      });
      this.refreshTimer();
      return result;
    };
    this.callbackFunctions.set(callbackId, callback);
    return callback;
  }

  private encode(value: unknown): WireValue {
    return encodeWire(value, {
      hostReference: (object) => this.hostReference(object),
    });
  }

  private decode(value: WireValue): unknown {
    const counter = wireCounter();
    const visit = (wire: WireValue, depth: number): unknown => {
      if (!wire || typeof wire !== "object" || Array.isArray(wire) || typeof wire.type !== "string") {
        throw new ControlExecutionError("Malformed workflow control value");
      }
      consumeWire(counter, depth, wire.type === "primitive" && typeof wire.value === "string" ? wire.value : undefined);
      if (wire.type === "undefined") {
        assertExactKeys(wire, ["type"], "undefined wire value");
        return undefined;
      }
      if (wire.type === "primitive") {
        assertExactKeys(wire, ["type", "value"], "primitive wire value");
        if (
          wire.value !== null && typeof wire.value !== "boolean" && typeof wire.value !== "string" &&
          (typeof wire.value !== "number" || !Number.isFinite(wire.value) || Object.is(wire.value, -0))
        ) throw new ControlExecutionError("Malformed workflow control primitive");
        return wire.value;
      }
      if (wire.type === "host-ref" || wire.type === "metric-ref") {
        assertExactKeys(
          wire,
          wire.type === "metric-ref" && wire.state !== undefined ? ["type", "id", "state"] : ["type", "id"],
          `${wire.type} wire value`,
        );
        requireId(wire.id, "host reference");
        if (wire.type === "metric-ref" && wire.state !== undefined) {
          throw new ControlExecutionError("Workflow control cannot update host metric state");
        }
        const reference = this.referenceValues.get(wire.id);
        if (!reference) throw new ControlExecutionError(`Unknown host reference ${wire.id}`);
        return reference;
      }
      if (wire.type === "callback") {
        assertExactKeys(wire, ["type", "id"], "callback wire value");
        return this.remoteCallback(requireId(wire.id, "callback"));
      }
      if (wire.type === "array") {
        assertExactKeys(wire, ["type", "values"], "array wire value");
        if (!Array.isArray(wire.values)) throw new ControlExecutionError("Malformed workflow control array");
        return wire.values.map((entry) => visit(entry, depth + 1));
      }
      if (wire.type === "object") {
        assertExactKeys(wire, ["type", "entries"], "object wire value");
        if (!Array.isArray(wire.entries)) throw new ControlExecutionError("Malformed workflow control object");
        const result: Record<string, unknown> = Object.create(null);
        const seen = new Set<string>();
        for (const entry of wire.entries) {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
            throw new ControlExecutionError("Malformed workflow control object");
          }
          if (seen.has(entry[0])) throw new ControlExecutionError(`Duplicate workflow control property ${entry[0]}`);
          seen.add(entry[0]);
          consumeWire(counter, depth + 1, entry[0]);
          result[entry[0]] = visit(entry[1], depth + 1);
        }
        return result;
      }
      throw new ControlExecutionError("Malformed workflow control value");
    };
    return visit(value, 0);
  }

  private hostReference(value: object): { id: string; metric?: MetricMirrorState } | undefined {
    const metric = mirroredMetricState(value);
    const opaque = metric !== undefined || isOpaqueHostReference(value);
    if (!opaque) return undefined;
    let id = this.hostReferences.get(value);
    if (!id) {
      id = `host-${this.nextReference++}`;
      this.hostReferences.set(value, id);
      this.referenceValues.set(id, value);
    }
    if (metric) this.metricReferences.add(id);
    return { id, ...(metric ? { metric } : {}) };
  }

  private metricStates(): MetricStateUpdate[] {
    const result: MetricStateUpdate[] = [];
    for (const id of this.metricReferences) {
      const value = this.referenceValues.get(id);
      if (!value) continue;
      const state = mirroredMetricState(value);
      if (state) result.push({ id, state: encodeWire(state, { hostReference: () => undefined }) });
    }
    return result;
  }

  private serializeHostError(error: unknown): SerializedError {
    const id = `host-error-${this.nextHostError++}`;
    this.hostErrors.set(id, error);
    return serializeError(error, id);
  }

  private deserializeError(error: SerializedError): unknown {
    if (error.hostErrorId && this.hostErrors.has(error.hostErrorId)) return this.hostErrors.get(error.hostErrorId);
    if (
      error.name === "ControlExecutionLimitError" ||
      /script execution timed out|control message exceeds its structural limit/i.test(error.message)
    ) return new ControlExecutionLimitError(error.message);
    const value = new Error(typeof error.message === "string" ? error.message : "Workflow control failed");
    value.name = typeof error.name === "string" ? error.name : "Error";
    if (typeof error.stack === "string") value.stack = error.stack;
    if (error.properties && typeof error.properties === "object") Object.assign(value, error.properties);
    return value;
  }

  private refreshTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.settled || this.closing) return;
    if (this.phase === "starting") {
      this.timer = setTimeout(() => {
        this.fail(new ControlExecutionLimitError("Workflow control initialization timed out"));
      }, CONTROL_INITIALIZATION_TIMEOUT_MS);
      this.timer.unref?.();
      return;
    }
    if (this.phase !== "running" || ![...this.invocationStates.values()].includes("runnable")) return;
    this.timer = setTimeout(() => {
      this.fail(new ControlExecutionLimitError(
        `Workflow control exceeded ${this.segmentTimeoutMs}ms without yielding to a host operation`,
      ));
    }, this.segmentTimeoutMs);
    this.timer.unref?.();
  }

  private finishSuccess(value: unknown): void {
    if (this.settled) return;
    this.phase = "finished";
    this.settled = true;
    this.resolveResult(value);
  }

  private finishFailure(error: unknown): void {
    if (this.settled) return;
    this.phase = "finished";
    this.settled = true;
    this.rejectResult(error);
  }

  private fail(error: unknown): void {
    if (this.settled || this.closing) return;
    this.closing = true;
    this.phase = "finished";
    try { this.options.onControlFailure?.(error); } catch { /* Failure handling must not replace the control error. */ }
    for (const waiter of this.callbackWaiters.values()) waiter.reject(error);
    this.callbackWaiters.clear();
    this.child.kill("SIGKILL");
    this.settled = true;
    this.rejectResult(error);
  }

  private cleanup(): void {
    if (this.timer) clearTimeout(this.timer);
    this.syncInput.end();
    if (!this.child.killed) this.child.kill("SIGKILL");
  }

  private send(message: HostProcessMessage): void {
    if (!this.child.connected) throw new ControlExecutionError("Workflow control process is disconnected");
    this.child.send(message, (error) => {
      if (error && !this.settled && !this.closing) this.fail(new ControlExecutionError(`Workflow control IPC failed: ${error.message}`));
    });
  }

  private sendSync(message: MetricResponseMessage): void {
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > CONTROL_WIRE_BYTES) throw new ControlExecutionLimitError("Workflow metric response exceeds its structural limit");
    this.syncInput.write(line);
  }

  private claimRequestId(requestId: string): void {
    if (this.requestIds.has(requestId)) throw new ControlExecutionError(`Duplicate workflow control request ${requestId}`);
    if (this.requestIds.size >= CONTROL_WIRE_NODES) {
      throw new ControlExecutionLimitError("Workflow control request count exceeds its structural limit");
    }
    this.requestIds.add(requestId);
  }
}

function assertExactKeys(value: object, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ControlExecutionError(`${label} has unexpected fields`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function encodeWire(
  value: unknown,
  options: { hostReference: (value: object) => { id: string; metric?: MetricMirrorState } | undefined },
): WireValue {
  const counter = wireCounter();
  const ancestors = new Set<object>();
  const visit = (current: unknown, depth: number): WireValue => {
    consumeWire(counter, depth, typeof current === "string" ? current : undefined);
    if (current === undefined) return { type: "undefined" };
    if (current === null || typeof current === "boolean" || typeof current === "string") {
      return { type: "primitive", value: current };
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) throw new ControlExecutionError("Control values require finite JSON numbers");
      return { type: "primitive", value: current };
    }
    if (!current || typeof current !== "object") throw new ControlExecutionError(`Unsupported control value ${typeof current}`);
    const reference = options.hostReference(current);
    if (reference) return reference.metric
      ? {
          type: "metric-ref",
          id: reference.id,
          state: visit(reference.metric, depth + 1),
        }
      : { type: "host-ref", id: reference.id };
    if (ancestors.has(current)) throw new ControlExecutionError("Cyclic workflow control values are unavailable");
    ancestors.add(current);
    try {
      if (Array.isArray(current)) return { type: "array", values: current.map((entry) => visit(entry, depth + 1)) };
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new ControlExecutionError("Workflow control objects must be plain data or host references");
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const entries: Array<[string, WireValue]> = [];
      for (const key of Object.keys(descriptors).sort()) {
        consumeWire(counter, depth + 1, key);
        const property = descriptors[key]!;
        if (!property.enumerable || !("value" in property)) {
          throw new ControlExecutionError(`Workflow control property ${key} must be enumerable data`);
        }
        entries.push([key, visit(property.value, depth + 1)]);
      }
      return { type: "object", entries };
    } finally {
      ancestors.delete(current);
    }
  };
  return visit(value, 0);
}

function isOpaqueHostReference(value: object): boolean {
  return Boolean(
    describeOpaqueArtifactRef(value) ||
    isCandidateWorkspaceCapability(value) ||
    describeOpaqueCandidateRef(value) ||
    describeOpaqueAcceptedCandidateRef(value) ||
    describeOpaqueCandidateWorkspace(value) ||
    describeOpaqueLaunchSnapshotRef(value),
  );
}

function mirroredMetricState(value: object): MetricMirrorState | undefined {
  try {
    const state = metricHandleState(value);
    return {
      metricId: state.metricId,
      definition: structuredClone(state.definition) as unknown as Record<string, unknown>,
      baseline: state.baseline,
      current: state.current,
      best: state.best,
      relativeGain: state.relativeGain,
      observationCount: state.observationCount,
    };
  } catch {
    return undefined;
  }
}

function serializeError(error: unknown, hostErrorId?: string): SerializedError {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const properties: NonNullable<SerializedError["properties"]> = {};
  for (const key of [
    "status", "operationPath", "expected", "actual", "attentionKind", "branchFailureKind", "point", "classification",
  ]) {
    const value = record?.[key];
    if (value === null || typeof value === "boolean") properties[key] = value;
    else if (typeof value === "string") properties[key] = boundedText(value, 16_000);
    else if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) properties[key] = value;
  }
  return {
    name: error instanceof Error ? error.name : "Error",
    message: boundedText(message, 16_000),
    ...(error instanceof Error && error.stack ? { stack: boundedText(error.stack, 32_000) } : {}),
    ...(hostErrorId ? { hostErrorId } : {}),
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
  };
}

function boundedSegmentTimeout(value: number | undefined): number {
  if (value === undefined) return CONTROL_SEGMENT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 25 || value > 10_000) throw new Error("Control segment timeout is invalid");
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[a-z0-9-]+$/.test(value)) {
    throw new ControlExecutionError(`Invalid ${label} id`);
  }
  return value;
}

function boundedText(value: string, maximum: number): string {
  let bytes = 0;
  let result = "";
  for (const scalar of value) {
    const size = Buffer.byteLength(scalar);
    if (bytes + size > maximum) break;
    result += scalar;
    bytes += size;
  }
  return result;
}

function wireCounter(): { nodes: number; bytes: number } {
  return { nodes: 0, bytes: 0 };
}

function consumeWire(counter: { nodes: number; bytes: number }, depth: number, text?: string): void {
  counter.nodes++;
  if (text !== undefined) counter.bytes += Buffer.byteLength(text);
  if (depth > CONTROL_WIRE_DEPTH || counter.nodes > CONTROL_WIRE_NODES || counter.bytes > CONTROL_WIRE_BYTES) {
    throw new ControlExecutionLimitError("Workflow control message exceeds its structural limit");
  }
}
