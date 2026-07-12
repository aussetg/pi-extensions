import os from "node:os";

export const EXTENSION_VERSION = "0.1.0";
export const EXTENSION_NAME = "workflows";
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
  schemaBytes: 64 * 1024,
  schemaDepth: 16,
  schemaNodes: 2_000,
  stallMsMin: 1_000,
  stallMsMax: DEFAULT_LIMITS.workflowHardTimeoutMs,
} as const;

/** Plain sequential agent() calls may edit the user's current workspace. */
export const DEFAULT_AGENT_WORKSPACE = "shared" as const;

export const WORKFLOW_CHILD_CGROUP = {
  memoryMax: "768M",
  tasksMax: "128",
  cpuQuota: "200%",
} as const;

export const WORKFLOW_RESOURCE_LIMITS = {
  workflowProtocolLineBytes: 1024 * 1024,
  workflowParentMessageBytes: 1024 * 1024,
  workflowPendingRpcRequests: 4096,
  workflowFanoutGroupDepth: 64,
  workflowProtocolErrorBytes: 8 * 1024,
  workflowOutputBytes: 2 * 1024 * 1024,
  workflowChildStderrBytes: 64 * 1024,
  subagentStdoutLineBytes: 1024 * 1024,
  subagentStdoutBytes: 4 * 1024 * 1024,
  subagentEvents: 10_000,
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

export const RENDER_LIMITS = {
  managerRows: 40,
  progressCalls: 8,
  progressLogs: 1,
  resultLines: 16,
  pagerLines: 300,
} as const;
