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
  uiViews?: WorkflowViewSnapshot[];
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
  agentType?: string;
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

export type WorkflowViewPlacement = "runPanel" | "widget" | "completion" | "artifact";

export interface WorkflowViewSpec {
  version: 1;
  id: string;
  title: string;
  description?: string;
  placement?: WorkflowViewPlacement;
  defaultExpanded?: boolean;
  stateSchema?: JsonSchema;
  initialState?: JsonObject;
  layout: WorkflowLayoutNode;
  expandedLayout?: WorkflowLayoutNode;
  limits?: {
    maxRows?: number;
    maxSeriesPoints?: number;
    updateHz?: number;
  };
}

export type WorkflowLayoutNode =
  | { type: "vstack"; children: WorkflowLayoutNode[] }
  | { type: "hstack"; children: WorkflowLayoutNode[] }
  | { type: "grid"; columns: number; children: WorkflowLayoutNode[] }
  | { type: "dashboard"; bind?: string }
  | { type: "text"; text: string }
  | { type: "markdown"; bind?: string; text?: string; maxLines?: number }
  | {
      type: "metric";
      label: string;
      bind: string;
      format?: WorkflowFormat;
      trendBind?: string;
      threshold?: { warnAbove?: number; errorAbove?: number; warnBelow?: number; errorBelow?: number };
    }
  | { type: "progress"; label: string; valueBind?: string; totalBind?: string; percentBind?: string }
  | { type: "sparkline"; label: string; bind: string; format?: "number" | "duration" | "percent"; maxPoints?: number }
  | {
      type: "table";
      bind: string;
      columns: WorkflowTableColumn[];
      maxRows?: number;
    }
  | { type: "keyValue"; bind: string; maxItems?: number }
  | { type: "statusList"; bind: string; itemLabelKey?: string; itemStatusKey?: string; itemDetailKey?: string; maxItems?: number }
  | { type: "phaseList"; maxItems?: number }
  | { type: "logTail"; bind?: string; maxLines?: number };

export type WorkflowTableColumn = ({ path: string; key?: never } | { key: string; path?: never }) & { label: string; format?: WorkflowFormat; width?: number };

export type WorkflowFormat = "text" | "number" | "percent" | "duration" | "bytes" | "tokens" | "cost" | "status";

export type WorkflowDashboardDocument = JsonObject & {
  title?: string;
  status?: string;
  summary?: string;
  panel?: WorkflowDashboardPanel;
  progress?: WorkflowDashboardProgress;
  metrics?: WorkflowDashboardMetric[];
  charts?: WorkflowDashboardChart[];
  tables?: WorkflowDashboardTable[];
  sections?: WorkflowDashboardSection[];
};

export type WorkflowDashboardPanelBlock = "summary" | "progress" | "metrics" | "charts" | "tables" | "sections";

export type WorkflowDashboardPanel = JsonObject & {
  lines?: number;
  priority?: WorkflowDashboardPanelBlock[];
};

export type WorkflowDashboardProgress = JsonObject & {
  label?: string;
  value?: number;
  total?: number;
  percent?: number;
  detail?: string;
};

export type WorkflowDashboardMetric = JsonObject & {
  label: string;
  value?: JsonValue;
  format?: WorkflowFormat;
  status?: string;
  detail?: string;
};

export type WorkflowDashboardChartType = "sparkline";
export type WorkflowDashboardChartFormat = "number" | "duration" | "percent";
export type WorkflowDashboardChartDirection = "up" | "down" | "neutral";

export type WorkflowDashboardChart = JsonObject & {
  type?: WorkflowDashboardChartType;
  label: string;
  values: number[];
  format?: WorkflowDashboardChartFormat;
  direction?: WorkflowDashboardChartDirection;
  value?: JsonValue;
  status?: string;
  detail?: string;
};

export type WorkflowDashboardTableColumn = JsonObject & {
  key?: string;
  path?: string;
  label?: string;
  format?: WorkflowFormat;
  width?: number;
};

export type WorkflowDashboardTableRow = JsonObject;

export type WorkflowDashboardTable = JsonObject & {
  title?: string;
  columns: Array<string | WorkflowDashboardTableColumn>;
  rows: WorkflowDashboardTableRow[];
  maxRows?: number;
};

export type WorkflowDashboardSection = JsonObject & {
  title?: string;
  summary?: string;
  progress?: WorkflowDashboardProgress;
  metrics?: WorkflowDashboardMetric[];
  rows?: WorkflowDashboardRow[];
  lines?: string[];
};

export type WorkflowDashboardRow = JsonObject & {
  label?: string;
  status?: string;
  value?: JsonValue;
  detail?: string;
};

export type RunStatus = "running" | "paused" | "completed" | "failed" | "aborted" | "stale";
export type CallStatus = "pending" | "running" | "done" | "failed" | "skipped" | "aborted";

export interface WorkflowCallProgress {
  callId: string;
  label: string;
  phase?: string;
  model?: string;
  thinking?: ThinkingLevel;
  agentType?: string;
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
  uiViews: Array<{ viewId: string; title: string; specPath: string; latestStatePath: string }>;
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
  uiViews: Array<{ viewId: string; specPath: string; latestStatePath: string }>;
  subagents: Array<{ callId: string; transcriptPath: string; resultPath?: string }>;
  recovery?: { scriptPath: string; resumeFromRunId: string; args?: Record<string, unknown> };
}

export interface WorkflowViewSnapshot {
  spec: WorkflowViewSpec;
  state: JsonObject;
  seq: number;
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
  | { type: "ui_defined"; runId: string; time: string; viewId: string; specPath: string }
  | { type: "ui_state"; runId: string; time: string; viewId: string; seq: number; statePath: string }
  | { type: "ui_closed"; runId: string; time: string; viewId: string }
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
