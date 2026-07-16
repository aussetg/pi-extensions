import type { ParsedStructuredWorkflow } from "../definition/types.js";
import type { RunDatabase } from "../persistence/run-database.js";
import type { JsonObject, JsonValue } from "../types.js";
import type {
  ArtifactRecord,
  AttemptRecord,
  OperationKind,
  OperationRecord,
  OperationResult,
  ResourceMeasurement,
  RunRecord,
  UsageMeasurement,
  WorkflowCallRecord,
  WorkspaceCheckpointRecord,
} from "./durable-types.js";
import type { MeasurementRecord } from "../measurements/records.js";
import type { ExperimentRecord } from "../experiments/records.js";

export type SemanticEffectKind = Exclude<OperationKind, "stage" | "loop" | "parallel" | "fan-out" | "checkpoint">;

export interface SemanticEngineInvocation {
  workflowId: string;
  definitionHash: string;
  input: JsonObject;
  inputHash: string;
}

export interface SemanticEffectAdmissionRequest {
  run: RunRecord;
  kind: SemanticEffectKind;
  sourceId: string;
  path: string;
  input: unknown;
}

export interface SemanticEffectRequest extends SemanticEffectAdmissionRequest {
  database: RunDatabase;
  operation: OperationRecord;
  signal: AbortSignal;
}

export interface SemanticEffectRestoreRequest extends SemanticEffectAdmissionRequest {
  database: RunDatabase;
  operation: OperationRecord & { result: OperationResult };
}

export interface SemanticEffectJournalIdentity {
  /** Content-only semantic identity; see buildAgentSemanticKey for agents. */
  semanticKey: string;
  completionAuthority: "finish-work" | "host-effect";
  replayPolicy: "immutable" | "workspace" | "never";
}

export interface SemanticReplaySource {
  runDir: string;
  run: RunRecord;
  operation: OperationRecord;
  call: WorkflowCallRecord;
  workspaceCheckpoint?: WorkspaceCheckpointRecord;
}

export interface SemanticReplayMaterialization {
  result: OperationResult;
  attemptId?: AttemptRecord["attemptId"];
  workspaceCheckpoint?: WorkspaceCheckpointRecord;
  measurement?: MeasurementRecord;
  experiment?: ExperimentRecord;
  verification?: import("./durable-types.js").VerificationRecord;
}

export interface SemanticEffectOutcome {
  result: OperationResult;
  artifacts?: ArtifactRecord[];
  /** Already-registered immutable evidence linked in the completion transaction. */
  evidenceArtifacts?: ArtifactRecord["digest"][];
  /** Already-registered progress artifacts linked in the completion transaction. */
  progressArtifacts?: ArtifactRecord["digest"][];
  attemptId?: AttemptRecord["attemptId"];
  usage?: UsageMeasurement;
  resources?: ResourceMeasurement;
  workspaceCheckpoint?: WorkspaceCheckpointRecord;
  measurement?: MeasurementRecord;
  experiment?: ExperimentRecord;
  verification?: import("./durable-types.js").VerificationRecord;
  /** Must agree with journalIdentity; agent success is finish_work-only. */
  completionAuthority: "finish-work" | "host-effect";
}

/** Trusted host provider boundary. Workflow JavaScript never receives this object. */
export interface SemanticEffectAdapter {
  readonly kind: SemanticEffectKind;
  semanticInput(request: SemanticEffectAdmissionRequest): JsonValue | Promise<JsonValue>;
  journalIdentity(
    request: SemanticEffectAdmissionRequest,
  ): SemanticEffectJournalIdentity | Promise<SemanticEffectJournalIdentity>;
  execute(request: SemanticEffectRequest): Promise<SemanticEffectOutcome>;
  /** Required to map and restore a cross-run candidate checkpoint. */
  materializeReplay?(
    request: SemanticEffectRequest,
    source: SemanticReplaySource,
  ): Promise<SemanticReplayMaterialization>;
  /** Import immutable domain rows which are not fully represented by OperationResult. */
  materializeImmutableReplay?(
    request: SemanticEffectRequest,
    source: SemanticReplaySource,
  ): Promise<SemanticReplayMaterialization>;
  /** Rebuild workflow-facing opaque handles from committed database authority. */
  restore?(request: SemanticEffectRestoreRequest): unknown | Promise<unknown>;
  /** Release run-scoped sockets or other nondurable coordinator resources. */
  dispose?(): void | Promise<void>;
}

export type SemanticEngineFaultPoint =
  | "after-run-start"
  | "after-operation-claim"
  | "after-effect-settled"
  | "after-operation-completion"
  | "after-replay-materialized"
  | "after-replay-completion"
  | "after-checkpoint-request"
  | "after-checkpoint-response"
  | "after-checkpoint-completion"
  | "after-result-artifact";

export interface SequentialSemanticEngineOptions {
  now?: () => Date;
  signal?: AbortSignal;
  snapshot?: unknown;
  controlPollIntervalMs?: number;
  /** Trusted host may lower, but never raise, the built-in operation guard. */
  operationAdmissionLimit?: number;
  /** Exact source selected by the primary run launcher; never searched globally. */
  replaySourceRunDir?: string;
  faultInjector?: (point: SemanticEngineFaultPoint, operation?: OperationRecord) => void | Promise<void>;
}

export interface SemanticEngineScope {
  path: string;
  operationId?: string;
  parent?: SemanticEngineScope;
  seenIds: Set<string>;
  signal: AbortSignal;
  branchLineage: ReadonlyMap<string, string>;
}

export type SequentialSemanticRunOutcome =
  | { status: "completed"; run: RunRecord; result: JsonValue }
  | { status: "waiting" | "paused" | "stopped"; run: RunRecord }
  | { status: "failed"; run: RunRecord; error: string };

export class SemanticEngineCrashError extends Error {
  constructor(message = "Simulated semantic-engine crash", options?: ErrorOptions) {
    super(message, options);
    this.name = "SemanticEngineCrashError";
  }
}

export class SemanticOperationError extends Error {
  readonly operationId: string;
  readonly operationPath: string;

  constructor(operation: OperationRecord, message: string) {
    super(message);
    this.name = "SemanticOperationError";
    this.operationId = operation.operationId;
    this.operationPath = operation.path;
  }
}

export class SemanticRunawayAdmissionError extends Error {
  constructor(readonly reason: import("./durable-types.js").StructuredReason) {
    super(reason.summary);
    this.name = "SemanticRunawayAdmissionError";
  }
}

/** Useful to adapter factories that bind one exact parsed workflow. */
export interface SemanticEngineDefinitionBinding {
  parsed: ParsedStructuredWorkflow;
  invocation: SemanticEngineInvocation;
}
