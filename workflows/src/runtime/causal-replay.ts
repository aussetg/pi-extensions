import fs from "node:fs";
import path from "node:path";
import { WorkflowReplayArtifactImporter } from "../artifacts/replay.js";
import type {
  CompleteWorkflowStructuralJoinInput,
  WorkflowOperationRecord,
  WorkflowScopeCallRecord,
  WorkflowScopeRecord,
  WorkflowWorkspaceCheckpointRecord,
} from "../persistence/run-database-types.js";
import {
  WorkflowRunDatabase,
  WorkflowRunDatabaseReader,
  WorkflowRunDatabaseRevisionConflictError,
} from "../persistence/run-database.js";
import type { JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import {
  WorkflowReplayWorkspaceImporter,
  type WorkflowReplayWorkspaceTarget,
} from "../workspaces/replay.js";
import {
  sameWorkflowJoin,
  workflowOperationIdentity,
  workflowStructuralJoinKey,
} from "./causal-identity.js";

const MAX_REVISION_RETRIES = 16;

export type WorkflowCausalReplayFaultPoint =
  | "after-artifacts-materialized"
  | "after-workspace-restored"
  | "after-call-commit"
  | "after-join-commit";

export type WorkflowReplayMissCode =
  | "scope-unavailable"
  | "scope-seed-changed"
  | "scope-prefix-changed"
  | "source-prefix-ended"
  | "operation-changed"
  | "semantic-key-changed"
  | "completion-authority-changed"
  | "replay-policy-changed"
  | "source-failed"
  | "non-replayable"
  | "workspace-required";

export interface WorkflowReplayMiss {
  kind: "miss";
  code: WorkflowReplayMissCode;
  path: string;
  reason: string;
}

export interface WorkflowReplayHit {
  kind: "hit";
  operation: WorkflowOperationRecord;
  call: WorkflowScopeCallRecord;
  result: JsonValue;
  source: {
    runId: string;
    operationId: string;
    scopePath: string;
    cursor: number;
    callKey: string;
  };
  artifacts: number;
  workspaceCheckpoint?: WorkflowWorkspaceCheckpointRecord;
  workspaceRestored: boolean;
}

export type WorkflowReplayDecision = WorkflowReplayMiss | WorkflowReplayHit;

export interface WorkflowReplayCallRequest {
  operationId: string;
  semanticKey: string;
  completionAuthority: Exclude<WorkflowScopeCallRecord["completionAuthority"], "structural-join">;
  replayPolicy: WorkflowScopeCallRecord["replayPolicy"];
  workspace?: WorkflowReplayWorkspaceTarget;
  at: string;
}

export interface WorkflowStructuralJoinCompletion
  extends Omit<CompleteWorkflowStructuralJoinInput,
    "expectedRevision" | "callKey" | "joinKey" | "replay"> {}

export interface WorkflowStructuralJoinResult {
  operation: WorkflowOperationRecord;
  joinKey: string;
  replayedSourceJoin: boolean;
}

export class WorkflowCausalReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowCausalReplayError";
  }
}

/** One explicit source run. Eligibility is reconstructed from durable target replay evidence. */
export class WorkflowCausalReplay implements Disposable {
  private readonly artifacts: WorkflowReplayArtifactImporter;
  private readonly workspaces: WorkflowReplayWorkspaceImporter;
  private closed = false;

  private constructor(
    readonly targetRunDir: string,
    readonly sourceRunDir: string,
    readonly target: WorkflowRunDatabase,
    readonly source: WorkflowRunDatabaseReader,
    private readonly sourceRevision: number,
    private readonly faultInjector?: (point: WorkflowCausalReplayFaultPoint) => void,
  ) {
    this.artifacts = new WorkflowReplayArtifactImporter(sourceRunDir, source, targetRunDir, target);
    this.workspaces = new WorkflowReplayWorkspaceImporter(sourceRunDir, source, targetRunDir, target);
  }

