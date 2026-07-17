import fs from "node:fs";
import path from "node:path";
import { WorkflowV17ReplayArtifactImporter } from "../artifacts/replay-v17.js";
import type {
  CompleteWorkflowStructuralJoinV17Input,
  WorkflowOperationV17Record,
  WorkflowScopeCallV17Record,
  WorkflowScopeV17Record,
  WorkflowWorkspaceCheckpointV17Record,
} from "../persistence/run-database-v17-types.js";
import {
  WorkflowRunDatabaseV17,
  WorkflowRunDatabaseV17Reader,
  WorkflowRunDatabaseV17RevisionConflictError,
} from "../persistence/run-database-v17.js";
import type { JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import {
  WorkflowV17ReplayWorkspaceImporter,
  type WorkflowV17ReplayWorkspaceTarget,
} from "../workspaces/replay-v17.js";
import {
  sameWorkflowV17Join,
  workflowV17OperationIdentity,
  workflowV17StructuralJoinKey,
} from "./causal-identity-v17.js";

const MAX_REVISION_RETRIES = 16;

export type WorkflowV17CausalReplayFaultPoint =
  | "after-artifacts-materialized"
  | "after-workspace-restored"
  | "after-call-commit"
  | "after-join-commit";

export type WorkflowV17ReplayMissCode =
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

export interface WorkflowV17ReplayMiss {
  kind: "miss";
  code: WorkflowV17ReplayMissCode;
  path: string;
  reason: string;
}

export interface WorkflowV17ReplayHit {
  kind: "hit";
  operation: WorkflowOperationV17Record;
  call: WorkflowScopeCallV17Record;
  result: JsonValue;
  source: {
    runId: string;
    operationId: string;
    scopePath: string;
    cursor: number;
    callKey: string;
  };
  artifacts: number;
  workspaceCheckpoint?: WorkflowWorkspaceCheckpointV17Record;
  workspaceRestored: boolean;
}

export type WorkflowV17ReplayDecision = WorkflowV17ReplayMiss | WorkflowV17ReplayHit;

export interface WorkflowV17ReplayCallRequest {
  operationId: string;
  semanticKey: string;
  completionAuthority: Exclude<WorkflowScopeCallV17Record["completionAuthority"], "structural-join">;
  replayPolicy: WorkflowScopeCallV17Record["replayPolicy"];
  workspace?: WorkflowV17ReplayWorkspaceTarget;
  at: string;
}

export interface WorkflowV17StructuralJoinCompletion
  extends Omit<CompleteWorkflowStructuralJoinV17Input,
    "expectedRevision" | "callKey" | "joinKey" | "replay"> {}

export interface WorkflowV17StructuralJoinResult {
  operation: WorkflowOperationV17Record;
  joinKey: string;
  replayedSourceJoin: boolean;
}

export class WorkflowV17CausalReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowV17CausalReplayError";
  }
}

/** One explicit source run. Eligibility is reconstructed from durable target replay evidence. */
export class WorkflowV17CausalReplay implements Disposable {
  private readonly artifacts: WorkflowV17ReplayArtifactImporter;
  private readonly workspaces: WorkflowV17ReplayWorkspaceImporter;
  private closed = false;

  private constructor(
    readonly targetRunDir: string,
    readonly sourceRunDir: string,
    readonly target: WorkflowRunDatabaseV17,
    readonly source: WorkflowRunDatabaseV17Reader,
    private readonly sourceRevision: number,
    private readonly faultInjector?: (point: WorkflowV17CausalReplayFaultPoint) => void,
  ) {
    this.artifacts = new WorkflowV17ReplayArtifactImporter(sourceRunDir, source, targetRunDir, target);
    this.workspaces = new WorkflowV17ReplayWorkspaceImporter(sourceRunDir, source, targetRunDir, target);
  }

