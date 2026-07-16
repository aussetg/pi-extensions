import { describe, expect, it } from "vitest";
import type { WorkflowRunProjection } from "../src/projection/types.js";
import { renderApplyApprovalConfirmation, renderDraftPromotionConfirmation } from "../src/ui/flow-confirmations.js";
import { FlowInspectorComponent, renderWorkflowInspectorText } from "../src/ui/flow-inspector.js";
import { selectForegroundRun } from "../src/ui/flow-selection.js";
import { AwaitedFlowToolComponent, renderWorkflowToolText } from "../src/ui/flow-tool-renderer.js";
import { FlowWidgetComponent, renderFlowWidgetLines, renderWorkflowRunText } from "../src/ui/flow-widget.js";
import { visibleWidth } from "../src/utils/truncate.js";

const NOW = "2026-06-01T12:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;

const FIXTURES: Record<string, WorkflowRunProjection> = {
  queued: fixture("queued"),
  running: fixture("running"),
  progress: fixture("running", { activeAgents: [agent()], artifacts: [{ digest: HASH, kind: "test-report", mediaType: "application/json", bytes: 412 }] }),
  checkpoint: fixture("waiting", {
    checkpoints: [{ checkpointId: "checkpoint_1", operationId: "operation_1", status: "waiting", request: { kind: "choice", title: "Release", prompt: "Choose the deployment region", choices: [{ id: "eu", label: "Europe" }, { id: "us", label: "United States" }] }, challengeHash: HASH, requestedRevision: 7, requestedAt: NOW }],
    attentionReasons: [{ category: "human-input", code: "checkpoint-waiting", summary: "Choose the deployment region", retryable: true, operationId: "operation_1" }],
  }),
  approval: fixture("waiting", { apply: apply(), attentionReasons: [{ category: "approval", code: "apply-approval-waiting", summary: "apply requires an exact human decision", retryable: true, operationId: "operation_1" }] }),
  threeStrikes: fixture("paused", { activeAgents: [agent({ status: "paused", receiptlessStrikes: 3 })], attentionReasons: [{ category: "agent-protocol", code: "receiptless-three-strikes", summary: "Agent paused after three clean receiptless yields", retryable: true, operationId: "operation_1" }] }),
  providerBackoff: fixture("paused", { attentionReasons: [{ category: "provider", code: "provider-backoff", summary: "Provider retry after 30 seconds", retryable: true }] }),
  replay: fixture("running", { replay: { mode: "cross-revision-prefix", sourceRunId: "flow_source", matchedCalls: 4, firstMissOrdinal: 5, firstMissReason: "call-key-mismatch", fresh: false } }),
  failed: fixture("failed", { attentionReasons: [{ category: "workflow", code: "run-failed", summary: "Verification failed", retryable: false }] }),
  stopped: fixture("stopped", { attentionReasons: [{ category: "control", code: "run-stopped", summary: "Workflow was stopped", retryable: false }] }),
  completed: fixture("completed", { phaseTree: [operation("completed")], operationCounts: { completed: 1 } }),
};

