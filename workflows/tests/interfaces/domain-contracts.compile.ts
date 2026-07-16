import type {
  AgentExecutionHandle,
  AgentProfileSnapshot,
  AgentRouteSnapshot,
} from "../../src/agents/executor.js";
import type { RunStatus, SafetyConfiguration } from "../../src/runtime/durable-types.js";

declare const handle: AgentExecutionHandle;

handle.cancel("stop-effect");
// @ts-expect-error running agents cannot receive task-specific guidance
handle.sendGuidance("change the task");
// @ts-expect-error process cancellation has no semantic delivery query
handle.queryGuidance("message-id");

const statuses: RunStatus[] = ["queued", "running", "waiting", "paused", "completed", "failed", "stopped"];

const safety: SafetyConfiguration = {
  concurrency: 4,
  maximumAgentLaunches: 128,
  memoryBytes: 2_147_483_648,
  tasks: 256,
  cpuQuotaPercent: 200,
  cpuWeight: 100,
  outputBytes: 52_428_800,
  commandTimeoutMs: 600_000,
};

const profile: AgentProfileSnapshot = {
  id: "builtin:coder",
  name: "coder",
  description: "Edits a candidate workspace.",
  instructions: "Implement the complete launch task.",
  allowedTools: ["read", "edit"],
  hash: "0".repeat(64),
  sourcePath: "profiles/coder.md",
};

const route: AgentRouteSnapshot = {
  id: "route_11111111111111111111111111111111",
  profileId: "builtin:coder",
  provider: "provider",
  model: "provider/model",
  thinking: "high",
  hash: "1".repeat(64),
};

void [statuses, safety, profile, route];
