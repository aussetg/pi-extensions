import type { WorkflowCapability, WorkflowNamespace } from "../definition/types.js";

export type WorkflowDraftNamespace = Exclude<WorkflowNamespace, "builtin">;
export type WorkflowDraftId = `${WorkflowDraftNamespace}:${string}`;

/** One immutable, content-addressed draft revision selected by a mutable head. */
export interface WorkflowDraftRevision {
  formatVersion: 1;
  id: WorkflowDraftId;
  namespace: WorkflowDraftNamespace;
  name: string;
  projectRoot?: string;
  source: string;
  sourceHash: string;
  targetPath: string;
  revisionHashes: string[];
}

export interface WorkflowDraftSummary extends Omit<WorkflowDraftRevision, "source"> {}

export interface WorkflowDraftDiagnostic {
  stage: "installed" | "parse" | "schema" | "profiles" | "routes" | "resources" | "operations" | "control-load";
  severity: "info" | "error";
  message: string;
  location?: { line: number; column: number };
}

export interface WorkflowDraftSourceDiff {
  installedSourceHash: string | null;
  draftSourceHash: string;
  changed: boolean;
  preview: string;
  truncated: boolean;
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
  dynamicSites: {
    loops: number;
    parallel: number;
    fanOut: number;
  };
  hostAdmissionLimit: number;
}

export interface WorkflowDraftReviewBody {
  formatVersion: 1;
  draftId: WorkflowDraftId;
  namespace: WorkflowDraftNamespace;
  name: string;
  sourceHash: string;
  targetPath: string;
  installedSourceHash: string | null;
  valid: boolean;
  definition?: {
    name: string;
    title?: string;
    description: string;
    modelVisible: boolean;
    maxParallelism?: number;
  };
  sourceDiff: WorkflowDraftSourceDiff;
  capabilities: {
    declared: WorkflowCapability[];
    derived: WorkflowCapability[];
  };
  profiles: WorkflowDraftResolvedProfile[];
  commandProfiles: string[];
  measurementProfiles: string[];
  verificationProfiles: string[];
  authority: {
    candidateWrite: boolean;
    mediatedNetwork: boolean;
    hostCommand: boolean;
    humanInput: boolean;
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
  formatVersion: 1;
  draftId: WorkflowDraftId;
  draftHash: string;
  targetNamespace: WorkflowDraftNamespace;
  targetPath: string;
  installedSourceHash: string | null;
  reviewHash: string;
  challengeHash: string;
}

export interface WorkflowDraftPromotionResult {
  id: WorkflowDraftId;
  sourceHash: string;
  installedPath: string;
  reviewHash: string;
}
