import type { ThinkingLevel } from "./thinking.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = JsonObject;

export interface WorkflowInput {
  script?: string;
  name?: string;
  scriptPath?: string;
  args?: Record<string, unknown>;
  resumeFromRunId?: string;
  mode?: "async" | "await";
  budgetTokens?: number;
  maxAgents?: number;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  title?: string;
  whenToUse?: string;
  phases?: Array<{ title: string; detail?: string; model?: string }>;
}

export interface WorkflowUsage {
  agentCount: number;
  subagentTokens: number;
  toolUses: number;
  durationMs?: number;
  estimated?: boolean;
}

export interface WorkflowLaunchOutput {
  status: "async_launched" | "completed" | "failed";
  taskId: string;
  runId: string;
  name: string;
  title?: string;
  description?: string;
  phases?: WorkflowMeta["phases"];
  summary: string;
  scriptPath: string;
  transcriptDir: string;
  outputPath?: string;
  resultPreview?: string;
  error?: string;
  usage?: WorkflowUsage;
  progress?: WorkflowProgressSnapshot;
  startedAt?: string;
  endedAt?: string;
  recovery?: {
    toolCall: {
      scriptPath: string;
      resumeFromRunId: string;
      args?: Record<string, unknown>;
    };
  };
}

export interface AgentOptions {
  label?: string;
  phase?: string;
  schema?: JsonSchema;
  model?: string;
  /**
   * Pi thinking level for this subagent. When omitted, workflows default to one
   * level below the launching session, unless the model pattern itself includes
   * a legacy :<thinking> suffix.
   */
  thinking?: ThinkingLevel;
  /** Workspace policy for this subagent. Fan-out defaults to readOnly. */
  workspace?: "shared" | "readOnly" | "patch";
  stallMs?: number;
}

/** Opaque handle for a patch produced by an agent running in patch workspace mode. */
export interface WorkflowPatchRef {
  kind: "workflow_patch";
  id: string;
  callId: string;
  files: string[];
  empty: boolean;
}

export interface WorkflowPatchAgentResult {
  result: unknown;
  patch: WorkflowPatchRef;
}

export interface WorkflowPatchApplyResult {
  applied: boolean;
  patchId: string;
  files: string[];
}

export interface AgentWorkspaceArtifacts {
  kind: "patch";
  worktreeDir: string;
  workspaceRoot: string;
  statusPath?: string;
  patchPath?: string;
  changedFiles: string[];
  ignoredManifestPath?: string;
  ignoredFilesDir?: string;
  patchCaptureError?: string;
  error?: string;
}

export type RunStatus = "running" | "paused" | "completed" | "failed" | "aborted" | "stale";
export type CallStatus = "pending" | "running" | "done" | "failed" | "skipped" | "aborted";

export interface WorkflowCallProgress {
  callId: string;
  label: string;
  phase?: string;
  model?: string;
  thinking?: ThinkingLevel;
  status: CallStatus;
  usage?: WorkflowUsage;
  startedAt?: string;
  endedAt?: string;
  resultPath?: string;
  error?: string;
}

export interface WorkflowProgressSnapshot {
  total: number;
  running: number;
  completed: number;
  failed: number;
  skipped: number;
  phase?: string;
  calls: WorkflowCallProgress[];
  recentLogs: string[];
  updatedAt: string;
}

export interface RunRecord {
  runId: string;
  taskId: string;
  sessionId: string;
  name: string;
  title?: string;
  description: string;
  phases?: WorkflowMeta["phases"];
  status: RunStatus;
  scriptPath: string;
  runDir: string;
  journalPath: string;
  logsPath: string;
  manifestPath: string;
  argsPath: string;
  transcriptDir: string;
  outputPath?: string;
  errorPath?: string;
  startedAt: string;
  endedAt?: string;
  argsHash: string;
  scriptHash: string;
  resumeFromRunId?: string;
  phase?: string;
  progress: WorkflowProgressSnapshot;
  usage: WorkflowUsage;
  recovery?: { scriptPath: string; resumeFromRunId: string; args?: Record<string, unknown> };
}

export interface RunManifest {
  runId: string;
  createdBy: "workflows";
  extensionVersion: string;
  scriptHash: string;
  argsHash: string;
  scriptPath: string;
  journalPath: string;
  outputPath?: string;
  runPath: string;
  subagents: Array<{ callId: string; transcriptPath: string; resultPath?: string }>;
  recovery?: { scriptPath: string; resumeFromRunId: string; args?: Record<string, unknown> };
}

export type WorkflowJournalEvent =
  | { type: "workflow_started"; runId: string; time: string; scriptHash: string; argsHash: string }
  | {
      type: "agent_started";
      runId: string;
      time: string;
      callId: string;
      label: string;
      phase?: string;
      promptHash: string;
      optsHash: string;
    }
  | {
      type: "agent_result";
      runId: string;
      time: string;
      callId: string;
      status: "done" | "error" | "skipped" | "aborted";
      resultPath?: string;
      error?: string;
      usage?: WorkflowUsage;
      model?: string;
      thinking?: ThinkingLevel;
    }
  | { type: "log"; runId: string; time: string; message: string }
  | { type: "phase"; runId: string; time: string; phase: string }
  | { type: "patch_applied"; runId: string; time: string; patchId: string; callId: string; files: string[] }
  | { type: "workflow_completed"; runId: string; time: string; outputPath: string; usage: WorkflowUsage }
  | { type: "workflow_failed"; runId: string; time: string; error: string; errorPath?: string };

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolResult<TDetails = unknown> {
  content: TextBlock[];
  details?: TDetails;
  isError?: boolean;
  terminate?: boolean;
}
