import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactStore } from "../artifacts/store.js";
import { scanCandidateTree, type CandidateTreeEntry, type CandidateTreeManifest } from "../candidates/tree.js";
import type {
  ApplyPathImage,
  ApplyPathPlan,
  ApplyPlanRecord,
  ApplyReceiptRecord,
  ApprovalRecord,
  ArtifactRef,
  CandidateRecord,
  VerificationRecord,
} from "../runtime/durable-types.js";
import { RunDatabase } from "../persistence/run-database.js";
import type { JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import {
  assertProjectSnapshotManifest,
  scanProjectSource,
  type ProjectSnapshotEntry,
  type ProjectSnapshotManifest,
  type ProjectSourceState,
} from "../workspaces/project-snapshot.js";

export type ApplyFaultPoint = "before-mutation" | "after-path-mutation" | "after-mutation-before-receipt";

export interface VerifiedApplyServiceOptions {
  now?: () => Date;
  faultInjector?: (point: ApplyFaultPoint, path?: string) => void | Promise<void>;
}

export interface PrepareApplyOptions {
  operationId: string;
  candidateId: string;
  verificationId: string;
  /** Current host resolution; a changed profile or tool environment requires verification again. */
  verificationProfileHash: string;
  gateEnvironmentHash: string;
  createdAt?: string;
}

export interface ExecuteApplyOptions {
  planId: string;
  verificationProfileHash: string;
  gateEnvironmentHash: string;
  signal?: AbortSignal;
  startedAt?: string;
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

interface ApplyInspection {
  state: ProjectSourceState;
  classification: "preimage" | "postimage" | "mixed" | "conflict";
  conflictPaths: string[];
  observedPostimageHash: string;
}

export class ApplyStaleError extends Error {
  constructor(message: string) { super(message); this.name = "ApplyStaleError"; }
}

export class ApplyConflictError extends Error {
  constructor(readonly paths: string[]) {
    super(`Live project conflicts with the verified apply plan: ${paths.slice(0, 16).join(", ")}`);
    this.name = "ApplyConflictError";
  }
}

/** Exact, human-approved, crash-recoverable live-project apply. */
export class VerifiedApplyService {
  readonly runDir: string;
  readonly runId: string;
  readonly artifacts: ArtifactStore;
  private readonly now: () => Date;
  private readonly faultInjector?: VerifiedApplyServiceOptions["faultInjector"];

  constructor(runDirInput: string, readonly database: RunDatabase, options: VerifiedApplyServiceOptions = {}) {
    this.runDir = path.resolve(runDirInput);
    if (path.resolve(database.databasePath) !== path.join(this.runDir, "run.sqlite")) {
      throw new Error("Apply service and run database do not match");
    }
    this.runId = database.readRun().runId;
    this.now = options.now ?? (() => new Date());
    this.faultInjector = options.faultInjector;
    this.artifacts = new ArtifactStore(this.runDir, database, { now: this.now });
  }

  async prepare(options: PrepareApplyOptions): Promise<{ plan: ApplyPlanRecord; approval: ApprovalRecord }> {
    const operation = this.database.readOperation(options.operationId);
    if (!operation || operation.runId !== this.runId || operation.kind !== "apply" || operation.status !== "running") {
      throw new Error(`Apply operation ${options.operationId} is not running`);
    }
    const candidate = this.requiredCandidate(options.candidateId);
    if (candidate.changedPaths.length === 0) throw new Error("Apply rejects an empty candidate delta");
    const verification = this.requiredFreshVerification(options, candidate);
    const project = await this.readProjectManifest();
    const live = await scanProjectSource(project.sourceRoot);
    if (live.treeHash !== verification.liveProjectTreeHash) {
      throw new ApplyStaleError("Live project drifted after verification; rerun affected gates");
    }
    const candidateRoot = this.candidateRoot(candidate);
    if ((await scanCandidateTree(candidateRoot)).treeHash !== candidate.workspace.treeHash) {
      throw new ApplyStaleError("Candidate changed after verification");
    }
    const frozen = await this.readCandidateManifest(candidate);
    const paths = await this.buildPathPlans(candidate, frozen.tree, project, candidateRoot);
    if (paths.map((entry) => entry.path).join("\0") !== candidate.changedPaths.join("\0")) {
      throw new Error("Apply plan differs from the verified candidate delta");
    }
    if ((await scanCandidateTree(candidateRoot)).treeHash !== candidate.workspace.treeHash) {
      throw new ApplyStaleError("Candidate changed while the apply plan was captured");
    }
    const unrelatedLiveHash = unrelatedHash(live, new Set(candidate.changedPaths));
    const planId = `apply_plan_${stableHash({
      runId: this.runId,
      operationId: operation.operationId,
      candidateId: candidate.candidateId,
      candidateTreeHash: candidate.workspace.treeHash,
      verificationId: verification.verificationId,
      liveProjectTreeHash: live.treeHash,
      unrelatedLiveHash,
      paths: paths.map(pathIdentity),
    }).slice(7, 39)}`;
    const existing = this.database.readApplyPlan(planId);
    if (existing) {
      const approval = this.database.readApproval(existing.approvalId);
      if (!approval) throw new Error("Apply plan approval is missing");
      return { plan: existing, approval };
    }
    const createdAt = iso(options.createdAt ?? this.now().toISOString());
    const bindingHash = stableHash({
      planId,
      candidateId: candidate.candidateId,
      candidateTreeHash: candidate.workspace.treeHash,
      candidateLineageHash: candidate.workspace.lineageHash,
      candidateWriteScopeHash: candidate.workspace.writeScopeHash,
      verificationId: verification.verificationId,
      verificationProfileHash: verification.profileHash,
      gateEnvironmentHash: verification.gateEnvironmentHash,
      projectSnapshotHash: project.treeHash,
      liveProjectTreeHash: live.treeHash,
      unrelatedLiveHash,
      paths: paths.map(pathIdentity),
    });
    const manifestValue = {
      formatVersion: 1 as const,
      planId,
      runId: this.runId,
      operationId: operation.operationId,
      bindingHash,
      candidateId: candidate.candidateId,
      verificationId: verification.verificationId,
      liveProjectTreeHash: live.treeHash,
      unrelatedLiveHash,
      changedPaths: candidate.changedPaths,
      paths,
      createdAt,
    };
    const manifest = await this.artifacts.putJson({
      expectedRevision: this.database.readRun().revision,
      kind: "apply-plan",
      value: manifestValue as unknown as JsonValue,
      metadata: { planId },
      createdAt,
    });
    const challengedRevision = this.database.readRun().revision;
    const challengeBody = {
      kind: "apply" as const,
      runId: this.runId,
      operationId: operation.operationId,
      planId,
      bindingHash,
      manifestDigest: manifest.artifact.digest,
      candidateId: candidate.candidateId,
      candidateTreeHash: candidate.workspace.treeHash,
      candidateLineageHash: candidate.workspace.lineageHash!,
      candidateWriteScopeHash: candidate.workspace.writeScopeHash!,
      verificationId: verification.verificationId,
      verificationProfileHash: verification.profileHash,
      gateEnvironmentHash: verification.gateEnvironmentHash,
      liveProjectTreeHash: live.treeHash,
      unrelatedLiveHash,
      changedPaths: candidate.changedPaths,
      challengedRevision,
    };
    const challengeHash = stableHash(challengeBody);
    const approvalId = `approval_${stableHash({ planId, challengeHash }).slice(7, 39)}`;
    const plan: ApplyPlanRecord = {
      planId,
      runId: this.runId,
      operationId: operation.operationId,
      candidateId: candidate.candidateId,
      candidateTreeHash: candidate.workspace.treeHash,
      candidateLineageHash: candidate.workspace.lineageHash!,
      candidateWriteScopeHash: candidate.workspace.writeScopeHash!,
      verificationId: verification.verificationId,
      verificationProfileHash: verification.profileHash,
      gateEnvironmentHash: verification.gateEnvironmentHash,
      projectSnapshotHash: project.treeHash,
      liveProjectTreeHash: live.treeHash,
      unrelatedLiveHash,
      bindingHash,
      manifest: manifest.artifact,
      approvalId,
      challengeHash,
      paths,
      createdAt,
    };
    const approval: ApprovalRecord = {
      approvalId,
      runId: this.runId,
      operationId: operation.operationId,
      kind: "apply",
      status: "waiting",
      challenge: {
        challengeHash,
        runRevision: challengedRevision,
        bindingHash,
        summary: manifest.artifact,
      },
      requestedAt: createdAt,
    };
    return this.database.createApplyApproval(this.database.readRun().revision, plan, approval, {
      type: "apply-approval-requested",
      operationId: operation.operationId,
      payload: { planId, approvalId, challengeHash },
      at: createdAt,
    });
  }

  async apply(options: ExecuteApplyOptions): Promise<ApplyReceiptRecord> {
    const plan = this.database.readApplyPlan(options.planId);
    if (!plan || plan.runId !== this.runId) throw new Error(`Unknown apply plan ${options.planId}`);
    const project = await this.readProjectManifest();
    return await withProjectApplyLock(project.sourceRoot, async () => {
      const existing = this.database.readApplyReceipt(plan.planId);
      if (existing) {
        const inspection = await this.inspect(plan, project.sourceRoot);
        if (inspection.classification !== "postimage") throw new ApplyConflictError(inspection.conflictPaths);
        return existing;
      }
      const approval = this.database.readApproval(plan.approvalId);
      if (!approval || approval.status !== "completed" || approval.decision !== "approved"
        || approval.challenge.challengeHash !== plan.challengeHash || approval.challenge.bindingHash !== plan.bindingHash) {
        throw new Error("Apply requires the exact completed human approval");
      }
      const verification = this.database.readVerification(plan.verificationId);
      if (!verification || verification.status !== "passed") throw new ApplyStaleError("Passed verification is unavailable");
      if (options.verificationProfileHash !== plan.verificationProfileHash
        || options.gateEnvironmentHash !== plan.gateEnvironmentHash
        || verification.profileHash !== plan.verificationProfileHash
        || verification.gateEnvironmentHash !== plan.gateEnvironmentHash) {
        throw new ApplyStaleError("Verification profile or required tool environment changed; rerun affected gates");
      }
      let inspection = await this.inspect(plan, project.sourceRoot);
      if (unrelatedHash(inspection.state, new Set(plan.paths.map((entry) => entry.path))) !== plan.unrelatedLiveHash) {
        throw new ApplyStaleError("Unrelated live-project drift changed after verification; rerun affected gates");
      }
      if (inspection.classification === "conflict") throw new ApplyConflictError(inspection.conflictPaths);
      const startedAt = iso(options.startedAt ?? this.now().toISOString());
      const recovered = inspection.classification !== "preimage";
      if (inspection.classification !== "postimage") {
        await this.fault("before-mutation");
        await this.mutate(plan, project.sourceRoot, options.signal);
        await this.fault("after-mutation-before-receipt");
        inspection = await this.inspect(plan, project.sourceRoot);
        if (inspection.classification !== "postimage") throw new ApplyConflictError(inspection.conflictPaths);
      }
      const completedAt = iso(this.now().toISOString());
      const mutationId = `mutation_${stableHash({ planId: plan.planId, challengeHash: plan.challengeHash }).slice(7, 39)}`;
      const receipt: ApplyReceiptRecord = {
        receiptId: `apply_receipt_${stableHash({ planId: plan.planId, challengeHash: plan.challengeHash }).slice(7, 39)}`,
        runId: this.runId,
        operationId: plan.operationId,
        planId: plan.planId,
        approvalId: plan.approvalId,
        challengeHash: plan.challengeHash,
        candidateId: plan.candidateId,
        verificationId: plan.verificationId,
        mutationId,
        changedPaths: plan.paths.map((entry) => entry.path),
        reconciled: recovered,
        observedPostimageHash: inspection.observedPostimageHash,
        startedAt,
        completedAt,
      };
      return this.database.commitApplyReceipt(this.database.readRun().revision, receipt, {
        type: "apply-receipt-recorded",
        operationId: plan.operationId,
        payload: { planId: plan.planId, receiptId: receipt.receiptId, reconciled: recovered },
        at: completedAt,
      });
    });
  }

  private requiredFreshVerification(options: PrepareApplyOptions, candidate: CandidateRecord): VerificationRecord {
    const verification = this.database.readVerification(options.verificationId);
    if (!verification || verification.runId !== this.runId || verification.status !== "passed") {
      throw new ApplyStaleError("Apply requires passed verification");
    }
    if (
      verification.candidateId !== candidate.candidateId
      || verification.candidateTreeHash !== candidate.workspace.treeHash
      || verification.candidateLineageHash !== candidate.workspace.lineageHash
      || verification.candidateWriteScopeHash !== candidate.workspace.writeScopeHash
    ) throw new ApplyStaleError("Verification is stale for this candidate");
    if (verification.profileHash !== options.verificationProfileHash
      || verification.gateEnvironmentHash !== options.gateEnvironmentHash) {
      throw new ApplyStaleError("Verification profile or required tool environment changed; rerun affected gates");
    }
    return verification;
  }

  private async buildPathPlans(
    candidate: CandidateRecord,
    candidateTree: CandidateTreeManifest,
    project: ProjectSnapshotManifest,
    candidateRoot: string,
  ): Promise<ApplyPathPlan[]> {
    const before = new Map(project.entries.map((entry) => [entry.path, projectImage(entry)]));
    const after = new Map(candidateTree.entries.map((entry) => [entry.path, candidateImage(entry)]));
    const result: ApplyPathPlan[] = [];
    for (const candidatePath of candidate.changedPaths) {
      const preimage = before.get(candidatePath) ?? { type: "absent" as const };
      const postimage = after.get(candidatePath) ?? { type: "absent" as const };
      let content: ArtifactRef | undefined;
      if (postimage.type === "file") content = await this.ensurePostimageArtifact(path.join(candidateRoot, candidatePath), postimage);
      result.push({ path: candidatePath, preimage, postimage, ...(content ? { content } : {}) });
    }
    return result.sort((left, right) => comparePath(left.path, right.path));
  }

  private async ensurePostimageArtifact(filePath: string, image: Extract<ApplyPathImage, { type: "file" }>): Promise<ArtifactRef> {
    const existing = this.database.readArtifact(image.digest);
    if (existing) {
      const stored = await this.artifacts.read(image.digest);
      if (stored.artifact.bytes !== image.bytes) throw new Error("Apply postimage artifact has the wrong size");
      return stored.artifact;
    }
    const stored = await this.artifacts.putFile({
      expectedRevision: this.database.readRun().revision,
      kind: "apply-postimage",
      filePath,
      metadata: {},
      createdAt: this.now().toISOString(),
      maximumBytes: image.bytes || 1,
    });
    if (stored.artifact.digest !== image.digest || stored.artifact.bytes !== image.bytes) {
      throw new ApplyStaleError("Candidate file changed while apply content was captured");
    }
    return stored.artifact;
  }

  private async inspect(plan: ApplyPlanRecord, sourceRoot: string): Promise<ApplyInspection> {
    const state = await scanProjectSource(sourceRoot);
    const observed = new Map(state.entries.map((entry) => [entry.path, projectImage(entry)]));
    const conflicts: string[] = [];
    let pre = 0;
    let post = 0;
    for (const entry of plan.paths) {
      const image = observed.get(entry.path) ?? { type: "absent" as const };
      const isPre = sameImage(image, entry.preimage);
      const isPost = sameImage(image, entry.postimage);
      if (!isPre && !isPost) conflicts.push(entry.path);
      if (isPre) pre++;
      if (isPost) post++;
    }
    const classification: ApplyInspection["classification"] = conflicts.length
      ? "conflict"
      : post === plan.paths.length
        ? "postimage"
        : pre === plan.paths.length
          ? "preimage"
          : "mixed";
    return {
      state,
      classification,
      conflictPaths: conflicts,
      observedPostimageHash: stableHash(plan.paths.map((entry) => ({ path: entry.path, postimage: entry.postimage }))),
    };
  }

  private async mutate(plan: ApplyPlanRecord, sourceRoot: string, signal: AbortSignal | undefined): Promise<void> {
    const removals = plan.paths
      .filter((entry) => entry.postimage.type === "absent" || entry.preimage.type !== entry.postimage.type)
      .sort((left, right) => depth(right.path) - depth(left.path) || comparePath(right.path, left.path));
    for (const entry of removals) {
      checkAbort(signal);
      const observed = await observePath(sourceRoot, entry.path);
      if (sameImage(observed, entry.postimage)) continue;
      if (!sameImage(observed, entry.preimage)) throw new ApplyConflictError([entry.path]);
      await removePath(sourceRoot, entry.path, observed);
      await this.fault("after-path-mutation", entry.path);
    }

    const directories = plan.paths
      .filter((entry) => entry.postimage.type === "directory")
      .sort((left, right) => depth(left.path) - depth(right.path) || comparePath(left.path, right.path));
    for (const entry of directories) {
      checkAbort(signal);
      const postimage = entry.postimage as Extract<ApplyPathImage, { type: "directory" }>;
      const observed = await observePath(sourceRoot, entry.path);
      if (sameImage(observed, postimage)) continue;
      if (!sameImage(observed, entry.preimage) && observed.type !== "absent") throw new ApplyConflictError([entry.path]);
      await assertSafeParents(sourceRoot, entry.path);
      if (observed.type === "absent") await fs.promises.mkdir(path.join(sourceRoot, entry.path), { mode: postimage.mode });
      await fs.promises.chmod(path.join(sourceRoot, entry.path), postimage.mode);
      await syncDirectory(path.dirname(path.join(sourceRoot, entry.path)));
      await this.fault("after-path-mutation", entry.path);
    }

    const leaves = plan.paths
      .filter((entry) => entry.postimage.type === "file" || entry.postimage.type === "symlink")
      .sort((left, right) => depth(left.path) - depth(right.path) || comparePath(left.path, right.path));
    for (const entry of leaves) {
      checkAbort(signal);
      const observed = await observePath(sourceRoot, entry.path);
      if (sameImage(observed, entry.postimage)) continue;
      if (!sameImage(observed, entry.preimage) && observed.type !== "absent") throw new ApplyConflictError([entry.path]);
      await assertSafeParents(sourceRoot, entry.path);
      if (entry.postimage.type === "file") await this.installFile(sourceRoot, entry);
      else if (entry.postimage.type === "symlink") await this.installSymlink(sourceRoot, entry.path, entry.postimage.target);
      else throw new Error("Apply leaf plan changed during execution");
      await this.fault("after-path-mutation", entry.path);
    }
  }

  private async installFile(sourceRoot: string, entry: ApplyPathPlan): Promise<void> {
    if (entry.postimage.type !== "file" || !entry.content) throw new Error("Apply file plan is incomplete");
    const stored = await this.artifacts.read(entry.content.digest);
    if (stored.artifact.digest !== entry.postimage.digest || stored.artifact.bytes !== entry.postimage.bytes) {
      throw new Error("Apply postimage artifact differs from the plan");
    }
    const target = path.join(sourceRoot, entry.path);
    const staging = path.join(this.runDir, "outputs", "apply-stage");
    await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 });
    const temporary = path.join(staging, `${crypto.randomUUID()}.tmp`);
    const input = await fs.promises.open(stored.bodyPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const output = await fs.promises.open(temporary, "wx", entry.postimage.mode);
    try {
      const hash = crypto.createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let bytes = 0;
      while (true) {
        const read = await input.read(buffer, 0, buffer.length, null);
        if (!read.bytesRead) break;
        const chunk = buffer.subarray(0, read.bytesRead);
        hash.update(chunk); bytes += read.bytesRead; await output.write(chunk);
      }
      if (bytes !== entry.postimage.bytes || `sha256:${hash.digest("hex")}` !== entry.postimage.digest) {
        throw new Error("Apply postimage artifact failed its digest check");
      }
      await output.chmod(entry.postimage.mode);
      await output.sync();
    } finally {
      await input.close(); await output.close();
    }
    try {
      await fs.promises.rename(temporary, target);
      await syncDirectory(path.dirname(target));
    } catch (error) {
      await fs.promises.rm(temporary, { force: true });
      throw error;
    }
  }

  private async installSymlink(sourceRoot: string, relative: string, linkTarget: string): Promise<void> {
    const target = contained(sourceRoot, relative);
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), linkTarget));
    if (!linkTarget || path.posix.isAbsolute(linkTarget) || resolved === ".." || resolved.startsWith("../")) {
      throw new Error(`Unsafe apply symlink ${relative}`);
    }
    const staging = path.join(this.runDir, "outputs", "apply-stage");
    await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 });
    const temporary = path.join(staging, `${crypto.randomUUID()}.tmp`);
    await fs.promises.symlink(linkTarget, temporary);
    try { await fs.promises.rename(temporary, target); await syncDirectory(path.dirname(target)); }
    catch (error) { await fs.promises.rm(temporary, { force: true }); throw error; }
  }

  private requiredCandidate(candidateId: string): CandidateRecord {
    const candidate = this.database.readCandidate(candidateId);
    if (!candidate || candidate.runId !== this.runId) throw new Error(`Unknown candidate ${candidateId}`);
    return candidate;
  }

  private candidateRoot(candidate: CandidateRecord): string {
    const workspace = this.database.readCandidateWorkspace(candidate.workspace.workspaceId);
    if (!workspace || workspace.runId !== this.runId
      || workspace.rootPath !== `workspaces/candidates/${workspace.workspaceId}/project`) {
      throw new Error("Candidate workspace authority is missing");
    }
    return contained(this.runDir, workspace.rootPath);
  }

  private async readCandidateManifest(candidate: CandidateRecord): Promise<FrozenCandidateManifest> {
    const stored = await this.artifacts.read(candidate.manifest.digest);
    const value = JSON.parse(await fs.promises.readFile(stored.bodyPath, "utf8")) as FrozenCandidateManifest;
    if (value.formatVersion !== 1 || value.candidateId !== candidate.candidateId || value.runId !== candidate.runId
      || value.workspaceId !== candidate.workspace.workspaceId || value.tree.treeHash !== candidate.workspace.treeHash
      || value.lineageHash !== candidate.workspace.lineageHash || value.writeScopeHash !== candidate.workspace.writeScopeHash
      || stableJson(value.changedPaths) !== stableJson(candidate.changedPaths)) {
      throw new Error("Candidate manifest differs from SQLite authority");
    }
    return value;
  }

  private async readProjectManifest(): Promise<ProjectSnapshotManifest> {
    const source = await fs.promises.readFile(path.join(this.runDir, "context", "project-manifest.json"), "utf8");
    const value = JSON.parse(source) as ProjectSnapshotManifest;
    if (source !== `${stableJson(value)}\n`) throw new Error("Project manifest is not canonical");
    assertProjectSnapshotManifest(value);
    if (this.database.readRun().projectSnapshotHash !== value.treeHash) throw new Error("Run project snapshot binding is stale");
    return value;
  }

  private async fault(point: ApplyFaultPoint, changedPath?: string): Promise<void> {
    await this.faultInjector?.(point, changedPath);
  }
}

