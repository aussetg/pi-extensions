import path from "node:path";
import { candidateAuthorityBinding, verificationDispositionBinding } from "../candidates/disposition.js";
import { describeOpaqueAcceptedCandidateRef } from "../candidates/refs.js";
import { zeroUsage, type AttemptRecord, type CandidateRecord } from "../runtime/durable-types.js";
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
import { VerifiedApplyService, type VerifiedApplyServiceOptions } from "./verified-apply.js";

export interface SemanticApplyAdapterOptions {
  runDir: string;
  database: import("../persistence/run-database.js").RunDatabase;
  now?: () => Date;
  serviceOptions?: Omit<VerifiedApplyServiceOptions, "now">;
  currentVerificationBinding?: (
    verification: import("../runtime/durable-types.js").VerificationRecord,
  ) => { profileHash: string; gateEnvironmentHash: string } | Promise<{
    profileHash: string;
    gateEnvironmentHash: string;
  }>;
}

interface ResolvedApply {
  candidate: CandidateRecord;
  accepted: NonNullable<ReturnType<typeof describeOpaqueAcceptedCandidateRef>>;
  verification: import("../runtime/durable-types.js").VerificationRecord;
  semanticInput: JsonValue;
}

export interface ApplyWorkflowReceipt {
  applied: true;
  receiptId: string;
  candidateId: string;
  changedPaths: string[];
}

class ApplyWaitingError extends Error {
  constructor() {
    super("Live-project apply is waiting for exact human approval");
    this.name = "ApplyWaitingError";
  }
}

/** Human-approved live apply. Its journal policy is always never. */
export class SemanticApplyAdapter implements SemanticEffectAdapter {
  readonly kind = "apply" as const;
  private readonly runDir: string;
  private readonly service: VerifiedApplyService;
  private readonly now: () => Date;
  private readonly admissions = new Map<string, ResolvedApply>();

  constructor(private readonly options: SemanticApplyAdapterOptions) {
    this.runDir = path.resolve(options.runDir);
    if (path.resolve(options.database.databasePath) !== path.join(this.runDir, "run.sqlite")) {
      throw new Error("Apply adapter and run database directories differ");
    }
    this.now = options.now ?? (() => new Date());
    this.service = new VerifiedApplyService(this.runDir, options.database, {
      ...options.serviceOptions,
      now: this.now,
    });
  }

  semanticInput(request: SemanticEffectAdmissionRequest): JsonValue {
    return this.resolve(request).semanticInput;
  }

  journalIdentity(request: SemanticEffectAdmissionRequest): SemanticEffectJournalIdentity {
    return {
      semanticKey: stableHash({
        formatVersion: 1,
        kind: "human-approved-apply",
        semanticInput: this.resolve(request).semanticInput,
        contextIdentityHash: request.run.contextIdentityHash,
      }),
      completionAuthority: "host-effect",
      replayPolicy: "never",
    };
  }

  async execute(request: SemanticEffectRequest): Promise<SemanticEffectOutcome> {
    const resolved = this.resolve(request);
    const currentBinding = await this.options.currentVerificationBinding?.(resolved.verification) ?? {
      profileHash: resolved.verification.profileHash,
      gateEnvironmentHash: resolved.verification.gateEnvironmentHash,
    };
    if (
      currentBinding.profileHash !== resolved.verification.profileHash
      || currentBinding.gateEnvironmentHash !== resolved.verification.gateEnvironmentHash
    ) throw new Error("Verification policy or required tool environment changed before apply");
    const attempt = this.admitAttempt(request, resolved.candidate);
    let plan = request.database.readApplyPlanByOperation(request.operation.operationId);
    let approval = plan ? request.database.readApproval(plan.approvalId) : undefined;
    if (!plan) {
      const prepared = await this.service.prepare({
        operationId: request.operation.operationId,
        candidateId: resolved.candidate.candidateId,
        verificationId: resolved.verification.verificationId,
        verificationProfileHash: resolved.verification.profileHash,
        gateEnvironmentHash: resolved.verification.gateEnvironmentHash,
        createdAt: this.timestamp(),
      });
      plan = prepared.plan;
      approval = prepared.approval;
    }
    if (!approval) throw new Error("Apply approval disappeared after plan creation");
    if (approval.status === "waiting") throw new ApplyWaitingError();
    if (approval.status !== "completed" || approval.decision !== "approved") {
      throw new Error("Live-project apply does not have human approval");
    }
    const receipt = await this.service.apply({
      planId: plan.planId,
      verificationProfileHash: resolved.verification.profileHash,
      gateEnvironmentHash: resolved.verification.gateEnvironmentHash,
      signal: request.signal,
      startedAt: this.timestamp(),
    });
    const value: ApplyWorkflowReceipt = {
      applied: true,
      receiptId: receipt.receiptId,
      candidateId: receipt.candidateId,
      changedPaths: [...receipt.changedPaths],
    };
    return {
      result: { value: value as unknown as JsonValue, artifacts: [plan.manifest] },
      attemptId: attempt.attemptId,
      completionAuthority: "host-effect",
    };
  }

