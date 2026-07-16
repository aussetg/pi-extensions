import { createOpaqueArtifactRef, describeOpaqueArtifactRef } from "../artifacts/store.js";
import type { CandidateWorkspaceCapability, CandidateWorkspaceHandle } from "../candidates/store.js";
import { DEFINITION_LIMITS, FLOW_NAME_PATTERN } from "../definition/limits.js";
import {
  zeroUsage,
  type AgentProgress,
  type ArtifactRef,
  type OperationResult,
  type StructuredReason,
} from "../runtime/durable-types.js";
import type { JsonSchema, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import type {
  AgentExecutionResult,
  AgentWorkspaceHandle,
} from "./executor.js";
import type {
  PersistedWorkflowExecutionResources,
  PreparedWorkflowExecutionResources,
  ResolvedAgentSelection,
} from "./resources.js";

export type SemanticAgentExecutionResources =
  | PreparedWorkflowExecutionResources
  | PersistedWorkflowExecutionResources;

export interface NormalizedAgentOptions {
  prompt: string;
  profile: string;
  inputs: Array<{ id: string; opaque: object; artifact: ArtifactRef }>;
  outputSchema?: JsonSchema;
  workspace?: CandidateWorkspaceCapability;
  network: "none" | "research";
  resultMode: "value" | "artifact" | "value-and-artifact";
}

/** A structured provider error whose durable reason survives collect mode. */
export class SemanticAgentExecutionError extends Error {
  constructor(readonly reason: StructuredReason) {
    super(reason.summary);
    this.name = "SemanticAgentExecutionError";
  }
}

export function normalizeAgentOptions(value: unknown): NormalizedAgentOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("flow.agent options must be an object");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["title", "profile", "prompt", "inputs", "outputSchema", "workspace", "network", "resultMode"]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`flow.agent options contain unknown field ${key}`);
  if (typeof record.profile !== "string" || !record.profile.includes(":")) throw new TypeError("flow.agent profile selector is invalid");
  const prompt = boundedText(record.prompt, "agent prompt", DEFINITION_LIMITS.agentPromptScalars);
  const network = record.network ?? "none";
  if (network !== "none" && network !== "research") throw new TypeError("flow.agent network is invalid");
  const resultMode = record.resultMode ?? "value";
  if (resultMode !== "value" && resultMode !== "artifact" && resultMode !== "value-and-artifact") {
    throw new TypeError("flow.agent resultMode is invalid");
  }
  const rawInputs = record.inputs ?? [];
  if (!Array.isArray(rawInputs) || rawInputs.length > DEFINITION_LIMITS.agentInputs) throw new TypeError("flow.agent inputs are invalid");
  const ids = new Set<string>();
  const inputs = rawInputs.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError(`flow.agent input ${index} is invalid`);
    const input = entry as Record<string, unknown>;
    if (Object.keys(input).sort().join(",") !== "artifact,id") throw new TypeError(`flow.agent input ${index} has invalid fields`);
    if (typeof input.id !== "string" || !FLOW_NAME_PATTERN.test(input.id) || ids.has(input.id)) {
      throw new TypeError(`flow.agent input ${index} has an invalid or duplicate id`);
    }
    ids.add(input.id);
    const artifact = describeOpaqueArtifactRef(input.artifact);
    if (!artifact) throw new TypeError(`flow.agent input ${input.id} is not an opaque artifact reference`);
    return { id: input.id, opaque: input.artifact as object, artifact };
  }).sort((left, right) => left.id.localeCompare(right.id));
  let outputSchema: JsonSchema | undefined;
  if (record.outputSchema !== undefined) {
    if (!record.outputSchema || typeof record.outputSchema !== "object" || Array.isArray(record.outputSchema)) {
      throw new TypeError("flow.agent outputSchema must be an object schema");
    }
    outputSchema = structuredClone(record.outputSchema as JsonSchema);
  }
  if (record.title !== undefined) boundedText(record.title, "agent title", DEFINITION_LIMITS.titleScalars);
  return {
    profile: record.profile,
    prompt,
    inputs,
    ...(outputSchema ? { outputSchema } : {}),
    ...(record.workspace !== undefined ? { workspace: record.workspace as CandidateWorkspaceCapability } : {}),
    network,
    resultMode,
  };
}

export function exactAgentSelection(
  resources: SemanticAgentExecutionResources,
  sourceId: string,
): ResolvedAgentSelection {
  const matches = resources.agentSelections.filter((selection) => selection.operationId === sourceId);
  if (matches.length !== 1) throw new Error(`Agent ${sourceId} has no unique pinned authority`);
  return matches[0]!;
}

export function logicalAgentIds(runId: string, operationId: string) {
  const body = stableHash({ formatVersion: 1, runId, operationId, kind: "logical-agent" }).slice(7, 39);
  return {
    agentSessionId: `agent_session_${body}`,
    attemptId: `attempt_${body}`,
    executionId: `execution_${body}`,
  };
}

export function candidateAgentWorkspace(handle: CandidateWorkspaceHandle): AgentWorkspaceHandle {
  return {
    mode: "candidate",
    root: handle.root,
    cwd: handle.cwd,
    preTreeHash: handle.ref.treeHash,
    workspace: handle.ref,
  };
}

export function resultFromFinish(
  mode: NormalizedAgentOptions["resultMode"],
  value: JsonValue | undefined,
  artifacts: ArtifactRef[],
): OperationResult {
  return {
    ...(mode === "artifact" ? {} : { value }),
    artifacts: artifacts.map((artifact) => ({ ...artifact })),
  };
}

export function workflowAgentValue(mode: NormalizedAgentOptions["resultMode"], result: OperationResult): unknown {
  if (mode === "value") return result.value;
  const artifact = result.artifacts[0];
  if (!artifact) throw new Error(`Completed ${mode} agent has no output artifact`);
  const opaque = createOpaqueArtifactRef(artifact);
  if (mode === "artifact") return opaque;
  const workspaceCheckpoint = result.artifacts.find((entry) => entry.kind === "workspace-checkpoint");
  return Object.freeze({
    value: result.value,
    artifact: opaque,
    ...(workspaceCheckpoint
      ? { workspaceCheckpointArtifact: createOpaqueArtifactRef(workspaceCheckpoint) }
      : {}),
  });
}

export function agentExecutionFailure(
  result: Exclude<AgentExecutionResult, { outcome: "finished" }>,
  operationId: string,
): Error {
  if (result.outcome === "failed" || result.outcome === "paused") return new SemanticAgentExecutionError(result.reason);
  return new SemanticAgentExecutionError(("reason" in result ? result.reason : undefined) ?? {
    category: "control",
    code: result.outcome === "yielded" ? "agent-receiptless-yield" : "agent-stopped",
    summary: result.outcome === "yielded" ? "Agent yielded without finish_work" : "Agent execution stopped",
    retryable: result.outcome === "yielded",
    operationId,
  });
}

export function emptyAgentProgress(at: string): AgentProgress {
  return {
    metrics: [],
    usage: zeroUsage(),
    modelTurn: 0,
    toolCount: 0,
    retries: 0,
    workspaceChanged: false,
    workspaceChangeCount: 0,
    recentWorkspaceChanges: [],
    updatedAt: at,
  };
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} contains disallowed control characters`);
  }
  return value;
}
