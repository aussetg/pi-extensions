import type { SafetyConfiguration } from "../runtime/durable-types.js";
import {
  unitResourcePolicy,
  type UnitResourcePolicy,
  type WorkflowUnitKind,
} from "../systemd/unit-properties.js";

type CommandUnitKind = Extract<WorkflowUnitKind, "command" | "verification" | "measurement">;

export interface CommandExecutionLimits {
  resourcePolicy: UnitResourcePolicy;
  timeoutMs: number;
  outputBytes: number;
}

/** Resolve run-owned resources and cap reviewed command time/output authority. */
export function resolveCommandExecutionLimits(
  kind: CommandUnitKind,
  safety: SafetyConfiguration,
  requestedTimeoutMs: number,
  requestedOutputBytes: number,
): CommandExecutionLimits {
  positiveInteger(requestedTimeoutMs, "Requested command timeout");
  positiveInteger(requestedOutputBytes, "Requested command output limit");
  positiveInteger(safety?.commandTimeoutMs, "Run command timeout");
  positiveInteger(safety?.outputBytes, "Run command output limit");
  return {
    resourcePolicy: unitResourcePolicy(kind, safety),
    timeoutMs: Math.min(requestedTimeoutMs, safety.commandTimeoutMs),
    outputBytes: Math.min(requestedOutputBytes, safety.outputBytes),
  };
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} is invalid`);
}
