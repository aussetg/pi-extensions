import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLiveProgressProjector } from "../src/agents/live-progress.js";
import { RunDatabase } from "../src/persistence/run-database.js";
import type {
  AgentProgress,
  AgentSessionRecord,
  ArtifactRecord,
  AttemptRecord,
  OperationRecord,
  RunRecord,
} from "../src/runtime/durable-types.js";
import { sha256 } from "../src/utils/hashes.js";

const NOW = "2026-07-01T12:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("live agent progress", () => {
  it("projects automatic state, bounded recent results, and immediate artifact links without changing control", async () => {
    const fixture = createFixture();
    const projector = new AgentLiveProgressProjector(fixture.database);
    let sequence = 0;
    const event = (type: string, fields: Record<string, unknown> = {}, seconds = ++sequence) => ({
      type,
      executionId: fixture.executionId,
      operationId: fixture.operationId,
      attemptId: fixture.attemptId,
      sequence,
      at: later(seconds),
      ...fields,
    }) as any;

    await projector.emit(event("model-start", { model: "test/model", turn: 1 }), {
      cpuUsec: 120,
      ioReadBytes: 40,
      ioWriteBytes: 60,
      memoryCurrentBytes: 4_096,
      memoryPeakBytes: 8_192,
      tasksCurrent: 4,
      tasksPeak: 6,
    });
    await projector.emit(event("assistant-text", { text: "private-delta-must-not-enter-semantic-state" }), {
      cpuUsec: 130,
    });
    await projector.emit(event("tool-start", { toolCallId: "tool-1", toolName: "read", input: { path: "README.md" } }));
    expect(fixture.database.readAgentSession(fixture.agentSessionId)?.progress).toMatchObject({
      currentTool: "read",
      toolCount: 1,
    });
    await projector.emit(event("tool-end", { toolCallId: "tool-1", toolName: "read", isError: false }));
    await projector.emit(event("model-end", {
      turn: 1,
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 10,
        cacheWriteTokens: 2,
        providerRequests: 1,
        cost: 0.05,
        elapsedMs: 900,
        complete: true,
      },
    }));
    await projector.emit(event("workspace-change", {
      treeHash: sha256("changed-tree"),
      changedPaths: ["src/main.ts", "tests/main.test.ts"],
    }));
    await projector.emit(event("provider-retry", { delayMs: 20, message: "retry" }));
    // A reopened physical worker restarts its local turn numbering. The
    // durable projection counts logical model starts across those cycles.
    await projector.emit(event("model-start", { model: "test/model", turn: 1 }));
    await projector.emit(event("model-end", { turn: 1 }));

    commitVisible(fixture, "report_progress", "progress-1", {
      type: "report",
      message: "Checking durable projection",
      current: 2,
      total: 3,
      metrics: [{ name: "findings", value: 7, unit: "count" }],
    }, (current) => ({
      ...current,
      message: "Checking durable projection",
      current: 2,
      total: 3,
      metrics: [{ name: "findings", value: 7, unit: "count" }],
      updatedAt: later(10),
    }));
    commitVisible(fixture, "log_result", "log-1", {
      type: "log",
      message: `durable finding: ${"x".repeat(1_200)}`,
    });

    const artifact = artifactRecord(fixture.runId);
    fixture.database.registerArtifact(fixture.database.readRun().revision, artifact, {
      type: "agent-artifact-stored",
      operationId: fixture.operationId,
      attemptId: fixture.attemptId,
      payload: { digest: artifact.digest },
      at: later(12),
    });
    const ref = { digest: artifact.digest, kind: artifact.kind, mediaType: artifact.mediaType, bytes: artifact.bytes };
    commitVisible(fixture, "publish_artifact", "artifact-1", {
      type: "artifact",
      artifact: ref,
      name: "analysis",
    }, undefined, { artifact: ref });

    // Invisible lifecycle history after the log/artifact must not make the
    // recent inspector query walk transcript-sized history.
    for (let index = 0; index < 80; index += 1) {
      await projector.emit(event(index % 2 ? "compaction-start" : "compaction-end", index % 2 ? {} : { summaryBytes: 20 }));
    }

    const [live] = fixture.database.projectActiveAgentProgress({ now: new Date(later(120)), recentLimit: 3 });
    expect(live).toMatchObject({
      elapsedMs: 120_000,
      session: {
        status: "running",
        progress: {
          message: "Checking durable projection",
          current: 2,
          total: 3,
          metrics: [{ name: "findings", value: 7, unit: "count" }],
          usage: { inputTokens: 100, outputTokens: 25, providerRequests: 1, cost: 0.05 },
          modelTurn: 2,
          toolCount: 1,
          retries: 1,
          workspaceChanged: true,
          workspaceChangeCount: 1,
          recentWorkspaceChanges: ["src/main.ts", "tests/main.test.ts"],
          resources: {
            cpuUsec: 130,
            ioReadBytes: 40,
            ioWriteBytes: 60,
            memoryCurrentBytes: 4_096,
            memoryPeakBytes: 8_192,
            tasksCurrent: 4,
            tasksPeak: 6,
          },
        },
      },
      recent: [
        { type: "report", messagePreview: "Checking durable projection", current: 2, total: 3 },
        { type: "log" },
        { type: "artifact", name: "analysis", artifact: ref },
      ],
    });
    expect(live!.recent[1]!.messagePreview).toHaveLength(1_000);
    expect(Object.fromEntries(live!.automaticMetrics.map((metric) => [metric.name, metric.value]))).toMatchObject({
      elapsed_ms: 120_000,
      model_turn: 2,
      tool_count: 1,
      retries: 1,
      workspace_changes: 1,
      "usage.input_tokens": 100,
      "cgroup.cpu_usec": 130,
      "cgroup.memory_current_bytes": 4_096,
      "cgroup.processes_current": 4,
    });

    const durableProgress = fixture.database.listAgentProgress(fixture.agentSessionId, { limit: 256 });
    expect(durableProgress).toHaveLength(92);
    expect(JSON.stringify(durableProgress)).not.toContain("private-delta-must-not-enter-semantic-state");
    expect(fixture.database.listOperations()).toEqual([expect.objectContaining({ operationId: fixture.operationId, status: "running" })]);
    expect(fixture.database.listWorkflowCalls()).toEqual([]);
    expect(fixture.database.readAgentSession(fixture.agentSessionId)?.finish).toBeUndefined();

    const raw = new DatabaseSync(fixture.database.databasePath, { readOnly: true });
    const plans = raw.prepare(`
      EXPLAIN QUERY PLAN
      SELECT sequence, at, type, event_json FROM agent_progress_history
      WHERE agent_session_id = ? AND visible = 1 ORDER BY sequence DESC LIMIT ?
    `).all(fixture.agentSessionId, 3) as Array<{ detail: string }>;
    expect(plans.some((plan) => plan.detail.includes("agent_progress_visible_recent"))).toBe(true);
    raw.close();
    fixture.database.close();
  });

  it("rejects unbounded current text and scalar values before durable state changes", () => {
    const fixture = createFixture();
    const before = fixture.database.readRun().revision;
    const current = fixture.database.readAgentSession(fixture.agentSessionId)!.progress;
    expect(() => fixture.database.commitAgentProgressTool({
      expectedRevision: before,
      agentSessionId: fixture.agentSessionId,
      executionId: fixture.executionId,
      toolCallId: "oversized-progress",
      toolName: "report_progress",
      requestHash: sha256("oversized-progress"),
      response: { recorded: true },
      committedAt: later(1),
      progress: { ...current, message: "x".repeat(1_001), metrics: [], updatedAt: later(1) },
      progressEvent: { type: "report", message: "x".repeat(1_001) },
    })).toThrow(/progress message/i);
    expect(() => fixture.database.commitAgentProgressTool({
      expectedRevision: before,
      agentSessionId: fixture.agentSessionId,
      executionId: fixture.executionId,
      toolCallId: "oversized-metric",
      toolName: "report_progress",
      requestHash: sha256("oversized-metric"),
      response: { recorded: true },
      committedAt: later(1),
      progress: { ...current, metrics: [{ name: "huge", value: 1e16 }], updatedAt: later(1) },
      progressEvent: { type: "report", message: "bounded", metrics: [{ name: "huge", value: 1e16 }] },
    })).toThrow(/metric value/i);
    expect(fixture.database.readRun().revision).toBe(before);
    expect(fixture.database.listAgentProgress(fixture.agentSessionId)).toEqual([]);
    fixture.database.close();
  });
});

