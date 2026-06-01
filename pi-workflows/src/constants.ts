import os from "node:os";

export const EXTENSION_VERSION = "0.1.0";
export const EXTENSION_NAME = "pi-workflows";
export const WORKFLOW_RESULT_MESSAGE = "workflow_result";

export const SCRIPT_MAX_BYTES = 524_288;
export const CHAT_PREVIEW_BYTES = 8_000;
export const TOOL_PREVIEW_BYTES = 16_000;

export const DEFAULT_LIMITS = {
  agentConcurrency: Math.min(16, Math.max(2, os.cpus().length - 2)),
  pipelineSchedulingLimit: 50,
  agentCap: 1000,
  stallMs: 180_000,
  stallRetries: 5,
  workflowHeartbeatMs: 1_000,
  workflowHeartbeatTimeoutMs: 15_000,
  workflowHardTimeoutMs: 6 * 60 * 60_000,
} as const;

export const WORKFLOW_AGENT_OPTION_LIMITS = {
  labelBytes: 500,
  phaseBytes: 500,
  modelBytes: 500,
  agentTypeBytes: 120,
  schemaBytes: 64 * 1024,
  schemaDepth: 16,
  schemaNodes: 2_000,
  stallMsMin: 1_000,
  stallMsMax: DEFAULT_LIMITS.workflowHardTimeoutMs,
} as const;

export const WORKFLOW_ISOLATION_POLICY = {
  /** Plain sequential agent() calls operate in the user's current workspace. */
  directAgentDefault: "shared",
  /** Fan-out helpers run branch/stage agent() calls in disposable git worktrees unless explicitly overridden. */
  fanoutAgentDefault: "worktree",
} as const;

export const WORKFLOW_CHILD_CGROUP = {
  memoryMax: "768M",
  tasksMax: "128",
  cpuQuota: "200%",
} as const;

export const WORKFLOW_RESOURCE_LIMITS = {
  workflowProtocolLineBytes: 1024 * 1024,
  workflowParentMessageBytes: 1024 * 1024,
  workflowOutputBytes: 2 * 1024 * 1024,
  workflowReplayResultBytes: 8 * 1024 * 1024,
  workflowChildStderrBytes: 64 * 1024,
  subagentStdoutLineBytes: 1024 * 1024,
  subagentResultTextBytes: 512 * 1024,
  subagentStderrBytes: 128 * 1024,
  runRecordBytes: 8 * 1024 * 1024,
  runArgsBytes: 2 * 1024 * 1024,
  runOwnerBytes: 4 * 1024,
  journalEventBytes: 128 * 1024,
  journalBytes: 32 * 1024 * 1024,
  journalEvents: 100_000,
  logMessageBytes: 4 * 1024,
  logEntries: 1000,
  logFileBytes: 1024 * 1024,
  worktreeStatusBytes: 1024 * 1024,
  worktreePatchBytes: 100 * 1024 * 1024,
  worktreeIgnoredListBytes: 1024 * 1024,
  worktreeIgnoredFiles: 200,
  worktreeIgnoredFileBytes: 2 * 1024 * 1024,
  worktreeIgnoredTotalBytes: 8 * 1024 * 1024,
  worktreeIgnoredSymlinkBytes: 4 * 1024,
} as const;

export const UI_LIMITS = {
  maxViewsPerRun: 5,
  maxSpecBytes: 64 * 1024,
  maxStateBytes: 512 * 1024,
  maxUpdateHz: 4,
  maxDashboardCharts: 4,
  maxDashboardChartPoints: 80,
  maxDashboardTables: 2,
  maxDashboardTableRows: 12,
  maxDashboardTableColumns: 6,
  minDashboardPanelLines: 6,
  maxDashboardPanelLines: 24,
  maxRowsPerTable: 500,
  maxRenderedRows: 50,
  maxSeriesPoints: 500,
  maxNodeDepth: 8,
  maxNodeCount: 100,
  maxTextBytesPerNode: 16 * 1024,
  maxColumnWidth: 120,
  maxStateSnapshotsPerView: 200,
} as const;

export const RENDER_LIMITS = {
  managerRows: 40,
  progressCalls: 12,
  progressLogs: 3,
  compactViewLines: 3,
  panelViewLines: 10,
  workflowPanelLines: 16,
  fullViewLines: 220,
  pagerLines: 300,
} as const;
