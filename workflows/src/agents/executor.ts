import type { JsonSchema, JsonValue } from "../types.js";
import type {
  AgentFinishRecord,
  AgentProgress,
  ArtifactRef,
  SafetyConfiguration,
  StructuredReason,
  UsageMeasurement,
  WorkspaceRef,
} from "../runtime/durable-types.js";

export type AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentToolDescriptor {
  name: string;
  schemaHash: string;
  mutatesWorkspace: boolean;
  usesMediatedNetwork: boolean;
}

export interface AgentExecutorDescriptor {
  id: string;
  capabilities: {
    persistentSessions: boolean;
    candidateWorkspace: boolean;
    mediatedNetwork: boolean;
    liveProgress: boolean;
    artifactPublication: boolean;
  };
  toolCatalog: AgentToolDescriptor[];
}

/** Semantic role policy. Exact provider routing is deliberately separate. */
export interface AgentProfileSnapshot {
  id: string;
  name: string;
  title?: string;
  description: string;
  instructions: string;
  allowedTools: string[];
  hash: string;
  sourcePath: string;
}

/** Host-resolved economic route, never selected by workflow source or input. */
export interface AgentRouteSnapshot {
  id: string;
  profileId: string;
  provider: string;
  /** Exact `provider/model` identity captured when the run is launched. */
  model: string;
  thinking: AgentThinkingLevel;
  hash: string;
}

interface AgentWorkspaceHandleBase {
  readonly root: string;
  readonly cwd: string;
  readonly preTreeHash: string;
}

export type AgentWorkspaceHandle =
  | (AgentWorkspaceHandleBase & {
      readonly mode: "read-only";
      readonly workspace: WorkspaceRef & { kind: "snapshot" };
    })
  | (AgentWorkspaceHandleBase & {
      readonly mode: "candidate";
      readonly workspace: WorkspaceRef & { kind: "candidate" };
    });

export interface AgentInputBundleEntry {
  id: string;
  artifact: ArtifactRef;
  path: string;
}

export interface AgentInputBundleHandle {
  readonly root: string;
  readonly entries: readonly AgentInputBundleEntry[];
  readonly hash: string;
}

export interface AgentContextEntry {
  id: string;
  path: string;
  text: string;
  hash: string;
}

export interface AgentContextBundle {
  entries: AgentContextEntry[];
  hash: string;
}

interface AgentSessionHandleBase {
  readonly agentSessionId: string;
  readonly piSessionPath: string;
}

export type AgentSessionHandle =
  | (AgentSessionHandleBase & { readonly resume: false })
  | (AgentSessionHandleBase & { readonly resume: true });

export interface AgentProtocolHandle {
  readonly socketPath: string;
  readonly executionToken: string;
}

export const MISSING_RECEIPT_REMINDER =
  "Your prior turn ended without finish_work. Continue the same task and call finish_work when the result is ready." as const;

export type AgentLaunchInstruction =
  | { kind: "initial-task"; task: string }
  | { kind: "resume" }
  | { kind: "missing-receipt-reminder"; text: typeof MISSING_RECEIPT_REMINDER };

interface AgentExecutionRequestBase {
  runId: string;
  operationId: string;
  operationPath: string;
  attemptId: string;
  executionId: string;
  profile: AgentProfileSnapshot;
  route: AgentRouteSnapshot;
  tools: AgentToolDescriptor[];
  network: "none" | "research";
  outputSchema?: JsonSchema;
  workspace: AgentWorkspaceHandle;
  inputs: AgentInputBundleHandle;
  context: AgentContextBundle;
  protocol: AgentProtocolHandle;
  semanticCallKey: string;
  safety: SafetyConfiguration;
}

export type AgentExecutionRequest = AgentExecutionRequestBase &
  (
    | {
        instruction: Extract<AgentLaunchInstruction, { kind: "initial-task" }>;
        session: AgentSessionHandle & { resume: false };
      }
    | {
        instruction: Exclude<AgentLaunchInstruction, { kind: "initial-task" }>;
        session: AgentSessionHandle & { resume: true };
      }
  );

interface AgentEventBase {
  executionId: string;
  operationId: string;
  attemptId: string;
  sequence: number;
  at: string;
}

/** Evidence and projection events. Only finish-committed authorizes completion. */
export type AgentEvent = AgentEventBase &
  (
    | { type: "execution-start"; pid?: number; unit?: string }
    | { type: "session-open"; agentSessionId: string; resumed: boolean }
    | { type: "model-start"; model: string; turn: number }
    | { type: "model-end"; turn: number; usage?: UsageMeasurement; stopReason?: string }
    | { type: "assistant-text"; text: string }
    | { type: "tool-start"; toolCallId: string; toolName: string; input?: JsonValue }
    | { type: "tool-update"; toolCallId: string; text: string }
    | { type: "tool-end"; toolCallId: string; toolName: string; isError: boolean }
    | { type: "progress"; progress: AgentProgress }
    | { type: "result-log"; message: string; artifact?: ArtifactRef }
    | { type: "artifact-published"; artifact: ArtifactRef; name?: string }
    | { type: "workspace-change"; treeHash: string; changedPaths: string[] }
    | { type: "compaction-start" }
    | { type: "compaction-end"; summaryBytes: number }
    | { type: "provider-retry"; delayMs?: number; message?: string }
    | { type: "finish-requested"; toolCallId: string }
    | { type: "finish-committed"; finish: AgentFinishRecord }
    | { type: "cancel-requested"; reason: AgentCancellationReason }
    | { type: "termination"; outcome: "finished" | "yielded" | "failed" | "stopped"; reason?: StructuredReason }
  );

export type AgentExecutionResult =
  | {
      outcome: "finished";
      finish: AgentFinishRecord;
      usage: UsageMeasurement;
      transcriptComplete: boolean;
    }
  | {
      outcome: "yielded";
      clean: true;
      meaningfulProgress: boolean;
      usage: UsageMeasurement;
      transcriptComplete: boolean;
    }
  | {
      outcome: "failed";
      reason: StructuredReason;
      /** Activity retained across infrastructure recovery before the next clean yield. */
      meaningfulProgress?: boolean;
      usage: UsageMeasurement;
      transcriptComplete: boolean;
    }
  | {
      outcome: "paused";
      reason: StructuredReason;
      receiptlessStrikes: number;
      usage: UsageMeasurement;
      transcriptComplete: boolean;
    }
  | {
      outcome: "stopped";
      reason?: StructuredReason;
      usage: UsageMeasurement;
      transcriptComplete: boolean;
    };

export type AgentCancellationReason = "run-stop" | "scope-failure" | "stop-effect" | "coordinator-shutdown";

export interface AgentEventSink {
  emit(event: AgentEvent): Promise<void>;
}

/** Running agents support process cancellation only; later task messages are not accepted. */
export interface AgentExecutionHandle {
  wait(): Promise<AgentExecutionResult>;
  cancel(reason: AgentCancellationReason): Promise<void>;
  dispose?(): Promise<void>;
}

export interface AgentExecutor {
  describe(): AgentExecutorDescriptor;
  start(request: AgentExecutionRequest, sink: AgentEventSink): Promise<AgentExecutionHandle>;
}
