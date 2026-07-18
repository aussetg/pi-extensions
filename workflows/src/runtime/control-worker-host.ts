import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import {
  WORKFLOW_RUNTIME_API_HASH,
  type WorkflowDescriptorIdentity,
  type WorkflowProductIdentity,
  type WorkflowReferenceIdentity,
} from "../definition/workflow-language.js";
import type { ParsedWorkflow, WorkflowDescriptor } from "../definition/workflow-types.js";
import { FLOW_NAME_PATTERN } from "../definition/limits.js";
import { sha256 } from "../utils/hashes.js";
import {
  WorkflowControlAuthorityRegistry,
  type WorkflowControlAuthorityDescription,
} from "./control-authority.js";
import {
  parseWorkflowControlProcessMessage,
  parseWorkflowDescriptorIdentity,
  parseWorkflowProductIdentity,
  parseWorkflowReferenceIdentity,
  sameWorkflowWireIdentity,
  WORKFLOW_ASYNC_FLOW_METHODS,
  WORKFLOW_CONTROL_PROTOCOL_VERSION,
  WORKFLOW_SYNC_FLOW_METHODS,
  type WorkflowControlProcessMessage,
  type WorkflowFlowMethod,
  type WorkflowHostProcessMessage,
  type WorkflowMetricResponseMessage,
  type WorkflowSerializedError,
  type WorkflowSyncResponseMessage,
  type WorkflowWireValue,
} from "./control-protocol.js";

const WIRE_BYTES = 4 * 1024 * 1024;
const WIRE_DEPTH = 48;
const WIRE_NODES = 50_000;
const SEGMENT_TIMEOUT_MS = 1_000;
const INITIALIZATION_TIMEOUT_MS = 5_000;
const OLD_GENERATION_MB = 64;
const YOUNG_GENERATION_MB = 16;
const ASYNC_METHODS = new Set<string>(WORKFLOW_ASYNC_FLOW_METHODS);
const SYNC_METHODS = new Set<string>(WORKFLOW_SYNC_FLOW_METHODS);

export type WorkflowHostFlow = Partial<Record<
  WorkflowFlowMethod,
  (sourceSite: string, ...args: unknown[]) => unknown
>>;

export interface WorkflowControlOptions<TContext> {
  workflow: ParsedWorkflow;
  flow: WorkflowHostFlow;
  args: Record<string, unknown>;
  snapshot?: object;
  authority: WorkflowControlAuthorityRegistry;
  signal: AbortSignal;
  rootContext: TContext;
  currentContext: () => TContext;
  runInContext: <T>(context: TContext, body: () => T) => T;
  metricCall?: (metricSet: object, method: string, args: unknown[]) => unknown;
  segmentTimeoutMs?: number;
  onControlFailure?: (error: unknown) => void;
  onControlStart?: (pid: number) => void;
  definitionOnly?: boolean;
}

export class WorkflowControlExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowControlExecutionError";
  }
}

export class WorkflowControlExecutionLimitError extends WorkflowControlExecutionError {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowControlExecutionLimitError";
  }
}

/** Execute one reviewed v17 definition in its memory-bounded control process. */
export async function evaluateWorkflowControl<TContext>(
  options: WorkflowControlOptions<TContext>,
): Promise<unknown> {
  assertReviewedWorkflow(options.workflow);
  return await new WorkflowControlProcessBridge(options).run();
}

