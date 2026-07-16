import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { JsonValue } from "../types.js";
import type {
  AtomicOperationCompletion,
} from "../persistence/run-database.js";
import { RunDatabase } from "../persistence/run-database.js";
import type {
  CandidateRecord,
  CandidateWorkspaceRecord,
  CandidateWriteScope,
  OperationRecord,
  OperationResult,
  WorkflowCallRecord,
  WorkspaceCheckpointRecord,
  WorkspaceRef,
} from "../runtime/durable-types.js";
import { ArtifactStore } from "../artifacts/store.js";
import { canonicalJsonValue } from "../definition/canonical-json.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import {
  assertProjectSnapshotManifest,
  verifyProjectSnapshot,
  type ProjectSnapshotManifest,
} from "../workspaces/project-snapshot.js";
import {
  assertCandidateTreeManifest,
  cloneCandidateTree,
  diffCandidateTrees,
  projectTreeManifest,
  scanCandidateTree,
  validateCandidatePath,
  type CandidatePathChange,
  type CandidateTreeManifest,
} from "./tree.js";
import {
  CandidateWorkspaceError,
  assertDirectoryChain,
  assertInside,
  assertNoSymlinkPath,
  assertRealDirectory,
  assertSame,
  assertSameWorkspace,
  compareBytes,
  iso,
  normalizeLogicalId,
  readProjectManifest,
  removeTree,
  syncDirectory,
} from "./workspace-files.js";

export type { CandidatePathChange, CandidateTreeManifest } from "./tree.js";
export type { CandidateRecord, CandidateWriteScope, CandidateWorkspaceRecord } from "../runtime/durable-types.js";
export { CandidateWorkspaceError } from "./workspace-files.js";

export type CandidateWorkspaceCapability = Readonly<object>;

/** Recognition only; the owning manager still performs every authority check. */
export function isCandidateWorkspaceCapability(value: unknown): value is CandidateWorkspaceCapability {
  return !!value && typeof value === "object" && CAPABILITIES.has(value as object);
}

export interface CandidateWorkspaceHandle {
  capability: CandidateWorkspaceCapability;
  ref: WorkspaceRef & { kind: "candidate" };
  root: string;
  cwd: string;
  logicalId: string;
  parentCandidateId?: string;
  writeScope: CandidateWriteScope;
}

export interface FrozenCandidateManifest {
  formatVersion: 1;
  candidateId: string;
  runId: string;
  parentCandidateId?: string;
  workspaceId: string;
  tree: CandidateTreeManifest;
  lineageHash: string;
  writeScope: CandidateWriteScope;
  writeScopeHash: string;
  directChanges: CandidatePathChange[];
  changedPaths: string[];
  frozenAt: string;
}

export interface CandidateDiffArtifact {
  formatVersion: 1;
  candidateId: string;
  baseTreeHash: string;
  treeHash: string;
  changes: CandidatePathChange[];
}

export type CandidateWorkspaceFaultPoint =
  | "workspace-published"
  | "workspace-registered"
  | "checkpoint-cloned"
  | "checkpoint-published"
  | "manifest-stored"
  | "diff-stored"
  | "candidate-registered"
  | "restore-backed-up"
  | "restore-published";

export interface CandidateWorkspaceManagerOptions {
  now?: () => Date;
  faultInjector?: (point: CandidateWorkspaceFaultPoint) => void | Promise<void>;
}

export interface PreparedWorkspaceCheckpoint {
  record: WorkspaceCheckpointRecord;
  manifest: CandidateTreeManifest;
}

export interface ImportedWorkspaceCheckpoint {
  record: WorkspaceCheckpointRecord;
  restored: true;
}

export interface CompleteMutatingOperationInput
  extends Omit<AtomicOperationCompletion, "result" | "workspaceCheckpoint" | "journal"> {
  workspace: CandidateWorkspaceCapability;
  result: Omit<OperationResult, "workspace">;
  journal: Omit<WorkflowCallRecord, "result" | "postWorkspaceCheckpointId">;
}

const CAPABILITIES = new WeakMap<object, { owner: object; workspaceId: string }>();
const WORKSPACE_ID = /^workspace_[a-f0-9]{32}$/;
const CANDIDATE_ID = /^candidate_[a-f0-9]{32}$/;
const CHECKPOINT_ID = /^checkpoint_[a-f0-9]{32}$/;

