import type {
  WorkflowV17CandidateWriteSite,
  WorkflowV17Capability,
  WorkflowV17DynamicResourceUse,
  WorkflowV17NativeLoop,
} from "../definition/workflow-v17-types.js";
import type { WorkflowV17Exposure } from "../registry/workflow-v17-policy.js";
import type { WorkflowDraftId, WorkflowDraftNamespace, WorkflowDraftSourceDiff } from "./types.js";

export interface WorkflowV17DraftDiagnostic {
  stage: "installed" | "typecheck" | "parse" | "schema" | "profiles" | "routes" | "resources" | "operations" | "control-load" | "policy";
  severity: "info" | "error";
  message: string;
  location?: { line: number; column: number };
}

export interface WorkflowV17DraftResolvedProfile {
  selector: string;
  id: string;
  profileHash: string;
  routeId: string;
  routeHash: string;
  model: string;
  thinking: string;
}

export interface WorkflowV17DraftOperationAnalysis {
  staticSites: number;
  byMethod: Record<string, number>;
  concurrentSites: number;
  nativeLoops: WorkflowV17NativeLoop[];
  suspiciousUnboundedLoops: Array<{ line: number; column: number }>;
  hostAdmissionLimit: number;
}

export interface WorkflowV17DraftReviewBody {
  formatVersion: 1;
  runtimeVersion: 17;
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
    currentExposure: WorkflowV17Exposure;
    policyHash: string;
  };
  sourceDiff: WorkflowDraftSourceDiff;
  capabilities: WorkflowV17Capability[];
  descriptors: Array<{
    binding: string;
    kind: "agent-task" | "command-task";
    profile: string;
    workspace?: "snapshot" | "candidate";
    network?: "none" | "research";
    effect?: "read-only" | "temporary" | "candidate";
    sourceSite: string;
  }>;
  profiles: WorkflowV17DraftResolvedProfile[];
  commandProfiles: string[];
  measurementProfiles: string[];
  verificationProfiles: string[];
  dynamicResources: WorkflowV17DynamicResourceUse[];
  candidateWrites: WorkflowV17CandidateWriteSite[];
  authority: {
    candidateWrite: boolean;
    mediatedNetwork: boolean;
    hostCommand: boolean;
    humanInput: boolean;
    humanInteractionSites: number;
    applySites: number;
  };
  operations: WorkflowV17DraftOperationAnalysis;
  definitionControlLoad: "passed" | "failed" | "skipped";
  diagnostics: WorkflowV17DraftDiagnostic[];
}

export interface WorkflowV17DraftReviewRecord extends WorkflowV17DraftReviewBody {
  reviewHash: string;
}

export interface WorkflowV17DraftPromotionChallenge {
  formatVersion: 1;
  runtimeVersion: 17;
  draftId: WorkflowDraftId;
  draftHash: string;
  targetNamespace: WorkflowDraftNamespace;
  targetPath: string;
  installedSourceHash: string | null;
  currentPolicyHash: string;
  targetExposure: WorkflowV17Exposure;
  reviewHash: string;
  challengeHash: string;
}

export interface WorkflowV17DraftPromotionResult {
  id: WorkflowDraftId;
  sourceHash: string;
  installedPath: string;
  exposure: WorkflowV17Exposure;
  policyHash: string;
  reviewHash: string;
}
