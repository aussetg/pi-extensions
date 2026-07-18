import type { WorkflowNamespace } from "../definition/types.js";

export type WorkflowDraftNamespace = Exclude<WorkflowNamespace, "builtin">;
export type WorkflowDraftId = `${WorkflowDraftNamespace}:${string}`;

export interface WorkflowDraftRevision {
  id: WorkflowDraftId;
  namespace: WorkflowDraftNamespace;
  name: string;
  projectRoot?: string;
  source: string;
  sourceHash: string;
  targetPath: string;
  revisionHashes: string[];
}

export type WorkflowDraftSummary = Omit<WorkflowDraftRevision, "source">;

export interface WorkflowDraftSourceDiff {
  installedSourceHash: string | null;
  draftSourceHash: string;
  changed: boolean;
  preview: string;
  truncated: boolean;
}
