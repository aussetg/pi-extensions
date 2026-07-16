import fs from "node:fs";
import path from "node:path";
import { ArtifactStore, createOpaqueArtifactRef } from "../artifacts/store.js";
import { SemanticAgentAdapter } from "../agents/semantic-adapter.js";
import type { PreparedWorkflowExecutionResources } from "../agents/resources.js";
import type { HostCommandExecutor, HostCommandResult } from "../commands/executor.js";
import type { CommandProfileSnapshot } from "../commands/profiles.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import { RunDatabase, RunRevisionConflictError } from "../persistence/run-database.js";
import { zeroUsage, type OperationRecord } from "../runtime/durable-types.js";
import {
  deterministicSemanticId,
  semanticOperationPath,
} from "../runtime/semantic-engine-helpers.js";
import type { SemanticEffectAdmissionRequest, SemanticEffectOutcome } from "../runtime/semantic-engine-types.js";
import { canonicalStructuralJson } from "../runtime/semantic-engine-values.js";
import type { JsonSchema, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import type {
  SemanticVerificationContext,
  SemanticVerificationEvidenceProvider,
} from "./semantic-adapter.js";
import {
  verificationCommandEnvironmentHash,
  verificationCommandProfile,
  verificationReviewerEnvironmentHash,
} from "./environment.js";
import type {
  VerificationCommandEvidence,
  VerificationEvidenceInput,
  VerificationReviewEvidence,
} from "./receipts.js";
import type { VerificationCommandGate, VerificationCommandProfile } from "./profiles.js";

const REVIEW_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["status", "summary"],
  properties: {
    status: { type: "string", enum: ["passed", "failed", "blocked"] },
    summary: { type: "string", minLength: 1, maxLength: 8_000 },
  },
});

export interface HostVerificationEvidenceProviderOptions {
  runDir: string;
  database: RunDatabase;
  resources: PreparedWorkflowExecutionResources;
  commandExecutor: HostCommandExecutor;
  agentAdapter: SemanticAgentAdapter;
  now?: () => Date;
}

/** Runs deterministic gates read-only and obtains adversarial conclusions through finish_work. */
export class HostVerificationEvidenceProvider implements SemanticVerificationEvidenceProvider {
  private readonly runDir: string;
  private readonly now: () => Date;
  private readonly artifacts: ArtifactStore;

  constructor(private readonly options: HostVerificationEvidenceProviderOptions) {
    this.runDir = path.resolve(options.runDir);
    if (path.resolve(options.database.databasePath) !== path.join(this.runDir, "run.sqlite")) {
      throw new Error("Verification evidence provider and run database directories differ");
    }
    this.now = options.now ?? (() => new Date());
    this.artifacts = new ArtifactStore(this.runDir, options.database, { now: this.now });
  }

  environmentIdentity(context: SemanticVerificationContext): JsonValue {
    const executor = this.options.commandExecutor.describe();
    const reviewer = "profile" in context.profile.adversarialReview
      ? this.options.resources.agentSelections.find((selection) =>
          selection.operationId === reviewerSourceId(context.profile.name))
      : undefined;
    return {
      formatVersion: 1,
      commandExecutor: {
        id: executor.id,
        protocolVersion: executor.protocolVersion,
        sandbox: executor.sandbox,
      },
      tests: gateIdentity(context.profile.tests),
      diagnostics: gateIdentity(context.profile.diagnostics),
      ...(reviewer ? { reviewerAuthorityHash: reviewer.authorityHash } : {}),
    } as unknown as JsonValue;
  }

  async collect(
    context: SemanticVerificationContext & { operationId: string; attemptId: string; signal: AbortSignal },
  ): Promise<VerificationEvidenceInput> {
    const tests = await this.commands("tests", context.profile.tests, context);
    const diagnostics = await this.commands("diagnostics", context.profile.diagnostics, context);
    const adversarialReview = "profile" in context.profile.adversarialReview
      ? await this.review(context)
      : undefined;
    return {
      ...(tests ? { tests } : {}),
      ...(diagnostics ? { diagnostics } : {}),
      ...(adversarialReview ? { adversarialReview } : {}),
    };
  }