/** Evaluate constructors and metadata without invoking run(). */
export async function loadWorkflowControlDefinition(workflow: ParsedWorkflow): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new WorkflowControlExecutionLimitError(
    "Workflow v17 definition-only load timed out",
  )), INITIALIZATION_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const result = await evaluateWorkflowControl({
      workflow,
      flow: {},
      args: {},
      authority: new WorkflowControlAuthorityRegistry(`definition:${workflow.installedName}`),
      signal: controller.signal,
      rootContext: undefined,
      currentContext: () => undefined,
      runInContext: (_context, body) => body(),
      definitionOnly: true,
    });
    if (!plainRecord(result) || result.loaded !== true || result.name !== workflow.installedName) {
      throw new WorkflowControlExecutionError("Workflow v17 definition-only load returned an invalid binding");
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

class WorkflowControlProcessBridge<TContext> {
  private readonly segmentTimeoutMs: number;
  private readonly descriptors = new Map<string, WorkflowDescriptor>();
  private readonly operationSites = new Map<string, WorkflowFlowMethod>();
  private readonly hostReferences = new WeakMap<object, string>();
  private readonly referenceValues = new Map<string, object>();
  private readonly sourceSiteValues = new WeakMap<object, { sourceSite: string; method: WorkflowFlowMethod }>();
  private readonly callbackFunctions = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  private readonly callbackWaiters = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();
  private readonly invocationContexts = new Map<string, TContext>();
  private readonly invocationStates = new Map<string, "runnable" | "waiting">();
  private readonly hostErrors = new Map<string, unknown>();
  private readonly requestIds = new Set<string>();
  private readonly child: ChildProcess;
  private readonly syncInput: Writable;
  private readonly snapshot?: WorkflowWireValue;
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

  constructor(private readonly options: WorkflowControlOptions<TContext>) {
    this.segmentTimeoutMs = boundedSegmentTimeout(options.segmentTimeoutMs);
    for (const descriptor of options.workflow.descriptors) {
      if (this.descriptors.has(descriptor.identity.sourceSite)) {
        throw new WorkflowControlExecutionError(`Duplicate workflow v17 descriptor ${descriptor.identity.sourceSite}`);
      }
      this.descriptors.set(descriptor.identity.sourceSite, descriptor);
    }
    for (const site of options.workflow.operations) {
      if (this.operationSites.has(site.sourceSite)) {
        throw new WorkflowControlExecutionError(`Duplicate workflow v17 operation site ${site.sourceSite}`);
      }
      this.operationSites.set(site.sourceSite, site.method);
    }
    this.snapshot = options.snapshot === undefined ? undefined : this.encode(options.snapshot);
    this.child = fork(fileURLToPath(new URL("./control-worker.js", import.meta.url)), [], {
      execArgv: [
        `--max-old-space-size=${OLD_GENERATION_MB}`,
        `--max-semi-space-size=${YOUNG_GENERATION_MB}`,
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
      throw new WorkflowControlExecutionError("Workflow v17 control process has no synchronous response pipe");
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
    this.child.on("message", message => this.onMessage(message));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-64 * 1024);
    });
    this.child.once("error", error => {
      const limited = /memory limit|heap out of memory|allocation failed/iu.test(error.message);
      this.fail(limited
        ? new WorkflowControlExecutionLimitError("Workflow v17 control exceeded its memory limit")
        : new WorkflowControlExecutionError(`Workflow v17 control process failed: ${error.message}`));
    });
    this.child.once("exit", (code, signal) => {
      if (this.settled || this.closing) return;
      const limited = /heap out of memory|allocation failed|fatal process out of memory/iu.test(this.stderr);
      this.fail(limited
        ? new WorkflowControlExecutionLimitError("Workflow v17 control exceeded its memory limit")
        : new WorkflowControlExecutionError(
          `Workflow v17 control process exited before completion (${signal ?? code ?? "unknown"})`,
        ));
    });
    const abort = () => this.fail(this.options.signal.reason instanceof Error
      ? this.options.signal.reason
      : new WorkflowControlExecutionError("Workflow v17 control was aborted"));
    this.options.signal.addEventListener("abort", abort, { once: true });
    if (this.options.signal.aborted) abort();
    else {
      this.send(this.initializeMessage());
      this.refreshTimer();
    }
    try {
      return await result;
    } finally {
      this.options.signal.removeEventListener("abort", abort);
      this.cleanup();
    }
  }

  private initializeMessage(): WorkflowHostProcessMessage {
    const workflow = this.options.workflow;
    return {
      type: "initialize",
      protocolVersion: WORKFLOW_CONTROL_PROTOCOL_VERSION,
      runtimeApiHash: WORKFLOW_RUNTIME_API_HASH,
      executableSource: workflow.executableSource,
      workflowName: workflow.installedName,
      metadata: this.encodePlain(workflow.metadata),
      descriptors: workflow.descriptors.map(descriptor => ({
        identity: structuredClone(descriptor.identity),
        definition: this.encodePlain(descriptorDefinition(descriptor)),
      })),
      operationSites: workflow.operations.map(site => ({ sourceSite: site.sourceSite, method: site.method })),
      args: this.encode(this.options.args),
      ...(this.snapshot ? { snapshot: this.snapshot } : {}),
      segmentTimeoutMs: this.segmentTimeoutMs,
      definitionOnly: this.options.definitionOnly === true,
    };
  }

  private onMessage(raw: unknown): void {
    if (this.settled || this.closing) return;
    try {
      const message = parseWorkflowControlProcessMessage(raw);
      if (message.type === "initialized") {
        if (this.phase !== "starting") throw new WorkflowControlExecutionError("Workflow v17 control initialized twice");
        this.phase = "running";
        this.invocationStates.set("root", "runnable");
        this.refreshTimer();
        if (this.child.pid !== undefined) {
          try { this.options.onControlStart?.(this.child.pid); } catch { /* Observability only. */ }
        }
        return;
      }
      if (this.phase !== "running") throw new WorkflowControlExecutionError("Workflow v17 message arrived before initialization");
      if (message.type === "host-call") {
        this.claimRequestId(message.requestId);
        void this.handleHostCall(message);
        return;
      }
      if (message.type === "sync-call") {
        this.claimRequestId(message.requestId);
        this.handleSyncCall(message);
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
      this.fail(error instanceof WorkflowControlExecutionError
        ? error
        : new WorkflowControlExecutionError(`Malformed workflow v17 control message: ${errorMessage(error)}`));
    }
  }

  private async handleHostCall(
    message: Extract<WorkflowControlProcessMessage, { type: "host-call" }>,
  ): Promise<void> {
    const { requestId, invocationId, method } = message;
    if (!this.invocationContexts.has(invocationId)) {
      this.fail(new WorkflowControlExecutionError("Malformed workflow v17 host invocation"));
      return;
    }
    const context = this.invocationContexts.get(invocationId)!;
    const callable = this.options.flow[method];
    if (!ASYNC_METHODS.has(method) || typeof callable !== "function") {
      this.fail(new WorkflowControlExecutionError(`Unavailable workflow v17 method ${method}`));
      return;
    }
    this.invocationStates.set(invocationId, "waiting");
    this.refreshTimer();
    try {
      const { sourceSite, args } = this.decodeInvocation(message.args, method);
      const value = await Promise.resolve(this.options.runInContext(context, () => callable(sourceSite, ...args)));
      if (this.settled || this.closing) return;
      this.invocationStates.set(invocationId, "runnable");
      this.send({ type: "host-response", requestId, value: this.encode(value) });
      this.refreshTimer();
    } catch (error) {
      if (this.settled || this.closing) return;
      this.invocationStates.set(invocationId, "runnable");
      this.send({ type: "host-response", requestId, error: this.serializeHostError(error) });
      this.refreshTimer();
    }
  }

  private handleSyncCall(
    message: Extract<WorkflowControlProcessMessage, { type: "sync-call" }>,
  ): void {
    const { requestId, invocationId, method } = message;
    if (!this.invocationContexts.has(invocationId)) {
      this.fail(new WorkflowControlExecutionError("Malformed workflow v17 synchronous invocation"));
      return;
    }
    const context = this.invocationContexts.get(invocationId)!;
    this.invocationStates.set(invocationId, "waiting");
    this.refreshTimer();
    try {
      const callable = this.options.flow[method];
      if (!SYNC_METHODS.has(method) || typeof callable !== "function") {
        throw new WorkflowControlExecutionError(`Unavailable workflow v17 synchronous method ${method}`);
      }
      const { sourceSite, args } = this.decodeInvocation(message.args, method);
      const value = this.options.runInContext(context, () => callable(sourceSite, ...args));
      if (value && typeof (value as PromiseLike<unknown>).then === "function") {
        throw new WorkflowControlExecutionError(`Workflow v17 flow.${method} must be synchronous`);
      }
      this.sendSync({ type: "sync-response", requestId, value: this.encode(value) });
    } catch (error) {
      this.sendSync({ type: "sync-response", requestId, error: this.serializeHostError(error) });
    } finally {
      this.invocationStates.set(invocationId, "runnable");
      this.refreshTimer();
    }
  }

  private handleMetricCall(
    message: Extract<WorkflowControlProcessMessage, { type: "metric-call" }>,
  ): void {
    const { requestId, invocationId, referenceId, method } = message;
    if (!this.invocationContexts.has(invocationId)) {
      this.fail(new WorkflowControlExecutionError("Malformed workflow v17 metric invocation"));
      return;
    }
    const context = this.invocationContexts.get(invocationId)!;
    this.invocationStates.set(invocationId, "waiting");
    this.refreshTimer();
    try {
      const metricSet = this.referenceValues.get(referenceId);
      const description = metricSet ? this.options.authority.transport(metricSet) : undefined;
      if (!metricSet || description?.family !== "reference" || description.identity.kind !== "metric-set") {
        throw new WorkflowControlExecutionError("Unknown workflow v17 metric-set reference");
      }
      if (typeof this.options.metricCall !== "function") {
        throw new WorkflowControlExecutionError("Workflow v17 metric-set methods are unavailable");
      }
      const args = this.decode(message.args);
      if (!Array.isArray(args)) throw new WorkflowControlExecutionError("Workflow v17 metric-set arguments are invalid");
      const value = this.options.runInContext(context, () => this.options.metricCall!(metricSet, method, args));
      if (value && typeof (value as PromiseLike<unknown>).then === "function") {
        throw new WorkflowControlExecutionError("Workflow v17 metric-set methods must be synchronous");
      }
      this.sendMetric({ type: "metric-response", requestId, value: this.encode(value) });
    } catch (error) {
      this.sendMetric({ type: "metric-response", requestId, error: this.serializeHostError(error) });
    } finally {
      this.invocationStates.set(invocationId, "runnable");
      this.refreshTimer();
    }
  }

  private decodeInvocation(value: WorkflowWireValue, method: WorkflowFlowMethod): {
    sourceSite: string;
    args: unknown[];
  } {
    const decoded = this.decode(value);
    if (!Array.isArray(decoded) || decoded.length < 1) {
      throw new WorkflowControlExecutionError(`Workflow v17 flow.${method} arguments are invalid`);
    }
    const [siteValue, ...args] = decoded;
    if (!siteValue || typeof siteValue !== "object") {
      throw new WorkflowControlExecutionError(`Workflow v17 flow.${method} lacks source-site authority`);
    }
    const site = this.sourceSiteValues.get(siteValue);
    if (!site || site.method !== method) {
      throw new WorkflowControlExecutionError(`Workflow v17 flow.${method} source site is invalid`);
    }
    return { sourceSite: site.sourceSite, args };
  }

  private handleCallbackResult(
    message: Extract<WorkflowControlProcessMessage, { type: "callback-result" }>,
  ): void {
    const waiter = this.callbackWaiters.get(message.invocationId);
    if (!waiter) {
      this.fail(new WorkflowControlExecutionError(`Unknown workflow v17 callback invocation ${message.invocationId}`));
      return;
    }
    this.callbackWaiters.delete(message.invocationId);
    this.invocationContexts.delete(message.invocationId);
    this.invocationStates.delete(message.invocationId);
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
      if (this.settled) return Promise.reject(new WorkflowControlExecutionError("Workflow v17 control process is unavailable"));
      const invocationId = `callback-${this.nextCallbackInvocation++}`;
      const context = this.options.currentContext();
      this.invocationContexts.set(invocationId, context);
      this.invocationStates.set(invocationId, "runnable");
      const result = new Promise<unknown>((resolve, reject) => this.callbackWaiters.set(invocationId, { resolve, reject }));
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

  private encode(value: unknown): WorkflowWireValue {
    return encodeWire(value, {
      authority: object => this.authorityReference(object),
    });
  }

  private encodePlain(value: unknown): WorkflowWireValue {
    return encodeWire(value, { authority: () => undefined });
  }

  private authorityReference(value: object): AuthorityTransport | undefined {
    const description = this.options.authority.transport(value);
    if (!description) return undefined;
    let id = this.hostReferences.get(value);
    if (!id) {
      id = `authority-${this.nextReference++}`;
      this.hostReferences.set(value, id);
      this.referenceValues.set(id, value);
    }
    return { id, description };
  }

  private decode(value: WorkflowWireValue): unknown {
    const counter = wireCounter();
    const visit = (wire: WorkflowWireValue, depth: number): unknown => {
      if (!wire || typeof wire !== "object" || Array.isArray(wire) || typeof wire.type !== "string") {
        throw new WorkflowControlExecutionError("Malformed workflow v17 wire value");
      }
      consumeWire(counter, depth, wire.type === "primitive" && typeof wire.value === "string" ? wire.value : undefined);
      if (wire.type === "undefined") {
        assertExactKeys(wire, ["type"], "undefined wire value");
        return undefined;
      }
      if (wire.type === "primitive") {
        assertExactKeys(wire, ["type", "value"], "primitive wire value");
        if (wire.value !== null && typeof wire.value !== "boolean" && typeof wire.value !== "string"
          && (typeof wire.value !== "number" || !Number.isFinite(wire.value) || Object.is(wire.value, -0))) {
          throw new WorkflowControlExecutionError("Malformed workflow v17 primitive");
        }
        return wire.value;
      }
      if (wire.type === "source-site") {
        assertExactKeys(wire, ["type", "sourceSite"], "source-site wire value");
        const method = this.operationSites.get(wire.sourceSite);
        if (!method) throw new WorkflowControlExecutionError(`Unknown workflow v17 operation site ${wire.sourceSite}`);
        const value = Object.freeze(Object.create(null) as object);
        this.sourceSiteValues.set(value, { sourceSite: wire.sourceSite, method });
        return value;
      }
      if (wire.type === "descriptor-ref") {
        assertExactKeys(wire, ["type", "id", "identity"], "descriptor-ref wire value");
        const id = requireId(wire.id, "descriptor transport");
        const identity = parseWorkflowDescriptorIdentity(wire.identity);
        const existing = this.referenceValues.get(id);
        if (existing) {
          this.assertReference(existing, "descriptor", identity);
          return existing;
        }
        const descriptor = this.descriptors.get(identity.sourceSite);
        if (!descriptor || !sameWorkflowWireIdentity(descriptor.identity, identity)) {
          throw new WorkflowControlExecutionError(`Unknown or changed workflow v17 descriptor ${identity.sourceSite}`);
        }
        const value = this.options.authority.descriptor(descriptor);
        this.hostReferences.set(value, id);
        this.referenceValues.set(id, value);
        return value;
      }
      if (wire.type === "product-ref" || wire.type === "reference-ref") {
        assertExactKeys(wire, ["type", "id", "identity"], `${wire.type} wire value`);
        const id = requireId(wire.id, `${wire.type} transport`);
        const identity = wire.type === "product-ref"
          ? parseWorkflowProductIdentity(wire.identity)
          : parseWorkflowReferenceIdentity(wire.identity);
        const existing = this.referenceValues.get(id);
        if (!existing) throw new WorkflowControlExecutionError(`Unknown workflow v17 authority reference ${id}`);
        this.assertReference(existing, wire.type === "product-ref" ? "product" : "reference", identity);
        return existing;
      }
      if (wire.type === "callback") {
        assertExactKeys(wire, ["type", "id"], "callback wire value");
        return this.remoteCallback(requireId(wire.id, "callback"));
      }
      if (wire.type === "array") {
        assertExactKeys(wire, ["type", "values"], "array wire value");
        if (!Array.isArray(wire.values)) throw new WorkflowControlExecutionError("Malformed workflow v17 array");
        return wire.values.map(entry => visit(entry, depth + 1));
      }
      if (wire.type === "object") {
        assertExactKeys(wire, ["type", "entries"], "object wire value");
        if (!Array.isArray(wire.entries)) throw new WorkflowControlExecutionError("Malformed workflow v17 object");
        const result = Object.create(null) as Record<string, unknown>;
        const seen = new Set<string>();
        for (const entry of wire.entries) {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
            throw new WorkflowControlExecutionError("Malformed workflow v17 object entry");
          }
          if (seen.has(entry[0])) throw new WorkflowControlExecutionError(`Duplicate workflow v17 property ${entry[0]}`);
          seen.add(entry[0]);
          consumeWire(counter, depth + 1, entry[0]);
          result[entry[0]] = visit(entry[1], depth + 1);
        }
        return result;
      }
      throw new WorkflowControlExecutionError(`Control process sent unavailable workflow v17 wire type ${wire.type}`);
    };
    return visit(value, 0);
  }

  private assertReference(
    value: object,
    family: WorkflowControlAuthorityDescription["family"],
    identity: WorkflowControlAuthorityDescription["identity"],
  ): void {
    const description = this.options.authority.transport(value);
    if (!description || description.family !== family || !sameWorkflowWireIdentity(description.identity, identity)) {
      throw new WorkflowControlExecutionError(`Workflow v17 ${family} authority identity changed`);
    }
  }

  private serializeHostError(error: unknown): WorkflowSerializedError {
    const id = `host-error-${this.nextHostError++}`;
    this.hostErrors.set(id, error);
    return serializeError(error, id);
  }

  private deserializeError(error: WorkflowSerializedError): unknown {
    if (error.hostErrorId && this.hostErrors.has(error.hostErrorId)) return this.hostErrors.get(error.hostErrorId);
    if (error.name === "WorkflowControlExecutionLimitError"
      || /script execution timed out|control message exceeds its structural limit/iu.test(error.message)) {
      return new WorkflowControlExecutionLimitError(error.message);
    }
    const result = new Error(error.message);
    result.name = error.name;
    if (error.stack) result.stack = error.stack;
    if (error.properties) Object.assign(result, error.properties);
    return result;
  }

  private refreshTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.settled || this.closing) return;
    if (this.phase === "starting") {
      this.timer = setTimeout(() => this.fail(new WorkflowControlExecutionLimitError(
        "Workflow v17 control initialization timed out",
      )), INITIALIZATION_TIMEOUT_MS);
      this.timer.unref?.();
      return;
    }
    if (this.phase !== "running" || ![...this.invocationStates.values()].includes("runnable")) return;
    this.timer = setTimeout(() => this.fail(new WorkflowControlExecutionLimitError(
      `Workflow v17 control exceeded ${this.segmentTimeoutMs}ms without yielding to a host operation`,
    )), this.segmentTimeoutMs);
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
    try { this.options.onControlFailure?.(error); } catch { /* Failure handling cannot replace the error. */ }
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

  private send(message: WorkflowHostProcessMessage): void {
    if (!this.child.connected) throw new WorkflowControlExecutionError("Workflow v17 control process is disconnected");
    this.child.send(message, error => {
      if (error && !this.settled && !this.closing) {
        this.fail(new WorkflowControlExecutionError(`Workflow v17 control IPC failed: ${error.message}`));
      }
    });
  }

  private sendSync(message: WorkflowSyncResponseMessage): void {
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > WIRE_BYTES) throw new WorkflowControlExecutionLimitError(
      "Workflow v17 synchronous response exceeds its structural limit",
    );
    this.syncInput.write(line);
  }

  private sendMetric(message: WorkflowMetricResponseMessage): void {
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > WIRE_BYTES) throw new WorkflowControlExecutionLimitError(
      "Workflow v17 metric response exceeds its structural limit",
    );
    this.syncInput.write(line);
  }

  private claimRequestId(requestId: string): void {
    if (this.requestIds.has(requestId)) throw new WorkflowControlExecutionError(`Duplicate workflow v17 request ${requestId}`);
    if (this.requestIds.size >= WIRE_NODES) throw new WorkflowControlExecutionLimitError(
      "Workflow v17 request count exceeds its structural limit",
    );
    this.requestIds.add(requestId);
  }
}

