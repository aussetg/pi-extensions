import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  CandidateWorkspaceManager,
  CandidateWriteScopeError,
  type CandidateWorkspaceCapability,
} from "../src/candidates/store.js";
import { RunDatabase } from "../src/persistence/run-database.js";
import type { OperationRecord, RunRecord } from "../src/runtime/durable-types.js";
import { captureProjectSnapshot } from "../src/workspaces/project-snapshot.js";
import { sha256 } from "../src/utils/hashes.js";
import { stableJson } from "../src/utils/stable-json.js";
import {
  buildWorkflowCallKey,
  WORKFLOW_JOURNAL_ROOT_KEY,
} from "../src/persistence/workflow-journal.js";

const roots: string[] = [];
const NOW = "2026-04-09T12:00:00.000Z";

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await makeWritable(root);
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

describe("Btrfs candidate workspaces and checkpoints", () => {
  it("clones every visible launch path and freezes edits, additions, deletions, modes, symlinks, and deterministic diff evidence", async () => {
    const fixture = await candidateFixture("candidate-tree-");
    const capability = await fixture.manager.create({
      logicalId: "run/candidate:edit",
      writeScope: "all-semantic-project-paths",
      createdAt: NOW,
    });
    const workspace = await fixture.manager.describe(capability);

    expect(await fs.promises.readFile(path.join(workspace.root, "ignored.log"), "utf8")).toBe("launch ignored content\n");
    expect(await fs.promises.readFile(path.join(workspace.root, "untracked.txt"), "utf8")).toBe("launch untracked content\n");
    await fs.promises.writeFile(path.join(workspace.root, "src", "edit.txt"), "edited\n");
    await fs.promises.writeFile(path.join(workspace.root, "added.txt"), "added\n");
    await fs.promises.rm(path.join(workspace.root, "delete.txt"));
    await fs.promises.chmod(path.join(workspace.root, "script.sh"), 0o755);
    await fs.promises.symlink("edit.txt", path.join(workspace.root, "src", "edit-link"));
    await fs.promises.writeFile(path.join(workspace.root, "ignored.log"), "changed although ignored by Git\n");
    await fs.promises.mkdir(path.join(workspace.root, "build"));
    await fs.promises.writeFile(path.join(workspace.root, "build", "new-cache.bin"), "admitted new content\n");

    const candidate = await fixture.manager.freeze({ workspace: capability, frozenAt: later(1) });
    expect(candidate.changedPaths).toEqual([
      "added.txt",
      "build",
      "build/new-cache.bin",
      "delete.txt",
      "ignored.log",
      "script.sh",
      "src/edit-link",
      "src/edit.txt",
    ]);
    expect(candidate.workspace).toMatchObject({
      kind: "candidate",
      workspaceId: workspace.ref.workspaceId,
      treeHash: expect.stringMatching(/^sha256:/),
      lineageHash: expect.stringMatching(/^sha256:/),
      writeScopeHash: expect.stringMatching(/^sha256:/),
    });
    expect(fixture.database.readCandidate(candidate.candidateId)).toEqual(candidate);

    const diff = await fixture.manager.artifacts.read(candidate.diff.digest);
    const diffValue = JSON.parse(await fs.promises.readFile(diff.bodyPath, "utf8"));
    expect(diffValue).toMatchObject({
      formatVersion: 1,
      candidateId: candidate.candidateId,
      treeHash: candidate.workspace.treeHash,
    });
    expect(diffValue.changes.map((change: { kind: string; path: string }) => `${change.kind}:${change.path}`)).toEqual([
      "add:added.txt",
      "add:build",
      "add:build/new-cache.bin",
      "delete:delete.txt",
      "modify:ignored.log",
      "mode:script.sh",
      "add:src/edit-link",
      "modify:src/edit.txt",
    ]);

    const extents = spawnSync("filefrag", ["-v", fixture.largeLaunchFile, path.join(workspace.root, "large.bin")], { encoding: "utf8" });
    expect(extents.status, extents.stderr).toBe(0);
    expect(extents.stdout).toMatch(/shared/);
    fixture.database.close();
  });

  it("enforces fixed scopes and rejects symlinks that could escape toward the live project", async () => {
    const fixture = await candidateFixture("candidate-scope-");
    const scoped = await fixture.manager.create({
      logicalId: "run/candidate:scoped",
      writeScope: { allow: ["src/"], deny: ["src/blocked.txt"] },
      createdAt: NOW,
    });
    const scopedRoot = (await fixture.manager.describe(scoped)).root;
    await fs.promises.writeFile(path.join(scopedRoot, "outside.txt"), "escape\n");
    await expect(fixture.manager.freeze({ workspace: scoped, frozenAt: later(1) })).rejects.toBeInstanceOf(CandidateWriteScopeError);

    const unsafe = await fixture.manager.create({
      logicalId: "run/candidate:unsafe-link",
      createdAt: NOW,
    });
    const unsafeRoot = (await fixture.manager.describe(unsafe)).root;
    await fs.promises.symlink("../../live-project/secret", path.join(unsafeRoot, "src", "escape"));
    await expect(fixture.manager.freeze({ workspace: unsafe, frozenAt: later(2) })).rejects.toThrow(/symlink escapes|unsafe/i);

    const substituted = await fixture.manager.create({ logicalId: "run/candidate:substituted", createdAt: NOW });
    const substitutedRoot = (await fixture.manager.describe(substituted)).root;
    await fs.promises.rm(substitutedRoot, { recursive: true });
    await fs.promises.symlink(fixture.project, substitutedRoot);
    await expect(fixture.manager.bubblewrapBind(substituted)).rejects.toThrow(/symlink/i);

    const safe = await fixture.manager.create({ logicalId: "run/candidate:sandbox", createdAt: NOW });
    const bind = await fixture.manager.bubblewrapBind(safe);
    expect(bind).toEqual(["--bind", (await fixture.manager.describe(safe)).root, "/workspace"]);
    const sandbox = runBwrap(bind, `test ! -e ${shellQuote(fixture.project)} && test -e /workspace/src/edit.txt`);
    expect(sandbox.status, sandbox.stderr).toBe(0);
    fixture.database.close();
  });

  it("creates descendants with exact parent lineage and independent mutable trees", async () => {
    const fixture = await candidateFixture("candidate-lineage-");
    const parentCapability = await fixture.manager.create({
      logicalId: "run/candidate:parent",
      writeScope: { allow: ["src/"] },
      createdAt: NOW,
    });
    const parentRoot = (await fixture.manager.describe(parentCapability)).root;
    await fs.promises.writeFile(path.join(parentRoot, "src", "edit.txt"), "parent\n");
    const parent = await fixture.manager.freeze({ workspace: parentCapability, frozenAt: later(1) });

    const childCapability = await fixture.manager.create({
      logicalId: "run/candidate:child",
      parentCandidateId: parent.candidateId,
      writeScope: { allow: ["src/"] },
      createdAt: later(2),
    });
    const childHandle = await fixture.manager.describe(childCapability);
    expect(await fs.promises.readFile(path.join(childHandle.root, "src", "edit.txt"), "utf8")).toBe("parent\n");
    expect(childHandle.ref.lineageHash).not.toBe(parent.workspace.lineageHash);
    expect(childHandle.ref.writeScopeHash).toBe(parent.workspace.writeScopeHash);
    await fs.promises.writeFile(path.join(childHandle.root, "src", "child.txt"), "child\n");
    const child = await fixture.manager.freeze({ workspace: childCapability, frozenAt: later(3) });
    expect(child.parentCandidateId).toBe(parent.candidateId);
    expect(child.changedPaths).toEqual(["src/child.txt", "src/edit.txt"]);
    expect(await fs.promises.readFile(path.join(parentRoot, "src", "edit.txt"), "utf8")).toBe("parent\n");
    await expect(fs.promises.lstat(path.join(parentRoot, "src", "child.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    fixture.database.close();
  });

  it("detects mutation during checkpoint capture and removes a pre-commit orphan on recovery", async () => {
    const fixture = await candidateFixture("candidate-checkpoint-race-");
    const capability = await fixture.manager.create({ logicalId: "run/candidate:race", createdAt: NOW });
    const handle = await fixture.manager.describe(capability);
    const operation = insertAgentOperation(fixture.database, "operation_race", 0);
    let changed = false;
    const racing = await CandidateWorkspaceManager.open(fixture.runDir, fixture.database, {
      faultInjector: async (point) => {
        if (point === "checkpoint-cloned" && !changed) {
          changed = true;
          await fs.promises.writeFile(path.join(handle.root, "src", "edit.txt"), "changed after clone\n");
        }
      },
    });
    const reopenedCapability = await racing.openWorkspace(handle.ref.workspaceId);
    await expect(racing.prepareCheckpoint({ operationId: operation.operationId, workspace: reopenedCapability, createdAt: later(2) }))
      .rejects.toThrow(/changed while/i);
    expect((await fs.promises.readdir(path.join(fixture.runDir, "workspaces", "checkpoints"))).filter((name) => CHECKPOINT.test(name))).toHaveLength(0);

    const clean = await fixture.manager.prepareCheckpoint({ operationId: operation.operationId, workspace: capability, createdAt: later(3) });
    expect(await fs.promises.readFile(path.join(fixture.runDir, clean.record.storagePath, "src", "edit.txt"), "utf8")).toBe("changed after clone\n");
    expect(await fixture.manager.reconcile()).toEqual({ removed: 1, retained: 0 });
    await expect(fs.promises.lstat(path.join(fixture.runDir, clean.record.storagePath))).rejects.toMatchObject({ code: "ENOENT" });
    fixture.database.close();
  });

  it("atomically binds mutating completion to a restorable checkpoint and never returns a cached result without it", async () => {
    const fixture = await candidateFixture("candidate-replay-");
    const capability = await fixture.manager.create({ logicalId: "run/candidate:replay", createdAt: NOW });
    const handle = await fixture.manager.describe(capability);
    await fs.promises.writeFile(path.join(handle.root, "src", "edit.txt"), "committed post-state\n");
    await fs.promises.writeFile(path.join(handle.root, "post.txt"), "durable\n");
    const operation = insertAgentOperation(fixture.database, "operation_replay", 0);
    const completed = await complete(fixture.manager, fixture.database, operation, capability, later(2));
    const journal = fixture.database.readWorkflowCall(operation.operationId)!;
    expect(journal.postWorkspaceCheckpointId).toMatch(CHECKPOINT);
    const checkpoint = fixture.database.readWorkspaceCheckpoint(journal.postWorkspaceCheckpointId!)!;
    expect(checkpoint).toMatchObject({
      workspace: completed.result!.workspace,
    });
    const checkpointExtents = spawnSync("filefrag", [
      "-v",
      path.join(handle.root, "large.bin"),
      path.join(fixture.runDir, checkpoint.storagePath, "large.bin"),
    ], { encoding: "utf8" });
    expect(checkpointExtents.status, checkpointExtents.stderr).toBe(0);
    expect(checkpointExtents.stdout).toMatch(/shared/);

    await fs.promises.writeFile(path.join(handle.root, "src", "edit.txt"), "wrong live candidate\n");
    await fs.promises.rm(path.join(handle.root, "post.txt"));
    const restored = await fixture.manager.restoreForReplay(operation.operationId, capability);
    expect(restored.restored).toBe(true);
    expect(await fs.promises.readFile(path.join(handle.root, "src", "edit.txt"), "utf8")).toBe("committed post-state\n");
    expect(await fs.promises.readFile(path.join(handle.root, "post.txt"), "utf8")).toBe("durable\n");
    expect((await fixture.manager.restoreForReplay(operation.operationId, capability)).restored).toBe(false);

    const uncheckpointed = insertAgentOperation(fixture.database, "operation_uncheckpointed", 1);
    await expect(async () => fixture.database.completeOperation({
      expectedRevision: fixture.database.readRun().revision,
      operationId: uncheckpointed.operationId,
      completedAt: later(4),
      result: { artifacts: [], workspace: completed.result!.workspace },
      usage: zeroUsage(),
      event: { type: "operation-completed", payload: {} },
    })).rejects.toThrow(/requires.*checkpoint/i);
    expect(fixture.database.readOperation(uncheckpointed.operationId)?.status).toBe("running");
    fixture.database.close();
  });

  it("recovers after a coordinator crash during restore without touching the launch or live project", async () => {
    const fixture = await candidateFixture("candidate-crash-recovery-");
    const capability = await fixture.manager.create({ logicalId: "run/candidate:crash", createdAt: NOW });
    const handle = await fixture.manager.describe(capability);
    await fs.promises.writeFile(path.join(handle.root, "src", "edit.txt"), "checkpoint value\n");
    const operation = insertAgentOperation(fixture.database, "operation_crash", 0);
    await complete(fixture.manager, fixture.database, operation, capability, later(2));
    await fs.promises.writeFile(path.join(handle.root, "src", "edit.txt"), "contaminated\n");

    let crashed = false;
    const crashing = await CandidateWorkspaceManager.open(fixture.runDir, fixture.database, {
      faultInjector: (point) => {
        if (!crashed && point === "restore-backed-up") { crashed = true; throw new Error("coordinator power cut"); }
      },
    });
    const crashCapability = await crashing.openWorkspace(handle.ref.workspaceId);
    await expect(crashing.restoreForReplay(operation.operationId, crashCapability)).rejects.toThrow("power cut");
    await expect(fs.promises.lstat(handle.root)).rejects.toMatchObject({ code: "ENOENT" });

    const recovered = await CandidateWorkspaceManager.open(fixture.runDir, fixture.database);
    const recoveredCapability = await recovered.openWorkspace(handle.ref.workspaceId);
    expect((await recovered.restoreForReplay(operation.operationId, recoveredCapability)).restored).toBe(true);
    expect(await fs.promises.readFile(path.join(handle.root, "src", "edit.txt"), "utf8")).toBe("checkpoint value\n");
    expect((await recovered.reconcile()).removed).toBeGreaterThanOrEqual(1);
    expect(await fs.promises.readFile(path.join(fixture.runDir, "context", "project", "src", "edit.txt"), "utf8")).toBe("launch\n");
    expect(await fs.promises.readFile(path.join(fixture.project, "src", "edit.txt"), "utf8")).toBe("launch\n");
    fixture.database.close();
  });

  it("imports an explicit cross-run prefix checkpoint and binds it to current candidate authority", async () => {
    const sourceRunId = "flow_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const targetRunId = "flow_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const source = await candidateFixture("candidate-prefix-source-", { runId: sourceRunId });
    const sourceWorkspace = await source.manager.create({ logicalId: "run/candidate:shared", createdAt: NOW });
    const sourceHandle = await source.manager.describe(sourceWorkspace);
    await fs.promises.writeFile(path.join(sourceHandle.root, "src", "edit.txt"), "cross-run checkpoint\n");
    await fs.promises.writeFile(path.join(sourceHandle.root, "replayed.txt"), "restored\n");
    const sourceOperation = insertAgentOperation(source.database, "operation_candidate_prefix", 0);
    await complete(source.manager, source.database, sourceOperation, sourceWorkspace, later(2));
    const sourceCall = source.database.readWorkflowCall(sourceOperation.operationId)!;
    const sourceCheckpoint = source.database.readWorkspaceCheckpoint(sourceCall.postWorkspaceCheckpointId!)!;

    const target = await candidateFixture("candidate-prefix-target-", {
      runId: targetRunId,
      replaySourceRunId: sourceRunId,
    });
    const targetWorkspace = await target.manager.create({ logicalId: "run/candidate:shared", createdAt: NOW });
    const before = await target.manager.describe(targetWorkspace);
    expect(await fs.promises.readFile(path.join(before.root, "src", "edit.txt"), "utf8")).toBe("launch\n");
    const targetOperation = insertAgentOperation(target.database, "operation_candidate_prefix", 0);
    const imported = await target.manager.importCheckpointForReplay({
      sourceRunDir: source.runDir,
      source: sourceCheckpoint,
      operationId: targetOperation.operationId,
      workspace: targetWorkspace,
      expectedPreTreeHash: before.ref.treeHash,
      createdAt: later(3),
    });
    expect(imported.record.runId).toBe(targetRunId);
    expect(imported.record.workspace.workspaceId).toBe(before.ref.workspaceId);
    expect(imported.record.workspace.lineageHash).toBe(before.ref.lineageHash);
    expect(imported.record.workspace.treeHash).toBe(sourceCheckpoint.workspace.treeHash);
    expect(await fs.promises.readFile(path.join(before.root, "src", "edit.txt"), "utf8")).toBe("cross-run checkpoint\n");
    expect(await fs.promises.readFile(path.join(before.root, "replayed.txt"), "utf8")).toBe("restored\n");

    const result = { value: sourceCall.result.value, artifacts: [], workspace: imported.record.workspace };
    const completed = target.database.completeOperation({
      expectedRevision: target.database.readRun().revision,
      operationId: targetOperation.operationId,
      completedAt: later(3),
      result,
      usage: zeroUsage(),
      workspaceCheckpoint: imported.record,
      journal: {
        runId: targetRunId,
        operationId: targetOperation.operationId,
        ordinal: targetOperation.ordinal,
        previousJournalKey: sourceCall.previousJournalKey,
        semanticKey: sourceCall.semanticKey,
        callKey: sourceCall.callKey,
        completionAuthority: sourceCall.completionAuthority,
        replayPolicy: sourceCall.replayPolicy,
        result,
        postWorkspaceCheckpointId: imported.record.checkpointId,
        committedAt: later(3),
      },
      replay: {
        sourceRunId,
        sourceOperationId: sourceOperation.operationId,
        ordinal: sourceCall.ordinal,
        callKey: sourceCall.callKey,
        restoredWorkspaceCheckpointId: imported.record.checkpointId,
      },
      replayMatchedCalls: 1,
      event: { type: "operation-replayed", payload: {} },
    });
    expect(completed.replay).toMatchObject({
      sourceRunId,
      restoredWorkspaceCheckpointId: imported.record.checkpointId,
    });
    expect(target.database.readRun().replay?.matchedCalls).toBe(1);
    source.database.close();
    target.database.close();
  });
});

const CHECKPOINT = /^checkpoint_[a-f0-9]{32}$/;

async function candidateFixture(prefix: string, options: {
  runId?: string;
  replaySourceRunId?: string;
} = {}) {
  const root = await btrfsTemporary(prefix);
  const project = path.join(root, "live-project");
  const runId = options.runId ?? "flow_11111111111111111111111111111111";
  const runDir = path.join(root, runId);
  await fs.promises.mkdir(path.join(project, "src"), { recursive: true });
  await fs.promises.mkdir(path.join(runDir, "context"), { recursive: true });
  for (const directory of ["sessions", "workspaces/candidates", "workspaces/checkpoints", "workspaces/overlays", "artifacts", "outputs"]) {
    await fs.promises.mkdir(path.join(runDir, directory), { recursive: true });
  }
  await fs.promises.writeFile(path.join(project, "src", "edit.txt"), "launch\n");
  await fs.promises.writeFile(path.join(project, "delete.txt"), "delete\n");
  await fs.promises.writeFile(path.join(project, "script.sh"), "#!/bin/sh\n", { mode: 0o644 });
  await fs.promises.writeFile(path.join(project, ".gitignore"), "ignored.log\nbuild/\n");
  await fs.promises.writeFile(path.join(project, "ignored.log"), "launch ignored content\n");
  await fs.promises.writeFile(path.join(project, "untracked.txt"), "launch untracked content\n");
  const largeLaunchFile = path.join(project, "large.bin");
  await fs.promises.writeFile(largeLaunchFile, Buffer.alloc(2 * 1024 * 1024, 7));
  const manifest = await captureProjectSnapshot(project, project, path.join(runDir, "context", "project"));
  await fs.promises.writeFile(path.join(runDir, "context", "project-manifest.json"), `${stableJson(manifest)}\n`);
  const database = RunDatabase.create(path.join(runDir, "run.sqlite"), {
    run: runRecord(manifest.treeHash, runId, options.replaySourceRunId),
  });
  const manager = await CandidateWorkspaceManager.open(runDir, database);
  return { root, project, runDir, database, manager, largeLaunchFile };
}

function insertAgentOperation(database: RunDatabase, operationId: string, ordinal: number): OperationRecord {
  const at = later(ordinal + 1);
  const operation: OperationRecord = {
    operationId,
    runId: database.readRun().runId,
    path: `run/agent:${operationId}`,
    sourceId: operationId,
    kind: "agent",
    ordinal,
    status: "running",
    semanticInputHash: sha256(`input:${operationId}`),
    attemptCount: 0,
    createdAt: at,
    startedAt: at,
    updatedAt: at,
  };
  return database.insertOperation(database.readRun().revision, operation, {
    type: "operation-started",
    operationId,
    payload: {},
    at,
  });
}

async function complete(
  manager: CandidateWorkspaceManager,
  database: RunDatabase,
  operation: OperationRecord,
  workspace: CandidateWorkspaceCapability,
  completedAt: string,
): Promise<OperationRecord> {
  return await manager.completeMutatingOperation({
    expectedRevision: database.readRun().revision,
    operationId: operation.operationId,
    completedAt,
    workspace,
    result: { value: { finished: true }, artifacts: [] },
    usage: zeroUsage(),
    journal: {
      runId: database.readRun().runId,
      operationId: operation.operationId,
      ordinal: operation.ordinal,
      previousJournalKey: database.readLastWorkflowCall()?.callKey ?? WORKFLOW_JOURNAL_ROOT_KEY,
      semanticKey: sha256(`semantic:${operation.operationId}`),
      callKey: buildWorkflowCallKey({
        previousJournalKey: database.readLastWorkflowCall()?.callKey ?? WORKFLOW_JOURNAL_ROOT_KEY,
        operation,
        semanticKey: sha256(`semantic:${operation.operationId}`),
      }),
      completionAuthority: "finish-work",
      replayPolicy: "workspace",
      committedAt: completedAt,
    },
    event: { type: "operation-completed", payload: { checkpointed: true } },
  });
}

function runRecord(projectSnapshotHash: string, runId: string, replaySourceRunId?: string): RunRecord {
  return {
    runId,
    revision: 1,
    workflow: {
      id: "builtin:test",
      name: "test",
      sourceHash: sha256("source"),
      definitionHash: sha256("definition"),
      capabilities: ["read-project", "candidate-write"],
    },
    invocationHash: sha256("invocation"),
    projectSnapshotHash,
    routeSnapshotHash: sha256("routes"),
    contextIdentityHash: sha256("context"),
    status: "running",
    safety: {
      concurrency: 4,
      maximumAgentLaunches: 100,
      memoryBytes: 2 ** 30,
      tasks: 256,
      cpuQuotaPercent: 400,
      cpuWeight: 100,
      outputBytes: 64 * 1024 * 1024,
      commandTimeoutMs: 60_000,
    },
    usage: zeroUsage(),
    ...(replaySourceRunId ? {
      replay: {
        mode: "cross-revision-prefix",
        sourceRunId: replaySourceRunId,
        matchedCalls: 0,
        fresh: false,
      },
    } : {}),
    createdAt: NOW,
    startedAt: NOW,
    updatedAt: NOW,
  };
}

function zeroUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    providerRequests: 0,
    cost: 0,
    elapsedMs: 0,
    complete: true,
  };
}

function later(seconds: number): string { return new Date(Date.parse(NOW) + seconds * 1_000).toISOString(); }

async function btrfsTemporary(prefix: string): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(process.cwd(), `.phase9-${prefix}`));
  roots.push(root);
  const type = spawnSync("stat", ["-f", "-c", "%T", root], { encoding: "utf8" });
  if (type.status !== 0 || type.stdout.trim() !== "btrfs") throw new Error("Phase 9 tests require Btrfs");
  return root;
}

function runBwrap(projectArgs: string[], command: string) {
  return spawnSync("/usr/bin/bwrap", [
    "--tmpfs", "/",
    "--proc", "/proc",
    "--dev", "/dev",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    ...projectArgs,
    "--", "/bin/sh", "-c", command,
  ], { encoding: "utf8" });
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }

async function makeWritable(target: string): Promise<void> {
  let stat: fs.Stats;
  try { stat = await fs.promises.lstat(target); } catch { return; }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.promises.chmod(target, 0o700).catch(() => undefined);
    for (const name of await fs.promises.readdir(target)) await makeWritable(path.join(target, name));
  } else await fs.promises.chmod(target, 0o600).catch(() => undefined);
}
