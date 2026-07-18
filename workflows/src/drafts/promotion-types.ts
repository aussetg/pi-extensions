import type {
  WorkflowCandidateWriteSite,
  WorkflowCapability,
  WorkflowDynamicResourceUse,
  WorkflowNativeLoop,
} from "../definition/workflow-types.js";
import type { WorkflowExposure } from "../registry/workflow-policy.js";
import type { WorkflowDraftId, WorkflowDraftNamespace, WorkflowDraftSourceDiff } from "./types.js";

export interface WorkflowDraftDiagnostic {
  stage: "installed" | "typecheck" | "parse" | "schema" | "profiles" | "routes" | "resources" | "operations" | "control-load" | "policy";
  severity: "info" | "error";
  message: string;
  location?: { line: number; column: number };
}

export interface WorkflowDraftResolvedProfile {
  selector: string;
  id: string;
  profileHash: string;
  routeId: string;
  routeHash: string;
  model: string;
  thinking: string;
}

export interface WorkflowDraftOperationAnalysis {
  staticSites: number;
  byMethod: Record<string, number>;
  concurrentSites: number;
  nativeLoops: WorkflowNativeLoop[];
  suspiciousUnboundedLoops: Array<{ line: number; column: number }>;
  hostAdmissionLimit: number;
}

export interface WorkflowDraftReviewBody {
  draftId: WorkflowDraftId;
  namespace: WorkflowDraftNamespace;
  name: string;
  sourceHash: string;
  targetPath: string;
  installedSourceHash: string | null;
  valid: boolean;
  definition?: {
    title?: string;
    description: string;
    concurrency?: number;
    currentExposure: WorkflowExposure;
    policyHash: string;
  };
  sourceDiff: WorkflowDraftSourceDiff;
  capabilities: WorkflowCapability[];
  descriptors: Array<{
    binding: string;
    kind: "agent-task" | "command-task";
    profile: string;
    workspace?: "snapshot" | "candidate";
    network?: "none" | "research";
    effect?: "read-only" | "temporary" | "candidate";
    sourceSite: string;
  }>;
  profiles: WorkflowDraftResolvedProfile[];
  commandProfiles: string[];
  measurementProfiles: string[];
  verificationProfiles: string[];
  dynamicResources: WorkflowDynamicResourceUse[];
  candidateWrites: WorkflowCandidateWriteSite[];
  authority: {
    candidateWrite: boolean;
    mediatedNetwork: boolean;
    hostCommand: boolean;
    humanInput: boolean;
    humanInteractionSites: number;
    applySites: number;
  };
  operations: WorkflowDraftOperationAnalysis;
  definitionControlLoad: "passed" | "failed" | "skipped";
  diagnostics: WorkflowDraftDiagnostic[];
}

export interface WorkflowDraftReviewRecord extends WorkflowDraftReviewBody {
  reviewHash: string;
}

export interface WorkflowDraftPromotionChallenge {
  draftId: WorkflowDraftId;
  draftHash: string;
  targetNamespace: WorkflowDraftNamespace;
  targetPath: string;
  installedSourceHash: string | null;
  currentPolicyHash: string;
  targetExposure: WorkflowExposure;
  reviewHash: string;
  challengeHash: string;
}

export interface WorkflowDraftPromotionResult {
  id: WorkflowDraftId;
  sourceHash: string;
  installedPath: string;
  exposure: WorkflowExposure;
  policyHash: string;
  reviewHash: string;
}
