import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunDatabase, RunDatabaseReader } from "../src/persistence/run-database.js";
import { projectApplyApproval, projectDraftPromotion } from "../src/projection/approval-inspectors.js";
import { readWorkflowInspectorPage } from "../src/projection/inspector-pages.js";
import { buildWorkflowRunProjection, type WorkflowRunProjectionSource } from "../src/projection/run-projection.js";
import { readWorkflowRunProjection } from "../src/projection/run-projection.js";
import type { AgentLiveProgressProjection, OperationRecord, RunRecord, RunStatus } from "../src/runtime/durable-types.js";
import { sha256, stableHash } from "../src/utils/hashes.js";

const roots: string[] = [];
const NOW = "2026-06-01T12:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("uniform workflow run projection", () => {
  it("covers the final queued, running, waiting, paused, replay, and terminal states", () => {
    const queued = projection("queued");
    expect(queued.status).toBe("queued");
    expect(queued.phaseTree[0]).toMatchObject({ kind: "stage", status: "queued" });

    const running = projection("running", { operations: [operation("running")] });
    expect(running.phaseTree[0]?.status).toBe("running");

    const richAgent = liveAgent(0, "running");
    const progress = projection("running", { activeAgents: [richAgent] });
    expect(progress.activeAgents[0]).toMatchObject({
      progress: { message: "Reviewing parser edge cases", current: 3, total: 5 },
      currentTool: "workspace_command",
      customMetrics: [{ name: "tests", value: 41, unit: "passed" }],
      automaticMetrics: [{ name: "elapsed", value: 1200, unit: "ms" }],
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    expect(progress.activeAgents[0]?.recentLogs).toHaveLength(1);
    expect(progress.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, providerRequests: 2 });

    const human = projection("waiting", { checkpoints: [checkpoint()] });
    expect(human.attentionReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "human-input", code: "checkpoint-waiting" }),
    ]));

    const approval = projection("waiting", { approval: applyApproval() });
    expect(approval.attentionReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "approval", code: "apply-approval-waiting" }),
    ]));

    const strikes = projection("paused", { activeAgents: [liveAgent(3, "paused")] });
    expect(strikes.attentionReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "agent-protocol", code: "receiptless-three-strikes" }),
    ]));

    const provider = projection("paused", { run: run("paused", {
      category: "provider", code: "provider-backoff", summary: "Provider retry after 30 seconds", retryable: true,
    }) });
    expect(provider.attentionReasons[0]).toMatchObject({ category: "provider", code: "provider-backoff" });

    const replayOperation = { ...operation("completed"), replay: {
      sourceRunId: "flow_source", sourceOperationId: "operation_source", ordinal: 0,
      callKey: sha256("call"), restoredWorkspaceCheckpointId: "checkpoint_restore",
    } };
    const replay = projection("running", {
      run: { ...run("running"), replay: {
        mode: "cross-revision-prefix", sourceRunId: "flow_source", matchedCalls: 1,
        firstMissOrdinal: 1, firstMissReason: "call-key-mismatch", fresh: false,
      } },
      operations: [replayOperation],
    });
    expect(replay.replay).toMatchObject({ matchedCalls: 1, firstMissOrdinal: 1 });
    expect(replay.phaseTree[0]?.replay).toMatchObject({ ordinal: 0, workspaceRestored: true });

    expect(projection("failed").attentionReasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: "run-failed" })]));
    expect(projection("stopped").attentionReasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: "run-stopped" })]));
    expect(projection("completed").attentionReasons).toEqual([]);
  });

  it("is transport-neutral bounded plain data", () => {
    const value = projection("running", { activeAgents: [liveAgent(0, "running")] });
    const rpc = JSON.parse(JSON.stringify(value));
    const headless = JSON.parse(JSON.stringify(value));
    expect(rpc).toEqual(headless);
    expect(JSON.stringify(value)).not.toContain("\\u001b");
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(256 * 1024);
  });

  it("binds draft inspector summaries to the exact source and challenge", () => {
    const review: any = {
      formatVersion: 1, draftId: "user:demo", namespace: "user", name: "demo",
      sourceHash: sha256("draft"), targetPath: "/tmp/demo.flow.js", installedSourceHash: sha256("installed"),
      valid: true, sourceDiff: { installedSourceHash: sha256("installed"), draftSourceHash: sha256("draft"), changed: true, preview: "+ change", truncated: false },
      capabilities: { declared: ["read-project"], derived: ["read-project"] }, profiles: [], commandProfiles: [], measurementProfiles: [], verificationProfiles: [],
      authority: { candidateWrite: false, mediatedNetwork: false, hostCommand: false, humanInput: false, applySites: 0 },
      operations: { staticSites: 1, byMethod: { stage: 1 }, dynamicSites: { loops: 0, parallel: 0, fanOut: 0 }, hostAdmissionLimit: 10 },
      definitionControlLoad: "passed", diagnostics: [], reviewHash: sha256("review"),
    };
    const challenge: any = {
      formatVersion: 1, draftId: review.draftId, draftHash: review.sourceHash, targetNamespace: "user",
      targetPath: review.targetPath, installedSourceHash: review.installedSourceHash,
      reviewHash: review.reviewHash, challengeHash: sha256("challenge"),
    };
    expect(projectDraftPromotion(review, challenge)).toMatchObject({
      validation: { source: { draftHash: review.sourceHash, installedHash: review.installedSourceHash } },
      challenge: { challengeHash: challenge.challengeHash },
    });
    expect(() => projectDraftPromotion(review, { ...challenge, draftHash: sha256("other") })).toThrow(/exact review/);
  });

  it("binds apply approval inspector data to exact candidate and verification evidence", () => {
    const approval = applyApproval();
    const plan: any = {
      planId: "plan_1", runId: approval.runId, operationId: approval.operationId,
      candidateId: "candidate_1", candidateTreeHash: sha256("tree"), candidateLineageHash: sha256("lineage"), candidateWriteScopeHash: sha256("scope"),
      verificationId: "verification_1", verificationProfileHash: sha256("profile"), gateEnvironmentHash: sha256("environment"),
      bindingHash: approval.challenge.bindingHash, approvalId: approval.approvalId, challengeHash: approval.challenge.challengeHash,
      paths: [{ path: "src/parser.ts" }],
    };
    const verification: any = {
      verificationId: plan.verificationId, candidateId: plan.candidateId, candidateTreeHash: plan.candidateTreeHash,
      candidateLineageHash: plan.candidateLineageHash, candidateWriteScopeHash: plan.candidateWriteScopeHash,
      profileHash: plan.verificationProfileHash, gateEnvironmentHash: plan.gateEnvironmentHash, status: "passed",
    };
    expect(projectApplyApproval(run("waiting"), approval, plan, verification)).toMatchObject({
      challengeHash: approval.challenge.challengeHash,
      candidate: { id: "candidate_1", treeHash: plan.candidateTreeHash },
      verification: { id: "verification_1", status: "passed" },
      paths: { count: 1, preview: ["src/parser.ts"] },
    });
    expect(() => projectApplyApproval(run("waiting"), approval, plan, { ...verification, profileHash: sha256("other") })).toThrow(/exactly bound/);
  });
});

