import type { WorkflowRunProjection } from "../projection/types.js";
import { boundedWorkflowProjectionText } from "../projection/run-projection.js";
import { truncateToWidth } from "../utils/truncate.js";

/** Exact human-readable binding shown immediately before draft installation. */
export function renderDraftPromotionConfirmation(
  promotion: ReturnType<typeof import("../projection/approval-inspectors.js")["projectWorkflowDraftPromotion"]>,
  width = 100,
): readonly string[] {
  const { validation, challenge } = promotion;
  return bound([
    `Promote ${validation.draftId} → ${validation.source.targetPath} (${challenge.targetExposure})`,
    `draft      ${challenge.draftHash}`,
    `installed  ${challenge.installedSourceHash ?? "none"}`,
    `review     ${challenge.reviewHash}`,
    `challenge  ${challenge.challengeHash}`,
    `authority  ${validation.capabilities.join(", ") || "none"}`,
    `profiles   ${validation.profiles.map((entry) => entry.id).join(", ") || "none"}`,
    `commands   ${validation.commandProfiles.join(", ") || "none"}`,
    `operations ${validation.operations.staticSites} static · host limit ${validation.operations.hostAdmissionLimit}`,
    validation.source.changed ? validation.source.diffPreview.replace(/ ↵ /g, "\n") : "No source change.",
  ], width, 96);
}

/** Exact apply binding. Approval text is derived from the same run projection as RPC. */
export function renderApplyApprovalConfirmation(
  projection: WorkflowRunProjection,
  challengeToken: string,
  decision: "approve" | "reject" = "approve",
  width = 100,
): readonly string[] {
  const apply = projection.humanInteractions.find(item => item.kind === "apply" && item.status === "waiting");
  if (!apply) throw new Error("Run has no waiting apply approval");
  return bound([
    `${decision === "approve" ? "Apply" : "Reject"} ${projection.workflowId} · run ${projection.shortRunId} · revision ${projection.revision}`,
    `operation    ${apply.operationId}`,
    `approval     ${apply.approvalId}`,
    `challenge    ${challengeToken}`,
    decision === "approve"
      ? "This exact verified delta changes working-tree files only."
      : "The candidate and verification remain as durable evidence.",
  ], width, 64);
}

export function renderFlowCommandFeedback(
  value: { ok: boolean; message: string; projection?: WorkflowRunProjection; error?: { message: string } },
  width = 120,
): string {
  const projection = value.projection;
  const message = projection
    ? `${projection.workflowId} (${projection.shortRunId}) · ${projection.status} · r${projection.revision}${projection.attention[0] ? ` · ${projection.attention[0].summary}` : ""}`
    : value.error?.message ?? value.message;
  return truncateToWidth(safe(message, 2_048), Math.max(1, Math.trunc(width)));
}

function bound(lines: string[], width: number, maximumRows: number): readonly string[] {
  const safeWidth = Math.max(20, Math.trunc(width));
  return Object.freeze(lines.flatMap((line) => line.split("\n")).slice(0, maximumRows).map((line) => truncateToWidth(safe(line, 40_000), safeWidth)));
}
function safe(value: unknown, maximum: number): string { return boundedWorkflowProjectionText(value, maximum); }