export class CandidateWriteScopeError extends Error {
  constructor(readonly offending: CandidatePathChange[]) {
    super(`Candidate changes escape the fixed write scope: ${offending.slice(0, 16).map((change) => change.path).join(", ")}`);
    this.name = "CandidateWriteScopeError";
  }
}

/** One Btrfs-only candidate/checkpoint manager bound to a run database. */
export class CandidateWorkspaceManager {
  readonly runDir: string;
  readonly runId: string;
  readonly launchRoot: string;
  readonly launchManifest: ProjectSnapshotManifest;
  readonly launchTree: CandidateTreeManifest;
  readonly artifacts: ArtifactStore;
  private readonly owner = Object.freeze({});
  private readonly now: () => Date;
  private readonly faultInjector?: CandidateWorkspaceManagerOptions["faultInjector"];

  private constructor(
    runDir: string,
    readonly database: RunDatabase,
    launchManifest: ProjectSnapshotManifest,
    options: CandidateWorkspaceManagerOptions,
  ) {
    this.runDir = path.resolve(runDir);
    this.runId = database.readRun().runId;
    this.launchRoot = path.join(this.runDir, "context", "project");
    this.launchManifest = launchManifest;
    this.launchTree = projectTreeManifest(launchManifest);
    this.artifacts = new ArtifactStore(this.runDir, database, { now: options.now });
    this.now = options.now ?? (() => new Date());
    this.faultInjector = options.faultInjector;
  }

  static async open(
    runDirInput: string,
    database: RunDatabase,
    options: CandidateWorkspaceManagerOptions = {},
  ): Promise<CandidateWorkspaceManager> {
    const runDir = path.resolve(runDirInput);
    if (path.resolve(database.databasePath) !== path.join(runDir, "run.sqlite")) {
      throw new CandidateWorkspaceError("Candidate manager and run database do not match");
    }
    await assertRealDirectory(runDir);
    const manifest = await readProjectManifest(path.join(runDir, "context", "project-manifest.json"));
    assertProjectSnapshotManifest(manifest);
    if (database.readRun().projectSnapshotHash !== manifest.treeHash) {
      throw new CandidateWorkspaceError("Run database and launch snapshot identities differ");
    }
    await verifyProjectSnapshot(path.join(runDir, "context", "project"), manifest);
    for (const directory of ["workspaces/candidates", "workspaces/checkpoints"]) {
      await fs.promises.mkdir(path.join(runDir, directory), { recursive: true, mode: 0o700 });
      await assertRealDirectory(path.join(runDir, directory));
    }
    return new CandidateWorkspaceManager(runDir, database, manifest, options);
  }

