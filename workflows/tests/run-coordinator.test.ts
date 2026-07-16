import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { RunCatalog } from "../src/persistence/run-catalog.js";
import { RunDatabase, RunDatabaseReader } from "../src/persistence/run-database.js";
import { StructuredWorkflowRegistry } from "../src/registry/structured-workflows.js";
import type {
  ArtifactRecord,
  HumanCheckpointRecord,
  OperationRecord,
  RunRecord,
} from "../src/runtime/durable-types.js";
import {
  assertCoordinatorProcessIdentity,
  coordinatorUnitName,
} from "../src/runtime/coordinator-identity.js";
import {
  CoordinatorAlreadyRunningError,
  CoordinatorService,
} from "../src/runtime/coordinator-service.js";
import { RunCoordinator } from "../src/runtime/run-coordinator.js";
import { NamedWorkflowService } from "../src/runtime/named-workflow-service.js";
import { SystemdUserUnitLauncher } from "../src/systemd/launcher.js";
import { sha256 } from "../src/utils/hashes.js";

const roots: string[] = [];
const units = new Set<string>();
const systemd = new SystemdUserUnitLauncher();

afterEach(async () => {
  await Promise.all([...units].map((unit) => systemd.stop(unit, 250).catch(() => undefined)));
  units.clear();
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeWritable(root).catch(() => undefined);
    await fs.promises.rm(root, { recursive: true, force: true });
  }));
});

