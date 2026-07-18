import { deepFreezeJson } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import type { WorkflowProductKind } from "../definition/workflow-language.js";
import type { WorkflowArtifactRecord } from "../persistence/run-database-types.js";
import type { JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { WorkflowEffectProductFactory } from "./products.js";

export interface WorkflowArtifactManifestEntry {
  path: string;
  productKind: WorkflowProductKind;
  artifact: WorkflowArtifactRecord;
}

export interface WorkflowArtifactManifest {
  entries: readonly WorkflowArtifactManifestEntry[];
  hash: string;
}

/** Safe filesystem segment for ordinary TypeScript artifact bundle keys. */
export const WORKFLOW_ARTIFACT_SEGMENT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

/** Convert one named artifact algebra into a canonical, authority-checked leaf manifest. */
export function workflowArtifactManifest(
  products: WorkflowEffectProductFactory,
  bundle: unknown,
): WorkflowArtifactManifest {
  if (!plainRecord(bundle)) throw new TypeError("Workflow artifact bundle must be a named object");
  const entries: WorkflowArtifactManifestEntry[] = [];
  const ancestors = new Set<object>();
  let nodes = 0;

  const visit = (value: unknown, currentPath: string, depth: number): void => {
    nodes++;
    if (depth > DEFINITION_LIMITS.structuralValueDepth
      || nodes > DEFINITION_LIMITS.structuralValueNodes) {
      throw new WorkflowArtifactManifestError(
        `Workflow artifact input ${currentPath} exceeds its structural limit`,
      );
    }
    if (value && typeof value === "object") {
      let attachable: ReturnType<WorkflowEffectProductFactory["attachableArtifact"]> | undefined;
      try {
        attachable = products.attachableArtifact(value);
      } catch (error) {
        if (products.authority.describe(value)) {
          throw new WorkflowArtifactManifestError(
            `Workflow artifact input ${currentPath} is not attachable`,
            { cause: error },
          );
        }
      }
      if (attachable) {
        entries.push(Object.freeze({
          path: currentPath,
          productKind: attachable.productKind,
          artifact: freezeArtifact(attachable.artifact),
        }));
        if (entries.length > DEFINITION_LIMITS.agentInputs) {
          throw new WorkflowArtifactManifestError(
            `Workflow artifact bundle exceeds ${DEFINITION_LIMITS.agentInputs} leaves`,
          );
        }
        return;
      }
    }

    if (Array.isArray(value)) {
      if (ancestors.has(value)) throw new WorkflowArtifactManifestError(`Workflow artifact input ${currentPath} is cyclic`);
      ancestors.add(value);
      try {
        for (let index = 0; index < value.length; index++) {
          visit(value[index], `${currentPath}/${String(index).padStart(6, "0")}`, depth + 1);
        }
      } finally {
        ancestors.delete(value);
      }
      return;
    }
    if (plainRecord(value)) {
      if (ancestors.has(value)) throw new WorkflowArtifactManifestError(`Workflow artifact input ${currentPath} is cyclic`);
      ancestors.add(value);
      try {
        for (const key of Object.keys(value).sort()) {
          assertSegment(key, `${currentPath}/${key}`);
          visit(value[key], `${currentPath}/${key}`, depth + 1);
        }
      } finally {
        ancestors.delete(value);
      }
      return;
    }
    throw new WorkflowArtifactManifestError(
      `Workflow artifact input ${currentPath} is plain ${value === null ? "null" : typeof value}`,
    );
  };

  for (const key of Object.keys(bundle).sort()) {
    assertSegment(key, key);
    visit(bundle[key], key, 1);
  }
  const frozenEntries = Object.freeze(entries);
  const hash = workflowArtifactManifestHash(entries);
  return Object.freeze({ entries: frozenEntries, hash });
}

export function workflowArtifactManifestHash(
  entries: readonly WorkflowArtifactManifestEntry[],
): string {
  return stableHash({
    entries: entries.map(entry => ({
      path: entry.path,
      productKind: entry.productKind,
      digest: entry.artifact.digest,
      kind: entry.artifact.kind,
      mediaType: entry.artifact.mediaType,
      bytes: entry.artifact.bytes,
    })),
  });
}

export class WorkflowArtifactManifestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowArtifactManifestError";
  }
}

function assertSegment(value: string, displayPath: string): void {
  if (!WORKFLOW_ARTIFACT_SEGMENT_PATTERN.test(value)) {
    throw new WorkflowArtifactManifestError(`Invalid workflow artifact segment ${displayPath}`);
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeArtifact(value: WorkflowArtifactRecord): WorkflowArtifactRecord {
  return deepFreezeJson(structuredClone(value) as unknown as JsonValue) as unknown as WorkflowArtifactRecord;
}
