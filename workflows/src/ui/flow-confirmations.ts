import type {
  WorkflowDraftPromotionProjection,
  WorkflowRunProjection,
} from "../projection/types.js";
import { boundedProjectionText } from "../projection/run-projection.js";
import { truncateToWidth } from "../utils/truncate.js";

/** Exact human-readable binding shown immediately before draft installation. */
export function renderDraftPromotionConfirmation(
  promotion: WorkflowDraftPromotionProjection,
  width = 100,
): readonly string[] {
  const { validation, challenge } = promotion;
  return bound([
    `Promote ${validation.draftId} → ${validation.source.targetPath}`,
    `draft      ${challenge.draftHash}`,
    `installed  ${challenge.installedSourceHash ?? "none"}`,
    `review     ${challenge.reviewHash}`,
    `challenge  ${challenge.challengeHash}`,
    `authority  ${validation.capabilities.declared.join(", ") || "none"}`,
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
  const apply = projection.apply;
  if (!apply || apply.status !== "waiting") throw new Error("Run has no waiting apply approval");
  if (apply.challenge.challengeHash !== challengeToken) throw new Error("Apply challenge does not match the projected approval");
  return bound([
    `${decision === "approve" ? "Apply" : "Reject"} ${projection.workflowId} · run ${projection.shortRunId} · revision ${projection.revision}`,
    `operation    ${apply.operationId}`,
    `approval     ${apply.approvalId}`,
    `challenge    ${apply.challenge.challengeHash}`,
    `binding      ${apply.challenge.bindingHash}`,
    `candidate    ${apply.candidateId}`,
    `tree         ${apply.candidateTreeHash}`,
    `lineage      ${apply.candidateLineageHash}`,
    `write scope  ${apply.candidateWriteScopeHash}`,
    `verification ${apply.verificationId} · ${apply.verificationProfileHash}`,
    `summary      ${apply.challenge.summary.digest} · ${apply.challenge.summary.bytes} bytes`,
    `paths        ${apply.changedPathCount}${apply.changedPathPreview.length ? ` · ${apply.changedPathPreview.join(", ")}` : ""}`,
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
    ? `${projection.workflowId} (${projection.shortRunId}) · ${projection.status} · r${projection.revision}${projection.attentionReasons[0] ? ` · ${projection.attentionReasons[0].summary}` : ""}`
    : value.error?.message ?? value.message;
  return truncateToWidth(safe(message, 2_048), Math.max(1, Math.trunc(width)));
}

function bound(lines: string[], width: number, maximumRows: number): readonly string[] {
  const safeWidth = Math.max(20, Math.trunc(width));
  return Object.freeze(lines.flatMap((line) => line.split("\n")).slice(0, maximumRows).map((line) => truncateToWidth(safe(line, 40_000), safeWidth)));
}
function safe(value: unknown, maximum: number): string { return boundedProjectionText(value, maximum); }