  private async commands(
    gate: "tests" | "diagnostics",
    configured: VerificationCommandGate,
    context: SemanticVerificationContext & { operationId: string; attemptId: string; signal: AbortSignal },
  ): Promise<VerificationCommandEvidence[] | undefined> {
    if (!Array.isArray(configured)) return undefined;
    const evidence: VerificationCommandEvidence[] = [];
    for (const [ordinal, command] of configured.entries()) {
      if (context.signal.aborted) throw context.signal.reason;
      const safety = this.options.database.readRun().safety;
      const profile = verificationCommandProfile(context.profile.id, gate, command);
      const executionId = `command_${stableHash({
        runId: context.runId,
        operationId: context.operationId,
        gate,
        ordinal,
      }).slice(7, 39)}`;
      const result = await this.options.commandExecutor.execute({
        runId: context.runId,
        operationPath: `${context.operationPath}/${gate}:${command.id}`,
        attempt: 1,
        executionId,
        runDir: this.runDir,
        workspaceRoot: context.candidateRoot,
        cwd: context.candidateRoot,
        profile,
        arguments: {},
        effect: "read-only",
        safety,
        maximumOutputBytes: Math.min(safety.outputBytes, profile.outputLimitBytes),
        inlineLimitBytes: Math.min(
          safety.outputBytes,
          profile.outputLimitBytes,
          DEFINITION_LIMITS.commandInlineBytes,
        ),
        unitKind: "verification",
      }, context.signal);
      evidence.push(commandEvidence(command, profile, this.options.commandExecutor.describe(), result));
    }
    return evidence;
  }

  private async review(
    context: SemanticVerificationContext & { operationId: string; attemptId: string; signal: AbortSignal },
  ): Promise<VerificationReviewEvidence> {
    const policy = context.profile.adversarialReview;
    if (!("profile" in policy)) throw new Error("Adversarial review policy is not active");
    const sourceId = reviewerSourceId(context.profile.name);
    const operationPath = semanticOperationPath(context.operationPath, "agent", sourceId);
    const candidateContent = await this.candidateReviewContent(context);
    const input = {
      profile: policy.profile,
      prompt: [
        "Review the exact frozen candidate manifest and deterministic diff supplied as artifacts.",
        "candidate-content.json contains the exact before/after bytes for every changed path; inspect it instead of reading changed paths from the launch workspace.",
        "Look for correctness, regression, security, scope, and missing-test risks.",
        policy.instructions ?? "Return passed only when the candidate is safe to apply.",
        "Finish with exactly { status, summary }; prose is not completion.",
      ].join("\n\n"),
      inputs: [
        { id: "candidate-manifest", artifact: createOpaqueArtifactRef(context.candidate.manifest) },
        { id: "candidate-diff", artifact: createOpaqueArtifactRef(context.candidate.diff) },
        { id: "candidate-content", artifact: createOpaqueArtifactRef(candidateContent) },
      ],
      outputSchema: REVIEW_SCHEMA,
      network: "none",
      resultMode: "value",
    };
    const admission: SemanticEffectAdmissionRequest = {
      run: this.options.database.readRun(),
      kind: "agent",
      sourceId,
      path: operationPath,
      input,
    };
    const semanticInputHash = stableHash(canonicalStructuralJson(
      await this.options.agentAdapter.semanticInput(admission),
    ));
    const operation = await this.claimReviewer(context.operationId, sourceId, operationPath, semanticInputHash);
    if (operation.status !== "completed") {
      try {
        const outcome = await this.options.agentAdapter.execute({
          ...admission,
          run: this.options.database.readRun(),
          database: this.options.database,
          operation,
          signal: context.signal,
        });
        await this.completeReviewer(operation, context.operationId, outcome);
      } catch (error) {
        await this.failReviewer(operation, context.operationId, error);
        throw error;
      }
    }
    const session = this.options.database.readAgentSessionByOperation(operation.operationId);
    if (!session?.finish) throw new Error("Adversarial review completed without a finish_work receipt");
    return {
      agentSessionId: session.agentSessionId,
      finish: structuredClone(session.finish),
      environmentHash: verificationReviewerEnvironmentHash({
        profileId: session.profileId,
        routeId: session.routeId,
        authorityHash: requiredReviewerAuthority(this.options.resources, sourceId),
      }),
    };
  }

