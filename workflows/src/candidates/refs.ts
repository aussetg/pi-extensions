const CANDIDATE_REFS = new WeakMap<object, CandidateRefDescriptor>();
const ACCEPTED_CANDIDATE_REFS = new WeakMap<object, AcceptedCandidateRefDescriptor>();
const LAUNCH_REFS = new WeakMap<object, LaunchSnapshotRefDescriptor>();
const WORKSPACE_REFS = new WeakMap<object, CandidateWorkspaceDescriptor>();

export interface CandidateRefDescriptor {
  runId: string;
  candidateId: string;
  logicalPath: string;
  committedAttempt: number;
  treeHash: string;
  lineageHash: string;
  recordHash: string;
}

export interface AcceptedCandidateRefDescriptor extends CandidateRefDescriptor {
  acceptanceReceiptId: string;
  acceptanceRecordHash: string;
}

export interface LaunchSnapshotRefDescriptor {
  runId: string;
  snapshotHash: string;
}

export interface CandidateWorkspaceDescriptor {
  runId: string;
  logicalPath: string;
  attempt: number;
  root: string;
  cwd: string;
  base: "launch-snapshot" | string;
  baseTreeHash: string;
  baseLineageHash: string;
  writeScopeHash: string;
}

export type OpaqueCandidateRef = Readonly<object>;
export type OpaqueAcceptedCandidateRef = OpaqueCandidateRef;
export type OpaqueLaunchSnapshotRef = Readonly<object>;
export type OpaqueCandidateWorkspace = Readonly<object>;

export class CandidateReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateReferenceError";
  }
}

export function createOpaqueCandidateRef(descriptor: CandidateRefDescriptor): OpaqueCandidateRef {
  assertCandidateDescriptor(descriptor);
  const ref = Object.create(null) as object;
  CANDIDATE_REFS.set(ref, Object.freeze({ ...descriptor }));
  return Object.freeze(ref);
}

export function describeOpaqueCandidateRef(value: unknown): CandidateRefDescriptor | undefined {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = CANDIDATE_REFS.get(value as object) ?? ACCEPTED_CANDIDATE_REFS.get(value as object);
  if (!descriptor) return undefined;
  assertCandidateDescriptor(descriptor);
  return {
    runId: descriptor.runId,
    candidateId: descriptor.candidateId,
    logicalPath: descriptor.logicalPath,
    committedAttempt: descriptor.committedAttempt,
    treeHash: descriptor.treeHash,
    lineageHash: descriptor.lineageHash,
    recordHash: descriptor.recordHash,
  };
}

export function createOpaqueAcceptedCandidateRef(descriptor: AcceptedCandidateRefDescriptor): OpaqueAcceptedCandidateRef {
  assertAcceptedCandidateDescriptor(descriptor);
  const ref = Object.create(null) as object;
  ACCEPTED_CANDIDATE_REFS.set(ref, Object.freeze({ ...descriptor }));
  return Object.freeze(ref);
}

export function describeOpaqueAcceptedCandidateRef(value: unknown): AcceptedCandidateRefDescriptor | undefined {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = ACCEPTED_CANDIDATE_REFS.get(value as object);
  if (!descriptor) return undefined;
  assertAcceptedCandidateDescriptor(descriptor);
  return { ...descriptor };
}

export function createOpaqueLaunchSnapshotRef(descriptor: LaunchSnapshotRefDescriptor): OpaqueLaunchSnapshotRef {
  assertLaunchDescriptor(descriptor);
  const ref = Object.create(null) as object;
  LAUNCH_REFS.set(ref, Object.freeze({ ...descriptor }));
  return Object.freeze(ref);
}

export function describeOpaqueLaunchSnapshotRef(value: unknown): LaunchSnapshotRefDescriptor | undefined {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = LAUNCH_REFS.get(value as object);
  if (!descriptor) return undefined;
  assertLaunchDescriptor(descriptor);
  return { ...descriptor };
}

export function createOpaqueCandidateWorkspace(descriptor: CandidateWorkspaceDescriptor): OpaqueCandidateWorkspace {
  assertWorkspaceDescriptor(descriptor);
  const ref = Object.create(null) as object;
  WORKSPACE_REFS.set(ref, Object.freeze({ ...descriptor }));
  return Object.freeze(ref);
}

export function describeOpaqueCandidateWorkspace(value: unknown): CandidateWorkspaceDescriptor | undefined {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = WORKSPACE_REFS.get(value as object);
  if (!descriptor) return undefined;
  assertWorkspaceDescriptor(descriptor);
  return { ...descriptor };
}

function assertCandidateDescriptor(value: CandidateRefDescriptor): void {
  if (
    !value || typeof value !== "object" || typeof value.runId !== "string" ||
    !/^candidate_[a-f0-9]{32}$/.test(value.candidateId) ||
    typeof value.logicalPath !== "string" || !value.logicalPath.includes("/candidate:") ||
    !Number.isSafeInteger(value.committedAttempt) || value.committedAttempt < 1 ||
    !isHash(value.treeHash) || !isHash(value.lineageHash) || !isHash(value.recordHash)
  ) throw new CandidateReferenceError("Candidate descriptor identity is invalid");
}

function assertAcceptedCandidateDescriptor(value: AcceptedCandidateRefDescriptor): void {
  assertCandidateDescriptor(value);
  if (!/^acceptance_[a-f0-9]{32}$/.test(value.acceptanceReceiptId) || !isHash(value.acceptanceRecordHash)) {
    throw new CandidateReferenceError("Accepted-candidate descriptor authority is invalid");
  }
}

function assertLaunchDescriptor(value: LaunchSnapshotRefDescriptor): void {
  if (!value || typeof value.runId !== "string" || !isHash(value.snapshotHash)) {
    throw new CandidateReferenceError("Launch-snapshot descriptor is invalid");
  }
}

function assertWorkspaceDescriptor(value: CandidateWorkspaceDescriptor): void {
  if (
    !value || typeof value.runId !== "string" || typeof value.logicalPath !== "string" ||
    !Number.isSafeInteger(value.attempt) || value.attempt < 1 ||
    typeof value.root !== "string" || typeof value.cwd !== "string" ||
    !(value.base === "launch-snapshot" || /^candidate_[a-f0-9]{32}$/.test(value.base)) || !isHash(value.baseTreeHash) ||
    !isHash(value.baseLineageHash) || !isHash(value.writeScopeHash)
  ) throw new CandidateReferenceError("Candidate-workspace descriptor is invalid");
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}