function projectImage(entry: ProjectSnapshotEntry): ApplyPathImage {
  if (entry.type === "file") return { type: "file", mode: entry.mode, bytes: entry.bytes, digest: entry.digest };
  if (entry.type === "symlink") return { type: "symlink", mode: entry.mode, target: entry.target };
  return { type: "directory", mode: entry.mode };
}

function candidateImage(entry: CandidateTreeEntry): ApplyPathImage {
  if (entry.type === "file") return { type: "file", mode: entry.mode, bytes: entry.bytes, digest: entry.digest };
  if (entry.type === "symlink") return { type: "symlink", mode: entry.mode, target: entry.target };
  return { type: "directory", mode: entry.mode };
}

function pathIdentity(entry: ApplyPathPlan) {
  return { path: entry.path, preimage: entry.preimage, postimage: entry.postimage, contentDigest: entry.content?.digest ?? null };
}

function unrelatedHash(state: ProjectSourceState, changedPaths: ReadonlySet<string>): string {
  return stableHash({
    rootMode: state.rootMode,
    entries: state.entries
      .filter((entry) => !changedPaths.has(entry.path))
      .map((entry) => ({ path: entry.path, image: projectImage(entry) })),
  });
}

async function observePath(root: string, relative: string): Promise<ApplyPathImage> {
  const target = contained(root, relative);
  let stat: fs.Stats;
  try { stat = await fs.promises.lstat(target); }
  catch (error: any) { if (error?.code === "ENOENT") return { type: "absent" }; throw error; }
  const mode = stat.mode & 0o777;
  if (stat.isDirectory() && !stat.isSymbolicLink()) return { type: "directory", mode };
  if (stat.isSymbolicLink()) return { type: "symlink", mode, target: await fs.promises.readlink(target) };
  if (!stat.isFile()) throw new ApplyConflictError([relative]);
  const handle = await fs.promises.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead; hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new ApplyConflictError([relative]);
    return { type: "file", mode, bytes, digest: `sha256:${hash.digest("hex")}` };
  } finally { await handle.close(); }
}

