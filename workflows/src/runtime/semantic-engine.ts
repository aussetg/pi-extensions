import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalJsonObject, canonicalJsonValue, deepFreezeJson } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import type {
  WorkflowEffectSettlementRecord,
  WorkflowOperationKind,
  WorkflowOperationRecord,
  WorkflowRunRecord,
  WorkflowScopeCallRecord,
  WorkflowScopeRecord,
  WorkflowStructuralJoinLaneRecord,
  WorkflowCallArtifactInput,
} from "../persistence/run-database-types.js";
import {
  WorkflowRunDatabase,
  WorkflowRunDatabaseAdmissionError,
  WorkflowRunDatabaseRevisionConflictError,
  WorkflowRunDatabaseStateError,
} from "../persistence/run-database.js";
import type { JsonObject, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import {
  workflowFreshCallKey,
  workflowLaneSeed,
  workflowOperationIdentity,
  workflowStructuralJoinKey,
} from "./causal-identity.js";
import type { WorkflowCausalReplay } from "./causal-replay.js";
import { SemanticConcurrencyLimiter } from "./semantic-engine-concurrency.js";
import type { WorkflowReplayWorkspaceTarget } from "../workspaces/replay.js";

const MAX_REVISION_RETRIES = 16;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const EFFECT_KINDS = new Set<WorkflowOperationKind>([
  "agent", "command", "ask", "measure", "verify", "accept", "reject", "record-experiment", "apply",
]);

export type WorkflowSemanticEngineFaultPoint =
  | "after-run-start"
  | "after-operation-claim"
  | "after-effect-settled"
  | "after-operation-complete"
  | "after-operation-failure"
  | "after-child-scopes-preclaimed"
  | "after-lane-scope-complete"
  | "after-lane-scope-failure"
  | "after-lane-scope-cancelled"
  | "after-candidate-frozen"
  | "after-structural-join"
  | "after-root-scope-complete"
  | "after-root-scope-failure";

type WorkflowEffectKind = Exclude<WorkflowOperationKind, "parallel" | "map" | "candidate">;

export interface WorkflowEffectInvocation {
  sourceSite: string;
  descriptorSourceSite?: string;
  title?: string;
  candidateWorkspaceIds?: readonly string[];
  input: unknown;
}

export interface WorkflowStructuredOptions {
  sourceSite: string;
  title?: string;
  concurrency?: number;
  errors?: "fail-fast" | "collect";
}

export interface WorkflowMapOptions extends WorkflowStructuredOptions {
  key(item: JsonValue, index: number): string | Promise<string>;
}

export interface WorkflowCandidateInvocation {
  sourceSite: string;
  title?: string;
  body(workspace: unknown): JsonValue | Promise<JsonValue>;
  input: unknown;
}

export interface WorkflowCandidateRuntimeContext {
  run: WorkflowRunRecord;
  operation: WorkflowOperationRecord;
  bodyScope: WorkflowScopeRecord;
  input: unknown;
  signal: AbortSignal;
}

export interface WorkflowCandidateRuntimeValue {
  result: JsonValue;
  value: unknown;
  artifacts?: WorkflowCallArtifactInput[];
}

export interface WorkflowSemanticCandidateRuntime {
  semanticInput(context: { run: WorkflowRunRecord; input: unknown; signal: AbortSignal }): JsonValue | Promise<JsonValue>;
  existing(context: WorkflowCandidateRuntimeContext): WorkflowCandidateRuntimeValue | undefined | Promise<WorkflowCandidateRuntimeValue | undefined>;
  open(context: WorkflowCandidateRuntimeContext): unknown | Promise<unknown>;
  freeze(
    context: WorkflowCandidateRuntimeContext & { output: JsonValue; bodyTerminalKey: string },
  ): WorkflowCandidateRuntimeValue | Promise<WorkflowCandidateRuntimeValue>;
  restore(context: WorkflowCandidateRuntimeContext & { result: JsonValue }): unknown;
  abandon(context: WorkflowCandidateRuntimeContext, failure: JsonObject): void | Promise<void>;
}

export interface WorkflowEffectIdentity {
  semanticKey: string;
  completionAuthority: Exclude<WorkflowScopeCallRecord["completionAuthority"], "structural-join">;
  replayPolicy: WorkflowScopeCallRecord["replayPolicy"];
  workspace?: WorkflowReplayWorkspaceTarget;
  postWorkspaceCheckpointId?: string;
}

export interface WorkflowEffectAdapterContext {
  run: WorkflowRunRecord;
  input: unknown;
  semanticInput: JsonValue;
  operation?: WorkflowOperationRecord;
  signal: AbortSignal;
}

export interface WorkflowEffectRestoreContext extends WorkflowEffectAdapterContext {
  operation: WorkflowOperationRecord;
  call: WorkflowScopeCallRecord;
  result: JsonValue;
}

export interface WorkflowSemanticEffectAdapter {
  readonly kind: WorkflowEffectKind;
  semanticInput(context: Omit<WorkflowEffectAdapterContext, "semanticInput" | "operation">): JsonValue | Promise<JsonValue>;
  journalIdentity(context: WorkflowEffectAdapterContext & { operation: WorkflowOperationRecord }): WorkflowEffectIdentity | Promise<WorkflowEffectIdentity>;
  execute(context: WorkflowEffectAdapterContext & { operation: WorkflowOperationRecord }): JsonValue | Promise<JsonValue>;
  evidence?(context: WorkflowEffectAdapterContext & {
    operation: WorkflowOperationRecord;
    result: JsonValue;
  }): { artifacts?: WorkflowCallArtifactInput[] } | Promise<{ artifacts?: WorkflowCallArtifactInput[] }>;
  restore?(context: WorkflowEffectRestoreContext): unknown | Promise<unknown>;
}

export interface WorkflowSequentialFlow {
  effect<T = JsonValue>(kind: WorkflowEffectKind, invocation: WorkflowEffectInvocation): Promise<T>;
  parallel<const B extends Readonly<Record<string, () => unknown | Promise<unknown>>>>(
    branches: B,
    options: WorkflowStructuredOptions,
  ): Promise<{ [K in keyof B]: Awaited<ReturnType<B[K]>> }>;
  map<T>(
    items: readonly JsonValue[],
    body: (item: JsonValue, index: number) => T | Promise<T>,
    options: WorkflowMapOptions,
  ): Promise<T[]>;
  candidate(invocation: WorkflowCandidateInvocation): Promise<unknown>;
}

export type WorkflowSemanticRunOutcome<T extends JsonValue = JsonValue> =
  | { status: "completed"; result: T; terminalKey: string }
  | { status: "failed"; failure: JsonObject }
  | { status: "paused"; failure: JsonObject }
  | { status: "waiting"; failure: JsonObject }
  | { status: "stopped"; failure: JsonObject };

export interface WorkflowSemanticEngineOptions {
  replay?: WorkflowCausalReplay;
  signal?: AbortSignal;
  operationAdmissionLimit?: number;
  now?: () => Date;
  candidate?: WorkflowSemanticCandidateRuntime;
  structuralValues?: {
    encode(value: unknown): JsonValue;
    decode(value: JsonValue): unknown;
  };
  faultInjector?: (
    point: WorkflowSemanticEngineFaultPoint,
    operation?: WorkflowOperationRecord,
  ) => void | Promise<void>;
}

interface CursorScope {
  record: WorkflowScopeRecord;
  cursor: number;
  previousCallKey: string;
  signal: AbortSignal;
  branchLineage: ReadonlyArray<{ groupOperationId: string; laneKey: string }>;
}

interface StructuredLane {
  key: string;
  scope: WorkflowScopeRecord;
  body: () => unknown | Promise<unknown>;
  groupOperationId: string;
}

interface StructuredLaneOutcome {
  key: string;
  scope: WorkflowScopeRecord;
  outcome: "success" | "failure" | "cancelled";
  terminalKey: string;
  value?: unknown;
  failure?: JsonObject;
}

interface NormalizedStructuredOptions {
  sourceSite: string;
  title?: string;
  concurrency: number;
  errors: "fail-fast" | "collect";
}

export class WorkflowSemanticEngineCrashError extends Error {
  constructor(
    readonly point: WorkflowSemanticEngineFaultPoint,
    readonly operationPath?: string,
  ) {
    super(`Workflow v17 simulated crash at ${point}${operationPath ? ` ${operationPath}` : ""}`);
    this.name = "WorkflowSemanticEngineCrashError";
  }
}

export class WorkflowSemanticDriftError extends Error {
  constructor(message: string, readonly operationPath?: string) {
    super(message);
    this.name = "WorkflowSemanticDriftError";
  }
}

export class WorkflowRecordedEffectError extends Error {
  readonly operationPath: string;
  readonly failure: JsonObject;

  constructor(operationPath: string, failure: JsonObject) {
    super(typeof failure.summary === "string" ? failure.summary : `Recorded workflow effect failed at ${operationPath}`);
    this.name = "WorkflowRecordedEffectError";
    this.operationPath = operationPath;
    this.failure = deepFreezeJson(structuredClone(failure));
  }
}

export class WorkflowRecordedStructuralError extends Error {
  readonly operationPath: string;
  readonly failure: JsonObject;

  constructor(operationPath: string, failure: JsonObject) {
    super(typeof failure.summary === "string" ? failure.summary : `Recorded workflow structure failed at ${operationPath}`);
    this.name = "WorkflowRecordedStructuralError";
    this.operationPath = operationPath;
    this.failure = deepFreezeJson(structuredClone(failure));
  }
}

/** A durable human boundary. The operation remains unsettled and resumes from the same cursor. */
export class WorkflowHumanSuspension extends Error {
  constructor(readonly interactionId: string, readonly failure: JsonObject) {
    super(typeof failure.summary === "string" ? failure.summary : "Workflow is waiting for human input");
    this.name = "WorkflowHumanSuspension";
  }
}

class WorkflowSiblingCancellation extends Error {
  constructor(readonly laneKey: string) {
    super(`Workflow v17 sibling lane cancelled after ${laneKey} failed`);
    this.name = "WorkflowSiblingCancellation";
  }
}

/** Cursor-owned v17 execution with keyed structured child scopes. */
export class WorkflowSemanticEngine {
  private readonly storage = new AsyncLocalStorage<CursorScope>();
  private readonly adapters = new Map<WorkflowEffectKind, WorkflowSemanticEffectAdapter>();
  private readonly controller = new AbortController();
  private readonly now: () => Date;
  private readonly operationAdmissionLimit: number;
  private readonly limiter: SemanticConcurrencyLimiter;
  private readonly controlContexts = new WeakSet<object>();
  private readonly externalAbort?: () => void;
  private running = false;
  private used = false;
  private fatalFault?: unknown;

  constructor(
    readonly database: WorkflowRunDatabase,
    adapters: readonly WorkflowSemanticEffectAdapter[],
    readonly options: WorkflowSemanticEngineOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.operationAdmissionLimit = boundedOperationAdmissionLimit(
      options.operationAdmissionLimit ?? DEFINITION_LIMITS.semanticOperations,
    );
    this.limiter = new SemanticConcurrencyLimiter(Math.min(
      database.readRun().safety.concurrency,
      DEFINITION_LIMITS.concurrency,
    ));
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
    body: (flow: WorkflowSequentialFlow) => T | Promise<T>,
  ): Promise<WorkflowSemanticRunOutcome<T>> {
    if (this.running || this.used) throw new Error("Workflow v17 semantic engine instances execute exactly once");
    this.running = true;
    this.used = true;
    try {
      await this.startRun();
      const root = this.database.readScope(this.database.readRun().rootScopeId);
      if (!root) throw new Error("Workflow v17 root scope is missing");
      const scope: CursorScope = {
        record: root,
        cursor: 0,
        previousCallKey: root.seedKey,
        signal: this.controller.signal,
        branchLineage: [],
      };
      this.controlContexts.add(scope);
      try {
        const raw = await this.storage.run(scope, async () => await body(this.flowApi()));
        if (this.fatalFault !== undefined) throw this.fatalFault;
        if (this.controller.signal.aborted) throw this.controller.signal.reason;
        const result = canonical(raw) as T;
        const pending = this.database.listCandidates().filter(candidate =>
          candidate.state === "pending" && candidate.changedPaths.length > 0);
        if (pending.length > 0) {
          throw new Error(`Workflow completed with ${pending.length} undisposed nonempty candidate${pending.length === 1 ? "" : "s"}`);
        }
        const terminalKey = scope.previousCallKey;
        await this.completeRootScope(scope, terminalKey);
        await this.transitionRun("completed", undefined, terminalKey, result);
        return { status: "completed", result: structuredClone(result), terminalKey };
      } catch (error) {
        if (this.fatalFault !== undefined) throw this.fatalFault;
        if (error instanceof WorkflowHumanSuspension) {
          const current = this.database.readRun();
          if (current.status !== "waiting") {
            throw new WorkflowSemanticDriftError("Workflow v17 human suspension lacks a waiting run");
          }
          return { status: "waiting", failure: structuredClone(error.failure) };
        }
        if (isPassthrough(error)) throw error;
        if (error instanceof WorkflowRunDatabaseAdmissionError) {
          const failure = failureReason("workflow", `admission-${error.limit}`, error.message, true);
          await this.transitionRun("paused", failure);
          return { status: "paused", failure };
        }
        if (this.controller.signal.aborted) {
          const failure = failureReason("workflow", "cancelled", "Workflow control was cancelled", true);
          const current = this.database.readRun();
          if (current.status === "paused") return { status: "paused", failure: current.reason ?? failure };
          if (current.status === "stopped") return { status: "stopped", failure: current.reason ?? failure };
          await this.transitionRun("paused", failure);
          return { status: "paused", failure };
        }
        const failure = failureFromError(error);
        try {
          await this.failRootScope(scope, failure);
        } catch (scopeError) {
          if (!(scopeError instanceof WorkflowRunDatabaseStateError)
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

  private flowApi(): WorkflowSequentialFlow {
    return Object.freeze({
      effect: async <T>(kind: WorkflowEffectKind, invocation: WorkflowEffectInvocation): Promise<T> =>
        await this.effect(kind, invocation) as T,
      parallel: async <B extends Readonly<Record<string, () => unknown | Promise<unknown>>>>(
        branches: B,
        options: WorkflowStructuredOptions,
      ): Promise<{ [K in keyof B]: Awaited<ReturnType<B[K]>> }> => await this.parallel(branches, options),
      map: async <T>(
        items: readonly JsonValue[],
        body: (item: JsonValue, index: number) => T | Promise<T>,
        options: WorkflowMapOptions,
      ): Promise<T[]> => await this.map(items, body, options),
      candidate: async (invocation: WorkflowCandidateInvocation): Promise<unknown> =>
        await this.candidate(invocation),
    });
  }

  currentControlContext(): object {
    return this.scope();
  }

  runInControlContext<T>(context: object, body: () => T): T {
    if (!this.controlContexts.has(context)) throw new TypeError("Unknown workflow v17 semantic control context");
    return this.storage.run(context as CursorScope, body);
  }

  private async effect(kind: WorkflowEffectKind, invocation: WorkflowEffectInvocation): Promise<unknown> {
    if (this.fatalFault !== undefined) throw this.fatalFault;
    const scope = this.scope();
    if (scope.signal.aborted) throw scope.signal.reason;
    if (!EFFECT_KINDS.has(kind)) throw new TypeError(`Workflow v17 ${kind} is not a sequential effect`);
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`No workflow v17 adapter for ${kind}`);
    const run = this.database.readRun();
    await this.bindCandidateWorkspaceLanes(scope, invocation.candidateWorkspaceIds ?? []);
    const semanticInput = canonical(await adapter.semanticInput({
      run,
      input: invocation.input,
      signal: scope.signal,
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
      signal: scope.signal,
    }), kind);

    if (operation.status === "completed" || operation.status === "failed") {
      return await this.restoreCommitted(scope, adapter, invocation.input, semanticInput, operation, identity);
    }
    if (operation.status !== "running" && operation.status !== "waiting") {
      throw new WorkflowSemanticDriftError(
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
        ...(identity.workspace ? { workspace: identity.workspace } : {}),
        at: this.timestamp(),
      });
      if (decision.kind === "hit") {
        const current = this.database.readOperation(operation.operationId)!;
        await this.fault("after-operation-complete", current);
        return await this.restoreCommitted(scope, adapter, invocation.input, semanticInput, current, identity);
      }
    }

    let result: JsonValue;
    try {
      if (scope.signal.aborted) throw scope.signal.reason;
      const lease = await this.limiter.acquire(scope.signal);
      try {
        if (this.fatalFault !== undefined) throw this.fatalFault;
        if (scope.signal.aborted) throw scope.signal.reason;
        result = canonical(await adapter.execute({
          run: this.database.readRun(),
          input: invocation.input,
          semanticInput,
          operation,
          signal: scope.signal,
        }));
        if (this.fatalFault !== undefined) throw this.fatalFault;
      } finally {
        lease.release();
      }
    } catch (error) {
      if (isPassthrough(error)) throw error;
      if (scope.signal.aborted) throw error;
      const failure = failureFromError(error, kind);
      const settled = await this.settle(operation, {
        semanticKey: identity.semanticKey,
        completionAuthority: identity.completionAuthority,
        replayPolicy: "never",
      }, { outcome: "failure", failure });
      await this.fault("after-effect-settled", operation);
      return await this.completeSettlement(scope, adapter, invocation.input, semanticInput, operation, settled);
    }
    const settled = await this.settle(operation, identity, { outcome: "success", result });
    await this.fault("after-effect-settled", operation);
    return await this.completeSettlement(scope, adapter, invocation.input, semanticInput, operation, settled);
  }

  private async parallel<B extends Readonly<Record<string, () => unknown | Promise<unknown>>>>(
    branches: B,
    optionsValue: WorkflowStructuredOptions,
  ): Promise<{ [K in keyof B]: Awaited<ReturnType<B[K]>> }> {
    const options = normalizeStructuredOptions(optionsValue, "parallel", this.limiter.limit);
    if (!branches || typeof branches !== "object" || Array.isArray(branches)) {
      throw new TypeError("Workflow v17 parallel branches must be an object");
    }
    const keys = Object.keys(branches);
    if (keys.length < 1 || keys.length > DEFINITION_LIMITS.parallelBranches) {
      throw new TypeError(`Workflow v17 parallel requires 1–${DEFINITION_LIMITS.parallelBranches} branches`);
    }
    const seen = new Set<string>();
    for (const key of keys) {
      assertLaneKey(key);
      if (seen.has(key)) throw new TypeError(`Duplicate workflow v17 parallel lane ${key}`);
      seen.add(key);
      if (typeof branches[key] !== "function") throw new TypeError(`Workflow v17 parallel lane ${key} is not a callback`);
    }
    const values = await this.runStructure(
      "parallel",
      keys.map((key) => ({ key, body: branches[key]! })),
      canonical({ formatVersion: 1, kind: "parallel", keys, errors: options.errors }),
      options,
    );
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new Error("Workflow v17 parallel produced an invalid result");
    }
    return values as { [K in keyof B]: Awaited<ReturnType<B[K]>> };
  }

  private async map<T>(
    itemsValue: readonly JsonValue[],
    body: (item: JsonValue, index: number) => T | Promise<T>,
    optionsValue: WorkflowMapOptions,
  ): Promise<T[]> {
    const options = normalizeMapOptions(optionsValue, this.limiter.limit);
    if (!Array.isArray(itemsValue) || itemsValue.length > DEFINITION_LIMITS.mapItems) {
      throw new TypeError(`Workflow v17 map accepts at most ${DEFINITION_LIMITS.mapItems} items`);
    }
    if (typeof body !== "function") throw new TypeError("Workflow v17 map body must be a callback");
    const items = canonical(itemsValue) as JsonValue[];
    const keys: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < items.length; index++) {
      const key = await Promise.resolve(options.key(structuredClone(items[index]!), index));
      assertLaneKey(key);
      if (seen.has(key)) throw new TypeError(`Duplicate workflow v17 map lane ${key}`);
      seen.add(key);
      keys.push(key);
    }
    const result = await this.runStructure(
      "map",
      items.map((item, index) => ({
        key: keys[index]!,
        body: () => body(structuredClone(item), index),
      })),
      canonical({
        formatVersion: 1,
        kind: "map",
        errors: options.errors,
        entries: items.map((item, index) => ({ key: keys[index]!, item })),
      }),
      options,
    );
    if (!Array.isArray(result)) throw new Error("Workflow v17 map produced an invalid result");
    return result as T[];
  }

  private async candidate(invocation: WorkflowCandidateInvocation): Promise<unknown> {
    const runtime = this.options.candidate;
    if (!runtime) throw new Error("Workflow v17 candidate runtime is unavailable");
    if (!invocation || typeof invocation.body !== "function") {
      throw new TypeError("Workflow v17 candidate body must be a callback");
    }
    const parent = this.scope();
    if (parent.signal.aborted) throw parent.signal.reason;
    const semanticInput = canonical(await runtime.semanticInput({
      run: this.database.readRun(), input: invocation.input, signal: parent.signal,
    }));
    const cursor = parent.cursor++;
    const claimed = await this.claim(parent, cursor, "candidate", invocation, stableHash(semanticInput));
    const operation = claimed.operation;
    if (claimed.claimed) await this.fault("after-operation-claim", operation);
    const semanticKey = stableHash({
      formatVersion: 1,
      kind: "workflow-candidate-join",
      semanticInputHash: operation.semanticInputHash,
      contextIdentityHash: this.database.readRun().contextIdentityHash,
    });
    const policyHash = stableHash({
      formatVersion: 1,
      kind: "workflow-candidate-policy",
      semanticInput,
    });
    if (operation.status === "completed" || operation.status === "failed") {
      const restored = this.restoreCandidateStructure(parent, operation, semanticKey, policyHash);
      if (restored.failure) throw new WorkflowRecordedStructuralError(operation.path, restored.failure);
      return runtime.restore({
        run: this.database.readRun(), operation, bodyScope: restored.bodyScope,
        input: invocation.input, signal: parent.signal, result: restored.result!,
      });
    }
    if (operation.status !== "running" && operation.status !== "waiting") {
      throw new WorkflowSemanticDriftError(
        `Workflow v17 candidate ${operation.path} cannot resume from ${operation.status}`,
        operation.path,
      );
    }
    const bodyScope = await this.preclaimCandidateBody(parent, operation);
    const context: WorkflowCandidateRuntimeContext = {
      run: this.database.readRun(), operation, bodyScope, input: invocation.input, signal: parent.signal,
    };
    const existing = await runtime.existing(context);
    if (existing) {
      const joinKey = await this.completeCandidateJoin(
        parent, operation, bodyScope, semanticKey, policyHash, existing,
      );
      parent.previousCallKey = joinKey;
      await this.fault("after-structural-join", operation);
      return existing.value;
    }
    if (bodyScope.status !== "active") {
      throw new WorkflowSemanticDriftError(
        `Workflow v17 candidate body ${bodyScope.path} has no frozen authority`,
        operation.path,
      );
    }
    const workspace = await runtime.open(context);
    const bodyContext: CursorScope = {
      record: bodyScope,
      cursor: 0,
      previousCallKey: bodyScope.seedKey,
      signal: parent.signal,
      branchLineage: [...parent.branchLineage],
    };
    this.controlContexts.add(bodyContext);
    try {
      const output = canonical(await this.storage.run(bodyContext, async () =>
        await invocation.body(workspace)));
      if (this.fatalFault !== undefined) throw this.fatalFault;
      if (parent.signal.aborted) throw parent.signal.reason;
      const frozen = await runtime.freeze({
        ...context,
        run: this.database.readRun(),
        output,
        bodyTerminalKey: bodyContext.previousCallKey,
      });
      await this.fault("after-candidate-frozen", operation);
      const currentBody = this.database.readScope(bodyScope.scopeId)!;
      if (currentBody.status !== "completed" || currentBody.terminalKey !== bodyContext.previousCallKey) {
        throw new WorkflowSemanticDriftError("Workflow v17 candidate freeze did not settle its body scope");
      }
      const joinKey = await this.completeCandidateJoin(
        parent, operation, currentBody, semanticKey, policyHash, frozen,
      );
      parent.previousCallKey = joinKey;
      await this.fault("after-structural-join", operation);
      return frozen.value;
    } catch (error) {
      if (isPassthrough(error) || error instanceof WorkflowRunDatabaseAdmissionError) throw error;
      if (this.fatalFault !== undefined) throw this.fatalFault;
      if (parent.signal.aborted) throw error;
      const failure = failureFromError(error);
      let currentBody = this.database.readScope(bodyScope.scopeId)!;
      if (currentBody.status === "active") {
        const terminalKey = failedScopeTerminal(bodyContext.previousCallKey, failure);
        await this.completeScope(currentBody, "failed", terminalKey, failure);
        currentBody = this.database.readScope(bodyScope.scopeId)!;
      }
      await runtime.abandon({ ...context, run: this.database.readRun(), bodyScope: currentBody }, failure);
      const lanes = [{
        laneKey: "candidate",
        scopeId: currentBody.scopeId,
        terminalKey: currentBody.terminalKey!,
        outcome: currentBody.status === "cancelled" ? "cancelled" as const : "failure" as const,
      }];
      const structural = structuralFailure("candidate", "candidate", failure);
      const joinKey = workflowStructuralJoinKey({
        previousCallKey: parent.previousCallKey,
        operation: workflowOperationIdentity(operation),
        semanticKey,
        policyHash,
        outputOrder: ["candidate"],
        lanes,
        outcome: "failure",
        failure: structural,
      });
      await this.completeFailedStructure(operation, {
        previousCallKey: parent.previousCallKey,
        semanticKey,
        policyHash,
        outputOrder: ["candidate"],
        lanes,
        joinKey,
        failure: structural,
      });
      parent.previousCallKey = joinKey;
      await this.fault("after-structural-join", operation);
      throw new WorkflowRecordedStructuralError(operation.path, structural);
    }
  }

  private async runStructure(
    kind: "parallel" | "map",
    laneBodies: ReadonlyArray<{ key: string; body: () => unknown | Promise<unknown> }>,
    semanticInput: JsonValue,
    options: NormalizedStructuredOptions,
  ): Promise<unknown> {
    if (this.fatalFault !== undefined) throw this.fatalFault;
    const parent = this.scope();
    if (parent.signal.aborted) throw parent.signal.reason;
    const cursor = parent.cursor++;
    const claimed = await this.claim(
      parent,
      cursor,
      kind,
      options,
      stableHash(semanticInput),
    );
    const operation = claimed.operation;
    if (claimed.claimed) await this.fault("after-operation-claim", operation);
    const outputOrder = laneBodies.map((lane) => lane.key);
    const semanticKey = stableHash({
      formatVersion: 1,
      kind: `workflow-${kind}-join`,
      semanticInputHash: operation.semanticInputHash,
    });
    const policyHash = stableHash({
      formatVersion: 1,
      kind: `workflow-${kind}-policy`,
      errors: options.errors,
    });
    if (operation.status === "completed" || operation.status === "failed") {
      return this.restoreStructure(parent, operation, semanticKey, policyHash, outputOrder);
    }
    if (operation.status !== "running" && operation.status !== "waiting") {
      throw new WorkflowSemanticDriftError(
        `Workflow v17 structure ${operation.path} cannot resume from ${operation.status}`,
        operation.path,
      );
    }
    const scopes = await this.preclaimLanes(parent, operation, kind, outputOrder);
    const lanes: StructuredLane[] = laneBodies.map((lane, index) => ({
      ...lane,
      scope: scopes[index]!,
      groupOperationId: operation.operationId,
    }));
    const outcomes = await this.runLanes(lanes, options);
    if (this.fatalFault !== undefined) throw this.fatalFault;
    if (parent.signal.aborted) throw parent.signal.reason;
    const firstFailure = options.errors === "fail-fast"
      ? outcomes.find((lane) => lane.outcome === "failure")
      : undefined;
    const laneRecords = outcomes.map((lane): Omit<WorkflowStructuralJoinLaneRecord, "ordinal"> => ({
      laneKey: lane.key,
      scopeId: lane.scope.scopeId,
      terminalKey: lane.terminalKey,
      outcome: lane.outcome,
    }));
    if (firstFailure) {
      const failure = structuralFailure(kind, firstFailure.key, firstFailure.failure!);
      const joinKey = workflowStructuralJoinKey({
        previousCallKey: parent.previousCallKey,
        operation: workflowOperationIdentity(operation),
        semanticKey,
        policyHash,
        outputOrder,
        lanes: laneRecords,
        outcome: "failure",
        failure,
      });
      await this.completeFailedStructure(operation, {
        previousCallKey: parent.previousCallKey,
        semanticKey,
        policyHash,
        outputOrder,
        lanes: laneRecords,
        joinKey,
        failure,
      });
      parent.previousCallKey = joinKey;
      await this.fault("after-structural-join", operation);
      throw new WorkflowRecordedStructuralError(operation.path, failure);
    }
    const runtimeResult = kind === "parallel"
      ? Object.fromEntries(outcomes.map((lane) => [lane.key, laneResult(lane, options.errors)]))
      : outcomes.map((lane) => laneResult(lane, options.errors));
    const result = this.encodeStructuralValue(runtimeResult);
    const joinKey = await this.completeSuccessfulStructure(operation, {
      previousCallKey: parent.previousCallKey,
      semanticKey,
      policyHash,
      outputOrder,
      lanes: laneRecords,
      result,
    });
    parent.previousCallKey = joinKey;
    await this.fault("after-structural-join", operation);
    return runtimeResult;
  }

  private restoreStructure(
    parent: CursorScope,
    operation: WorkflowOperationRecord,
    semanticKey: string,
    policyHash: string,
    outputOrder: readonly string[],
  ): unknown {
    const call = this.database.readScopeCall(operation.operationId);
    const join = this.database.readStructuralJoin(operation.operationId);
    if (!call || !join || call.previousCallKey !== parent.previousCallKey
      || call.semanticKey !== semanticKey || call.completionAuthority !== "structural-join"
      || join.policyHash !== policyHash || !equalStrings(join.outputOrder, outputOrder)
      || join.joinKey !== call.callKey) {
      throw new WorkflowSemanticDriftError(
        `Workflow v17 same-run structure changed identity at ${operation.path}`,
        operation.path,
      );
    }
    parent.previousCallKey = call.callKey;
    if (call.outcome === "failure") {
      if (operation.status !== "failed" || call.replayPolicy !== "never" || !operation.failure) {
        throw new WorkflowSemanticDriftError(`Workflow v17 failed structure is corrupt at ${operation.path}`);
      }
      throw new WorkflowRecordedStructuralError(operation.path, operation.failure);
    }
    if (operation.status !== "completed" || operation.result === undefined) {
      throw new WorkflowSemanticDriftError(`Workflow v17 completed structure is corrupt at ${operation.path}`);
    }
    return this.decodeStructuralValue(operation.result);
  }

  private restoreCandidateStructure(
    parent: CursorScope,
    operation: WorkflowOperationRecord,
    semanticKey: string,
    policyHash: string,
  ): { bodyScope: WorkflowScopeRecord; result?: JsonValue; failure?: JsonObject } {
    const call = this.database.readScopeCall(operation.operationId);
    const join = this.database.readStructuralJoin(operation.operationId);
    const [bodyScope] = this.database.listChildScopes(operation.operationId);
    if (!call || !join || !bodyScope || join.kind !== "candidate"
      || call.previousCallKey !== parent.previousCallKey || call.semanticKey !== semanticKey
      || call.completionAuthority !== "structural-join" || join.policyHash !== policyHash
      || !equalStrings(join.outputOrder, ["candidate"]) || join.joinKey !== call.callKey
      || join.lanes.length !== 1 || join.lanes[0]!.scopeId !== bodyScope.scopeId) {
      throw new WorkflowSemanticDriftError(
        `Workflow v17 same-run candidate changed identity at ${operation.path}`,
        operation.path,
      );
    }
    parent.previousCallKey = call.callKey;
    if (call.outcome === "failure") {
      if (operation.status !== "failed" || call.replayPolicy !== "never" || !operation.failure) {
        throw new WorkflowSemanticDriftError(`Workflow v17 failed candidate is corrupt at ${operation.path}`);
      }
      return { bodyScope, failure: operation.failure };
    }
    if (operation.status !== "completed" || operation.result === undefined) {
      throw new WorkflowSemanticDriftError(`Workflow v17 completed candidate is corrupt at ${operation.path}`);
    }
    return { bodyScope, result: structuredClone(operation.result) };
  }

  private async restoreCommitted(
    scope: CursorScope,
    adapter: WorkflowSemanticEffectAdapter,
    input: unknown,
    semanticInput: JsonValue,
    operation: WorkflowOperationRecord,
    identity: WorkflowEffectIdentity,
  ): Promise<unknown> {
    const call = this.database.readScopeCall(operation.operationId);
    if (!call || call.previousCallKey !== scope.previousCallKey || call.semanticKey !== identity.semanticKey
      || call.completionAuthority !== identity.completionAuthority
      || (call.outcome === "success" && call.replayPolicy !== identity.replayPolicy)
      || (call.outcome === "success" && call.postWorkspaceCheckpointId !== identity.postWorkspaceCheckpointId)
      || (call.outcome === "failure" && (call.replayPolicy !== "never" || call.postWorkspaceCheckpointId !== undefined))) {
      throw new WorkflowSemanticDriftError(
        `Workflow v17 same-run call changed identity at ${operation.path}`,
        operation.path,
      );
    }
    scope.previousCallKey = call.callKey;
    if (call.outcome === "failure") throw new WorkflowRecordedEffectError(operation.path, operation.failure!);
    const result = structuredClone(operation.result!);
    return await adapter.restore?.({
      run: this.database.readRun(),
      input,
      semanticInput,
      operation,
      call,
      result,
      signal: scope.signal,
    }) ?? result;
  }

  private async preclaimLanes(
    parent: CursorScope,
    operation: WorkflowOperationRecord,
    kind: "parallel" | "map",
    keys: readonly string[],
  ): Promise<WorkflowScopeRecord[]> {
    const childKind = kind === "parallel" ? "parallel-branch" as const : "map-item" as const;
    const specs = keys.map((laneKey) => ({
      kind: childKind,
      laneKey,
      seedKey: workflowLaneSeed({
        parentPreviousCallKey: parent.previousCallKey,
        ownerOperationPath: operation.path,
        ownerKind: kind,
        childKind,
        laneKey,
      }),
    }));
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      try {
        const result = this.database.createChildScopes(
          this.database.readRun().revision,
          operation.operationId,
          specs,
          this.timestamp(),
        );
        if (result.created) await this.fault("after-child-scopes-preclaimed", operation);
        return result.scopes;
      } catch (error) {
        if (error instanceof WorkflowRunDatabaseRevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error(`Could not preclaim workflow v17 ${kind} lanes`);
  }

  private async preclaimCandidateBody(
    parent: CursorScope,
    operation: WorkflowOperationRecord,
  ): Promise<WorkflowScopeRecord> {
    const spec = {
      kind: "candidate-body" as const,
      seedKey: workflowLaneSeed({
        parentPreviousCallKey: parent.previousCallKey,
        ownerOperationPath: operation.path,
        ownerKind: "candidate",
        childKind: "candidate-body",
      }),
    };
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      try {
        const result = this.database.createChildScopes(
          this.database.readRun().revision,
          operation.operationId,
          [spec],
          this.timestamp(),
        );
        if (result.created) await this.fault("after-child-scopes-preclaimed", operation);
        return result.scopes[0]!;
      } catch (error) {
        if (error instanceof WorkflowRunDatabaseRevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error("Could not preclaim workflow v17 candidate body");
  }

  private async completeCandidateJoin(
    parent: CursorScope,
    operation: WorkflowOperationRecord,
    bodyScope: WorkflowScopeRecord,
    semanticKey: string,
    policyHash: string,
    value: WorkflowCandidateRuntimeValue,
  ): Promise<string> {
    return await this.completeSuccessfulStructure(operation, {
      previousCallKey: parent.previousCallKey,
      semanticKey,
      policyHash,
      outputOrder: ["candidate"],
      lanes: [{
        laneKey: "candidate",
        scopeId: bodyScope.scopeId,
        terminalKey: bodyScope.terminalKey!,
        outcome: "success",
      }],
      result: value.result,
      ...(value.artifacts?.length ? { artifacts: value.artifacts } : {}),
    });
  }

  private async bindCandidateWorkspaceLanes(
    scope: CursorScope,
    workspaceIds: readonly string[],
  ): Promise<void> {
    if (!Array.isArray(workspaceIds) || new Set(workspaceIds).size !== workspaceIds.length) {
      throw new TypeError("Workflow v17 candidate workspace identities must be unique");
    }
    for (const workspaceId of workspaceIds) {
      if (typeof workspaceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,255}$/u.test(workspaceId)) {
        throw new TypeError("Workflow v17 candidate workspace identity is invalid");
      }
      for (const binding of scope.branchLineage) {
        let bound = false;
        for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
          try {
            this.database.bindCandidateWorkspaceLane(this.database.readRun().revision, {
              workspaceId,
              groupOperationId: binding.groupOperationId,
              laneKey: binding.laneKey,
              at: this.timestamp(),
            });
            bound = true;
            break;
          } catch (error) {
            if (error instanceof WorkflowRunDatabaseRevisionConflictError) continue;
            throw error;
          }
        }
        if (!bound) throw new Error(`Could not bind workflow v17 candidate workspace ${workspaceId}`);
      }
    }
  }

  private async runLanes(
    lanes: readonly StructuredLane[],
    options: NormalizedStructuredOptions,
  ): Promise<StructuredLaneOutcome[]> {
    if (lanes.length === 0) return [];
    const parent = this.scope();
    const controller = linkedController(parent.signal);
    const outcomes = new Array<StructuredLaneOutcome | undefined>(lanes.length);
    let cursor = 0;
    let firstFailure: StructuredLaneOutcome | undefined;
    let passthrough: unknown;
    const worker = async (): Promise<void> => {
      while (passthrough === undefined && !(firstFailure && options.errors === "fail-fast")) {
        const index = cursor++;
        if (index >= lanes.length) return;
        try {
          const outcome = await this.runLane(lanes[index]!, controller.signal);
          outcomes[index] = outcome;
          if (outcome.outcome === "failure" && options.errors === "fail-fast" && !firstFailure) {
            firstFailure = outcome;
            controller.abort(new WorkflowSiblingCancellation(outcome.key));
          }
        } catch (error) {
          if (passthrough === undefined) passthrough = error;
          controller.abort(error);
        }
      }
    };
    try {
      await Promise.all(Array.from(
        { length: Math.min(options.concurrency, lanes.length) },
        () => worker(),
      ));
      if (this.fatalFault !== undefined) throw this.fatalFault;
      if (passthrough !== undefined) throw passthrough;
      if (parent.signal.aborted) throw parent.signal.reason;
      if (firstFailure && options.errors === "fail-fast") {
        const cancellation = cancellationFailure(firstFailure.key);
        for (let index = 0; index < lanes.length; index++) {
          if (outcomes[index]) continue;
          const cancelled = await this.cancelLane(lanes[index]!, cancellation);
          outcomes[index] = cancelled;
        }
      }
      if (outcomes.some((outcome) => outcome === undefined)) {
        throw new Error("Workflow v17 structured scheduler left an unsettled lane");
      }
      return outcomes as StructuredLaneOutcome[];
    } finally {
      controller.dispose();
    }
  }

  private async runLane(lane: StructuredLane, signal: AbortSignal): Promise<StructuredLaneOutcome> {
    let current = this.database.readScope(lane.scope.scopeId);
    if (!current) throw new Error(`Workflow v17 lane ${lane.scope.path} disappeared`);
    if (current.status === "failed") return laneFromTerminal(current);
    if (current.status === "cancelled") return laneFromTerminal(current);
    const scope: CursorScope = {
      record: current,
      cursor: 0,
      previousCallKey: current.seedKey,
      signal,
      branchLineage: [
        ...this.scope().branchLineage,
        { groupOperationId: lane.groupOperationId, laneKey: lane.key },
      ],
    };
    this.controlContexts.add(scope);
    try {
      const value = await this.storage.run(scope, async () => await lane.body());
      if (this.fatalFault !== undefined) throw this.fatalFault;
      if (signal.aborted) throw signal.reason;
      current = this.database.readScope(current.scopeId)!;
      if (current.status === "completed") {
        if (current.terminalKey !== scope.previousCallKey) {
          throw new WorkflowSemanticDriftError(
            `Workflow v17 lane ${current.path} terminal changed after restart`,
          );
        }
      } else if (current.status === "active") {
        await this.completeScope(current, "completed", scope.previousCallKey);
        await this.fault("after-lane-scope-complete");
        current = this.database.readScope(current.scopeId)!;
      } else {
        throw new WorkflowSemanticDriftError(`Workflow v17 successful lane ${current.path} is ${current.status}`);
      }
      return {
        key: lane.key,
        scope: current,
        outcome: "success",
        terminalKey: current.terminalKey!,
        value,
      };
    } catch (error) {
      if (isPassthrough(error) || error instanceof WorkflowRunDatabaseAdmissionError) throw error;
      if (this.fatalFault !== undefined) throw this.fatalFault;
      if (this.controller.signal.aborted) throw error;
      if (signal.aborted && signal.reason instanceof WorkflowSiblingCancellation) {
        return await this.cancelLane(lane, cancellationFailure(signal.reason.laneKey));
      }
      if (signal.aborted) throw error;
      const failure = failureFromError(error);
      current = this.database.readScope(lane.scope.scopeId)!;
      if (current.status === "failed") {
        if (stableHash(current.failure) !== stableHash(failure)) {
          throw new WorkflowSemanticDriftError(`Workflow v17 lane ${current.path} failure changed after restart`);
        }
      } else if (current.status === "active") {
        const terminalKey = failedScopeTerminal(scope.previousCallKey, failure);
        await this.completeScope(current, "failed", terminalKey, failure);
        await this.fault("after-lane-scope-failure");
        current = this.database.readScope(current.scopeId)!;
      } else {
        throw new WorkflowSemanticDriftError(`Workflow v17 failed lane ${current.path} is ${current.status}`);
      }
      return {
        key: lane.key,
        scope: current,
        outcome: "failure",
        terminalKey: current.terminalKey!,
        failure,
      };
    }
  }

  private async cancelLane(
    lane: StructuredLane,
    failure: JsonObject,
  ): Promise<StructuredLaneOutcome> {
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      const current = this.database.readScope(lane.scope.scopeId);
      if (!current) throw new Error(`Workflow v17 lane ${lane.scope.path} disappeared`);
      if (current.status !== "active") return laneFromTerminal(current);
      try {
        const cancelled = this.database.cancelScopeTree({
          expectedRevision: this.database.readRun().revision,
          scopeId: current.scopeId,
          failure,
          at: this.timestamp(),
        });
        await this.fault("after-lane-scope-cancelled");
        return laneFromTerminal(cancelled);
      } catch (error) {
        if (error instanceof WorkflowRunDatabaseRevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error(`Could not cancel workflow v17 lane ${lane.scope.path}`);
  }

  private async completeSuccessfulStructure(
    operation: WorkflowOperationRecord,
    input: {
      previousCallKey: string;
      semanticKey: string;
      policyHash: string;
      outputOrder: string[];
      lanes: Array<Omit<WorkflowStructuralJoinLaneRecord, "ordinal">>;
      result: JsonValue;
      artifacts?: WorkflowCallArtifactInput[];
    },
  ): Promise<string> {
    if (this.options.replay) {
      const completed = this.options.replay.completeStructuralJoin({
        operationId: operation.operationId,
        ...input,
        kind: operation.kind as "parallel" | "map" | "candidate",
        at: this.timestamp(),
      });
      return completed.joinKey;
    }
    const joinKey = workflowStructuralJoinKey({
      previousCallKey: input.previousCallKey,
      operation: workflowOperationIdentity(operation),
      semanticKey: input.semanticKey,
      policyHash: input.policyHash,
      outputOrder: input.outputOrder,
      lanes: input.lanes,
      result: input.result,
    });
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      try {
        this.database.completeStructuralJoin({
          expectedRevision: this.database.readRun().revision,
          operationId: operation.operationId,
          previousCallKey: input.previousCallKey,
          semanticKey: input.semanticKey,
          callKey: joinKey,
          kind: operation.kind as "parallel" | "map" | "candidate",
          policyHash: input.policyHash,
          joinKey,
          outputOrder: input.outputOrder,
          lanes: input.lanes,
          result: input.result,
          ...(input.artifacts?.length ? { artifacts: input.artifacts } : {}),
          at: this.timestamp(),
        });
        return joinKey;
      } catch (error) {
        if (error instanceof WorkflowRunDatabaseRevisionConflictError) continue;
        const current = this.database.readOperation(operation.operationId);
        if (current?.status === "completed" && current.callKey === joinKey) return joinKey;
        throw error;
      }
    }
    throw new Error(`Could not complete workflow v17 ${operation.kind} join`);
  }

  private encodeStructuralValue(value: unknown): JsonValue {
    return this.options.structuralValues
      ? this.options.structuralValues.encode(value)
      : canonical(value);
  }

  private decodeStructuralValue(value: JsonValue): unknown {
    return this.options.structuralValues
      ? this.options.structuralValues.decode(value)
      : structuredClone(value);
  }

  private async completeFailedStructure(
    operation: WorkflowOperationRecord,
    input: {
      previousCallKey: string;
      semanticKey: string;
      policyHash: string;
      outputOrder: string[];
      lanes: Array<Omit<WorkflowStructuralJoinLaneRecord, "ordinal">>;
      joinKey: string;
      failure: JsonObject;
    },
  ): Promise<void> {
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      try {
        this.database.completeStructuralFailure({
          expectedRevision: this.database.readRun().revision,
          operationId: operation.operationId,
          previousCallKey: input.previousCallKey,
          semanticKey: input.semanticKey,
          callKey: input.joinKey,
          kind: operation.kind as "parallel" | "map" | "candidate",
          policyHash: input.policyHash,
          joinKey: input.joinKey,
          outputOrder: input.outputOrder,
          lanes: input.lanes,
          failure: input.failure,
          at: this.timestamp(),
        });
        return;
      } catch (error) {
        if (error instanceof WorkflowRunDatabaseRevisionConflictError) continue;
        const current = this.database.readOperation(operation.operationId);
        if (current?.status === "failed" && current.callKey === input.joinKey) return;
        throw error;
      }
    }
    throw new Error(`Could not complete failed workflow v17 ${operation.kind} join`);
  }

  private async completeSettlement(
    scope: CursorScope,
    adapter: WorkflowSemanticEffectAdapter,
    input: unknown,
    semanticInput: JsonValue,
    operation: WorkflowOperationRecord,
    settlement: WorkflowEffectSettlementRecord,
  ): Promise<unknown> {
    const terminal = settlement.outcome === "success" ? settlement.result! : settlement.failure!;
    const callKey = workflowFreshCallKey({
      runId: operation.runId,
      previousCallKey: scope.previousCallKey,
      operation: workflowOperationIdentity(operation),
      semanticKey: settlement.semanticKey,
      outcome: settlement.outcome,
      completionAuthority: settlement.completionAuthority,
      replayPolicy: settlement.replayPolicy,
      result: terminal,
    });
    const evidence = settlement.outcome === "success" && adapter.evidence
      ? await adapter.evidence({
          run: this.database.readRun(), input, semanticInput, operation,
          result: settlement.result!, signal: scope.signal,
        })
      : undefined;
    let completed: WorkflowOperationRecord | undefined;
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
          ...(settlement.postWorkspaceCheckpointId ? {
            postWorkspaceCheckpointId: settlement.postWorkspaceCheckpointId,
          } : {}),
          ...(evidence?.artifacts?.length ? { artifacts: evidence.artifacts } : {}),
          at: this.timestamp(),
        });
        break;
      } catch (error) {
        if (error instanceof WorkflowRunDatabaseRevisionConflictError) continue;
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
    const identity: WorkflowEffectIdentity = {
      semanticKey: settlement.semanticKey,
      completionAuthority: settlement.completionAuthority,
      replayPolicy: settlement.outcome === "success" ? settlement.replayPolicy : "never",
      ...(settlement.outcome === "success" && settlement.postWorkspaceCheckpointId ? {
        postWorkspaceCheckpointId: settlement.postWorkspaceCheckpointId,
      } : {}),
    };
    return await this.restoreCommitted(scope, adapter, input, semanticInput, completed, identity);
  }

  private async claim(
    scope: CursorScope,
    cursor: number,
    kind: WorkflowOperationKind,
    invocation: Pick<WorkflowEffectInvocation, "sourceSite" | "descriptorSourceSite" | "title">,
    semanticInputHash: string,
  ): Promise<{ operation: WorkflowOperationRecord; claimed: boolean }> {
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
        if (error instanceof WorkflowRunDatabaseRevisionConflictError) continue;
        if (error instanceof WorkflowRunDatabaseStateError && /Semantic operation changed/u.test(error.message)) {
          const existing = this.database.readOperationAt(scope.record.scopeId, cursor);
          throw new WorkflowSemanticDriftError(error.message, existing?.path);
        }
        throw error;
      }
    }
    throw new Error("Could not claim workflow v17 operation after repeated revision races");
  }

  private async settle(
    operation: WorkflowOperationRecord,
    identity: WorkflowEffectIdentity,
    terminal: { outcome: "success"; result: JsonValue } | { outcome: "failure"; failure: JsonObject },
  ): Promise<WorkflowEffectSettlementRecord> {
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
          ...(terminal.outcome === "success" && identity.postWorkspaceCheckpointId ? {
            postWorkspaceCheckpointId: identity.postWorkspaceCheckpointId,
          } : {}),
          at: this.timestamp(),
        });
      } catch (error) {
        if (error instanceof WorkflowRunDatabaseRevisionConflictError) continue;
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
        throw new WorkflowSemanticDriftError("Workflow v17 root terminal key changed after restart");
      }
      return;
    }
    if (current.status !== "active") {
      throw new WorkflowSemanticDriftError(`Workflow v17 root scope is already ${current.status}`);
    }
    await this.completeScope(current, "completed", terminalKey);
    await this.fault("after-root-scope-complete");
  }

  private async failRootScope(scope: CursorScope, failure: JsonObject): Promise<void> {
    const terminalKey = stableHash({
      formatVersion: 1,
      kind: "workflow-scope-failure",
      previousCallKey: scope.previousCallKey,
      failure,
    });
    const current = this.database.readScope(scope.record.scopeId)!;
    if (current.status === "failed") {
      if (current.terminalKey !== terminalKey || stableHash(current.failure) !== stableHash(failure)) {
        throw new WorkflowSemanticDriftError("Workflow v17 root failure changed after restart");
      }
      return;
    }
    if (current.status !== "active") {
      throw new WorkflowSemanticDriftError(`Workflow v17 root scope is already ${current.status}`);
    }
    await this.completeScope(current, "failed", terminalKey, failure);
    await this.fault("after-root-scope-failure");
  }

  private async completeScope(
    scope: WorkflowScopeRecord,
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
        if (error instanceof WorkflowRunDatabaseRevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error("Could not complete workflow v17 scope after repeated revision races");
  }

  private async transitionRun(
    status: "running" | "paused" | "completed" | "failed",
    reason?: JsonObject,
    rootTerminalKey?: string,
    result?: JsonValue,
  ): Promise<void> {
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      const current = this.database.readRun();
      if (current.status === status) return;
      try {
        this.database.transitionRun(current.revision, {
          status,
          ...(reason ? { reason } : {}),
          ...(rootTerminalKey ? { rootTerminalKey } : {}),
          ...(result !== undefined ? { result } : {}),
          at: this.timestamp(),
        });
        return;
      } catch (error) {
        if (error instanceof WorkflowRunDatabaseRevisionConflictError) continue;
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

  private async fault(point: WorkflowSemanticEngineFaultPoint, operation?: WorkflowOperationRecord): Promise<void> {
    try {
      await this.options.faultInjector?.(point, operation);
    } catch (error) {
      this.fatalFault = error;
      throw error;
    }
  }
}

function normalizeIdentity(value: WorkflowEffectIdentity, kind: WorkflowEffectKind): WorkflowEffectIdentity {
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
    if (!value.workspace || !value.postWorkspaceCheckpointId) {
      throw new TypeError(`Workflow v17 ${kind} workspace effect lacks replay/checkpoint authority`);
    }
  } else if (value.workspace || value.postWorkspaceCheckpointId) {
    throw new TypeError(`Workflow v17 ${kind} non-workspace effect carries workspace authority`);
  }
  return value;
}

function assertSettlementIdentity(
  operation: WorkflowOperationRecord,
  settlement: WorkflowEffectSettlementRecord,
  identity: WorkflowEffectIdentity,
  expectedOutcome?: WorkflowEffectSettlementRecord["outcome"],
): void {
  if (settlement.semanticKey !== identity.semanticKey
    || settlement.completionAuthority !== identity.completionAuthority
    || (settlement.outcome === "success" && settlement.replayPolicy !== identity.replayPolicy)
    || (settlement.outcome === "success"
      && settlement.postWorkspaceCheckpointId !== identity.postWorkspaceCheckpointId)
    || (settlement.outcome === "failure" && settlement.replayPolicy !== "never")
    || (expectedOutcome !== undefined && settlement.outcome !== expectedOutcome)) {
    throw new WorkflowSemanticDriftError(
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

function failureFromError(error: unknown, effectKind?: WorkflowEffectKind): JsonObject {
  if (error instanceof WorkflowRecordedEffectError) return structuredClone(error.failure);
  if (error instanceof WorkflowRecordedStructuralError) return structuredClone(error.failure);
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
    ...(effectKind ? { effectKind } : {}),
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

function normalizeStructuredOptions(
  value: WorkflowStructuredOptions,
  label: "parallel" | "map",
  hostConcurrency: number,
): NormalizedStructuredOptions {
  if (!value || typeof value !== "object") throw new TypeError(`Workflow v17 ${label} options must be an object`);
  if (typeof value.sourceSite !== "string" || !/^[a-z][a-z0-9-]{0,127}$/u.test(value.sourceSite)) {
    throw new TypeError(`Workflow v17 ${label} source site is invalid`);
  }
  const concurrency = value.concurrency ?? hostConcurrency;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > hostConcurrency
    || concurrency > DEFINITION_LIMITS.concurrency) {
    throw new TypeError(`Workflow v17 ${label} concurrency must be 1–${Math.min(hostConcurrency, DEFINITION_LIMITS.concurrency)}`);
  }
  const errors = value.errors ?? "fail-fast";
  if (errors !== "fail-fast" && errors !== "collect") {
    throw new TypeError(`Workflow v17 ${label} errors must be fail-fast or collect`);
  }
  if (value.title !== undefined && (typeof value.title !== "string" || !value.title.trim()
    || Array.from(value.title).length > DEFINITION_LIMITS.titleScalars)) {
    throw new TypeError(`Workflow v17 ${label} title is invalid`);
  }
  return {
    sourceSite: value.sourceSite,
    ...(value.title ? { title: value.title } : {}),
    concurrency,
    errors,
  };
}

function normalizeMapOptions(
  value: WorkflowMapOptions,
  hostConcurrency: number,
): NormalizedStructuredOptions & Pick<WorkflowMapOptions, "key"> {
  const normalized = normalizeStructuredOptions(value, "map", hostConcurrency);
  if (typeof value.key !== "function") throw new TypeError("Workflow v17 map requires a key callback");
  return { ...normalized, key: value.key };
}

function assertLaneKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value)) {
    throw new TypeError("Workflow v17 lane key must match ^[a-z][a-z0-9_-]{0,63}$");
  }
}

function failedScopeTerminal(previousCallKey: string, failure: JsonObject): string {
  return stableHash({
    formatVersion: 1,
    kind: "workflow-scope-failure",
    previousCallKey,
    failure,
  });
}

function laneFromTerminal(scope: WorkflowScopeRecord): StructuredLaneOutcome {
  if (scope.status !== "failed" && scope.status !== "cancelled") {
    throw new WorkflowSemanticDriftError(`Workflow v17 lane ${scope.path} is not failed or cancelled`);
  }
  if (!scope.laneKey || !scope.terminalKey || !scope.failure) {
    throw new WorkflowSemanticDriftError(`Workflow v17 terminal lane ${scope.path} is incomplete`);
  }
  return {
    key: scope.laneKey,
    scope,
    outcome: scope.status === "failed" ? "failure" : "cancelled",
    terminalKey: scope.terminalKey,
    failure: structuredClone(scope.failure),
  };
}

function laneResult(
  lane: StructuredLaneOutcome,
  errors: "fail-fast" | "collect",
): unknown {
  if (errors === "collect") {
    return lane.outcome === "success"
      ? { ok: true, value: lane.value! }
      : { ok: false, error: branchError(lane.failure!) };
  }
  if (lane.outcome !== "success") {
    throw new Error(`Workflow v17 fail-fast lane ${lane.key} has no successful value`);
  }
  return lane.value!;
}

function branchError(failure: JsonObject): JsonObject {
  const category = typeof failure.category === "string" ? failure.category : "control";
  const effectKind = typeof failure.effectKind === "string" ? failure.effectKind : undefined;
  const kind = effectKind === "agent" ? "agent"
    : effectKind === "command" ? "command"
    : category === "agent" ? "agent"
    : category === "command" ? "command"
      : category === "infrastructure" ? "infrastructure"
        : "control";
  return {
    kind,
    summary: typeof failure.summary === "string" ? failure.summary : "Concurrent workflow lane failed",
    evidence: [],
  };
}

function structuralFailure(
  kind: "parallel" | "map" | "candidate",
  laneKey: string,
  cause: JsonObject,
): JsonObject {
  return canonicalJsonObject({
    category: "structure",
    code: `${kind}-lane-failed`,
    summary: `${kind} lane ${laneKey} failed: ${typeof cause.summary === "string" ? cause.summary : "unknown failure"}`,
    retryable: false,
    laneKey,
    cause,
  }, {
    maxBytes: 64 * 1024,
    maxDepth: 12,
    maxNodes: 256,
    maxStringScalars: 20_000,
  });
}

function cancellationFailure(laneKey: string): JsonObject {
  return {
    category: "structure",
    code: "sibling-cancelled",
    summary: `Cancelled after lane ${laneKey} failed`,
    retryable: false,
    laneKey,
  };
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function linkedController(parent: AbortSignal): AbortController & { dispose(): void } {
  const controller = new AbortController() as AbortController & { dispose(): void };
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(parent.reason);
  };
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  controller.dispose = () => parent.removeEventListener("abort", abort);
  return controller;
}

function isPassthrough(error: unknown): boolean {
  return error instanceof WorkflowSemanticEngineCrashError
    || error instanceof WorkflowSemanticDriftError
    || error instanceof WorkflowHumanSuspension;
}
