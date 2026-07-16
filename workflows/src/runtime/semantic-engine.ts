import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ParsedStructuredWorkflow } from "../definition/types.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import { evaluateControlDefinition } from "./control-worker-host.js";
import { ArtifactStore } from "../artifacts/store.js";
import {
  RunDatabase,
  RunDatabaseAdmissionError,
  RunDatabaseStateError,
  RunRevisionConflictError,
} from "../persistence/run-database.js";
import {
  zeroUsage,
  type HumanCheckpointRequest,
  type OperationKind,
  type OperationRecord,
  type OperationResult,
  type RunRecord,
  type StructuredReason,
} from "./durable-types.js";
import type { JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import {
  boundedError,
  canonicalInvocationInput,
  canonicalStructuralJson,
  effectFailureReason,
  normalizeCheckpointRequest,
  normalizeStageOptions,
  operationSourceId,
  validateJsonSchema,
  workflowFailureReason,
} from "./semantic-engine-values.js";
import {
  SemanticEngineCrashError,
  SemanticRunawayAdmissionError,
  SemanticOperationError,
  type SemanticEffectAdapter,
  type SemanticEffectAdmissionRequest,
  type SemanticEffectKind,
  type SemanticEffectOutcome,
  type SemanticEngineFaultPoint,
  type SemanticEngineInvocation,
  type SemanticEngineScope,
  type SequentialSemanticEngineOptions,
  type SequentialSemanticRunOutcome,
} from "./semantic-engine-types.js";
import {
  CandidateConcurrencyGuard,
  SemanticConcurrencyLimiter,
} from "./semantic-engine-concurrency.js";
import {
  StructuredConcurrencyRuntime,
  type StructuralBranchBinding,
  type StructuralPreclaim,
} from "./semantic-structured-concurrency.js";
import { SemanticRunLifecycle } from "./semantic-run-lifecycle.js";
import {
  assertPreclaimedSemanticOperation,
  assertSemanticOperationIdentity,
  boundedOperationAdmissionLimit,
  boundedSemanticPollInterval,
  deterministicSemanticId,
  linkedSemanticController,
  recordedSemanticFailure,
  semanticInvocationHash,
  semanticOperationPath,
} from "./semantic-engine-helpers.js";
import type { SemanticEffectJournalIdentity } from "./semantic-engine-types.js";
import { SemanticJournalRuntime } from "./semantic-journal.js";
import { createMetricHandle } from "../measurements/metrics.js";
import { isCandidateWorkspaceCapability } from "../candidates/store.js";

export { semanticInvocationHash } from "./semantic-engine-helpers.js";

export * from "./semantic-engine-types.js";

const MAX_REVISION_RETRIES = 16;

class SemanticRunSuspension extends Error {
  constructor(readonly status: "waiting" | "paused" | "stopped", message: string) {
    super(message);
    this.name = "SemanticRunSuspension";
  }
}

/** SQLite-backed sequential control and effect engine. */
export class SequentialSemanticEngine {
  private readonly storage = new AsyncLocalStorage<SemanticEngineScope>();
  private readonly adapters = new Map<SemanticEffectKind, SemanticEffectAdapter>();
  private readonly rootController = new AbortController();
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private readonly lifecycle: SemanticRunLifecycle;
  private readonly externalSignal?: AbortSignal;
  private readonly externalAbort?: () => void;
  private readonly limiter: SemanticConcurrencyLimiter;
  private readonly candidateConcurrency: CandidateConcurrencyGuard;
  private readonly structures: StructuredConcurrencyRuntime;
  private readonly operationAdmissionLimit: number;
  private readonly journal: SemanticJournalRuntime;

  constructor(
    readonly runDir: string,
    readonly database: RunDatabase,
    readonly parsed: ParsedStructuredWorkflow,
    readonly invocation: SemanticEngineInvocation,
    adapters: readonly SemanticEffectAdapter[],
    readonly options: SequentialSemanticEngineOptions = {},
  ) {
    this.runDir = path.resolve(runDir);
    if (path.resolve(database.databasePath) !== path.join(this.runDir, "run.sqlite")) {
      throw new Error("Semantic engine run directory and database do not match");
    }
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = boundedSemanticPollInterval(options.controlPollIntervalMs ?? 25);
    const run = database.readRun();
    this.operationAdmissionLimit = boundedOperationAdmissionLimit(
      options.operationAdmissionLimit ?? DEFINITION_LIMITS.semanticOperations,
    );
    const concurrency = Math.min(
      run.safety.concurrency,
      parsed.metadata.maxParallelism ?? DEFINITION_LIMITS.concurrency,
      DEFINITION_LIMITS.concurrency,
    );
    this.limiter = new SemanticConcurrencyLimiter(concurrency);
    this.candidateConcurrency = new CandidateConcurrencyGuard(run.runId);
    const artifacts = new ArtifactStore(this.runDir, database, {
      now: this.now,
      maximumArtifactBytes: run.safety.outputBytes,
    });
    this.lifecycle = new SemanticRunLifecycle(database, parsed, artifacts, {
      timestamp: () => this.timestamp(),
      boundary: async () => await this.boundary(),
      faultAfterResultArtifact: async () => await this.fault("after-result-artifact"),
    });
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.kind)) throw new Error(`Duplicate semantic effect adapter ${adapter.kind}`);
      this.adapters.set(adapter.kind, adapter);
    }
    this.structures = new StructuredConcurrencyRuntime({
      concurrency,
      structuralOperation: async (kind, id, semanticInputHash, body) => await this.structuralOperation(
        kind, id, semanticInputHash, body,
      ),
      preclaim: async (parent, specs) => await this.preclaim(parent, specs),
      children: (parentOperationId) => this.database.readStructuredQueue(parentOperationId)?.children ?? [],
      runPreclaimedChild: async (parent, operation, body, branch) => await this.runPreclaimedChild(
        parent, operation, body, branch,
      ),
      branchFailure: (error, branch) => this.branchFailure(error, branch),
      isPassthrough: (error) => this.isPassthrough(error),
      cancelSiblings: (error) => !(error instanceof SemanticRunawayAdmissionError),
      branchSettled: (operationPath) => this.journal.settleStructuralScope(operationPath),
    });
    this.assertIdentity();
    this.journal = new SemanticJournalRuntime(this.runDir, database, options.replaySourceRunDir, {
      timestamp: () => this.timestamp(),
      boundary: async (operationId) => await this.boundary(operationId),
      fault: async (point, operation) => await this.fault(point, operation),
      currentOperationId: (excludingOperationId) => this.activeAncestor(this.scope(), excludingOperationId),
    });
    if (options.signal) {
      this.externalSignal = options.signal;
      this.externalAbort = () => {
        if (!this.rootController.signal.aborted) this.rootController.abort(options.signal!.reason);
      };
      options.signal.addEventListener("abort", this.externalAbort, { once: true });
      if (options.signal.aborted) this.externalAbort();
    }
  }

  async run(): Promise<SequentialSemanticRunOutcome> {
    try {
      const terminal = await this.lifecycle.startOrReadTerminal(
        () => this.rootController.signal.aborted,
        async () => await this.pauseForExternalCancellation(),
      );
      if (terminal) return terminal;
      await this.fault("after-run-start");
      const input = canonicalInvocationInput(this.invocation.input);
      validateJsonSchema(this.parsed.metadata.inputSchema, input, "workflow inputSchema");
      const root: SemanticEngineScope = {
        path: "run",
        seenIds: new Set(),
        signal: this.rootController.signal,
        branchLineage: new Map(),
      };
      const value = await this.storage.run(root, () => evaluateControlDefinition({
        executableSource: this.parsed.executableSource,
        workflowName: this.parsed.metadata.name,
        flow: this.flowApi(),
        args: input,
        ...(this.options.snapshot !== undefined ? { snapshot: this.options.snapshot } : {}),
        signal: this.rootController.signal,
        rootContext: root,
        currentContext: () => this.scope(),
        runInContext: (scope, body) => this.storage.run(scope, body),
      }));
      await this.boundary();
      const result = canonicalStructuralJson(value);
      validateJsonSchema(this.parsed.metadata.outputSchema, result, "workflow outputSchema");
      return await this.lifecycle.complete(result);
    } catch (error) {
      if (error instanceof SemanticEngineCrashError) throw error;
      if (this.externalSignal?.aborted) {
        await this.limiter.whenIdle();
        return await this.pauseForExternalCancellation();
      }
      if (error instanceof SemanticRunawayAdmissionError) return await this.pauseForRunaway(error);
      if (error instanceof SemanticRunSuspension) {
        await this.limiter.whenIdle();
        return await this.controlledOutcome(error);
      }
      return await this.lifecycle.fail(error);
    } finally {
      if (this.externalSignal && this.externalAbort) {
        this.externalSignal.removeEventListener("abort", this.externalAbort);
      }
      this.journal.close();
      await Promise.all([...this.adapters.values()].map(async (adapter) => await adapter.dispose?.()));
    }
  }

  private flowApi(): Record<string, unknown> {
    return Object.freeze({
      stage: (id: unknown, body: unknown, options?: unknown) => this.stage(id, body, options),
      loop: (id: unknown, options: unknown, body: unknown) => this.structures.loop(id, options, body),
      parallel: (id: unknown, branches: unknown, options?: unknown) => this.structures.parallel(id, branches, options),
      fanOut: (id: unknown, items: unknown, options: unknown, body: unknown) => this.structures.fanOut(id, items, options, body),
      agent: (id: unknown, input: unknown) => this.effect("agent", id, input),
      command: (id: unknown, input: unknown) => this.effect("command", id, input),
      checkpoint: (id: unknown, input: unknown) => this.checkpoint(id, input),
      metric: (id: unknown, definition: unknown) => createMetricHandle(id, definition),
      measure: (id: unknown, input: unknown) => this.effect("measure", id, input),
      candidate: (id: unknown, body: unknown, options?: unknown) => this.candidate(id, body, options),
      verify: (id: unknown, input: unknown) => this.effect("verify", id, input),
      accept: (id: unknown, input: unknown) => this.effect("accept", id, input),
      reject: (id: unknown, input: unknown) => this.effect("reject", id, input),
      recordExperiment: (id: unknown, input: unknown) => this.effect("record-experiment", id, input),
      apply: (id: unknown, input: unknown) => this.effect("apply", id, input),
    });
  }

  private async stage(idValue: unknown, body: unknown, optionsValue: unknown): Promise<unknown> {
    if (typeof body !== "function") throw new Error("flow.stage() body must be a callback");
    const options = normalizeStageOptions(optionsValue);
    return await this.structuralOperation(
      "stage",
      idValue,
      stableHash({ title: options.title ?? null }),
      async () => await Promise.resolve((body as () => unknown)()),
    );
  }

  private async structuralOperation<T>(
    kind: Extract<OperationKind, "stage" | "loop" | "parallel" | "fan-out">,
    idValue: unknown,
    semanticInputHash: string,
    body: (operation: OperationRecord, scope: SemanticEngineScope) => Promise<T>,
  ): Promise<T> {
    const id = operationSourceId(idValue);
    const parent = this.scope();
    const operation = await this.claim(parent, kind, id, semanticInputHash);
    return await this.executeStructuralOperation(operation, parent, body);
  }

  private async runPreclaimedChild<T>(
    parent: SemanticEngineScope,
    operation: OperationRecord,
    body: () => unknown,
    branch?: StructuralBranchBinding,
  ): Promise<T> {
    let current = this.database.readOperation(operation.operationId);
    if (!current) throw new RunDatabaseStateError(`Missing preclaimed operation ${operation.path}`);
    if (current.status === "queued") current = await this.focus(current);
    return await this.executeStructuralOperation(current, parent, async () => await Promise.resolve(body()) as T, branch);
  }

  private async executeStructuralOperation<T>(
    operation: OperationRecord,
    parent: SemanticEngineScope,
    body: (operation: OperationRecord, scope: SemanticEngineScope) => Promise<T>,
    branch?: StructuralBranchBinding,
  ): Promise<T> {
    if (operation.status === "failed") throw recordedSemanticFailure(operation);
    if (operation.status === "paused" || operation.status === "stopped" || operation.status === "waiting") {
      throw new SemanticRunSuspension(operation.status, `Structure ${operation.path} is ${operation.status}`);
    }
    if (branch?.signal.aborted) throw branch.signal.reason;
    const branchLineage = new Map(parent.branchLineage);
    if (branch) branchLineage.set(branch.groupId, branch.key);
    const child: SemanticEngineScope = {
      path: operation.path,
      operationId: operation.operationId,
      parent,
      seenIds: new Set(),
      signal: branch?.signal ?? parent.signal,
      branchLineage,
    };
    try {
      // Completed stages deliberately re-enter deterministic control so nested
      // committed effects can reconstruct workflow-facing opaque handles.
      const result = await this.storage.run(child, () => body(operation, child));
      await this.boundary();
      const current = this.database.readOperation(operation.operationId);
      if (!current) throw new RunDatabaseStateError(`Missing structural operation ${operation.path}`);
      if (current.status !== "completed") await this.completeOperation(current, { artifacts: [] });
      if (operation.kind === "parallel" || operation.kind === "fan-out") await this.normalizeOperationOrder();
      return result;
    } catch (error) {
      if (this.isPassthrough(error)) throw error;
      const current = this.database.readOperation(operation.operationId);
      if (current && current.status !== "completed" && current.status !== "failed") {
        await this.failOperation(current, workflowFailureReason(error, current.operationId));
      }
      throw error;
    }
  }

  private async preclaim(
    parent: OperationRecord,
    specs: readonly StructuralPreclaim[],
  ): Promise<OperationRecord[]> {
    if (specs.length === 0) return [];
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      await this.boundary(parent.operationId);
      const existing = specs.map((spec) => this.database.readOperationByPath(spec.path));
      if (existing.every(Boolean)) {
        for (let index = 0; index < specs.length; index++) {
          assertPreclaimedSemanticOperation(existing[index]!, parent.operationId, specs[index]!);
        }
        return existing as OperationRecord[];
      }
      if (existing.some(Boolean)) throw new RunDatabaseStateError(`Structural queue ${parent.path} was only partly preclaimed`);
      const run = this.database.readRun();
      const at = this.timestamp();
      const firstOrdinal = this.database.nextOperationOrdinal();
      const operations = specs.map((spec, index): OperationRecord => ({
        operationId: deterministicSemanticId("operation", run.runId, spec.path),
        runId: run.runId,
        parentOperationId: parent.operationId,
        path: spec.path,
        sourceId: spec.sourceId,
        kind: "stage",
        ordinal: firstOrdinal + index,
        status: "queued",
        semanticInputHash: spec.semanticInputHash,
        attemptCount: 0,
        createdAt: at,
        updatedAt: at,
      }));
      try {
        return this.database.preclaimOperations({
          expectedRevision: run.revision,
          operations,
          admission: this.admissionLimits(run),
          event: {
            type: "structure-preclaimed",
            operationId: parent.operationId,
            payload: { path: parent.path, count: operations.length, firstOrdinal },
            at,
          },
        });
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        if (error instanceof RunDatabaseAdmissionError) throw this.runaway(error, parent.operationId);
        throw error;
      }
    }
    throw new Error("Could not preclaim structural operations after repeated revision races");
  }

  private async focus(operation: OperationRecord): Promise<OperationRecord> {
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      await this.boundary(operation.operationId);
      const current = this.database.readOperation(operation.operationId);
      if (!current) throw new RunDatabaseStateError(`Missing operation ${operation.path}`);
      if (current.status !== "queued") return current;
      const run = this.database.readRun();
      try {
        return this.database.focusOperation({
          expectedRevision: run.revision,
          operationId: operation.operationId,
          focusedAt: this.timestamp(),
          event: { type: "operation-started", payload: { path: operation.path } },
        });
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error("Could not start preclaimed operation after repeated revision races");
  }

  private async normalizeOperationOrder(): Promise<void> {
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      await this.boundary();
      const run = this.database.readRun();
      try {
        this.database.normalizeOperationOrdinals(run.revision, this.timestamp());
        return;
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error("Could not normalize operation order after repeated revision races");
  }

  private async effect(kind: SemanticEffectKind, idValue: unknown, input: unknown): Promise<unknown> {
    const id = operationSourceId(idValue);
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`No semantic effect adapter is installed for ${kind}`);
    const parent = this.scope();
    this.candidateConcurrency.assertSafe(input, parent.branchLineage);
    const pathValue = semanticOperationPath(parent.path, kind, id);
    const admission: SemanticEffectAdmissionRequest = {
      run: this.database.readRun(), kind, sourceId: id, path: pathValue, input,
    };
    const semanticInput = canonicalStructuralJson(await adapter.semanticInput(admission));
    const journalIdentity = await this.journal.identity(adapter, admission);
    const operation = await this.claim(parent, kind, id, stableHash(semanticInput));
    if (operation.status === "completed") return await this.restore(adapter, admission, operation);
    if (operation.status === "failed") throw recordedSemanticFailure(operation);
    if (operation.status === "paused" || operation.status === "stopped" || operation.status === "waiting") {
      throw new SemanticRunSuspension(operation.status, `Effect ${operation.path} is ${operation.status}`);
    }

    const controller = linkedSemanticController(parent.signal);
    const monitor = setInterval(() => {
      const suspension = this.controlSuspension(operation.operationId);
      if (suspension && !controller.signal.aborted) controller.abort(suspension);
    }, this.pollIntervalMs);
    monitor.unref?.();
    let lease: Awaited<ReturnType<SemanticConcurrencyLimiter["acquire"]>> | undefined;
    try {
      lease = await this.limiter.acquire(controller.signal);
      await this.boundary(operation.operationId);
      const request = { ...admission, database: this.database, operation, signal: controller.signal };
      const replayed = await this.journal.consume(adapter, request, journalIdentity);
      if (replayed) return await this.restore(adapter, admission, replayed);
      if (controller.signal.aborted) throw controller.signal.reason;
      await this.boundary(operation.operationId);
      const outcome = await adapter.execute(request);
      if (outcome.completionAuthority !== journalIdentity.completionAuthority) {
        throw new Error(`Effect ${operation.path} completed through the wrong authority`);
      }
      if (
        (kind === "agent" || kind === "command")
        && containsCandidateWorkspaceCapability(input)
        && (!outcome.result.workspace || outcome.result.workspace.kind !== "candidate" || !outcome.workspaceCheckpoint)
      ) {
        throw new Error(`Mutating child ${operation.path} completed without an exact candidate checkpoint`);
      }
      await this.fault("after-effect-settled", operation);
      await this.boundary(operation.operationId);
      const completed = await this.completeOperation(operation, outcome.result, outcome, journalIdentity);
      await this.fault("after-operation-completion", completed);
      return await this.restore(adapter, admission, completed);
    } catch (error) {
      if (error instanceof SemanticEngineCrashError) throw error;
      const suspension = await this.detectSuspension(operation.operationId);
      if (suspension) throw suspension;
      const current = this.database.readOperation(operation.operationId);
      if (current?.status === "completed") return await this.restore(adapter, admission, current);
      if (current && current.status !== "failed") {
        const failed = await this.failOperation(current, effectFailureReason(error, current.operationId));
        throw new SemanticOperationError(failed, boundedError(error));
      }
      throw error;
    } finally {
      lease?.release();
      clearInterval(monitor);
      controller.dispose();
    }
  }

  /**
   * Candidate owns a callback scope rather than one host effect. Its mutating
   * children are journaled and checkpointed normally; the container merely
   * freezes their final tree, so journaling it would put a parent call before
   * the child calls whose post-state it summarizes.
   */
  private async candidate(idValue: unknown, body: unknown, options: unknown): Promise<unknown> {
    if (typeof body !== "function") throw new Error("flow.candidate() body must be a callback");
    const id = operationSourceId(idValue);
    const adapter = this.adapters.get("candidate");
    if (!adapter) throw new Error("No semantic effect adapter is installed for candidate");
    const parent = this.scope();
    const input = { body, options };
    const pathValue = semanticOperationPath(parent.path, "candidate", id);
    const admission: SemanticEffectAdmissionRequest = {
      run: this.database.readRun(), kind: "candidate", sourceId: id, path: pathValue, input,
    };
    const semanticInput = canonicalStructuralJson(await adapter.semanticInput(admission));
    const operation = await this.claim(parent, "candidate", id, stableHash(semanticInput));
    if (operation.status === "completed") return await this.restore(adapter, admission, operation);
    if (operation.status === "failed") throw recordedSemanticFailure(operation);
    if (operation.status === "paused" || operation.status === "stopped" || operation.status === "waiting") {
      throw new SemanticRunSuspension(operation.status, `Candidate ${operation.path} is ${operation.status}`);
    }

    const controller = linkedSemanticController(parent.signal);
    const monitor = setInterval(() => {
      const suspension = this.controlSuspension(operation.operationId);
      if (suspension && !controller.signal.aborted) controller.abort(suspension);
    }, this.pollIntervalMs);
    monitor.unref?.();
    const child: SemanticEngineScope = {
      path: operation.path,
      operationId: operation.operationId,
      parent,
      seenIds: new Set(),
      signal: controller.signal,
      branchLineage: new Map(parent.branchLineage),
    };
    try {
      await this.boundary(operation.operationId);
      const request = { ...admission, database: this.database, operation, signal: controller.signal };
      const outcome = await this.storage.run(child, async () => await adapter.execute(request));
      if (outcome.completionAuthority !== "host-effect") {
        throw new Error(`Candidate ${operation.path} completed through the wrong authority`);
      }
      if (outcome.result.workspace || outcome.workspaceCheckpoint) {
        throw new Error(`Candidate container ${operation.path} cannot replace child checkpoint authority`);
      }
      await this.fault("after-effect-settled", operation);
      await this.boundary(operation.operationId);
      const completed = await this.completeOperation(operation, outcome.result, outcome);
      await this.fault("after-operation-completion", completed);
      return await this.restore(adapter, admission, completed);
    } catch (error) {
      if (error instanceof SemanticEngineCrashError) throw error;
      const suspension = await this.detectSuspension(operation.operationId);
      if (suspension) throw suspension;
      const current = this.database.readOperation(operation.operationId);
      if (current?.status === "completed") return await this.restore(adapter, admission, current);
      if (current && current.status !== "failed") {
        const failed = await this.failOperation(current, effectFailureReason(error, current.operationId));
        throw new SemanticOperationError(failed, boundedError(error));
      }
      throw error;
    } finally {
      clearInterval(monitor);
      controller.dispose();
    }
  }

  private async checkpoint(idValue: unknown, input: unknown): Promise<JsonValue> {
    if (!this.database.readRun().workflow.capabilities.includes("human-input")) {
      throw new Error("flow.checkpoint() requires human-input capability");
    }
    const id = operationSourceId(idValue);
    const request = normalizeCheckpointRequest(input);
    const parent = this.scope();
    const operation = await this.claim(parent, "checkpoint", id, stableHash(request));
    const checkpointId = deterministicSemanticId("checkpoint", this.database.readRun().runId, operation.path);
    let checkpoint = this.database.readHumanCheckpoint(checkpointId);
    if (!checkpoint) {
      checkpoint = await this.createCheckpoint(operation, request, checkpointId);
      await this.fault("after-checkpoint-request", operation);
    }
    if (checkpoint.operationId !== operation.operationId || stableHash(checkpoint.request) !== stableHash(request)) {
      throw new RunDatabaseStateError(`Checkpoint ${checkpointId} changed semantic identity`);
    }
    if (checkpoint.status === "waiting") this.suspend("waiting", `Checkpoint ${operation.path} is waiting for human input`);
    if (checkpoint.status === "stopped") this.suspend("stopped", `Checkpoint ${operation.path} was stopped`);
    if (checkpoint.response === undefined) throw new RunDatabaseStateError(`Completed checkpoint ${checkpointId} has no response`);
    await this.fault("after-checkpoint-response", operation);
    const current = this.database.readOperation(operation.operationId)!;
    if (current.status !== "completed") {
      await this.completeOperation(current, { value: checkpoint.response, artifacts: [] });
      await this.fault("after-checkpoint-completion", current);
    }
    return checkpoint.response;
  }

  private async claim(
    parent: SemanticEngineScope,
    kind: OperationKind,
    id: string,
    semanticInputHash: string,
  ): Promise<OperationRecord> {
    if (parent.seenIds.has(id)) throw new Error(`Duplicate sibling operation id ${id} in ${parent.path}`);
    parent.seenIds.add(id);
    const pathValue = semanticOperationPath(parent.path, kind, id);
    const existing = this.database.readOperationByPath(pathValue);
    if (existing) {
      assertSemanticOperationIdentity(existing, parent.operationId, kind, id, semanticInputHash);
      if (existing.status === "completed" || existing.status === "failed") return existing;
    }
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      await this.boundary(existing?.operationId);
      const run = this.database.readRun();
      const at = this.timestamp();
      const operation: OperationRecord = {
        operationId: deterministicSemanticId("operation", run.runId, pathValue),
        runId: run.runId,
        ...(parent.operationId ? { parentOperationId: parent.operationId } : {}),
        path: pathValue,
        sourceId: id,
        kind,
        ordinal: existing?.ordinal ?? this.database.nextOperationOrdinal(),
        status: "running",
        semanticInputHash,
        attemptCount: 0,
        createdAt: existing?.createdAt ?? at,
        startedAt: existing?.startedAt ?? at,
        updatedAt: at,
      };
      try {
        const claimed = this.database.claimOperation({
          expectedRevision: run.revision,
          operation,
          admission: this.admissionLimits(run),
          event: { type: existing ? "operation-focused" : "operation-claimed", operationId: operation.operationId, payload: { path: pathValue, kind }, at },
        }).operation;
        await this.fault("after-operation-claim", claimed);
        return claimed;
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        if (error instanceof RunDatabaseAdmissionError) throw this.runaway(error, parent.operationId);
        throw error;
      }
    }
    throw new Error("Could not claim operation after repeated revision races");
  }

  private async completeOperation(
    operation: OperationRecord,
    result: OperationResult,
    outcome: Partial<Omit<SemanticEffectOutcome, "result">> = {},
    journalIdentity?: SemanticEffectJournalIdentity,
  ): Promise<OperationRecord> {
    const already = this.database.readOperation(operation.operationId);
    if (already?.status === "completed") return already;
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      const current = this.database.readOperation(operation.operationId);
      if (current?.status === "completed") return current;
      await this.boundary(operation.operationId);
      const run = this.database.readRun();
      try {
        const journal = journalIdentity
          ? this.journal.call(operation, result, journalIdentity, outcome.workspaceCheckpoint)
          : undefined;
        return this.database.completeOperation({
          expectedRevision: run.revision,
          operationId: operation.operationId,
          ...(outcome.attemptId ? { attemptId: outcome.attemptId } : {}),
          completedAt: this.timestamp(),
          result,
          ...(outcome.artifacts ? { artifacts: outcome.artifacts } : {}),
          ...(outcome.evidenceArtifacts ? { evidenceArtifacts: outcome.evidenceArtifacts } : {}),
          ...(outcome.progressArtifacts ? { progressArtifacts: outcome.progressArtifacts } : {}),
          usage: outcome.usage ?? zeroUsage(),
          ...(outcome.resources ? { resources: outcome.resources } : {}),
          ...(outcome.workspaceCheckpoint ? { workspaceCheckpoint: outcome.workspaceCheckpoint } : {}),
          ...(outcome.measurement ? { measurement: outcome.measurement } : {}),
          ...(outcome.experiment ? { experiment: outcome.experiment } : {}),
          ...(outcome.verification ? { verification: outcome.verification } : {}),
          ...(journal ? { journal } : {}),
          currentOperationId: this.activeAncestor(this.scope(), operation.operationId),
          event: { type: "operation-completed", payload: { path: operation.path, kind: operation.kind } },
        });
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error("Could not complete operation after repeated revision races");
  }

  private async failOperation(operation: OperationRecord, reason: StructuredReason): Promise<OperationRecord> {
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      const suspension = await this.detectSuspension(operation.operationId);
      if (suspension) throw suspension;
      const current = this.database.readOperation(operation.operationId);
      if (!current || current.status === "failed") return current ?? operation;
      if (current.status === "completed") return current;
      const run = this.database.readRun();
      try {
        return this.database.failOperation({
          expectedRevision: run.revision,
          operationId: operation.operationId,
          failedAt: this.timestamp(),
          reason,
          currentOperationId: this.activeAncestor(this.scope(), operation.operationId),
          event: { type: "operation-failed", payload: { path: operation.path, kind: operation.kind } },
        });
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error("Could not fail operation after repeated revision races");
  }

  private async createCheckpoint(
    operation: OperationRecord,
    request: HumanCheckpointRequest,
    checkpointId: string,
  ) {
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      await this.boundary(operation.operationId);
      const run = this.database.readRun();
      const requestedRevision = run.revision + 1;
      const requestedAt = this.timestamp();
      const challengeHash = stableHash({
        runId: run.runId, operationId: operation.operationId, path: operation.path,
        semanticInputHash: operation.semanticInputHash, request, requestedRevision,
      });
      try {
        return this.database.createHumanCheckpoint(run.revision, {
          checkpointId, runId: run.runId, operationId: operation.operationId,
          status: "waiting", request, challengeHash, requestedRevision, requestedAt,
        }, {
          type: "checkpoint-requested", operationId: operation.operationId,
          payload: { checkpointId, challengeHash }, at: requestedAt,
        });
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error("Could not create checkpoint after repeated revision races");
  }

  private async restore(
    adapter: SemanticEffectAdapter,
    admission: SemanticEffectAdmissionRequest,
    operation: OperationRecord,
  ): Promise<unknown> {
    if (!operation.result) throw new RunDatabaseStateError(`Completed operation ${operation.path} has no result`);
    if (operation.result.workspace?.kind === "candidate" && !adapter.restore) {
      throw new RunDatabaseStateError(`Completed mutation ${operation.path} has no workspace restore adapter`);
    }
    return adapter.restore
      ? await adapter.restore({ ...admission, database: this.database, operation: operation as OperationRecord & { result: OperationResult } })
      : operation.result.value;
  }

  private async controlledOutcome(suspension: SemanticRunSuspension): Promise<SequentialSemanticRunOutcome> {
    const run = this.database.readRun();
    if (run.status === "failed") return { status: "failed", run, error: run.reason?.summary ?? suspension.message };
    if (run.status === "waiting" || run.status === "paused" || run.status === "stopped") return { status: run.status, run };
    if (suspension.status === "stopped") {
      for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
        const current = this.database.readRun();
        if (current.status === "stopped") return { status: "stopped", run: current };
        try {
          const stopped = this.database.transitionRun(current.revision, {
            status: "stopped", reason: current.reason ?? {
              category: "control", code: "effect-stopped", summary: suspension.message, retryable: false,
            }, currentOperationId: null, endedAt: this.timestamp(),
            event: { type: "run-stopped", payload: {}, at: this.timestamp() },
          });
          return { status: "stopped", run: stopped };
        } catch (error) { if (!(error instanceof RunRevisionConflictError)) throw error; }
      }
    }
    throw new RunDatabaseStateError(`Run remained ${run.status} after ${suspension.status} suspension`);
  }

  private async pauseForExternalCancellation(): Promise<SequentialSemanticRunOutcome> {
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      const run = this.database.readRun();
      if (run.status === "paused" || run.status === "waiting" || run.status === "stopped") return { status: run.status, run };
      if (run.status === "failed") return { status: "failed", run, error: run.reason?.summary ?? "Workflow failed" };
      if (run.status === "completed") return await this.lifecycle.readCompleted(run);
      try {
        const paused = this.database.pauseCoordinatorForSignal(run.revision, this.timestamp(), "Semantic engine execution was cancelled");
        return { status: "paused", run: paused };
      } catch (error) { if (!(error instanceof RunRevisionConflictError)) throw error; }
    }
    throw new Error("Could not pause cancelled run after repeated revision races");
  }

  private async pauseForRunaway(error: SemanticRunawayAdmissionError): Promise<SequentialSemanticRunOutcome> {
    await this.limiter.whenIdle();
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      const run = this.database.readRun();
      if (run.status === "paused" || run.status === "waiting" || run.status === "stopped") {
        return { status: run.status, run };
      }
      if (run.status === "completed") return await this.lifecycle.readCompleted(run);
      if (run.status === "failed") return { status: "failed", run, error: run.reason?.summary ?? error.message };
      try {
        const paused = this.database.pauseRunForSafety(run.revision, this.timestamp(), error.reason);
        return { status: "paused", run: paused };
      } catch (transitionError) {
        if (transitionError instanceof RunRevisionConflictError) continue;
        throw transitionError;
      }
    }
    throw new Error("Could not pause runaway workflow after repeated revision races");
  }

  private admissionLimits(run: RunRecord) {
    return {
      maximumOperations: this.operationAdmissionLimit,
      maximumAgentOperations: run.safety.maximumAgentLaunches,
    };
  }

  private runaway(error: RunDatabaseAdmissionError, operationId?: string): SemanticRunawayAdmissionError {
    const reason: StructuredReason = {
      category: "safety",
      code: error.guard === "operations" ? "operation-runaway" : "agent-launch-runaway",
      summary: error.message,
      retryable: true,
      ...(operationId ? { operationId } : {}),
      details: {
        guard: error.guard,
        admitted: error.admitted,
        requested: error.requested,
        limit: error.limit,
      },
    };
    const runaway = new SemanticRunawayAdmissionError(reason);
    this.limiter.close(runaway);
    return runaway;
  }

  private isPassthrough(error: unknown): boolean {
    return error instanceof SemanticRunSuspension
      || error instanceof SemanticEngineCrashError
      || error instanceof SemanticRunawayAdmissionError;
  }

  private branchFailure(error: unknown, branch: OperationRecord): Record<string, unknown> {
    const failed = error instanceof SemanticOperationError
      ? this.database.readOperation(error.operationId)
      : this.database.readOperation(branch.operationId);
    const operation = failed ?? branch;
    const kind = operation.kind === "agent"
      ? "agent"
      : operation.kind === "command"
        ? "command"
        : operation.reason?.category === "infrastructure" || operation.reason?.category === "provider"
          ? "infrastructure"
          : "control";
    return {
      operationPath: error instanceof SemanticOperationError ? error.operationPath : operation.path,
      kind,
      summary: boundedError(error),
    };
  }

  private async boundary(operationId?: string): Promise<void> {
    if (this.externalSignal?.aborted) throw new SemanticRunSuspension("paused", "Semantic engine execution was cancelled");
    const suspension = this.controlSuspension(operationId);
    if (suspension) throw suspension;
  }

  private async detectSuspension(operationId?: string): Promise<SemanticRunSuspension | undefined> {
    if (this.externalSignal?.aborted) {
      const outcome = await this.pauseForExternalCancellation();
      if (outcome.status === "failed" || outcome.status === "completed") return undefined;
      return new SemanticRunSuspension(outcome.status, "Semantic engine execution was cancelled");
    }
    return this.controlSuspension(operationId);
  }

  private controlSuspension(operationId?: string): SemanticRunSuspension | undefined {
    const run = this.database.readRun();
    if (run.status === "waiting" || run.status === "paused" || run.status === "stopped") {
      return new SemanticRunSuspension(run.status, run.reason?.summary ?? `Run is ${run.status}`);
    }
    if (!operationId) return undefined;
    const operation = this.database.readOperation(operationId);
    if (operation?.status === "waiting" || operation?.status === "paused" || operation?.status === "stopped") {
      return new SemanticRunSuspension(operation.status, operation.reason?.summary ?? `Operation is ${operation.status}`);
    }
    return undefined;
  }

  private activeAncestor(scope: SemanticEngineScope, excludingOperationId?: string): string | null {
    for (let current: SemanticEngineScope | undefined = scope; current; current = current.parent) {
      if (!current.operationId) continue;
      if (current.operationId === excludingOperationId) continue;
      const operation = this.database.readOperation(current.operationId);
      if (operation?.status === "running") return operation.operationId;
    }
    return null;
  }

  private scope(): SemanticEngineScope {
    const scope = this.storage.getStore();
    if (!scope) throw new Error("Flow operation called outside workflow execution");
    return scope;
  }

  private suspend(status: "waiting" | "paused" | "stopped", message: string): never {
    const error = new SemanticRunSuspension(status, message);
    if (!this.rootController.signal.aborted) this.rootController.abort(error);
    throw error;
  }

  private async fault(point: SemanticEngineFaultPoint, operation?: OperationRecord): Promise<void> {
    try { await this.options.faultInjector?.(point, operation); }
    catch (error) {
      if (error instanceof SemanticEngineCrashError) throw error;
      throw new SemanticEngineCrashError(`Semantic engine crashed at ${point}`, { cause: error });
    }
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Semantic engine clock returned an invalid date");
    return value.toISOString();
  }

  private assertIdentity(): void {
    const run = this.database.readRun();
    if (this.parsed.sourceHash !== run.workflow.sourceHash || this.parsed.metadata.name !== run.workflow.name) {
      throw new Error("Workflow source does not match the run database");
    }
    if (this.invocation.workflowId !== run.workflow.id || this.invocation.definitionHash !== run.workflow.definitionHash) {
      throw new Error("Workflow invocation definition does not match the run database");
    }
    if (stableHash(this.invocation.input) !== this.invocation.inputHash) throw new Error("Workflow invocation input hash is corrupt");
    if (semanticInvocationHash(this.invocation) !== run.invocationHash) throw new Error("Workflow invocation identity does not match the run database");
    if (stableHash(this.parsed.metadata.capabilities) !== stableHash(run.workflow.capabilities)) {
      throw new Error("Workflow capabilities do not match the run database");
    }
  }
}

function containsCandidateWorkspaceCapability(value: unknown): boolean {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown): boolean => {
    if (!current || typeof current !== "object") return false;
    if (++nodes > 50_000) throw new Error("Effect input exceeds the candidate-capability traversal limit");
    if (candidateCapability(current)) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    if (Array.isArray(current)) return current.some(visit);
    return (Object.values(Object.getOwnPropertyDescriptors(current)) as PropertyDescriptor[]).some((descriptor) => (
      descriptor.enumerable && "value" in descriptor && visit(descriptor.value)
    ));
  };
  return visit(value);
}

function candidateCapability(value: unknown): boolean {
  return isCandidateWorkspaceCapability(value);
}

export async function executeSequentialSemanticRun(
  runDir: string,
  database: RunDatabase,
  parsed: ParsedStructuredWorkflow,
  invocation: SemanticEngineInvocation,
  adapters: readonly SemanticEffectAdapter[],
  options: SequentialSemanticEngineOptions = {},
): Promise<SequentialSemanticRunOutcome> {
  return await new SequentialSemanticEngine(runDir, database, parsed, invocation, adapters, options).run();
}