async function removePath(root: string, relative: string, image: ApplyPathImage): Promise<void> {
  const target = contained(root, relative);
  await assertSafeParents(root, relative);
  if (image.type === "directory") await fs.promises.rmdir(target);
  else if (image.type !== "absent") await fs.promises.unlink(target);
  await syncDirectory(path.dirname(target));
}

async function assertSafeParents(rootInput: string, relative: string): Promise<void> {
  const root = path.resolve(rootInput);
  const parts = relative.split("/").slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fs.promises.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ApplyConflictError([relative]);
  }
}

async function withProjectApplyLock<T>(sourceRoot: string, body: () => Promise<T>): Promise<T> {
  const lock = path.join(os.tmpdir(), `pi-workflow-apply-${stableHash(path.resolve(sourceRoot)).slice(7, 39)}.lock`);
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await fs.promises.mkdir(lock, { mode: 0o700 });
      await fs.promises.writeFile(path.join(lock, "pid"), `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const pid = Number.parseInt(await fs.promises.readFile(path.join(lock, "pid"), "utf8").catch(() => "0"), 10);
      if (!processAlive(pid)) { await fs.promises.rm(lock, { recursive: true, force: true }); continue; }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the live-project apply lock");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try { return await body(); }
  finally { await fs.promises.rm(lock, { recursive: true, force: true }); }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error: any) { return error?.code === "EPERM"; }
}

function sameImage(left: ApplyPathImage, right: ApplyPathImage): boolean { return stableJson(left) === stableJson(right); }
function depth(value: string): number { return value.split("/").length; }
function comparePath(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function checkAbort(signal: AbortSignal | undefined): void { if (signal?.aborted) throw signal.reason ?? new Error("Apply cancelled"); }
function iso(value: string): string { const date = new Date(value); if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error("Invalid apply timestamp"); return value; }
function contained(rootInput: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Unsafe apply path");
  const root = path.resolve(rootInput); const target = path.resolve(root, relative); const rel = path.relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("Apply path escapes its root");
  return target;
}
async function syncDirectory(directory: string): Promise<void> { const handle = await fs.promises.open(directory, "r"); try { await handle.sync(); } finally { await handle.close(); } }

export type ApplyApprovalChallenge = ApprovalRecord["challenge"];
export type ApplyReceipt = ApplyReceiptRecord;
export type ApplyBundleRecord = ApplyPlanRecord;
export type { ApplyReceiptRecord } from "../runtime/durable-types.js";