  async create(options: {
    logicalId: string;
    writeScope?: CandidateWriteScope;
    parentCandidateId?: string;
    createdAt?: string;
  }): Promise<CandidateWorkspaceCapability> {
    const logicalId = normalizeLogicalId(options.logicalId);
    const writeScope = normalizeCandidateWriteScope(options.writeScope);
    const writeScopeHash = stableHash(writeScope);
    const parent = options.parentCandidateId ? this.requiredCandidate(options.parentCandidateId) : undefined;
    const parentWorkspace = parent ? this.database.readCandidateWorkspace(parent.workspace.workspaceId) : undefined;
    if (parent && !parentWorkspace) throw new CandidateWorkspaceError(`Candidate ${parent.candidateId} has no workspace`);
    const sourceRoot = parentWorkspace ? this.absoluteRoot(parentWorkspace) : this.launchRoot;
    const sourceTree = parent ? await scanCandidateTree(sourceRoot) : this.launchTree;
    if (parent && sourceTree.treeHash !== parent.workspace.treeHash) {
      throw new CandidateWorkspaceError("Parent candidate workspace no longer matches its frozen tree");
    }
    const workspaceId = `workspace_${stableHash({
      runId: this.runId,
      logicalId,
      parentCandidateId: parent?.candidateId ?? null,
      parentTreeHash: sourceTree.treeHash,
      writeScopeHash,
    }).slice(7, 39)}`;
    const lineageHash = stableHash({
      formatVersion: 1,
      logicalId,
      parentLineageHash: parent?.workspace.lineageHash ?? this.launchManifest.manifestHash,
      parentTreeHash: sourceTree.treeHash,
      writeScopeHash,
    });
    const createdAt = iso(options.createdAt ?? this.now().toISOString());
    const rootPath = `workspaces/candidates/${workspaceId}/project`;
    const record: CandidateWorkspaceRecord = {
      workspaceId,
      runId: this.runId,
      logicalId,
      ...(parent ? { parentCandidateId: parent.candidateId } : {}),
      workspace: {
        kind: "candidate",
        workspaceId,
        treeHash: sourceTree.treeHash,
        lineageHash,
        writeScopeHash,
      },
      writeScope,
      rootPath,
      createdAt,
    };

    const existing = this.database.readCandidateWorkspace(workspaceId);
    if (existing) {
      const { createdAt: _existingCreatedAt, ...existingIdentity } = existing;
      const { createdAt: _proposedCreatedAt, ...proposedIdentity } = record;
      assertSame(existingIdentity, proposedIdentity, "candidate workspace");
      await this.ensureWorkspaceExists(existing, sourceRoot, sourceTree.treeHash);
      return this.capability(existing);
    }

    const finalDirectory = path.dirname(this.absoluteRoot(record));
    const temporaryDirectory = `${finalDirectory}.tmp-${crypto.randomUUID()}`;
    try {
      const manifest = await cloneCandidateTree(sourceRoot, path.join(temporaryDirectory, "project"));
      if (manifest.treeHash !== sourceTree.treeHash) throw new CandidateWorkspaceError("Candidate clone differs from its immutable parent");
      try {
        await fs.promises.rename(temporaryDirectory, finalDirectory);
        await syncDirectory(path.dirname(finalDirectory));
      } catch (error: any) {
        if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
        await removeTree(temporaryDirectory);
        if ((await scanCandidateTree(path.join(finalDirectory, "project"))).treeHash !== sourceTree.treeHash) {
          throw new CandidateWorkspaceError(`Candidate workspace collision ${workspaceId}`);
        }
      }
      await this.fault("workspace-published");
      this.database.registerCandidateWorkspace(this.database.readRun().revision, record, {
        type: "candidate-workspace-created",
        payload: { workspaceId, logicalId },
        at: createdAt,
      });
      await this.fault("workspace-registered");
      return this.capability(record);
    } catch (error) {
      await removeTree(temporaryDirectory).catch(() => undefined);
      throw error;
    }
  }

  async openWorkspace(workspaceId: string): Promise<CandidateWorkspaceCapability> {
    if (!WORKSPACE_ID.test(workspaceId)) throw new CandidateWorkspaceError("Invalid candidate workspace id");
    const record = this.database.readCandidateWorkspace(workspaceId);
    if (!record || record.runId !== this.runId) throw new CandidateWorkspaceError(`Unknown candidate workspace ${workspaceId}`);
    return this.capability(record);
  }

  async describe(capability: CandidateWorkspaceCapability): Promise<CandidateWorkspaceHandle> {
    const record = this.resolve(capability);
    const root = this.absoluteRoot(record);
    await assertNoSymlinkPath(this.runDir, root);
    await assertRealDirectory(root);
    const cwd = path.resolve(root, this.launchManifest.cwd === "." ? "" : this.launchManifest.cwd);
    assertInside(root, cwd, "Candidate cwd");
    await assertDirectoryChain(root, cwd);
    const current = await scanCandidateTree(root);
    return {
      capability,
      ref: { ...structuredClone(record.workspace), treeHash: current.treeHash },
      root,
      cwd,
      logicalId: record.logicalId,
      ...(record.parentCandidateId ? { parentCandidateId: record.parentCandidateId } : {}),
      writeScope: structuredClone(record.writeScope),
    };
  }

