import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalJsonObject, canonicalJsonValue, deepFreezeJson } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import type {
  WorkflowEffectSettlementV17Record,
  WorkflowOperationV17Kind,
  WorkflowOperationV17Record,
  WorkflowRunV17Record,
  WorkflowScopeCallV17Record,
  WorkflowScopeV17Record,
} from "../persistence/run-database-v17-types.js";
import {
  WorkflowRunDatabaseV17,
  WorkflowRunDatabaseV17AdmissionError,
  WorkflowRunDatabaseV17RevisionConflictError,
  WorkflowRunDatabaseV17StateError,
} from "../persistence/run-database-v17.js";
import type { JsonObject, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import {
  workflowV17FreshCallKey,
  workflowV17OperationIdentity,
} from "./causal-identity-v17.js";
import type { WorkflowV17CausalReplay } from "./causal-replay-v17.js";

const MAX_REVISION_RETRIES = 16;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const EFFECT_KINDS = new Set<WorkflowOperationV17Kind>([
  "agent", "command", "ask", "measure", "verify", "accept", "reject", "record-experiment", "apply",
]);

export type WorkflowV17SemanticEngineFaultPoint =
  | "after-run-start"
  | "after-operation-claim"
  | "after-effect-settled"
  | "after-operation-complete"
  | "after-operation-failure"
  | "after-root-scope-complete"
  | "after-root-scope-failure";

type WorkflowV17EffectKind = Exclude<WorkflowOperationV17Kind, "parallel" | "map" | "metrics" | "candidate">;

export interface WorkflowV17EffectInvocation {
  sourceSite: string;
  descriptorSourceSite?: string;
  title?: string;
  input: unknown;
}

export interface WorkflowV17EffectIdentity {
  semanticKey: string;
  completionAuthority: Exclude<WorkflowScopeCallV17Record["completionAuthority"], "structural-join">;
  replayPolicy: WorkflowScopeCallV17Record["replayPolicy"];
}

export interface WorkflowV17EffectAdapterContext {
  run: WorkflowRunV17Record;
  input: unknown;
  semanticInput: JsonValue;
  operation?: WorkflowOperationV17Record;
  signal: AbortSignal;
}

export interface WorkflowV17EffectRestoreContext extends WorkflowV17EffectAdapterContext {
  operation: WorkflowOperationV17Record;
  call: WorkflowScopeCallV17Record;
  result: JsonValue;
}

export interface WorkflowV17SemanticEffectAdapter {
  readonly kind: WorkflowV17EffectKind;
  semanticInput(context: Omit<WorkflowV17EffectAdapterContext, "semanticInput" | "operation">): JsonValue | Promise<JsonValue>;
  journalIdentity(context: WorkflowV17EffectAdapterContext & { operation: WorkflowOperationV17Record }): WorkflowV17EffectIdentity | Promise<WorkflowV17EffectIdentity>;
  execute(context: WorkflowV17EffectAdapterContext & { operation: WorkflowOperationV17Record }): JsonValue | Promise<JsonValue>;
  restore?(context: WorkflowV17EffectRestoreContext): unknown;
}

export interface WorkflowV17SequentialFlow {
  effect<T = JsonValue>(kind: WorkflowV17EffectKind, invocation: WorkflowV17EffectInvocation): Promise<T>;
}

export type WorkflowV17SemanticRunOutcome<T extends JsonValue = JsonValue> =
  | { status: "completed"; result: T; terminalKey: string }
  | { status: "failed"; failure: JsonObject }
  | { status: "paused"; failure: JsonObject };

export interface WorkflowV17SemanticEngineOptions {
  replay?: WorkflowV17CausalReplay;
  signal?: AbortSignal;
  operationAdmissionLimit?: number;
  now?: () => Date;
  faultInjector?: (
    point: WorkflowV17SemanticEngineFaultPoint,
    operation?: WorkflowOperationV17Record,
  ) => void | Promise<void>;
}

interface CursorScope {
  record: WorkflowScopeV17Record;
  cursor: number;
  previousCallKey: string;
}

export class WorkflowV17SemanticEngineCrashError extends Error {
  constructor(
    readonly point: WorkflowV17SemanticEngineFaultPoint,
    readonly operationPath?: string,
  ) {
    super(`Workflow v17 simulated crash at ${point}${operationPath ? ` ${operationPath}` : ""}`);
    this.name = "WorkflowV17SemanticEngineCrashError";
  }
}

export class WorkflowV17SemanticDriftError extends Error {
  constructor(message: string, readonly operationPath?: string) {
    super(message);
    this.name = "WorkflowV17SemanticDriftError";
  }
}

export class WorkflowV17RecordedEffectError extends Error {
  readonly operationPath: string;
  readonly failure: JsonObject;

  constructor(operationPath: string, failure: JsonObject) {
    super(typeof failure.summary === "string" ? failure.summary : `Recorded workflow effect failed at ${operationPath}`);
    this.name = "WorkflowV17RecordedEffectError";
    this.operationPath = operationPath;
    this.failure = deepFreezeJson(structuredClone(failure));
  }
}

/** Sequential v17 execution. Structured child scopes are added by phase 9. */
export class WorkflowV17SemanticEngine {
  private readonly storage = new AsyncLocalStorage<CursorScope>();
  private readonly adapters = new Map<WorkflowV17EffectKind, WorkflowV17SemanticEffectAdapter>();
  private readonly controller = new AbortController();
  private readonly now: () => Date;
  private readonly operationAdmissionLimit: number;
  private readonly externalAbort?: () => void;
  private running = false;
  private used = false;
  private fatalFault?: unknown;

  constructor(
    readonly database: WorkflowRunDatabaseV17,
    adapters: readonly WorkflowV17SemanticEffectAdapter[],
    readonly options: WorkflowV17SemanticEngineOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.operationAdmissionLimit = boundedOperationAdmissionLimit(
      options.operationAdmissionLimit ?? DEFINITION_LIMITS.semanticOperations,
    );
    for (const adapter of adapters) {
      if (!EFFECT_KINDS.has(adapter.kind)) throw new TypeError(`Workflow v17 ${adapter.kind} is not a sequential effect`);
      if (this.adapters.has(adapter.kind)) throw new TypeError(`Duplicate workflow v17 effect adapter ${adapter.kind}`);
      this.adapters.set(adapter.kind, adapter);
    }
    if (options.signal) {
      this.externalAbort = () => {
        if (!this.controller.signal.aborted) this.controller.abort(options.signal!.reason);
      };
      options.signal.addEventListener("abort", this.externalAbort, { once: true });
      if (options.signal.aborted) this.externalAbort();
    }
  }

  async run<T extends JsonValue>(
    body: (flow: WorkflowV17SequentialFlow) => T | Promise<T>,
  ): Promise<WorkflowV17SemanticRunOutcome<T>> {
    if (this.running || this.used) throw new Error("Workflow v17 semantic engine instances execute exactly once");
    this.running = true;
    this.used = true;
    try {
      await this.startRun();
      const root = this.database.readScope(this.database.readRun().rootScopeId);
      if (!root) throw new Error("Workflow v17 root scope is missing");
      const scope: CursorScope = { record: root, cursor: 0, previousCallKey: root.seedKey };
      try {
        const raw = await this.storage.run(scope, async () => await body(this.flowApi()));
        if (this.fatalFault !== undefined) throw this.fatalFault;
        if (this.controller.signal.aborted) throw this.controller.signal.reason;
        const result = canonical(raw) as T;
        const terminalKey = scope.previousCallKey;
        await this.completeRootScope(scope, terminalKey);
        await this.transitionRun("completed", undefined, terminalKey);
        return { status: "completed", result: structuredClone(result), terminalKey };
      } catch (error) {
        if (this.fatalFault !== undefined) throw this.fatalFault;
        if (isPassthrough(error)) throw error;
        if (error instanceof WorkflowRunDatabaseV17AdmissionError) {
          const failure = failureReason("workflow", `admission-${error.limit}`, error.message, true);
          await this.transitionRun("paused", failure);
          return { status: "paused", failure };
        }
        if (this.controller.signal.aborted) {
          const failure = failureReason("workflow", "cancelled", "Workflow control was cancelled", true);
          await this.transitionRun("paused", failure);
          return { status: "paused", failure };
        }
        const failure = failureFromError(error);
        try {
          await this.failRootScope(scope, failure);
        } catch (scopeError) {
          if (!(scopeError instanceof WorkflowRunDatabaseV17StateError)
            || !/unsettled operations/u.test(scopeError.message)) throw scopeError;
          // An adapter/protocol failure can occur after claim but before a
          // durable effect outcome exists. The terminal run transition below
          // cancels that operation and its active scope atomically.
        }
        await this.transitionRun("failed", failure);
        return { status: "failed", failure };
      }
    } finally {
      this.running = false;
      if (this.options.signal && this.externalAbort) {
        this.options.signal.removeEventListener("abort", this.externalAbort);
      }
    }
  }

  private flowApi(): WorkflowV17SequentialFlow {
    return Object.freeze({
      effect: async <T>(kind: WorkflowV17EffectKind, invocation: WorkflowV17EffectInvocation): Promise<T> =>
        await this.effect(kind, invocation) as T,
    });
  }

  private async effect(kind: WorkflowV17EffectKind, invocation: WorkflowV17EffectInvocation): Promise<unknown> {
    if (this.fatalFault !== undefined) throw this.fatalFault;
    if (this.controller.signal.aborted) throw this.controller.signal.reason;
    if (!EFFECT_KINDS.has(kind)) throw new TypeError(`Workflow v17 ${kind} is not a sequential effect`);
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`No workflow v17 adapter for ${kind}`);
    const scope = this.scope();
    const run = this.database.readRun();
    const semanticInput = canonical(await adapter.semanticInput({
      run,
      input: invocation.input,
      signal: this.controller.signal,
    }));
    const cursor = scope.cursor++;
    const claimed = await this.claim(scope, cursor, kind, invocation, stableHash(semanticInput));
    const operation = claimed.operation;
    if (claimed.claimed) await this.fault("after-operation-claim", operation);
    const identity = normalizeIdentity(await adapter.journalIdentity({
      run: this.database.readRun(),
      input: invocation.input,
      semanticInput,
      operation,
      signal: this.controller.signal,
    }), kind);

    if (operation.status === "completed" || operation.status === "failed") {
      return this.restoreCommitted(scope, adapter, invocation.input, semanticInput, operation, identity);
    }
    if (operation.status !== "running" && operation.status !== "waiting") {
      throw new WorkflowV17SemanticDriftError(
        `Workflow v17 operation ${operation.path} cannot resume from ${operation.status}`,
        operation.path,
      );
    }

    const settlement = this.database.readEffectSettlement(operation.operationId);
    if (settlement) {
      assertSettlementIdentity(operation, settlement, identity);
      return await this.completeSettlement(scope, adapter, invocation.input, semanticInput, operation, settlement);
    }

    if (this.options.replay) {
      const decision = await this.options.replay.tryReplayCall({
        operationId: operation.operationId,
        semanticKey: identity.semanticKey,
        completionAuthority: identity.completionAuthority,
        replayPolicy: identity.replayPolicy,
        at: this.timestamp(),
      });
      if (decision.kind === "hit") {
        const current = this.database.readOperation(operation.operationId)!;
        await this.fault("after-operation-complete", current);
        return this.restoreCommitted(scope, adapter, invocation.input, semanticInput, current, identity);
      }
    }

    let result: JsonValue;
    try {
      if (this.controller.signal.aborted) throw this.controller.signal.reason;
      result = canonical(await adapter.execute({
        run: this.database.readRun(),
        input: invocation.input,
        semanticInput,
        operation,
        signal: this.controller.signal,
      }));
    } catch (error) {
      if (isPassthrough(error)) throw error;
      if (this.controller.signal.aborted) throw error;
      const failure = failureFromError(error);
      const settled = await this.settle(operation, {
        ...identity,
        replayPolicy: "never",
      }, { outcome: "failure", failure });
      await this.fault("after-effect-settled", operation);
      return await this.completeSettlement(scope, adapter, invocation.input, semanticInput, operation, settled);
    }
    const settled = await this.settle(operation, identity, { outcome: "success", result });
    await this.fault("after-effect-settled", operation);
    return await this.completeSettlement(scope, adapter, invocation.input, semanticInput, operation, settled);
  }

  private restoreCommitted(
    scope: CursorScope,
    adapter: WorkflowV17SemanticEffectAdapter,
    input: unknown,
    semanticInput: JsonValue,
    operation: WorkflowOperationV17Record,
    identity: WorkflowV17EffectIdentity,
  ): unknown {
    const call = this.database.readScopeCall(operation.operationId);
    if (!call || call.previousCallKey !== scope.previousCallKey || call.semanticKey !== identity.semanticKey
      || call.completionAuthority !== identity.completionAuthority
      || (call.outcome === "success" && call.replayPolicy !== identity.replayPolicy)
      || (call.outcome === "failure" && call.replayPolicy !== "never")) {
      throw new WorkflowV17SemanticDriftError(
        `Workflow v17 same-run call changed identity at ${operation.path}`,
        operation.path,
      );
    }
    scope.previousCallKey = call.callKey;
    if (call.outcome === "failure") throw new WorkflowV17RecordedEffectError(operation.path, operation.failure!);
    const result = structuredClone(operation.result!);
    return adapter.restore?.({
      run: this.database.readRun(),
      input,
      semanticInput,
      operation,
      call,
      result,
      signal: this.controller.signal,
    }) ?? result;
  }

  private async completeSettlement(
    scope: CursorScope,
    adapter: WorkflowV17SemanticEffectAdapter,
    input: unknown,
    semanticInput: JsonValue,
    operation: WorkflowOperationV17Record,
    settlement: WorkflowEffectSettlementV17Record,
  ): Promise<unknown> {
    const terminal = settlement.outcome === "success" ? settlement.result! : settlement.failure!;
    const callKey = workflowV17FreshCallKey({
      runId: operation.runId,
      previousCallKey: scope.previousCallKey,
      operation: workflowV17OperationIdentity(operation),
      semanticKey: settlement.semanticKey,
      outcome: settlement.outcome,
      completionAuthority: settlement.completionAuthority,
      replayPolicy: settlement.replayPolicy,
      result: terminal,
    });
    let completed: WorkflowOperationV17Record | undefined;
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      try {
        completed = this.database.completeCall({
          expectedRevision: this.database.readRun().revision,
          operationId: operation.operationId,
          previousCallKey: scope.previousCallKey,
          semanticKey: settlement.semanticKey,
          callKey,
          outcome: settlement.outcome,
          completionAuthority: settlement.completionAuthority,
          replayPolicy: settlement.replayPolicy,
          ...(settlement.outcome === "success" ? { result: settlement.result! } : { failure: settlement.failure! }),
          at: this.timestamp(),
        });
        break;
      } catch (error) {
        if (error instanceof WorkflowRunDatabaseV17RevisionConflictError) continue;
        const current = this.database.readOperation(operation.operationId);
        if (current?.status === "completed" || current?.status === "failed") {
          completed = current;
          break;
        }
        throw error;
      }
    }
    if (!completed) throw new Error("Could not complete workflow v17 effect after repeated revision races");
    await this.fault(settlement.outcome === "success" ? "after-operation-complete" : "after-operation-failure", completed);
    const identity: WorkflowV17EffectIdentity = {
      semanticKey: settlement.semanticKey,
      completionAuthority: settlement.completionAuthority,
      replayPolicy: settlement.outcome === "success" ? settlement.replayPolicy : "never",
    };
    return this.restoreCommitted(scope, adapter, input, semanticInput, completed, identity);
  }

  private async claim(
    scope: CursorScope,
    cursor: number,
    kind: WorkflowV17EffectKind,
    invocation: WorkflowV17EffectInvocation,
    semanticInputHash: string,
  ): Promise<{ operation: WorkflowOperationV17Record; claimed: boolean }> {
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      try {
        return this.database.claimOperation({
          expectedRevision: this.database.readRun().revision,
          scopeId: scope.record.scopeId,
          cursor,
          kind,
          sourceSite: invocation.sourceSite,
          ...(invocation.descriptorSourceSite ? { descriptorSourceSite: invocation.descriptorSourceSite } : {}),
          ...(invocation.title ? { title: invocation.title } : {}),
          semanticInputHash,
          maximumOperations: this.operationAdmissionLimit,
          maximumAgentOperations: this.database.readRun().safety.maximumAgentLaunches,
          at: this.timestamp(),
        });
      } catch (error) {
        if (error instanceof WorkflowRunDatabaseV17RevisionConflictError) continue;
        if (error instanceof WorkflowRunDatabaseV17StateError && /Semantic operation changed/u.test(error.message)) {
          const existing = this.database.readOperationAt(scope.record.scopeId, cursor);
          throw new WorkflowV17SemanticDriftError(error.message, existing?.path);
        }
        throw error;
      }
    }
    throw new Error("Could not claim workflow v17 operation after repeated revision races");
  }

  private async settle(
    operation: WorkflowOperationV17Record,
    identity: WorkflowV17EffectIdentity,
    terminal: { outcome: "success"; result: JsonValue } | { outcome: "failure"; failure: JsonObject },
  ): Promise<WorkflowEffectSettlementV17Record> {
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      try {
        return this.database.settleEffect({
          expectedRevision: this.database.readRun().revision,
          operationId: operation.operationId,
          semanticKey: identity.semanticKey,
          outcome: terminal.outcome,
          completionAuthority: identity.completionAuthority,
          replayPolicy: identity.replayPolicy,
          ...(terminal.outcome === "success" ? { result: terminal.result } : { failure: terminal.failure }),
          at: this.timestamp(),
        });
      } catch (error) {
        if (error instanceof WorkflowRunDatabaseV17RevisionConflictError) continue;
        const existing = this.database.readEffectSettlement(operation.operationId);
        if (existing) {
          assertSettlementIdentity(operation, existing, identity, terminal.outcome);
          return existing;
        }
        throw error;
      }
    }
    throw new Error("Could not settle workflow v17 effect after repeated revision races");
  }

  private async startRun(): Promise<void> {
    const run = this.database.readRun();
    if (run.status === "running") return;
    if (run.status !== "queued" && run.status !== "paused") {
      throw new Error(`Workflow v17 run is already ${run.status}`);
    }
    await this.transitionRun("running");
    await this.fault("after-run-start");
  }

  private async completeRootScope(scope: CursorScope, terminalKey: string): Promise<void> {
    const current = this.database.readScope(scope.record.scopeId)!;
    if (current.status === "completed") {
      if (current.terminalKey !== terminalKey) {
        throw new WorkflowV17SemanticDriftError("Workflow v17 root terminal key changed after restart");
      }
      return;
    }
    if (current.status !== "active") {
      throw new WorkflowV17SemanticDriftError(`Workflow v17 root scope is already ${current.status}`);
    }
    await this.completeScope(current, "completed", terminalKey);
    await this.fault("after-root-scope-complete");
  }

  private async failRootScope(scope: CursorScope, failure: JsonObject): Promise<void> {
    const terminalKey = stableHash({
      formatVersion: 1,
      kind: "workflow-v17-scope-failure",
      previousCallKey: scope.previousCallKey,
      failure,
    });
    const current = this.database.readScope(scope.record.scopeId)!;
    if (current.status === "failed") {
      if (current.terminalKey !== terminalKey || stableHash(current.failure) !== stableHash(failure)) {
        throw new WorkflowV17SemanticDriftError("Workflow v17 root failure changed after restart");
      }
      return;
    }
    if (current.status !== "active") {
      throw new WorkflowV17SemanticDriftError(`Workflow v17 root scope is already ${current.status}`);
    }
    await this.completeScope(current, "failed", terminalKey, failure);
    await this.fault("after-root-scope-failure");
  }

  private async completeScope(
    scope: WorkflowScopeV17Record,
    status: "completed" | "failed",
    terminalKey: string,
    failure?: JsonObject,
  ): Promise<void> {
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      try {
        this.database.completeScope({
          expectedRevision: this.database.readRun().revision,
          scopeId: scope.scopeId,
          status,
          terminalKey,
          ...(failure ? { failure } : {}),
          at: this.timestamp(),
        });
        return;
      } catch (error) {
        if (error instanceof WorkflowRunDatabaseV17RevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error("Could not complete workflow v17 scope after repeated revision races");
  }

  private async transitionRun(
    status: "running" | "paused" | "completed" | "failed",
    reason?: JsonObject,
    rootTerminalKey?: string,
  ): Promise<void> {
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      const current = this.database.readRun();
      if (current.status === status) return;
      try {
        this.database.transitionRun(current.revision, {
          status,
          ...(reason ? { reason } : {}),
          ...(rootTerminalKey ? { rootTerminalKey } : {}),
          at: this.timestamp(),
        });
        return;
      } catch (error) {
        if (error instanceof WorkflowRunDatabaseV17RevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error(`Could not transition workflow v17 run to ${status}`);
  }

  private scope(): CursorScope {
    const scope = this.storage.getStore();
    if (!scope) throw new Error("Workflow v17 effect escaped its semantic scope");
    return scope;
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("Workflow v17 engine clock is invalid");
    return value.toISOString();
  }

  private async fault(point: WorkflowV17SemanticEngineFaultPoint, operation?: WorkflowOperationV17Record): Promise<void> {
    try {
      await this.options.faultInjector?.(point, operation);
    } catch (error) {
      this.fatalFault = error;
      throw error;
    }
  }
}

function normalizeIdentity(value: WorkflowV17EffectIdentity, kind: WorkflowV17EffectKind): WorkflowV17EffectIdentity {
  if (!value || typeof value !== "object" || !HASH.test(value.semanticKey)) {
    throw new TypeError(`Workflow v17 ${kind} adapter returned an invalid semantic key`);
  }
  if (value.completionAuthority !== "finish-work" && value.completionAuthority !== "host-effect") {
    throw new TypeError(`Workflow v17 ${kind} adapter returned an invalid completion authority`);
  }
  if (!new Set(["immutable", "workspace", "never"]).has(value.replayPolicy)) {
    throw new TypeError(`Workflow v17 ${kind} adapter returned an invalid replay policy`);
  }
  if (kind === "apply" && value.replayPolicy !== "never") {
    throw new TypeError("Workflow v17 apply adapter must use never replay policy");
  }
  if (value.replayPolicy === "workspace") {
    throw new TypeError(`Workflow v17 ${kind} workspace effects require the later evidence-adapter phase`);
  }
  return value;
}

function assertSettlementIdentity(
  operation: WorkflowOperationV17Record,
  settlement: WorkflowEffectSettlementV17Record,
  identity: WorkflowV17EffectIdentity,
  expectedOutcome?: WorkflowEffectSettlementV17Record["outcome"],
): void {
  if (settlement.semanticKey !== identity.semanticKey
    || settlement.completionAuthority !== identity.completionAuthority
    || (settlement.outcome === "success" && settlement.replayPolicy !== identity.replayPolicy)
    || (settlement.outcome === "failure" && settlement.replayPolicy !== "never")
    || (expectedOutcome !== undefined && settlement.outcome !== expectedOutcome)) {
    throw new WorkflowV17SemanticDriftError(
      `Workflow v17 effect settlement changed identity at ${operation.path}`,
      operation.path,
    );
  }
}

function canonical(value: unknown): JsonValue {
  return canonicalJsonValue(value, {
    maxBytes: DEFINITION_LIMITS.structuralValueBytes,
    maxDepth: DEFINITION_LIMITS.structuralValueDepth,
    maxNodes: DEFINITION_LIMITS.structuralValueNodes,
    maxStringScalars: DEFINITION_LIMITS.structuralStringScalars,
  });
}

function failureFromError(error: unknown): JsonObject {
  if (error instanceof WorkflowV17RecordedEffectError) return structuredClone(error.failure);
  const record = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const summary = boundedText(
    typeof record?.message === "string" ? record.message : String(error),
    16_000,
  );
  return canonicalJsonObject({
    category: "effect",
    code: "execution-failed",
    summary,
    retryable: false,
    ...(typeof record?.name === "string" ? { name: boundedText(record.name, 256) } : {}),
  }, {
    maxBytes: 64 * 1024,
    maxDepth: 8,
    maxNodes: 64,
    maxStringScalars: 20_000,
  });
}

function failureReason(
  category: string,
  code: string,
  summary: string,
  retryable: boolean,
): JsonObject {
  return { category, code, summary: boundedText(summary, 16_000), retryable };
}

function boundedText(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

function boundedOperationAdmissionLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFINITION_LIMITS.semanticOperations) {
    throw new TypeError(`Workflow v17 operation admission limit must be 1–${DEFINITION_LIMITS.semanticOperations}`);
  }
  return value;
}

function isPassthrough(error: unknown): boolean {
  return error instanceof WorkflowV17SemanticEngineCrashError
    || error instanceof WorkflowV17SemanticDriftError;
}
