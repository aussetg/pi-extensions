import type {
  WorkflowOperationV17Kind,
  WorkflowOperationV17Record,
  WorkflowScopeCallV17Record,
  WorkflowScopeV17Kind,
  WorkflowStructuralJoinLaneV17Record,
  WorkflowStructuralJoinV17Record,
} from "../persistence/run-database-v17-types.js";
import type { JsonObject, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";

export const WORKFLOW_V17_ROOT_SCOPE_SEED = stableHash({
  formatVersion: 1,
  kind: "workflow-v17-root-scope",
});

export interface WorkflowV17CausalOperationIdentity {
  path: string;
  kind: WorkflowOperationV17Kind;
  semanticInputHash: string;
}

export function workflowV17LaneSeed(input: {
  parentPreviousCallKey: string;
  ownerOperationPath: string;
  ownerKind: "parallel" | "map" | "candidate";
  childKind: Exclude<WorkflowScopeV17Kind, "root">;
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
    kind: "workflow-v17-lane-seed",
    parentPreviousCallKey: input.parentPreviousCallKey,
    ownerOperationPath: input.ownerOperationPath,
    ownerKind: input.ownerKind,
    childKind: input.childKind,
    laneKey: input.laneKey ?? "candidate",
  });
}

export function workflowV17FreshCallKey(input: {
  runId: string;
  previousCallKey: string;
  operation: WorkflowV17CausalOperationIdentity;
  semanticKey: string;
  outcome: WorkflowScopeCallV17Record["outcome"];
  completionAuthority: WorkflowScopeCallV17Record["completionAuthority"];
  replayPolicy: WorkflowScopeCallV17Record["replayPolicy"];
  result: JsonValue | JsonObject;
}): string {
  if (input.completionAuthority === "structural-join") {
    throw new TypeError("Structural calls require workflowV17StructuralJoinKey()");
  }
  return stableHash({
    formatVersion: 1,
    kind: "workflow-v17-call",
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

export function workflowV17StructuralJoinKey(input: {
  previousCallKey: string;
  operation: WorkflowV17CausalOperationIdentity;
  semanticKey: string;
  policyHash: string;
  outputOrder: readonly string[];
  lanes: readonly Pick<WorkflowStructuralJoinLaneV17Record,
    "laneKey" | "terminalKey" | "outcome">[];
  result: JsonValue;
}): string {
  if (input.operation.kind !== "parallel" && input.operation.kind !== "map"
    && input.operation.kind !== "candidate") {
    throw new TypeError(`Workflow v17 ${input.operation.kind} is not structural`);
  }
  return stableHash({
    formatVersion: 1,
    kind: "workflow-v17-structural-join",
    previousCallKey: input.previousCallKey,
    operation: causalOperation(input.operation),
    semanticKey: input.semanticKey,
    policyHash: input.policyHash,
    outputOrder: [...input.outputOrder],
    lanes: input.lanes.map((lane) => ({
      laneKey: lane.laneKey,
      terminalKey: lane.terminalKey,
      outcome: lane.outcome,
    })),
    resultHash: stableHash(input.result),
  });
}

export function workflowV17OperationIdentity(
  operation: Pick<WorkflowOperationV17Record, "path" | "kind" | "semanticInputHash">,
): WorkflowV17CausalOperationIdentity {
  return {
    path: operation.path,
    kind: operation.kind,
    semanticInputHash: operation.semanticInputHash,
  };
}

export function sameWorkflowV17Join(
  left: WorkflowStructuralJoinV17Record,
  right: {
    kind: WorkflowStructuralJoinV17Record["kind"];
    previousCallKey: string;
    policyHash: string;
    outputOrder: readonly string[];
    joinKey: string;
    lanes: readonly Pick<WorkflowStructuralJoinLaneV17Record,
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

function causalOperation(value: WorkflowV17CausalOperationIdentity) {
  return {
    path: value.path,
    kind: value.kind,
    semanticInputHash: value.semanticInputHash,
  };
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
