import fs from "node:fs";
import path from "node:path";
import { canonicalJsonValue, deepFreezeJson } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import type { WorkflowProductIdentity, WorkflowReferenceIdentity } from "../definition/workflow-language.js";
import type {
  WorkflowArtifactRecord,
  WorkflowCandidateRecord,
  WorkflowCandidateWorkspaceRecord,
  WorkflowOperationRecord,
  WorkflowRunRecord,
  WorkflowScopeRecord,
  WorkflowWorkspaceCheckpointRecord,
} from "../persistence/run-database-types.js";
import {
  WorkflowRunDatabase,
  WorkflowRunDatabaseRevisionConflictError,
} from "../persistence/run-database.js";
import type { JsonObject, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import {
  WorkflowControlAuthorityRegistry,
  type WorkflowControlAuthorityDescription,
} from "../runtime/control-authority.js";
import type {
  WorkflowCandidateRuntimeContext,
  WorkflowCandidateRuntimeValue,
  WorkflowSemanticCandidateRuntime,
} from "../runtime/semantic-engine.js";
import { WorkflowArtifactStore } from "../artifacts/store.js";
import {
  cloneCandidateTree,
  diffCandidateTrees,
  projectTreeManifest,
  scanCandidateTree,
  validateCandidatePath,
  type CandidatePathChange,
  type CandidateTreeManifest,
} from "./tree.js";
import type { CandidateWriteScope } from "../runtime/durable-types.js";
import {
  assertProjectSnapshotManifest,
  type ProjectSnapshotManifest,
} from "../workspaces/project-snapshot.js";

const MAX_REVISION_RETRIES = 16;

export class CandidateWriteScopeError extends Error {
  constructor(readonly offending: CandidatePathChange[]) {
    super(`Candidate changes escape the fixed write scope: ${offending.slice(0, 16).map(change => change.path).join(", ")}`);
    this.name = "CandidateWriteScopeError";
  }
}

export function normalizeCandidateWriteScope(value: CandidateWriteScope | undefined): CandidateWriteScope {
  if (value === undefined || value === "all-semantic-project-paths") return "all-semantic-project-paths";
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Candidate write scope must be an object");
  const allow = normalizeScopeRules(value.allow, "allow");
  if (!allow.length) throw new Error("Candidate write scope allow list is empty");
  const deny = value.deny ? normalizeScopeRules(value.deny, "deny") : undefined;
  if (allow.length + (deny?.length ?? 0) > DEFINITION_LIMITS.candidateScopeRules) throw new Error("Candidate write scope has too many rules");
  return canonicalJsonValue({ allow, ...(deny?.length ? { deny } : {}) },
    { maxBytes: 64 * 1024, maxDepth: 8, maxNodes: 256, maxStringScalars: 8_192 }) as CandidateWriteScope;
}

export interface WorkflowCandidateWorkspaceHandle {
  record: WorkflowCandidateWorkspaceRecord;
  root: string;
  cwd: string;
  currentTreeHash: string;
}

export interface WorkflowPreparedCandidateWorkspace {
  workspaceId: string;
  initialTreeHash: string;
  baseLineageHash: string;
  writeScope: CandidateWriteScope;
  writeScopeHash: string;
  rootPath: string;
}

export interface WorkflowFrozenCandidateWorkspace {
  treeHash: string;
  lineageHash: string;
  changedPaths: string[];
  manifestArtifact: WorkflowArtifactRecord;
  diffArtifact: WorkflowArtifactRecord;
}

export interface WorkflowCandidateWorkspaceDriver {
  prepare(input: {
    run: WorkflowRunRecord;
    operation: WorkflowOperationRecord;
    bodyScope: WorkflowScopeRecord;
    parent?: WorkflowCandidateRecord;
    writeScope: CandidateWriteScope;
  }): Promise<WorkflowPreparedCandidateWorkspace>;
  describe(record: WorkflowCandidateWorkspaceRecord): Promise<WorkflowCandidateWorkspaceHandle>;
  freeze(input: {
    run: WorkflowRunRecord;
    operation: WorkflowOperationRecord;
    workspace: WorkflowCandidateWorkspaceRecord;
    output: JsonValue;
  }): Promise<WorkflowFrozenCandidateWorkspace>;
  checkpoint(input: {
    run: WorkflowRunRecord;
    operation: WorkflowOperationRecord;
    workspace: WorkflowCandidateWorkspaceRecord;
  }): Promise<WorkflowWorkspaceCheckpointRecord>;
}

interface CandidatePlan {
  parent?: WorkflowCandidateRecord;
  writeScope: CandidateWriteScope;
  semanticInput: JsonValue;
}

interface LaunchPrivateAuthority {
  runId: string;
  snapshotHash: string;
}

interface WorkspacePrivateAuthority {
  runId: string;
  workspaceId: string;
  recordHash: string;
}

interface CandidatePrivateAuthority {
  runId: string;
  candidateId: string;
  recordHash: string;
  accepted: boolean;
  dispositionHash?: string;
}

/** Candidate authority and lifecycle bound to one run. */
export class WorkflowCandidateRuntime implements WorkflowSemanticCandidateRuntime {
  private readonly workspaces = new Map<string, object>();
  private readonly candidates = new Map<string, { hash: string; value: object }>();
  readonly snapshot: object;

  constructor(
    readonly database: WorkflowRunDatabase,
    readonly authority: WorkflowControlAuthorityRegistry,
    readonly driver: WorkflowCandidateWorkspaceDriver,
    private readonly now: () => Date = () => new Date(),
  ) {
    const run = database.readRun();
    const privateAuthority = freezePrivate<LaunchPrivateAuthority>({
      runId: run.runId,
      snapshotHash: run.projectSnapshotHash,
    });
    this.snapshot = authority.reference(referenceIdentity(
      "launch-snapshot",
      `launch-${run.projectSnapshotHash.slice(7, 39)}`,
      privateAuthority,
    ), {}, privateAuthority);
  }

  semanticInput(context: { run: WorkflowRunRecord; input: unknown }): JsonValue {
    return structuredClone(this.plan(context.run, context.input).semanticInput);
  }

  async existing(context: WorkflowCandidateRuntimeContext): Promise<WorkflowCandidateRuntimeValue | undefined> {
    const candidate = this.database.readCandidateByOperation(context.operation.operationId);
    if (!candidate) return undefined;
    if (candidate.bodyScopeId !== context.bodyScope.scopeId || context.bodyScope.status !== "completed") {
      throw new WorkflowCandidateAuthorityError("Frozen candidate differs from its body scope");
    }
    return this.runtimeValue(candidate);
  }

  async open(context: WorkflowCandidateRuntimeContext): Promise<unknown> {
    const plan = this.plan(context.run, context.input);
    let workspace = this.database.readCandidateWorkspaceByOperation(context.operation.operationId);
    if (!workspace) {
      const prepared = await this.driver.prepare({
        run: context.run,
        operation: context.operation,
        bodyScope: context.bodyScope,
        ...(plan.parent ? { parent: plan.parent } : {}),
        writeScope: plan.writeScope,
      });
      workspace = await revisionRetry(async () => this.database.createCandidateWorkspace({
        expectedRevision: this.database.readRun().revision,
        workspaceId: prepared.workspaceId,
        candidateOperationId: context.operation.operationId,
        bodyScopeId: context.bodyScope.scopeId,
        ...(plan.parent ? { parentCandidateId: plan.parent.candidateId } : {}),
        initialTreeHash: prepared.initialTreeHash,
        baseLineageHash: prepared.baseLineageHash,
        writeScope: prepared.writeScope as unknown as JsonValue,
        writeScopeHash: prepared.writeScopeHash,
        rootPath: prepared.rootPath,
        at: timestamp(this.now),
      }));
    }
    assertWorkspacePlan(workspace, context, plan);
    await this.driver.describe(workspace);
    return this.workspaceValue(workspace);
  }

  async freeze(
    context: WorkflowCandidateRuntimeContext & { output: JsonValue; bodyTerminalKey: string },
  ): Promise<WorkflowCandidateRuntimeValue> {
    const workspace = this.database.readCandidateWorkspaceByOperation(context.operation.operationId);
    if (!workspace) throw new WorkflowCandidateAuthorityError("Candidate workspace disappeared before freeze");
    const existing = this.database.readCandidateByOperation(context.operation.operationId);
    if (existing) return this.runtimeValue(existing);
    const evidence = await this.driver.freeze({
      run: context.run,
      operation: context.operation,
      workspace,
      output: context.output,
    });
    let candidate = await revisionRetry(async () => this.database.freezeCandidate({
      expectedRevision: this.database.readRun().revision,
      workspaceId: workspace.workspaceId,
      bodyTerminalKey: context.bodyTerminalKey,
      treeHash: evidence.treeHash,
      lineageHash: evidence.lineageHash,
      output: context.output,
      changedPaths: evidence.changedPaths,
      manifestArtifactDigest: evidence.manifestArtifact.digest,
      diffArtifactDigest: evidence.diffArtifact.digest,
      at: timestamp(this.now),
    }));
    if (candidate.changedPaths.length === 0 && candidate.state === "pending") {
      candidate = await revisionRetry(async () => this.database.disposeCandidate({
        expectedRevision: this.database.readRun().revision,
        candidateId: candidate.candidateId,
        disposition: "discarded",
        reason: reason("unchanged", "Candidate has no semantic project changes"),
        at: timestamp(this.now),
      }));
    }
    return this.runtimeValue(candidate);
  }

  restore(context: WorkflowCandidateRuntimeContext & { result: JsonValue }): unknown {
    const record = candidateResult(context.result);
    const candidate = this.database.readCandidate(record.candidateId);
    if (!candidate || candidate.operationId !== context.operation.operationId
      || stableHash(candidate.output) !== record.outputHash
      || stableHash(candidate.changedPaths) !== record.changedPathsHash) {
      throw new WorkflowCandidateAuthorityError("Candidate result is stale or corrupt");
    }
    return this.candidateValue(candidate);
  }

  async abandon(context: WorkflowCandidateRuntimeContext, failure: JsonObject): Promise<void> {
    const workspace = this.database.readCandidateWorkspaceByOperation(context.operation.operationId);
    if (!workspace || workspace.state !== "mutable") return;
    await revisionRetry(async () => this.database.abandonCandidateWorkspace(
      this.database.readRun().revision,
      workspace.workspaceId,
      failure,
      timestamp(this.now),
    ));
  }

  workspace(value: unknown): WorkflowCandidateWorkspaceRecord {
    const description = this.authority.describe(value);
    const privateAuthority = description?.privateAuthority;
    if (!description || description.family !== "reference" || description.identity.kind !== "candidate-workspace"
      || !workspacePrivate(privateAuthority, this.database.readRun().runId)) {
      throw new WorkflowCandidateAuthorityError("Value is not a candidate workspace from this run");
    }
    const workspace = this.database.readCandidateWorkspace(privateAuthority.workspaceId);
    if (!workspace || workspace.state !== "mutable" || stableHash(workspace) !== privateAuthority.recordHash) {
      throw new WorkflowCandidateAuthorityError("Candidate workspace authority is stale");
    }
    return workspace;
  }

  candidate(value: unknown, options: { pending?: boolean } = {}): WorkflowCandidateRecord {
    const description = this.authority.describe(value);
    const privateAuthority = candidatePrivate(description, this.database.readRun().runId, false);
    const candidate = this.database.readCandidate(privateAuthority.candidateId);
    if (!candidate || candidateImmutableHash(candidate) !== privateAuthority.recordHash) {
      throw new WorkflowCandidateAuthorityError("Candidate authority is stale");
    }
    if (options.pending && candidate.state !== "pending") {
      throw new WorkflowCandidateAuthorityError(`Candidate ${candidate.candidateId} is ${candidate.state}`);
    }
    return candidate;
  }

  accepted(value: unknown): WorkflowCandidateRecord {
    const description = this.authority.describe(value);
    const privateAuthority = candidatePrivate(description, this.database.readRun().runId, true);
    const candidate = this.database.readCandidate(privateAuthority.candidateId);
    if (!candidate || (candidate.state !== "accepted" && candidate.state !== "applied")
      || !candidate.disposition || candidate.disposition.disposition !== "accepted"
      || candidateImmutableHash(candidate) !== privateAuthority.recordHash
      || candidate.disposition.authorityHash !== privateAuthority.dispositionHash) {
      throw new WorkflowCandidateAuthorityError("Accepted candidate authority is stale");
    }
    return candidate;
  }

  candidateValue(candidate: WorkflowCandidateRecord): object {
    return this.productValue(candidate, false);
  }

  acceptedValue(candidate: WorkflowCandidateRecord): object {
    if (!candidate.disposition || candidate.disposition.disposition !== "accepted") {
      throw new WorkflowCandidateAuthorityError("Cannot mint accepted authority without acceptance");
    }
    return this.productValue(candidate, true);
  }

  workspaceValue(workspace: WorkflowCandidateWorkspaceRecord): object {
    const existing = this.workspaces.get(workspace.workspaceId);
    if (existing) return existing;
    const privateAuthority = freezePrivate<WorkspacePrivateAuthority>({
      runId: workspace.runId,
      workspaceId: workspace.workspaceId,
      recordHash: stableHash(workspace),
    });
    const value = this.authority.reference(referenceIdentity(
      "candidate-workspace",
      `workspace-${stableHash(workspace.workspaceId).slice(7, 39)}`,
      privateAuthority,
    ), {}, privateAuthority);
    this.workspaces.set(workspace.workspaceId, value);
    return value;
  }

  async workspaceHandle(value: unknown): Promise<WorkflowCandidateWorkspaceHandle> {
    return await this.driver.describe(this.workspace(value));
  }

  async candidateWorkspaceHandle(candidate: WorkflowCandidateRecord): Promise<WorkflowCandidateWorkspaceHandle> {
    const current = this.database.readCandidate(candidate.candidateId);
    const workspace = this.database.readCandidateWorkspace(candidate.workspaceId);
    if (!current || candidateImmutableHash(current) !== candidateImmutableHash(candidate)
      || !workspace || workspace.state !== "frozen") {
      throw new WorkflowCandidateAuthorityError("Candidate workspace evidence is stale");
    }
    const handle = await this.driver.describe(workspace);
    if (handle.currentTreeHash !== candidate.treeHash) {
      throw new WorkflowCandidateAuthorityError("Frozen candidate workspace tree changed");
    }
    return handle;
  }

  async checkpoint(value: unknown, operation: WorkflowOperationRecord): Promise<WorkflowWorkspaceCheckpointRecord> {
    const workspace = this.workspace(value);
    const checkpoint = await this.driver.checkpoint({ run: this.database.readRun(), operation, workspace });
    const existing = this.database.readWorkspaceCheckpoint(checkpoint.checkpointId);
    if (existing) {
      if (stableJson(existing) !== stableJson(checkpoint)) {
        throw new WorkflowCandidateAuthorityError("Workspace checkpoint changed identity");
      }
      return existing;
    }
    return await revisionRetry(async () => this.database.insertWorkspaceCheckpoint(
      this.database.readRun().revision,
      checkpoint,
    ));
  }

  checkpointId(value: unknown, operation: WorkflowOperationRecord): string {
    const workspace = this.workspace(value);
    return workflowCheckpointId(this.database.readRun().runId, operation.operationId, workspace.workspaceId);
  }

  private plan(run: WorkflowRunRecord, input: unknown): CandidatePlan {
    const record = plainRecord(input, "workflow candidate options");
    exactKeys(record, ["base", "writes"], "workflow candidate options");
    let parent: WorkflowCandidateRecord | undefined;
    let base: JsonValue = { kind: "launch-snapshot", snapshotHash: run.projectSnapshotHash };
    if (record.base !== undefined) {
      const description = this.authority.describe(record.base);
      if (description?.family === "reference" && description.identity.kind === "launch-snapshot") {
        const authority = description.privateAuthority;
        if (!launchPrivate(authority, run.runId, run.projectSnapshotHash)) {
          throw new WorkflowCandidateAuthorityError("Launch snapshot authority is stale");
        }
      } else {
        parent = this.accepted(record.base);
        base = {
          kind: "accepted-candidate",
          candidateId: parent.candidateId,
          treeHash: parent.treeHash,
          lineageHash: parent.lineageHash,
          dispositionHash: parent.disposition!.authorityHash,
        };
      }
    }
    const rawWrites = Array.isArray(record.writes)
      ? { allow: record.writes }
      : record.writes;
    const writeScope = normalizeCandidateWriteScope(rawWrites as CandidateWriteScope | undefined);
    return {
      ...(parent ? { parent } : {}),
      writeScope,
      semanticInput: canonicalJsonValue({
        base,
        writeScope: writeScope as unknown as JsonValue,
        writeScopeHash: stableHash(writeScope),
      }, limits()),
    };
  }

  private runtimeValue(candidate: WorkflowCandidateRecord): WorkflowCandidateRuntimeValue {
    const manifest = this.database.readArtifact(candidate.manifestArtifactDigest);
    const diff = this.database.readArtifact(candidate.diffArtifactDigest);
    if (!manifest || !diff) throw new WorkflowCandidateAuthorityError("Candidate artifact evidence is unavailable");
    return {
      result: {
        candidateId: candidate.candidateId,
        outputHash: stableHash(candidate.output),
        changedPathsHash: stableHash(candidate.changedPaths),
      },
      value: this.candidateValue(candidate),
      artifacts: [
        { role: "evidence", name: "manifest", ordinal: 0, artifact: manifest },
        { role: "evidence", name: "diff", ordinal: 1, artifact: diff },
      ],
    };
  }

  private productValue(candidate: WorkflowCandidateRecord, accepted: boolean): object {
    const key = `${accepted ? "accepted" : "candidate"}:${candidate.candidateId}`;
    const recordHash = candidateImmutableHash(candidate);
    const authorityHash = stableHash({
      kind: accepted ? "workflow-accepted-candidate-authority" : "workflow-candidate-authority",
      runId: candidate.runId,
      candidateId: candidate.candidateId,
      recordHash,
      ...(accepted ? { dispositionHash: candidate.disposition!.authorityHash } : {}),
    });
    const existing = this.candidates.get(key);
    if (existing) {
      if (existing.hash !== authorityHash) {
        throw new WorkflowCandidateAuthorityError(`Candidate ${candidate.candidateId} changed authority`);
      }
      return existing.value;
    }
    const privateAuthority = freezePrivate<CandidatePrivateAuthority>({
      runId: candidate.runId,
      candidateId: candidate.candidateId,
      recordHash,
      accepted,
      ...(accepted ? { dispositionHash: candidate.disposition!.authorityHash } : {}),
    });
    const identity: WorkflowProductIdentity = {
      kind: accepted ? "accepted-candidate" : "candidate",
      authorityId: `${accepted ? "accepted" : "candidate"}-${candidate.candidateId.slice(-32)}`,
      authorityHash,
    };
    const value = this.authority.product(identity, {
      output: deepFreezeJson(structuredClone(candidate.output)),
      changedPaths: Object.freeze([...candidate.changedPaths]),
    }, privateAuthority);
    this.candidates.set(key, { hash: authorityHash, value });
    return value;
  }
}

/** Btrfs candidate/checkpoint implementation used by the production coordinator. */
export class WorkflowFilesystemCandidateDriver implements WorkflowCandidateWorkspaceDriver {
  readonly runDir: string;
  private launch?: { manifest: ProjectSnapshotManifest; tree: CandidateTreeManifest };

  constructor(
    runDir: string,
    readonly database: WorkflowRunDatabase,
    readonly store: WorkflowArtifactStore,
    private readonly launchManifest: ProjectSnapshotManifest,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.runDir = path.resolve(runDir);
    assertProjectSnapshotManifest(launchManifest);
  }

  async prepare(input: {
    run: WorkflowRunRecord;
    operation: WorkflowOperationRecord;
    parent?: WorkflowCandidateRecord;
    writeScope: CandidateWriteScope;
  }): Promise<WorkflowPreparedCandidateWorkspace> {
    const launch = await this.launchState(input.run);
    const parentWorkspace = input.parent
      ? this.database.readCandidateWorkspace(input.parent.workspaceId)
      : undefined;
    if (input.parent && !parentWorkspace) throw new Error("Parent candidate workspace is unavailable");
    const sourceRoot = parentWorkspace ? contained(this.runDir, parentWorkspace.rootPath) : path.join(this.runDir, "context", "project");
    const sourceTree = parentWorkspace ? await scanCandidateTree(sourceRoot) : launch.tree;
    if (input.parent && sourceTree.treeHash !== input.parent.treeHash) {
      throw new Error("Parent candidate tree changed after acceptance");
    }
    const writeScopeHash = stableHash(input.writeScope);
    const workspaceId = `workspace_${stableHash({
      runId: input.run.runId,
      operationId: input.operation.operationId,
      parentCandidateId: input.parent?.candidateId ?? null,
      sourceTreeHash: sourceTree.treeHash,
      writeScopeHash,
    }).slice(7, 39)}`;
    const rootPath = `workspaces/candidates/${workspaceId}/project`;
    const target = contained(this.runDir, rootPath);
    await publishClone(sourceRoot, target, sourceTree.treeHash);
    return {
      workspaceId,
      initialTreeHash: sourceTree.treeHash,
      baseLineageHash: input.parent?.lineageHash ?? launch.manifest.manifestHash,
      writeScope: input.writeScope,
      writeScopeHash,
      rootPath,
    };
  }

  async describe(record: WorkflowCandidateWorkspaceRecord): Promise<WorkflowCandidateWorkspaceHandle> {
    const root = contained(this.runDir, record.rootPath);
    const launch = await this.launchState(this.database.readRun());
    const cwd = path.resolve(root, launch.manifest.cwd === "." ? "" : launch.manifest.cwd);
    assertInside(root, cwd);
    const current = await scanCandidateTree(root);
    return { record: structuredClone(record), root, cwd, currentTreeHash: current.treeHash };
  }

  async freeze(input: {
    run: WorkflowRunRecord;
    operation: WorkflowOperationRecord;
    workspace: WorkflowCandidateWorkspaceRecord;
    output: JsonValue;
  }): Promise<WorkflowFrozenCandidateWorkspace> {
    const launch = await this.launchState(input.run);
    const handle = await this.describe(input.workspace);
    const base = input.workspace.parentCandidateId
      ? this.database.readCandidate(input.workspace.parentCandidateId)
      : undefined;
    const baseWorkspace = base ? this.database.readCandidateWorkspace(base.workspaceId) : undefined;
    const baseTree = baseWorkspace
      ? await scanCandidateTree(contained(this.runDir, baseWorkspace.rootPath))
      : launch.tree;
    const current = await scanCandidateTree(handle.root);
    const changes = diffCandidateTrees(baseTree, current);
    enforceWriteScope(input.workspace.writeScope as CandidateWriteScope, changes);
    const changedPaths = [...new Set(changes.map(change => change.path))].sort();
    const lineageHash = stableHash({
      operationId: input.operation.operationId,
      baseLineageHash: input.workspace.baseLineageHash,
      treeHash: current.treeHash,
      writeScopeHash: input.workspace.writeScopeHash,
    });
    const manifest = await this.store.putJson({
      kind: "candidate-manifest",
      value: {
        operationId: input.operation.operationId,
        workspaceId: input.workspace.workspaceId,
        tree: current as unknown as JsonValue,
        lineageHash,
        writeScopeHash: input.workspace.writeScopeHash,
        changedPaths,
      },
    });
    const diff = await this.store.putJson({
      kind: "candidate-diff",
      value: {
        baseTreeHash: baseTree.treeHash,
        treeHash: current.treeHash,
        changes: changes as unknown as JsonValue,
      },
    });
    return {
      treeHash: current.treeHash,
      lineageHash,
      changedPaths,
      manifestArtifact: manifest.record,
      diffArtifact: diff.record,
    };
  }

  async checkpoint(input: {
    run: WorkflowRunRecord;
    operation: WorkflowOperationRecord;
    workspace: WorkflowCandidateWorkspaceRecord;
  }): Promise<WorkflowWorkspaceCheckpointRecord> {
    const handle = await this.describe(input.workspace);
    const tree = await scanCandidateTree(handle.root);
    const checkpointId = workflowCheckpointId(
      input.run.runId,
      input.operation.operationId,
      input.workspace.workspaceId,
    );
    const storagePath = `workspaces/checkpoints/${checkpointId}`;
    await publishClone(handle.root, contained(this.runDir, storagePath), tree.treeHash);
    return {
      checkpointId,
      runId: input.run.runId,
      operationId: input.operation.operationId,
      workspaceId: input.workspace.workspaceId,
      treeHash: tree.treeHash,
      lineageHash: input.workspace.baseLineageHash,
      writeScopeHash: input.workspace.writeScopeHash,
      storagePath,
      createdAt: timestamp(this.now),
    };
  }

  private async launchState(run: WorkflowRunRecord): Promise<{ manifest: ProjectSnapshotManifest; tree: CandidateTreeManifest }> {
    if (this.launch) return this.launch;
    const manifest = this.launchManifest;
    if (manifest.treeHash !== run.projectSnapshotHash) throw new Error("Launch snapshot differs from workflow run");
    const root = path.join(this.runDir, "context", "project");
    if ((await scanCandidateTree(root)).treeHash !== manifest.treeHash) throw new Error("Launch snapshot tree is corrupt");
    this.launch = { manifest, tree: projectTreeManifest(manifest) };
    return this.launch;
  }
}

export class WorkflowCandidateAuthorityError extends Error {
  constructor(message: string) { super(message); this.name = "WorkflowCandidateAuthorityError"; }
}

export function workflowCheckpointId(runId: string, operationId: string, workspaceId: string): string {
  return `checkpoint_${stableHash({
    kind: "workflow-workspace-checkpoint",
    runId,
    operationId,
    workspaceId,
  }).slice(7, 39)}`;
}

function candidateResult(value: JsonValue): {
  candidateId: string;
  outputHash: string;
  changedPathsHash: string;
} {
  const record = plainRecord(value, "workflow candidate result");
  exactKeys(record, ["candidateId", "outputHash", "changedPathsHash"], "workflow candidate result");
  if (typeof record.candidateId !== "string"
    || typeof record.outputHash !== "string" || typeof record.changedPathsHash !== "string") {
    throw new WorkflowCandidateAuthorityError("Workflow candidate result is invalid");
  }
  return record as unknown as ReturnType<typeof candidateResult>;
}

function candidateImmutableHash(candidate: WorkflowCandidateRecord): string {
  return stableHash({
    candidateId: candidate.candidateId,
    runId: candidate.runId,
    operationId: candidate.operationId,
    workspaceId: candidate.workspaceId,
    bodyScopeId: candidate.bodyScopeId,
    parentCandidateId: candidate.parentCandidateId ?? null,
    treeHash: candidate.treeHash,
    lineageHash: candidate.lineageHash,
    writeScopeHash: candidate.writeScopeHash,
    outputHash: candidate.outputHash,
    changedPaths: candidate.changedPaths,
    manifestArtifactDigest: candidate.manifestArtifactDigest,
    diffArtifactDigest: candidate.diffArtifactDigest,
    frozenAt: candidate.frozenAt,
  });
}

function referenceIdentity(
  kind: WorkflowReferenceIdentity["kind"],
  authorityId: string,
  privateAuthority: object,
): WorkflowReferenceIdentity {
  return { kind, authorityId, authorityHash: stableHash(privateAuthority) };
}

function candidatePrivate(
  description: WorkflowControlAuthorityDescription | undefined,
  runId: string,
  accepted: boolean,
): CandidatePrivateAuthority {
  const privateAuthority = description?.privateAuthority;
  if (!description || description.family !== "product"
    || description.identity.kind !== (accepted ? "accepted-candidate" : "candidate")
    || !plainPrivate(privateAuthority)
    || privateAuthority.runId !== runId || privateAuthority.accepted !== accepted
    || typeof privateAuthority.candidateId !== "string" || typeof privateAuthority.recordHash !== "string") {
    throw new WorkflowCandidateAuthorityError(
      accepted ? "Value is not an accepted candidate from this run" : "Value is not a candidate from this run",
    );
  }
  return privateAuthority as unknown as CandidatePrivateAuthority;
}

function launchPrivate(value: unknown, runId: string, snapshotHash: string): boolean {
  return plainPrivate(value) && value.runId === runId && value.snapshotHash === snapshotHash;
}

function workspacePrivate(value: unknown, runId: string): value is WorkspacePrivateAuthority {
  return plainPrivate(value) && value.runId === runId
    && typeof value.workspaceId === "string" && typeof value.recordHash === "string";
}

function assertWorkspacePlan(
  workspace: WorkflowCandidateWorkspaceRecord,
  context: WorkflowCandidateRuntimeContext,
  plan: CandidatePlan,
): void {
  if (workspace.candidateOperationId !== context.operation.operationId
    || workspace.bodyScopeId !== context.bodyScope.scopeId
    || workspace.parentCandidateId !== plan.parent?.candidateId
    || workspace.writeScopeHash !== stableHash(plan.writeScope)
    || stableJson(workspace.writeScope) !== stableJson(plan.writeScope)) {
    throw new WorkflowCandidateAuthorityError("Candidate workspace differs from its reviewed plan");
  }
}

function enforceWriteScope(scope: CandidateWriteScope, changes: CandidatePathChange[]): void {
  if (scope === "all-semantic-project-paths") return;
  const offending = changes.filter(change => !scope.allow.some(rule => matches(rule, change.path))
    || (scope.deny ?? []).some(rule => matches(rule, change.path)));
  if (offending.length) throw new CandidateWriteScopeError(offending);
}

function matches(rule: string, value: string): boolean {
  return rule.endsWith("/") ? value.startsWith(rule) : value === rule;
}

function normalizeScopeRules(value: string[], label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Candidate write scope ${label} must be an array`);
  const rules = value.map(rule => {
    if (typeof rule !== "string") throw new Error(`Candidate write scope ${label} contains a non-string rule`);
    if (/[?*\[\]{}]/u.test(rule)) throw new Error(`Candidate write scope does not accept globs: ${rule}`);
    return validateCandidatePath(rule, rule.endsWith("/"));
  }).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  for (const [index, rule] of rules.entries()) {
    if (rules.indexOf(rule) !== index) throw new Error(`Duplicate candidate write-scope rule ${rule}`);
    if (rules.some((other, otherIndex) => otherIndex !== index && other.endsWith("/") && rule.startsWith(other))) {
      throw new Error(`Redundant candidate write-scope rule ${rule}`);
    }
  }
  return rules;
}

async function publishClone(source: string, target: string, expectedTreeHash: string): Promise<void> {
  try {
    if ((await scanCandidateTree(target)).treeHash !== expectedTreeHash) {
      throw new Error("Existing candidate tree differs from its expected source");
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    const cloned = await cloneCandidateTree(source, temporary, { durable: true });
    if (cloned.treeHash !== expectedTreeHash) throw new Error("Candidate clone changed source identity");
    try { await fs.promises.rename(temporary, target); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      if ((await scanCandidateTree(target)).treeHash !== expectedTreeHash) throw new Error("Candidate clone collision");
    }
  } finally {
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
}

function contained(rootInput: string, relative: string): string {
  const root = path.resolve(rootInput);
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error("Candidate path escapes its workflow run");
  }
  return target;
}

function assertInside(rootInput: string, targetInput: string): void {
  const root = path.resolve(rootInput);
  const target = path.resolve(targetInput);
  const rel = path.relative(root, target);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error("Candidate cwd escapes its workspace");
  }
}

async function revisionRetry<T>(body: () => T | Promise<T>): Promise<T> {
  for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
    try { return await body(); }
    catch (error) {
      if (error instanceof WorkflowRunDatabaseRevisionConflictError) continue;
      throw error;
    }
  }
  throw new Error("Workflow candidate lifecycle exceeded revision retries");
}

function reason(code: string, summary: string): JsonObject {
  return { category: "candidate", code, summary, retryable: false };
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("Workflow candidate clock is invalid");
  return value.toISOString();
}

function limits() {
  return { maxBytes: 1024 * 1024, maxDepth: 32, maxNodes: 20_000, maxStringScalars: 100_000 };
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function plainPrivate(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} contains unexpected fields`);
  }
}

function freezePrivate<T extends object>(value: T): T {
  return Object.freeze(structuredClone(value));
}