  async prepareCheckpoint(options: {
    operationId: string;
    workspace: CandidateWorkspaceCapability;
    createdAt?: string;
  }): Promise<PreparedWorkspaceCheckpoint> {
    const workspace = this.resolve(options.workspace);
    const operation = this.database.readOperation(options.operationId);
    if (!operation || operation.runId !== this.runId) throw new CandidateWorkspaceError(`Unknown checkpoint operation ${options.operationId}`);
    const root = this.absoluteRoot(workspace);
    const current = await scanCandidateTree(root);
    const parent = workspace.parentCandidateId ? this.requiredCandidate(workspace.parentCandidateId) : undefined;
    const baseline = parent ? (await this.readFrozenManifest(parent)).tree : this.launchTree;
    enforceWriteScope(workspace.writeScope, diffCandidateTrees(baseline, current));
    const temporary = path.join(this.runDir, "workspaces", "checkpoints", `.checkpoint-${crypto.randomUUID()}.tmp`);
    const manifest = await cloneCandidateTree(root, temporary, { durable: true });
    await this.fault("checkpoint-cloned");
    const after = await scanCandidateTree(root);
    if (manifest.treeHash !== current.treeHash || after.treeHash !== manifest.treeHash) {
      await removeTree(temporary);
      throw new CandidateWorkspaceError("Candidate changed while its post-workspace checkpoint was captured");
    }
    const checkpointId = `checkpoint_${stableHash({
      runId: this.runId,
      operationId: operation.operationId,
      workspaceId: workspace.workspaceId,
      treeHash: manifest.treeHash,
      lineageHash: workspace.workspace.lineageHash,
      writeScopeHash: workspace.workspace.writeScopeHash,
    }).slice(7, 39)}`;
    const storagePath = `workspaces/checkpoints/${checkpointId}`;
    const finalRoot = path.join(this.runDir, storagePath);
    try {
      await fs.promises.rename(temporary, finalRoot);
      await syncDirectory(path.dirname(finalRoot));
    } catch (error: any) {
      if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
      await removeTree(temporary);
      if ((await scanCandidateTree(finalRoot)).treeHash !== manifest.treeHash) {
        throw new CandidateWorkspaceError(`Workspace checkpoint collision ${checkpointId}`);
      }
    }
    await this.fault("checkpoint-published");
    return {
      manifest,
      record: {
        checkpointId,
        runId: this.runId,
        operationId: operation.operationId,
        workspace: {
          kind: "candidate",
          workspaceId: workspace.workspaceId,
          treeHash: manifest.treeHash,
          lineageHash: workspace.workspace.lineageHash,
          writeScopeHash: workspace.workspace.writeScopeHash,
        },
        storagePath,
        createdAt: iso(options.createdAt ?? this.now().toISOString()),
      },
    };
  }

  /** The only successful candidate-result commit path: checkpoint and journal are mandatory. */
  async completeMutatingOperation(input: CompleteMutatingOperationInput): Promise<OperationRecord> {
    const prepared = await this.prepareCheckpoint({
      operationId: input.operationId,
      workspace: input.workspace,
      createdAt: input.completedAt,
    });
    const result: OperationResult = { ...input.result, workspace: prepared.record.workspace };
    return this.database.completeOperation({
      ...input,
      result,
      workspaceCheckpoint: prepared.record,
      journal: {
        ...input.journal,
        result,
        postWorkspaceCheckpointId: prepared.record.checkpointId,
      },
    });
  }

  /** Restore the exact journaled post-tree before returning a completed mutating result. */
  async restoreForReplay(operationId: string, capability: CandidateWorkspaceCapability): Promise<{ restored: boolean; operation: OperationRecord }> {
    const workspace = this.resolve(capability);
    const operation = this.database.readOperation(operationId);
    const journal = this.database.readWorkflowCall(operationId);
    if (!operation || operation.status !== "completed" || !operation.result?.workspace || operation.result.workspace.kind !== "candidate") {
      throw new CandidateWorkspaceError("Mutating replay has no completed candidate result");
    }
    if (!journal?.postWorkspaceCheckpointId) throw new CandidateWorkspaceError("Mutating replay has no journaled post-workspace checkpoint");
    if (stableJson(journal.result) !== stableJson(operation.result)) {
      throw new CandidateWorkspaceError("Mutating replay journal differs from the completed result");
    }
    const checkpoint = this.database.readWorkspaceCheckpoint(journal.postWorkspaceCheckpointId);
    if (!checkpoint || checkpoint.operationId !== operationId) throw new CandidateWorkspaceError("Journaled post-workspace checkpoint is missing");
    assertSameWorkspace(operation.result.workspace, checkpoint.workspace, "replay result");
    if (workspace.workspaceId !== checkpoint.workspace.workspaceId) throw new CandidateWorkspaceError("Replay workspace has the wrong identity");
    if (
      workspace.workspace.lineageHash !== checkpoint.workspace.lineageHash
      || workspace.workspace.writeScopeHash !== checkpoint.workspace.writeScopeHash
    ) throw new CandidateWorkspaceError("Replay workspace authority differs from its checkpoint");
    const root = this.absoluteRoot(workspace);
    try {
      const current = await scanCandidateTree(root);
      if (current.treeHash === checkpoint.workspace.treeHash) return { restored: false, operation };
    } catch { /* an absent or unsafe mutable tree is restored from authority */ }
    await this.restoreCheckpoint(workspace, checkpoint);
    return { restored: true, operation };
  }