interface AuthorityTransport {
  id: string;
  description: WorkflowControlAuthorityDescription;
}

function encodeWire(
  value: unknown,
  options: { authority(value: object): AuthorityTransport | undefined },
): WorkflowWireValue {
  const counter = wireCounter();
  const ancestors = new Set<object>();
  const visit = (current: unknown, depth: number): WorkflowWireValue => {
    consumeWire(counter, depth, typeof current === "string" ? current : undefined);
    if (current === undefined) return { type: "undefined" };
    if (current === null || typeof current === "boolean" || typeof current === "string") {
      return { type: "primitive", value: current };
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) throw new WorkflowControlExecutionError(
        "Workflow v17 control values require finite numbers",
      );
      return { type: "primitive", value: current };
    }
    if (!current || typeof current !== "object") throw new WorkflowControlExecutionError(
      `Unsupported workflow v17 control value ${typeof current}`,
    );
    const authority = options.authority(current);
    if (authority) {
      const { id, description } = authority;
      if (description.family === "descriptor") {
        return {
          type: "descriptor-ref",
          id,
          identity: structuredClone(description.identity) as WorkflowDescriptorIdentity,
        };
      }
      const fields = Object.entries(description.fields).map(([name, field]) => {
        consumeWire(counter, depth + 1, name);
        return [name, visit(field, depth + 1)] as [string, WorkflowWireValue];
      });
      return description.family === "product"
        ? {
            type: "product",
            id,
            identity: structuredClone(description.identity) as WorkflowProductIdentity,
            fields,
          }
        : {
            type: "reference",
            id,
            identity: structuredClone(description.identity) as WorkflowReferenceIdentity,
            fields,
          };
    }
    if (ancestors.has(current)) throw new WorkflowControlExecutionError("Cyclic workflow v17 control values are unavailable");
    ancestors.add(current);
    try {
      if (Array.isArray(current)) return { type: "array", values: current.map(entry => visit(entry, depth + 1)) };
      if (!plainRecord(current)) throw new WorkflowControlExecutionError(
        "Workflow v17 control objects must be plain data or authority values",
      );
      const entries: Array<[string, WorkflowWireValue]> = [];
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current)).sort(([left], [right]) => left.localeCompare(right))) {
        consumeWire(counter, depth + 1, key);
        if (!descriptor.enumerable || descriptor.get || descriptor.set || !("value" in descriptor)) {
          throw new WorkflowControlExecutionError(`Workflow v17 property ${key} must be enumerable data`);
        }
        entries.push([key, visit(descriptor.value, depth + 1)]);
      }
      return { type: "object", entries };
    } finally {
      ancestors.delete(current);
    }
  };
  return visit(value, 0);
}