function commitVisible(
  fixture: ReturnType<typeof createFixture>,
  toolName: "report_progress" | "log_result" | "publish_artifact",
  toolCallId: string,
  progressEvent: Parameters<RunDatabase["commitAgentProgressTool"]>[0]["progressEvent"],
  update: (current: AgentProgress) => AgentProgress = (current) => ({ ...current, updatedAt: later(11) }),
  response: any = { recorded: true },
): void {
  const current = fixture.database.readAgentSession(fixture.agentSessionId)!.progress;
  const progress = update(current);
  fixture.database.commitAgentProgressTool({
    expectedRevision: fixture.database.readRun().revision,
    agentSessionId: fixture.agentSessionId,
    executionId: fixture.executionId,
    toolCallId,
    toolName,
    requestHash: sha256(`${toolName}:${toolCallId}`),
    response,
    committedAt: progress.updatedAt,
    progress,
    progressEvent,
  });
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-live-progress-"));
  roots.push(root);
  const runId = "flow_progress";
  const operationId = "operation-progress";
  const attemptId = "attempt-progress-1";
  const executionId = "execution-progress-1";
  const agentSessionId = "agent-session-progress";
  const database = RunDatabase.create(path.join(root, "run.sqlite"), { run: runRecord(runId) });
  const operation: OperationRecord = {
    operationId, runId, path: "run/agent:progress", sourceId: "progress", kind: "agent", ordinal: 0,
    status: "running", semanticInputHash: sha256("semantic"), attemptCount: 0,
    createdAt: NOW, startedAt: NOW, updatedAt: NOW,
  };
  database.insertOperation(1, operation, { type: "operation-started", operationId, payload: {}, at: NOW });
  const attempt: AttemptRecord = {
    attemptId, runId, operationId, number: 1, effect: "agent", executionId, status: "running",
    usage: zeroUsage(), outputArtifacts: [], startedAt: NOW, updatedAt: NOW,
  };
  database.insertAttempt(2, attempt, { type: "attempt-started", operationId, attemptId, payload: {}, at: NOW });
  const session: AgentSessionRecord = {
    agentSessionId, runId, operationId, profileId: "builtin:test", routeId: "route:test",
    piSessionPath: `sessions/${executionId}/session.jsonl`,
    workspace: { kind: "snapshot", workspaceId: "snapshot-progress", treeHash: sha256("tree") },
    network: "none", status: "running", receiptlessStrikes: 0, currentExecutionId: executionId,
    progress: {
      metrics: [], usage: zeroUsage(), modelTurn: 0, toolCount: 0, retries: 0,
      workspaceChanged: false, workspaceChangeCount: 0, recentWorkspaceChanges: [], updatedAt: NOW,
    },
    createdAt: NOW, updatedAt: NOW,
  };
  database.createAgentSession(3, session, { type: "agent-session-started", operationId, attemptId, payload: {}, at: NOW });
  return { root, runId, operationId, attemptId, executionId, agentSessionId, database };
}