  static async open(input: {
    targetRunDir: string;
    target: WorkflowRunDatabaseV17;
    sourceRunDir: string;
    faultInjector?: (point: WorkflowV17CausalReplayFaultPoint) => void;
  }): Promise<WorkflowV17CausalReplay> {
    const targetRunDir = await realRunDirectory(input.targetRunDir, "target");
    const sourceRunDir = await realRunDirectory(input.sourceRunDir, "source");
    if (sourceRunDir === targetRunDir) throw new WorkflowV17CausalReplayError("Replay source is the target run");
    if (path.resolve(input.target.databasePath) !== path.join(targetRunDir, "run.sqlite")) {
      throw new WorkflowV17CausalReplayError("Replay target database is outside its run directory");
    }
    const source = WorkflowRunDatabaseV17Reader.open(path.join(sourceRunDir, "run.sqlite"));
    try {
      input.target.validateIntegrity();
      const sourceRun = source.readSnapshot((reader) => {
        reader.validateIntegrity();
        return reader.readRun();
      });
      const targetRun = input.target.readRun();
      if (sourceRun.runId === targetRun.runId) {
        throw new WorkflowV17CausalReplayError("Replay source has the target run id");
      }
      if (sourceRun.workflow.id !== targetRun.workflow.id) {
        throw new WorkflowV17CausalReplayError("Replay source belongs to another installed workflow");
      }
      if (sourceRun.workflow.runtimeApiHash !== targetRun.workflow.runtimeApiHash) {
        throw new WorkflowV17CausalReplayError("Replay source uses another workflow runtime API");
      }
      return new WorkflowV17CausalReplay(
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

  async tryReplayCall(request: WorkflowV17ReplayCallRequest): Promise<WorkflowV17ReplayDecision> {
    this.assertOpen();
    this.assertSourceUnchanged();
    const operation = this.target.readOperation(request.operationId);
    if (!operation) throw new WorkflowV17CausalReplayError(`Unknown replay target operation ${request.operationId}`);
    if (operation.status === "completed") {
      return this.readExistingHit(operation, request);
    }
    if (operation.status !== "running" && operation.status !== "waiting") {
      throw new WorkflowV17CausalReplayError(`Replay target operation ${operation.path} is ${operation.status}`);
    }
    if (operation.kind === "parallel" || operation.kind === "map" || operation.kind === "candidate") {
      throw new WorkflowV17CausalReplayError("Structural operations complete through causal joins");
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
    let checkpoint: WorkflowWorkspaceCheckpointV17Record | undefined;
    let workspaceRestored = false;
    if (request.replayPolicy === "workspace") {
      const sourceCheckpointId = match.sourceCall.postWorkspaceCheckpointId;
      const sourceCheckpoint = sourceCheckpointId
        ? this.source.readWorkspaceCheckpoint(sourceCheckpointId)
        : undefined;
      if (!sourceCheckpoint || sourceCheckpoint.operationId !== match.sourceOperation.operationId) {
        throw new WorkflowV17CausalReplayError("Replayable workspace call lacks its exact source checkpoint");
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
    let completed: WorkflowOperationV17Record | undefined;
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
        if (error instanceof WorkflowRunDatabaseV17RevisionConflictError) continue;
        const current = this.target.readOperation(operation.operationId);
        if (current?.status === "completed") return this.readExistingHit(current, request);
        throw error;
      }
    }
    if (!completed) throw new WorkflowV17CausalReplayError("Could not commit replay after repeated revision races");
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

  completeStructuralJoin(input: WorkflowV17StructuralJoinCompletion): WorkflowV17StructuralJoinResult {
    this.assertOpen();
    this.assertSourceUnchanged();
    const operation = this.target.readOperation(input.operationId);
    if (!operation) throw new WorkflowV17CausalReplayError(`Unknown structural operation ${input.operationId}`);
    const joinKey = workflowV17StructuralJoinKey({
      previousCallKey: input.previousCallKey,
      operation: workflowV17OperationIdentity(operation),
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
        throw new WorkflowV17CausalReplayError(`Completed structural join ${operation.path} changed identity`);
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
        if (error instanceof WorkflowRunDatabaseV17RevisionConflictError) continue;
        throw error;
      }
    }
    throw new WorkflowV17CausalReplayError("Could not commit structural join after repeated revision races");
  }

  private matchSourceCall(
    targetOperation: WorkflowOperationV17Record,
    request: WorkflowV17ReplayCallRequest,
  ): WorkflowV17ReplayMiss | {
    kind: "match";
    sourceScope: WorkflowScopeV17Record;
    sourceOperation: WorkflowOperationV17Record;
    sourceCall: WorkflowScopeCallV17Record;
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
      throw new WorkflowV17CausalReplayError(`Source operation ${sourceOperation.path} result is corrupt`);
    }
    return { kind: "match", sourceScope: scopeMatch.sourceScope, sourceOperation, sourceCall };
  }

  private matchScopePrefix(targetOperation: WorkflowOperationV17Record): WorkflowV17ReplayMiss | {
    kind: "match";
    sourceScope: WorkflowScopeV17Record;
    previousCallKey: string;
  } {
    const targetScope = this.target.readScope(targetOperation.scopeId);
    if (!targetScope) throw new WorkflowV17CausalReplayError(`Target scope for ${targetOperation.path} is missing`);
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
    operation: WorkflowOperationV17Record,
    target: WorkflowV17StructuralJoinCompletion & { joinKey: string },
  ): NonNullable<WorkflowScopeCallV17Record["replay"]> | undefined {
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
      || !sameWorkflowV17Join(sourceJoin, target)) return undefined;
    return {
      sourceRunId: this.source.readRun().runId,
      sourceOperationId: sourceOperation.operationId,
      sourceScopePath: scopeMatch.sourceScope.path,
      sourceCursor: sourceOperation.cursor,
      sourceCallKey: sourceCall.callKey,
    };
  }

  private readExistingHit(
    operation: WorkflowOperationV17Record,
    request: WorkflowV17ReplayCallRequest,
  ): WorkflowV17ReplayHit {
    const call = this.target.readScopeCall(operation.operationId);
    if (!call?.replay || call.replay.sourceRunId !== this.source.readRun().runId
      || call.semanticKey !== request.semanticKey || call.replayPolicy !== request.replayPolicy
      || call.completionAuthority !== request.completionAuthority || operation.result === undefined) {
      throw new WorkflowV17CausalReplayError(`Completed operation ${operation.path} is not this replay hit`);
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
    if (this.closed) throw new WorkflowV17CausalReplayError("Workflow causal replay is closed");
  }

  private assertSourceUnchanged(): void {
    if (this.source.readRun().revision !== this.sourceRevision) {
      throw new WorkflowV17CausalReplayError("Replay source changed after its evidence snapshot opened");
    }
  }

  private fault(point: WorkflowV17CausalReplayFaultPoint): void {
    this.faultInjector?.(point);
  }
}

function miss(code: WorkflowV17ReplayMissCode, pathValue: string, reason: string): WorkflowV17ReplayMiss {
  return { kind: "miss", code, path: pathValue, reason };
}

async function realRunDirectory(input: string, label: string): Promise<string> {
  const requested = path.resolve(input);
  const stat = await fs.promises.lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.promises.realpath(requested) !== requested) {
    throw new WorkflowV17CausalReplayError(`Replay ${label} run directory is unsafe`);
  }
  const database = await fs.promises.lstat(path.join(requested, "run.sqlite"));
  if (!database.isFile() || database.isSymbolicLink()) {
    throw new WorkflowV17CausalReplayError(`Replay ${label} database is unsafe`);
  }
  return requested;
}