  private async candidateReviewContent(context: SemanticVerificationContext) {
    const launchRoot = path.join(this.runDir, "context", "project");
    const entries: JsonValue[] = [];
    for (const relative of context.candidate.changedPaths) {
      entries.push({
        path: relative,
        before: await reviewPath(launchRoot, relative),
        after: await reviewPath(context.candidateRoot, relative),
      });
    }
    return (await this.artifacts.putJson({
      expectedRevision: this.options.database.readRun().revision,
      kind: "verification-review-content",
      value: { formatVersion: 1, candidateTreeHash: context.candidate.workspace.treeHash, entries },
      metadata: { candidateId: context.candidate.candidateId },
      maximumBytes: this.options.database.readRun().safety.outputBytes,
      createdAt: this.timestamp(),
    })).artifact;
  }

  private async claimReviewer(
    parentOperationId: string,
    sourceId: string,
    operationPath: string,
    semanticInputHash: string,
  ): Promise<OperationRecord> {
    for (let retry = 0; retry < 16; retry += 1) {
      const existing = this.options.database.readOperationByPath(operationPath);
      if (existing?.status === "completed") return existing;
      const run = this.options.database.readRun();
      const at = this.timestamp();
      const operation: OperationRecord = {
        operationId: deterministicSemanticId("operation", run.runId, operationPath),
        runId: run.runId,
        parentOperationId,
        path: operationPath,
        sourceId,
        kind: "agent",
        ordinal: existing?.ordinal ?? nextOperationOrdinal(this.options.database),
        status: "running",
        semanticInputHash,
        attemptCount: existing?.attemptCount ?? 0,
        createdAt: existing?.createdAt ?? at,
        startedAt: existing?.startedAt ?? at,
        updatedAt: at,
      };
      try {
        return this.options.database.claimOperation({
          expectedRevision: run.revision,
          operation,
          admission: {
            maximumOperations: DEFINITION_LIMITS.semanticOperations,
            maximumAgentOperations: run.safety.maximumAgentLaunches,
          },
          event: {
            type: existing ? "verification-reviewer-focused" : "verification-reviewer-claimed",
            operationId: operation.operationId,
            payload: { path: operationPath },
            at,
          },
        }).operation;
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error("Could not claim adversarial reviewer after repeated revision races");
  }

  private async completeReviewer(
    operation: OperationRecord,
    parentOperationId: string,
    outcome: SemanticEffectOutcome,
  ): Promise<void> {
    if (outcome.completionAuthority !== "finish-work") {
      throw new Error("Adversarial reviewer completed through the wrong authority");
    }
    for (let retry = 0; retry < 16; retry += 1) {
      const existing = this.options.database.readOperation(operation.operationId);
      if (existing?.status === "completed") return;
      const run = this.options.database.readRun();
      try {
        this.options.database.completeOperation({
          expectedRevision: run.revision,
          operationId: operation.operationId,
          ...(outcome.attemptId ? { attemptId: outcome.attemptId } : {}),
          completedAt: this.timestamp(),
          result: outcome.result,
          ...(outcome.evidenceArtifacts ? { evidenceArtifacts: outcome.evidenceArtifacts } : {}),
          ...(outcome.progressArtifacts ? { progressArtifacts: outcome.progressArtifacts } : {}),
          usage: outcome.usage ?? zeroUsage(),
          ...(outcome.resources ? { resources: outcome.resources } : {}),
          currentOperationId: parentOperationId,
          event: {
            type: "verification-reviewer-completed",
            payload: { path: operation.path, completionAuthority: "finish-work" },
          },
        });
        return;
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error("Could not complete adversarial reviewer after repeated revision races");
  }

  private async failReviewer(operation: OperationRecord, parentOperationId: string, error: unknown): Promise<void> {
    for (let retry = 0; retry < 16; retry += 1) {
      const current = this.options.database.readOperation(operation.operationId);
      if (!current || current.status === "failed" || current.status === "completed" || current.status === "stopped") return;
      const run = this.options.database.readRun();
      try {
        this.options.database.failOperation({
          expectedRevision: run.revision,
          operationId: operation.operationId,
          failedAt: this.timestamp(),
          reason: {
            category: "effect",
            code: "verification-reviewer-failed",
            summary: boundedError(error),
            retryable: true,
            operationId: operation.operationId,
          },
          currentOperationId: parentOperationId,
          event: { type: "verification-reviewer-failed", payload: { path: operation.path } },
        });
        return;
      } catch (transitionError) {
        if (transitionError instanceof RunRevisionConflictError) continue;
        throw transitionError;
      }
    }
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Verification evidence clock is invalid");
    return value.toISOString();
  }
}

function commandEvidence(
  command: VerificationCommandProfile,
  profile: CommandProfileSnapshot,
  executor: ReturnType<HostCommandExecutor["describe"]>,
  result: HostCommandResult,
): VerificationCommandEvidence {
  return {
    commandId: command.id,
    status: result.status,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdoutDigest: result.stdoutEvidence.digest,
    stdoutBytes: result.stdoutEvidence.bytes,
    stderrDigest: result.stderrEvidence.digest,
    stderrBytes: result.stderrEvidence.bytes,
    environmentHash: verificationCommandEnvironmentHash(profile, executor),
    startedAt: result.startedAt,
    completedAt: result.endedAt,
  };
}

function gateIdentity(gate: VerificationCommandGate): JsonValue {
  return Array.isArray(gate)
    ? gate.map((command) => ({ id: command.id, argv: command.argv, env: command.env ?? {}, timeoutMs: command.timeoutMs })) as unknown as JsonValue
    : { notApplicable: gate.notApplicable };
}

async function reviewPath(root: string, relative: string): Promise<JsonValue> {
  const target = path.resolve(root, relative);
  const contained = path.relative(root, target);
  if (!contained || contained === ".." || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained)) {
    throw new Error(`Candidate review path escapes its root: ${relative}`);
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(target);
  } catch (error: any) {
    if (error?.code === "ENOENT") return { type: "missing" };
    throw error;
  }
  if (stat.isFile()) {
    const content = await fs.promises.readFile(target);
    return { type: "file", mode: stat.mode & 0o777, bytes: content.length, base64: content.toString("base64") };
  }
  if (stat.isDirectory()) return { type: "directory", mode: stat.mode & 0o777 };
  if (stat.isSymbolicLink()) return { type: "symlink", target: await fs.promises.readlink(target) };
  throw new Error(`Candidate review path has unsupported type: ${relative}`);
}

function reviewerSourceId(profileName: string): string {
  return `verification-${profileName}`;
}

function requiredReviewerAuthority(
  resources: PreparedWorkflowExecutionResources,
  sourceId: string,
): string {
  const matches = resources.agentSelections.filter((entry) => entry.operationId === sourceId);
  if (matches.length !== 1) throw new Error(`Verification reviewer ${sourceId} has no unique pinned authority`);
  return matches[0]!.authorityHash;
}

function nextOperationOrdinal(database: RunDatabase): number {
  let afterOrdinal = -1;
  let maximum = -1;
  for (;;) {
    const page = database.listOperations({ afterOrdinal, limit: 256 });
    for (const operation of page) maximum = Math.max(maximum, operation.ordinal);
    if (page.length < 256) break;
    afterOrdinal = page.at(-1)!.ordinal;
  }
  return maximum + 1;
}

function boundedError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return Array.from(text.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, 2_048).join("");
}
