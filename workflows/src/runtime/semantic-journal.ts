import {
  RunDatabase,
  RunDatabaseStateError,
  RunRevisionConflictError,
} from "../persistence/run-database.js";
import {
  buildWorkflowCallKey,
  WORKFLOW_JOURNAL_ROOT_KEY,
} from "../persistence/workflow-journal.js";
import { stableHash } from "../utils/hashes.js";
import {
  zeroUsage,
  type OperationRecord,
  type OperationResult,
  type WorkflowCallRecord,
  type WorkspaceCheckpointRecord,
} from "./durable-types.js";
import { JournalPrefixReplay, type PreparedReplayHit } from "./journal-prefix-replay.js";
import type {
  SemanticEffectAdapter,
  SemanticEffectAdmissionRequest,
  SemanticEffectJournalIdentity,
  SemanticEffectRequest,
  SemanticEngineFaultPoint,
  SemanticReplayMaterialization,
} from "./semantic-engine-types.js";

const MAX_REVISION_RETRIES = 16;

export interface SemanticJournalHooks {
  timestamp(): string;
  boundary(operationId: string): Promise<void>;
  fault(point: SemanticEngineFaultPoint, operation: OperationRecord): Promise<void>;
  currentOperationId(excludingOperationId: string): string | null;
}

/** Semantic call construction plus explicit prefix materialization. */
export class SemanticJournalRuntime {
  private readonly replay?: JournalPrefixReplay;

  constructor(
    readonly runDir: string,
    readonly database: RunDatabase,
    replaySourceRunDir: string | undefined,
    private readonly hooks: SemanticJournalHooks,
  ) {
    this.replay = JournalPrefixReplay.open(runDir, database, replaySourceRunDir);
  }

  async identity(
    adapter: SemanticEffectAdapter,
    admission: SemanticEffectAdmissionRequest,
  ): Promise<SemanticEffectJournalIdentity> {
    const identity = await adapter.journalIdentity(admission);
    if (!identity || !/^sha256:[a-f0-9]{64}$/.test(identity.semanticKey)) {
      throw new Error(`Effect ${admission.path} has an invalid semantic journal key`);
    }
    if (identity.completionAuthority !== "finish-work" && identity.completionAuthority !== "host-effect") {
      throw new Error(`Effect ${admission.path} has invalid completion authority`);
    }
    if (!new Set(["immutable", "workspace", "never"]).has(identity.replayPolicy)) {
      throw new Error(`Effect ${admission.path} has an invalid replay policy`);
    }
    if (admission.kind === "agent" && identity.completionAuthority !== "finish-work") {
      throw new Error(`Agent ${admission.path} must complete through finish_work`);
    }
    if (admission.kind === "apply" && identity.replayPolicy !== "never") {
      throw new Error(`Apply effect ${admission.path} cannot be replayable`);
    }
    return Object.freeze({ ...identity });
  }

  call(
    operation: OperationRecord,
    result: OperationResult,
    identity: SemanticEffectJournalIdentity,
    checkpoint?: WorkspaceCheckpointRecord,
  ): WorkflowCallRecord {
    assertJournalResult(operation, result, identity, checkpoint);
    const previousJournalKey = this.database.readLastWorkflowCall()?.callKey ?? WORKFLOW_JOURNAL_ROOT_KEY;
    return {
      runId: this.database.readRun().runId,
      operationId: operation.operationId,
      ordinal: operation.ordinal,
      previousJournalKey,
      semanticKey: identity.semanticKey,
      callKey: buildWorkflowCallKey({ previousJournalKey, operation, semanticKey: identity.semanticKey }),
      completionAuthority: identity.completionAuthority,
      replayPolicy: identity.replayPolicy,
      result,
      ...(checkpoint ? { postWorkspaceCheckpointId: checkpoint.checkpointId } : {}),
      committedAt: this.hooks.timestamp(),
    };
  }

  async consume(
    adapter: SemanticEffectAdapter,
    request: SemanticEffectRequest,
    identity: SemanticEffectJournalIdentity,
  ): Promise<OperationRecord | undefined> {
    return await this.replay?.consume(request.operation, identity, async (hit) => {
      return await this.commitHit(adapter, request, identity, hit);
    });
  }

  settleStructuralScope(operationPath: string): void {
    this.replay?.settleStructuralScope(operationPath);
  }

  close(): void { this.replay?.close(); }