  /**
   * Import an explicit old run's immutable post-tree, bind it to this run's
   * candidate authority, and restore it before the replay hit can commit.
   */
  async importCheckpointForReplay(options: {
    sourceRunDir: string;
    source: WorkspaceCheckpointRecord;
    operationId: string;
    workspace: CandidateWorkspaceCapability;
    expectedPreTreeHash?: string;
    createdAt?: string;
  }): Promise<ImportedWorkspaceCheckpoint> {
    const workspace = this.resolve(options.workspace);
    const operation = this.database.readOperation(options.operationId);
    if (!operation || operation.runId !== this.runId) {
      throw new CandidateWorkspaceError(`Unknown replay operation ${options.operationId}`);
    }
    const sourceRunDir = path.resolve(options.sourceRunDir);
    if (sourceRunDir === this.runDir || options.source.runId === this.runId) {
      throw new CandidateWorkspaceError("Cross-revision checkpoint source must be another run");
    }
    if (options.source.storagePath !== `workspaces/checkpoints/${options.source.checkpointId}`) {
      throw new CandidateWorkspaceError("Source replay checkpoint path is noncanonical");
    }
    if (options.source.workspace.kind !== "candidate") {
      throw new CandidateWorkspaceError("Source replay checkpoint is not a candidate tree");
    }
    if (options.source.workspace.writeScopeHash !== workspace.workspace.writeScopeHash) {
      throw new CandidateWorkspaceError("Replay checkpoint write scope differs from the current candidate");
    }
    const current = await scanCandidateTree(this.absoluteRoot(workspace));
    if (options.expectedPreTreeHash && current.treeHash !== options.expectedPreTreeHash) {
      throw new CandidateWorkspaceError("Replay candidate pre-tree changed before checkpoint restore");
    }

    const sourceRoot = path.resolve(sourceRunDir, options.source.storagePath);
    assertInside(sourceRunDir, sourceRoot, "Source replay checkpoint");
    await assertNoSymlinkPath(sourceRunDir, sourceRoot);
    const sourceTree = await scanCandidateTree(sourceRoot);
    if (sourceTree.treeHash !== options.source.workspace.treeHash) {
      throw new CandidateWorkspaceError("Source replay checkpoint tree is corrupt");
    }

    const checkpointId = `checkpoint_${stableHash({
      runId: this.runId,
      operationId: operation.operationId,
      workspaceId: workspace.workspaceId,
      treeHash: sourceTree.treeHash,
      lineageHash: workspace.workspace.lineageHash,
      writeScopeHash: workspace.workspace.writeScopeHash,
    }).slice(7, 39)}`;
    const storagePath = `workspaces/checkpoints/${checkpointId}`;
    const finalRoot = path.join(this.runDir, storagePath);
    const temporary = path.join(this.runDir, "workspaces", "checkpoints", `.checkpoint-${crypto.randomUUID()}.tmp`);
    try {
      const imported = await cloneCandidateTree(sourceRoot, temporary, { durable: true });
      if (imported.treeHash !== sourceTree.treeHash) {
        throw new CandidateWorkspaceError("Imported replay checkpoint differs from its source");
      }
      try {
        await fs.promises.rename(temporary, finalRoot);
        await syncDirectory(path.dirname(finalRoot));
      } catch (error: any) {
        if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
        await removeTree(temporary);
        if ((await scanCandidateTree(finalRoot)).treeHash !== sourceTree.treeHash) {
          throw new CandidateWorkspaceError(`Workspace checkpoint collision ${checkpointId}`);
        }
      }
    } catch (error) {
      await removeTree(temporary).catch(() => undefined);
      throw error;
    }
    await this.fault("checkpoint-published");
    const record: WorkspaceCheckpointRecord = {
      checkpointId,
      runId: this.runId,
      operationId: operation.operationId,
      workspace: {
        kind: "candidate",
        workspaceId: workspace.workspaceId,
        treeHash: sourceTree.treeHash,
        lineageHash: workspace.workspace.lineageHash,
        writeScopeHash: workspace.workspace.writeScopeHash,
      },
      storagePath,
      createdAt: iso(options.createdAt ?? this.now().toISOString()),
    };
    await this.restoreCheckpoint(workspace, record);
    return { record, restored: true };
  }

