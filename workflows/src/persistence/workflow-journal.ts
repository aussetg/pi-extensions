import type { DatabaseSync } from "./sqlite.js";
import { stableHash } from "../utils/hashes.js";
import type {
  OperationRecord,
  WorkflowCallRecord,
} from "../runtime/durable-types.js";
import {
  requiredNumber,
  requiredString,
  type SqlRow,
} from "./run-database-codec.js";

export const WORKFLOW_JOURNAL_ROOT_KEY = stableHash({
  formatVersion: 1,
  kind: "workflow-journal-root",
});

export interface WorkflowCallKeyInput {
  previousJournalKey: string;
  operation: Pick<OperationRecord, "path" | "sourceId" | "kind" | "semanticInputHash">;
  semanticKey: string;
}

/** Chain one semantic call without admitting timestamps or host execution policy. */
export function buildWorkflowCallKey(input: WorkflowCallKeyInput): string {
  return stableHash({
    formatVersion: 1,
    previousJournalKey: input.previousJournalKey,
    operation: {
      path: input.operation.path,
      sourceId: input.operation.sourceId,
      kind: input.operation.kind,
      semanticInputHash: input.operation.semanticInputHash,
    },
    semanticKey: input.semanticKey,
  });
}

export interface WorkflowJournalPlanEntry {
  operationId: string;
  ordinal: number;
  previousJournalKey: string;
  callKey: string;
}

export interface WorkflowJournalPlan {
  entries: WorkflowJournalPlanEntry[];
  maximumOrdinal: number;
  changed: boolean;
}

/** Rebuild the chain in deterministic operation-tree order after concurrency settles. */
export function planWorkflowJournal(database: DatabaseSync): WorkflowJournalPlan {
  const rows = database.prepare(`
    SELECT
      call.operation_id, call.ordinal AS call_ordinal, call.previous_journal_key, call.call_key,
      call.semantic_key, operation.ordinal AS operation_ordinal, operation.path,
      operation.source_id, operation.kind, operation.semantic_input_hash
    FROM workflow_calls call
    JOIN operations operation ON operation.operation_id = call.operation_id
    ORDER BY operation.ordinal
  `).all() as SqlRow[];
  let previousJournalKey = WORKFLOW_JOURNAL_ROOT_KEY;
  let changed = false;
  let maximumOrdinal = -1;
  const entries = rows.map((row): WorkflowJournalPlanEntry => {
    const ordinal = requiredNumber(row, "operation_ordinal");
    maximumOrdinal = Math.max(maximumOrdinal, requiredNumber(row, "call_ordinal"), ordinal);
    const callKey = buildWorkflowCallKey({
      previousJournalKey,
      operation: {
        path: requiredString(row, "path"),
        sourceId: requiredString(row, "source_id"),
        kind: requiredString(row, "kind") as OperationRecord["kind"],
        semanticInputHash: requiredString(row, "semantic_input_hash"),
      },
      semanticKey: requiredString(row, "semantic_key"),
    });
    const entry = {
      operationId: requiredString(row, "operation_id"),
      ordinal,
      previousJournalKey,
      callKey,
    };
    changed ||= requiredNumber(row, "call_ordinal") !== ordinal
      || requiredString(row, "previous_journal_key") !== previousJournalKey
      || requiredString(row, "call_key") !== callKey;
    previousJournalKey = callKey;
    return entry;
  });
  return { entries, maximumOrdinal, changed };
}

export function applyWorkflowJournalPlan(database: DatabaseSync, plan: WorkflowJournalPlan): void {
  if (!plan.changed) return;
  const offset = plan.maximumOrdinal + plan.entries.length + 1;
  if (!Number.isSafeInteger(offset)) throw new RangeError("Workflow journal ordinal offset overflow");
  database.prepare("UPDATE workflow_calls SET ordinal = ordinal + ?").run(offset);
  const updateCall = database.prepare(`
    UPDATE workflow_calls SET ordinal = ?, previous_journal_key = ?, call_key = ?
    WHERE operation_id = ?
  `);
  const updateOperation = database.prepare("UPDATE operations SET call_key = ? WHERE operation_id = ?");
  for (const entry of plan.entries) {
    updateCall.run(entry.ordinal, entry.previousJournalKey, entry.callKey, entry.operationId);
    updateOperation.run(entry.callKey, entry.operationId);
  }
}

export function assertWorkflowCallChain(
  calls: readonly WorkflowCallRecord[],
  operations: ReadonlyMap<string, OperationRecord>,
): void {
  let previousJournalKey = WORKFLOW_JOURNAL_ROOT_KEY;
  let previousOrdinal = -1;
  for (const call of calls) {
    const operation = operations.get(call.operationId);
    if (!operation) throw new Error(`Workflow journal names missing operation ${call.operationId}`);
    if (call.ordinal <= previousOrdinal || call.ordinal !== operation.ordinal) {
      throw new Error(`Workflow journal ordinal ${call.ordinal} is not in stable operation order`);
    }
    const expected = buildWorkflowCallKey({ previousJournalKey, operation, semanticKey: call.semanticKey });
    if (call.previousJournalKey !== previousJournalKey || call.callKey !== expected || operation.callKey !== expected) {
      throw new Error(`Workflow journal chain is corrupt at ordinal ${call.ordinal}`);
    }
    previousOrdinal = call.ordinal;
    previousJournalKey = call.callKey;
  }
}


