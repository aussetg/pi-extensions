import { RunDatabase, RunRevisionConflictError } from "../persistence/run-database.js";
import type { AgentProgress, ResourceMeasurement, UsageMeasurement } from "../runtime/durable-types.js";
import type { AgentEvent, AgentEventSink } from "./executor.js";
import { AGENT_PROGRESS_LIMITS } from "../runtime/agent-progress-limits.js";

const MAX_COMMIT_RETRIES = 16;

export type AgentProgressResourceSampler = (
  event: AgentEvent,
) => Promise<ResourceMeasurement | undefined>;

/**
 * Converts normalized lifecycle events into one current row plus bounded
 * semantic history. Text/reasoning deltas and tool-update deltas are evidence
 * only and deliberately never enter this projection.
 */
export class AgentLiveProgressProjector implements AgentEventSink {
  constructor(
    readonly database: RunDatabase,
    private readonly sampleResources?: AgentProgressResourceSampler,
  ) {}

  async emit(event: AgentEvent, sampledResources?: ResourceMeasurement): Promise<void> {
    const semantic = projectable(event);
    const resources = sampledResources ?? await this.sampleResources?.(event);
    if (!semantic && !resources) return;
    for (let attempt = 0; attempt < MAX_COMMIT_RETRIES; attempt += 1) {
      const session = this.database.readAgentSessionByOperation(event.operationId);
      const effectAttempt = this.database.readAttempt(event.attemptId);
      if (!session
        || session.currentExecutionId !== event.executionId
        || !effectAttempt
        || effectAttempt.operationId !== event.operationId
        || effectAttempt.executionId !== event.executionId) {
        throw new Error("Agent progress event does not match its durable execution");
      }
      const progress = applyEvent(session.progress, event, resources, session.createdAt);
      try {
        this.database.recordAgentProgress(
          this.database.readRun().revision,
          session.agentSessionId,
          progress,
          { type: "observed", progress },
          {
            type: "agent-progress-observed",
            operationId: event.operationId,
            attemptId: event.attemptId,
            payload: {
              agentSessionId: session.agentSessionId,
              executionId: event.executionId,
              lifecycleType: event.type,
            },
            at: progress.updatedAt,
          },
        );
        return;
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error("Agent live progress could not commit after repeated revision races");
  }
}

function projectable(event: AgentEvent): boolean {
  return event.type !== "assistant-text"
    && event.type !== "tool-update"
    && event.type !== "progress"
    && event.type !== "result-log"
    && event.type !== "artifact-published";
}

function applyEvent(
  current: AgentProgress,
  event: AgentEvent,
  sampled: ResourceMeasurement | undefined,
  createdAt: string,
): AgentProgress {
  const progress: AgentProgress = structuredClone(current);
  const eventAt = timestamp(event.at);
  progress.updatedAt = laterTimestamp(current.updatedAt, eventAt);
  progress.usage.elapsedMs = Math.max(
    progress.usage.elapsedMs,
    Math.max(0, Date.parse(progress.updatedAt) - Date.parse(createdAt)),
  );
  if (sampled) progress.resources = { ...(progress.resources ?? {}), ...sampled };

  switch (event.type) {
    case "model-start":
      positive(event.turn, "model turn");
      progress.modelTurn = increment(progress.modelTurn, "model turn");
      delete progress.currentTool;
      break;
    case "model-end":
      positive(event.turn, "model turn");
      if (event.usage) progress.usage = addTurnUsage(progress.usage, event.usage);
      delete progress.currentTool;
      break;
    case "tool-start":
      progress.currentTool = identifier(event.toolName, "tool name");
      progress.toolCount = increment(progress.toolCount, "tool count");
      break;
    case "tool-end":
      if (progress.currentTool === identifier(event.toolName, "tool name")) delete progress.currentTool;
      break;
    case "workspace-change": {
      const changed = normalizeChangedPaths(event.changedPaths);
      progress.workspaceChangeCount = increment(progress.workspaceChangeCount, "workspace change count");
      progress.workspaceChanged = true;
      progress.recentWorkspaceChanges = appendRecentPaths(progress.recentWorkspaceChanges, changed);
      break;
    }
    case "provider-retry":
      progress.retries = increment(progress.retries, "retry count");
      delete progress.currentTool;
      break;
    case "finish-committed":
    case "termination":
    case "cancel-requested":
      delete progress.currentTool;
      break;
    default:
      break;
  }
  return progress;
}

function addTurnUsage(current: UsageMeasurement, observed: UsageMeasurement): UsageMeasurement {
  const integer = (left: number, right: number, label: string): number => {
    const value = left + right;
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Agent ${label} overflow`);
    return value;
  };
  const cost = current.cost + observed.cost;
  if (!Number.isFinite(cost) || cost < 0) throw new RangeError("Agent usage cost overflow");
  return {
    inputTokens: integer(current.inputTokens, observed.inputTokens, "input usage"),
    outputTokens: integer(current.outputTokens, observed.outputTokens, "output usage"),
    cacheReadTokens: integer(current.cacheReadTokens, observed.cacheReadTokens, "cache-read usage"),
    cacheWriteTokens: integer(current.cacheWriteTokens, observed.cacheWriteTokens, "cache-write usage"),
    providerRequests: integer(current.providerRequests, observed.providerRequests, "provider request count"),
    cost,
    elapsedMs: Math.max(current.elapsedMs, observed.elapsedMs),
    complete: current.complete && observed.complete,
  };
}

function appendRecentPaths(current: string[], additions: string[]): string[] {
  const result = [...current];
  for (const changedPath of additions) {
    const prior = result.indexOf(changedPath);
    if (prior >= 0) result.splice(prior, 1);
    result.push(changedPath);
  }
  return result.slice(-AGENT_PROGRESS_LIMITS.recentWorkspacePaths);
}

function normalizeChangedPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 256) throw new TypeError("Invalid workspace change paths");
  const result = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string"
      || Array.from(entry).length > AGENT_PROGRESS_LIMITS.workspacePathScalars
      || entry.startsWith("/")
      || entry.split("/").some((part) => !part || part === "." || part === "..")
      || /[\u0000-\u001f\u007f]/.test(entry)) {
      throw new TypeError("Invalid workspace change path");
    }
    result.add(entry);
  }
  return [...result];
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(value)) {
    throw new TypeError(`Invalid agent ${label}`);
  }
  return value;
}

function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`Invalid agent ${label}`);
  return value as number;
}

function increment(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`Agent ${label} overflow`);
  }
  return value + 1;
}

function timestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new TypeError("Invalid agent event timestamp");
  return value;
}

function laterTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}
