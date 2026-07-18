import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cloneCandidateTree, scanCandidateTree } from "../candidates/tree.js";
import type {
  WorkflowWorkspaceCheckpointRecord,
} from "../persistence/run-database-types.js";
import {
  WorkflowRunDatabase,
  WorkflowRunDatabaseReader,
} from "../persistence/run-database.js";
import { stableHash } from "../utils/hashes.js";

export interface WorkflowReplayWorkspaceTarget {
  workspaceId: string;
  lineageHash: string;
  expectedPreTreeHash?: string;
}

export interface WorkflowImportedWorkspaceCheckpoint {
  record: WorkflowWorkspaceCheckpointRecord;
  restored: boolean;
}

export class WorkflowReplayWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowReplayWorkspaceError";
  }
}

/** Imports and restores one exact source post-workspace tree before its replay call commits. */
export class WorkflowReplayWorkspaceImporter {
  private readonly sourceRunDir: string;
  private readonly targetRunDir: string;

  constructor(
    sourceRunDir: string,
    private readonly source: WorkflowRunDatabaseReader,
    targetRunDir: string,
    private readonly target: WorkflowRunDatabase,
  ) {
    this.sourceRunDir = path.resolve(sourceRunDir);
    this.targetRunDir = path.resolve(targetRunDir);
  }

  async importAndRestore(input: {
    source: WorkflowWorkspaceCheckpointRecord;
    targetOperationId: string;
    target: WorkflowReplayWorkspaceTarget;
    createdAt: string;
  }): Promise<WorkflowImportedWorkspaceCheckpoint> {
    const sourceRun = this.source.readRun();
    const targetRun = this.target.readRun();
    const workspace = this.target.readCandidateWorkspace(input.target.workspaceId);
    const operation = this.target.readOperation(input.targetOperationId);
    if (!workspace || workspace.runId !== targetRun.runId || workspace.state !== "mutable") {
      throw new WorkflowReplayWorkspaceError("Replay requires one mutable target candidate workspace");
    }
    if (!operation || operation.runId !== targetRun.runId) {
      throw new WorkflowReplayWorkspaceError("Replay target operation is unavailable");
    }
    let operationScope = this.target.readScope(operation.scopeId);
    let insideWorkspace = false;
    while (operationScope) {
      if (operationScope.scopeId === workspace.bodyScopeId) {
        insideWorkspace = true;
        break;
      }
      operationScope = operationScope.parentScopeId
        ? this.target.readScope(operationScope.parentScopeId)
        : undefined;
    }
    if (!insideWorkspace) {
      throw new WorkflowReplayWorkspaceError("Replay operation is outside its target candidate workspace scope");
    }
    if (input.source.runId !== sourceRun.runId
      || input.source.storagePath !== `workspaces/checkpoints/${input.source.checkpointId}`) {
      throw new WorkflowReplayWorkspaceError("Source replay checkpoint identity is invalid");
    }
    if (!input.source.writeScopeHash
      || input.source.writeScopeHash !== workspace.writeScopeHash) {
      throw new WorkflowReplayWorkspaceError("Replay checkpoint write scope differs from the target workspace");
    }
    assertHash(input.target.lineageHash, "target replay workspace lineage");
    if (input.target.expectedPreTreeHash) {
      assertHash(input.target.expectedPreTreeHash, "target replay pre-tree");
    }

    const sourceRoot = contained(this.sourceRunDir, input.source.storagePath);
    const sourceTree = await scanCandidateTree(sourceRoot);
    if (sourceTree.treeHash !== input.source.treeHash) {
      throw new WorkflowReplayWorkspaceError("Source replay checkpoint tree is corrupt");
    }
    const targetRoot = contained(this.targetRunDir, workspace.rootPath);
    const current = await scanCandidateTree(targetRoot);
    if (input.target.expectedPreTreeHash
      && current.treeHash !== input.target.expectedPreTreeHash
      && current.treeHash !== sourceTree.treeHash) {
      throw new WorkflowReplayWorkspaceError("Target candidate changed before replay restoration");
    }

    const checkpointId = `checkpoint_${stableHash({
      formatVersion: 1,
      runId: targetRun.runId,
      operationId: operation.operationId,
      workspaceId: workspace.workspaceId,
      treeHash: sourceTree.treeHash,
      lineageHash: input.target.lineageHash,
      writeScopeHash: workspace.writeScopeHash,
      sourceCallCheckpointId: input.source.checkpointId,
    }).slice(7, 39)}`;
    const storagePath = `workspaces/checkpoints/${checkpointId}`;
    const checkpointRoot = contained(this.targetRunDir, storagePath);
    await this.publishCheckpoint(sourceRoot, checkpointRoot, sourceTree.treeHash);
    const restored = current.treeHash !== sourceTree.treeHash;
    if (restored) await replaceTree(checkpointRoot, targetRoot, sourceTree.treeHash);
    if ((await scanCandidateTree(targetRoot)).treeHash !== sourceTree.treeHash) {
      throw new WorkflowReplayWorkspaceError("Target replay workspace restoration failed verification");
    }
    return {
      record: {
        checkpointId,
        runId: targetRun.runId,
        operationId: operation.operationId,
        workspaceId: workspace.workspaceId,
        treeHash: sourceTree.treeHash,
        lineageHash: input.target.lineageHash,
        writeScopeHash: workspace.writeScopeHash,
        storagePath,
        createdAt: input.createdAt,
      },
      restored,
    };
  }