describe("per-run coordinator core", () => {
  it("claims only its exact deterministic systemd identity", () => {
    const runId = `flow_${"a".repeat(32)}`;
    const unit = coordinatorUnitName(runId);
    expect(unit).toBe(`pi-workflow-coordinator-${"a".repeat(32)}.service`);
    expect(assertCoordinatorProcessIdentity(runId, {
      expectedUnit: unit,
      invocationId: "b".repeat(32),
      cgroupText: `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}\n`,
    })).toBe(unit);
    expect(() => assertCoordinatorProcessIdentity(runId, {
      expectedUnit: unit,
      invocationId: "b".repeat(32),
      cgroupText: "0::/user.slice/other.service\n",
    })).toThrow(/not running/i);
  });

  it("polls SQLite controls through stop-effect, pause, resume, shutdown, and stop", async () => {
    const fixture = await runFixture();
    const first = runCore(fixture.runDir);
    await waitForRun(fixture.databasePath, (run) => run.status === "running");

    const database = RunDatabase.open(fixture.databasePath);
    const operation = insertOperation(database, "effect", "agent", 0);
    enqueue(database, { kind: "stop-effect", operationId: operation.operationId, reason: "replace it" });
    await waitForAck(fixture.databasePath, "request_stop_effect");
    expect(database.readOperation(operation.operationId)).toMatchObject({
      status: "stopped",
      reason: { code: "effect-stopped", operationId: operation.operationId },
    });

    enqueue(database, { kind: "pause", reason: "inspect" });
    expect(await first).toMatchObject({ status: "paused", exit: "settled", processedControlRequests: 2 });
    expect(database.readRun()).toMatchObject({ status: "paused", reason: { code: "paused" } });

    enqueue(database, { kind: "resume" }, "request_resume_1");
    const second = runCore(fixture.runDir);
    await waitForRun(fixture.databasePath, (run) => run.status === "running");
    enqueue(database, { kind: "shutdown" });
    expect(await second).toMatchObject({ status: "paused", exit: "shutdown", processedControlRequests: 2 });

    enqueue(database, { kind: "resume" }, "request_resume_2");
    const third = runCore(fixture.runDir);
    await waitForRun(fixture.databasePath, (run) => run.status === "running");
    enqueue(database, { kind: "stop", reason: "done" });
    expect(await third).toMatchObject({ status: "stopped", exit: "settled", processedControlRequests: 2 });
    expect(database.listPendingControlRequests()).toEqual([]);
    database.close();
  });

  it("turns a crash-left running operation into explicit paused interruption evidence", async () => {
    const fixture = await runFixture();
    const database = RunDatabase.open(fixture.databasePath);
    const operation = insertOperation(database, "stale", "command", 0);
    database.close();

    const outcome = await runCore(fixture.runDir);
    expect(outcome).toMatchObject({ status: "paused", openDisposition: "stale-effects-settled" });
    const reader = RunDatabaseReader.open(fixture.databasePath);
    expect(reader.readRun()).toMatchObject({
      status: "paused",
      reason: { category: "infrastructure", code: "coordinator-interrupted" },
    });
    expect(reader.readOperation(operation.operationId)).toMatchObject({
      status: "paused",
      reason: { code: "coordinator-interrupted" },
    });
    reader.close();
  });

  it("validates and atomically resolves challenge-bound checkpoint responses", async () => {
    const fixture = await runFixture();
    const database = RunDatabase.open(fixture.databasePath);
    const operation = insertOperation(database, "review", "checkpoint", 0);
    const challengeHash = sha256("checkpoint:review");
    const checkpoint: HumanCheckpointRecord = {
      checkpointId: "checkpoint_review",
      runId: fixture.runId,
      operationId: operation.operationId,
      status: "waiting",
      request: {
        kind: "choice",
        prompt: "Continue?",
        choices: [{ id: "yes", label: "Continue" }, { id: "no", label: "Stop" }],
      },
      challengeHash,
      requestedRevision: database.readRun().revision + 1,
      requestedAt: now(),
    };
    database.createHumanCheckpoint(database.readRun().revision, checkpoint, event("checkpoint-requested"));

    enqueue(database, {
      kind: "checkpoint-response",
      checkpointId: checkpoint.checkpointId,
      challengeHash: sha256("stale"),
      value: "yes",
    });
    const rejected = await runCore(fixture.runDir);
    expect(rejected.status).toBe("waiting");
    expect(database.readControlAcknowledgement("request_checkpoint_response")).toMatchObject({
      accepted: false,
      reason: { code: "challenge-mismatch" },
    });

    enqueue(database, {
      kind: "checkpoint-response",
      checkpointId: checkpoint.checkpointId,
      challengeHash,
      value: "yes",
    }, "request_checkpoint_response_valid");
    const resumed = runCore(fixture.runDir);
    await waitForRun(fixture.databasePath, (run) => run.status === "running");
    expect(database.readHumanCheckpoint(checkpoint.checkpointId)).toMatchObject({
      status: "completed",
      response: "yes",
    });
    enqueue(database, { kind: "stop" });
    await resumed;
    database.close();
  });

  it("consumes exact human apply approval and rejects concurrent command CAS", async () => {
    const fixture = await runFixture();
    const database = RunDatabase.open(fixture.databasePath);
    const operation = insertOperation(database, "apply", "apply", 0);
    const summary = artifact(fixture.runId, "approval summary");
    database.registerArtifact(database.readRun().revision, summary, event("approval-summary"));
    const challengeHash = sha256("approval:apply");
    seedWaitingApproval(fixture.databasePath, fixture.runId, operation.operationId, summary.digest, challengeHash, database.readRun().revision);

    const contender = RunDatabase.open(fixture.databasePath);
    const expectedRevision = database.readRun().revision;
    database.enqueueControlRequest({
      requestId: "request_approve",
      runId: fixture.runId,
      expectedRevision,
      requestedAt: now(),
      actor: "human:test",
      kind: "approve",
      approvalId: "approval_apply",
      challengeHash,
    });
    expect(() => contender.enqueueControlRequest({
      requestId: "request_racing_stop",
      runId: fixture.runId,
      expectedRevision,
      requestedAt: now(),
      actor: "human:test",
      kind: "stop",
    })).toThrow(/revision changed/i);

    const active = runCore(fixture.runDir);
    await waitForRun(fixture.databasePath, (run) => run.status === "running");
    expect(database.readApproval("approval_apply")).toMatchObject({
      status: "completed",
      decision: "approved",
      actor: "human:test",
    });
    enqueue(database, { kind: "stop" });
    await active;
    contender.close();
    database.close();
  });

  it("consumes explicit apply rejection as a terminal human decision", async () => {
    const fixture = await runFixture();
    const database = RunDatabase.open(fixture.databasePath);
    const operation = insertOperation(database, "rejected_apply", "apply", 0);
    const summary = artifact(fixture.runId, "rejected approval summary");
    database.registerArtifact(database.readRun().revision, summary, event("approval-summary"));
    const challengeHash = sha256("approval:reject");
    seedWaitingApproval(fixture.databasePath, fixture.runId, operation.operationId, summary.digest, challengeHash, database.readRun().revision);
    database.enqueueControlRequest({
      requestId: "request_reject",
      runId: fixture.runId,
      expectedRevision: database.readRun().revision,
      requestedAt: now(),
      actor: "human:test",
      kind: "reject",
      approvalId: "approval_apply",
      challengeHash,
      reason: "not this candidate",
    });

    expect(await runCore(fixture.runDir)).toMatchObject({ status: "stopped", exit: "settled" });
    expect(database.readApproval("approval_apply")).toMatchObject({
      status: "completed",
      decision: "rejected",
      actor: "human:test",
    });
    expect(database.readOperation(operation.operationId)).toMatchObject({ status: "stopped" });
    database.close();
  });
});