describe("indexed inspector pages", () => {
  it("uses keyset cursors and never returns more than the requested page", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-projection-"));
    roots.push(root);
    const databasePath = path.join(root, "run.sqlite");
    const database = RunDatabase.create(databasePath, { run: run("queued") });
    for (let ordinal = 0; ordinal < 80; ordinal++) {
      const record = operation("queued", ordinal);
      database.insertOperation(database.readRun().revision, record, {
        type: "operation-queued", operationId: record.operationId, payload: {}, at: NOW,
      });
    }
    database.close();
    const reader = RunDatabaseReader.open(databasePath);
    const overview = readWorkflowRunProjection(reader, { shortRunId: "01234567", now: new Date(NOW) });
    expect(overview.phaseTree.length).toBeLessThanOrEqual(128);
    expect(overview.operationCounts).toEqual({ queued: 80 });
    const first = readWorkflowInspectorPage(reader, "operations", { limit: 7 });
    const second = readWorkflowInspectorPage(reader, "operations", { limit: 7, cursor: first.nextCursor });
    expect(first.entries).toHaveLength(7);
    expect(second.entries).toHaveLength(7);
    expect((first.entries as any[]).map((entry) => entry.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect((second.entries as any[])[0]?.ordinal).toBe(7);
    expect(first.bytes).toBeLessThanOrEqual(256 * 1024);
    expect(readWorkflowInspectorPage(reader, "events", { limit: 5 }).entries).toHaveLength(5);
    expect(readWorkflowInspectorPage(reader, "logs", { limit: 5 }).entries).toEqual([]);
    expect(readWorkflowInspectorPage(reader, "artifacts", { limit: 5 }).entries).toEqual([]);
    expect(readWorkflowInspectorPage(reader, "measurements", { limit: 5 }).entries).toEqual([]);
    expect(() => readWorkflowInspectorPage(reader, "events", { cursor: first.nextCursor })).toThrow(/another page/);
    reader.close();
  });
});

function projection(status: RunStatus, overrides: Partial<WorkflowRunProjectionSource> = {}) {
  const base: WorkflowRunProjectionSource = {
    run: run(status),
    shortRunId: "abcd1234",
    operationCounts: { [status]: 1 },
    operationTotal: 1,
    operations: [operation(status)],
    activeAgents: [],
    checkpoints: [],
    metrics: [],
    artifacts: [],
    pendingControlRequests: 0,
    latestEventSequence: 1,
  };
  return buildWorkflowRunProjection({ ...base, ...overrides });
}

function run(status: RunStatus, reason?: RunRecord["reason"]): RunRecord {
  return {
    runId: "flow_0123456789abcdef0123456789abcdef",
    revision: 1,
    workflow: { id: "builtin:research", name: "research", sourceHash: sha256("source"), definitionHash: sha256("definition"), capabilities: ["read-project"] },
    invocationHash: sha256("invocation"), projectSnapshotHash: sha256("project"), routeSnapshotHash: sha256("route"), contextIdentityHash: sha256("context"),
    status, ...(reason ? { reason } : {}),
    safety: { concurrency: 4, maximumAgentLaunches: 100, memoryBytes: 1024, tasks: 32, cpuQuotaPercent: 100, cpuWeight: 100, outputBytes: 1024, commandTimeoutMs: 1000 },
    usage: usage(), createdAt: NOW, updatedAt: NOW,
  };
}

function operation(status: RunStatus, ordinal = 0): OperationRecord {
  return {
    operationId: `operation_${ordinal}`, runId: "flow_0123456789abcdef0123456789abcdef",
    path: `run/stage:${ordinal}`, sourceId: `stage-${ordinal}`, kind: "stage", ordinal, status,
    semanticInputHash: stableHash({ ordinal }), attemptCount: 0, createdAt: NOW, updatedAt: NOW,
  };
}

function liveAgent(strikes: number, status: RunStatus): AgentLiveProgressProjection {
  return {
    session: {
      agentSessionId: "agent_session_1", runId: "flow_0123456789abcdef0123456789abcdef", operationId: "operation_0",
      profileId: "builtin:implementer", routeId: "local:default", piSessionPath: "sessions/execution_1/session.jsonl",
      workspace: { kind: "candidate", workspaceId: "candidate_1", treeHash: sha256("tree"), lineageHash: sha256("lineage"), writeScopeHash: sha256("scope") },
      network: "research", status, receiptlessStrikes: strikes, currentExecutionId: "execution_1",
      progress: {
        message: "Reviewing parser edge cases", current: 3, total: 5,
        metrics: [{ name: "tests", value: 41, unit: "passed" }], usage: { ...usage(), inputTokens: 100, outputTokens: 20, providerRequests: 2 },
        modelTurn: 4, currentTool: "workspace_command", toolCount: 7, retries: 1,
        workspaceChanged: true, workspaceChangeCount: 2, recentWorkspaceChanges: ["src/parser.ts"], updatedAt: NOW,
      },
      createdAt: NOW, updatedAt: NOW,
    },
    elapsedMs: 1200,
    automaticMetrics: [{ name: "elapsed", value: 1200, unit: "ms" }],
    recent: [{ sequence: 2, type: "log", at: NOW, messagePreview: "Parser tests now pass" }],
  };
}

function checkpoint(): any {
  return {
    checkpointId: "checkpoint_1", runId: "flow_0123456789abcdef0123456789abcdef", operationId: "operation_0",
    status: "waiting", request: { kind: "confirm", prompt: "Continue with deployment?" }, challengeHash: sha256("checkpoint"),
    requestedRevision: 1, requestedAt: NOW,
  };
}

function applyApproval(): any {
  return {
    approvalId: "approval_1", runId: "flow_0123456789abcdef0123456789abcdef", operationId: "operation_0",
    kind: "apply", status: "waiting", challenge: { challengeHash: sha256("challenge"), runRevision: 1, bindingHash: sha256("binding"), summary: artifact() }, requestedAt: NOW,
  };
}

function artifact() { return { digest: sha256("artifact"), kind: "summary", mediaType: "application/json" as const, bytes: 2 }; }
function usage() { return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, providerRequests: 0, cost: 0, elapsedMs: 0, complete: true }; }
