import crypto from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RunCatalog, shortRunIds, type RunCatalogEntry } from "../persistence/run-catalog.js";
import { RunDatabase } from "../persistence/run-database.js";
import type { JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { CoordinatorAlreadyRunningError, CoordinatorService } from "./coordinator-service.js";
import { coordinatorUnitName } from "./coordinator-identity.js";
import type { ControlRequest, OperationRecord } from "./durable-types.js";
import { deterministicSemanticId } from "./semantic-engine-helpers.js";
import type {
  WorkflowApprovalChallenge,
  WorkflowCheckpointChallenge,
  WorkflowDeletionChallenge,
  WorkflowRunSummary,
} from "./named-workflow-types.js";
import { summarizeRun } from "./workflow-run-values.js";

const TERMINAL = new Set(["completed", "failed", "stopped"]);

/** Inserts revision-bound requests; the coordinator remains the sole scheduler. */
export class WorkflowControlClient {
  constructor(
    readonly catalog: RunCatalog,
    readonly coordinator: CoordinatorService,
  ) {}

  async pause(runRef: string, ctx: ExtensionContext): Promise<WorkflowRunSummary> {
    return await this.simple(runRef, { kind: "pause", reason: "Paused by the primary session" }, ctx);
  }

  async resume(runRef: string, ctx: ExtensionContext): Promise<WorkflowRunSummary> {
    return await this.simple(runRef, { kind: "resume" }, ctx);
  }

  async stop(runRef: string, ctx: ExtensionContext): Promise<WorkflowRunSummary> {
    return await this.simple(runRef, { kind: "stop", reason: "Stopped by the primary session" }, ctx);
  }

  async stopEffect(runRef: string, operationRef: string, ctx: ExtensionContext): Promise<WorkflowRunSummary> {
    const entry = await this.catalog.resolve(runRef);
    const database = RunDatabase.open(entry.paths.database);
    try {
      const operation = resolveOperation(database, operationRef);
      if (!["queued", "running", "waiting", "paused"].includes(operation.status)) {
        throw new Error(`Operation ${operation.path} is ${operation.status}, not active`);
      }
      enqueue(database, ctx, { kind: "stop-effect", operationId: operation.operationId, reason: "Stopped by the primary session" });
    } finally {
      database.close();
    }
    await this.wake(entry);
    return await this.summary(entry);
  }

  async checkpointChallenge(
    runRef: string,
    checkpointId: string | undefined,
    _ctx: ExtensionContext,
  ): Promise<WorkflowCheckpointChallenge> {
    const entry = await this.catalog.resolve(runRef);
    const database = RunDatabase.open(entry.paths.database);
    try {
      const run = database.readRun();
      const checkpoint = checkpointId
        ? database.readHumanCheckpoint(checkpointId)
        : activeCheckpoint(database);
      if (!checkpoint || checkpoint.status !== "waiting") throw new Error("There is no matching waiting checkpoint");
      return { summary: summarizeRun(run, await this.shortId(entry.runId)), checkpoint, token: checkpoint.challengeHash };
    } finally {
      database.close();
    }
  }

  async respond(
    runRef: string,
    checkpointId: string | undefined,
    challenge: string,
    value: JsonValue,
    ctx: ExtensionContext,
  ): Promise<WorkflowRunSummary> {
    const entry = await this.catalog.resolve(runRef);
    const database = RunDatabase.open(entry.paths.database);
    try {
      const checkpoint = checkpointId
        ? database.readHumanCheckpoint(checkpointId)
        : activeCheckpoint(database);
      if (!checkpoint || checkpoint.status !== "waiting") throw new Error("There is no matching waiting checkpoint");
      if (checkpoint.challengeHash !== challenge) throw new Error("Checkpoint challenge is stale");
      enqueue(database, ctx, {
        kind: "checkpoint-response",
        checkpointId: checkpoint.checkpointId,
        challengeHash: challenge,
        value,
      });
    } finally {
      database.close();
    }
    await this.wake(entry);
    return await this.summary(entry);
  }

  async approvalChallenge(runRef: string, _ctx: ExtensionContext): Promise<WorkflowApprovalChallenge> {
    const entry = await this.catalog.resolve(runRef);
    const database = RunDatabase.open(entry.paths.database);
    try {
      const run = database.readRun();
      const operation = activeApplyOperation(database);
      const plan = database.readApplyPlanByOperation(operation.operationId);
      const approval = plan ? database.readApproval(plan.approvalId) : undefined;
      if (!approval || approval.status !== "waiting") throw new Error("There is no waiting apply approval");
      return {
        summary: summarizeRun(run, await this.shortId(entry.runId)),
        approvalId: approval.approvalId,
        operationId: operation.operationId,
        token: approval.challenge.challengeHash,
        summaryArtifact: approval.challenge.summary,
      };
    } finally {
      database.close();
    }
  }

  async decideApproval(
    runRef: string,
    decision: "approve" | "reject",
    challenge: string,
    ctx: ExtensionContext,
  ): Promise<WorkflowRunSummary> {
    const entry = await this.catalog.resolve(runRef);
    const database = RunDatabase.open(entry.paths.database);
    try {
      const operation = activeApplyOperation(database);
      const plan = database.readApplyPlanByOperation(operation.operationId);
      const approval = plan ? database.readApproval(plan.approvalId) : undefined;
      if (!approval || approval.status !== "waiting") throw new Error("There is no waiting apply approval");
      if (approval.challenge.challengeHash !== challenge) throw new Error("Apply approval challenge is stale");
      enqueue(database, ctx, decision === "approve"
        ? { kind: "approve", approvalId: approval.approvalId, challengeHash: challenge }
        : { kind: "reject", approvalId: approval.approvalId, challengeHash: challenge, reason: "Rejected by the primary session" });
    } finally {
      database.close();
    }
    await this.wake(entry);
    return await this.summary(entry);
  }

  async deletionChallenge(runRef: string, _ctx: ExtensionContext): Promise<WorkflowDeletionChallenge> {
    const entry = await this.catalog.resolve(runRef);
    const database = RunDatabase.open(entry.paths.database);
    try {
      const run = database.readRun();
      if (!TERMINAL.has(run.status)) throw new Error(`Run ${run.runId} is ${run.status}, not terminal`);
      const summary = summarizeRun(run, await this.shortId(entry.runId));
      return { summary, token: deletionToken(summary) };
    } finally {
      database.close();
    }
  }

  async deleteRun(runRef: string, challenge: string, ctx: ExtensionContext): Promise<void> {
    const prepared = await this.deletionChallenge(runRef, ctx);
    if (prepared.token !== challenge) throw new Error("Run deletion challenge is stale");
    const unit = await this.coordinator.launcher.inspect(coordinatorUnitName(prepared.summary.runId));
    if (["active", "activating", "deactivating", "reloading"].includes(unit.activeState)) {
      throw new Error(`Coordinator ${unit.unit} is still active`);
    }
    await this.catalog.delete(prepared.summary.runId);
  }

  private async simple(
    runRef: string,
    control: { kind: "pause"; reason: string } | { kind: "resume" } | { kind: "stop"; reason: string },
    ctx: ExtensionContext,
  ): Promise<WorkflowRunSummary> {
    const entry = await this.catalog.resolve(runRef);
    const database = RunDatabase.open(entry.paths.database);
    try {
      const run = database.readRun();
      if (control.kind === "pause" && run.status !== "queued" && run.status !== "running") {
        throw new Error(`Run is ${run.status}, not active`);
      }
      if (control.kind === "resume" && run.status !== "paused") throw new Error(`Run is ${run.status}, not paused`);
      if (control.kind === "stop" && TERMINAL.has(run.status)) throw new Error(`Run is already ${run.status}`);
      enqueue(database, ctx, control);
    } finally {
      database.close();
    }
    await this.wake(entry);
    return await this.summary(entry);
  }

  private async wake(entry: RunCatalogEntry): Promise<void> {
    try {
      await this.coordinator.launch(entry.paths.root);
    } catch (error) {
      if (!(error instanceof CoordinatorAlreadyRunningError)) throw error;
    }
  }

  private async summary(entry: RunCatalogEntry): Promise<WorkflowRunSummary> {
    const database = RunDatabase.open(entry.paths.database);
    try { return summarizeRun(database.readRun(), await this.shortId(entry.runId)); }
    finally { database.close(); }
  }

  private async shortId(runId: string): Promise<string> {
    const ids = (await this.catalog.list()).map((entry) => entry.runId);
    return shortRunIds(ids).get(runId) ?? runId.slice(5, 13);
  }
}

type ControlBody =
  | { kind: "pause"; reason?: string }
  | { kind: "resume" }
  | { kind: "stop"; reason?: string }
  | { kind: "stop-effect"; operationId: string; reason?: string }
  | { kind: "checkpoint-response"; checkpointId: string; challengeHash: string; value: JsonValue }
  | { kind: "approve"; approvalId: string; challengeHash: string }
  | { kind: "reject"; approvalId: string; challengeHash: string; reason?: string };

function enqueue(database: RunDatabase, ctx: ExtensionContext, body: ControlBody): void {
  const run = database.readRun();
  const request: ControlRequest = {
    requestId: `request_${crypto.randomBytes(16).toString("hex")}`,
    runId: run.runId,
    expectedRevision: run.revision,
    requestedAt: new Date().toISOString(),
    actor: `human:${safeActor(ctx.sessionManager.getSessionId() ?? "primary-session")}`,
    ...body,
  } as ControlRequest;
  database.enqueueControlRequest(request);
}

function activeCheckpoint(database: RunDatabase) {
  const run = database.readRun();
  const operation = run.currentOperationId ? database.readOperation(run.currentOperationId) : undefined;
  if (!operation || operation.kind !== "checkpoint") return undefined;
  return database.readHumanCheckpoint(deterministicSemanticId("checkpoint", run.runId, operation.path));
}

function activeApplyOperation(database: RunDatabase): OperationRecord {
  const run = database.readRun();
  const current = run.currentOperationId ? database.readOperation(run.currentOperationId) : undefined;
  if (current?.kind === "apply") return current;
  const operations = database.listOperations({ limit: 1_000 }).filter((operation) => operation.kind === "apply" && operation.status === "waiting");
  if (operations.length !== 1) throw new Error("There is no unambiguous waiting apply operation");
  return operations[0]!;
}

function resolveOperation(database: RunDatabase, reference: string): OperationRecord {
  if (!reference || reference.includes("\0")) throw new Error("An exact operation id or path is required");
  const exact = reference.startsWith("operation_") ? database.readOperation(reference) : database.readOperationByPath(reference);
  if (exact) return exact;
  const matches = database.listOperations({ limit: 1_000 }).filter((operation) => (
    operation.operationId.startsWith(reference) || operation.path === reference
  ));
  if (matches.length !== 1) throw new Error(matches.length ? "Operation reference is ambiguous" : "Unknown operation reference");
  return matches[0]!;
}

function deletionToken(summary: WorkflowRunSummary): string {
  return stableHash({
    kind: "delete-workflow-run",
    runId: summary.runId,
    revision: summary.revision,
    workflowId: summary.workflowId,
    status: summary.status,
    resultDigest: summary.result?.digest ?? null,
  });
}

function safeActor(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return normalized || "primary-session";
}