  private async commitHit(
    adapter: SemanticEffectAdapter,
    request: SemanticEffectRequest,
    identity: SemanticEffectJournalIdentity,
    hit: PreparedReplayHit,
  ): Promise<OperationRecord> {
    const materialized = await materializeReplay(adapter, request, identity, hit);
    await this.hooks.fault("after-replay-materialized", request.operation);
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      await this.hooks.boundary(request.operation.operationId);
      const run = this.database.readRun();
      const completedAt = this.hooks.timestamp();
      const journal: WorkflowCallRecord = {
        runId: run.runId,
        operationId: request.operation.operationId,
        ordinal: request.operation.ordinal,
        previousJournalKey: hit.source.call.previousJournalKey,
        semanticKey: identity.semanticKey,
        callKey: hit.source.call.callKey,
        completionAuthority: identity.completionAuthority,
        replayPolicy: identity.replayPolicy,
        result: materialized.result,
        ...(materialized.workspaceCheckpoint
          ? { postWorkspaceCheckpointId: materialized.workspaceCheckpoint.checkpointId }
          : {}),
        committedAt: completedAt,
      };
      try {
        const completed = this.database.completeOperation({
          expectedRevision: run.revision,
          operationId: request.operation.operationId,
          ...(materialized.attemptId ? { attemptId: materialized.attemptId } : {}),
          completedAt,
          result: materialized.result,
          ...(hit.artifactRecords.length ? { artifacts: hit.artifactRecords } : {}),
          usage: zeroUsage(),
          ...(materialized.workspaceCheckpoint ? { workspaceCheckpoint: materialized.workspaceCheckpoint } : {}),
          ...(materialized.measurement ? { measurement: materialized.measurement } : {}),
          ...(materialized.experiment ? { experiment: materialized.experiment } : {}),
          ...(materialized.verification ? { verification: materialized.verification } : {}),
          journal,
          replay: {
            sourceRunId: hit.source.run.runId,
            sourceOperationId: hit.source.operation.operationId,
            ordinal: hit.source.call.ordinal,
            callKey: hit.source.call.callKey,
            ...(materialized.workspaceCheckpoint
              ? { restoredWorkspaceCheckpointId: materialized.workspaceCheckpoint.checkpointId }
              : {}),
          },
          replayMatchedCalls: hit.matchedCalls,
          currentOperationId: this.hooks.currentOperationId(request.operation.operationId),
          event: {
            type: "operation-replayed",
            payload: {
              path: request.operation.path,
              sourceRunId: hit.source.run.runId,
              sourceOrdinal: hit.source.call.ordinal,
            },
          },
        });
        await this.hooks.fault("after-replay-completion", completed);
        return completed;
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error("Could not commit replay hit after repeated revision races");
  }
}

async function materializeReplay(
  adapter: SemanticEffectAdapter,
  request: SemanticEffectRequest,
  identity: SemanticEffectJournalIdentity,
  hit: PreparedReplayHit,
): Promise<SemanticReplayMaterialization> {
  let materialized: SemanticReplayMaterialization;
  if (identity.replayPolicy === "immutable" && adapter.materializeImmutableReplay) {
    materialized = await adapter.materializeImmutableReplay(request, hit.source);
  } else if (identity.replayPolicy === "workspace" && adapter.materializeReplay) {
    materialized = await adapter.materializeReplay(request, hit.source);
  } else if (identity.replayPolicy === "workspace") {
    throw new RunDatabaseStateError(`Effect ${request.operation.path} cannot restore a replay workspace`);
  } else {
    materialized = { result: hit.source.call.result };
  }
  if (!materialized || !materialized.result || !Array.isArray(materialized.result.artifacts)) {
    throw new RunDatabaseStateError("Replay materializer returned an invalid result");
  }
  if (
    stableHash(materialized.result.value ?? null) !== stableHash(hit.source.call.result.value ?? null)
    || stableHash(materialized.result.artifacts) !== stableHash(hit.source.call.result.artifacts)
  ) throw new RunDatabaseStateError("Replay materializer changed immutable effect output");
  assertJournalResult(hit.source.operation, materialized.result, identity, materialized.workspaceCheckpoint);
  if (identity.replayPolicy === "workspace" && !hit.source.workspaceCheckpoint) {
    throw new RunDatabaseStateError("Replay source mutation has no workspace checkpoint");
  }
  return materialized;
}

function assertJournalResult(
  operation: OperationRecord,
  result: OperationResult,
  identity: SemanticEffectJournalIdentity,
  checkpoint?: WorkspaceCheckpointRecord,
): void {
  if (identity.replayPolicy === "workspace") {
    if (!result.workspace || result.workspace.kind !== "candidate" || !checkpoint) {
      throw new Error(`Mutating effect ${operation.path} has no exact post-workspace checkpoint`);
    }
    if (stableHash(result.workspace) !== stableHash(checkpoint.workspace)) {
      throw new Error(`Mutating effect ${operation.path} checkpoint differs from its result`);
    }
  } else if (result.workspace || checkpoint) {
    throw new Error(`Effect ${operation.path} produced an undeclared workspace mutation`);
  }
}
