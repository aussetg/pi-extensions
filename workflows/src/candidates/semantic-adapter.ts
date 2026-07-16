import type { CandidateWorkspaceManager } from "./store.js";
import { normalizeCandidateWriteScope } from "./store.js";
import {
  createOpaqueCandidateRef,
  describeOpaqueAcceptedCandidateRef,
  describeOpaqueLaunchSnapshotRef,
  type CandidateRefDescriptor,
} from "./refs.js";
import { canonicalStructuralJson, validateJsonSchema } from "../runtime/semantic-engine-values.js";
import type {
  SemanticEffectAdapter,
  SemanticEffectAdmissionRequest,
  SemanticEffectJournalIdentity,
  SemanticEffectOutcome,
  SemanticEffectRequest,
  SemanticEffectRestoreRequest,
} from "../runtime/semantic-engine-types.js";
import type { CandidateRecord, CandidateWriteScope } from "../runtime/durable-types.js";
import type { JsonSchema, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";

interface CandidateOptions {
  title?: string;
  baseCandidateId?: string;
  writeScope: CandidateWriteScope;
  metadataSchema?: JsonSchema;
}

interface ResolvedCandidateScope {
  body: (workspace: unknown) => unknown;
  options: CandidateOptions;
  semanticInput: JsonValue;
}

interface CandidateOperationValue {
  formatVersion: 1;
  candidateId: string;
  logicalPath: string;
  committedAttempt: number;
  treeHash: string;
  lineageHash: string;
  recordHash: string;
  metadata: JsonValue;
}

export interface SemanticCandidateAdapterOptions {
  manager: CandidateWorkspaceManager;
}

/**
 * Candidate is a callback-owning semantic operation. The engine deliberately
 * does not journal the container itself: mutating children carry exact
 * workspace checkpoints, while this adapter deterministically freezes their
 * resulting tree into immutable metadata.
 */
export class SemanticCandidateAdapter implements SemanticEffectAdapter {
  readonly kind = "candidate" as const;

  constructor(private readonly options: SemanticCandidateAdapterOptions) {}

  semanticInput(request: SemanticEffectAdmissionRequest): JsonValue {
    return this.resolve(request).semanticInput;
  }

  journalIdentity(request: SemanticEffectAdmissionRequest): SemanticEffectJournalIdentity {
    return {
      semanticKey: stableHash({
        formatVersion: 1,
        kind: "candidate-container",
        semanticInput: this.resolve(request).semanticInput,
        contextIdentityHash: request.run.contextIdentityHash,
      }),
      completionAuthority: "host-effect",
      replayPolicy: "immutable",
    };
  }

  async execute(request: SemanticEffectRequest): Promise<SemanticEffectOutcome> {
    const resolved = this.resolve(request);
    const workspace = await this.options.manager.create({
      logicalId: request.path,
      writeScope: resolved.options.writeScope,
      ...(resolved.options.baseCandidateId
        ? { parentCandidateId: resolved.options.baseCandidateId }
        : {}),
    });
    const metadata = canonicalStructuralJson(await Promise.resolve(resolved.body(workspace)));
    if (resolved.options.metadataSchema) {
      validateJsonSchema(resolved.options.metadataSchema, metadata, "candidate metadataSchema");
    }
    const candidate = await this.options.manager.freeze({ workspace });
    const value = candidateOperationValue(request.path, candidate, metadata);
    return {
      result: {
        value: value as unknown as JsonValue,
        artifacts: [candidate.manifest, candidate.diff],
      },
      completionAuthority: "host-effect",
    };
  }

  restore(request: SemanticEffectRestoreRequest): unknown {
    const value = parseCandidateOperationValue(request.operation.result.value);
    const candidate = request.database.readCandidate(value.candidateId);
    if (!candidate || candidate.runId !== request.run.runId) {
      throw new Error(`Completed candidate ${request.path} has no SQLite candidate`);
    }
    const expected = candidateOperationValue(request.path, candidate, value.metadata);
    if (stableHash(expected) !== stableHash(value)) {
      throw new Error(`Completed candidate ${request.path} differs from its frozen authority`);
    }
    const outputDigests = new Set(request.operation.result.artifacts.map((artifact) => artifact.digest));
    if (!outputDigests.has(candidate.manifest.digest) || !outputDigests.has(candidate.diff.digest)) {
      throw new Error(`Completed candidate ${request.path} lacks its immutable manifest or diff`);
    }
    const descriptor: CandidateRefDescriptor = {
      runId: candidate.runId,
      candidateId: candidate.candidateId,
      logicalPath: value.logicalPath,
      committedAttempt: value.committedAttempt,
      treeHash: candidate.workspace.treeHash,
      lineageHash: candidate.workspace.lineageHash!,
      recordHash: stableHash(candidate),
    };
    return Object.freeze({
      candidate: createOpaqueCandidateRef(descriptor),
      metadata: structuredClone(value.metadata),
      changedPaths: [...candidate.changedPaths],
    });
  }

  private resolve(request: SemanticEffectAdmissionRequest): ResolvedCandidateScope {
    const input = plainRecord(request.input, "flow.candidate arguments");
    exactKeys(input, new Set(["body", "options"]), "flow.candidate arguments");
    if (typeof input.body !== "function") throw new TypeError("flow.candidate body must be a callback");
    const raw = input.options === undefined
      ? Object.create(null) as Record<string, unknown>
      : plainRecord(input.options, "flow.candidate options");
    exactKeys(raw, new Set(["title", "base", "metadataSchema", "writes"]), "flow.candidate options");
    const title = raw.title === undefined ? undefined : boundedTitle(raw.title);
    const writeScope = normalizeCandidateWriteScope(raw.writes as CandidateWriteScope | undefined);
    const metadataSchema = raw.metadataSchema === undefined
      ? undefined
      : schema(raw.metadataSchema, "candidate metadataSchema");
    let baseCandidateId: string | undefined;
    let base: JsonValue = { kind: "launch-snapshot", treeHash: request.run.projectSnapshotHash };
    if (raw.base !== undefined) {
      const launch = describeOpaqueLaunchSnapshotRef(raw.base);
      const accepted = describeOpaqueAcceptedCandidateRef(raw.base);
      if (launch) {
        if (launch.runId !== request.run.runId || launch.snapshotHash !== request.run.projectSnapshotHash) {
          throw new TypeError("flow.candidate base launch snapshot is stale or belongs to another run");
        }
      } else if (accepted) {
        if (accepted.runId !== request.run.runId) throw new TypeError("flow.candidate base belongs to another run");
        const candidate = this.options.manager.database.readCandidate(accepted.candidateId);
        if (!candidate || !sameCandidateDescriptor(candidate, accepted)) {
          throw new TypeError("flow.candidate accepted base is stale");
        }
        baseCandidateId = candidate.candidateId;
        base = {
          kind: "accepted-candidate",
          treeHash: accepted.treeHash,
          lineageHash: accepted.lineageHash,
          acceptanceRecordHash: accepted.acceptanceRecordHash,
        };
      } else {
        throw new TypeError("flow.candidate base must be flow.snapshot or an accepted candidate");
      }
    }
    const options: CandidateOptions = {
      ...(title ? { title } : {}),
      ...(baseCandidateId ? { baseCandidateId } : {}),
      writeScope,
      ...(metadataSchema ? { metadataSchema } : {}),
    };
    const resolved: ResolvedCandidateScope = {
      body: input.body as (workspace: unknown) => unknown,
      options,
      semanticInput: {
        ...(title ? { title } : {}),
        base,
        writeScope: writeScope as unknown as JsonValue,
        ...(metadataSchema ? { metadataSchema } : {}),
      } as unknown as JsonValue,
    };
    return resolved;
  }
}

function candidateOperationValue(
  logicalPath: string,
  candidate: CandidateRecord,
  metadata: JsonValue,
): CandidateOperationValue {
  return {
    formatVersion: 1,
    candidateId: candidate.candidateId,
    logicalPath,
    committedAttempt: 1,
    treeHash: candidate.workspace.treeHash,
    lineageHash: candidate.workspace.lineageHash!,
    recordHash: stableHash(candidate),
    metadata,
  };
}

function parseCandidateOperationValue(value: unknown): CandidateOperationValue {
  const record = plainRecord(value, "candidate operation result");
  exactKeys(record, new Set([
    "formatVersion", "candidateId", "logicalPath", "committedAttempt", "treeHash",
    "lineageHash", "recordHash", "metadata",
  ]), "candidate operation result");
  if (
    record.formatVersion !== 1
    || typeof record.candidateId !== "string"
    || typeof record.logicalPath !== "string"
    || record.committedAttempt !== 1
    || !isHash(record.treeHash) || !isHash(record.lineageHash) || !isHash(record.recordHash)
  ) throw new Error("Candidate operation result is corrupt");
  return record as unknown as CandidateOperationValue;
}

function sameCandidateDescriptor(
  candidate: CandidateRecord,
  descriptor: NonNullable<ReturnType<typeof describeOpaqueAcceptedCandidateRef>>,
): boolean {
  return candidate.candidateId === descriptor.candidateId
    && candidate.workspace.treeHash === descriptor.treeHash
    && candidate.workspace.lineageHash === descriptor.lineageHash
    && stableHash(candidate) === descriptor.recordHash;
}

function schema(value: unknown, label: string): JsonSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return structuredClone(value) as JsonSchema;
}

function boundedTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > 192) {
    throw new TypeError("candidate title is invalid");
  }
  return value;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length) throw new TypeError(`${label} contains unknown fields: ${extras.sort().join(", ")}`);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}