  async freeze(options: {
    workspace: CandidateWorkspaceCapability;
    frozenAt?: string;
  }): Promise<CandidateRecord> {
    const workspace = this.resolve(options.workspace);
    const current = await scanCandidateTree(this.absoluteRoot(workspace));
    const parent = workspace.parentCandidateId ? this.requiredCandidate(workspace.parentCandidateId) : undefined;
    const parentTree = parent ? await this.readFrozenManifest(parent) : undefined;
    const directChanges = diffCandidateTrees(parentTree?.tree ?? this.launchTree, current);
    enforceWriteScope(workspace.writeScope, directChanges);
    const netChanges = diffCandidateTrees(this.launchTree, current);
    if (netChanges.length > DEFINITION_LIMITS.candidateChangedPaths * 2) throw new CandidateWorkspaceError("Candidate diff is too large");
    const changedPaths = [...new Set(netChanges.map((change) => change.path))].sort(compareBytes);
    const frozenAt = iso(options.frozenAt ?? this.now().toISOString());
    const candidateId = `candidate_${stableHash({
      runId: this.runId,
      workspaceId: workspace.workspaceId,
      treeHash: current.treeHash,
      lineageHash: workspace.workspace.lineageHash,
      writeScopeHash: workspace.workspace.writeScopeHash,
      changedPaths,
    }).slice(7, 39)}`;
    const existing = this.database.readCandidate(candidateId);
    if (existing) {
      if ((await scanCandidateTree(this.absoluteRoot(workspace))).treeHash !== existing.workspace.treeHash) {
        throw new CandidateWorkspaceError("Frozen candidate workspace has changed");
      }
      return existing;
    }
    const manifest: FrozenCandidateManifest = {
      formatVersion: 1,
      candidateId,
      runId: this.runId,
      ...(parent ? { parentCandidateId: parent.candidateId } : {}),
      workspaceId: workspace.workspaceId,
      tree: current,
      lineageHash: workspace.workspace.lineageHash!,
      writeScope: workspace.writeScope,
      writeScopeHash: workspace.workspace.writeScopeHash!,
      directChanges,
      changedPaths,
      frozenAt,
    };
    const diff: CandidateDiffArtifact = {
      formatVersion: 1,
      candidateId,
      baseTreeHash: this.launchTree.treeHash,
      treeHash: current.treeHash,
      changes: netChanges,
    };
    const storedManifest = await this.artifacts.putJson({
      expectedRevision: this.database.readRun().revision,
      kind: "candidate-manifest",
      value: manifest as unknown as JsonValue,
      metadata: { candidateId },
      createdAt: frozenAt,
    });
    await this.fault("manifest-stored");
    const storedDiff = await this.artifacts.putJson({
      expectedRevision: this.database.readRun().revision,
      kind: "candidate-diff",
      value: diff as unknown as JsonValue,
      metadata: { candidateId },
      createdAt: frozenAt,
    });
    await this.fault("diff-stored");
    const after = await scanCandidateTree(this.absoluteRoot(workspace));
    if (after.treeHash !== current.treeHash) throw new CandidateWorkspaceError("Candidate changed while it was frozen");
    const record: CandidateRecord = {
      candidateId,
      runId: this.runId,
      ...(parent ? { parentCandidateId: parent.candidateId } : {}),
      workspace: {
        kind: "candidate",
        workspaceId: workspace.workspaceId,
        treeHash: current.treeHash,
        lineageHash: workspace.workspace.lineageHash,
        writeScopeHash: workspace.workspace.writeScopeHash,
      },
      changedPaths,
      manifest: storedManifest.artifact,
      diff: storedDiff.artifact,
      frozenAt,
    };
    const registered = this.database.registerCandidate(this.database.readRun().revision, record, {
      type: "candidate-frozen",
      payload: { candidateId, workspaceId: workspace.workspaceId, changedPaths: changedPaths.length },
      at: frozenAt,
    });
    await this.fault("candidate-registered");
    return registered;
  }

