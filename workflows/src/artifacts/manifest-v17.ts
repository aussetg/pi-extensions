import { deepFreezeJson } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import type { WorkflowV17ProductKind } from "../definition/workflow-language-v17.js";
import type { WorkflowArtifactV17Record } from "../persistence/run-database-v17-types.js";
import type { JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { WorkflowV17EffectProductFactory } from "./products-v17.js";

export interface WorkflowV17ArtifactManifestEntry {
  path: string;
  productKind: WorkflowV17ProductKind;
  artifact: WorkflowArtifactV17Record;
}

export interface WorkflowV17ArtifactManifest {
  formatVersion: 1;
  entries: readonly WorkflowV17ArtifactManifestEntry[];
  hash: string;
}

/** Safe filesystem segment for ordinary TypeScript artifact bundle keys. */
export const WORKFLOW_V17_ARTIFACT_SEGMENT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

/** Convert one named artifact algebra into a canonical, authority-checked leaf manifest. */
export function workflowV17ArtifactManifest(
  products: WorkflowV17EffectProductFactory,
  bundle: unknown,
): WorkflowV17ArtifactManifest {
  if (!plainRecord(bundle)) throw new TypeError("Workflow v17 artifact bundle must be a named object");
  const entries: WorkflowV17ArtifactManifestEntry[] = [];
  const ancestors = new Set<object>();
  let nodes = 0;

  const visit = (value: unknown, currentPath: string, depth: number): void => {
    nodes++;
    if (depth > DEFINITION_LIMITS.structuralValueDepth
      || nodes > DEFINITION_LIMITS.structuralValueNodes) {
      throw new WorkflowV17ArtifactManifestError(
        `Workflow v17 artifact input ${currentPath} exceeds its structural limit`,
      );
    }
    if (value && typeof value === "object") {
      try {
        const attachable = products.attachableArtifact(value);
        entries.push(Object.freeze({
          path: currentPath,
          productKind: attachable.productKind,
          artifact: freezeArtifact(attachable.artifact),
        }));
        if (entries.length > DEFINITION_LIMITS.agentInputs) {
          throw new WorkflowV17ArtifactManifestError(
            `Workflow v17 artifact bundle exceeds ${DEFINITION_LIMITS.agentInputs} leaves`,
          );
        }
        return;
      } catch (error) {
        if (products.authority.describe(value)) {
          throw new WorkflowV17ArtifactManifestError(
            `Workflow v17 artifact input ${currentPath} is not attachable`,
            { cause: error },
          );
        }
      }
    }

    if (Array.isArray(value)) {
      if (ancestors.has(value)) throw new WorkflowV17ArtifactManifestError(`Workflow v17 artifact input ${currentPath} is cyclic`);
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
      if (ancestors.has(value)) throw new WorkflowV17ArtifactManifestError(`Workflow v17 artifact input ${currentPath} is cyclic`);
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
    throw new WorkflowV17ArtifactManifestError(
      `Workflow v17 artifact input ${currentPath} is plain ${value === null ? "null" : typeof value}`,
    );
  };

  for (const key of Object.keys(bundle).sort()) {
    assertSegment(key, key);
    visit(bundle[key], key, 1);
  }
  const frozenEntries = Object.freeze(entries);
  const hash = workflowV17ArtifactManifestHash(entries);
  return Object.freeze({ formatVersion: 1, entries: frozenEntries, hash });
}

export function workflowV17ArtifactManifestHash(
  entries: readonly WorkflowV17ArtifactManifestEntry[],
): string {
  return stableHash({
    formatVersion: 1,
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

export class WorkflowV17ArtifactManifestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowV17ArtifactManifestError";
  }
}

function assertSegment(value: string, displayPath: string): void {
  if (!WORKFLOW_V17_ARTIFACT_SEGMENT_PATTERN.test(value)) {
    throw new WorkflowV17ArtifactManifestError(`Invalid workflow v17 artifact segment ${displayPath}`);
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeArtifact(value: WorkflowArtifactV17Record): WorkflowArtifactV17Record {
  return deepFreezeJson(structuredClone(value) as unknown as JsonValue) as unknown as WorkflowArtifactV17Record;
}
