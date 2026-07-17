import fs from "node:fs";
import path from "node:path";
import { canonicalJsonObject, deepFreezeJson } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS, FLOW_NAME_PATTERN } from "../definition/limits.js";
import type { WorkflowNamespace } from "../definition/types.js";
import type { JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { readBoundedTextFile } from "../persistence/safe-paths.js";

export const WORKFLOW_V17_REGISTRY_POLICY_FILE = "registry.json";

export type WorkflowV17Exposure = "human" | "model";

export interface WorkflowV17RegistryPolicySnapshot {
  formatVersion: 1;
  namespace: WorkflowNamespace;
  path: string;
  source: "default" | "file";
  model: string[];
  hash: string;
}

const POLICY_BYTES = 64 * 1024;
const POLICY_FIELDS = new Set(["formatVersion", "model"]);

/**
 * Read one namespace-local exposure policy. Absence is deliberately the safe, human-only policy.
 * The hash names semantic policy contents, not the machine-local path or whether an empty file exists.
 */
export async function readWorkflowV17RegistryPolicy(
  directoryInput: string,
  namespace: WorkflowNamespace,
): Promise<WorkflowV17RegistryPolicySnapshot> {
  const directory = path.resolve(directoryInput);
  const policyPath = path.join(directory, WORKFLOW_V17_REGISTRY_POLICY_FILE);
  let source: string;
  try {
    const stat = await fs.promises.lstat(policyPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Workflow registry policy must be a regular non-symlink file");
    }
    source = await readBoundedTextFile(policyPath, POLICY_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return policySnapshot(namespace, policyPath, "default", []);
    }
    throw error;
  }

  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch (error) { throw new Error(`Workflow registry policy is not JSON: ${errorMessage(error)}`); }
  const record = strictRecord(parsed, POLICY_FIELDS, "workflow registry policy");
  if (record.formatVersion !== 1) throw new Error("Workflow registry policy formatVersion must be 1");
  if (!Array.isArray(record.model)) throw new Error("Workflow registry policy model must be an array");
  if (record.model.length > DEFINITION_LIMITS.filesPerNamespace) {
    throw new Error(`Workflow registry policy exceeds ${DEFINITION_LIMITS.filesPerNamespace} model entries`);
  }
  const seen = new Set<string>();
  const model = record.model.map((value, index) => {
    if (typeof value !== "string" || !FLOW_NAME_PATTERN.test(value)) {
      throw new Error(`Workflow registry policy model[${index}] is invalid`);
    }
    if (seen.has(value)) throw new Error(`Workflow registry policy contains duplicate model entry ${value}`);
    seen.add(value);
    return value;
  }).sort();
  return policySnapshot(namespace, policyPath, "file", model);
}

export function defaultWorkflowV17RegistryPolicy(
  directoryInput: string,
  namespace: WorkflowNamespace,
): WorkflowV17RegistryPolicySnapshot {
  return policySnapshot(
    namespace,
    path.join(path.resolve(directoryInput), WORKFLOW_V17_REGISTRY_POLICY_FILE),
    "default",
    [],
  );
}

export function workflowV17Exposure(
  policy: WorkflowV17RegistryPolicySnapshot,
  name: string,
): WorkflowV17Exposure {
  return policy.model.includes(name) ? "model" : "human";
}

function policySnapshot(
  namespace: WorkflowNamespace,
  policyPath: string,
  source: "default" | "file",
  model: string[],
): WorkflowV17RegistryPolicySnapshot {
  const semantic = { formatVersion: 1 as const, namespace, model: [...model].sort() };
  const snapshot = {
    ...semantic,
    path: path.resolve(policyPath),
    source,
    hash: stableHash(semantic),
  };
  return deepFreezeJson(canonicalJsonObject(snapshot, {
    maxBytes: POLICY_BYTES,
    maxDepth: 8,
    maxNodes: DEFINITION_LIMITS.filesPerNamespace + 16,
    maxStringScalars: 4_096,
  }) as JsonValue) as unknown as WorkflowV17RegistryPolicySnapshot;
}

function strictRecord(
  value: unknown,
  fields: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!fields.has(key)) throw new Error(`${label} contains unknown field ${key}`);
  return record;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