  /** Remove only filesystem checkpoint bodies which SQLite does not name. */
  async reconcile(): Promise<{ removed: number; retained: number }> {
    const root = path.join(this.runDir, "workspaces", "checkpoints");
    const referenced = new Set(this.database.listWorkspaceCheckpointIds());
    let removed = 0;
    let retained = 0;
    for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
      const target = path.join(root, entry.name);
      if (entry.name.startsWith(".checkpoint-") && entry.name.endsWith(".tmp")) {
        await removeTree(target); removed++; continue;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink() || !CHECKPOINT_ID.test(entry.name)) continue;
      if (!referenced.has(entry.name)) { await removeTree(target); removed++; }
      else { await this.verifyCheckpoint(this.database.readWorkspaceCheckpoint(entry.name)!); retained++; }
    }
    const candidates = path.join(this.runDir, "workspaces", "candidates");
    for (const entry of await fs.promises.readdir(candidates, { withFileTypes: true })) {
      const target = path.join(candidates, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name.includes(".tmp-")) { await removeTree(target); removed++; continue; }
      if (!WORKSPACE_ID.test(entry.name)) continue;
      for (const child of await fs.promises.readdir(target, { withFileTypes: true })) {
        if (!child.isDirectory() || (!child.name.includes(".restore-") && !child.name.includes(".stale-"))) continue;
        await removeTree(path.join(target, child.name));
        removed++;
      }
    }
    if (removed) await Promise.all([syncDirectory(root), syncDirectory(candidates)]);
    return { removed, retained };
  }

  /** Bind only the disposable tree; callers must not add a live-project bind. */
  async bubblewrapBind(capability: CandidateWorkspaceCapability): Promise<string[]> {
    const handle = await this.describe(capability);
    return ["--bind", handle.root, "/workspace"];
  }

  private async restoreCheckpoint(workspace: CandidateWorkspaceRecord, checkpoint: WorkspaceCheckpointRecord): Promise<void> {
    await this.verifyCheckpoint(checkpoint);
    const source = path.join(this.runDir, checkpoint.storagePath);
    const root = this.absoluteRoot(workspace);
    const parent = path.dirname(root);
    await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = `${root}.restore-${crypto.randomUUID()}`;
    const restored = await cloneCandidateTree(source, temporary, { durable: true });
    if (restored.treeHash !== checkpoint.workspace.treeHash) throw new CandidateWorkspaceError("Restored checkpoint tree differs from its database row");
    const backup = `${root}.stale-${crypto.randomUUID()}`;
    let hadRoot = false;
    try {
      try { await fs.promises.rename(root, backup); hadRoot = true; }
      catch (error: any) { if (error?.code !== "ENOENT") throw error; }
      await this.fault("restore-backed-up");
      await fs.promises.rename(temporary, root);
      await syncDirectory(parent);
      await this.fault("restore-published");
      if (hadRoot) await removeTree(backup);
    } catch (error) {
      await removeTree(temporary).catch(() => undefined);
      throw error;
    }
    if ((await scanCandidateTree(root)).treeHash !== checkpoint.workspace.treeHash) {
      throw new CandidateWorkspaceError("Candidate checkpoint restore verification failed");
    }
  }

  private async verifyCheckpoint(checkpoint: WorkspaceCheckpointRecord): Promise<void> {
    if (checkpoint.runId !== this.runId || !CHECKPOINT_ID.test(checkpoint.checkpointId)) throw new CandidateWorkspaceError("Invalid workspace checkpoint identity");
    if (checkpoint.storagePath !== `workspaces/checkpoints/${checkpoint.checkpointId}`) throw new CandidateWorkspaceError("Workspace checkpoint path is noncanonical");
    const actual = await scanCandidateTree(path.join(this.runDir, checkpoint.storagePath));
    if (actual.treeHash !== checkpoint.workspace.treeHash) throw new CandidateWorkspaceError(`Workspace checkpoint ${checkpoint.checkpointId} is corrupt`);
  }

  private async readFrozenManifest(candidate: CandidateRecord): Promise<FrozenCandidateManifest> {
    const stored = await this.artifacts.read(candidate.manifest.digest);
    const value = JSON.parse(await fs.promises.readFile(stored.bodyPath, "utf8")) as FrozenCandidateManifest;
    if (
      value.formatVersion !== 1 || value.candidateId !== candidate.candidateId
      || value.runId !== candidate.runId || value.workspaceId !== candidate.workspace.workspaceId
      || value.parentCandidateId !== candidate.parentCandidateId
      || value.tree.treeHash !== candidate.workspace.treeHash
      || value.lineageHash !== candidate.workspace.lineageHash
      || value.writeScopeHash !== candidate.workspace.writeScopeHash
      || stableJson(value.changedPaths) !== stableJson(candidate.changedPaths)
      || stableJson(value) !== await fs.promises.readFile(stored.bodyPath, "utf8")
    ) throw new CandidateWorkspaceError(`Candidate manifest ${candidate.candidateId} is corrupt`);
    assertCandidateTreeManifest(value.tree);
    return value;
  }

  private requiredCandidate(candidateId: string): CandidateRecord {
    if (!CANDIDATE_ID.test(candidateId)) throw new CandidateWorkspaceError("Invalid candidate id");
    const candidate = this.database.readCandidate(candidateId);
    if (!candidate || candidate.runId !== this.runId) throw new CandidateWorkspaceError(`Unknown candidate ${candidateId}`);
    return candidate;
  }

  private resolve(capability: CandidateWorkspaceCapability): CandidateWorkspaceRecord {
    if (!capability || typeof capability !== "object") throw new CandidateWorkspaceError("Candidate workspace is not an opaque capability");
    const held = CAPABILITIES.get(capability as object);
    if (!held || held.owner !== this.owner) throw new CandidateWorkspaceError("Candidate workspace capability is forged or belongs to another manager");
    const record = this.database.readCandidateWorkspace(held.workspaceId);
    if (!record || record.runId !== this.runId) throw new CandidateWorkspaceError("Candidate workspace capability is stale");
    return record;
  }

  private capability(record: CandidateWorkspaceRecord): CandidateWorkspaceCapability {
    const capability = Object.freeze(Object.create(null)) as object;
    CAPABILITIES.set(capability, { owner: this.owner, workspaceId: record.workspaceId });
    return capability;
  }

  private absoluteRoot(record: CandidateWorkspaceRecord): string {
    const target = path.resolve(this.runDir, record.rootPath);
    assertInside(this.runDir, target, "Candidate workspace");
    if (record.rootPath !== `workspaces/candidates/${record.workspaceId}/project`) {
      throw new CandidateWorkspaceError("Candidate workspace path is noncanonical");
    }
    return target;
  }

  private async ensureWorkspaceExists(record: CandidateWorkspaceRecord, source: string, expectedTreeHash: string): Promise<void> {
    const root = this.absoluteRoot(record);
    try {
      await scanCandidateTree(root);
      return;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    const temporary = `${root}.restore-${crypto.randomUUID()}`;
    const manifest = await cloneCandidateTree(source, temporary, { durable: true });
    if (manifest.treeHash !== expectedTreeHash) throw new CandidateWorkspaceError("Candidate recovery source differs from its initial tree");
    await fs.promises.rename(temporary, root);
    await syncDirectory(path.dirname(root));
  }

  private async fault(point: CandidateWorkspaceFaultPoint): Promise<void> { await this.faultInjector?.(point); }
}

