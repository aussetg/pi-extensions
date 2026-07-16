import fs from "node:fs";
import path from "node:path";
import { describeOpaqueCandidateRef } from "../candidates/refs.js";
import { RunDatabaseReader } from "../persistence/run-database.js";
import { zeroUsage, type CandidateRecord, type AttemptRecord, type VerificationRecord } from "../runtime/durable-types.js";
import type {
  SemanticEffectAdapter,
  SemanticEffectAdmissionRequest,
  SemanticEffectJournalIdentity,
  SemanticEffectOutcome,
  SemanticEffectRequest,
  SemanticEffectRestoreRequest,
  SemanticReplayMaterialization,
  SemanticReplaySource,
} from "../runtime/semantic-engine-types.js";
import { canonicalStructuralJson } from "../runtime/semantic-engine-values.js";
import type { JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import {
  assertProjectSnapshotManifest,
  scanProjectSource,
  type ProjectSnapshotManifest,
} from "../workspaces/project-snapshot.js";
import { resolveVerificationProfile, type VerificationProfileSnapshot } from "./profiles.js";
import {
  VerificationService,
  type VerificationEvidenceInput,
} from "./receipts.js";

export interface SemanticVerificationContext {
  runId: string;
  operationId?: string;
  operationPath: string;
  candidate: CandidateRecord;
  candidateRoot: string;
  profile: VerificationProfileSnapshot;
}

export interface SemanticVerificationEvidenceProvider {
  /** Stable identity of required command/reviewer tooling, not transient pressure. */
  environmentIdentity(context: SemanticVerificationContext): JsonValue | Promise<JsonValue>;
  collect(
    context: SemanticVerificationContext & { operationId: string; attemptId: string; signal: AbortSignal },
  ): Promise<VerificationEvidenceInput>;
}

export interface SemanticVerificationAdapterOptions {
  runDir: string;
  database: import("../persistence/run-database.js").RunDatabase;
  profiles: readonly VerificationProfileSnapshot[];
  evidence: SemanticVerificationEvidenceProvider;
  now?: () => Date;
}

interface ResolvedVerification {
  candidate: CandidateRecord;
  candidateRoot: string;
  profile: VerificationProfileSnapshot;
  projectSnapshotHash: string;
  liveProjectTreeHash: string;
  environmentIdentity: JsonValue;
  environmentIdentityHash: string;
  semanticInput: JsonValue;
}

interface VerificationResultValue {
  formatVersion: 1;
  status: VerificationRecord["status"];
  candidateTreeHash: string;
  candidateLineageHash: string;
  candidateWriteScopeHash: string;
  profileHash: string;
  gateEnvironmentHash: string;
  evidenceHash: string;
  bindingHash: string;
}

export interface VerificationWorkflowReceipt {
  receiptId: string;
  candidateId: string;
  candidateLineageHash: string;
  candidateTreeHash: string;
  candidateWriteScopeHash: string;
  profileHash: string;
  policyHash: string;
  gateEvidenceHashes: string[];
  environmentHash: string;
  passed: boolean;
  status: VerificationRecord["status"];
}

/** Exact candidate + policy verification as an immutable semantic effect. */
export class SemanticVerificationAdapter implements SemanticEffectAdapter {
  readonly kind = "verify" as const;
  private readonly runDir: string;
  private readonly service: VerificationService;
  private readonly now: () => Date;
  private readonly admissions = new Map<string, Promise<ResolvedVerification>>();

  constructor(private readonly options: SemanticVerificationAdapterOptions) {
    this.runDir = path.resolve(options.runDir);
    if (path.resolve(options.database.databasePath) !== path.join(this.runDir, "run.sqlite")) {
      throw new Error("Verification adapter and run database directories differ");
    }
    this.now = options.now ?? (() => new Date());
    this.service = new VerificationService(this.runDir, options.database, this.now);
  }

  async semanticInput(request: SemanticEffectAdmissionRequest): Promise<JsonValue> {
    return (await this.resolve(request)).semanticInput;
  }

  async journalIdentity(request: SemanticEffectAdmissionRequest): Promise<SemanticEffectJournalIdentity> {
    const resolved = await this.resolve(request);
    return {
      semanticKey: stableHash({
        formatVersion: 1,
        kind: "verification",
        semanticInput: resolved.semanticInput,
        contextIdentityHash: request.run.contextIdentityHash,
      }),
      completionAuthority: "host-effect",
      replayPolicy: "immutable",
    };
  }

  async execute(request: SemanticEffectRequest): Promise<SemanticEffectOutcome> {
    const resolved = await this.resolve(request);
    const attempt = this.admitAttempt(request, resolved.candidate);
    const context = this.context(request, resolved);
    const evidence = await this.options.evidence.collect({
      ...context,
      operationId: request.operation.operationId,
      attemptId: attempt.attemptId,
      signal: request.signal,
    });
    const verification = await this.service.prepare({
      operationId: request.operation.operationId,
      attemptId: attempt.attemptId,
      candidateId: resolved.candidate.candidateId,
      profile: resolved.profile,
      evidence,
      createdAt: this.timestamp(),
    });
    const value = verificationResultValue(verification);
    return {
      result: { value: value as unknown as JsonValue, artifacts: [verification.evidence] },
      attemptId: attempt.attemptId,
      verification,
      completionAuthority: "host-effect",
    };
  }

  async materializeImmutableReplay(
    request: SemanticEffectRequest,
    source: SemanticReplaySource,
  ): Promise<SemanticReplayMaterialization> {
    const resolved = await this.resolve(request);
    const sourceDatabase = RunDatabaseReader.open(
      path.join(source.runDir, "run.sqlite"),
    );
    try {
      const prior = sourceDatabase.readVerificationByOperation(source.operation.operationId);
      if (!prior) throw new Error("Replay verification has no normalized source record");
      assertReplayBinding(prior, resolved);
      const attempt = this.admitAttempt(request, resolved.candidate);
      const verificationId = verificationRecordId({
        runId: request.run.runId,
        operationId: request.operation.operationId,
        attemptId: attempt.attemptId,
        candidateId: resolved.candidate.candidateId,
        candidateTreeHash: resolved.candidate.workspace.treeHash,
        profileHash: resolved.profile.hash,
        gateEnvironmentHash: prior.gateEnvironmentHash,
      });
      const verification: VerificationRecord = {
        ...prior,
        verificationId,
        runId: request.run.runId,
        operationId: request.operation.operationId,
        attemptId: attempt.attemptId,
        attemptNumber: attempt.number,
        candidateId: resolved.candidate.candidateId,
        candidateTreeHash: resolved.candidate.workspace.treeHash,
        candidateLineageHash: resolved.candidate.workspace.lineageHash!,
        candidateWriteScopeHash: resolved.candidate.workspace.writeScopeHash!,
        projectSnapshotHash: resolved.projectSnapshotHash,
        liveProjectTreeHash: resolved.liveProjectTreeHash,
        profileId: resolved.profile.id,
        profileHash: resolved.profile.hash,
        gates: prior.gates.map((gate) => {
          const { agentSessionId: _agentSessionId, finishToolCallId: _finishToolCallId, finishSchemaHash: _finishSchemaHash, ...portable } = gate;
          return { ...portable, verificationId };
        }),
      };
      if (stableHash(verificationResultValue(verification)) !== stableHash(source.call.result.value)) {
        throw new Error("Replay verification output changed its immutable semantic binding");
      }
      return { result: source.call.result, attemptId: attempt.attemptId, verification };
    } finally {
      sourceDatabase.close();
    }
  }

  async restore(request: SemanticEffectRestoreRequest): Promise<VerificationWorkflowReceipt> {
    const resolved = await this.resolve(request);
    const verification = request.database.readVerificationByOperation(request.operation.operationId);
    if (!verification) throw new Error(`Completed verification ${request.path} has no SQLite record`);
    assertReplayBinding(verification, resolved);
    if (stableHash(verificationResultValue(verification)) !== stableHash(request.operation.result.value)) {
      throw new Error(`Completed verification ${request.path} differs from its operation output`);
    }
    return verificationWorkflowReceipt(verification);
  }

  private resolve(request: SemanticEffectAdmissionRequest): Promise<ResolvedVerification> {
    let pending = this.admissions.get(request.path);
    if (!pending) {
      pending = this.resolveFresh(request);
      this.admissions.set(request.path, pending);
    }
    return pending;
  }

  private async resolveFresh(request: SemanticEffectAdmissionRequest): Promise<ResolvedVerification> {
    const input = plainRecord(request.input, "flow.verify options");
    exactKeys(input, new Set(["title", "candidate", "profile"]), "flow.verify options");
    if (input.title !== undefined) boundedTitle(input.title);
    if (typeof input.profile !== "string") throw new TypeError("flow.verify profile must be a selector");
    const descriptor = describeOpaqueCandidateRef(input.candidate);
    if (!descriptor || descriptor.runId !== request.run.runId) {
      throw new TypeError("flow.verify candidate is not from this run");
    }
    const candidate = this.options.database.readCandidate(descriptor.candidateId);
    if (!candidate || !sameCandidate(candidate, descriptor)) throw new TypeError("flow.verify candidate reference is stale");
    const workspace = this.options.database.readCandidateWorkspace(candidate.workspace.workspaceId);
    if (!workspace) throw new Error(`Candidate ${candidate.candidateId} has no mutable workspace authority`);
    const candidateRoot = path.join(this.runDir, workspace.rootPath);
    const profile = resolveVerificationProfile(this.options.profiles, input.profile);
    const project = await readProjectManifest(this.runDir);
    if (project.treeHash !== request.run.projectSnapshotHash) throw new Error("Verification launch snapshot is stale");
    const live = await scanProjectSource(project.sourceRoot);
    const context: SemanticVerificationContext = {
      runId: request.run.runId,
      operationPath: request.path,
      candidate,
      candidateRoot,
      profile,
    };
    const environmentIdentity = canonicalStructuralJson(
      await this.options.evidence.environmentIdentity(context),
    );
    const environmentIdentityHash = stableHash(environmentIdentity);
    return {
      candidate,
      candidateRoot,
      profile,
      projectSnapshotHash: project.treeHash,
      liveProjectTreeHash: live.treeHash,
      environmentIdentity,
      environmentIdentityHash,
      semanticInput: {
        candidate: {
          treeHash: candidate.workspace.treeHash,
          lineageHash: candidate.workspace.lineageHash!,
          writeScopeHash: candidate.workspace.writeScopeHash!,
        },
        profileId: profile.id,
        profileHash: profile.hash,
        projectSnapshotHash: project.treeHash,
        liveProjectTreeHash: live.treeHash,
        environmentIdentityHash,
      },
    };
  }

  private context(
    request: SemanticEffectAdmissionRequest,
    resolved: ResolvedVerification,
  ): SemanticVerificationContext {
    return {
      runId: request.run.runId,
      operationPath: request.path,
      candidate: resolved.candidate,
      candidateRoot: resolved.candidateRoot,
      profile: resolved.profile,
    };
  }

  private admitAttempt(request: SemanticEffectRequest, candidate: CandidateRecord): AttemptRecord {
    const attemptId = `attempt_${stableHash({
      formatVersion: 1,
      runId: request.run.runId,
      operationId: request.operation.operationId,
      effect: "verification",
    }).slice(7, 39)}`;
    const existing = request.database.readAttempt(attemptId);
    if (existing) {
      if (existing.operationId !== request.operation.operationId || existing.effect !== "verification") {
        throw new Error(`Verification attempt collision ${attemptId}`);
      }
      return existing;
    }
    const at = this.timestamp();
    return request.database.insertAttempt(request.database.readRun().revision, {
      attemptId,
      runId: request.run.runId,
      operationId: request.operation.operationId,
      number: 1,
      effect: "verification",
      status: "running",
      preWorkspace: candidate.workspace,
      usage: zeroUsage(),
      outputArtifacts: [],
      startedAt: at,
      updatedAt: at,
    }, {
      type: "verification-attempt-started",
      operationId: request.operation.operationId,
      attemptId,
      payload: { candidateId: candidate.candidateId },
      at,
    });
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Verification clock is invalid");
    return value.toISOString();
  }
}

export function verificationWorkflowReceipt(record: VerificationRecord): VerificationWorkflowReceipt {
  return Object.freeze({
    receiptId: record.verificationId,
    candidateId: record.candidateId,
    candidateLineageHash: record.candidateLineageHash,
    candidateTreeHash: record.candidateTreeHash,
    candidateWriteScopeHash: record.candidateWriteScopeHash,
    profileHash: record.profileHash,
    policyHash: stableHash({
      profileHash: record.profileHash,
      gates: record.gates.map((gate) => ({ kind: gate.kind, environmentHash: gate.environmentHash })),
    }),
    gateEvidenceHashes: record.gates.map((gate) => gate.evidenceHash),
    environmentHash: record.gateEnvironmentHash,
    passed: record.status === "passed",
    status: record.status,
  });
}

export function requireVerificationReceipt(
  database: import("../persistence/run-database.js").RunDatabase,
  value: unknown,
  candidate: CandidateRecord,
  passed: boolean | undefined,
): VerificationRecord {
  const receipt = plainRecord(value, "verification receipt");
  if (typeof receipt.receiptId !== "string") throw new TypeError("Verification receipt id is missing");
  const record = database.readVerification(receipt.receiptId);
  if (!record || record.runId !== candidate.runId) throw new TypeError("Verification receipt is unknown");
  if (passed !== undefined && (record.status === "passed") !== passed) {
    throw new TypeError(passed ? "A passed verification receipt is required" : "Verification receipt status changed");
  }
  if (!sameCandidateRecord(record, candidate)) throw new TypeError("Verification receipt belongs to another candidate authority");
  if (stableJson(verificationWorkflowReceipt(record)) !== stableJson(value)) {
    throw new TypeError("Verification receipt was forged or changed");
  }
  return record;
}

function verificationResultValue(record: VerificationRecord): VerificationResultValue {
  const body = {
    formatVersion: 1 as const,
    status: record.status,
    candidateTreeHash: record.candidateTreeHash,
    candidateLineageHash: record.candidateLineageHash,
    candidateWriteScopeHash: record.candidateWriteScopeHash,
    profileHash: record.profileHash,
    gateEnvironmentHash: record.gateEnvironmentHash,
    evidenceHash: record.evidenceHash,
  };
  return { ...body, bindingHash: stableHash(body) };
}

function verificationRecordId(input: {
  runId: string;
  operationId: string;
  attemptId: string;
  candidateId: string;
  candidateTreeHash: string;
  profileHash: string;
  gateEnvironmentHash: string;
}): string {
  return `verification_${stableHash(input).slice(7, 39)}`;
}

function assertReplayBinding(record: VerificationRecord, resolved: ResolvedVerification): void {
  if (
    record.candidateTreeHash !== resolved.candidate.workspace.treeHash
    || record.candidateLineageHash !== resolved.candidate.workspace.lineageHash
    || record.candidateWriteScopeHash !== resolved.candidate.workspace.writeScopeHash
    || record.projectSnapshotHash !== resolved.projectSnapshotHash
    || record.liveProjectTreeHash !== resolved.liveProjectTreeHash
    || record.profileId !== resolved.profile.id
    || record.profileHash !== resolved.profile.hash
  ) throw new Error("Verification candidate, policy, project, or live binding changed");
}

function sameCandidateRecord(record: VerificationRecord, candidate: CandidateRecord): boolean {
  return record.candidateId === candidate.candidateId
    && record.candidateTreeHash === candidate.workspace.treeHash
    && record.candidateLineageHash === candidate.workspace.lineageHash
    && record.candidateWriteScopeHash === candidate.workspace.writeScopeHash;
}

function sameCandidate(
  candidate: CandidateRecord,
  descriptor: NonNullable<ReturnType<typeof describeOpaqueCandidateRef>>,
): boolean {
  return candidate.candidateId === descriptor.candidateId
    && candidate.workspace.treeHash === descriptor.treeHash
    && candidate.workspace.lineageHash === descriptor.lineageHash
    && stableHash(candidate) === descriptor.recordHash;
}

async function readProjectManifest(runDir: string): Promise<ProjectSnapshotManifest> {
  const source = await fs.promises.readFile(path.join(runDir, "context", "project-manifest.json"), "utf8");
  const value = JSON.parse(source) as ProjectSnapshotManifest;
  if (source !== `${stableJson(value)}\n`) throw new Error("Project manifest is not canonical");
  assertProjectSnapshotManifest(value);
  return value;
}

function boundedTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > 192) {
    throw new TypeError("verification title is invalid");
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

