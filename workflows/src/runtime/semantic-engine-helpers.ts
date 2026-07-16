import { DEFINITION_LIMITS } from "../definition/limits.js";
import { RunDatabaseStateError } from "../persistence/run-database.js";
import { sha256, stableHash } from "../utils/hashes.js";
import type { OperationKind, OperationRecord } from "./durable-types.js";
import { SemanticOperationError, type SemanticEngineInvocation } from "./semantic-engine-types.js";
import type { StructuralPreclaim } from "./semantic-structured-concurrency.js";

export function semanticInvocationHash(invocation: SemanticEngineInvocation): string {
  return stableHash({
    workflowId: invocation.workflowId,
    definitionHash: invocation.definitionHash,
    input: invocation.input,
    inputHash: invocation.inputHash,
  });
}

export function semanticOperationPath(parent: string, kind: OperationKind, id: string): string {
  return `${parent}/${kind}:${id}`;
}

export function deterministicSemanticId(
  prefix: "operation" | "checkpoint",
  runId: string,
  pathValue: string,
): string {
  return `${prefix}_${sha256(`${runId}\0${pathValue}`).slice(7, 39)}`;
}

export function assertSemanticOperationIdentity(
  operation: OperationRecord,
  parentOperationId: string | undefined,
  kind: OperationKind,
  sourceId: string,
  semanticInputHash: string,
): void {
  if (
    operation.parentOperationId !== parentOperationId
    || operation.kind !== kind
    || operation.sourceId !== sourceId
    || operation.semanticInputHash !== semanticInputHash
  ) throw new RunDatabaseStateError(`Operation path ${operation.path} changed semantic identity across restart`);
}

export function assertPreclaimedSemanticOperation(
  operation: OperationRecord,
  parentOperationId: string,
  spec: StructuralPreclaim,
): void {
  if (
    operation.parentOperationId !== parentOperationId
    || operation.kind !== "stage"
    || operation.path !== spec.path
    || operation.sourceId !== spec.sourceId
    || operation.semanticInputHash !== spec.semanticInputHash
  ) throw new RunDatabaseStateError(`Structural queue row ${operation.path} changed semantic identity`);
}

export function recordedSemanticFailure(operation: OperationRecord): SemanticOperationError {
  return new SemanticOperationError(
    operation,
    operation.reason?.summary ?? `Operation ${operation.path} previously failed`,
  );
}

export function linkedSemanticController(parent: AbortSignal): AbortController & { dispose(): void } {
  const controller = new AbortController() as AbortController & { dispose(): void };
  const abort = () => { if (!controller.signal.aborted) controller.abort(parent.reason); };
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  controller.dispose = () => parent.removeEventListener("abort", abort);
  return controller;
}

export function boundedSemanticPollInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < 5 || value > 1_000) {
    throw new TypeError("Semantic control poll interval must be 5–1000ms");
  }
  return value;
}

export function boundedOperationAdmissionLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFINITION_LIMITS.semanticOperations) {
    throw new TypeError(`Semantic operation admission limit must be 1–${DEFINITION_LIMITS.semanticOperations}`);
  }
  return value;
}
