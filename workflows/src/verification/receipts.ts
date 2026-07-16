import fs from "node:fs";
import path from "node:path";
import { ArtifactStore } from "../artifacts/store.js";
import type { CandidatePathImage, CandidateTreeManifest } from "../candidates/tree.js";
import { scanCandidateTree } from "../candidates/tree.js";
import type { CandidateRecord } from "../runtime/durable-types.js";
import type {
  AgentFinishRecord,
  VerificationGateKind,
  VerificationGateRecord,
  VerificationGateStatus,
  VerificationRecord,
} from "../runtime/durable-types.js";
import { RunDatabase } from "../persistence/run-database.js";
import type { JsonObject, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import {
  assertProjectSnapshotManifest,
  scanProjectSource,
  type ProjectSnapshotManifest,
} from "../workspaces/project-snapshot.js";
import type {
  VerificationCommandGate,
  VerificationCommandProfile,
  VerificationProfileSnapshot,
} from "./profiles.js";

export type VerificationCommandStatus =
  | "completed"
  | "timed-out"
  | "output-limited"
  | "infrastructure-failure"
  | "cancelled";

/** Exact command result supplied by the command effect adapter. */
export interface VerificationCommandEvidence {
  commandId: string;
  status: VerificationCommandStatus;
  exitCode: number | null;
  timedOut: boolean;
  stdoutDigest: string;
  stdoutBytes: number;
  stderrDigest: string;
  stderrBytes: number;
  environmentHash: string;
  startedAt: string;
  completedAt: string;
}

/** Adversarial conclusions are accepted only from a committed finish_work record. */
export interface VerificationReviewEvidence {
  agentSessionId: string;
  finish: AgentFinishRecord;
  environmentHash: string;
}

export interface VerificationEvidenceInput {
  tests?: VerificationCommandEvidence[];
  diagnostics?: VerificationCommandEvidence[];
  adversarialReview?: VerificationReviewEvidence;
}

export interface RecordVerificationOptions {
  operationId: string;
  attemptId: string;
  candidateId: string;
  profile: VerificationProfileSnapshot;
  evidence: VerificationEvidenceInput;
  createdAt?: string;
}

interface GateEvidence {
  kind: VerificationGateKind;
  status: VerificationGateStatus;
  summary: string;
  environmentHash: string;
  details: JsonObject;
  agentSessionId?: string;
  finishToolCallId?: string;
  finishSchemaHash?: string;
  evidenceHash: string;
}

interface FrozenCandidateManifest {
  formatVersion: 1;
  candidateId: string;
  runId: string;
  workspaceId: string;
  tree: CandidateTreeManifest;
  lineageHash: string;
  writeScopeHash: string;
  changedPaths: string[];
}

const GATE_ORDER: readonly VerificationGateKind[] = [
  "tests",
  "diagnostics",
  "diff-inspection",
  "adversarial-review",
  "contamination",
];

/**
 * Converts deterministic gates and one finish-authorized adversarial review
 * into immutable evidence plus normalized SQLite rows.
 */
export class VerificationService {
  readonly runDir: string;
  readonly runId: string;
  readonly artifacts: ArtifactStore;

  constructor(runDirInput: string, readonly database: RunDatabase, private readonly now = () => new Date()) {
    this.runDir = path.resolve(runDirInput);
    if (path.resolve(database.databasePath) !== path.join(this.runDir, "run.sqlite")) {
      throw new Error("Verification service and run database do not match");
    }
    this.runId = database.readRun().runId;
    this.artifacts = new ArtifactStore(this.runDir, database, { now });
  }

  async record(options: RecordVerificationOptions): Promise<VerificationRecord> {
    const record = await this.prepare(options);
    return this.database.commitVerification(this.database.readRun().revision, record, {
      type: "verification-recorded",
      operationId: record.operationId,
      attemptId: record.attemptId,
      payload: { verificationId: record.verificationId, status: record.status },
      at: record.createdAt,
    });
  }

  /** Build immutable verification evidence for an atomic operation completion. */
  async prepare(options: RecordVerificationOptions): Promise<VerificationRecord> {
    const run = this.database.readRun();
    const operation = this.database.readOperation(options.operationId);
    const attempt = this.database.readAttempt(options.attemptId);
    if (!operation || operation.runId !== this.runId || operation.kind !== "verify") {
      throw new Error(`Unknown verification operation ${options.operationId}`);
    }
    if (!attempt || attempt.operationId !== operation.operationId || attempt.effect !== "verification") {
      throw new Error(`Unknown verification attempt ${options.attemptId}`);
    }
    const candidate = this.requiredCandidate(options.candidateId);
    assertCandidateAttemptBinding(candidate, attempt.preWorkspace);
    const candidateManifest = await this.readCandidateManifest(candidate);
    const candidateRoot = this.candidateRoot(candidate);
    const candidateState = await scanCandidateTree(candidateRoot);
    if (candidateState.treeHash !== candidate.workspace.treeHash) {
      throw new Error("Stale candidate: mutable workspace differs from its frozen tree");
    }
    const project = await this.readProjectManifest();
    if (run.projectSnapshotHash !== project.treeHash) throw new Error("Verification project snapshot binding is stale");
    const live = await scanProjectSource(project.sourceRoot);

    const gates: GateEvidence[] = [
      commandGate("tests", options.profile.tests, options.evidence.tests),
      commandGate("diagnostics", options.profile.diagnostics, options.evidence.diagnostics),
      await diffGate(options.profile, candidate, candidateManifest, candidateRoot),
      this.reviewGate(options.profile, options.evidence.adversarialReview),
      contaminationGate(candidate, candidateState, project),
    ];
    if (gates.some((gate, index) => gate.kind !== GATE_ORDER[index])) throw new Error("Verification gates are unordered");
    const status = gates.some((gate) => gate.status === "blocked")
      ? "blocked"
      : gates.some((gate) => gate.status === "failed")
        ? "failed"
        : "passed";
    const gateEnvironmentHash = stableHash(gates.map((gate) => ({ kind: gate.kind, environmentHash: gate.environmentHash })));
    const createdAt = iso(options.createdAt ?? this.now().toISOString());
    const verificationId = `verification_${stableHash({
      runId: this.runId,
      operationId: operation.operationId,
      attemptId: attempt.attemptId,
      candidateId: candidate.candidateId,
      candidateTreeHash: candidate.workspace.treeHash,
      profileHash: options.profile.hash,
      gateEnvironmentHash,
    }).slice(7, 39)}`;
    const evidenceValue = {
      formatVersion: 1 as const,
      verificationId,
      runId: this.runId,
      operationId: operation.operationId,
      attemptId: attempt.attemptId,
      candidateId: candidate.candidateId,
      projectSnapshotHash: project.treeHash,
      liveProjectTreeHash: live.treeHash,
      profileId: options.profile.id,
      profileHash: options.profile.hash,
      gateEnvironmentHash,
      status,
      gates,
      createdAt,
    };
    const stored = await this.artifacts.putJson({
      expectedRevision: this.database.readRun().revision,
      kind: "verification-evidence",
      value: evidenceValue as unknown as JsonValue,
      metadata: { verificationId },
      createdAt,
    });
    const gateRecords: VerificationGateRecord[] = gates.map((gate, ordinal) => ({
      verificationId,
      ordinal,
      kind: gate.kind,
      status: gate.status,
      summary: gate.summary,
      environmentHash: gate.environmentHash,
      evidenceHash: gate.evidenceHash,
      ...(gate.agentSessionId ? { agentSessionId: gate.agentSessionId } : {}),
      ...(gate.finishToolCallId ? { finishToolCallId: gate.finishToolCallId } : {}),
      ...(gate.finishSchemaHash ? { finishSchemaHash: gate.finishSchemaHash } : {}),
    }));
    const record: VerificationRecord = {
      verificationId,
      runId: this.runId,
      operationId: operation.operationId,
      attemptId: attempt.attemptId,
      attemptNumber: attempt.number,
      status,
      candidateId: candidate.candidateId,
      candidateTreeHash: candidate.workspace.treeHash,
      candidateLineageHash: candidate.workspace.lineageHash!,
      candidateWriteScopeHash: candidate.workspace.writeScopeHash!,
      projectSnapshotHash: project.treeHash,
      liveProjectTreeHash: live.treeHash,
      profileId: options.profile.id,
      profileHash: options.profile.hash,
      gateEnvironmentHash,
      evidence: stored.artifact,
      evidenceHash: stableHash(evidenceValue),
      gates: gateRecords,
      createdAt,
    };
    return record;
  }

  private reviewGate(profile: VerificationProfileSnapshot, supplied: VerificationReviewEvidence | undefined): GateEvidence {
    if ("notApplicable" in profile.adversarialReview) {
      if (supplied) throw new Error("Adversarial evidence was supplied to a not-applicable gate");
      return gate("adversarial-review", "not-applicable", profile.adversarialReview.notApplicable,
        stableHash({ notApplicable: profile.adversarialReview.notApplicable }), { notApplicable: profile.adversarialReview.notApplicable });
    }
    if (!supplied) throw new Error("Adversarial review requires a finish_work receipt");
    const session = this.database.readAgentSession(supplied.agentSessionId);
    if (!session?.finish || stableJson(session.finish) !== stableJson(supplied.finish)) {
      throw new Error("Adversarial review is not bound to a committed finish_work receipt");
    }
    const value = supplied.finish.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Adversarial finish value is invalid");
    const verdict = (value as Record<string, unknown>).status;
    const summary = (value as Record<string, unknown>).summary;
    if (!['passed', 'failed', 'blocked'].includes(String(verdict)) || typeof summary !== "string" || !summary.trim()) {
      throw new Error("Adversarial finish value must contain status and summary");
    }
    const details = {
      reviewerProfile: profile.adversarialReview.profile,
      agentSessionId: supplied.agentSessionId,
      finishToolCallId: supplied.finish.toolCallId,
      finishSchemaHash: supplied.finish.schemaHash,
      finishCommittedAt: supplied.finish.committedAt,
      result: value,
      artifacts: supplied.finish.artifacts,
    } as unknown as JsonObject;
    return gate("adversarial-review", verdict as VerificationGateStatus, summary, supplied.environmentHash, details, {
      agentSessionId: supplied.agentSessionId,
      finishToolCallId: supplied.finish.toolCallId,
      finishSchemaHash: supplied.finish.schemaHash,
    });
  }

  private requiredCandidate(candidateId: string): CandidateRecord {
    const candidate = this.database.readCandidate(candidateId);
    if (!candidate || candidate.runId !== this.runId) throw new Error(`Unknown candidate ${candidateId}`);
    return candidate;
  }

  private candidateRoot(candidate: CandidateRecord): string {
    const workspace = this.database.readCandidateWorkspace(candidate.workspace.workspaceId);
    if (!workspace || workspace.runId !== this.runId) throw new Error("Candidate workspace record is missing");
    if (workspace.rootPath !== `workspaces/candidates/${workspace.workspaceId}/project`) throw new Error("Candidate workspace path is noncanonical");
    return contained(this.runDir, workspace.rootPath);
  }

  private async readCandidateManifest(candidate: CandidateRecord): Promise<FrozenCandidateManifest> {
    const stored = await this.artifacts.read(candidate.manifest.digest);
    const value = JSON.parse(await fs.promises.readFile(stored.bodyPath, "utf8")) as FrozenCandidateManifest;
    if (
      value.formatVersion !== 1 || value.candidateId !== candidate.candidateId || value.runId !== candidate.runId
      || value.workspaceId !== candidate.workspace.workspaceId || value.tree.treeHash !== candidate.workspace.treeHash
      || value.lineageHash !== candidate.workspace.lineageHash || value.writeScopeHash !== candidate.workspace.writeScopeHash
      || stableJson(value.changedPaths) !== stableJson(candidate.changedPaths)
    ) throw new Error("Candidate manifest differs from its SQLite authority");
    return value;
  }

  private async readProjectManifest(): Promise<ProjectSnapshotManifest> {
    const filePath = path.join(this.runDir, "context", "project-manifest.json");
    const source = await fs.promises.readFile(filePath, "utf8");
    const value = JSON.parse(source) as ProjectSnapshotManifest;
    if (source !== `${stableJson(value)}\n`) throw new Error("Project manifest is not canonical");
    assertProjectSnapshotManifest(value);
    return value;
  }
}

function commandGate(
  kind: "tests" | "diagnostics",
  configured: VerificationCommandGate,
  supplied: VerificationCommandEvidence[] | undefined,
): GateEvidence {
  if (!Array.isArray(configured)) {
    if (supplied?.length) throw new Error(`${kind} evidence was supplied to a not-applicable gate`);
    return gate(kind, "not-applicable", configured.notApplicable,
      stableHash({ notApplicable: configured.notApplicable }), { notApplicable: configured.notApplicable });
  }
  if (!supplied || supplied.length !== configured.length) throw new Error(`${kind} evidence is incomplete`);
  const commands = configured.map((command, index) => validateCommandEvidence(command, supplied[index]!));
  const status: VerificationGateStatus = commands.some((command) => command.status !== "completed")
    ? "blocked"
    : commands.some((command) => command.exitCode !== 0)
      ? "failed"
      : "passed";
  const summary = status === "passed"
    ? `${commands.length} command${commands.length === 1 ? "" : "s"} passed`
    : status === "failed" ? "A deterministic command returned a failing exit code" : "Deterministic command infrastructure did not complete";
  return gate(kind, status, summary,
    stableHash(commands.map((command) => ({ commandId: command.commandId, environmentHash: command.environmentHash }))),
    { commands } as unknown as JsonObject);
}

function validateCommandEvidence(command: VerificationCommandProfile, evidence: VerificationCommandEvidence): VerificationCommandEvidence {
  if (evidence.commandId !== command.id) throw new Error(`Verification command evidence expected ${command.id}`);
  if (!isHash(evidence.stdoutDigest) || !isHash(evidence.stderrDigest) || !isHash(evidence.environmentHash)) {
    throw new Error(`Verification command ${command.id} has invalid evidence hashes`);
  }
  if (!Number.isSafeInteger(evidence.stdoutBytes) || evidence.stdoutBytes < 0 || !Number.isSafeInteger(evidence.stderrBytes) || evidence.stderrBytes < 0) {
    throw new Error(`Verification command ${command.id} has invalid output sizes`);
  }
  if (!Number.isFinite(Date.parse(evidence.startedAt)) || !Number.isFinite(Date.parse(evidence.completedAt))) {
    throw new Error(`Verification command ${command.id} has invalid timestamps`);
  }
  if (!['completed', 'timed-out', 'output-limited', 'infrastructure-failure', 'cancelled'].includes(evidence.status)) {
    throw new Error(`Verification command ${command.id} has an invalid status`);
  }
  if (evidence.status === "completed" && (!Number.isSafeInteger(evidence.exitCode) || evidence.exitCode! < 0 || evidence.exitCode! > 255)) {
    throw new Error(`Verification command ${command.id} lacks exact exit evidence`);
  }
  return structuredClone(evidence);
}

async function diffGate(
  profile: VerificationProfileSnapshot,
  candidate: CandidateRecord,
  manifest: FrozenCandidateManifest,
  candidateRoot: string,
): Promise<GateEvidence> {
  const policy = profile.diffInspection;
  const failures: string[] = [];
  if (policy.requireChanges && candidate.changedPaths.length === 0) failures.push("candidate has no changes");
  if (candidate.changedPaths.length > policy.maximumChangedPaths) failures.push("changed-path limit exceeded");
  const entries = new Map(manifest.tree.entries.map((entry) => [entry.path, entry]));
  for (const changedPath of candidate.changedPaths) {
    const entry = entries.get(changedPath);
    if (entry?.type === "file" && entry.bytes > policy.maximumFileBytes) failures.push(`${changedPath} exceeds the file-size policy`);
    if (!pathAllowed(policy.paths, changedPath)) failures.push(`${changedPath} is outside the verification path policy`);
    if (policy.forbidSecrets && entry?.type === "file" && await looksSecret(path.join(candidateRoot, changedPath), changedPath)) {
      failures.push(`${changedPath} resembles secret material`);
    }
  }
  const details = {
    changedPaths: candidate.changedPaths,
    changedPathCount: candidate.changedPaths.length,
    candidateTreeHash: candidate.workspace.treeHash,
    policyHash: stableHash(policy),
    failures: failures.slice(0, 64),
  } as unknown as JsonObject;
  return gate("diff-inspection", failures.length ? "failed" : "passed",
    failures.length ? failures[0]! : `${candidate.changedPaths.length} changed path${candidate.changedPaths.length === 1 ? "" : "s"} satisfy policy`,
    stableHash({ implementation: "deterministic-diff-v1", policy }), details);
}

function contaminationGate(
  candidate: CandidateRecord,
  observed: CandidateTreeManifest,
  project: ProjectSnapshotManifest,
): GateEvidence {
  const passed = observed.treeHash === candidate.workspace.treeHash;
  return gate("contamination", passed ? "passed" : "blocked",
    passed ? "Frozen candidate tree is unchanged" : "Candidate changed during verification",
    stableHash({ implementation: "candidate-contamination-v1" }), {
      candidateTreeHash: candidate.workspace.treeHash,
      observedTreeHash: observed.treeHash,
      projectSnapshotHash: project.treeHash,
      candidateLineageHash: candidate.workspace.lineageHash!,
      candidateWriteScopeHash: candidate.workspace.writeScopeHash!,
    });
}

function gate(
  kind: VerificationGateKind,
  status: VerificationGateStatus,
  summary: string,
  environmentHash: string,
  details: JsonObject,
  finish: Pick<GateEvidence, "agentSessionId" | "finishToolCallId" | "finishSchemaHash"> = {},
): GateEvidence {
  if (!isHash(environmentHash)) throw new Error(`Verification gate ${kind} has an invalid environment hash`);
  const body = { kind, status, summary, environmentHash, details, ...finish };
  return { ...body, evidenceHash: stableHash(body) };
}

function assertCandidateAttemptBinding(candidate: CandidateRecord, workspace: import("../runtime/durable-types.js").WorkspaceRef | undefined): void {
  if (!workspace || workspace.kind !== "candidate"
    || workspace.workspaceId !== candidate.workspace.workspaceId
    || workspace.treeHash !== candidate.workspace.treeHash
    || workspace.lineageHash !== candidate.workspace.lineageHash
    || workspace.writeScopeHash !== candidate.workspace.writeScopeHash) {
    throw new Error("Verification attempt is not bound to the exact candidate authority");
  }
}

function pathAllowed(scope: VerificationProfileSnapshot["diffInspection"]["paths"], candidatePath: string): boolean {
  if (scope === "all-semantic-project-paths") return true;
  const matches = (rule: string) => rule.endsWith("/") ? candidatePath.startsWith(rule) : candidatePath === rule;
  return scope.allow.some(matches) && !(scope.deny ?? []).some(matches);
}

async function looksSecret(filePath: string, candidatePath: string): Promise<boolean> {
  if (/(^|\/)(?:\.env(?:\..*)?|id_(?:rsa|ed25519)|credentials\.json)$/i.test(candidatePath)) return true;
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return false;
  const source = await fs.promises.readFile(filePath, "utf8").catch(() => "");
  return /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}/.test(source);
}

function contained(rootInput: string, relative: string): string {
  const root = path.resolve(rootInput);
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("Verification path escapes the run directory");
  return target;
}

function iso(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error("Verification timestamp is invalid");
  return value;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

export type VerificationReceiptRecord = VerificationRecord;
export type VerificationReceipt = VerificationRecord;
export type VerificationGateEvidence = GateEvidence;
export type { VerificationGateStatus } from "../runtime/durable-types.js";
export type { CandidatePathImage };
