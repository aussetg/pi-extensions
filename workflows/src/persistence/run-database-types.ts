import type { JsonObject, JsonValue } from "../types.js";
import type {
  AgentFinishRecord,
  AgentProgress,
  AgentProgressEvent,
  AgentSessionRecord,
  AgentMediatedToolName,
  AgentTerminalToolName,
  AgentToolReceiptRecord,
  ApprovalRecord,
  ArtifactRecord,
  ArtifactRef,
  AttemptRecord,
  ControlAcknowledgement,
  OperationRecord,
  OperationReplayRecord,
  OperationResult,
  ResourceMeasurement,
  RunRecord,
  RunStatus,
  StructuredReason,
  UsageMeasurement,
  VerificationRecord,
  WorkflowCallRecord,
  WorkspaceCheckpointRecord,
} from "../runtime/durable-types.js";
import type { CoordinatorOpenDisposition } from "./run-database-coordinator.js";
import type { RunDatabaseOpenOptions } from "./run-database-reader.js";
import type { MeasurementRecord } from "../measurements/records.js";
import type { ExperimentRecord } from "../experiments/records.js";

export interface CreateRunDatabaseOptions extends RunDatabaseOpenOptions {
  run: RunRecord;
  artifacts?: ArtifactRecord[];
  event?: Omit<RunTransitionEvent, "at"> & { at?: string };
}

export interface RunTransitionEvent {
  type: string;
  operationId?: string;
  attemptId?: string;
  payload: JsonObject;
  at: string;
}

export interface RunStateTransition {
  status: RunStatus;
  reason?: StructuredReason | null;
  currentOperationId?: string | null;
  result?: ArtifactRef | null;
  error?: ArtifactRef | null;
  startedAt?: string | null;
  endedAt?: string | null;
  event: RunTransitionEvent;
}

/** Re-focus one already claimed operation while replaying deterministic control. */
export interface OperationFocus {
  expectedRevision: number;
  operationId: string;
  focusedAt: string;
  event: Omit<RunTransitionEvent, "operationId" | "at"> & { at?: string };
}

export interface OperationClaim {
  expectedRevision: number;
  operation: OperationRecord;
  admission?: OperationAdmissionLimits;
  event: RunTransitionEvent;
}

export interface OperationAdmissionLimits {
  maximumOperations: number;
  maximumAgentOperations: number;
}

/** Atomically reserve deterministic queue rows before concurrent callbacks start. */
export interface OperationPreclaim {
  expectedRevision: number;
  operations: OperationRecord[];
  admission: OperationAdmissionLimits;
  event: RunTransitionEvent;
}

/** Settle an operation failure without prematurely deciding the run's terminal state. */
export interface OperationFailure {
  expectedRevision: number;
  operationId: string;
  failedAt: string;
  reason: import("../runtime/durable-types.js").StructuredReason;
  currentOperationId?: string | null;
  event: Omit<RunTransitionEvent, "operationId" | "at"> & { at?: string };
}

export interface OperationClaimResult {
  operation: OperationRecord;
  claimed: boolean;
}

export interface AtomicOperationCompletion {
  expectedRevision: number;
  operationId: string;
  attemptId?: string;
  completedAt: string;
  result: OperationResult;
  /** Bodies are written by the artifact store; these are the rows admitted by this commit. */
  artifacts?: ArtifactRecord[];
  /** Existing immutable bodies linked as evidence in this same transaction. */
  evidenceArtifacts?: string[];
  /** Existing immutable bodies linked as progress in this same transaction. */
  progressArtifacts?: string[];
  usage: UsageMeasurement;
  resources?: ResourceMeasurement;
  workspaceCheckpoint?: WorkspaceCheckpointRecord;
  /** Domain rows committed with the operation result, never as a second writer. */
  measurement?: MeasurementRecord;
  experiment?: ExperimentRecord;
  verification?: VerificationRecord;
  journal?: WorkflowCallRecord;
  /** Present only when this completion was materialized from one explicit source run. */
  replay?: OperationReplayRecord;
  /** New exact prefix length committed atomically with a replay hit. */
  replayMatchedCalls?: number;
  runStatus?: RunStatus;
  currentOperationId?: string | null;
  event: Omit<RunTransitionEvent, "operationId" | "attemptId" | "at"> & { at?: string };
}

interface AgentToolCommitBase {
  expectedRevision: number;
  agentSessionId: string;
  executionId: string;
  toolCallId: string;
  requestHash: string;
  response: JsonValue;
  committedAt: string;
}

export interface AgentProgressToolCommit extends AgentToolCommitBase {
  toolName: Exclude<AgentTerminalToolName, "finish_work">;
  progress: AgentProgress;
  progressEvent: AgentProgressEvent;
}

export interface AgentFinishToolCommit extends AgentToolCommitBase {
  toolName: "finish_work";
  finish: AgentFinishRecord;
}

export interface AgentMediatedToolCommit extends AgentToolCommitBase {
  toolName: AgentMediatedToolName;
  progress: AgentProgress;
}

export interface AgentYieldSettlementInput {
  expectedRevision: number;
  agentSessionId: string;
  executionId: string;
  meaningfulProgress: boolean;
  at: string;
}

export interface AgentInfrastructureRetryInput {
  expectedRevision: number;
  agentSessionId: string;
  executionId: string;
  reason: StructuredReason;
  meaningfulProgress: boolean;
  at: string;
}

export interface AgentInfrastructurePauseInput extends AgentInfrastructureRetryInput {}

export interface AgentToolCommitResult {
  receipt: AgentToolReceiptRecord;
  duplicate: boolean;
}

export interface AgentExecutionInputArtifact {
  id: string;
  artifact: ArtifactRef;
}

/** One logical-agent admission. Process/provider recovery reuses these rows. */
export interface AgentExecutionAdmission {
  expectedRevision: number;
  attempt: AttemptRecord;
  session: AgentSessionRecord;
  inputArtifacts: AgentExecutionInputArtifact[];
  event: RunTransitionEvent;
}

export interface AgentExecutionAdmissionResult {
  attempt: AttemptRecord;
  session: AgentSessionRecord;
  created: boolean;
}

export interface ControlAcknowledgementInput {
  requestId: string;
  expectedRevision: number;
  accepted: boolean;
  reason?: StructuredReason;
  acknowledgedAt: string;
}

export interface ApprovalControlResolution {
  approval: ApprovalRecord;
  acknowledgement: ControlAcknowledgement;
}

export interface CoordinatorOpenResult {
  run: RunRecord;
  disposition: CoordinatorOpenDisposition;
  runningOperationIds: string[];
}

