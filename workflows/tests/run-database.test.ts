import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentSessionRecord,
  ArtifactRecord,
  AttemptRecord,
  OperationRecord,
  RunRecord,
} from "../src/runtime/durable-types.js";
import {
  RunDatabase,
  RunDatabaseReader,
  RunDatabaseStateError,
  RunDatabaseVersionError,
  RunRevisionConflictError,
} from "../src/persistence/run-database.js";
import { sha256, stableHash } from "../src/utils/hashes.js";
import { buildWorkflowCallKey } from "../src/persistence/workflow-journal.js";
import { readWorkflowRunProjection } from "../src/projection/run-projection.js";

const temporaryDirectories: string[] = [];
const NOW = "2026-04-01T12:00:00.000Z";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("run SQLite database", () => {
  it("creates and reopens the one-row version-3 WAL database", () => {
    const databasePath = runDatabasePath();
    const database = RunDatabase.create(databasePath, { run: runRecord() });

    expect(database.configuration()).toEqual({
      schemaVersion: 3,
      journalMode: "wal",
      foreignKeys: true,
      synchronous: 2,
      busyTimeoutMs: 5_000,
    });
    expect(database.readRun()).toEqual(runRecord());
    expect(database.listEvents()).toEqual([{
      runId: "flow_test",
      sequence: 1,
      revision: 1,
      type: "run-created",
      payload: {},
      at: NOW,
    }]);
    database.close();

    const reopened = RunDatabase.open(databasePath);
    expect(reopened.readRun()).toEqual(runRecord());
    expect(readWorkflowRunProjection(reopened, { now: new Date(NOW) })).toMatchObject({
      revision: 1,
      status: "queued",
      operationCounts: {},
      activeAgents: [],
      pendingControlRequests: 0,
      latestEventSequence: 1,
    });
    reopened.close();
    expect(() => RunDatabase.create(databasePath, { run: runRecord() })).toThrow();
    const preserved = RunDatabase.open(databasePath);
    expect(preserved.readRun().runId).toBe("flow_test");
    preserved.close();
  });

  it("serializes state transitions with run-revision compare-and-swap", () => {
    const databasePath = runDatabasePath();
    const first = RunDatabase.create(databasePath, { run: runRecord() });
    const contender = RunDatabase.open(databasePath);

    const running = first.transitionRun(1, {
      status: "running",
      startedAt: later(1),
      event: transitionEvent("run-started", 1),
    });
    expect(running).toMatchObject({ revision: 2, status: "running", startedAt: later(1), updatedAt: later(1) });
    expect(() => contender.transitionRun(1, {
      status: "paused",
      event: transitionEvent("run-paused", 2),
    })).toThrow(RunRevisionConflictError);
    expect(contender.readRun()).toMatchObject({ revision: 2, status: "running" });

    first.close();
    contender.close();
  });

  it("atomically completes an effect with artifacts, usage, checkpoint, journal, progress reset, event, and revision", () => {
    const database = RunDatabase.create(runDatabasePath(), { run: { ...runRecord(), status: "running" } });
    const operation = operationRecord();
    database.insertOperation(1, operation, {
      ...transitionEvent("operation-started", 1),
      operationId: operation.operationId,
    });
    const attempt = attemptRecord();
    database.insertAttempt(2, attempt, {
      ...transitionEvent("attempt-started", 2),
      operationId: operation.operationId,
      attemptId: attempt.attemptId,
    });
    const session = agentSessionRecord();
    database.createAgentSession(3, session, {
      ...transitionEvent("agent-session-started", 3),
      operationId: operation.operationId,
      attemptId: attempt.attemptId,
    });

    const artifact = artifactRecord();
    const workspace = {
      kind: "candidate" as const,
      workspaceId: "candidate_test",
      treeHash: sha256("tree-after"),
      lineageHash: sha256("lineage"),
      writeScopeHash: stableHash("all-semantic-project-paths"),
    };
    database.registerCandidateWorkspace(4, {
      workspaceId: workspace.workspaceId,
      runId: "flow_test",
      logicalId: "run/candidate:test",
      workspace,
      writeScope: "all-semantic-project-paths",
      rootPath: "workspaces/candidates/candidate_test/project",
      createdAt: later(4),
    }, {
      ...transitionEvent("candidate-workspace-created", 4),
      operationId: operation.operationId,
    });
    const result = { value: { answer: 42 }, artifacts: [artifactRef(artifact)], workspace };
    const previousJournalKey = sha256("journal-root");
    const semanticKey = sha256("semantic-call");
    const callKey = buildWorkflowCallKey({ previousJournalKey, operation, semanticKey });
    const completed = database.completeOperation({
      expectedRevision: 5,
      operationId: operation.operationId,
      attemptId: attempt.attemptId,
      completedAt: later(4),
      result,
      artifacts: [artifact],
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        providerRequests: 1,
        cost: 0.25,
        elapsedMs: 700,
        complete: true,
      },
      resources: { cpuUsec: 100, memoryPeakBytes: 2_048 },
      workspaceCheckpoint: {
        checkpointId: "workspace_checkpoint_test",
        runId: "flow_test",
        operationId: operation.operationId,
        workspace,
        storagePath: "workspaces/checkpoints/workspace_checkpoint_test",
        createdAt: later(4),
      },
      journal: {
        runId: "flow_test",
        operationId: operation.operationId,
        ordinal: 0,
        previousJournalKey,
        semanticKey,
        callKey,
        completionAuthority: "finish-work",
        replayPolicy: "workspace",
        result,
        postWorkspaceCheckpointId: "workspace_checkpoint_test",
        committedAt: later(4),
      },
      event: { type: "operation-completed", payload: { durable: true } },
    });

    expect(completed).toMatchObject({
      status: "completed",
      attemptCount: 1,
      result: { value: { answer: 42 }, artifacts: [artifactRef(artifact)], workspace },
    });
    expect(database.readAttempt(attempt.attemptId)).toMatchObject({
      status: "completed",
      postWorkspaceCheckpointId: "workspace_checkpoint_test",
      outputArtifacts: [artifactRef(artifact)],
      usage: { inputTokens: 10, outputTokens: 4, complete: true },
      resources: { cpuUsec: 100, memoryPeakBytes: 2_048 },
      endedAt: later(4),
    });
    expect(database.readRun()).toMatchObject({
      revision: 6,
      status: "running",
      usage: { inputTokens: 10, outputTokens: 4, cost: 0.25, elapsedMs: 700, complete: true },
    });
    expect(database.readRun().currentOperationId).toBeUndefined();
    expect(database.readAgentSession(session.agentSessionId)).toMatchObject({
      status: "completed",
      progress: {
        metrics: [],
        usage: zeroUsage(),
        modelTurn: 0,
        toolCount: 0,
        retries: 0,
        workspaceChanged: false,
        workspaceChangeCount: 0,
        recentWorkspaceChanges: [],
        updatedAt: later(4),
      },
    });
    expect(database.listArtifacts()).toEqual([artifact]);
    expect(database.listEvents().map((event) => [event.sequence, event.revision, event.type])).toEqual([
      [1, 1, "run-created"],
      [2, 2, "operation-started"],
      [3, 3, "attempt-started"],
      [4, 4, "agent-session-started"],
      [5, 5, "candidate-workspace-created"],
      [6, 6, "operation-completed"],
    ]);

    expect(() => database.completeOperation({
      expectedRevision: 6,
      operationId: operation.operationId,
      completedAt: later(5),
      result: { artifacts: [] },
      usage: zeroUsage(),
      event: { type: "operation-completed", payload: {} },
    })).toThrow(RunDatabaseStateError);
    expect(database.readRun().revision).toBe(6);
    database.close();
  });

  it("orders the durable command inbox and admits only one concurrent revision-bound request", () => {
    const databasePath = runDatabasePath();
    const first = RunDatabase.create(databasePath, { run: runRecord() });
    const second = RunDatabase.open(databasePath);
    const pause = {
      requestId: "request_pause",
      runId: "flow_test",
      expectedRevision: 1,
      requestedAt: later(1),
      actor: "human:test",
      kind: "pause" as const,
      reason: "inspect progress",
    };
    first.enqueueControlRequest(pause);
    expect(() => second.enqueueControlRequest({
      requestId: "request_stop",
      runId: "flow_test",
      expectedRevision: 1,
      requestedAt: later(2),
      actor: "human:test",
      kind: "stop",
    })).toThrow(RunRevisionConflictError);
    expect(second.listPendingControlRequests()).toEqual([pause]);

    const acknowledgement = second.acknowledgeControlRequest({
      requestId: pause.requestId,
      expectedRevision: 2,
      accepted: true,
      acknowledgedAt: later(3),
    });
    expect(acknowledgement).toEqual({
      requestId: pause.requestId,
      runId: "flow_test",
      accepted: true,
      revision: 3,
      acknowledgedAt: later(3),
    });
    expect(first.listPendingControlRequests()).toEqual([]);
    expect(first.readControlAcknowledgement(pause.requestId)).toEqual(acknowledgement);
    expect(first.listEvents().map((event) => event.type)).toEqual([
      "run-created",
      "control-requested",
      "control-acknowledged",
    ]);

    first.close();
    second.close();
  });

  it("lets a WAL reader keep a stable snapshot while another connection commits", () => {
    const databasePath = runDatabasePath();
    const writer = RunDatabase.create(databasePath, { run: runRecord() });
    const reader = RunDatabaseReader.open(databasePath);

    const observed = reader.readSnapshot((snapshot) => {
      const before = snapshot.readRun().revision;
      writer.transitionRun(1, {
        status: "running",
        event: transitionEvent("run-started", 1),
      });
      const after = snapshot.readRun().revision;
      return { before, after };
    });
    expect(observed).toEqual({ before: 1, after: 1 });
    expect(reader.readRun().revision).toBe(2);

    reader.close();
    writer.close();
  });

  it("reopens committed WAL state after the writer is killed without closing SQLite", async () => {
    const databasePath = runDatabasePath();
    RunDatabase.create(databasePath, { run: runRecord() }).close();
    const script = String.raw`
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
      db.prepare("UPDATE runs SET revision = 2, status = 'running', updated_at = ? WHERE singleton = 1 AND revision = 1").run('${later(1)}');
      db.prepare("INSERT INTO events(run_id, sequence, revision, type, payload_json, at) VALUES ('flow_test', 2, 2, 'child-committed', '{}', ?)").run('${later(1)}');
      db.exec('COMMIT');
      process.stdout.write('committed\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", script, databasePath], { stdio: ["ignore", "pipe", "pipe"] });
    await once(child.stdout!, "data");
    child.kill("SIGKILL");
    await once(child, "exit");

    const reopened = RunDatabase.open(databasePath);
    expect(reopened.readRun()).toMatchObject({ revision: 2, status: "running", updatedAt: later(1) });
    expect(reopened.listEvents().at(-1)).toMatchObject({ sequence: 2, revision: 2, type: "child-committed" });
    reopened.close();
  });

  it.each([0, 1, 2, 99])("rejects unknown schema version %i without modifying it", (version) => {
    const databasePath = runDatabasePath();
    const unknown = new DatabaseSync(databasePath);
    unknown.exec(`PRAGMA user_version = ${version}`);
    unknown.close();

    expect(() => RunDatabase.open(databasePath)).toThrow(RunDatabaseVersionError);
    expect(() => RunDatabaseReader.open(databasePath)).toThrow(RunDatabaseVersionError);
    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(version);
    check.close();
  });
});

function runDatabasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-database-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "run.sqlite");
}

function runRecord(): RunRecord {
  return {
    runId: "flow_test",
    revision: 1,
    workflow: {
      id: "builtin:test",
      name: "test",
      sourceHash: sha256("source"),
      definitionHash: sha256("definition"),
      capabilities: ["read-project", "candidate-write", "mediated-network"],
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
    usage: zeroUsage(),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function operationRecord(): OperationRecord {
  return {
    operationId: "operation_research",
    runId: "flow_test",
    path: "run/agent:research",
    sourceId: "research",
    kind: "agent",
    ordinal: 0,
    status: "running",
    semanticInputHash: sha256("semantic-input"),
    callKey: sha256("call"),
    attemptCount: 0,
    createdAt: later(1),
    startedAt: later(1),
    updatedAt: later(1),
  };
}

function attemptRecord(): AttemptRecord {
  return {
    attemptId: "attempt_research_1",
    runId: "flow_test",
    operationId: "operation_research",
    number: 1,
    effect: "agent",
    executionId: "execution_research_1",
    status: "running",
    preWorkspace: {
      kind: "candidate",
      workspaceId: "candidate_test",
      treeHash: sha256("tree-before"),
      lineageHash: sha256("lineage"),
      writeScopeHash: sha256("scope"),
    },
    usage: zeroUsage(),
    outputArtifacts: [],
    startedAt: later(2),
    updatedAt: later(2),
  };
}

function agentSessionRecord(): AgentSessionRecord {
  return {
    agentSessionId: "agent_session_research",
    runId: "flow_test",
    operationId: "operation_research",
    profileId: "builtin:researcher",
    routeId: "route:researcher",
    piSessionPath: "sessions/execution_research_1/session.jsonl",
    workspace: {
      kind: "candidate",
      workspaceId: "candidate_test",
      treeHash: sha256("tree-before"),
      lineageHash: sha256("lineage"),
      writeScopeHash: sha256("scope"),
    },
    network: "research",
    status: "running",
    receiptlessStrikes: 0,
    currentExecutionId: "execution_research_1",
    progress: {
      message: "Inspecting sources",
      current: 1,
      total: 3,
      metrics: [{ name: "files", value: 12, unit: "count" }],
      usage: zeroUsage(),
      modelTurn: 2,
      currentTool: "read",
      toolCount: 3,
      retries: 0,
      workspaceChanged: true,
      workspaceChangeCount: 1,
      recentWorkspaceChanges: ["src/index.ts"],
      resources: { memoryCurrentBytes: 1_024 },
      updatedAt: later(3),
    },
    createdAt: later(3),
    updatedAt: later(3),
  };
}

function artifactRecord(): ArtifactRecord {
  return {
    digest: sha256("artifact body"),
    runId: "flow_test",
    kind: "agent-output",
    mediaType: "application/json",
    bytes: Buffer.byteLength("artifact body"),
    bodyPath: `artifacts/${sha256("artifact body")}/body`,
    metadata: { schema: "answer", nested: { stable: true } },
    createdAt: later(4),
  };
}

function artifactRef(record: ArtifactRecord) {
  return { digest: record.digest, kind: record.kind, mediaType: record.mediaType, bytes: record.bytes };
}

function zeroUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    providerRequests: 0,
    cost: 0,
    elapsedMs: 0,
    complete: true,
  };
}

function transitionEvent(type: string, seconds: number) {
  return { type, payload: {}, at: later(seconds) };
}

function later(seconds: number): string {
  return new Date(Date.parse(NOW) + seconds * 1_000).toISOString();
}
