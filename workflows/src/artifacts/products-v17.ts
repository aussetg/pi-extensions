import { canonicalJsonObject, canonicalJsonValue, deepFreezeJson } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import type {
  WorkflowV17ProductIdentity,
  WorkflowV17ProductKind,
} from "../definition/workflow-language-v17.js";
import type { WorkflowArtifactV17Record } from "../persistence/run-database-v17-types.js";
import type { JsonObject, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import {
  WorkflowV17ControlAuthorityRegistry,
  type WorkflowV17ControlAuthorityDescription,
} from "../runtime/control-authority-v17.js";
import { WorkflowV17ArtifactStore } from "./store-v17.js";

const AUTHORITY_ID = /^[a-z][a-z0-9-]{0,127}$/u;
const ATTACHABLE_PRODUCTS = new Set<WorkflowV17ProductKind>([
  "agent-result", "command-result", "verification", "measurement",
]);

const JSON_LIMITS = {
  maxBytes: DEFINITION_LIMITS.structuralValueBytes,
  maxDepth: DEFINITION_LIMITS.structuralValueDepth,
  maxNodes: DEFINITION_LIMITS.structuralValueNodes,
  maxStringScalars: DEFINITION_LIMITS.structuralStringScalars,
} as const;

export interface WorkflowV17ArtifactPrivateAuthority {
  formatVersion: 1;
  runId: string;
  artifact: WorkflowArtifactV17Record;
  recordHash: string;
}

export interface WorkflowV17EffectProductPrivateAuthority {
  formatVersion: 1;
  runId: string;
  kind: Exclude<WorkflowV17ProductKind, "artifact">;
  authorityId: string;
  artifactDigest?: string;
  bindingHash: string;
}

export interface CreateWorkflowV17AgentResult {
  authorityId: string;
  output: JsonObject;
  published?: readonly object[];
  checkpoint?: object;
}

export interface CreateWorkflowV17CommandResult {
  authorityId: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  output: JsonValue;
  stderrPreview?: string;
}

export interface CreateWorkflowV17Verification {
  authorityId: string;
  receiptId: string;
  status: "passed" | "failed" | "blocked";
  evidence?: JsonObject;
}

export interface CreateWorkflowV17Measurement {
  authorityId: string;
  measurementId: string;
  observations: JsonObject;
  diagnostics?: object;
}

/** Mints the exact public products from canonical schema-4 artifact evidence. */
export class WorkflowV17EffectProductFactory {
  private readonly artifacts = new Map<string, object>();
  private readonly products = new Map<string, { value: object; authorityHash: string }>();

  constructor(
    readonly authority: WorkflowV17ControlAuthorityRegistry,
    readonly store: WorkflowV17ArtifactStore,
  ) {}

  artifact(recordValue: WorkflowArtifactV17Record): object {
    const record = this.requireStoredArtifact(recordValue);
    const existing = this.artifacts.get(record.digest);
    if (existing) return existing;
    const authorityId = `artifact-${record.digest.slice(7)}`;
    const privateAuthority = freezePrivate<WorkflowV17ArtifactPrivateAuthority>({
      formatVersion: 1,
      runId: this.store.runId,
      artifact: structuredClone(record),
      recordHash: stableHash(record),
    });
    const identity: WorkflowV17ProductIdentity = {
      formatVersion: 1,
      kind: "artifact",
      authorityId,
      authorityHash: stableHash({
        formatVersion: 1,
        kind: "workflow-v17-artifact-authority",
        runId: this.store.runId,
        recordHash: privateAuthority.recordHash,
      }),
    };
    const value = this.authority.product(identity, {}, privateAuthority);
    this.artifacts.set(record.digest, value);
    return value;
  }

  async agentResult(input: CreateWorkflowV17AgentResult): Promise<object> {
    const output = canonicalJsonObject(input.output, JSON_LIMITS);
    const stored = await this.store.putJson({ kind: "agent-output", value: output });
    const artifact = this.artifact(stored.record);
    const published = Object.freeze((input.published ?? []).map((value, index) =>
      this.requireArtifactValue(value, `agent published artifact ${index}`)));
    const checkpoint = input.checkpoint === undefined
      ? undefined
      : this.requireArtifactValue(input.checkpoint, "agent workspace checkpoint");
    return this.product("agent-result", input.authorityId, {
      output,
      artifact,
      published,
      ...(checkpoint ? { checkpoint } : {}),
    }, artifact);
  }

  async commandResult(input: CreateWorkflowV17CommandResult): Promise<object> {
    if (typeof input.ok !== "boolean" || !Number.isSafeInteger(input.exitCode)
      || input.exitCode < -1 || !Number.isSafeInteger(input.durationMs) || input.durationMs < 0) {
      throw new TypeError("Workflow v17 command result is invalid");
    }
    if (input.stderrPreview !== undefined
      && (typeof input.stderrPreview !== "string" || Buffer.byteLength(input.stderrPreview) > 64 * 1024)) {
      throw new TypeError("Workflow v17 command stderr preview is invalid");
    }
    const output = canonicalJsonValue(input.output, JSON_LIMITS);
    const body = canonicalJsonObject({
      ok: input.ok,
      exitCode: input.exitCode,
      durationMs: input.durationMs,
      output,
      ...(input.stderrPreview !== undefined ? { stderrPreview: input.stderrPreview } : {}),
    }, JSON_LIMITS);
    const stored = await this.store.putJson({ kind: "command-result", value: body });
    const artifact = this.artifact(stored.record);
    return this.product("command-result", input.authorityId, { ...body, artifact }, artifact);
  }

  async verification(input: CreateWorkflowV17Verification): Promise<object> {
    assertDomainIdentifier(input.receiptId, "verification receipt id");
    if (!new Set(["passed", "failed", "blocked"]).has(input.status)) {
      throw new TypeError("Workflow v17 verification status is invalid");
    }
    const evidence = input.evidence === undefined
      ? undefined
      : canonicalJsonObject(input.evidence, JSON_LIMITS);
    const body = canonicalJsonObject({
      receiptId: input.receiptId,
      status: input.status,
      passed: input.status === "passed",
      ...(evidence ? { evidence } : {}),
    }, JSON_LIMITS);
    const stored = await this.store.putJson({ kind: "verification", value: body });
    const artifact = this.artifact(stored.record);
    return this.product("verification", input.authorityId, {
      receiptId: input.receiptId,
      status: input.status,
      passed: input.status === "passed",
      artifact,
    }, artifact);
  }

  async measurement(input: CreateWorkflowV17Measurement): Promise<object> {
    assertDomainIdentifier(input.measurementId, "measurement id");
    const observations = canonicalJsonObject(input.observations, JSON_LIMITS);
    const diagnostics = input.diagnostics === undefined
      ? undefined
      : this.requireArtifactValue(input.diagnostics, "measurement diagnostics");
    const diagnosticsRecord = diagnostics ? this.artifactRecord(diagnostics) : undefined;
    const body = canonicalJsonObject({
      measurementId: input.measurementId,
      observations,
      ...(diagnosticsRecord ? { diagnosticsDigest: diagnosticsRecord.digest } : {}),
    }, JSON_LIMITS);
    const stored = await this.store.putJson({ kind: "measurement", value: body });
    const artifact = this.artifact(stored.record);
    return this.product("measurement", input.authorityId, {
      measurementId: input.measurementId,
      observations,
      ...(diagnostics ? { diagnostics } : {}),
      artifact,
    }, artifact);
  }

  /** Record-experiment stays ordinary JSON in the frozen API; its operation still gets evidence. */
  async experimentArtifact(value: JsonObject): Promise<object> {
    const body = canonicalJsonObject(value, JSON_LIMITS);
    return this.artifact((await this.store.putJson({ kind: "experiment", value: body })).record);
  }

  /** Rebuild one attachable product embedded in a completed structural result. */
  restoreAttachableProduct(
    identity: WorkflowV17ProductIdentity,
    fields: Readonly<Record<string, unknown>>,
  ): object {
    if (identity.kind === "artifact" || !ATTACHABLE_PRODUCTS.has(identity.kind)) {
      throw new WorkflowV17ArtifactAuthorityError(
        `Workflow v17 product ${identity.kind} is not a restorable attachable product`,
      );
    }
    const artifact = fields.artifact;
    if (!artifact || typeof artifact !== "object") {
      throw new WorkflowV17ArtifactAuthorityError(
        `Workflow v17 product ${identity.authorityId} lacks its canonical artifact`,
      );
    }
    this.artifactRecord(artifact);
    const restored = this.product(identity.kind, identity.authorityId, fields, artifact);
    const description = this.authority.describe(restored);
    if (!description || description.family !== "product"
      || stableJson(description.identity) !== stableJson(identity)) {
      throw new WorkflowV17ArtifactAuthorityError(
        `Workflow v17 product ${identity.authorityId} differs from its structural authority`,
      );
    }
    return restored;
  }

  artifactRecord(value: unknown): WorkflowArtifactV17Record {
    const description = this.authority.describe(value);
    if (!description || description.family !== "product" || description.identity.kind !== "artifact") {
      throw new WorkflowV17ArtifactAuthorityError("Value has no workflow v17 artifact authority");
    }
    const record = artifactRecordFromDescription(description, this.store.runId);
    const stored = this.store.database.readArtifact(record.digest);
    if (!stored || stableJson(stored) !== stableJson(record)) {
      throw new WorkflowV17ArtifactAuthorityError(
        `Workflow v17 artifact ${record.digest} is not bound to this run database`,
      );
    }
    return record;
  }

  attachableArtifact(value: unknown): {
    productKind: WorkflowV17ProductKind;
    artifact: WorkflowArtifactV17Record;
  } {
    const description = this.authority.describe(value);
    if (!description || description.family !== "product") {
      throw new WorkflowV17ArtifactAuthorityError("Value has no workflow v17 attachable authority");
    }
    const identity = description.identity as WorkflowV17ProductIdentity;
    if (identity.kind === "artifact") {
      return { productKind: "artifact", artifact: artifactRecordFromDescription(description, this.store.runId) };
    }
    if (!ATTACHABLE_PRODUCTS.has(identity.kind)) {
      throw new WorkflowV17ArtifactAuthorityError(
        `Workflow v17 product ${identity.kind} is not attachable`,
      );
    }
    const artifact = description.fields.artifact;
    const record = this.artifactRecord(artifact);
    const privateAuthority = description.privateAuthority;
    const expectedHash = stableHash({
      formatVersion: 1,
      kind: `workflow-v17-${identity.kind}-authority`,
      runId: this.store.runId,
      authorityId: identity.authorityId,
      fields: authoritySemantics(this.authority, description.fields),
    });
    if (!plainRecord(privateAuthority) || privateAuthority.formatVersion !== 1
      || privateAuthority.runId !== this.store.runId || privateAuthority.kind !== identity.kind
      || privateAuthority.authorityId !== identity.authorityId
      || privateAuthority.artifactDigest !== record.digest
      || privateAuthority.bindingHash !== identity.authorityHash
      || expectedHash !== identity.authorityHash) {
      throw new WorkflowV17ArtifactAuthorityError(
        `Workflow v17 product ${identity.authorityId} has invalid attachable authority`,
      );
    }
    return { productKind: identity.kind, artifact: record };
  }

  private product(
    kind: Exclude<WorkflowV17ProductKind, "artifact">,
    authorityId: string,
    fields: Readonly<Record<string, unknown>>,
    artifact?: object,
  ): object {
    assertSafeIdentifier(authorityId, `${kind} authority id`);
    const semanticFields = authoritySemantics(this.authority, fields);
    const authorityHash = stableHash({
      formatVersion: 1,
      kind: `workflow-v17-${kind}-authority`,
      runId: this.store.runId,
      authorityId,
      fields: semanticFields,
    });
    const key = `${kind}:${authorityId}`;
    const existing = this.products.get(key);
    if (existing) {
      if (existing.authorityHash !== authorityHash) {
        throw new WorkflowV17ArtifactAuthorityError(`Workflow v17 product ${authorityId} changed identity`);
      }
      return existing.value;
    }
    const identity: WorkflowV17ProductIdentity = { formatVersion: 1, kind, authorityId, authorityHash };
    const privateAuthority = freezePrivate<WorkflowV17EffectProductPrivateAuthority>({
      formatVersion: 1,
      runId: this.store.runId,
      kind,
      authorityId,
      ...(artifact ? { artifactDigest: this.artifactRecord(artifact).digest } : {}),
      bindingHash: authorityHash,
    });
    const value = this.authority.product(identity, fields, privateAuthority);
    this.products.set(key, { value, authorityHash });
    return value;
  }

  private requireArtifactValue(value: object, label: string): object {
    try {
      this.artifactRecord(value);
      return value;
    } catch (error) {
      throw new WorkflowV17ArtifactAuthorityError(`${label} is not an exact artifact`, { cause: error });
    }
  }

  private requireStoredArtifact(value: WorkflowArtifactV17Record): WorkflowArtifactV17Record {
    const stored = this.store.database.readArtifact(value.digest);
    if (!stored || stableJson(stored) !== stableJson(value) || stored.runId !== this.store.runId) {
      throw new WorkflowV17ArtifactAuthorityError(`Artifact ${value.digest} is not stored by this workflow run`);
    }
    return structuredClone(stored);
  }
}

export class WorkflowV17ArtifactAuthorityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowV17ArtifactAuthorityError";
  }
}