describe("per-run coordinator systemd service", () => {
  it("executes a prepared workflow to completion in the durable service", async () => {
    const root = await fs.promises.mkdtemp(path.join(process.env.HOME ?? process.cwd(), "wf-pc-"));
    roots.push(root);
    const project = path.join(root, "project");
    const workflowsDir = path.join(project, ".pi", "workflows");
    await fs.promises.mkdir(workflowsDir, { recursive: true });
    await fs.promises.writeFile(path.join(workflowsDir, "coordinator-smoke.flow.js"), `
export default defineWorkflow({
  name: "coordinator-smoke",
  description: "Production coordinator smoke fixture.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["value"],
    properties: { value: { type: "string", minLength: 1, maxLength: 128 } },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["value"],
    properties: { value: { type: "string", minLength: 1, maxLength: 128 } },
  },
  capabilities: [],
  modelVisible: false,
  async run(_flow, args) { return { value: args.value }; },
});
`);
    const registry = new StructuredWorkflowRegistry();
    const coordinator = new CoordinatorService({ launcher: systemd });
    const service = new NamedWorkflowService({ getThinkingLevel: () => "off" } as any, {
      registry,
      catalog: new RunCatalog(path.join(root, "runs")),
      coordinator,
      pollIntervalMs: 25,
    });
    const ctx = {
      cwd: project,
      mode: "tui",
      signal: undefined,
      model: undefined,
      modelRegistry: { getAvailable: () => [] },
      isProjectTrusted: () => true,
      sessionManager: {
        getSessionId: () => "production-coordinator-test",
        getHeader: () => ({ id: "production-coordinator-test" }),
        getEntries: () => [],
      },
      ui: { notify: () => undefined },
    };

    const outcome = await service.invoke({
      name: "project:coordinator-smoke",
      args: { value: "durable" },
      mode: "await",
    }, "user", ctx as any);
    units.add(coordinatorUnitName(outcome.runId));

    expect(outcome).toMatchObject({ status: "completed", result: { value: "durable" }, handoff: false });
    const details = await service.open(outcome.runId, ctx as any);
    expect(details).toMatchObject({ status: "completed", workflowId: "project:coordinator-smoke" });
  }, 30_000);

  it("survives its launching extension, rejects duplicates, and recovers after SIGKILL", async () => {
    const fixture = await runFixture();
    const service = new CoordinatorService({
      launcher: systemd,
      entryPath: path.join(process.cwd(), "tests", "fixtures", "coordinator-inbox-entry.js"),
    });
    const launched = await service.launch(fixture.runDir);
    units.add(launched.unit);
    await waitForRun(fixture.databasePath, (run) => run.status === "running");

    await expect(service.launch(fixture.runDir)).rejects.toBeInstanceOf(CoordinatorAlreadyRunningError);
    expect((await systemd.inspect(launched.unit)).activeState).toBe("active");

    // The systemd-run helper belongs to the extension process; killing it
    // models an extension reload/exit without touching the service payload.
    if (launched.handle.helper.pid) process.kill(launched.handle.helper.pid, "SIGKILL");
    await delay(100);
    expect((await systemd.inspect(launched.unit)).activeState).toBe("active");

    const live = await waitForUnitMainPid(launched.unit);
    process.kill(live, "SIGKILL");
    await waitForUnitMainPid(launched.unit, live);
    await waitForRun(fixture.databasePath, (run) => run.status === "running");

    const database = RunDatabase.open(fixture.databasePath);
    enqueue(database, { kind: "stop" });
    await waitForRun(fixture.databasePath, (run) => run.status === "stopped");
    await waitForUnitInactive(launched.unit);
    database.close();
  }, 30_000);
});

async function runFixture() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "flow-coordinator-"));
  roots.push(root);
  const runId = `flow_${crypto.randomBytes(16).toString("hex")}`;
  const runDir = path.join(root, runId);
  await fs.promises.mkdir(runDir, { mode: 0o700 });
  const databasePath = path.join(runDir, "run.sqlite");
  RunDatabase.create(databasePath, { run: runRecord(runId) }).close();
  return { root, runId, runDir, databasePath };
}

function runRecord(runId: string): RunRecord {
  const createdAt = now();
  return {
    runId,
    revision: 1,
    workflow: {
      id: "builtin:test",
      name: "test",
      sourceHash: sha256("source"),
      definitionHash: sha256("definition"),
      capabilities: ["read-project", "human-input"],
    },
    invocationHash: sha256("invocation"),
    projectSnapshotHash: sha256("project"),
    routeSnapshotHash: sha256("routes"),
    contextIdentityHash: sha256("context"),
    status: "queued",
    safety: {
      concurrency: 4,
      maximumAgentLaunches: 1_000,
      memoryBytes: 2 ** 30,
      tasks: 256,
      cpuQuotaPercent: 400,
      cpuWeight: 100,
      outputBytes: 64 * 1024 * 1024,
      commandTimeoutMs: 60_000,
    },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      providerRequests: 0,
      cost: 0,
      elapsedMs: 0,
      complete: true,
    },
    createdAt,
    updatedAt: createdAt,
  };
}

