import fs from "node:fs";
import path from "node:path";
import { canonicalJsonValue, deepFreezeJson } from "../definition/canonical-json.js";
import type { WorkflowV17ProductIdentity, WorkflowV17ReferenceIdentity } from "../definition/workflow-language-v17.js";
import type {
  WorkflowArtifactV17Record,
  WorkflowCandidateV17Record,
  WorkflowCandidateWorkspaceV17Record,
  WorkflowOperationV17Record,
  WorkflowRunV17Record,
  WorkflowScopeV17Record,
  WorkflowWorkspaceCheckpointV17Record,
} from "../persistence/run-database-v17-types.js";
import {
  WorkflowRunDatabaseV17,
  WorkflowRunDatabaseV17RevisionConflictError,
} from "../persistence/run-database-v17.js";
import type { JsonObject, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import {
  WorkflowV17ControlAuthorityRegistry,
  type WorkflowV17ControlAuthorityDescription,
} from "../runtime/control-authority-v17.js";
import type {
  WorkflowV17CandidateRuntimeContext,
  WorkflowV17CandidateRuntimeValue,
  WorkflowV17SemanticCandidateRuntime,
} from "../runtime/semantic-engine-v17.js";
import { WorkflowV17ArtifactStore } from "../artifacts/store-v17.js";
import {
  cloneCandidateTree,
  diffCandidateTrees,
  projectTreeManifest,
  scanCandidateTree,
  type CandidatePathChange,
  type CandidateTreeManifest,
} from "./tree.js";
import {
  CandidateWriteScopeError,
  normalizeCandidateWriteScope,
  type CandidateWriteScope,
} from "./store.js";
import {
  assertProjectSnapshotManifest,
  type ProjectSnapshotManifest,
} from "../workspaces/project-snapshot.js";

const MAX_REVISION_RETRIES = 16;
const PRIVATE_FORMAT = 1;

export interface WorkflowV17CandidateWorkspaceHandle {
  record: WorkflowCandidateWorkspaceV17Record;
  root: string;
  cwd: string;
  currentTreeHash: string;
}

export interface WorkflowV17PreparedCandidateWorkspace {
  workspaceId: string;
  initialTreeHash: string;
  baseLineageHash: string;
  writeScope: CandidateWriteScope;
  writeScopeHash: string;
  rootPath: string;
}

export interface WorkflowV17FrozenCandidateWorkspace {
  treeHash: string;
  lineageHash: string;
  changedPaths: string[];
  manifestArtifact: WorkflowArtifactV17Record;
  diffArtifact: WorkflowArtifactV17Record;
}

export interface WorkflowV17CandidateWorkspaceDriver {
  prepare(input: {
    run: WorkflowRunV17Record;
    operation: WorkflowOperationV17Record;
    bodyScope: WorkflowScopeV17Record;
    parent?: WorkflowCandidateV17Record;
    writeScope: CandidateWriteScope;
  }): Promise<WorkflowV17PreparedCandidateWorkspace>;
  describe(record: WorkflowCandidateWorkspaceV17Record): Promise<WorkflowV17CandidateWorkspaceHandle>;
  freeze(input: {
    run: WorkflowRunV17Record;
    operation: WorkflowOperationV17Record;
    workspace: WorkflowCandidateWorkspaceV17Record;
    output: JsonValue;
  }): Promise<WorkflowV17FrozenCandidateWorkspace>;
  checkpoint(input: {
    run: WorkflowRunV17Record;
    operation: WorkflowOperationV17Record;
    workspace: WorkflowCandidateWorkspaceV17Record;
  }): Promise<WorkflowWorkspaceCheckpointV17Record>;
}

interface CandidatePlan {
  parent?: WorkflowCandidateV17Record;
  writeScope: CandidateWriteScope;
  semanticInput: JsonValue;
}

interface LaunchPrivateAuthority {
  formatVersion: 1;
  runId: string;
  snapshotHash: string;
}

interface WorkspacePrivateAuthority {
  formatVersion: 1;
  runId: string;
  workspaceId: string;
  recordHash: string;
}

interface CandidatePrivateAuthority {
  formatVersion: 1;
  runId: string;
  candidateId: string;
  recordHash: string;
  accepted: boolean;
  dispositionHash?: string;
}

/** Candidate authority and lifecycle bound to one schema-4 run. */
export class WorkflowV17CandidateRuntime implements WorkflowV17SemanticCandidateRuntime {
  private readonly workspaces = new Map<string, object>();
  private readonly candidates = new Map<string, { hash: string; value: object }>();
  readonly snapshot: object;

  constructor(
    readonly database: WorkflowRunDatabaseV17,
    readonly authority: WorkflowV17ControlAuthorityRegistry,
    readonly driver: WorkflowV17CandidateWorkspaceDriver,
    private readonly now: () => Date = () => new Date(),
  ) {
    const run = database.readRun();
    const privateAuthority = freezePrivate<LaunchPrivateAuthority>({
      formatVersion: PRIVATE_FORMAT,
      runId: run.runId,
      snapshotHash: run.projectSnapshotHash,
    });
    this.snapshot = authority.reference(referenceIdentity(
      "launch-snapshot",
      `launch-${run.projectSnapshotHash.slice(7, 39)}`,
      privateAuthority,
    ), {}, privateAuthority);
  }

  semanticInput(context: { run: WorkflowRunV17Record; input: unknown }): JsonValue {
    return structuredClone(this.plan(context.run, context.input).semanticInput);
  }

  async existing(context: WorkflowV17CandidateRuntimeContext): Promise<WorkflowV17CandidateRuntimeValue | undefined> {
    const candidate = this.database.readCandidateByOperation(context.operation.operationId);
    if (!candidate) return undefined;
    if (candidate.bodyScopeId !== context.bodyScope.scopeId || context.bodyScope.status !== "completed") {
      throw new WorkflowV17CandidateAuthorityError("Frozen candidate differs from its body scope");
    }
    return this.runtimeValue(candidate);
  }

  async open(context: WorkflowV17CandidateRuntimeContext): Promise<unknown> {
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
    context: WorkflowV17CandidateRuntimeContext & { output: JsonValue; bodyTerminalKey: string },
  ): Promise<WorkflowV17CandidateRuntimeValue> {
    const workspace = this.database.readCandidateWorkspaceByOperation(context.operation.operationId);
    if (!workspace) throw new WorkflowV17CandidateAuthorityError("Candidate workspace disappeared before freeze");
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

  restore(context: WorkflowV17CandidateRuntimeContext & { result: JsonValue }): unknown {
    const record = candidateResult(context.result);
    const candidate = this.database.readCandidate(record.candidateId);
    if (!candidate || candidate.operationId !== context.operation.operationId
      || stableHash(candidate.output) !== record.outputHash
      || stableHash(candidate.changedPaths) !== record.changedPathsHash) {
      throw new WorkflowV17CandidateAuthorityError("Candidate result is stale or corrupt");
    }
    return this.candidateValue(candidate);
  }

  async abandon(context: WorkflowV17CandidateRuntimeContext, failure: JsonObject): Promise<void> {
    const workspace = this.database.readCandidateWorkspaceByOperation(context.operation.operationId);
    if (!workspace || workspace.state !== "mutable") return;
    await revisionRetry(async () => this.database.abandonCandidateWorkspace(
      this.database.readRun().revision,
      workspace.workspaceId,
      failure,
      timestamp(this.now),
    ));
  }

  workspace(value: unknown): WorkflowCandidateWorkspaceV17Record {
    const description = this.authority.describe(value);
    const privateAuthority = description?.privateAuthority;
    if (!description || description.family !== "reference" || description.identity.kind !== "candidate-workspace"
      || !workspacePrivate(privateAuthority, this.database.readRun().runId)) {
      throw new WorkflowV17CandidateAuthorityError("Value is not a candidate workspace from this run");
    }
    const workspace = this.database.readCandidateWorkspace(privateAuthority.workspaceId);
    if (!workspace || workspace.state !== "mutable" || stableHash(workspace) !== privateAuthority.recordHash) {
      throw new WorkflowV17CandidateAuthorityError("Candidate workspace authority is stale");
    }
    return workspace;
  }

  candidate(value: unknown, options: { pending?: boolean } = {}): WorkflowCandidateV17Record {
    const description = this.authority.describe(value);
    const privateAuthority = candidatePrivate(description, this.database.readRun().runId, false);
    const candidate = this.database.readCandidate(privateAuthority.candidateId);
    if (!candidate || candidateImmutableHash(candidate) !== privateAuthority.recordHash) {
      throw new WorkflowV17CandidateAuthorityError("Candidate authority is stale");
    }
    if (options.pending && candidate.state !== "pending") {
      throw new WorkflowV17CandidateAuthorityError(`Candidate ${candidate.candidateId} is ${candidate.state}`);
    }
    return candidate;
  }

  accepted(value: unknown): WorkflowCandidateV17Record {
    const description = this.authority.describe(value);
    const privateAuthority = candidatePrivate(description, this.database.readRun().runId, true);
    const candidate = this.database.readCandidate(privateAuthority.candidateId);
    if (!candidate || (candidate.state !== "accepted" && candidate.state !== "applied")
      || !candidate.disposition || candidate.disposition.disposition !== "accepted"
      || candidateImmutableHash(candidate) !== privateAuthority.recordHash
      || candidate.disposition.authorityHash !== privateAuthority.dispositionHash) {
      throw new WorkflowV17CandidateAuthorityError("Accepted candidate authority is stale");
    }
    return candidate;
  }

  candidateValue(candidate: WorkflowCandidateV17Record): object {
    return this.productValue(candidate, false);
  }

  acceptedValue(candidate: WorkflowCandidateV17Record): object {
    if (!candidate.disposition || candidate.disposition.disposition !== "accepted") {
      throw new WorkflowV17CandidateAuthorityError("Cannot mint accepted authority without acceptance");
    }
    return this.productValue(candidate, true);
  }

  workspaceValue(workspace: WorkflowCandidateWorkspaceV17Record): object {
    const existing = this.workspaces.get(workspace.workspaceId);
    if (existing) return existing;
    const privateAuthority = freezePrivate<WorkspacePrivateAuthority>({
      formatVersion: PRIVATE_FORMAT,
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

  async workspaceHandle(value: unknown): Promise<WorkflowV17CandidateWorkspaceHandle> {
    return await this.driver.describe(this.workspace(value));
  }

  async candidateWorkspaceHandle(candidate: WorkflowCandidateV17Record): Promise<WorkflowV17CandidateWorkspaceHandle> {
    const current = this.database.readCandidate(candidate.candidateId);
    const workspace = this.database.readCandidateWorkspace(candidate.workspaceId);
    if (!current || candidateImmutableHash(current) !== candidateImmutableHash(candidate)
      || !workspace || workspace.state !== "frozen") {
      throw new WorkflowV17CandidateAuthorityError("Candidate workspace evidence is stale");
    }
    return await this.driver.describe(workspace);
  }

  async checkpoint(value: unknown, operation: WorkflowOperationV17Record): Promise<WorkflowWorkspaceCheckpointV17Record> {
    const workspace = this.workspace(value);
    const checkpoint = await this.driver.checkpoint({ run: this.database.readRun(), operation, workspace });
    const existing = this.database.readWorkspaceCheckpoint(checkpoint.checkpointId);
    if (existing) {
      if (stableJson(existing) !== stableJson(checkpoint)) {
        throw new WorkflowV17CandidateAuthorityError("Workspace checkpoint changed identity");
      }
      return existing;
    }
    return await revisionRetry(async () => this.database.insertWorkspaceCheckpoint(
      this.database.readRun().revision,
      checkpoint,
    ));
  }

  checkpointId(value: unknown, operation: WorkflowOperationV17Record): string {
    const workspace = this.workspace(value);
    return workflowV17CheckpointId(this.database.readRun().runId, operation.operationId, workspace.workspaceId);
  }

  private plan(run: WorkflowRunV17Record, input: unknown): CandidatePlan {
    const record = plainRecord(input, "workflow v17 candidate options");
    exactKeys(record, ["base", "writes"], "workflow v17 candidate options");
    let parent: WorkflowCandidateV17Record | undefined;
    let base: JsonValue = { kind: "launch-snapshot", snapshotHash: run.projectSnapshotHash };
    if (record.base !== undefined) {
      const description = this.authority.describe(record.base);
      if (description?.family === "reference" && description.identity.kind === "launch-snapshot") {
        const authority = description.privateAuthority;
        if (!launchPrivate(authority, run.runId, run.projectSnapshotHash)) {
          throw new WorkflowV17CandidateAuthorityError("Launch snapshot authority is stale");
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
        formatVersion: 1,
        base,
        writeScope: writeScope as unknown as JsonValue,
        writeScopeHash: stableHash(writeScope),
      }, limits()),
    };
  }

  private runtimeValue(candidate: WorkflowCandidateV17Record): WorkflowV17CandidateRuntimeValue {
    const manifest = this.database.readArtifact(candidate.manifestArtifactDigest);
    const diff = this.database.readArtifact(candidate.diffArtifactDigest);
    if (!manifest || !diff) throw new WorkflowV17CandidateAuthorityError("Candidate artifact evidence is unavailable");
    return {
      result: {
        formatVersion: 1,
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

  private productValue(candidate: WorkflowCandidateV17Record, accepted: boolean): object {
    const key = `${accepted ? "accepted" : "candidate"}:${candidate.candidateId}`;
    const recordHash = candidateImmutableHash(candidate);
    const authorityHash = stableHash({
      formatVersion: 1,
      kind: accepted ? "workflow-v17-accepted-candidate-authority" : "workflow-v17-candidate-authority",
      runId: candidate.runId,
      candidateId: candidate.candidateId,
      recordHash,
      ...(accepted ? { dispositionHash: candidate.disposition!.authorityHash } : {}),
    });
    const existing = this.candidates.get(key);
    if (existing) {
      if (existing.hash !== authorityHash) {
        throw new WorkflowV17CandidateAuthorityError(`Candidate ${candidate.candidateId} changed authority`);
      }
      return existing.value;
    }
    const privateAuthority = freezePrivate<CandidatePrivateAuthority>({
      formatVersion: PRIVATE_FORMAT,
      runId: candidate.runId,
      candidateId: candidate.candidateId,
      recordHash,
      accepted,
      ...(accepted ? { dispositionHash: candidate.disposition!.authorityHash } : {}),
    });
    const identity: WorkflowV17ProductIdentity = {
      formatVersion: 1,
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

/** Btrfs candidate/checkpoint implementation used by the eventual coordinator cutover. */
export class WorkflowV17FilesystemCandidateDriver implements WorkflowV17CandidateWorkspaceDriver {
  readonly runDir: string;
  private launch?: { manifest: ProjectSnapshotManifest; tree: CandidateTreeManifest };

  constructor(
    runDir: string,
    readonly database: WorkflowRunDatabaseV17,
    readonly store: WorkflowV17ArtifactStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.runDir = path.resolve(runDir);
  }

  async prepare(input: {
    run: WorkflowRunV17Record;
    operation: WorkflowOperationV17Record;
    parent?: WorkflowCandidateV17Record;
    writeScope: CandidateWriteScope;
  }): Promise<WorkflowV17PreparedCandidateWorkspace> {
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
      formatVersion: 1,
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

  async describe(record: WorkflowCandidateWorkspaceV17Record): Promise<WorkflowV17CandidateWorkspaceHandle> {
    const root = contained(this.runDir, record.rootPath);
    const launch = await this.launchState(this.database.readRun());
    const cwd = path.resolve(root, launch.manifest.cwd === "." ? "" : launch.manifest.cwd);
    assertInside(root, cwd);
    const current = await scanCandidateTree(root);
    return { record: structuredClone(record), root, cwd, currentTreeHash: current.treeHash };
  }

  async freeze(input: {
    run: WorkflowRunV17Record;
    operation: WorkflowOperationV17Record;
    workspace: WorkflowCandidateWorkspaceV17Record;
    output: JsonValue;
  }): Promise<WorkflowV17FrozenCandidateWorkspace> {
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
      formatVersion: 1,
      operationId: input.operation.operationId,
      baseLineageHash: input.workspace.baseLineageHash,
      treeHash: current.treeHash,
      writeScopeHash: input.workspace.writeScopeHash,
    });
    const manifest = await this.store.putJson({
      kind: "candidate-manifest",
      value: {
        formatVersion: 1,
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
        formatVersion: 1,
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
    run: WorkflowRunV17Record;
    operation: WorkflowOperationV17Record;
    workspace: WorkflowCandidateWorkspaceV17Record;
  }): Promise<WorkflowWorkspaceCheckpointV17Record> {
    const handle = await this.describe(input.workspace);
    const tree = await scanCandidateTree(handle.root);
    const checkpointId = workflowV17CheckpointId(
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

  private async launchState(run: WorkflowRunV17Record): Promise<{ manifest: ProjectSnapshotManifest; tree: CandidateTreeManifest }> {
    if (this.launch) return this.launch;
    const source = await fs.promises.readFile(path.join(this.runDir, "context", "project-manifest.json"), "utf8");
    const manifest = JSON.parse(source) as ProjectSnapshotManifest;
    assertProjectSnapshotManifest(manifest);
    if (manifest.treeHash !== run.projectSnapshotHash) throw new Error("Launch snapshot differs from workflow run");
    const root = path.join(this.runDir, "context", "project");
    if ((await scanCandidateTree(root)).treeHash !== manifest.treeHash) throw new Error("Launch snapshot tree is corrupt");
    this.launch = { manifest, tree: projectTreeManifest(manifest) };
    return this.launch;
  }
}

export class WorkflowV17CandidateAuthorityError extends Error {
  constructor(message: string) { super(message); this.name = "WorkflowV17CandidateAuthorityError"; }
}

export function workflowV17CheckpointId(runId: string, operationId: string, workspaceId: string): string {
  return `checkpoint_${stableHash({
    formatVersion: 1,
    kind: "workflow-v17-workspace-checkpoint",
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
  const record = plainRecord(value, "workflow v17 candidate result");
  exactKeys(record, ["formatVersion", "candidateId", "outputHash", "changedPathsHash"], "workflow v17 candidate result");
  if (record.formatVersion !== 1 || typeof record.candidateId !== "string"
    || typeof record.outputHash !== "string" || typeof record.changedPathsHash !== "string") {
    throw new WorkflowV17CandidateAuthorityError("Workflow v17 candidate result is invalid");
  }
  return record as unknown as ReturnType<typeof candidateResult>;
}

function candidateImmutableHash(candidate: WorkflowCandidateV17Record): string {
  return stableHash({
    formatVersion: 1,
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
  kind: WorkflowV17ReferenceIdentity["kind"],
  authorityId: string,
  privateAuthority: object,
): WorkflowV17ReferenceIdentity {
  return { formatVersion: 1, kind, authorityId, authorityHash: stableHash(privateAuthority) };
}

function candidatePrivate(
  description: WorkflowV17ControlAuthorityDescription | undefined,
  runId: string,
  accepted: boolean,
): CandidatePrivateAuthority {
  const privateAuthority = description?.privateAuthority;
  if (!description || description.family !== "product"
    || description.identity.kind !== (accepted ? "accepted-candidate" : "candidate")
    || !plainPrivate(privateAuthority) || privateAuthority.formatVersion !== PRIVATE_FORMAT
    || privateAuthority.runId !== runId || privateAuthority.accepted !== accepted
    || typeof privateAuthority.candidateId !== "string" || typeof privateAuthority.recordHash !== "string") {
    throw new WorkflowV17CandidateAuthorityError(
      accepted ? "Value is not an accepted candidate from this run" : "Value is not a candidate from this run",
    );
  }
  return privateAuthority as unknown as CandidatePrivateAuthority;
}

function launchPrivate(value: unknown, runId: string, snapshotHash: string): boolean {
  return plainPrivate(value) && value.formatVersion === PRIVATE_FORMAT
    && value.runId === runId && value.snapshotHash === snapshotHash;
}

function workspacePrivate(value: unknown, runId: string): value is WorkspacePrivateAuthority {
  return plainPrivate(value) && value.formatVersion === PRIVATE_FORMAT && value.runId === runId
    && typeof value.workspaceId === "string" && typeof value.recordHash === "string";
}

function assertWorkspacePlan(
  workspace: WorkflowCandidateWorkspaceV17Record,
  context: WorkflowV17CandidateRuntimeContext,
  plan: CandidatePlan,
): void {
  if (workspace.candidateOperationId !== context.operation.operationId
    || workspace.bodyScopeId !== context.bodyScope.scopeId
    || workspace.parentCandidateId !== plan.parent?.candidateId
    || workspace.writeScopeHash !== stableHash(plan.writeScope)
    || stableJson(workspace.writeScope) !== stableJson(plan.writeScope)) {
    throw new WorkflowV17CandidateAuthorityError("Candidate workspace differs from its reviewed plan");
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
      if (error instanceof WorkflowRunDatabaseV17RevisionConflictError) continue;
      throw error;
    }
  }
  throw new Error("Workflow v17 candidate lifecycle exceeded revision retries");
}

function reason(code: string, summary: string): JsonObject {
  return { category: "candidate", code, summary, retryable: false };
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("Workflow v17 candidate clock is invalid");
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
