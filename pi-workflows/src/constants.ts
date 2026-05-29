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

export const WORKFLOW_CHILD_CGROUP = {
  memoryMax: "768M",
  tasksMax: "128",
  cpuQuota: "200%",
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
  fullViewLines: 220,
  pagerLines: 300,
} as const;
