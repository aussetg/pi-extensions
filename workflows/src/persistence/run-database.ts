import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "./sqlite.js";
import type { JsonValue } from "../types.js";
import type {
  AgentProgress,
  AgentProgressEvent,
  AgentSessionRecord,
  AgentToolReceiptRecord,
  ApplyPlanRecord,
  ApplyReceiptRecord,
  ApprovalRecord,
  ArtifactRecord,
  AttemptRecord,
  CandidateRecord,
  CandidateWorkspaceRecord,
  ControlAcknowledgement,
  ControlRequest,
  HumanCheckpointRecord,
  OperationRecord,
  RunRecord,
  StructuredReason,
  VerificationRecord,
} from "../runtime/durable-types.js";
import {
  assertAgentToolCallId,
  addUsage,
  assertArtifactRecord,
  assertArtifactRef,
  assertHash,
  assertIdentifier,
  assertIsoDate,
  assertPositiveInteger,
  assertNonNegativeInteger,
  assertResources,
  assertRunRecord,
  assertStructuredReason,
  assertUsage,
  encodeCanonicalJson,
  optionalString,
  optionalReasonJson,
  requiredNumber,
  requiredString,
  type SqlRow,
} from "./run-database-codec.js";
import {
  RunDatabaseStateError,
  RunRevisionConflictError,
} from "./run-database-errors.js";
import {
  insertAgentSessionRow,
  insertArtifactRow,
  insertAttemptRow,
  insertCurrentProgress,
  insertEvent,
  insertOperationRow,
  insertRun,
  nextEventSequence,
  nextSequence,
  replaceCurrentProgress,
  requiredArtifactRef,
  requiredOperation,
  usageValues,
} from "./run-database-records.js";
import {
  configureNewRunDatabaseConnection,
  openRunDatabaseConnection,
  RunDatabaseReader,
  type RunDatabaseOpenOptions,
} from "./run-database-reader.js";
import { RUN_DATABASE_SCHEMA_SQL } from "./run-database-schema.js";
import {
  assertAgentSession,
  assertAttempt,
  assertCandidateRecord,
  assertCandidateWorkspaceRecord,
  assertControlRequest,
  assertEvent,
  assertOperation,
  assertProgress,
  assertResult,
  assertStatus,
  controlRequestFields,
} from "./run-database-validation.js";
import {
  finalizeAgentProgress,
  insertWorkflowCall,
  insertWorkspaceCheckpoint,
  updateCompletedAttempt,
  updateCompletedOperation,
} from "./run-database-completion.js";
import {
  insertApplyPlanAndApproval,
  insertApplyReceipt,
  insertVerification,
} from "./run-database-evidence.js";
import {
  applyCoordinatorControl,
  applyCoordinatorOpenMutation,
  applyCoordinatorSignalPause,
  coordinatorOpenMutation,
  insertHumanCheckpoint as insertHumanCheckpointRow,
  type CoordinatorControlMutation,
} from "./run-database-coordinator.js";
import type {
  ApprovalControlResolution,
  AgentFinishToolCommit,
  AgentExecutionAdmission,
  AgentExecutionAdmissionResult,
  AgentInfrastructurePauseInput,
  AgentInfrastructureRetryInput,
  AgentMediatedToolCommit,
  AgentProgressToolCommit,
  AgentToolCommitResult,
  AgentYieldSettlementInput,
  AtomicOperationCompletion,
  ControlAcknowledgementInput,
  CoordinatorOpenResult,
  CreateRunDatabaseOptions,
  OperationClaim,
  OperationClaimResult,
  OperationPreclaim,
  OperationFailure,
  OperationFocus,
  RunStateTransition,
  RunTransitionEvent,
} from "./run-database-types.js";
import {
  applyOperationOrder,
  applyOperationPreclaim,
  applySafetyPause,
  assertOperationAdmission,
  assertSameOperationClaim,
  assertSameOperationClaimRow,
  planOperationOrder,
  validateOperationPreclaim,
} from "./run-database-structure.js";
import {
  applyWorkflowJournalPlan,
  buildWorkflowCallKey,
  planWorkflowJournal,
} from "./workflow-journal.js";
import {
  insertExperiment,
  insertMeasurement,
} from "./run-database-measurements.js";

export { RunDatabaseCorruptionError } from "./run-database-codec.js";
export {
  RunDatabaseReader,
  RunDatabaseVersionError,
  type RunDatabaseConfiguration,
  type RunDatabaseOpenOptions,
  type StructuredQueueProjection,
} from "./run-database-reader.js";
export { RUN_DATABASE_BUSY_TIMEOUT_MS, RUN_DATABASE_SCHEMA_VERSION } from "./run-database-schema.js";
export {
  RunDatabaseAdmissionError,
  RunDatabaseStateError,
  RunRevisionConflictError,
} from "./run-database-errors.js";
export type {
  AgentInfrastructurePauseInput,
  AgentInfrastructureRetryInput,
  AgentMediatedToolCommit,
  AgentYieldSettlementInput,
  ApprovalControlResolution,
  AtomicOperationCompletion,
  AgentExecutionAdmission,
  AgentExecutionAdmissionResult,
  ControlAcknowledgementInput,
  CoordinatorOpenResult,
  CreateRunDatabaseOptions,
  OperationClaim,
  OperationClaimResult,
  OperationAdmissionLimits,
  OperationPreclaim,
  OperationFailure,
  OperationFocus,
  RunStateTransition,
  RunTransitionEvent,
} from "./run-database-types.js";

export class RunDatabase extends RunDatabaseReader {
  private constructor(database: DatabaseSync, databasePath: string) {
    super(database, databasePath);
  }

