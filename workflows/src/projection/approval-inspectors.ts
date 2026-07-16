import type { WorkflowDraftPromotionChallenge, WorkflowDraftReviewRecord } from "../drafts/types.js";
import type {
  ApplyPlanRecord,
  ApprovalRecord,
  RunRecord,
  VerificationRecord,
} from "../runtime/durable-types.js";
import { boundedProjectionText } from "./run-projection.js";
import {
  WORKFLOW_PROJECTION_LIMITS as LIMITS,
  type WorkflowApplyApprovalInspectorProjection,
  type WorkflowDraftPromotionProjection,
  type WorkflowDraftValidationProjection,
} from "./types.js";

export function projectDraftValidation(review: WorkflowDraftReviewRecord): WorkflowDraftValidationProjection {
  return {
    formatVersion: 1,
    draftId: review.draftId,
    namespace: review.namespace,
    name: review.name,
    valid: review.valid,
    source: {
      draftHash: review.sourceHash,
      installedHash: review.installedSourceHash,
      targetPath: boundedProjectionText(review.targetPath, 4_096),
      changed: review.sourceDiff.changed,
      diffPreview: boundedProjectionText(review.sourceDiff.preview, 40_000),
      truncated: review.sourceDiff.truncated,
    },
    reviewHash: review.reviewHash,
    capabilities: {
      declared: [...review.capabilities.declared],
      derived: [...review.capabilities.derived],
    },
    profiles: review.profiles.map((profile) => ({
      id: profile.id,
      profileHash: profile.profileHash,
      routeId: profile.routeId,
      routeHash: profile.routeHash,
    })),
    commandProfiles: [...review.commandProfiles],
    operations: structuredClone(review.operations),
    diagnostics: structuredClone(review.diagnostics),
  };
}

export function projectDraftPromotion(
  review: WorkflowDraftReviewRecord,
  challenge: WorkflowDraftPromotionChallenge,
): WorkflowDraftPromotionProjection {
  if (
    challenge.draftId !== review.draftId
    || challenge.draftHash !== review.sourceHash
    || challenge.installedSourceHash !== review.installedSourceHash
    || challenge.reviewHash !== review.reviewHash
    || challenge.targetNamespace !== review.namespace
    || challenge.targetPath !== review.targetPath
  ) throw new Error("Draft promotion challenge does not bind the exact review");
  return {
    formatVersion: 1,
    validation: projectDraftValidation(review),
    challenge: structuredClone(challenge),
  };
}

export function projectApplyApproval(
  run: RunRecord,
  approval: ApprovalRecord,
  plan: ApplyPlanRecord,
  verification: VerificationRecord,
): WorkflowApplyApprovalInspectorProjection {
  if (
    approval.runId !== run.runId
    || approval.kind !== "apply"
    || approval.operationId !== plan.operationId
    || approval.approvalId !== plan.approvalId
    || approval.challenge.challengeHash !== plan.challengeHash
    || approval.challenge.bindingHash !== plan.bindingHash
    || plan.verificationId !== verification.verificationId
    || plan.candidateId !== verification.candidateId
    || plan.candidateTreeHash !== verification.candidateTreeHash
    || plan.candidateLineageHash !== verification.candidateLineageHash
    || plan.candidateWriteScopeHash !== verification.candidateWriteScopeHash
    || plan.verificationProfileHash !== verification.profileHash
    || plan.gateEnvironmentHash !== verification.gateEnvironmentHash
  ) throw new Error("Apply approval inspector evidence is not exactly bound");
  return {
    formatVersion: 1,
    runId: run.runId,
    revision: run.revision,
    approvalId: approval.approvalId,
    operationId: approval.operationId,
    status: approval.status,
    ...(approval.decision ? { decision: approval.decision } : {}),
    challengeHash: approval.challenge.challengeHash,
    bindingHash: approval.challenge.bindingHash,
    summaryArtifact: structuredClone(approval.challenge.summary),
    candidate: {
      id: plan.candidateId,
      treeHash: plan.candidateTreeHash,
      lineageHash: plan.candidateLineageHash,
      writeScopeHash: plan.candidateWriteScopeHash,
    },
    verification: {
      id: verification.verificationId,
      profileHash: verification.profileHash,
      environmentHash: verification.gateEnvironmentHash,
      status: verification.status,
    },
    paths: {
      count: plan.paths.length,
      preview: plan.paths.slice(0, LIMITS.changedPathPreview).map((entry) => entry.path),
    },
    requestedAt: approval.requestedAt,
    ...(approval.resolvedAt ? { resolvedAt: approval.resolvedAt } : {}),
  };
}
