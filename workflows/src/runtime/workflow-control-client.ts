import crypto from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WorkflowRunCatalog, workflowShortRunIds, type WorkflowRunCatalogEntry } from "../persistence/run-catalog.js";
import { WorkflowRunDatabase } from "../persistence/run-database.js";
import type { JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { coordinatorUnitName } from "./coordinator-identity.js";
import { WorkflowCoordinatorAlreadyRunningError, WorkflowCoordinatorService } from "./coordinator-service.js";
import type { WorkflowDeletionChallenge, WorkflowHumanChallenge, WorkflowRunSummary } from "./named-workflow-types.js";

export class WorkflowControlClient {
  constructor(readonly catalog: WorkflowRunCatalog, readonly coordinator: WorkflowCoordinatorService) {}

  pause(runRef: string, ctx: ExtensionContext) { return this.simple(runRef, "pause", ctx); }
  resume(runRef: string, ctx: ExtensionContext) { return this.simple(runRef, "resume", ctx); }
  stop(runRef: string, ctx: ExtensionContext) { return this.simple(runRef, "stop", ctx); }

  async stopEffect(runRef: string, operationRef: string, ctx: ExtensionContext): Promise<WorkflowRunSummary> {
    const entry = await this.catalog.resolve(runRef);
    const database = WorkflowRunDatabase.open(entry.paths.database);
    try {
      const operation = resolveOperation(database, operationRef);
      this.enqueue(database, "stop-effect", ctx, { targetId: operation.operationId });
    } finally { database.close(); }
    await this.wake(entry);
    return await this.summary(entry);
  }

  async humanChallenge(runRef: string, kind: "ask" | "apply", _ctx: ExtensionContext): Promise<WorkflowHumanChallenge> {
    const entry = await this.catalog.resolve(runRef);
    const database = WorkflowRunDatabase.open(entry.paths.database);
    try {
      const interactions = database.listWaitingHumanInteractions().filter(value => value.kind === kind);
      if (interactions.length !== 1) throw new Error(`There is no unambiguous waiting workflow ${kind}`);
      const interaction = interactions[0]!;
      return {
        summary: await this.summaryFrom(database),
        interactionId: interaction.interactionId,
        operationId: interaction.operationId,
        kind,
        token: interaction.challengeHash,
        request: structuredClone(interaction.request),
      };
    } finally { database.close(); }
  }

  async respond(
    runRef: string,
    interactionId: string | undefined,
    challenge: string,
    value: JsonValue,
    ctx: ExtensionContext,
  ): Promise<WorkflowRunSummary> {
    const entry = await this.catalog.resolve(runRef);
    const database = WorkflowRunDatabase.open(entry.paths.database);
    try {
      const interaction = interactionId
        ? database.readHumanInteraction(interactionId)
        : database.listWaitingHumanInteractions().find(item => item.kind === "ask");
      if (!interaction || interaction.kind !== "ask" || interaction.status !== "waiting") throw new Error("There is no matching waiting workflow ask");
      if (interaction.challengeHash !== challenge) throw new Error("Workflow ask challenge is stale");
      this.enqueue(database, "ask-response", ctx, {
        targetId: interaction.interactionId, challengeHash: challenge, value,
      });
    } finally { database.close(); }
    await this.wake(entry);
    return await this.summary(entry);
  }

  async decideApproval(
    runRef: string,
    decision: "approve" | "reject",
    challenge: string,
    ctx: ExtensionContext,
  ): Promise<WorkflowRunSummary> {
    const entry = await this.catalog.resolve(runRef);
    const database = WorkflowRunDatabase.open(entry.paths.database);
    try {
      const interaction = database.listWaitingHumanInteractions().find(item => item.kind === "apply");
      if (!interaction || interaction.challengeHash !== challenge) throw new Error("Workflow apply challenge is stale");
      this.enqueue(database, decision === "approve" ? "apply-approve" : "apply-reject", ctx, {
        targetId: interaction.interactionId, challengeHash: challenge,
      });
    } finally { database.close(); }
    await this.wake(entry);
    return await this.summary(entry);
  }

  async deletionChallenge(runRef: string, _ctx: ExtensionContext): Promise<WorkflowDeletionChallenge> {
    const entry = await this.catalog.resolve(runRef);
    const database = WorkflowRunDatabase.open(entry.paths.database);
    try {
      const summary = await this.summaryFrom(database);
      if (!new Set(["completed", "failed", "stopped"]).has(summary.status)) throw new Error("Workflow run is not terminal");
      return { summary, token: stableHash({ formatVersion: 1, kind: "run-deletion", runId: summary.runId, revision: summary.revision }) };
    } finally { database.close(); }
  }

  async deleteRun(runRef: string, challenge: string, ctx: ExtensionContext): Promise<void> {
    const prepared = await this.deletionChallenge(runRef, ctx);
    if (prepared.token !== challenge) throw new Error("Workflow deletion challenge is stale");
    const state = await this.coordinator.launcher.inspect(coordinatorUnitName(prepared.summary.runId));
    if (["active", "activating", "deactivating", "reloading"].includes(state.activeState)) throw new Error("Workflow coordinator is active");
    await this.catalog.delete(prepared.summary.runId);
  }

  private async simple(runRef: string, kind: "pause" | "resume" | "stop", ctx: ExtensionContext) {
    const entry = await this.catalog.resolve(runRef);
    const database = WorkflowRunDatabase.open(entry.paths.database);
    try { this.enqueue(database, kind, ctx); } finally { database.close(); }
    await this.wake(entry);
    return await this.summary(entry);
  }

  private enqueue(
    database: WorkflowRunDatabase,
    kind: Parameters<WorkflowRunDatabase["enqueueControlRequest"]>[0]["kind"],
    ctx: ExtensionContext,
    fields: { targetId?: string; challengeHash?: string; value?: JsonValue } = {},
  ): void {
    const run = database.readRun();
    database.enqueueControlRequest({
      requestId: `request_${crypto.randomBytes(16).toString("hex")}`,
      runId: run.runId,
      kind,
      ...fields,
      actor: `human:${safeActor(ctx.sessionManager.getSessionId() ?? "primary-session")}`,
      status: "pending",
      requestedAt: new Date().toISOString(),
    });
  }

  private async wake(entry: WorkflowRunCatalogEntry): Promise<void> {
    try { await this.coordinator.launch(entry.paths.root); }
    catch (error) { if (!(error instanceof WorkflowCoordinatorAlreadyRunningError)) throw error; }
  }

  private async summary(entry: WorkflowRunCatalogEntry): Promise<WorkflowRunSummary> {
    const database = WorkflowRunDatabase.open(entry.paths.database);
    try { return await this.summaryFrom(database); } finally { database.close(); }
  }

  private async summaryFrom(database: WorkflowRunDatabase): Promise<WorkflowRunSummary> {
    const run = database.readRun();
    const ids = (await this.catalog.list()).map(entry => entry.runId);
    return {
      runId: run.runId,
      shortRunId: workflowShortRunIds(ids).get(run.runId) ?? run.runId.slice(5, 13),
      workflowId: run.workflow.id,
      workflowName: run.workflow.name,
      status: run.status,
      revision: run.revision,
      ...(run.reason ? { reason: structuredClone(run.reason) } : {}),
      ...(run.currentOperationId ? { currentOperationId: run.currentOperationId } : {}),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    };
  }
}

function resolveOperation(database: WorkflowRunDatabase, reference: string) {
  const exact = reference.startsWith("operation_") ? database.readOperation(reference) : undefined;
  if (exact) return exact;
  const matches = database.listOperations({ limit: 10_000 }).filter(operation =>
    operation.operationId.startsWith(reference) || operation.path === reference);
  if (matches.length !== 1) throw new Error(matches.length ? "Operation reference is ambiguous" : "Unknown operation reference");
  return matches[0]!;
}

function safeActor(value: string): string {
  return Array.from(value.replace(/[^A-Za-z0-9._:@+-]/gu, "-")).slice(0, 128).join("") || "primary-session";
}
