import type {
  WorkflowOperationKind,
  WorkflowOperationRecord,
  WorkflowScopeCallRecord,
  WorkflowScopeKind,
  WorkflowStructuralJoinLaneRecord,
  WorkflowStructuralJoinRecord,
} from "../persistence/run-database-types.js";
import type { JsonObject, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";

export const WORKFLOW_ROOT_SCOPE_SEED = stableHash({
  formatVersion: 1,
  kind: "workflow-root-scope",
});

export interface WorkflowCausalOperationIdentity {
  path: string;
  kind: WorkflowOperationKind;
  semanticInputHash: string;
}

export function workflowLaneSeed(input: {
  parentPreviousCallKey: string;
  ownerOperationPath: string;
  ownerKind: "parallel" | "map" | "candidate";
  childKind: Exclude<WorkflowScopeKind, "root">;
  laneKey?: string;
}): string {
  const expectedChild = input.ownerKind === "parallel"
    ? "parallel-branch"
    : input.ownerKind === "map"
      ? "map-item"
      : "candidate-body";
  if (input.childKind !== expectedChild) {
    throw new TypeError(`Workflow v17 ${input.ownerKind} cannot own ${input.childKind}`);
  }
  if (input.ownerKind === "candidate" && input.laneKey !== undefined) {
    throw new TypeError("Workflow v17 candidate body does not have an author lane key");
  }
  if (input.ownerKind !== "candidate" && !input.laneKey) {
    throw new TypeError(`Workflow v17 ${input.ownerKind} lane requires a key`);
  }
  return stableHash({
    formatVersion: 1,
    kind: "workflow-lane-seed",
    parentPreviousCallKey: input.parentPreviousCallKey,
    ownerOperationPath: input.ownerOperationPath,
    ownerKind: input.ownerKind,
    childKind: input.childKind,
    laneKey: input.laneKey ?? "candidate",
  });
}

export function workflowFreshCallKey(input: {
  runId: string;
  previousCallKey: string;
  operation: WorkflowCausalOperationIdentity;
  semanticKey: string;
  outcome: WorkflowScopeCallRecord["outcome"];
  completionAuthority: WorkflowScopeCallRecord["completionAuthority"];
  replayPolicy: WorkflowScopeCallRecord["replayPolicy"];
  result: JsonValue | JsonObject;
}): string {
  if (input.completionAuthority === "structural-join") {
    throw new TypeError("Structural calls require workflowStructuralJoinKey()");
  }
  return stableHash({
    formatVersion: 1,
    kind: "workflow-call",
    runId: input.runId,
    previousCallKey: input.previousCallKey,
    operation: causalOperation(input.operation),
    semanticKey: input.semanticKey,
    outcome: input.outcome,
    completionAuthority: input.completionAuthority,
    replayPolicy: input.replayPolicy,
    resultHash: stableHash(input.result),
  });
}

export function workflowStructuralJoinKey(input: {
  previousCallKey: string;
  operation: WorkflowCausalOperationIdentity;
  semanticKey: string;
  policyHash: string;
  outputOrder: readonly string[];
  lanes: readonly Pick<WorkflowStructuralJoinLaneRecord,
    "laneKey" | "terminalKey" | "outcome">[];
} & (
  | { outcome?: "success"; result: JsonValue; failure?: never }
  | { outcome: "failure"; result?: never; failure: JsonObject }
)): string {
  if (input.operation.kind !== "parallel" && input.operation.kind !== "map"
    && input.operation.kind !== "candidate") {
    throw new TypeError(`Workflow v17 ${input.operation.kind} is not structural`);
  }
  const outcome = input.outcome ?? "success";
  const terminal = outcome === "success" ? input.result : input.failure;
  return stableHash({
    formatVersion: 1,
    kind: "workflow-structural-join",
    previousCallKey: input.previousCallKey,
    operation: causalOperation(input.operation),
    semanticKey: input.semanticKey,
    policyHash: input.policyHash,
    outcome,
    outputOrder: [...input.outputOrder],
    lanes: input.lanes.map((lane) => ({
      laneKey: lane.laneKey,
      terminalKey: lane.terminalKey,
      outcome: lane.outcome,
    })),
    resultHash: stableHash(terminal),
  });
}

export function workflowOperationIdentity(
  operation: Pick<WorkflowOperationRecord, "path" | "kind" | "semanticInputHash">,
): WorkflowCausalOperationIdentity {
  return {
    path: operation.path,
    kind: operation.kind,
    semanticInputHash: operation.semanticInputHash,
  };
}

export function sameWorkflowJoin(
  left: WorkflowStructuralJoinRecord,
  right: {
    kind: WorkflowStructuralJoinRecord["kind"];
    previousCallKey: string;
    policyHash: string;
    outputOrder: readonly string[];
    joinKey: string;
    lanes: readonly Pick<WorkflowStructuralJoinLaneRecord,
      "laneKey" | "terminalKey" | "outcome">[];
  },
): boolean {
  return left.kind === right.kind
    && left.previousCallKey === right.previousCallKey
    && left.policyHash === right.policyHash
    && left.joinKey === right.joinKey
    && equalStrings(left.outputOrder, right.outputOrder)
    && left.lanes.length === right.lanes.length
    && left.lanes.every((lane, index) => {
      const current = right.lanes[index];
      return current !== undefined
        && lane.laneKey === current.laneKey
        && lane.terminalKey === current.terminalKey
        && lane.outcome === current.outcome;
    });
}

function causalOperation(value: WorkflowCausalOperationIdentity) {
  return {
    path: value.path,
    kind: value.kind,
    semanticInputHash: value.semanticInputHash,
  };
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
