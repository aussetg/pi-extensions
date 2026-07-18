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
  protocolVersion: 1;
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

export class AgentExecutorConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentExecutorConformanceError";
  }
}

export function assertAgentExecutorDescriptor(value: AgentExecutorDescriptor): void {
  if (!value || typeof value !== "object") throw new AgentExecutorConformanceError("Agent executor descriptor is missing");
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value.id)) throw new AgentExecutorConformanceError("Agent executor id is invalid");
  if (value.protocolVersion !== 1) throw new AgentExecutorConformanceError("Unsupported agent executor protocol version");
  if (!value.capabilities || typeof value.capabilities !== "object") {
    throw new AgentExecutorConformanceError("Agent executor capability descriptor is missing");
  }
  for (const capability of [
    "persistentSessions",
    "candidateWorkspace",
    "mediatedNetwork",
    "liveProgress",
    "artifactPublication",
  ] as const) {
    if (typeof value.capabilities[capability] !== "boolean") {
      throw new AgentExecutorConformanceError(`Agent executor capability ${capability} must be boolean`);
    }
  }
  if (!Array.isArray(value.toolCatalog) || value.toolCatalog.length > 128) {
    throw new AgentExecutorConformanceError("Agent executor tool catalog is invalid");
  }
  const names = new Set<string>();
  for (const tool of value.toolCatalog) {
    if (!tool || typeof tool !== "object" || !/^[a-z][a-z0-9_-]{0,63}$/.test(tool.name) || names.has(tool.name)) {
      throw new AgentExecutorConformanceError(`Invalid or duplicate agent executor tool ${String(tool?.name)}`);
    }
    if (!/^[a-f0-9]{64}$/.test(tool.schemaHash)) {
      throw new AgentExecutorConformanceError(`Agent executor tool ${tool.name} has an invalid schema hash`);
    }
    if (typeof tool.mutatesWorkspace !== "boolean" || typeof tool.usesMediatedNetwork !== "boolean") {
      throw new AgentExecutorConformanceError(`Agent executor tool ${tool.name} has invalid authority flags`);
    }
    names.add(tool.name);
  }
}

export interface ScriptedAgentExecutorOptions {
  descriptor?: AgentExecutorDescriptor;
  run: (
    request: AgentExecutionRequest,
    sink: AgentEventSink,
    signal: AbortSignal,
  ) => Promise<AgentExecutionResult>;
}

/** Deterministic executor for focused runtime tests; it never retries. */
export class ScriptedAgentExecutor implements AgentExecutor {
  private readonly descriptor: AgentExecutorDescriptor;

  constructor(private readonly options: ScriptedAgentExecutorOptions) {
    this.descriptor = options.descriptor ?? {
      id: "scripted-agent",
      protocolVersion: 1,
      capabilities: {
        persistentSessions: true,
        candidateWorkspace: true,
        mediatedNetwork: true,
        liveProgress: true,
        artifactPublication: true,
      },
      toolCatalog: [],
    };
    assertAgentExecutorDescriptor(this.descriptor);
  }

  describe(): AgentExecutorDescriptor {
    return structuredClone(this.descriptor);
  }

  async start(request: AgentExecutionRequest, sink: AgentEventSink): Promise<AgentExecutionHandle> {
    const controller = new AbortController();
    const result = this.options.run(request, sink, controller.signal);
    return {
      wait: async () => await result,
      cancel: async (reason) => {
        if (!controller.signal.aborted) controller.abort(new Error(reason));
      },
    };
  }
}
