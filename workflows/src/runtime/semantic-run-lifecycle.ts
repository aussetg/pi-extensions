import fs from "node:fs";
import type { ParsedStructuredWorkflow } from "../definition/types.js";
import { ArtifactStore } from "../artifacts/store.js";
import {
  RunDatabase,
  RunDatabaseStateError,
  RunRevisionConflictError,
} from "../persistence/run-database.js";
import type { JsonValue } from "../types.js";
import type { RunRecord } from "./durable-types.js";
import type { SequentialSemanticRunOutcome } from "./semantic-engine-types.js";
import {
  boundedError,
  canonicalStructuralJson,
  validateJsonSchema,
  workflowFailureReason,
} from "./semantic-engine-values.js";

const MAX_REVISION_RETRIES = 16;

export interface SemanticRunLifecycleHooks {
  timestamp(): string;
  boundary(): Promise<void>;
  faultAfterResultArtifact(): Promise<void>;
}

/** Terminal run/result persistence, kept separate from operation scheduling. */
export class SemanticRunLifecycle {
  constructor(
    private readonly database: RunDatabase,
    private readonly parsed: ParsedStructuredWorkflow,
    private readonly artifacts: ArtifactStore,
    private readonly hooks: SemanticRunLifecycleHooks,
  ) {}

  async startOrReadTerminal(
    aborted: () => boolean,
    pauseForCancellation: () => Promise<SequentialSemanticRunOutcome>,
  ): Promise<SequentialSemanticRunOutcome | undefined> {
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      const run = this.database.readRun();
      if (run.status === "completed") return await this.readCompleted(run);
      if (run.status === "failed") return { status: "failed", run, error: run.reason?.summary ?? "Workflow failed" };
      if (run.status === "waiting" || run.status === "paused" || run.status === "stopped") return { status: run.status, run };
      if (run.status === "running") return undefined;
      if (aborted()) return await pauseForCancellation();
      try {
        this.database.transitionRun(run.revision, {
          status: "running",
          startedAt: run.startedAt ?? this.hooks.timestamp(),
          endedAt: null,
          event: { type: "run-started", payload: {}, at: this.hooks.timestamp() },
        });
        return undefined;
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error("Could not start run after repeated revision races");
  }

  async complete(result: JsonValue): Promise<SequentialSemanticRunOutcome> {
    let stored: Awaited<ReturnType<ArtifactStore["putJson"]>> | undefined;
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      await this.hooks.boundary();
      const run = this.database.readRun();
      if (run.status === "completed") return await this.readCompleted(run);
      try {
        stored = await this.artifacts.putJson({
          expectedRevision: run.revision,
          kind: "workflow-result",
          value: { formatVersion: 1, result },
          metadata: { workflowId: run.workflow.id, definitionHash: run.workflow.definitionHash },
          maximumBytes: run.safety.outputBytes,
          createdAt: this.hooks.timestamp(),
        });
        break;
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        throw error;
      }
    }
    if (!stored) throw new Error("Could not store workflow result after repeated revision races");
    await this.hooks.faultAfterResultArtifact();
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      await this.hooks.boundary();
      const run = this.database.readRun();
      if (run.status === "completed") return await this.readCompleted(run);
      try {
        const completed = this.database.transitionRun(run.revision, {
          status: "completed",
          reason: null,
          currentOperationId: null,
          result: stored.artifact,
          startedAt: run.startedAt ?? this.hooks.timestamp(),
          endedAt: this.hooks.timestamp(),
          event: {
            type: "run-completed",
            payload: { resultDigest: stored.artifact.digest },
            at: this.hooks.timestamp(),
          },
        });
        return { status: "completed", run: completed, result };
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error("Could not complete run after repeated revision races");
  }

  async readCompleted(run: RunRecord): Promise<SequentialSemanticRunOutcome> {
    if (!run.result) throw new RunDatabaseStateError("Completed run has no result artifact");
    const stored = await this.artifacts.read(run.result.digest);
    const body = canonicalStructuralJson(JSON.parse(await fs.promises.readFile(stored.bodyPath, "utf8")));
    if (
      !body || typeof body !== "object" || Array.isArray(body) || body.formatVersion !== 1
      || !Object.prototype.hasOwnProperty.call(body, "result") || Object.keys(body).length !== 2
    ) throw new RunDatabaseStateError("Workflow result artifact has an invalid envelope");
    const result = body.result;
    validateJsonSchema(this.parsed.metadata.outputSchema, result, "workflow outputSchema");
    return { status: "completed", run, result };
  }

  async fail(error: unknown): Promise<SequentialSemanticRunOutcome> {
    const before = this.database.readRun();
    if (before.status === "paused" || before.status === "waiting" || before.status === "stopped") {
      return { status: before.status, run: before };
    }
    if (before.status === "failed") {
      return { status: "failed", run: before, error: before.reason?.summary ?? boundedError(error) };
    }
    const reason = workflowFailureReason(error, before.currentOperationId);
    let errorArtifact: Awaited<ReturnType<ArtifactStore["putJson"]>> | undefined;
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      const run = this.database.readRun();
      if (run.status !== "running" && run.status !== "queued") break;
      try {
        errorArtifact = await this.artifacts.putJson({
          expectedRevision: run.revision,
          kind: "workflow-error",
          value: { name: error instanceof Error ? error.name : "Error", message: boundedError(error) },
          metadata: { workflowId: run.workflow.id },
          maximumBytes: Math.min(run.safety.outputBytes, 256 * 1024),
          createdAt: this.hooks.timestamp(),
        });
        break;
      } catch (artifactError) {
        if (artifactError instanceof RunRevisionConflictError) continue;
        break;
      }
    }
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      const run = this.database.readRun();
      if (run.status === "paused" || run.status === "waiting" || run.status === "stopped") return { status: run.status, run };
      if (run.status === "failed") return { status: "failed", run, error: run.reason?.summary ?? reason.summary };
      try {
        const failed = this.database.transitionRun(run.revision, {
          status: "failed",
          reason,
          currentOperationId: null,
          ...(errorArtifact ? { error: errorArtifact.artifact } : {}),
          startedAt: run.startedAt ?? this.hooks.timestamp(),
          endedAt: this.hooks.timestamp(),
          event: { type: "run-failed", payload: { summary: reason.summary }, at: this.hooks.timestamp() },
        });
        return { status: "failed", run: failed, error: reason.summary };
      } catch (transitionError) {
        if (transitionError instanceof RunRevisionConflictError) continue;
        throw transitionError;
      }
    }
    throw new Error("Could not fail run after repeated revision races");
  }
}