function artifactRecordFromDescription(
  description: WorkflowV17ControlAuthorityDescription,
  runId: string,
): WorkflowArtifactV17Record {
  const privateAuthority = description.privateAuthority;
  if (!plainRecord(privateAuthority) || privateAuthority.formatVersion !== 1
    || privateAuthority.runId !== runId || !plainRecord(privateAuthority.artifact)
    || typeof privateAuthority.recordHash !== "string") {
    throw new WorkflowV17ArtifactAuthorityError("Workflow v17 artifact private authority is invalid");
  }
  const record = structuredClone(privateAuthority.artifact) as unknown as WorkflowArtifactV17Record;
  if (record.runId !== runId || stableHash(record) !== privateAuthority.recordHash
    || stableHash({
      formatVersion: 1,
      kind: "workflow-v17-artifact-authority",
      runId,
      recordHash: privateAuthority.recordHash,
    }) !== (description.identity as WorkflowV17ProductIdentity).authorityHash) {
    throw new WorkflowV17ArtifactAuthorityError("Workflow v17 artifact authority hash is invalid");
  }
  return record;
}

function authoritySemantics(
  authority: WorkflowV17ControlAuthorityRegistry,
  value: unknown,
  ancestors = new Set<object>(),
): JsonValue {
  if (value === undefined) return null;
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("Workflow v17 product fields require finite numbers");
    return value;
  }
  if (!value || typeof value !== "object") throw new TypeError("Workflow v17 product field is unavailable");
  const described = authority.describe(value);
  if (described) {
    return {
      family: described.family,
      identity: structuredClone(described.identity) as unknown as JsonValue,
    };
  }
  if (ancestors.has(value)) throw new TypeError("Workflow v17 product fields may not be cyclic");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map(entry => authoritySemantics(authority, entry, ancestors));
    if (!plainRecord(value)) throw new TypeError("Workflow v17 product fields must be plain data or authority");
    return Object.fromEntries(Object.keys(value).sort().map(key => [
      key,
      authoritySemantics(authority, value[key], ancestors),
    ]));
  } finally {
    ancestors.delete(value);
  }
}

function assertSafeIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !AUTHORITY_ID.test(value)) {
    throw new TypeError(`Workflow v17 ${label} is invalid`);
  }
}

function assertDomainIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,127}$/u.test(value)) {
    throw new TypeError(`Workflow v17 ${label} is invalid`);
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezePrivate<T>(value: T): T {
  deepFreezeJson(value as unknown as JsonValue);
  return value;
}