  static create(databasePath: string, options: CreateRunDatabaseOptions): RunDatabase {
    const resolved = path.resolve(databasePath);
    assertRunRecord(options.run);
    if (options.run.revision !== 1) throw new TypeError("A new run database must start at revision 1");
    if (options.run.currentOperationId) throw new TypeError("A new run cannot have a current operation");
    const artifactRecords = options.artifacts ?? [];
    for (const artifact of artifactRecords) assertArtifactRecord(artifact, options.run.runId);
    const uniqueArtifacts = new Set(artifactRecords.map((artifact) => artifact.digest));
    if (uniqueArtifacts.size !== artifactRecords.length) throw new TypeError("Initial artifacts must have unique digests");

    let placeholder: number | undefined;
    let database: DatabaseSync | undefined;
    let ownsPath = false;
    try {
      placeholder = fs.openSync(resolved, "wx", 0o600);
      ownsPath = true;
      fs.closeSync(placeholder);
      placeholder = undefined;
      database = openRunDatabaseConnection(resolved, false, options, true);
      configureNewRunDatabaseConnection(database);
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(RUN_DATABASE_SCHEMA_SQL);
        insertRun(database, options.run);
        for (const artifact of artifactRecords) insertArtifactRow(database, artifact, options.run.runId);
        const resultDigest = options.run.result?.digest;
        const errorDigest = options.run.error?.digest;
        if (resultDigest) requiredArtifactRef(database, options.run.result!);
        if (errorDigest) requiredArtifactRef(database, options.run.error!);
        const eventAt = options.event?.at ?? options.run.createdAt;
        insertEvent(database, options.run.runId, 1, options.run.revision, {
          type: options.event?.type ?? "run-created",
          ...(options.event?.operationId ? { operationId: options.event.operationId } : {}),
          ...(options.event?.attemptId ? { attemptId: options.event.attemptId } : {}),
          payload: options.event?.payload ?? {},
          at: eventAt,
        });
        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* preserve initialization error */ }
        throw error;
      }
      return new RunDatabase(database, resolved);
    } catch (error) {
      if (placeholder !== undefined) fs.closeSync(placeholder);
      database?.close();
      if (ownsPath) removeDatabaseFiles(resolved);
      throw error;
    }
  }

  static open(databasePath: string, options: RunDatabaseOpenOptions = {}): RunDatabase {
    const resolved = path.resolve(databasePath);
    return new RunDatabase(openRunDatabaseConnection(resolved, false, options), resolved);
  }

  /**
   * Claim this run for a freshly started coordinator. A leftover running row
   * is interruption evidence, never permission to continue silently.
   */
  reconcileCoordinatorOpen(openedAt: string): CoordinatorOpenResult {
    assertIsoDate(openedAt, "coordinator open time");
    const before = this.readRun();
    const mutation = coordinatorOpenMutation(this.database, before);
    if (mutation.disposition === "none") return { run: before, ...mutation };
    this.write(before.revision, {
      type: mutation.disposition === "started"
        ? "coordinator-started"
        : mutation.disposition === "recovered"
          ? "coordinator-recovered"
          : "coordinator-interrupted",
      payload: {
        disposition: mutation.disposition,
        runningOperations: mutation.runningOperationIds.length,
      },
      at: openedAt,
    }, (run) => applyCoordinatorOpenMutation(this.database, run, mutation, openedAt));
    return { run: this.readRun(), ...mutation };
  }

  transitionRun(expectedRevision: number, transition: RunStateTransition): RunRecord {
    assertStatus(transition.status);
    assertEvent(transition.event);
    if (transition.currentOperationId) assertIdentifier(transition.currentOperationId, "current operation id");
    if (transition.result) assertArtifactRef(transition.result);
    if (transition.error) assertArtifactRef(transition.error);
    if (transition.startedAt) assertIsoDate(transition.startedAt, "run startedAt");
    if (transition.endedAt) assertIsoDate(transition.endedAt, "run endedAt");
    this.write(expectedRevision, transition.event, (run) => {
      if (transition.currentOperationId) requiredOperation(this.database, transition.currentOperationId, run.runId);
      if (transition.result) requiredArtifactRef(this.database, transition.result);
      if (transition.error) requiredArtifactRef(this.database, transition.error);
      this.database.prepare(`
        UPDATE runs SET
          status = ?, reason_json = ?, current_operation_id = ?,
          result_artifact_digest = ?, error_artifact_digest = ?,
          started_at = ?, ended_at = ?
        WHERE singleton = 1
      `).run(
        transition.status,
        transition.reason === undefined ? nullableEncoded(run.reason) : optionalReasonJson(transition.reason),
        transition.currentOperationId === undefined ? run.currentOperationId ?? null : transition.currentOperationId,
        transition.result === undefined ? run.result?.digest ?? null : transition.result?.digest ?? null,
        transition.error === undefined ? run.error?.digest ?? null : transition.error?.digest ?? null,
        transition.startedAt === undefined ? run.startedAt ?? null : transition.startedAt,
        transition.endedAt === undefined ? run.endedAt ?? null : transition.endedAt,
      );
    });
    return this.readRun();
  }

  insertOperation(expectedRevision: number, operation: OperationRecord, event: RunTransitionEvent): OperationRecord {
    assertOperation(operation);
    assertEvent(event);
    this.write(expectedRevision, event, (run) => {
      if (operation.runId !== run.runId) throw new TypeError("Operation belongs to a different run");
      if (operation.parentOperationId) requiredOperation(this.database, operation.parentOperationId, run.runId);
      insertOperationRow(this.database, operation);
      for (const [ordinal, artifact] of (operation.result?.artifacts ?? []).entries()) {
        requiredArtifactRef(this.database, artifact);
        this.database.prepare(
          "INSERT INTO operation_artifacts(operation_id, artifact_digest, role, name, ordinal) VALUES (?, ?, 'output', NULL, ?)",
        ).run(operation.operationId, artifact.digest, ordinal);
      }
      if (operation.replay) throw new TypeError("Replay evidence is admitted only by atomic effect completion");
      if (operation.status === "running") {
        this.database.prepare("UPDATE runs SET current_operation_id = ? WHERE singleton = 1").run(operation.operationId);
      }
    });
    return this.readOperation(operation.operationId)!;
  }

  /**
   * Claim one deterministic operation path. Reopening the same path is a
   * replay only when its immutable semantic identity is exact.
   */
  claimOperation(input: OperationClaim): OperationClaimResult {
    assertOperation(input.operation);
    assertEvent(input.event);
    if (input.operation.status !== "running" || input.operation.result || input.operation.reason) {
      throw new TypeError("A claimed operation must be a fresh running operation");
    }
    const previous = this.readOperationByPath(input.operation.path);
    if (previous) {
      assertSameOperationClaim(previous, input.operation);
      const run = this.readRun();
      if (previous.status === "completed") return { operation: previous, claimed: false };
      if (previous.status === "running" && run.currentOperationId === previous.operationId) {
        return { operation: previous, claimed: false };
      }
    }

    let claimed = false;
    this.write(input.expectedRevision, input.event, (run) => {
      if (run.status !== "running") throw new RunDatabaseStateError(`Run is ${run.status}, not admitting operations`);
      const row = this.database.prepare(
        "SELECT * FROM operations WHERE run_id = ? AND path = ?",
      ).get(run.runId, input.operation.path) as SqlRow | undefined;
      if (!row) {
        if (input.operation.runId !== run.runId) throw new TypeError("Operation belongs to a different run");
        if (input.admission) assertOperationAdmission(this.database, input.admission, [input.operation]);
        if (input.operation.parentOperationId) requiredOperation(this.database, input.operation.parentOperationId, run.runId);
        insertOperationRow(this.database, input.operation);
        claimed = true;
      } else {
        assertSameOperationClaimRow(row, input.operation);
        const status = requiredString(row, "status");
        if (status === "completed") return;
        if (status !== "queued" && status !== "running" && status !== "paused") {
          throw new RunDatabaseStateError(`Operation ${input.operation.path} is ${status}, not claimable`);
        }
        this.database.prepare(`
          UPDATE operations SET status = 'running', reason_json = NULL,
            started_at = coalesce(started_at, ?), updated_at = ?
          WHERE operation_id = ?
        `).run(input.event.at, input.event.at, requiredString(row, "operation_id"));
      }
      const operationId = row ? requiredString(row, "operation_id") : input.operation.operationId;
      this.database.prepare("UPDATE runs SET current_operation_id = ? WHERE singleton = 1").run(operationId);
    });
    return { operation: this.readOperationByPath(input.operation.path)!, claimed };
  }

  /**
   * Reserve a whole structural queue in one revision. Existing exact rows are
   * left untouched, so restart can safely repeat the reservation.
   */
  preclaimOperations(input: OperationPreclaim): OperationRecord[] {
    validateOperationPreclaim(input);
    assertEvent(input.event);
    const existing = input.operations.map((operation) => this.readOperationByPath(operation.path));
    if (existing.every(Boolean)) {
      for (let index = 0; index < input.operations.length; index++) {
        assertSameOperationClaim(existing[index]!, input.operations[index]!);
      }
      return existing as OperationRecord[];
    }
    this.write(input.expectedRevision, input.event, (run) => applyOperationPreclaim(this.database, run, input));
    return input.operations.map((operation) => this.readOperationByPath(operation.path)!);
  }

  focusOperation(input: OperationFocus): OperationRecord {
    assertIdentifier(input.operationId, "operation id");
    assertIsoDate(input.focusedAt, "operation focus time");
    const event: RunTransitionEvent = {
      ...input.event,
      operationId: input.operationId,
      at: input.event.at ?? input.focusedAt,
    };
    assertEvent(event);
    this.write(input.expectedRevision, event, (run) => {
      if (run.status !== "running") throw new RunDatabaseStateError(`Run is ${run.status}, not focusing operations`);
      const operation = requiredOperation(this.database, input.operationId, run.runId);
      const status = requiredString(operation, "status");
      if (status !== "queued" && status !== "running" && status !== "paused") {
        throw new RunDatabaseStateError(`Operation ${input.operationId} is ${status}, not focusable`);
      }
      this.database.prepare(`
        UPDATE operations SET status = 'running', reason_json = NULL,
          started_at = coalesce(started_at, ?), updated_at = ?
        WHERE operation_id = ?
      `).run(input.focusedAt, input.focusedAt, input.operationId);
      this.database.prepare("UPDATE runs SET current_operation_id = ? WHERE singleton = 1").run(input.operationId);
    });
    return this.readOperation(input.operationId)!;
  }

  /**
   * Repack operation ordinals into deterministic depth-first structural order.
   * Parallel completion calls this only after every launched branch settles.
   */
  normalizeOperationOrdinals(expectedRevision: number, at: string): OperationRecord[] {
    assertIsoDate(at, "operation-order time");
    const plan = planOperationOrder(this.database);
    const journalBefore = planWorkflowJournal(this.database);
    if (!plan.changed && !journalBefore.changed) return plan.ordered.map((id) => this.readOperation(id)!);
    this.write(expectedRevision, {
      type: "operation-order-normalized",
      payload: { operations: plan.ordered.length },
      at,
    }, () => {
      if (plan.changed) applyOperationOrder(this.database, plan);
      applyWorkflowJournalPlan(this.database, planWorkflowJournal(this.database));
    });
    return plan.ordered.map((id) => this.readOperation(id)!);
  }

  failOperation(input: OperationFailure): OperationRecord {
    assertIdentifier(input.operationId, "operation id");
    assertIsoDate(input.failedAt, "operation failure time");
    if (input.currentOperationId) assertIdentifier(input.currentOperationId, "current operation id");
    const reasonJson = optionalReasonJson(input.reason);
    const event: RunTransitionEvent = {
      ...input.event,
      operationId: input.operationId,
      at: input.event.at ?? input.failedAt,
    };
    assertEvent(event);
    this.write(input.expectedRevision, event, (run) => {
      const operation = requiredOperation(this.database, input.operationId, run.runId);
      const status = requiredString(operation, "status");
      if (status !== "queued" && status !== "running" && status !== "waiting" && status !== "paused") {
        throw new RunDatabaseStateError(`Operation ${input.operationId} is ${status}, not failable`);
      }
      const nextCurrent = input.currentOperationId === undefined
        ? (run.currentOperationId === input.operationId ? null : run.currentOperationId ?? null)
        : input.currentOperationId;
      if (nextCurrent) requiredOperation(this.database, nextCurrent, run.runId);
      this.database.prepare(`
        UPDATE operations SET status = 'failed', reason_json = ?, updated_at = ?, ended_at = ?
        WHERE operation_id = ?
      `).run(reasonJson, input.failedAt, input.failedAt, input.operationId);
      this.database.prepare(`
        UPDATE attempts SET status = 'failed', reason_json = ?, updated_at = ?, ended_at = ?
        WHERE operation_id = ? AND status IN ('queued', 'running', 'waiting', 'paused')
      `).run(reasonJson, input.failedAt, input.failedAt, input.operationId);
      this.database.prepare(`
        UPDATE agent_sessions SET status = 'failed', reason_json = ?, current_execution_id = NULL, updated_at = ?
        WHERE operation_id = ? AND status IN ('queued', 'running', 'waiting', 'paused')
      `).run(reasonJson, input.failedAt, input.operationId);
      this.database.prepare("UPDATE runs SET current_operation_id = ? WHERE singleton = 1").run(nextCurrent);
    });
    return this.readOperation(input.operationId)!;
  }

  insertAttempt(expectedRevision: number, attempt: AttemptRecord, event: RunTransitionEvent): AttemptRecord {
    assertAttempt(attempt);
    assertEvent(event);
    this.write(expectedRevision, event, (run) => {
      if (attempt.runId !== run.runId) throw new TypeError("Attempt belongs to a different run");
      requiredOperation(this.database, attempt.operationId, run.runId);
      insertAttemptRow(this.database, attempt);
      for (const [ordinal, artifact] of attempt.outputArtifacts.entries()) {
        requiredArtifactRef(this.database, artifact);
        this.database.prepare(
          "INSERT INTO attempt_artifacts(attempt_id, artifact_digest, role, name, ordinal) VALUES (?, ?, 'output', NULL, ?)",
        ).run(attempt.attemptId, artifact.digest, ordinal);
      }
      this.database.prepare(`
        UPDATE operations SET attempt_count = max(attempt_count, ?), updated_at = ? WHERE operation_id = ?
      `).run(attempt.number, event.at, attempt.operationId);
    });
    return this.readAttempt(attempt.attemptId)!;
  }

  createAgentSession(expectedRevision: number, session: AgentSessionRecord, event: RunTransitionEvent): AgentSessionRecord {
    assertAgentSession(session);
    assertEvent(event);
    this.write(expectedRevision, event, (run) => {
      if (session.runId !== run.runId) throw new TypeError("Agent session belongs to a different run");
      requiredOperation(this.database, session.operationId, run.runId);
      insertAgentSessionRow(this.database, session);
      for (const [ordinal, artifact] of (session.finish?.artifacts ?? []).entries()) {
        requiredArtifactRef(this.database, artifact);
        this.database.prepare(
          "INSERT INTO agent_finish_artifacts(agent_session_id, artifact_digest, ordinal) VALUES (?, ?, ?)",
        ).run(session.agentSessionId, artifact.digest, ordinal);
      }
      insertCurrentProgress(this.database, session.agentSessionId, session.progress);
    });
    return this.readAgentSession(session.agentSessionId)!;
  }

  /**
   * Admit one logical agent and its first physical execution atomically. A
   * coordinator/process recovery rebinds the same execution id; it never
   * creates another session or attempt.
   */
  admitAgentExecution(input: AgentExecutionAdmission): AgentExecutionAdmissionResult {
    assertPositiveInteger(input.expectedRevision, "agent admission expected revision");
    assertAttempt(input.attempt);
    assertAgentSession(input.session);
    assertEvent(input.event);
    if (input.attempt.effect !== "agent") throw new TypeError("Agent admission requires an agent attempt");
    if (!input.attempt.executionId || input.attempt.executionId !== input.session.currentExecutionId) {
      throw new TypeError("Agent admission execution ids differ");
    }
    if (input.attempt.operationId !== input.session.operationId || input.attempt.runId !== input.session.runId) {
      throw new TypeError("Agent admission bindings differ");
    }
    if (input.attempt.number !== 1 || input.attempt.status !== "running" || input.session.status !== "running") {
      throw new TypeError("A logical agent must begin with one running attempt and session");
    }
    const inputIds = new Set<string>();
    for (const entry of input.inputArtifacts) {
      assertIdentifier(entry.id, "agent input id");
      if (inputIds.has(entry.id)) throw new TypeError(`Duplicate agent input ${entry.id}`);
      inputIds.add(entry.id);
      assertArtifactRef(entry.artifact);
    }

    const existingSession = this.readAgentSessionByOperation(input.session.operationId);
    if (existingSession) {
      const existingAttempt = this.readAttempt(input.attempt.attemptId);
      if (!existingAttempt) throw new RunDatabaseStateError("Agent session has no logical attempt");
      assertSameAgentAdmission(existingAttempt, existingSession, input.attempt, input.session);
      this.assertAgentInputEdges(input.attempt.attemptId, input.session.operationId, input.inputArtifacts);
      if (existingSession.finish || existingSession.currentExecutionId === input.session.currentExecutionId) {
        return { attempt: existingAttempt, session: existingSession, created: false };
      }
      if (existingSession.currentExecutionId !== undefined) {
        throw new RunDatabaseStateError(`Agent session ${existingSession.agentSessionId} is owned by another execution`);
      }
      if (existingSession.status !== "running" || existingAttempt.status !== "running") {
        throw new RunDatabaseStateError(`Agent session ${existingSession.agentSessionId} is not reopenable`);
      }
      this.write(input.expectedRevision, {
        ...input.event,
        type: "agent-execution-reopened",
        operationId: input.session.operationId,
        attemptId: input.attempt.attemptId,
      }, (run) => {
        requiredOperation(this.database, input.session.operationId, run.runId);
        this.database.prepare(`
          UPDATE agent_sessions SET current_execution_id = ?, reason_json = NULL, updated_at = ?
          WHERE agent_session_id = ? AND status = 'running' AND current_execution_id IS NULL
        `).run(input.session.currentExecutionId!, input.event.at, input.session.agentSessionId);
      });
      const reopened = this.readAgentSession(input.session.agentSessionId)!;
      if (reopened.currentExecutionId !== input.session.currentExecutionId) {
        throw new RunDatabaseStateError(`Agent session ${reopened.agentSessionId} did not reopen`);
      }
      return {
        attempt: this.readAttempt(input.attempt.attemptId)!,
        session: reopened,
        created: false,
      };
    }

    this.write(input.expectedRevision, {
      ...input.event,
      operationId: input.session.operationId,
      attemptId: input.attempt.attemptId,
    }, (run) => {
      if (input.session.runId !== run.runId) throw new TypeError("Agent admission belongs to another run");
      const operation = requiredOperation(this.database, input.session.operationId, run.runId);
      if (requiredString(operation, "kind") !== "agent" || requiredString(operation, "status") !== "running") {
        throw new RunDatabaseStateError("Agent admission operation is not running");
      }
      insertAttemptRow(this.database, input.attempt);
      insertAgentSessionRow(this.database, input.session);
      insertCurrentProgress(this.database, input.session.agentSessionId, input.session.progress);
      for (const [ordinal, entry] of input.inputArtifacts.entries()) {
        requiredArtifactRef(this.database, entry.artifact);
        this.database.prepare(`
          INSERT INTO operation_artifacts(operation_id, artifact_digest, role, name, ordinal)
          VALUES (?, ?, 'input', ?, ?)
        `).run(input.session.operationId, entry.artifact.digest, entry.id, ordinal);
        this.database.prepare(`
          INSERT INTO attempt_artifacts(attempt_id, artifact_digest, role, name, ordinal)
          VALUES (?, ?, 'input', ?, ?)
        `).run(input.attempt.attemptId, entry.artifact.digest, entry.id, ordinal);
      }
      this.database.prepare(`
        UPDATE operations SET attempt_count = 1, updated_at = ? WHERE operation_id = ?
      `).run(input.event.at, input.session.operationId);
    });
    return {
      attempt: this.readAttempt(input.attempt.attemptId)!,
      session: this.readAgentSession(input.session.agentSessionId)!,
      created: true,
    };
  }

  createHumanCheckpoint(
    expectedRevision: number,
    checkpoint: HumanCheckpointRecord,
    event: RunTransitionEvent,
  ): HumanCheckpointRecord {
    assertEvent(event);
    this.write(expectedRevision, event, (run, nextRevision) => {
      insertHumanCheckpointRow(this.database, checkpoint, run.runId, nextRevision);
    });
    return this.readHumanCheckpoint(checkpoint.checkpointId)!;
  }

  recordAgentProgress(
    expectedRevision: number,
    agentSessionId: string,
    progress: AgentProgress,
    progressEvent: AgentProgressEvent,
    event: RunTransitionEvent,
  ): AgentSessionRecord {
    assertIdentifier(agentSessionId, "agent session id");
    assertProgress(progress);
    assertEvent(event);
    this.write(expectedRevision, event, (run) => {
      insertAgentProgressMutation(this.database, run.runId, agentSessionId, progress, progressEvent, event.at);
    });
    return this.readAgentSession(agentSessionId)!;
  }

  /** Commit one non-terminating SDK tool call and its projection before acknowledging the worker. */
  commitAgentProgressTool(input: AgentProgressToolCommit): AgentToolCommitResult {
    validateAgentToolCommit(input);
    assertProgress(input.progress);
    const existing = this.readAgentToolReceipt(input.agentSessionId, input.toolCallId);
    if (existing) return duplicateToolReceipt(existing, input);

    this.write(input.expectedRevision, {
      type: `agent-${input.toolName.replaceAll("_", "-")}`,
      operationId: this.readAgentSession(input.agentSessionId)?.operationId,
      payload: { agentSessionId: input.agentSessionId, toolCallId: input.toolCallId },
      at: input.committedAt,
    }, (run) => {
      requireLiveAgentExecution(this.database, run.runId, input.agentSessionId, input.executionId);
      insertAgentProgressMutation(
        this.database,
        run.runId,
        input.agentSessionId,
        input.progress,
        input.progressEvent,
        input.committedAt,
      );
      insertAgentToolReceipt(this.database, input);
    });
    return { receipt: this.readAgentToolReceipt(input.agentSessionId, input.toolCallId)!, duplicate: false };
  }

  /** The sole durable acknowledgement path for the terminating finish_work tool. */
  commitAgentFinishTool(input: AgentFinishToolCommit): AgentToolCommitResult {
    validateAgentToolCommit(input);
    if (input.toolName !== "finish_work") throw new TypeError("Agent finish commit has the wrong tool name");
    if (input.finish.toolCallId !== input.toolCallId) throw new TypeError("Finish receipt tool call differs from its request");
    assertHash(input.finish.schemaHash, "finish schema hash");
    if (input.finish.value !== undefined) encodeCanonicalJson(input.finish.value, "value");
    if (!Array.isArray(input.finish.artifacts) || input.finish.artifacts.length > 256) {
      throw new TypeError("Invalid finish artifacts");
    }
    for (const artifact of input.finish.artifacts) assertArtifactRef(artifact);
    assertIsoDate(input.finish.committedAt, "finish committedAt");
    if (input.finish.committedAt !== input.committedAt) throw new TypeError("Finish and tool commit timestamps differ");

    const existing = this.readAgentToolReceipt(input.agentSessionId, input.toolCallId);
    if (existing) return duplicateToolReceipt(existing, input);

    this.write(input.expectedRevision, {
      type: "agent-finish-committed",
      operationId: this.readAgentSession(input.agentSessionId)?.operationId,
      payload: { agentSessionId: input.agentSessionId, toolCallId: input.toolCallId },
      at: input.committedAt,
    }, (run) => {
      const session = requireLiveAgentExecution(
        this.database,
        run.runId,
        input.agentSessionId,
        input.executionId,
      );
      if (optionalString(session, "finish_tool_call_id")) {
        throw new RunDatabaseStateError(`Agent session ${input.agentSessionId} already has a finish_work receipt`);
      }
      for (const artifact of input.finish.artifacts) requiredArtifactRef(this.database, artifact);
      this.database.prepare(`
        UPDATE agent_sessions SET
          finish_tool_call_id = ?, finish_schema_hash = ?, finish_value_json = ?,
          finish_committed_at = ?, updated_at = ?
        WHERE agent_session_id = ?
      `).run(
        input.finish.toolCallId,
        input.finish.schemaHash,
        input.finish.value === undefined ? null : encodeCanonicalJson(input.finish.value, "value"),
        input.finish.committedAt,
        input.finish.committedAt,
        input.agentSessionId,
      );
      for (const [ordinal, artifact] of input.finish.artifacts.entries()) {
        this.database.prepare(
          "INSERT INTO agent_finish_artifacts(agent_session_id, artifact_digest, ordinal) VALUES (?, ?, ?)",
        ).run(input.agentSessionId, artifact.digest, ordinal);
      }
      insertAgentToolReceipt(this.database, input);
    });
    return { receipt: this.readAgentToolReceipt(input.agentSessionId, input.toolCallId)!, duplicate: false };
  }

  /** Commit a coordinator-mediated semantic tool before its result reaches the model. */
  commitAgentMediatedTool(input: AgentMediatedToolCommit): AgentToolCommitResult {
    validateAgentToolCommit(input);
    assertProgress(input.progress);
    const existing = this.readAgentToolReceipt(input.agentSessionId, input.toolCallId);
    if (existing) return duplicateToolReceipt(existing, input);
    this.write(input.expectedRevision, {
      type: `agent-${input.toolName.replaceAll("_", "-")}`,
      operationId: this.readAgentSession(input.agentSessionId)?.operationId,
      payload: { agentSessionId: input.agentSessionId, toolCallId: input.toolCallId },
      at: input.committedAt,
    }, (run) => {
      requireLiveAgentExecution(this.database, run.runId, input.agentSessionId, input.executionId);
      insertAgentProgressMutation(
        this.database,
        run.runId,
        input.agentSessionId,
        input.progress,
        { type: "observed", progress: input.progress },
        input.committedAt,
      );
      insertAgentToolReceipt(this.database, input);
    });
    return { receipt: this.readAgentToolReceipt(input.agentSessionId, input.toolCallId)!, duplicate: false };
  }

  /** Atomically apply the three-strike rule at one clean receiptless yield. */
  settleAgentYield(input: AgentYieldSettlementInput): AgentSessionRecord {
    assertAgentSupervisionInput(input);
    if (typeof input.meaningfulProgress !== "boolean") throw new TypeError("Invalid agent yield progress flag");
    this.write(input.expectedRevision, {
      type: "agent-receiptless-yield",
      operationId: this.readAgentSession(input.agentSessionId)?.operationId,
      payload: { agentSessionId: input.agentSessionId, meaningfulProgress: input.meaningfulProgress },
      at: input.at,
    }, (run) => {
      const row = requireLiveAgentExecution(this.database, run.runId, input.agentSessionId, input.executionId);
      if (optionalString(row, "finish_tool_call_id")) {
        throw new RunDatabaseStateError(`Agent session ${input.agentSessionId} already finished`);
      }
      const strikes = input.meaningfulProgress
        ? 0
        : Math.min(3, requiredNumber(row, "receiptless_strikes") + 1);
      if (strikes < 3) {
        this.database.prepare(`
          UPDATE agent_sessions SET receiptless_strikes = ?, reason_json = NULL, updated_at = ?
          WHERE agent_session_id = ?
        `).run(strikes, input.at, input.agentSessionId);
        return;
      }
      const reason: StructuredReason = {
        category: "agent-protocol",
        code: "receiptless-yield-limit",
        summary: "Agent paused after three consecutive clean yields without finish_work or meaningful progress",
        retryable: true,
        operationId: requiredString(row, "operation_id"),
      };
      pauseAgentHierarchy(this.database, run, input.agentSessionId, reason, input.at);
      this.database.prepare(
        "UPDATE agent_sessions SET receiptless_strikes = 3 WHERE agent_session_id = ?",
      ).run(input.agentSessionId);
    });
    return this.readAgentSession(input.agentSessionId)!;
  }

  /** Persist an infrastructure recovery without charging a receiptless strike. */
  recordAgentInfrastructureRetry(input: AgentInfrastructureRetryInput): AgentSessionRecord {
    assertAgentSupervisionInput(input);
    if (typeof input.meaningfulProgress !== "boolean") throw new TypeError("Invalid agent recovery progress flag");
    assertStructuredReason(input.reason);
    if (input.reason.category !== "provider" && input.reason.category !== "infrastructure") {
      throw new TypeError("Agent recovery reason must be provider or infrastructure");
    }
    this.write(input.expectedRevision, {
      type: "agent-infrastructure-retry",
      operationId: this.readAgentSession(input.agentSessionId)?.operationId,
      payload: { agentSessionId: input.agentSessionId, code: input.reason.code },
      at: input.at,
    }, (run) => {
      requireLiveAgentExecution(this.database, run.runId, input.agentSessionId, input.executionId);
      const progress = this.readAgentSession(input.agentSessionId)!.progress;
      replaceCurrentProgress(this.database, input.agentSessionId, {
        ...progress,
        retries: progress.retries + 1,
        currentTool: undefined,
        updatedAt: input.at,
      });
      this.database.prepare("UPDATE agent_sessions SET reason_json = ?, updated_at = ? WHERE agent_session_id = ?")
        .run(optionalReasonJson(input.reason), input.at, input.agentSessionId);
      if (input.meaningfulProgress) {
        this.database.prepare("UPDATE agent_sessions SET receiptless_strikes = 0 WHERE agent_session_id = ?")
          .run(input.agentSessionId);
      }
    });
    return this.readAgentSession(input.agentSessionId)!;
  }

  /** Pause the complete active operation after bounded recovery is exhausted. */
  pauseAgentForInfrastructure(input: AgentInfrastructurePauseInput): AgentSessionRecord {
    assertAgentSupervisionInput(input);
    if (typeof input.meaningfulProgress !== "boolean") throw new TypeError("Invalid agent recovery progress flag");
    assertStructuredReason(input.reason);
    if (input.reason.category !== "provider" && input.reason.category !== "infrastructure") {
      throw new TypeError("Agent infrastructure pause requires a provider or infrastructure reason");
    }
    this.write(input.expectedRevision, {
      type: "agent-infrastructure-paused",
      operationId: this.readAgentSession(input.agentSessionId)?.operationId,
      payload: { agentSessionId: input.agentSessionId, code: input.reason.code },
      at: input.at,
    }, (run) => {
      requireLiveAgentExecution(this.database, run.runId, input.agentSessionId, input.executionId);
      pauseAgentHierarchy(this.database, run, input.agentSessionId, input.reason, input.at);
    });
    return this.readAgentSession(input.agentSessionId)!;
  }

  registerArtifact(expectedRevision: number, artifact: ArtifactRecord, event: RunTransitionEvent): ArtifactRecord {
    assertEvent(event);
    const run = this.readRun();
    assertArtifactRecord(artifact, run.runId);
    this.write(expectedRevision, event, (current) => insertArtifactRow(this.database, artifact, current.runId));
    return structuredClone(artifact);
  }

  registerCandidateWorkspace(
    expectedRevision: number,
    workspace: CandidateWorkspaceRecord,
    event: RunTransitionEvent,
  ): CandidateWorkspaceRecord {
    assertCandidateWorkspaceRecord(workspace);
    const run = this.readRun();
    if (workspace.runId !== run.runId) throw new TypeError("Candidate workspace belongs to another run");
    const existing = this.readCandidateWorkspace(workspace.workspaceId);
    if (existing) {
      if (encodeCanonicalJson(existing as unknown as JsonValue, "value") !== encodeCanonicalJson(workspace as unknown as JsonValue, "value")) {
        throw new RunDatabaseStateError(`Candidate workspace id collision ${workspace.workspaceId}`);
      }
      return existing;
    }
    this.write(expectedRevision, event, (current) => {
      if (workspace.runId !== current.runId) throw new TypeError("Candidate workspace belongs to another run");
      if (workspace.parentCandidateId && !this.database.prepare(
        "SELECT 1 AS value FROM candidates WHERE candidate_id = ? AND run_id = ?",
      ).get(workspace.parentCandidateId, current.runId)) {
        throw new RunDatabaseStateError(`Unknown parent candidate ${workspace.parentCandidateId}`);
      }
      this.database.prepare(`
        INSERT INTO candidate_workspaces(
          workspace_id, run_id, logical_id, parent_candidate_id, initial_tree_hash,
          lineage_hash, write_scope_json, write_scope_hash, root_path, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        workspace.workspaceId,
        workspace.runId,
        workspace.logicalId,
        workspace.parentCandidateId ?? null,
        workspace.workspace.treeHash,
        workspace.workspace.lineageHash!,
        encodeCanonicalJson(workspace.writeScope as unknown as JsonValue),
        workspace.workspace.writeScopeHash!,
        workspace.rootPath,
        workspace.createdAt,
      );
    });
    return this.readCandidateWorkspace(workspace.workspaceId)!;
  }

  registerCandidate(expectedRevision: number, candidate: CandidateRecord, event: RunTransitionEvent): CandidateRecord {
    assertCandidateRecord(candidate);
    const run = this.readRun();
    if (candidate.runId !== run.runId) throw new TypeError("Candidate belongs to another run");
    const existing = this.readCandidate(candidate.candidateId);
    if (existing) {
      if (encodeCanonicalJson(existing as unknown as JsonValue, "value") !== encodeCanonicalJson(candidate as unknown as JsonValue, "value")) {
        throw new RunDatabaseStateError(`Candidate id collision ${candidate.candidateId}`);
      }
      return existing;
    }
    this.write(expectedRevision, event, (current) => {
      if (candidate.runId !== current.runId) throw new TypeError("Candidate belongs to another run");
      requiredArtifactRef(this.database, candidate.manifest);
      requiredArtifactRef(this.database, candidate.diff);
      const workspace = this.database.prepare(
        "SELECT parent_candidate_id, lineage_hash, write_scope_hash FROM candidate_workspaces WHERE workspace_id = ? AND run_id = ?",
      ).get(candidate.workspace.workspaceId, current.runId) as SqlRow | undefined;
      if (!workspace) throw new RunDatabaseStateError(`Unknown candidate workspace ${candidate.workspace.workspaceId}`);
      if (
        optionalString(workspace, "parent_candidate_id") !== candidate.parentCandidateId
        || requiredString(workspace, "lineage_hash") !== candidate.workspace.lineageHash
        || requiredString(workspace, "write_scope_hash") !== candidate.workspace.writeScopeHash
      ) throw new RunDatabaseStateError("Candidate authority differs from its mutable workspace");
      this.database.prepare(`
        INSERT INTO candidates(
          candidate_id, run_id, parent_candidate_id, workspace_id, tree_hash, lineage_hash,
          write_scope_hash, manifest_artifact_digest, diff_artifact_digest, frozen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        candidate.candidateId,
        candidate.runId,
        candidate.parentCandidateId ?? null,
        candidate.workspace.workspaceId,
        candidate.workspace.treeHash,
        candidate.workspace.lineageHash ?? null,
        candidate.workspace.writeScopeHash ?? null,
        candidate.manifest.digest,
        candidate.diff.digest,
        candidate.frozenAt,
      );
      for (const [ordinal, changedPath] of candidate.changedPaths.entries()) {
        this.database.prepare(
          "INSERT INTO candidate_changed_paths(candidate_id, ordinal, path) VALUES (?, ?, ?)",
        ).run(candidate.candidateId, ordinal, changedPath);
      }
    });
    return this.readCandidate(candidate.candidateId)!;
  }

  commitVerification(expectedRevision: number, record: VerificationRecord, event: RunTransitionEvent): VerificationRecord {
    const existing = this.readVerification(record.verificationId);
    if (existing) {
      if (encodeCanonicalJson(existing as unknown as JsonValue, "value") !== encodeCanonicalJson(record as unknown as JsonValue, "value")) {
        throw new RunDatabaseStateError(`Verification id collision ${record.verificationId}`);
      }
      return existing;
    }
    assertEvent(event);
    this.write(expectedRevision, event, (run) => insertVerification(this.database, record, run.runId));
    return this.readVerification(record.verificationId)!;
  }

  createApplyApproval(
    expectedRevision: number,
    plan: ApplyPlanRecord,
    approval: ApprovalRecord,
    event: RunTransitionEvent,
  ): { plan: ApplyPlanRecord; approval: ApprovalRecord } {
    const existing = this.readApplyPlan(plan.planId);
    if (existing) {
      const existingApproval = this.readApproval(existing.approvalId);
      if (!existingApproval
        || encodeCanonicalJson(existing as unknown as JsonValue, "value") !== encodeCanonicalJson(plan as unknown as JsonValue, "value")
        || encodeCanonicalJson(existingApproval as unknown as JsonValue, "value") !== encodeCanonicalJson(approval as unknown as JsonValue, "value")) {
        throw new RunDatabaseStateError(`Apply plan id collision ${plan.planId}`);
      }
      return { plan: existing, approval: existingApproval };
    }
    assertEvent(event);
    this.write(expectedRevision, event, (run) => insertApplyPlanAndApproval(this.database, plan, approval, run.runId));
    return { plan: this.readApplyPlan(plan.planId)!, approval: this.readApproval(approval.approvalId)! };
  }

  /**
   * The only approval decision path. It consumes a durable control request
   * from a human actor and acknowledges it in the same transaction.
   */
  resolveApprovalControlRequest(
    expectedRevision: number,
    requestId: string,
    resolvedAt: string,
  ): ApprovalControlResolution {
    const resolution = this.processCoordinatorControlRequest(expectedRevision, requestId, resolvedAt);
    if (resolution.request.kind !== "approve" && resolution.request.kind !== "reject") {
      throw new RunDatabaseStateError("Control request is not an approval decision");
    }
    const approval = this.readApproval(resolution.request.approvalId);
    if (!approval) throw new RunDatabaseStateError("Approval disappeared after acknowledgement");
    return { approval, acknowledgement: resolution.acknowledgement };
  }

  commitApplyReceipt(expectedRevision: number, receipt: ApplyReceiptRecord, event: RunTransitionEvent): ApplyReceiptRecord {
    const existing = this.readApplyReceipt(receipt.planId);
    if (existing) {
      if (encodeCanonicalJson(existing as unknown as JsonValue, "value") !== encodeCanonicalJson(receipt as unknown as JsonValue, "value")) {
        throw new RunDatabaseStateError(`Apply receipt collision for ${receipt.planId}`);
      }
      return existing;
    }
    assertEvent(event);
    this.write(expectedRevision, event, (run) => insertApplyReceipt(this.database, receipt, run.runId));
    return this.readApplyReceipt(receipt.planId)!;
  }

  completeOperation(input: AtomicOperationCompletion): OperationRecord {
    assertIdentifier(input.operationId, "operation id");
    if (input.attemptId) assertIdentifier(input.attemptId, "attempt id");
    assertIsoDate(input.completedAt, "operation completion time");
    assertResult(input.result);
    assertUsage(input.usage);
    assertResources(input.resources);
    for (const digest of [...(input.evidenceArtifacts ?? []), ...(input.progressArtifacts ?? [])]) {
      assertHash(digest, "completion artifact digest");
    }
    if (new Set(input.evidenceArtifacts ?? []).size !== (input.evidenceArtifacts ?? []).length) {
      throw new TypeError("Duplicate completion evidence artifact");
    }
    if (new Set(input.progressArtifacts ?? []).size !== (input.progressArtifacts ?? []).length) {
      throw new TypeError("Duplicate completion progress artifact");
    }
    if (input.replayMatchedCalls !== undefined) assertPositiveInteger(input.replayMatchedCalls, "matched replay calls");
    if ((input.replay === undefined) !== (input.replayMatchedCalls === undefined)) {
      throw new TypeError("Replay completion and prefix progress must be committed together");
    }
    if ([input.measurement, input.experiment, input.verification].filter(Boolean).length > 1) {
      throw new TypeError("One operation cannot commit two domain records");
    }
    if (input.verification && input.verification.attemptId !== input.attemptId) {
      throw new TypeError("Verification completion must settle its exact attempt");
    }
    if (input.replay) {
      if (!input.journal) throw new TypeError("A replayed completion requires a workflow journal call");
      assertIdentifier(input.replay.sourceRunId, "replay source run id");
      assertIdentifier(input.replay.sourceOperationId, "replay source operation id");
      assertNonNegativeInteger(input.replay.ordinal, "replay source ordinal");
      assertHash(input.replay.callKey, "replay call key");
      if (input.replay.restoredWorkspaceCheckpointId) {
        assertIdentifier(input.replay.restoredWorkspaceCheckpointId, "replay workspace checkpoint id");
      }
    }
    if (input.result.workspace?.kind === "candidate") {
      if (!input.workspaceCheckpoint) {
        throw new TypeError("A candidate-workspace result requires its exact post-workspace checkpoint");
      }
      if (encodeCanonicalJson(input.result.workspace as unknown as JsonValue) !== encodeCanonicalJson(input.workspaceCheckpoint.workspace as unknown as JsonValue)) {
        throw new TypeError("Operation result workspace differs from its post-workspace checkpoint");
      }
      if (input.journal?.postWorkspaceCheckpointId !== input.workspaceCheckpoint.checkpointId) {
        throw new TypeError("A mutating journal result must name its post-workspace checkpoint");
      }
    }
    if (input.runStatus) assertStatus(input.runStatus);
    if (input.currentOperationId) assertIdentifier(input.currentOperationId, "current operation id");
    const event: RunTransitionEvent = {
      ...input.event,
      operationId: input.operationId,
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      at: input.event.at ?? input.completedAt,
    };
    assertEvent(event);

    this.write(input.expectedRevision, event, (run) => {
      const operation = requiredOperation(this.database, input.operationId, run.runId);
      const operationStatus = requiredString(operation, "status");
      if (!new Set(["running", "waiting"]).has(operationStatus)) {
        throw new RunDatabaseStateError(`Operation ${input.operationId} is ${operationStatus}, not completable`);
      }
      if (input.journal) {
        if (input.journal.ordinal !== requiredNumber(operation, "ordinal")) {
          throw new TypeError("Workflow call ordinal differs from its operation ordinal");
        }
        const expectedCallKey = buildWorkflowCallKey({
          previousJournalKey: input.journal.previousJournalKey,
          operation: {
            path: requiredString(operation, "path"),
            sourceId: requiredString(operation, "source_id"),
            kind: requiredString(operation, "kind") as OperationRecord["kind"],
            semanticInputHash: requiredString(operation, "semantic_input_hash"),
          },
          semanticKey: input.journal.semanticKey,
        });
        if (expectedCallKey !== input.journal.callKey) throw new TypeError("Workflow call key is invalid");
        if (input.journal.replayPolicy === "workspace" && !input.result.workspace) {
          throw new TypeError("Workspace replay policy requires a workspace result");
        }
        if (input.journal.replayPolicy !== "workspace" && input.result.workspace) {
          throw new TypeError("A workspace result requires workspace replay policy");
        }
        if (requiredString(operation, "kind") === "agent" && input.journal.completionAuthority !== "finish-work") {
          throw new TypeError("Agent completion requires finish-work authority");
        }
      }
      for (const artifact of input.artifacts ?? []) insertArtifactRow(this.database, artifact, run.runId);
      for (const artifact of input.result.artifacts) requiredArtifactRef(this.database, artifact);
      if (input.workspaceCheckpoint) insertWorkspaceCheckpoint(this.database, input.workspaceCheckpoint, run.runId, input.operationId);

      if (input.attemptId) {
        const attempt = this.database.prepare(
          "SELECT status FROM attempts WHERE attempt_id = ? AND operation_id = ? AND run_id = ?",
        ).get(input.attemptId, input.operationId, run.runId) as SqlRow | undefined;
        if (!attempt) throw new RunDatabaseStateError(`Unknown attempt ${input.attemptId}`);
        const attemptStatus = requiredString(attempt, "status");
        if (!new Set(["running", "waiting"]).has(attemptStatus)) {
          throw new RunDatabaseStateError(`Attempt ${input.attemptId} is ${attemptStatus}, not completable`);
        }
        updateCompletedAttempt(this.database, input);
      }

      for (const [ordinal, artifact] of input.result.artifacts.entries()) {
        this.database.prepare(
          "INSERT INTO operation_artifacts(operation_id, artifact_digest, role, name, ordinal) VALUES (?, ?, 'output', NULL, ?)",
        ).run(input.operationId, artifact.digest, ordinal);
        if (input.attemptId) this.database.prepare(
          "INSERT INTO attempt_artifacts(attempt_id, artifact_digest, role, name, ordinal) VALUES (?, ?, 'output', NULL, ?)",
        ).run(input.attemptId, artifact.digest, ordinal);
      }

      for (const [role, digests] of [
        ["evidence", input.evidenceArtifacts ?? []],
        ["progress", input.progressArtifacts ?? []],
      ] as const) {
        for (const [ordinal, digest] of digests.entries()) {
          if (!this.readArtifact(digest)) throw new RunDatabaseStateError(`Unknown completion artifact ${digest}`);
          this.database.prepare(`
            INSERT INTO operation_artifacts(operation_id, artifact_digest, role, name, ordinal)
            VALUES (?, ?, ?, NULL, ?)
          `).run(input.operationId, digest, role, ordinal);
          if (input.attemptId) this.database.prepare(`
            INSERT INTO attempt_artifacts(attempt_id, artifact_digest, role, name, ordinal)
            VALUES (?, ?, ?, NULL, ?)
          `).run(input.attemptId, digest, role, ordinal);
        }
      }

      if (input.measurement) insertMeasurement(
        this.database, input.measurement, run.runId, input.operationId, input.attemptId,
      );
      if (input.experiment) insertExperiment(this.database, input.experiment, run.runId, input.operationId);
      if (input.verification) insertVerification(this.database, input.verification, run.runId);

      updateCompletedOperation(this.database, input);
      if (input.journal) insertWorkflowCall(this.database, input.journal, input.result, run.runId, input.operationId);
      if (input.replay) {
        if (input.replay.sourceRunId === run.runId) throw new TypeError("Cross-revision replay source must be another run");
        if (input.replay.sourceOperationId.length < 1) throw new TypeError("Replay source operation id is empty");
        if (input.replay.callKey !== input.journal!.callKey) {
          throw new TypeError("Replay evidence differs from its workflow journal call");
        }
        if (input.replay.restoredWorkspaceCheckpointId !== input.workspaceCheckpoint?.checkpointId) {
          throw new TypeError("Replay workspace evidence differs from its imported checkpoint");
        }
        this.database.prepare(`
          INSERT INTO operation_replays(
            operation_id, source_run_id, source_operation_id, ordinal, call_key,
            restored_workspace_checkpoint_id
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          input.operationId,
          input.replay.sourceRunId,
          input.replay.sourceOperationId,
          input.replay.ordinal,
          input.replay.callKey,
          input.replay.restoredWorkspaceCheckpointId ?? null,
        );
        const changed = this.database.prepare(`
          UPDATE run_replay SET matched_calls = ?
          WHERE run_id = ? AND mode = 'cross-revision-prefix' AND fresh = 0
            AND first_miss_ordinal IS NULL AND matched_calls = ?
        `).run(input.replayMatchedCalls!, run.runId, input.replayMatchedCalls! - 1).changes;
        if (Number(changed) !== 1) throw new RunDatabaseStateError("Replay prefix changed before hit commit");
      }
      finalizeAgentProgress(this.database, input);

      const usage = addUsage(run.usage, input.usage);
      const nextCurrent = input.currentOperationId === undefined
        ? (run.currentOperationId === input.operationId ? null : run.currentOperationId ?? null)
        : input.currentOperationId;
      if (nextCurrent) requiredOperation(this.database, nextCurrent, run.runId);
      this.database.prepare(`
        UPDATE runs SET
          status = ?, current_operation_id = ?,
          usage_input_tokens = ?, usage_output_tokens = ?, usage_cache_read_tokens = ?,
          usage_cache_write_tokens = ?, usage_provider_requests = ?, usage_cost = ?,
          usage_elapsed_ms = ?, usage_complete = ?
        WHERE singleton = 1
      `).run(
        input.runStatus ?? run.status,
        nextCurrent,
        ...usageValues(usage),
      );
    });
    return this.readOperation(input.operationId)!;
  }

  recordReplayMiss(expectedRevision: number, ordinal: number, reason: string, at: string): RunRecord {
    assertNonNegativeInteger(ordinal, "replay miss ordinal");
    assertIsoDate(at, "replay miss time");
    if (typeof reason !== "string" || !reason.trim() || Buffer.byteLength(reason) > 2_048) {
      throw new TypeError("Invalid replay miss reason");
    }
    const run = this.readRun();
    if (!run.replay || run.replay.mode !== "cross-revision-prefix" || run.replay.fresh) {
      throw new RunDatabaseStateError("Run is not consuming an explicit replay prefix");
    }
    if (run.replay.firstMissOrdinal !== undefined) return run;
    this.write(expectedRevision, {
      type: "replay-prefix-missed",
      payload: { ordinal, reason },
      at,
    }, (current) => {
      const changed = this.database.prepare(`
        UPDATE run_replay SET first_miss_ordinal = ?, first_miss_reason = ?
        WHERE run_id = ? AND first_miss_ordinal IS NULL AND fresh = 0
      `).run(ordinal, reason, current.runId).changes;
      if (Number(changed) !== 1) throw new RunDatabaseStateError("Replay miss boundary changed concurrently");
    });
    return this.readRun();
  }

  enqueueControlRequest(request: ControlRequest): ControlRequest {
    assertControlRequest(request);
    if ((request.kind === "approve" || request.kind === "reject") && !request.actor.startsWith("human:")) {
      throw new TypeError("Approval control requests require a human actor");
    }
    const event: RunTransitionEvent = {
      type: "control-requested",
      ...(request.kind === "stop-effect" ? { operationId: request.operationId } : {}),
      payload: { requestId: request.requestId, kind: request.kind },
      at: request.requestedAt,
    };
    this.write(request.expectedRevision, event, (run) => {
      if (request.runId !== run.runId) throw new TypeError("Control request belongs to a different run");
      const sequence = requiredNumber(
        this.database.prepare("SELECT coalesce(max(inbox_sequence), 0) + 1 AS value FROM control_requests").get() as SqlRow,
        "value",
      );
      const fields = controlRequestFields(request);
      this.database.prepare(`
        INSERT INTO control_requests(
          request_id, run_id, inbox_sequence, expected_revision, kind, requested_at, actor,
          operation_id, reason, checkpoint_id, approval_id, challenge_hash, value_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        request.requestId,
        request.runId,
        sequence,
        request.expectedRevision,
        request.kind,
        request.requestedAt,
        request.actor,
        fields.operationId,
        fields.reason,
        fields.checkpointId,
        fields.approvalId,
        fields.challengeHash,
        fields.valueJson,
      );
    });
    return request;
  }

  acknowledgeControlRequest(input: ControlAcknowledgementInput): ControlAcknowledgement {
    assertIdentifier(input.requestId, "control request id");
    assertPositiveInteger(input.expectedRevision, "expected revision");
    assertIsoDate(input.acknowledgedAt, "control acknowledgement time");
    if (typeof input.accepted !== "boolean") throw new TypeError("Invalid control acknowledgement decision");
    const event: RunTransitionEvent = {
      type: "control-acknowledged",
      payload: { requestId: input.requestId, accepted: input.accepted },
      at: input.acknowledgedAt,
    };
    let acknowledgement!: ControlAcknowledgement;
    this.write(input.expectedRevision, event, (run, nextRevision) => {
      const request = this.database.prepare(
        "SELECT request_id FROM control_requests WHERE request_id = ? AND run_id = ?",
      ).get(input.requestId, run.runId) as SqlRow | undefined;
      if (!request) throw new RunDatabaseStateError(`Unknown control request ${input.requestId}`);
      if (this.database.prepare("SELECT 1 AS value FROM control_acknowledgements WHERE request_id = ?").get(input.requestId)) {
        throw new RunDatabaseStateError(`Control request ${input.requestId} is already acknowledged`);
      }
      this.database.prepare(`
        INSERT INTO control_acknowledgements(
          request_id, run_id, accepted, revision, reason_json, acknowledged_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.requestId,
        run.runId,
        input.accepted ? 1 : 0,
        nextRevision,
        optionalReasonJson(input.reason),
        input.acknowledgedAt,
      );
      acknowledgement = {
        requestId: input.requestId,
        runId: run.runId,
        accepted: input.accepted,
        revision: nextRevision,
        ...(input.reason ? { reason: input.reason } : {}),
        acknowledgedAt: input.acknowledgedAt,
      };
    });
    return acknowledgement;
  }

  /** Consume and acknowledge one inbox row in the same revision transaction. */
  processCoordinatorControlRequest(
    expectedRevision: number,
    requestId: string,
    acknowledgedAt: string,
  ): CoordinatorControlMutation {
    assertIdentifier(requestId, "control request id");
    assertIsoDate(acknowledgedAt, "control acknowledgement time");
    const existing = this.readControlAcknowledgement(requestId);
    if (existing) {
      const request = this.readControlRequest(requestId);
      if (!request) throw new RunDatabaseStateError(`Unknown acknowledged control request ${requestId}`);
      return { request, acknowledgement: existing, exitRequested: existing.accepted && request.kind === "shutdown" };
    }
    let result!: CoordinatorControlMutation;
    this.write(expectedRevision, {
      type: "control-consumed",
      payload: { requestId },
      at: acknowledgedAt,
    }, (run, nextRevision) => {
      result = applyCoordinatorControl(this.database, run, nextRevision, requestId, acknowledgedAt);
    });
    return result;
  }

  pauseCoordinatorForSignal(expectedRevision: number, at: string, summary: string): RunRecord {
    assertIsoDate(at, "coordinator signal time");
    if (typeof summary !== "string" || !summary.trim()) throw new TypeError("Coordinator signal summary is empty");
    this.write(expectedRevision, {
      type: "coordinator-signalled",
      payload: {},
      at,
    }, (run) => applyCoordinatorSignalPause(this.database, run, at, summary));
    return this.readRun();
  }

  /** Pause only after the engine has let already-launched effects settle. */
  pauseRunForSafety(expectedRevision: number, at: string, reason: StructuredReason): RunRecord {
    assertIsoDate(at, "safety pause time");
    assertStructuredReason(reason);
    if (reason.category !== "safety") throw new TypeError("Safety pause requires a safety reason");
    this.write(expectedRevision, {
      type: "safety-admission-paused",
      ...(reason.operationId ? { operationId: reason.operationId } : {}),
      payload: { code: reason.code, summary: reason.summary },
      at,
    }, (run) => applySafetyPause(this.database, run, at, reason));
    return this.readRun();
  }

  private assertAgentInputEdges(
    attemptId: string,
    operationId: string,
    expected: AgentExecutionAdmission["inputArtifacts"],
  ): void {
    const read = (table: "operation_artifacts" | "attempt_artifacts", key: "operation_id" | "attempt_id", id: string) =>
      (this.database.prepare(`
        SELECT artifact_digest, name, ordinal FROM ${table}
        WHERE ${key} = ? AND role = 'input' ORDER BY ordinal
      `).all(id) as SqlRow[]).map((row) => ({
        digest: requiredString(row, "artifact_digest"),
        id: requiredString(row, "name"),
        ordinal: requiredNumber(row, "ordinal"),
      }));
    const wanted = expected.map((entry, ordinal) => ({ digest: entry.artifact.digest, id: entry.id, ordinal }));
    if (
      encodeCanonicalJson(read("operation_artifacts", "operation_id", operationId) as unknown as JsonValue)
        !== encodeCanonicalJson(wanted as unknown as JsonValue)
      || encodeCanonicalJson(read("attempt_artifacts", "attempt_id", attemptId) as unknown as JsonValue)
        !== encodeCanonicalJson(wanted as unknown as JsonValue)
    ) throw new RunDatabaseStateError("Agent input artifact bindings changed across recovery");
  }

  private write(
    expectedRevision: number,
    event: RunTransitionEvent,
    mutate: (run: RunRecord, nextRevision: number) => void,
  ): void {
    this.assertOpen();
    assertPositiveInteger(expectedRevision, "expected revision");
    assertEvent(event);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.readRun();
      if (run.revision !== expectedRevision) throw new RunRevisionConflictError(expectedRevision, run.revision);
      const nextRevision = expectedRevision + 1;
      if (!Number.isSafeInteger(nextRevision)) throw new RangeError("Run revision overflow");
      mutate(run, nextRevision);
      const sequence = nextEventSequence(this.database, run.runId);
      insertEvent(this.database, run.runId, sequence, nextRevision, event);
      const changed = this.database.prepare(`
        UPDATE runs SET revision = ?, updated_at = ? WHERE singleton = 1 AND revision = ?
      `).run(nextRevision, event.at, expectedRevision).changes;
      if (Number(changed) !== 1) throw new RunRevisionConflictError(expectedRevision, this.readRun().revision);
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve transition error */ }
      throw error;
    }
  }
}

function assertSameAgentAdmission(
  existingAttempt: AttemptRecord,
  existingSession: AgentSessionRecord,
  proposedAttempt: AttemptRecord,
  proposedSession: AgentSessionRecord,
): void {
  const attemptIdentity = (attempt: AttemptRecord) => ({
    attemptId: attempt.attemptId,
    runId: attempt.runId,
    operationId: attempt.operationId,
    number: attempt.number,
    effect: attempt.effect,
    executionId: attempt.executionId ?? null,
    preWorkspace: attempt.preWorkspace ?? null,
  });
  const sessionIdentity = (session: AgentSessionRecord) => ({
    agentSessionId: session.agentSessionId,
    runId: session.runId,
    operationId: session.operationId,
    profileId: session.profileId,
    routeId: session.routeId,
    piSessionPath: session.piSessionPath,
    workspace: session.workspace,
    network: session.network,
  });
  if (
    encodeCanonicalJson(attemptIdentity(existingAttempt) as unknown as JsonValue)
      !== encodeCanonicalJson(attemptIdentity(proposedAttempt) as unknown as JsonValue)
    || encodeCanonicalJson(sessionIdentity(existingSession) as unknown as JsonValue)
      !== encodeCanonicalJson(sessionIdentity(proposedSession) as unknown as JsonValue)
  ) throw new RunDatabaseStateError("Logical agent admission changed across recovery");
}

function assertAgentSupervisionInput(input: {
  expectedRevision: number;
  agentSessionId: string;
  executionId: string;
  at: string;
}): void {
  assertPositiveInteger(input.expectedRevision, "agent supervision expected revision");
  assertIdentifier(input.agentSessionId, "agent session id");
  assertIdentifier(input.executionId, "agent execution id");
  assertIsoDate(input.at, "agent supervision time");
}

function pauseAgentHierarchy(
  database: DatabaseSync,
  run: RunRecord,
  agentSessionId: string,
  reason: StructuredReason,
  at: string,
): void {
  const row = database.prepare(
    "SELECT operation_id, current_execution_id FROM agent_sessions WHERE agent_session_id = ? AND run_id = ?",
  ).get(agentSessionId, run.runId) as SqlRow | undefined;
  if (!row) throw new RunDatabaseStateError(`Unknown agent session ${agentSessionId}`);
  const operationId = requiredString(row, "operation_id");
  const executionId = requiredString(row, "current_execution_id");
  const reasonJson = optionalReasonJson(reason);
  database.prepare(`
    UPDATE agent_sessions SET status = 'paused', reason_json = ?, current_execution_id = NULL, updated_at = ?
    WHERE agent_session_id = ?
  `).run(reasonJson, at, agentSessionId);
  database.prepare(`
    UPDATE attempts SET status = 'paused', reason_json = ?, updated_at = ?
    WHERE operation_id = ? AND execution_id = ? AND status IN ('queued', 'running', 'waiting')
  `).run(reasonJson, at, operationId, executionId);
  database.prepare(`
    UPDATE operations SET status = 'paused', reason_json = ?, updated_at = ?
    WHERE operation_id = ? AND status IN ('queued', 'running', 'waiting')
  `).run(reasonJson, at, operationId);
  database.prepare(`
    UPDATE runs SET status = 'paused', reason_json = ?, current_operation_id = NULL WHERE singleton = 1
  `).run(reasonJson);
}

function validateAgentToolCommit(input: AgentProgressToolCommit | AgentFinishToolCommit | AgentMediatedToolCommit): void {
  assertPositiveInteger(input.expectedRevision, "agent tool expected revision");
  assertIdentifier(input.agentSessionId, "agent session id");
  assertIdentifier(input.executionId, "agent execution id");
  assertAgentToolCallId(input.toolCallId);
  assertHash(input.requestHash, "agent tool request hash");
  assertIsoDate(input.committedAt, "agent tool commit time");
  if (!["finish_work", "report_progress", "log_result", "publish_artifact", "web_search", "web_fetch", "workspace_command"].includes(input.toolName)) {
    throw new TypeError(`Unknown agent protocol tool ${input.toolName}`);
  }
  encodeCanonicalJson(input.response, "value");
}

function duplicateToolReceipt(
  existing: AgentToolReceiptRecord,
  input: AgentProgressToolCommit | AgentFinishToolCommit | AgentMediatedToolCommit,
): AgentToolCommitResult {
  if (
    existing.executionId !== input.executionId
    || existing.toolName !== input.toolName
    || existing.requestHash !== input.requestHash
  ) {
    throw new RunDatabaseStateError(
      `Conflicting duplicate ${input.toolName} call ${input.toolCallId} for ${input.agentSessionId}`,
    );
  }
  return { receipt: existing, duplicate: true };
}

function requireLiveAgentExecution(
  database: DatabaseSync,
  runId: string,
  agentSessionId: string,
  executionId: string,
): SqlRow {
  const session = database.prepare(
    "SELECT * FROM agent_sessions WHERE agent_session_id = ? AND run_id = ?",
  ).get(agentSessionId, runId) as SqlRow | undefined;
  if (!session) throw new RunDatabaseStateError(`Unknown agent session ${agentSessionId}`);
  const status = requiredString(session, "status");
  if (status !== "running" && status !== "waiting") {
    throw new RunDatabaseStateError(`Agent session ${agentSessionId} is ${status}, not accepting tool calls`);
  }
  if (requiredString(session, "current_execution_id") !== executionId) {
    throw new RunDatabaseStateError(`Agent execution ${executionId} is not current for ${agentSessionId}`);
  }
  const operation = requiredOperation(database, requiredString(session, "operation_id"), runId);
  if (requiredString(operation, "kind") !== "agent") {
    throw new RunDatabaseStateError(`Agent session ${agentSessionId} is bound to a non-agent operation`);
  }
  return session;
}

function insertAgentToolReceipt(
  database: DatabaseSync,
  input: AgentProgressToolCommit | AgentFinishToolCommit | AgentMediatedToolCommit,
): void {
  database.prepare(`
    INSERT INTO agent_tool_receipts(
      agent_session_id, execution_id, tool_call_id, tool_name, request_hash, response_json, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.agentSessionId,
    input.executionId,
    input.toolCallId,
    input.toolName,
    input.requestHash,
    encodeCanonicalJson(input.response, "value"),
    input.committedAt,
  );
}

function insertAgentProgressMutation(
  database: DatabaseSync,
  runId: string,
  agentSessionId: string,
  progress: AgentProgress,
  progressEvent: AgentProgressEvent,
  at: string,
): void {
  const session = database.prepare(
    "SELECT operation_id FROM agent_sessions WHERE agent_session_id = ? AND run_id = ?",
  ).get(agentSessionId, runId) as SqlRow | undefined;
  if (!session) throw new RunDatabaseStateError(`Unknown agent session ${agentSessionId}`);
  replaceCurrentProgress(database, agentSessionId, progress);
  const sequence = nextSequence(database, "agent_progress_history");
  const kind = progressEvent.type;
  const message = kind === "report" || kind === "log" ? progressEvent.message : null;
  const artifact = kind === "log" || kind === "artifact" ? progressEvent.artifact : undefined;
  if (artifact) requiredArtifactRef(database, artifact);
  const name = kind === "artifact" ? progressEvent.name ?? null : null;
  const visible = kind === "observed" ? 0 : 1;
  database.prepare(`
    INSERT INTO agent_progress_history(
      run_id, sequence, operation_id, agent_session_id, at, type, message, artifact_digest, name, visible, event_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    sequence,
    requiredString(session, "operation_id"),
    agentSessionId,
    at,
    kind,
    message,
    artifact?.digest ?? null,
    name,
    visible,
    encodeCanonicalJson(progressEvent as unknown as JsonValue, "value"),
  );
  database.prepare("UPDATE agent_sessions SET updated_at = ? WHERE agent_session_id = ?").run(at, agentSessionId);
}

function nullableEncoded(value: StructuredReason | undefined): string | null {
  return value ? optionalReasonJson(value) : null;
}

function removeDatabaseFiles(databasePath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.rmSync(`${databasePath}${suffix}`, { force: true }); } catch { /* best effort after failed create */ }
  }
}