  private async publishCheckpoint(
    sourceRoot: string,
    finalRoot: string,
    treeHash: string,
  ): Promise<void> {
    const parent = path.dirname(finalRoot);
    await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = path.join(parent, `.checkpoint-${crypto.randomUUID()}.tmp`);
    try {
      const imported = await cloneCandidateTree(sourceRoot, temporary, { durable: true });
      if (imported.treeHash !== treeHash) {
        throw new WorkflowReplayWorkspaceError("Imported checkpoint differs from its source");
      }
      try {
        await fs.promises.rename(temporary, finalRoot);
        await syncDirectory(parent);
      } catch (error: unknown) {
        if (!new Set(["EEXIST", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) {
          throw error;
        }
        await removeTree(temporary);
        if ((await scanCandidateTree(finalRoot)).treeHash !== treeHash) {
          throw new WorkflowReplayWorkspaceError("Replay checkpoint path collided with another tree");
        }
      }
    } catch (error) {
      await removeTree(temporary).catch(() => undefined);
      throw error;
    }
  }
}

async function replaceTree(source: string, target: string, treeHash: string): Promise<void> {
  const parent = path.dirname(target);
  const temporary = path.join(parent, `.replay-${crypto.randomUUID()}.tmp`);
  const backup = path.join(parent, `.replay-${crypto.randomUUID()}.old`);
  await cloneCandidateTree(source, temporary, { durable: true });
  let moved = false;
  try {
    await fs.promises.rename(target, backup);
    moved = true;
    await fs.promises.rename(temporary, target);
    await syncDirectory(parent);
    await removeTree(backup);
  } catch (error) {
    await removeTree(temporary).catch(() => undefined);
    if (moved) {
      try {
        await fs.promises.lstat(target);
      } catch (targetError: unknown) {
        if ((targetError as NodeJS.ErrnoException).code === "ENOENT") {
          await fs.promises.rename(backup, target).catch(() => undefined);
        }
      }
    }
    throw error;
  }
  if ((await scanCandidateTree(target)).treeHash !== treeHash) {
    throw new WorkflowReplayWorkspaceError("Restored replay tree differs from its checkpoint");
  }
}

function contained(rootInput: string, relative: string): string {
  if (path.isAbsolute(relative)) throw new WorkflowReplayWorkspaceError("Replay storage path must be relative");
  const root = path.resolve(rootInput);
  const target = path.resolve(root, relative);
  const difference = path.relative(root, target);
  if (!difference || difference === ".." || difference.startsWith(`..${path.sep}`)
    || path.isAbsolute(difference)) {
    throw new WorkflowReplayWorkspaceError("Replay storage path escapes its run");
  }
  return target;
}

function assertHash(value: string, label: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`Invalid ${label} hash`);
  }
}

async function removeTree(target: string): Promise<void> {
  await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 3 });
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