  static async open(input: {
    targetRunDir: string;
    target: WorkflowRunDatabase;
    sourceRunDir: string;
    faultInjector?: (point: WorkflowCausalReplayFaultPoint) => void;
  }): Promise<WorkflowCausalReplay> {
    const targetRunDir = await realRunDirectory(input.targetRunDir, "target");
    const sourceRunDir = await realRunDirectory(input.sourceRunDir, "source");
    if (sourceRunDir === targetRunDir) throw new WorkflowCausalReplayError("Replay source is the target run");
    if (path.resolve(input.target.databasePath) !== path.join(targetRunDir, "run.sqlite")) {
      throw new WorkflowCausalReplayError("Replay target database is outside its run directory");
    }
    const source = WorkflowRunDatabaseReader.open(path.join(sourceRunDir, "run.sqlite"));
    try {
      input.target.validateIntegrity();
      const sourceRun = source.readSnapshot((reader) => {
        reader.validateIntegrity();
        return reader.readRun();
      });
      const targetRun = input.target.readRun();
      if (sourceRun.runId === targetRun.runId) {
        throw new WorkflowCausalReplayError("Replay source has the target run id");
      }
      if (sourceRun.workflow.id !== targetRun.workflow.id) {
        throw new WorkflowCausalReplayError("Replay source belongs to another installed workflow");
      }
      if (sourceRun.workflow.runtimeApiHash !== targetRun.workflow.runtimeApiHash) {
        throw new WorkflowCausalReplayError("Replay source uses another workflow runtime API");
      }
      return new WorkflowCausalReplay(
        targetRunDir,
        sourceRunDir,
        input.target,
        source,
        sourceRun.revision,
        input.faultInjector,
      );
    } catch (error) {
      source.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.source.close();
  }

  [Symbol.dispose](): void { this.close(); }

  async tryReplayCall(request: WorkflowReplayCallRequest): Promise<WorkflowReplayDecision> {
    this.assertOpen();
    this.assertSourceUnchanged();
    const operation = this.target.readOperation(request.operationId);
    if (!operation) throw new WorkflowCausalReplayError(`Unknown replay target operation ${request.operationId}`);
    if (operation.status === "completed") {
      return this.readExistingHit(operation, request);
    }
    if (operation.status !== "running" && operation.status !== "waiting") {
      throw new WorkflowCausalReplayError(`Replay target operation ${operation.path} is ${operation.status}`);
    }
    if (operation.kind === "parallel" || operation.kind === "map" || operation.kind === "candidate") {
      throw new WorkflowCausalReplayError("Structural operations complete through causal joins");
    }
    if (request.replayPolicy === "never") {
      return miss("non-replayable", operation.path, "target operation is explicitly non-replayable");
    }
    const match = this.matchSourceCall(operation, request);
    if (match.kind === "miss") return match;
    if (request.replayPolicy === "workspace" && !request.workspace) {
      return miss("workspace-required", operation.path, "workspace replay requires current target authority");
    }

    const artifacts = await this.artifacts.importOperation(
      match.sourceOperation.operationId,
      request.at,
    );
    this.fault("after-artifacts-materialized");
    let checkpoint: WorkflowWorkspaceCheckpointRecord | undefined;
    let workspaceRestored = false;
    if (request.replayPolicy === "workspace") {
      const sourceCheckpointId = match.sourceCall.postWorkspaceCheckpointId;
      const sourceCheckpoint = sourceCheckpointId
        ? this.source.readWorkspaceCheckpoint(sourceCheckpointId)
        : undefined;
      if (!sourceCheckpoint || sourceCheckpoint.operationId !== match.sourceOperation.operationId) {
        throw new WorkflowCausalReplayError("Replayable workspace call lacks its exact source checkpoint");
      }
      const imported = await this.workspaces.importAndRestore({
        source: sourceCheckpoint,
        targetOperationId: operation.operationId,
        target: request.workspace!,
        createdAt: request.at,
      });
      checkpoint = imported.record;
      workspaceRestored = imported.restored;
      this.fault("after-workspace-restored");
    }

    const replay = {
      sourceRunId: this.source.readRun().runId,
      sourceOperationId: match.sourceOperation.operationId,
      sourceScopePath: match.sourceScope.path,
      sourceCursor: match.sourceOperation.cursor,
      sourceCallKey: match.sourceCall.callKey,
    };
    this.assertSourceUnchanged();
    let completed: WorkflowOperationRecord | undefined;
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      try {
        completed = this.target.completeCall({
          expectedRevision: this.target.readRun().revision,
          operationId: operation.operationId,
          previousCallKey: match.sourceCall.previousCallKey,
          semanticKey: request.semanticKey,
          callKey: match.sourceCall.callKey,
          outcome: "success",
          completionAuthority: request.completionAuthority,
          replayPolicy: request.replayPolicy,
          result: structuredClone(match.sourceOperation.result!),
          ...(checkpoint ? {
            postWorkspaceCheckpointId: checkpoint.checkpointId,
            workspaceCheckpoint: checkpoint,
          } : {}),
          ...(artifacts.length > 0 ? { artifacts } : {}),
          replay,
          at: request.at,
        });
        break;
      } catch (error) {
        if (error instanceof WorkflowRunDatabaseRevisionConflictError) continue;
        const current = this.target.readOperation(operation.operationId);
        if (current?.status === "completed") return this.readExistingHit(current, request);
        throw error;
      }
    }
    if (!completed) throw new WorkflowCausalReplayError("Could not commit replay after repeated revision races");
    this.fault("after-call-commit");
    const call = this.target.readScopeCall(completed.operationId)!;
    return {
      kind: "hit",
      operation: completed,
      call,
      result: structuredClone(match.sourceOperation.result!),
      source: {
        runId: replay.sourceRunId,
        operationId: replay.sourceOperationId,
        scopePath: replay.sourceScopePath,
        cursor: replay.sourceCursor,
        callKey: replay.sourceCallKey,
      },
      artifacts: artifacts.length,
      ...(checkpoint ? { workspaceCheckpoint: checkpoint } : {}),
      workspaceRestored,
    };
  }

