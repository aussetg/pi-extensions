import type { WorkflowRunProjection } from "../projection/types.js";

export interface FlowForegroundCandidate {
  projection: WorkflowRunProjection;
  uiOwnerSessionId?: string;
  currentSessionId?: string;
  projectId?: string;
  currentProjectId?: string;
  awaitedToolActive?: boolean;
  launchedSequence?: number;
}

export interface FlowForegroundSelectionOptions { pinnedRunId?: string; }

const TERMINAL = new Set(["completed", "failed", "stopped"]);
const ATTENTION_PRIORITY: Record<string, number> = {
  approval: 0, "human-input": 1, workspace: 2, "agent-protocol": 3,
  provider: 4, safety: 5, infrastructure: 6, effect: 7, workflow: 8,
  replay: 9, control: 10,
};

/** Persistent pin first, then oldest actionable run, then newest active run. */
export function selectForegroundRun(
  candidates: readonly FlowForegroundCandidate[],
  options: FlowForegroundSelectionOptions = {},
): FlowForegroundCandidate | undefined {
  const eligible = candidates.filter(eligibleForUi);
  if (options.pinnedRunId) {
    const pinned = eligible.find((entry) => entry.projection.runId === options.pinnedRunId);
    if (pinned) return pinned;
  }
  const attention = eligible.filter(actionable).sort((left, right) => {
    const a = left.projection.attentionReasons[0]!;
    const b = right.projection.attentionReasons[0]!;
    return (ATTENTION_PRIORITY[a.category] ?? 99) - (ATTENTION_PRIORITY[b.category] ?? 99)
      || Date.parse(left.projection.updatedAt) - Date.parse(right.projection.updatedAt)
      || left.projection.runId.localeCompare(right.projection.runId);
  })[0];
  if (attention) return attention;
  return eligible.filter((entry) => !TERMINAL.has(entry.projection.status) && !entry.awaitedToolActive)
    .sort((left, right) => (right.launchedSequence ?? 0) - (left.launchedSequence ?? 0)
      || Date.parse(right.projection.createdAt) - Date.parse(left.projection.createdAt)
      || left.projection.runId.localeCompare(right.projection.runId))[0];
}

export function formatFlowAggregateStatus(candidates: readonly FlowForegroundCandidate[]): string | undefined {
  const active = candidates.filter(eligibleForUi).filter((entry) => !TERMINAL.has(entry.projection.status));
  if (!active.length) return undefined;
  const attention = active.filter(actionable).length;
  return `flow: ${active.length} active${attention ? ` · ${attention} needs action` : ""}`;
}

function actionable(candidate: FlowForegroundCandidate): boolean {
  return !TERMINAL.has(candidate.projection.status) && candidate.projection.attentionReasons.length > 0;
}

function eligibleForUi(candidate: FlowForegroundCandidate): boolean {
  if (candidate.uiOwnerSessionId && candidate.currentSessionId && candidate.uiOwnerSessionId !== candidate.currentSessionId) return false;
  return !(candidate.projectId && candidate.currentProjectId && candidate.projectId !== candidate.currentProjectId);
}