  restore(request: SemanticEffectRestoreRequest): ApplyWorkflowReceipt {
    const resolved = this.resolve(request);
    const plan = request.database.readApplyPlanByOperation(request.operation.operationId);
    if (!plan) throw new Error(`Completed apply ${request.path} has no exact plan`);
    const receipt = request.database.readApplyReceipt(plan.planId);
    if (!receipt || receipt.candidateId !== resolved.candidate.candidateId
      || receipt.verificationId !== resolved.verification.verificationId) {
      throw new Error(`Completed apply ${request.path} has no exact receipt`);
    }
    const value: ApplyWorkflowReceipt = {
      applied: true,
      receiptId: receipt.receiptId,
      candidateId: receipt.candidateId,
      changedPaths: [...receipt.changedPaths],
    };
    if (stableJson(value) !== stableJson(request.operation.result.value)) {
      throw new Error(`Completed apply ${request.path} differs from its operation output`);
    }
    return Object.freeze(value);
  }

  private resolve(request: SemanticEffectAdmissionRequest): ResolvedApply {
    const cached = this.admissions.get(request.path);
    if (cached) return cached;
    const input = plainRecord(request.input, "flow.apply options");
    exactKeys(input, new Set(["candidate", "verification"]), "flow.apply options");
    const accepted = describeOpaqueAcceptedCandidateRef(input.candidate);
    if (!accepted || accepted.runId !== request.run.runId) {
      throw new TypeError("flow.apply requires an accepted candidate from this run");
    }
    const candidate = this.options.database.readCandidate(accepted.candidateId);
    if (!candidate || candidate.workspace.treeHash !== accepted.treeHash
      || candidate.workspace.lineageHash !== accepted.lineageHash
      || stableHash(candidate) !== accepted.recordHash) {
      throw new TypeError("flow.apply accepted candidate is stale");
    }
    const acceptance = findAcceptance(this.options.database, accepted, candidate);
    const verification = requireVerificationReceipt(this.options.database, input.verification, candidate, true);
    if (acceptance.verification.bindingHash !== verificationDispositionBinding(verification).bindingHash) {
      throw new TypeError("flow.apply verification differs from the accepted disposition");
    }
    const resolved: ResolvedApply = {
      candidate,
      accepted,
      verification,
      semanticInput: {
        candidate: candidateAuthorityBinding(candidate),
        acceptanceRecordHash: accepted.acceptanceRecordHash,
        verification: verificationDispositionBinding(verification),
      } as unknown as JsonValue,
    };
    this.admissions.set(request.path, resolved);
    return resolved;
  }

  private admitAttempt(request: SemanticEffectRequest, candidate: CandidateRecord): AttemptRecord {
    const attemptId = `attempt_${stableHash({
      formatVersion: 1,
      runId: request.run.runId,
      operationId: request.operation.operationId,
      effect: "apply",
    }).slice(7, 39)}`;
    const existing = request.database.readAttempt(attemptId);
    if (existing) {
      if (existing.operationId !== request.operation.operationId || existing.effect !== "apply") {
        throw new Error(`Apply attempt collision ${attemptId}`);
      }
      return existing;
    }
    const at = this.timestamp();
    return request.database.insertAttempt(request.database.readRun().revision, {
      attemptId,
      runId: request.run.runId,
      operationId: request.operation.operationId,
      number: 1,
      effect: "apply",
      status: "running",
      preWorkspace: candidate.workspace,
      usage: zeroUsage(),
      outputArtifacts: [],
      startedAt: at,
      updatedAt: at,
    }, {
      type: "apply-attempt-started",
      operationId: request.operation.operationId,
      attemptId,
      payload: { candidateId: candidate.candidateId },
      at,
    });
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Apply clock is invalid");
    return value.toISOString();
  }
}

function findAcceptance(
  database: import("../persistence/run-database.js").RunDatabase,
  accepted: NonNullable<ReturnType<typeof describeOpaqueAcceptedCandidateRef>>,
  candidate: CandidateRecord,
): import("../candidates/disposition.js").CandidateAcceptanceRecord {
  const matches: import("../candidates/disposition.js").CandidateAcceptanceRecord[] = [];
  let afterOrdinal = -1;
  while (true) {
    const page = database.listOperations({ afterOrdinal, limit: 256 });
    for (const operation of page) {
      if (operation.kind !== "accept" || operation.status !== "completed" || !operation.result?.value) continue;
      const value = operation.result.value as unknown as import("../candidates/disposition.js").CandidateAcceptanceRecord;
      if (value.receiptId === accepted.acceptanceReceiptId && value.recordHash === accepted.acceptanceRecordHash) matches.push(value);
    }
    if (page.length < 256) break;
    afterOrdinal = page.at(-1)!.ordinal;
  }
  if (matches.length !== 1) throw new TypeError("Accepted candidate has no unique completed disposition");
  const acceptance = matches[0]!;
  if (stableHash(acceptance.candidate) !== stableHash(candidateAuthorityBinding(candidate))) {
    throw new TypeError("Accepted disposition candidate authority is stale");
  }
  return acceptance;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length) throw new TypeError(`${label} contains unknown fields: ${extras.sort().join(", ")}`);
}