  completeStructuralJoin(input: WorkflowStructuralJoinCompletion): WorkflowStructuralJoinResult {
    this.assertOpen();
    this.assertSourceUnchanged();
    const operation = this.target.readOperation(input.operationId);
    if (!operation) throw new WorkflowCausalReplayError(`Unknown structural operation ${input.operationId}`);
    const joinKey = workflowStructuralJoinKey({
      previousCallKey: input.previousCallKey,
      operation: workflowOperationIdentity(operation),
      semanticKey: input.semanticKey,
      policyHash: input.policyHash,
      outputOrder: input.outputOrder,
      lanes: input.lanes,
      result: input.result!,
    });
    if (operation.status === "completed") {
      const call = this.target.readScopeCall(operation.operationId);
      const join = this.target.readStructuralJoin(operation.operationId);
      if (!call || !join || call.callKey !== joinKey || join.joinKey !== joinKey
        || stableHash(operation.result) !== stableHash(input.result)) {
        throw new WorkflowCausalReplayError(`Completed structural join ${operation.path} changed identity`);
      }
      return {
        operation,
        joinKey,
        replayedSourceJoin: call.replay?.sourceRunId === this.source.readRun().runId,
      };
    }
    const replay = this.matchSourceJoin(operation, { ...input, joinKey });
    this.assertSourceUnchanged();
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      try {
        const completed = this.target.completeStructuralJoin({
          ...input,
          expectedRevision: this.target.readRun().revision,
          callKey: joinKey,
          joinKey,
          ...(replay ? { replay } : {}),
        });
        this.fault("after-join-commit");
        return { operation: completed, joinKey, replayedSourceJoin: Boolean(replay) };
      } catch (error) {
        if (error instanceof WorkflowRunDatabaseRevisionConflictError) continue;
        throw error;
      }
    }
    throw new WorkflowCausalReplayError("Could not commit structural join after repeated revision races");
  }

  private matchSourceCall(
    targetOperation: WorkflowOperationRecord,
    request: WorkflowReplayCallRequest,
  ): WorkflowReplayMiss | {
    kind: "match";
    sourceScope: WorkflowScopeRecord;
    sourceOperation: WorkflowOperationRecord;
    sourceCall: WorkflowScopeCallRecord;
  } {
    const scopeMatch = this.matchScopePrefix(targetOperation);
    if (scopeMatch.kind === "miss") return scopeMatch;
    const sourceOperation = this.source.readOperationAt(scopeMatch.sourceScope.scopeId, targetOperation.cursor);
    if (!sourceOperation) return miss("source-prefix-ended", targetOperation.path, "source scope prefix ended");
    if (sourceOperation.path !== targetOperation.path || sourceOperation.kind !== targetOperation.kind
      || sourceOperation.semanticInputHash !== targetOperation.semanticInputHash) {
      return miss("operation-changed", targetOperation.path, "operation kind or semantic input changed");
    }
    const sourceCall = this.source.readScopeCall(sourceOperation.operationId);
    if (!sourceCall) return miss("source-prefix-ended", targetOperation.path, "source operation has no committed call");
    if (sourceCall.outcome !== "success" || sourceOperation.status !== "completed") {
      return miss("source-failed", targetOperation.path, "source operation did not complete successfully");
    }
    if (sourceCall.replayPolicy === "never") {
      return miss("non-replayable", targetOperation.path, "source operation is explicitly non-replayable");
    }
    if (sourceCall.previousCallKey !== scopeMatch.previousCallKey) {
      return miss("scope-prefix-changed", targetOperation.path, "source call has another causal predecessor");
    }
    if (sourceCall.semanticKey !== request.semanticKey) {
      return miss("semantic-key-changed", targetOperation.path, "effect semantic key changed");
    }
    if (sourceCall.completionAuthority !== request.completionAuthority) {
      return miss("completion-authority-changed", targetOperation.path, "effect completion authority changed");
    }
    if (sourceCall.replayPolicy !== request.replayPolicy) {
      return miss("replay-policy-changed", targetOperation.path, "effect replay policy changed");
    }
    if (sourceOperation.result === undefined || stableHash(sourceOperation.result) !== sourceCall.resultHash) {
      throw new WorkflowCausalReplayError(`Source operation ${sourceOperation.path} result is corrupt`);
    }
    return { kind: "match", sourceScope: scopeMatch.sourceScope, sourceOperation, sourceCall };
  }

  private matchScopePrefix(targetOperation: WorkflowOperationRecord): WorkflowReplayMiss | {
    kind: "match";
    sourceScope: WorkflowScopeRecord;
    previousCallKey: string;
  } {
    const targetScope = this.target.readScope(targetOperation.scopeId);
    if (!targetScope) throw new WorkflowCausalReplayError(`Target scope for ${targetOperation.path} is missing`);
    const sourceScope = this.source.readScopeByPath(targetScope.path);
    if (!sourceScope) return miss("scope-unavailable", targetOperation.path, "source has no corresponding causal scope");
    if (sourceScope.kind !== targetScope.kind || sourceScope.seedKey !== targetScope.seedKey) {
      return miss("scope-seed-changed", targetOperation.path, "causal scope seed changed");
    }
    const sourceRunId = this.source.readRun().runId;
    let previousCallKey = targetScope.seedKey;
    for (let cursor = 0; cursor < targetOperation.cursor; cursor++) {
      const targetPrior = this.target.readOperationAt(targetScope.scopeId, cursor);
      const sourcePrior = this.source.readOperationAt(sourceScope.scopeId, cursor);
      if (!targetPrior || !sourcePrior) {
        return miss("scope-prefix-changed", targetOperation.path, "causal scope prefix is incomplete");
      }
      const targetCall = this.target.readScopeCall(targetPrior.operationId);
      const sourceCall = this.source.readScopeCall(sourcePrior.operationId);
      if (!targetCall || !sourceCall || !targetCall.replay
        || targetCall.replay.sourceRunId !== sourceRunId
        || targetCall.replay.sourceOperationId !== sourcePrior.operationId
        || targetCall.replay.sourceScopePath !== sourceScope.path
        || targetCall.replay.sourceCursor !== cursor
        || targetCall.callKey !== sourceCall.callKey
        || targetCall.previousCallKey !== previousCallKey) {
        return miss("scope-prefix-changed", targetOperation.path, "earlier call ended this lane's replay prefix");
      }
      previousCallKey = targetCall.callKey;
    }
    return { kind: "match", sourceScope, previousCallKey };
  }

  private matchSourceJoin(
    operation: WorkflowOperationRecord,
    target: WorkflowStructuralJoinCompletion & { joinKey: string },
  ): NonNullable<WorkflowScopeCallRecord["replay"]> | undefined {
    const scopeMatch = this.matchScopePrefix(operation);
    if (scopeMatch.kind === "miss") return undefined;
    const sourceOperation = this.source.readOperationAt(scopeMatch.sourceScope.scopeId, operation.cursor);
    if (!sourceOperation || sourceOperation.path !== operation.path || sourceOperation.kind !== operation.kind
      || sourceOperation.semanticInputHash !== operation.semanticInputHash) return undefined;
    const sourceCall = this.source.readScopeCall(sourceOperation.operationId);
    const sourceJoin = this.source.readStructuralJoin(sourceOperation.operationId);
    if (!sourceCall || !sourceJoin || sourceCall.outcome !== "success"
      || sourceCall.completionAuthority !== "structural-join"
      || sourceCall.semanticKey !== target.semanticKey
      || sourceCall.previousCallKey !== target.previousCallKey
      || sourceOperation.result === undefined
      || stableHash(sourceOperation.result) !== stableHash(target.result)
      || !sameWorkflowJoin(sourceJoin, target)) return undefined;
    return {
      sourceRunId: this.source.readRun().runId,
      sourceOperationId: sourceOperation.operationId,
      sourceScopePath: scopeMatch.sourceScope.path,
      sourceCursor: sourceOperation.cursor,
      sourceCallKey: sourceCall.callKey,
    };
  }

  private readExistingHit(
    operation: WorkflowOperationRecord,
    request: WorkflowReplayCallRequest,
  ): WorkflowReplayHit {
    const call = this.target.readScopeCall(operation.operationId);
    if (!call?.replay || call.replay.sourceRunId !== this.source.readRun().runId
      || call.semanticKey !== request.semanticKey || call.replayPolicy !== request.replayPolicy
      || call.completionAuthority !== request.completionAuthority || operation.result === undefined) {
      throw new WorkflowCausalReplayError(`Completed operation ${operation.path} is not this replay hit`);
    }
    const checkpoint = call.postWorkspaceCheckpointId
      ? this.target.readWorkspaceCheckpoint(call.postWorkspaceCheckpointId)
      : undefined;
    return {
      kind: "hit",
      operation,
      call,
      result: structuredClone(operation.result),
      source: {
        runId: call.replay.sourceRunId,
        operationId: call.replay.sourceOperationId,
        scopePath: call.replay.sourceScopePath,
        cursor: call.replay.sourceCursor,
        callKey: call.replay.sourceCallKey,
      },
      artifacts: this.target.listOperationArtifacts(operation.operationId).length,
      ...(checkpoint ? { workspaceCheckpoint: checkpoint } : {}),
      workspaceRestored: false,
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new WorkflowCausalReplayError("Workflow causal replay is closed");
  }

  private assertSourceUnchanged(): void {
    if (this.source.readRun().revision !== this.sourceRevision) {
      throw new WorkflowCausalReplayError("Replay source changed after its evidence snapshot opened");
    }
  }

  private fault(point: WorkflowCausalReplayFaultPoint): void {
    this.faultInjector?.(point);
  }
}

function miss(code: WorkflowReplayMissCode, pathValue: string, reason: string): WorkflowReplayMiss {
  return { kind: "miss", code, path: pathValue, reason };
}

async function realRunDirectory(input: string, label: string): Promise<string> {
  const requested = path.resolve(input);
  const stat = await fs.promises.lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.promises.realpath(requested) !== requested) {
    throw new WorkflowCausalReplayError(`Replay ${label} run directory is unsafe`);
  }
  const database = await fs.promises.lstat(path.join(requested, "run.sqlite"));
  if (!database.isFile() || database.isSymbolicLink()) {
    throw new WorkflowCausalReplayError(`Replay ${label} database is unsafe`);
  }
  return requested;
}
