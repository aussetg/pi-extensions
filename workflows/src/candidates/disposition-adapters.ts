import fs from "node:fs";
import path from "node:path";
import {
  ArtifactStore,
  describeOpaqueArtifactRef,
} from "../artifacts/store.js";
import type { MeasurementRecord } from "../measurements/records.js";
import type { CandidateRecord } from "../runtime/durable-types.js";
import type {
  SemanticEffectAdapter,
  SemanticEffectAdmissionRequest,
  SemanticEffectJournalIdentity,
  SemanticEffectOutcome,
  SemanticEffectRequest,
  SemanticEffectRestoreRequest,
} from "../runtime/semantic-engine-types.js";
import type { JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import { requireVerificationReceipt } from "../verification/semantic-adapter.js";
import {
  createOpaqueAcceptedCandidateRef,
  describeOpaqueCandidateRef,
  type AcceptedCandidateRefDescriptor,
  type CandidateRefDescriptor,
} from "./refs.js";
import {
  candidateAuthorityBinding,
  measurementDispositionBinding,
  normalizeRejectionReason,
  persistCandidateAcceptance,
  persistCandidateRejection,
  verificationDispositionBinding,
  type CandidateAcceptanceRecord,
  type CandidateRejectionRecord,
  type RejectionReceipt,
} from "./disposition.js";

interface DispositionAdapterOptions {
  runDir: string;
  database: import("../persistence/run-database.js").RunDatabase;
  now?: () => Date;
}

interface ResolvedDisposition {
  candidate: CandidateRecord;
  candidateRef: CandidateRefDescriptor;
  measurement?: MeasurementRecord;
  verification?: import("../runtime/durable-types.js").VerificationRecord;
  reason?: string;
  semanticInput: JsonValue;
}

export class SemanticAcceptAdapter implements SemanticEffectAdapter {
  readonly kind = "accept" as const;
  private readonly store: ArtifactStore;
  private readonly admissions = new Map<string, ResolvedDisposition>();

  constructor(private readonly options: DispositionAdapterOptions) {
    this.store = dispositionStore(options);
  }

  semanticInput(request: SemanticEffectAdmissionRequest): JsonValue {
    return this.resolve(request).semanticInput;
  }

  journalIdentity(request: SemanticEffectAdmissionRequest): SemanticEffectJournalIdentity {
    return immutableDispositionIdentity("accepted", request, this.resolve(request).semanticInput);
  }

  async execute(request: SemanticEffectRequest): Promise<SemanticEffectOutcome> {
    const resolved = this.resolve(request);
    const persisted = await persistCandidateAcceptance(
      this.store,
      request.database.readRun().revision,
      {
        operationPath: request.path,
        candidate: resolved.candidate,
        candidateLogicalPath: resolved.candidateRef.logicalPath,
        candidateCommittedAttempt: resolved.candidateRef.committedAttempt,
        verification: resolved.verification!,
        ...(resolved.measurement ? { measurement: resolved.measurement } : {}),
      },
    );
    return {
      result: {
        value: persisted.record as unknown as JsonValue,
        artifacts: [persisted.artifact],
      },
      completionAuthority: "host-effect",
    };
  }

  async restore(request: SemanticEffectRestoreRequest): Promise<object> {
    const resolved = this.resolve(request);
    const record = await this.readAcceptance(request.operation.result, request.path);
    assertAcceptanceBindings(record, resolved, request.path);
    const descriptor: AcceptedCandidateRefDescriptor = {
      runId: resolved.candidate.runId,
      candidateId: resolved.candidate.candidateId,
      logicalPath: resolved.candidateRef.logicalPath,
      committedAttempt: resolved.candidateRef.committedAttempt,
      treeHash: resolved.candidate.workspace.treeHash,
      lineageHash: resolved.candidate.workspace.lineageHash!,
      recordHash: stableHash(resolved.candidate),
      acceptanceReceiptId: record.receiptId,
      acceptanceRecordHash: record.recordHash,
    };
    return createOpaqueAcceptedCandidateRef(descriptor);
  }

  private resolve(request: SemanticEffectAdmissionRequest): ResolvedDisposition {
    const cached = this.admissions.get(request.path);
    if (cached) return cached;
    const input = plainRecord(request.input, "flow.accept options");
    exactKeys(input, new Set(["candidate", "verification", "measurement"]), "flow.accept options");
    const { candidate, descriptor } = requireCandidate(this.options.database, request.run.runId, input.candidate);
    const verification = requireVerificationReceipt(this.options.database, input.verification, candidate, true);
    const measurement = input.measurement === undefined
      ? undefined
      : requireMeasurement(this.options.database, input.measurement, candidate);
    const semanticInput = dispositionSemanticInput(candidate, verification, measurement);
    const resolved = { candidate, candidateRef: descriptor, verification, ...(measurement ? { measurement } : {}), semanticInput };
    this.admissions.set(request.path, resolved);
    return resolved;
  }

  private async readAcceptance(
    result: import("../runtime/durable-types.js").OperationResult,
    operationPath: string,
  ): Promise<CandidateAcceptanceRecord> {
    const record = plainRecord(result.value, "candidate acceptance output") as unknown as CandidateAcceptanceRecord;
    if (record.disposition !== "accepted" || record.operationPath !== operationPath) {
      throw new Error("Candidate acceptance operation output is corrupt");
    }
    await assertDispositionArtifact(this.store, result, record);
    return record;
  }
}

export class SemanticRejectAdapter implements SemanticEffectAdapter {
  readonly kind = "reject" as const;
  private readonly store: ArtifactStore;
  private readonly admissions = new Map<string, ResolvedDisposition>();

  constructor(private readonly options: DispositionAdapterOptions) {
    this.store = dispositionStore(options);
  }

  semanticInput(request: SemanticEffectAdmissionRequest): JsonValue {
    return this.resolve(request).semanticInput;
  }

  journalIdentity(request: SemanticEffectAdmissionRequest): SemanticEffectJournalIdentity {
    return immutableDispositionIdentity("rejected", request, this.resolve(request).semanticInput);
  }

  async execute(request: SemanticEffectRequest): Promise<SemanticEffectOutcome> {
    const resolved = this.resolve(request);
    const persisted = await persistCandidateRejection(
      this.store,
      request.database.readRun().revision,
      {
        operationPath: request.path,
        candidate: resolved.candidate,
        reason: resolved.reason!,
        ...(resolved.verification ? { verification: resolved.verification } : {}),
        ...(resolved.measurement ? { measurement: resolved.measurement } : {}),
      },
    );
    return {
      result: {
        value: persisted.record as unknown as JsonValue,
        artifacts: [persisted.artifact],
      },
      completionAuthority: "host-effect",
    };
  }

  async restore(request: SemanticEffectRestoreRequest): Promise<RejectionReceipt> {
    const resolved = this.resolve(request);
    const record = plainRecord(request.operation.result.value, "candidate rejection output") as unknown as CandidateRejectionRecord;
    assertRejectionBindings(record, resolved, request.path);
    await assertDispositionArtifact(this.store, request.operation.result, record);
    return Object.freeze({
      receiptId: record.receiptId,
      candidateId: resolved.candidate.candidateId,
      changedPaths: [...resolved.candidate.changedPaths],
      reason: record.reason,
      ...(resolved.measurement ? { measurementId: resolved.measurement.measurementId } : {}),
      ...(resolved.verification ? { verificationReceiptId: resolved.verification.verificationId } : {}),
    });
  }

  private resolve(request: SemanticEffectAdmissionRequest): ResolvedDisposition {
    const cached = this.admissions.get(request.path);
    if (cached) return cached;
    const input = plainRecord(request.input, "flow.reject options");
    exactKeys(input, new Set(["candidate", "reason", "verification", "measurement"]), "flow.reject options");
    const { candidate, descriptor } = requireCandidate(this.options.database, request.run.runId, input.candidate);
    const reason = normalizeRejectionReason(input.reason);
    const verification = input.verification === undefined
      ? undefined
      : requireVerificationReceipt(this.options.database, input.verification, candidate, undefined);
    const measurement = input.measurement === undefined
      ? undefined
      : requireMeasurement(this.options.database, input.measurement, candidate);
    const semanticInput = {
      ...(dispositionSemanticInput(candidate, verification, measurement) as Record<string, JsonValue>),
      reason,
    } as unknown as JsonValue;
    const resolved = {
      candidate,
      candidateRef: descriptor,
      reason,
      ...(verification ? { verification } : {}),
      ...(measurement ? { measurement } : {}),
      semanticInput,
    };
    this.admissions.set(request.path, resolved);
    return resolved;
  }
}

function dispositionStore(options: DispositionAdapterOptions): ArtifactStore {
  const runDir = path.resolve(options.runDir);
  if (path.resolve(options.database.databasePath) !== path.join(runDir, "run.sqlite")) {
    throw new Error("Disposition adapter and run database directories differ");
  }
  return new ArtifactStore(runDir, options.database, { now: options.now });
}

function immutableDispositionIdentity(
  disposition: "accepted" | "rejected",
  request: SemanticEffectAdmissionRequest,
  semanticInput: JsonValue,
): SemanticEffectJournalIdentity {
  return {
    semanticKey: stableHash({
      formatVersion: 2,
      kind: "candidate-disposition",
      disposition,
      semanticInput,
      contextIdentityHash: request.run.contextIdentityHash,
    }),
    completionAuthority: "host-effect",
    replayPolicy: "immutable",
  };
}

function dispositionSemanticInput(
  candidate: CandidateRecord,
  verification: import("../runtime/durable-types.js").VerificationRecord | undefined,
  measurement: MeasurementRecord | undefined,
): JsonValue {
  return {
    candidate: candidateAuthorityBinding(candidate),
    ...(verification ? { verification: verificationDispositionBinding(verification) } : {}),
    ...(measurement ? { measurement: measurementDispositionBinding(measurement) } : {}),
  } as unknown as JsonValue;
}

function requireCandidate(
  database: import("../persistence/run-database.js").RunDatabase,
  runId: string,
  value: unknown,
): { candidate: CandidateRecord; descriptor: CandidateRefDescriptor } {
  const descriptor = describeOpaqueCandidateRef(value);
  if (!descriptor || descriptor.runId !== runId) throw new TypeError("Candidate disposition requires a candidate from this run");
  const candidate = database.readCandidate(descriptor.candidateId);
  if (!candidate || candidate.runId !== runId
    || candidate.workspace.treeHash !== descriptor.treeHash
    || candidate.workspace.lineageHash !== descriptor.lineageHash
    || stableHash(candidate) !== descriptor.recordHash) {
    throw new TypeError("Candidate disposition reference is stale");
  }
  return { candidate, descriptor };
}

function requireMeasurement(
  database: import("../persistence/run-database.js").RunDatabase,
  value: unknown,
  candidate: CandidateRecord,
): MeasurementRecord {
  const supplied = plainRecord(value, "candidate measurement");
  if (typeof supplied.measurementId !== "string") throw new TypeError("Candidate measurement id is missing");
  const record = database.readMeasurement(supplied.measurementId);
  if (!record || record.runId !== candidate.runId || record.candidateId !== candidate.candidateId
    || record.workspace.treeHash !== candidate.workspace.treeHash
    || record.workspace.lineageHash !== candidate.workspace.lineageHash
    || record.workspace.writeScopeHash !== candidate.workspace.writeScopeHash) {
    throw new TypeError("Measurement is not bound to the exact candidate authority");
  }
  const single = supplied.observation !== undefined;
  if (single === (supplied.observations !== undefined)) {
    throw new TypeError("Candidate measurement must contain exactly one observation shape");
  }
  const expected = measurementWorkflowValue(record, single);
  if (!sameMeasurementValue(value, expected)) throw new TypeError("Candidate measurement value was forged or mixed");
  return record;
}

function measurementWorkflowValue(record: MeasurementRecord, single: boolean): Record<string, unknown> {
  const observations = record.delta.observations.map(({ status: _status, ...observation }) => observation);
  if (single && observations.length !== 1) throw new TypeError("Single measurement has multiple observations");
  return {
    measurementId: record.measurementId,
    profile: record.profileId,
    profileHash: record.profileHash,
    environmentHash: record.environmentHash,
    diagnostics: structuredClone(record.diagnostics),
    ...(record.diagnosticsArtifact ? { diagnosticsArtifact: record.diagnosticsArtifact } : {}),
    ...(single
      ? { observation: structuredClone(observations[0]!) }
      : { observations: Object.fromEntries(observations.map((entry) => [entry.outputId, structuredClone(entry)])) }),
  };
}

function sameMeasurementValue(value: unknown, expected: Record<string, unknown>): boolean {
  const supplied = plainRecord(value, "candidate measurement");
  for (const key of ["measurementId", "profile", "profileHash", "environmentHash", "diagnostics", "observation", "observations"]) {
    if (stableHash(supplied[key] ?? null) !== stableHash(expected[key] ?? null)) return false;
  }
  const expectedArtifact = expected.diagnosticsArtifact as import("../runtime/durable-types.js").ArtifactRef | undefined;
  const suppliedArtifact = supplied.diagnosticsArtifact === undefined
    ? undefined
    : describeOpaqueArtifactRef(supplied.diagnosticsArtifact);
  return stableHash(suppliedArtifact ?? null) === stableHash(expectedArtifact ?? null);
}

async function assertDispositionArtifact(
  store: ArtifactStore,
  result: import("../runtime/durable-types.js").OperationResult,
  record: CandidateAcceptanceRecord | CandidateRejectionRecord,
): Promise<void> {
  const { receiptId, recordHash, ...semantic } = record;
  if (recordHash !== stableHash(semantic) || receiptId !== `${record.disposition === "accepted" ? "acceptance" : "rejection"}_${recordHash.slice(7, 39)}`) {
    throw new Error("Candidate disposition output has an invalid semantic hash");
  }
  if (result.artifacts.length !== 1 || result.artifacts[0]!.kind !== "candidate-disposition") {
    throw new Error("Candidate disposition output lacks its immutable artifact");
  }
  const stored = await store.read(result.artifacts[0]!.digest);
  const source = await fs.promises.readFile(stored.bodyPath, "utf8");
  if (source !== stableJson(record)) throw new Error("Candidate disposition artifact differs from its operation output");
}

function assertAcceptanceBindings(
  record: CandidateAcceptanceRecord,
  resolved: ResolvedDisposition,
  pathValue: string,
): void {
  if (record.formatVersion !== 2 || record.disposition !== "accepted" || record.operationPath !== pathValue
    || stableHash(record.candidate) !== stableHash(candidateAuthorityBinding(resolved.candidate))
    || stableHash(record.verification) !== stableHash(verificationDispositionBinding(resolved.verification!))
    || stableHash(record.measurement ?? null) !== stableHash(resolved.measurement ? measurementDispositionBinding(resolved.measurement) : null)) {
    throw new Error("Candidate acceptance output changed its exact candidate or policy binding");
  }
}

function assertRejectionBindings(
  record: CandidateRejectionRecord,
  resolved: ResolvedDisposition,
  pathValue: string,
): void {
  if (record.formatVersion !== 2 || record.disposition !== "rejected" || record.operationPath !== pathValue
    || record.reason !== resolved.reason
    || stableHash(record.candidate) !== stableHash(candidateAuthorityBinding(resolved.candidate))
    || stableHash(record.verification ?? null) !== stableHash(resolved.verification ? verificationDispositionBinding(resolved.verification) : null)
    || stableHash(record.measurement ?? null) !== stableHash(resolved.measurement ? measurementDispositionBinding(resolved.measurement) : null)) {
    throw new Error("Candidate rejection output changed its exact candidate or evidence binding");
  }
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length) throw new TypeError(`${label} contains unknown fields: ${extras.sort().join(", ")}`);
}