function insertOperation(
  database: RunDatabase,
  id: string,
  kind: OperationRecord["kind"],
  ordinal: number,
): OperationRecord {
  const at = now();
  const operation: OperationRecord = {
    operationId: `operation_${id}`,
    runId: database.readRun().runId,
    path: `run/${kind}:${id}`,
    sourceId: id,
    kind,
    ordinal,
    status: "running",
    semanticInputHash: sha256(`input:${id}`),
    attemptCount: 0,
    createdAt: at,
    startedAt: at,
    updatedAt: at,
  };
  return database.insertOperation(database.readRun().revision, operation, {
    ...event("operation-started"),
    operationId: operation.operationId,
  });
}

type EnqueueInput =
  | { kind: "pause"; reason?: string }
  | { kind: "resume" }
  | { kind: "stop"; reason?: string }
  | { kind: "stop-effect"; operationId: string; reason?: string }
  | { kind: "checkpoint-response"; checkpointId: string; challengeHash: string; value: string }
  | { kind: "shutdown" };

function enqueue(database: RunDatabase, input: EnqueueInput, requestId = `request_${input.kind.replaceAll("-", "_")}`): void {
  database.enqueueControlRequest({
    requestId,
    runId: database.readRun().runId,
    expectedRevision: database.readRun().revision,
    requestedAt: now(),
    actor: "human:test",
    ...input,
  });
}

function event(type: string) {
  return { type, payload: {}, at: now() };
}

function artifact(runId: string, body: string): ArtifactRecord {
  const digest = sha256(body);
  return {
    digest,
    runId,
    kind: "approval-summary",
    mediaType: "application/json",
    bytes: Buffer.byteLength(body),
    bodyPath: `artifacts/${digest}/body`,
    metadata: {},
    createdAt: now(),
  };
}

function seedWaitingApproval(
  databasePath: string,
  runId: string,
  operationId: string,
  summaryDigest: string,
  challengeHash: string,
  revision: number,
): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    database.prepare(`
      INSERT INTO approvals(
        approval_id, run_id, operation_id, kind, status, challenge_hash,
        challenged_run_revision, binding_hash, summary_artifact_digest,
        decision, actor, requested_at, resolved_at
      ) VALUES ('approval_apply', ?, ?, 'apply', 'waiting', ?, ?, ?, ?, NULL, NULL, ?, NULL)
    `).run(runId, operationId, challengeHash, revision, sha256("binding"), summaryDigest, now());
    database.prepare("UPDATE operations SET status = 'waiting' WHERE operation_id = ?").run(operationId);
    database.prepare("UPDATE runs SET status = 'waiting', current_operation_id = ? WHERE singleton = 1").run(operationId);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve fixture error */ }
    throw error;
  } finally {
    database.close();
  }
}

function runCore(runDir: string) {
  return new RunCoordinator(runDir, { pollIntervalMs: 10, processIdentityCheck: false }).run();
}

async function waitForAck(databasePath: string, requestId: string): Promise<void> {
  await waitUntil(() => {
    const reader = RunDatabaseReader.open(databasePath);
    try { return reader.readControlAcknowledgement(requestId) !== undefined; } finally { reader.close(); }
  });
}

async function waitForRun(databasePath: string, predicate: (run: RunRecord) => boolean): Promise<void> {
  await waitUntil(() => predicate(readRun(databasePath)));
}

function readRun(databasePath: string): RunRecord {
  const reader = RunDatabaseReader.open(databasePath);
  try { return reader.readRun(); } finally { reader.close(); }
}

async function waitForUnitMainPid(unit: string, differentFrom?: number): Promise<number> {
  let pid: number | undefined;
  await waitUntil(async () => {
    pid = (await systemd.inspect(unit)).mainPid;
    return pid !== undefined && pid !== differentFrom;
  });
  return pid!;
}

async function waitForUnitInactive(unit: string): Promise<void> {
  await waitUntil(async () => !["active", "activating", "deactivating", "reloading"].includes((await systemd.inspect(unit)).activeState), 5_000);
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for coordinator fixture");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function now(): string {
  return new Date().toISOString();
}

async function makeWritable(root: string): Promise<void> {
  const stat = await fs.promises.lstat(root).catch(() => undefined);
  if (!stat || stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    await fs.promises.chmod(root, 0o600).catch(() => undefined);
    return;
  }
  await fs.promises.chmod(root, 0o700).catch(() => undefined);
  for (const name of await fs.promises.readdir(root).catch(() => [])) {
    await makeWritable(path.join(root, name));
  }
}