export function normalizeCandidateWriteScope(value: CandidateWriteScope | undefined): CandidateWriteScope {
  if (value === undefined || value === "all-semantic-project-paths") return "all-semantic-project-paths";
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Candidate write scope must be an object");
  const allow = normalizeRules(value.allow, "allow");
  if (allow.length === 0) throw new Error("Candidate write scope allow list is empty");
  const deny = value.deny ? normalizeRules(value.deny, "deny") : undefined;
  if (allow.length + (deny?.length ?? 0) > DEFINITION_LIMITS.candidateScopeRules) throw new Error("Candidate write scope has too many rules");
  return canonicalJsonValue(
    { allow, ...(deny?.length ? { deny } : {}) },
    { maxBytes: 64 * 1024, maxDepth: 8, maxNodes: 256, maxStringScalars: 8_192 },
  ) as CandidateWriteScope;
}

function enforceWriteScope(scope: CandidateWriteScope, changes: CandidatePathChange[]): void {
  if (scope === "all-semantic-project-paths") return;
  const offending = changes.filter((change) => {
    return !scope.allow.some((rule) => ruleMatches(rule, change.path))
      || (scope.deny ?? []).some((rule) => ruleMatches(rule, change.path));
  });
  if (offending.length) throw new CandidateWriteScopeError(offending);
}

function normalizeRules(value: string[], label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Candidate write scope ${label} must be an array`);
  const rules = value.map((rule) => {
    if (typeof rule !== "string") throw new Error(`Candidate write scope ${label} contains a non-string rule`);
    if (/[?*\[\]{}]/.test(rule)) throw new Error(`Candidate write scope does not accept globs: ${rule}`);
    return validateCandidatePath(rule, rule.endsWith("/"));
  }).sort(compareBytes);
  for (const [index, rule] of rules.entries()) {
    if (rules.indexOf(rule) !== index) throw new Error(`Duplicate candidate write-scope rule ${rule}`);
    if (rules.some((other, otherIndex) => otherIndex !== index && other.endsWith("/") && rule.startsWith(other))) {
      throw new Error(`Redundant candidate write-scope rule ${rule}`);
    }
  }
  return rules;
}

function ruleMatches(rule: string, candidatePath: string): boolean { return rule.endsWith("/") ? candidatePath.startsWith(rule) : candidatePath === rule; }

