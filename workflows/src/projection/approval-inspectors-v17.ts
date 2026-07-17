import type {
  WorkflowV17DraftPromotionChallenge,
  WorkflowV17DraftReviewRecord,
} from "../drafts/types-v17.js";
import { boundedWorkflowV17ProjectionText } from "./run-projection-v17.js";

export function projectWorkflowV17DraftReview(review: WorkflowV17DraftReviewRecord) {
  return {
    formatVersion: 1 as const,
    runtimeVersion: 17 as const,
    draftId: review.draftId,
    namespace: review.namespace,
    name: review.name,
    valid: review.valid,
    definition: review.definition ? structuredClone(review.definition) : null,
    source: {
      draftHash: review.sourceHash,
      installedHash: review.installedSourceHash,
      targetPath: boundedWorkflowV17ProjectionText(review.targetPath, 4_096),
      changed: review.sourceDiff.changed,
      diffPreview: boundedWorkflowV17ProjectionText(review.sourceDiff.preview, 40_000),
      truncated: review.sourceDiff.truncated,
    },
    reviewHash: review.reviewHash,
    capabilities: [...review.capabilities],
    descriptors: structuredClone(review.descriptors),
    profiles: review.profiles.map(profile => ({
      id: profile.id,
      profileHash: profile.profileHash,
      routeId: profile.routeId,
      routeHash: profile.routeHash,
    })),
    commandProfiles: [...review.commandProfiles],
    measurementProfiles: [...review.measurementProfiles],
    verificationProfiles: [...review.verificationProfiles],
    dynamicResources: structuredClone(review.dynamicResources),
    candidateWrites: structuredClone(review.candidateWrites),
    authority: structuredClone(review.authority),
    operations: structuredClone(review.operations),
    diagnostics: structuredClone(review.diagnostics),
  };
}

export function projectWorkflowV17DraftPromotion(
  review: WorkflowV17DraftReviewRecord,
  challenge: WorkflowV17DraftPromotionChallenge,
) {
  if (!review.definition
    || challenge.runtimeVersion !== 17
    || challenge.draftId !== review.draftId
    || challenge.draftHash !== review.sourceHash
    || challenge.targetNamespace !== review.namespace
    || challenge.targetPath !== review.targetPath
    || challenge.installedSourceHash !== review.installedSourceHash
    || challenge.currentPolicyHash !== review.definition.policyHash
    || challenge.reviewHash !== review.reviewHash) {
    throw new Error("Workflow v17 promotion challenge does not bind the exact review");
  }
  return {
    formatVersion: 1 as const,
    runtimeVersion: 17 as const,
    validation: projectWorkflowV17DraftReview(review),
    challenge: structuredClone(challenge),
  };
}