function descriptorDefinition(descriptor: WorkflowDescriptor): Record<string, unknown> {
  if (descriptor.kind === "agent-task") {
    return {
      profile: descriptor.profile,
      output: descriptor.output,
      workspace: descriptor.workspace,
      network: descriptor.network,
      ...(descriptor.instructions ? { instructions: descriptor.instructions } : {}),
      ...(descriptor.title ? { title: descriptor.title } : {}),
    };
  }
  return {
    profile: descriptor.profile,
    output: descriptor.output,
    effect: descriptor.effect,
    allowFailure: descriptor.allowFailure,
    ...(descriptor.title ? { title: descriptor.title } : {}),
  };
}

function assertReviewedWorkflow(workflow: ParsedWorkflow): void {
  if (!workflow || workflow.formatVersion !== 1 || !FLOW_NAME_PATTERN.test(workflow.installedName)
    || workflow.transform.runtimeApiHash !== WORKFLOW_RUNTIME_API_HASH
    || workflow.transform.executableSourceHash !== sha256(workflow.executableSource)) {
    throw new WorkflowControlExecutionError("Workflow v17 control input is not an exact reviewed executable");
  }
}

function serializeError(error: unknown, hostErrorId?: string): WorkflowSerializedError {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const properties: NonNullable<WorkflowSerializedError["properties"]> = {};
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
    message: boundedText(errorMessage(error), 16_000),
    ...(error instanceof Error && error.stack ? { stack: boundedText(error.stack, 32_000) } : {}),
    ...(hostErrorId ? { hostErrorId } : {}),
    ...(Object.keys(properties).length ? { properties } : {}),
  };
}

function assertExactKeys(value: object, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new WorkflowControlExecutionError(`${label} has unexpected fields`);
  }
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,127}$/u.test(value)) {
    throw new WorkflowControlExecutionError(`Invalid workflow v17 ${label} id`);
  }
  return value;
}

function boundedSegmentTimeout(value: number | undefined): number {
  if (value === undefined) return SEGMENT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 25 || value > 10_000) throw new WorkflowControlExecutionError(
    "Workflow v17 control segment timeout is invalid",
  );
  return value;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function wireCounter(): { nodes: number; bytes: number } {
  return { nodes: 0, bytes: 0 };
}

function consumeWire(counter: { nodes: number; bytes: number }, depth: number, text?: string): void {
  counter.nodes++;
  if (text !== undefined) counter.bytes += Buffer.byteLength(text);
  if (depth > WIRE_DEPTH || counter.nodes > WIRE_NODES || counter.bytes > WIRE_BYTES) {
    throw new WorkflowControlExecutionLimitError("Workflow v17 control message exceeds its structural limit");
  }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