function runRecord(runId: string): RunRecord {
  return {
    runId, revision: 1,
    workflow: {
      id: "builtin:test", name: "test", sourceHash: sha256("source"), definitionHash: sha256("definition"),
      capabilities: ["read-project"],
    },
    invocationHash: sha256("invocation"), projectSnapshotHash: sha256("project"),
    routeSnapshotHash: sha256("route"), contextIdentityHash: sha256("context"), status: "running",
    safety: {
      concurrency: 4, maximumAgentLaunches: 20, memoryBytes: 2 ** 30, tasks: 128,
      cpuQuotaPercent: 400, cpuWeight: 100, outputBytes: 8 * 1024 * 1024, commandTimeoutMs: 60_000,
    },
    usage: zeroUsage(), createdAt: NOW, startedAt: NOW, updatedAt: NOW,
  };
}

function artifactRecord(runId: string): ArtifactRecord {
  const digest = sha256("live artifact");
  return {
    digest, runId, kind: "agent-published", mediaType: "text/plain; charset=utf-8",
    bytes: 13, bodyPath: `artifacts/${digest}/body`, metadata: {}, createdAt: later(12),
  };
}

function zeroUsage() {
  return {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    providerRequests: 0, cost: 0, elapsedMs: 0, complete: true,
  };
}

function later(seconds: number): string {
  return new Date(Date.parse(NOW) + seconds * 1_000).toISOString();
}