describe("Phase 28 workflow rendering", () => {
  it("snapshots every Phase 27 state at narrow, normal, and wide widths", () => {
    const rendered = Object.fromEntries(Object.entries(FIXTURES).map(([name, projection]) => [name, Object.fromEntries(
      [[36, "narrow"], [68, "normal"], [112, "wide"]].map(([width, label]) => [label, {
        widget: renderFlowWidgetLines(projection, undefined, width as number),
        inspector: renderWorkflowInspectorText(projection, undefined, width as number).slice(0, width === 112 ? 14 : 9),
      }]),
    )]));
    expect(rendered).toMatchSnapshot();
    for (const views of Object.values(rendered) as any[]) for (const view of Object.values(views) as any[]) {
      const width = view === views.narrow ? 36 : view === views.normal ? 68 : 112;
      for (const line of [...view.widget, ...view.inspector]) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("keeps high-frequency updates bounded and reuses stable render caches", () => {
    const projection = FIXTURES.progress!;
    const component = new FlowWidgetComponent(projection);
    const first = component.render(80);
    component.update({ ...projection, revision: projection.revision + 1, latestEventSequence: projection.latestEventSequence + 100 });
    expect(component.render(80)).toBe(first);
    expect(first.length).toBeLessThanOrEqual(5);

    const tool = new AwaitedFlowToolComponent({ projection }, { isPartial: true });
    const toolFirst = tool.render(80);
    tool.update({ projection: { ...projection, revision: projection.revision + 1 } }, { isPartial: true });
    expect(tool.render(80)).toBe(toolFirst);
  });

  it("preserves a pinned focus across projection replacement", () => {
    const running = FIXTURES.running!;
    const waiting = FIXTURES.checkpoint!;
    const candidates = [{ projection: running, launchedSequence: 2 }, { projection: waiting, launchedSequence: 1 }];
    expect(selectForegroundRun(candidates)?.projection.runId).toBe(waiting.runId);
    expect(selectForegroundRun(candidates, { pinnedRunId: running.runId })?.projection.runId).toBe(running.runId);
    expect(selectForegroundRun([{ projection: { ...running, revision: 99 } }, candidates[1]!], { pinnedRunId: running.runId })?.projection.revision).toBe(99);

    const inspector = new FlowInspectorComponent({} as any, waiting.runId, waiting, {} as any);
    inspector.handleInput("\x1b[B");
    inspector.updateProjection({ ...waiting, revision: 8, attentionReasons: [
      { category: "provider", code: "provider-backoff", summary: "Retrying provider", retryable: true },
      ...waiting.attentionReasons,
    ] });
    expect(inspector.render(100).find((line) => line.startsWith("› checkpoint"))).toBeDefined();
  });

  it("keeps RPC/headless adapters plain, detached, and immutable", () => {
    const projection = FIXTURES.progress!;
    const widget = renderWorkflowRunText(projection);
    const tool = renderWorkflowToolText(projection, { expanded: true });
    const inspector = renderWorkflowInspectorText(structuredClone(projection), undefined, 100);
    expect(Object.isFrozen(widget)).toBe(true);
    expect(Object.isFrozen(tool)).toBe(true);
    expect(JSON.stringify([widget, tool, inspector])).not.toContain("\u001b");
    expect(JSON.stringify([widget, tool, inspector])).not.toContain("driver");
  });

  it("renders exact draft and apply confirmation bindings", () => {
    const draft: any = {
      formatVersion: 1,
      validation: { formatVersion: 1, draftId: "user:demo", namespace: "user", name: "demo", valid: true, source: { draftHash: HASH, installedHash: null, targetPath: "/workflows/demo.flow.js", changed: true, diffPreview: "+ flow.stage()", truncated: false }, reviewHash: HASH, capabilities: { declared: ["read-project"], derived: ["read-project"] }, profiles: [{ id: "builtin:researcher", profileHash: HASH, routeId: "default", routeHash: HASH }], commandProfiles: [], operations: { staticSites: 1, byMethod: { stage: 1 }, dynamicSites: { loops: 0, parallel: 0, fanOut: 0 }, hostAdmissionLimit: 100 }, diagnostics: [] },
      challenge: { challengeHash: HASH, draftHash: HASH, installedSourceHash: null, reviewHash: HASH, targetNamespace: "user", targetPath: "/workflows/demo.flow.js" },
    };
    const confirmations = {
      draft: { narrow: renderDraftPromotionConfirmation(draft, 48), wide: renderDraftPromotionConfirmation(draft, 112) },
      apply: { narrow: renderApplyApprovalConfirmation(FIXTURES.approval!, HASH, "approve", 48), wide: renderApplyApprovalConfirmation(FIXTURES.approval!, HASH, "approve", 112) },
    };
    expect(confirmations).toMatchSnapshot();
    expect(confirmations.draft.wide.join("\n")).toContain(`challenge  ${HASH}`);
    expect(confirmations.apply.wide.join("\n")).toContain("candidate    candidate_1");
    expect(() => renderApplyApprovalConfirmation(FIXTURES.approval!, `sha256:${"b".repeat(64)}`)).toThrow(/does not match/);
  });
});

function fixture(status: WorkflowRunProjection["status"], overrides: Partial<WorkflowRunProjection> = {}): WorkflowRunProjection {
  return {
    formatVersion: 1, runId: `flow_${status.padEnd(32, "0")}`, shortRunId: status.slice(0, 8), workflowId: "builtin:coding", workflowName: "Verified coding", revision: 7, status,
    createdAt: NOW, startedAt: NOW, updatedAt: NOW,
    usage: { inputTokens: 12_500, outputTokens: 3_200, cacheReadTokens: 900, cacheWriteTokens: 0, providerRequests: 5, cost: 0.42, elapsedMs: 83_000, complete: true },
    safety: { concurrency: 4, maximumAgentLaunches: 100 }, operationCounts: { [status]: 1 }, phaseTree: [operation(status)], phaseOperationOmittedCount: 0,
    recentOperations: status === "completed" || status === "failed" || status === "stopped" ? [operation(status)] : [], activeAgents: [], checkpoints: [], metrics: [], artifacts: [], attentionReasons: [], pendingControlRequests: 0, latestEventSequence: 17,
    ...overrides,
  };
}

function operation(status: WorkflowRunProjection["status"]): WorkflowRunProjection["phaseTree"][number] {
  return { operationId: "operation_1", path: "run/stage:implement/agent:coder", sourceId: "coder", kind: "agent", ordinal: 1, depth: 1, status, attemptCount: 1, outputArtifacts: [], outputArtifactOmittedCount: 0, createdAt: NOW, updatedAt: NOW };
}

function agent(overrides: Partial<WorkflowRunProjection["activeAgents"][number]> = {}): WorkflowRunProjection["activeAgents"][number] {
  return {
    agentSessionId: "agent_session_1", operationId: "operation_1", profileId: "builtin:implementer", routeId: "local:default", status: "running",
    workspace: { kind: "candidate", workspaceId: "workspace_1", treeHash: HASH }, network: "research", receiptlessStrikes: 0, executionId: "execution_1",
    progress: { message: "Reviewing parser edge cases", current: 3, total: 5 }, customMetrics: [{ name: "tests", value: 41, unit: "passed" }], automaticMetrics: [{ name: "elapsed", value: 83, unit: "s" }], currentTool: "workspace_command", modelTurn: 4, toolCount: 7, retries: 1,
    usage: { inputTokens: 4_000, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0, providerRequests: 2, cost: 0.1, elapsedMs: 32_000, complete: false },
    resources: { cpuUsec: 3_500_000, ioReadBytes: 1_048_576, ioWriteBytes: 524_288, memoryCurrentBytes: 268_435_456, memoryPeakBytes: 402_653_184, tasksCurrent: 12 }, workspaceChanged: true, workspaceChangeCount: 2, recentWorkspaceChanges: ["src/parser.ts"], recentLogs: [{ sequence: 2, type: "artifact", at: NOW, messagePreview: "Parser tests now pass", artifact: { digest: HASH, kind: "test-report", mediaType: "application/json", bytes: 412 } }], elapsedMs: 83_000, updatedAt: NOW,
    ...overrides,
  };
}

function apply(): NonNullable<WorkflowRunProjection["apply"]> {
  return { operationId: "operation_1", planId: "plan_1", approvalId: "approval_1", status: "waiting", challenge: { challengeHash: HASH, runRevision: 7, bindingHash: HASH, summary: { digest: HASH, kind: "apply-summary", mediaType: "application/json", bytes: 412 } }, candidateId: "candidate_1", candidateTreeHash: HASH, candidateLineageHash: HASH, candidateWriteScopeHash: HASH, verificationId: "verification_1", verificationProfileHash: HASH, changedPathCount: 2, changedPathPreview: ["src/parser.ts", "tests/parser.test.ts"] };
}
