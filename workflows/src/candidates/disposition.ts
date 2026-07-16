import { ArtifactStore } from "../artifacts/store.js";
import type { MeasurementRecord } from "../measurements/records.js";
import type {
  ArtifactRef,
  CandidateRecord,
  VerificationRecord,
} from "../runtime/durable-types.js";
import type { JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import {
  createOpaqueAcceptedCandidateRef,
  type AcceptedCandidateRefDescriptor,
  type OpaqueAcceptedCandidateRef,
} from "./refs.js";

export interface CandidateAuthorityBinding {
  treeHash: string;
  lineageHash: string;
  writeScopeHash: string;
  changedPaths: string[];
  authorityHash: string;
}

export interface VerificationDispositionBinding {
  status: "passed" | "failed" | "blocked";
  profileHash: string;
  gateEnvironmentHash: string;
  evidenceHash: string;
  bindingHash: string;
}

export interface MeasurementDispositionBinding {
  measurementId: string;
  profileHash: string;
  environmentHash: string;
  bindingHash: string;
}

interface CandidateDispositionRecordBase {
  formatVersion: 2;
  receiptId: string;
  operationPath: string;
  candidate: CandidateAuthorityBinding;
  measurement?: MeasurementDispositionBinding;
  recordHash: string;
}

export interface CandidateAcceptanceRecord extends CandidateDispositionRecordBase {
  disposition: "accepted";
  verification: VerificationDispositionBinding & { status: "passed" };
}

export interface CandidateRejectionRecord extends CandidateDispositionRecordBase {
  disposition: "rejected";
  reason: string;
  verification?: VerificationDispositionBinding;
}

export interface AcceptanceReceipt {
  receiptId: string;
  candidateId: string;
  verificationReceiptId: string;
  measurementId?: string;
}

export interface RejectionReceipt {
  receiptId: string;
  candidateId: string;
  changedPaths: string[];
  reason: string;
  measurementId?: string;
  verificationReceiptId?: string;
}

export function candidateAuthorityBinding(candidate: CandidateRecord): CandidateAuthorityBinding {
  if (!candidate.workspace.lineageHash || !candidate.workspace.writeScopeHash) {
    throw new Error(`Candidate ${candidate.candidateId} lacks lineage or write-scope authority`);
  }
  const body = {
    treeHash: candidate.workspace.treeHash,
    lineageHash: candidate.workspace.lineageHash,
    writeScopeHash: candidate.workspace.writeScopeHash,
    changedPaths: [...candidate.changedPaths],
  };
  return { ...body, authorityHash: stableHash(body) };
}

export function verificationDispositionBinding(
  verification: VerificationRecord,
): VerificationDispositionBinding {
  const body = {
    status: verification.status,
    profileHash: verification.profileHash,
    gateEnvironmentHash: verification.gateEnvironmentHash,
    evidenceHash: verification.evidenceHash,
  };
  return { ...body, bindingHash: stableHash(body) };
}

export function measurementDispositionBinding(
  measurement: MeasurementRecord,
): MeasurementDispositionBinding {
  return {
    measurementId: measurement.measurementId,
    profileHash: measurement.profileHash,
    environmentHash: measurement.environmentHash,
    bindingHash: measurement.bindingHash,
  };
}

export async function persistCandidateAcceptance(
  store: ArtifactStore,
  expectedRevision: number,
  options: {
    operationPath: string;
    candidate: CandidateRecord;
    candidateLogicalPath: string;
    candidateCommittedAttempt: number;
    verification: VerificationRecord;
    measurement?: MeasurementRecord;
  },
): Promise<{
  record: CandidateAcceptanceRecord;
  artifact: ArtifactRef;
  ref: OpaqueAcceptedCandidateRef;
  receipt: AcceptanceReceipt;
}> {
  if (options.verification.status !== "passed") {
    throw new Error("Candidate acceptance requires passed verification");
  }
  assertCandidateVerification(options.candidate, options.verification);
  if (options.measurement) assertCandidateMeasurement(options.candidate, options.measurement);
  const candidate = candidateAuthorityBinding(options.candidate);
  const verification = verificationDispositionBinding(options.verification) as VerificationDispositionBinding & { status: "passed" };
  const measurement = options.measurement
    ? measurementDispositionBinding(options.measurement)
    : undefined;
  const semantic = {
    formatVersion: 2 as const,
    disposition: "accepted" as const,
    operationPath: options.operationPath,
    candidate,
    verification,
    ...(measurement ? { measurement } : {}),
  };
  const recordHash = stableHash(semantic);
  const receiptId = `acceptance_${recordHash.slice(7, 39)}`;
  const record: CandidateAcceptanceRecord = { ...semantic, receiptId, recordHash };
  const artifact = (await store.putJson({
    expectedRevision,
    kind: "candidate-disposition",
    value: record as unknown as JsonValue,
    metadata: { receiptId, disposition: "accepted" },
  })).artifact;
  const descriptor: AcceptedCandidateRefDescriptor = {
    runId: options.candidate.runId,
    candidateId: options.candidate.candidateId,
    logicalPath: options.candidateLogicalPath,
    committedAttempt: options.candidateCommittedAttempt,
    treeHash: options.candidate.workspace.treeHash,
    lineageHash: options.candidate.workspace.lineageHash!,
    recordHash: stableHash(options.candidate),
    acceptanceReceiptId: receiptId,
    acceptanceRecordHash: recordHash,
  };
  return {
    record,
    artifact,
    ref: createOpaqueAcceptedCandidateRef(descriptor),
    receipt: {
      receiptId,
      candidateId: options.candidate.candidateId,
      verificationReceiptId: options.verification.verificationId,
      ...(options.measurement ? { measurementId: options.measurement.measurementId } : {}),
    },
  };
}

export async function persistCandidateRejection(
  store: ArtifactStore,
  expectedRevision: number,
  options: {
    operationPath: string;
    candidate: CandidateRecord;
    reason: string;
    verification?: VerificationRecord;
    measurement?: MeasurementRecord;
  },
): Promise<{ record: CandidateRejectionRecord; artifact: ArtifactRef; receipt: RejectionReceipt }> {
  const reason = normalizeRejectionReason(options.reason);
  if (options.verification) assertCandidateVerification(options.candidate, options.verification);
  if (options.measurement) assertCandidateMeasurement(options.candidate, options.measurement);
  const candidate = candidateAuthorityBinding(options.candidate);
  const verification = options.verification
    ? verificationDispositionBinding(options.verification)
    : undefined;
  const measurement = options.measurement
    ? measurementDispositionBinding(options.measurement)
    : undefined;
  const semantic = {
    formatVersion: 2 as const,
    disposition: "rejected" as const,
    operationPath: options.operationPath,
    candidate,
    reason,
    ...(verification ? { verification } : {}),
    ...(measurement ? { measurement } : {}),
  };
  const recordHash = stableHash(semantic);
  const receiptId = `rejection_${recordHash.slice(7, 39)}`;
  const record: CandidateRejectionRecord = { ...semantic, receiptId, recordHash };
  const artifact = (await store.putJson({
    expectedRevision,
    kind: "candidate-disposition",
    value: record as unknown as JsonValue,
    metadata: { receiptId, disposition: "rejected" },
  })).artifact;
  return {
    record,
    artifact,
    receipt: {
      receiptId,
      candidateId: options.candidate.candidateId,
      changedPaths: [...options.candidate.changedPaths],
      reason,
      ...(options.measurement ? { measurementId: options.measurement.measurementId } : {}),
      ...(options.verification ? { verificationReceiptId: options.verification.verificationId } : {}),
    },
  };
}

export function normalizeRejectionReason(value: unknown): string {
  if (
    typeof value !== "string" || !value.trim() || Array.from(value).length > 2_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) throw new TypeError("Candidate rejection reason must contain 1–2000 safe Unicode scalars");
  return value;
}

function assertCandidateVerification(candidate: CandidateRecord, verification: VerificationRecord): void {
  if (
    verification.candidateId !== candidate.candidateId
    || verification.candidateTreeHash !== candidate.workspace.treeHash
    || verification.candidateLineageHash !== candidate.workspace.lineageHash
    || verification.candidateWriteScopeHash !== candidate.workspace.writeScopeHash
  ) throw new Error("Verification is not bound to the exact candidate authority");
}

function assertCandidateMeasurement(candidate: CandidateRecord, measurement: MeasurementRecord): void {
  if (
    measurement.candidateId !== candidate.candidateId
    || measurement.workspace.treeHash !== candidate.workspace.treeHash
    || measurement.workspace.lineageHash !== candidate.workspace.lineageHash
    || measurement.workspace.writeScopeHash !== candidate.workspace.writeScopeHash
  ) throw new Error("Measurement is not bound to the exact candidate authority");
}

