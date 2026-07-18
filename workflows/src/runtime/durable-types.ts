import type { JsonObject, JsonValue } from "../types.js";

export type AgentSessionStatus =
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "completed"
  | "failed"
  | "stopped";

export type ReasonCategory =
  | "control"
  | "human-input"
  | "approval"
  | "safety"
  | "agent-protocol"
  | "provider"
  | "infrastructure"
  | "workflow"
  | "effect"
  | "workspace"
  | "replay";

export interface StructuredReason {
  category: ReasonCategory;
  code: string;
  summary: string;
  retryable: boolean;
  operationId?: string;
  evidence?: ArtifactRef[];
  details?: JsonObject;
}

/** Host-owned containment limits; never workflow invocation authority. */
export interface SafetyConfiguration {
  concurrency: number;
  maximumAgentLaunches: number;
  memoryBytes: number;
  tasks: number;
  cpuQuotaPercent: number;
  cpuWeight: number;
  outputBytes: number;
  commandTimeoutMs: number;
}

/** Observed provider and host use. These values never authorize admission. */
export interface UsageMeasurement {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  providerRequests: number;
  cost: number;
  elapsedMs: number;
  complete: boolean;
}

export function zeroUsage(complete = true): UsageMeasurement {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    providerRequests: 0,
    cost: 0,
    elapsedMs: 0,
    complete,
  };
}

export interface ResourceMeasurement {
  cpuUsec?: number;
  ioReadBytes?: number;
  ioWriteBytes?: number;
  memoryCurrentBytes?: number;
  memoryPeakBytes?: number;
  tasksCurrent?: number;
  tasksPeak?: number;
  cpuPressure?: number;
  ioPressure?: number;
  memoryPressure?: number;
}

export interface ArtifactRef {
  digest: string;
  kind: string;
  mediaType: "text/plain; charset=utf-8" | "application/json" | "application/octet-stream";
  bytes: number;
}

export interface WorkspaceRef {
  kind: "snapshot" | "candidate";
  workspaceId: string;
  treeHash: string;
  lineageHash?: string;
  writeScopeHash?: string;
}

export type CandidateWriteScope =
  | "all-semantic-project-paths"
  | { allow: string[]; deny?: string[] };

export interface ProgressMetric {
  name: string;
  value: number;
  unit?: string;
}

export interface AgentProgress {
  message?: string;
  current?: number;
  total?: number;
  metrics: ProgressMetric[];
  usage: UsageMeasurement;
  modelTurn: number;
  currentTool?: string;
  toolCount: number;
  retries: number;
  workspaceChanged: boolean;
  workspaceChangeCount: number;
  recentWorkspaceChanges: string[];
  resources?: ResourceMeasurement;
  updatedAt: string;
}

/** Durable acknowledgement of the terminating finish_work call. */
export interface AgentFinishRecord {
  toolCallId: string;
  schemaHash: string;
  value?: JsonValue;
  artifacts: ArtifactRef[];
  committedAt: string;
}

export type AgentTerminalToolName =
  | "finish_work"
  | "report_progress"
  | "log_result"
  | "publish_artifact";

export type AgentMediatedToolName = "web_search" | "web_fetch" | "workspace_command";
export type AgentProtocolToolName = AgentTerminalToolName | AgentMediatedToolName;

/** Minimal durable agent-session shape used by the restart supervisor. */
export interface AgentSessionRecord {
  agentSessionId: string;
  runId: string;
  operationId: string;
  profileId: string;
  routeId: string;
  piSessionPath: string;
  workspace: WorkspaceRef;
  network: "none" | "research";
  status: AgentSessionStatus;
  reason?: StructuredReason;
  receiptlessStrikes: number;
  currentExecutionId?: string;
  progress: AgentProgress;
  finish?: AgentFinishRecord;
  createdAt: string;
  updatedAt: string;
}
