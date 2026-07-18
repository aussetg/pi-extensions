import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFINITION_LIMITS, FLOW_NAME_PATTERN } from "../definition/limits.js";
import {
  projectRoot,
  projectWorkflowDir,
  userWorkflowDir,
  workflowDraftRoot,
} from "../persistence/paths.js";
import { readBoundedTextFile } from "../persistence/safe-paths.js";
import { sha256, sha256Hex, stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import {
  readWorkflowRegistryPolicy,
  workflowRegistryPolicyDocument,
  WORKFLOW_REGISTRY_POLICY_FILE,
  WORKFLOW_REGISTRY_PROMOTION_FILE,
  type WorkflowExposure,
} from "../registry/workflow-policy.js";
import type {
  WorkflowDraftId,
  WorkflowDraftNamespace,
  WorkflowDraftRevision,
  WorkflowDraftSummary,
} from "./types.js";

interface DraftHead {
  id: WorkflowDraftId;
  namespace: WorkflowDraftNamespace;
  name: string;
  projectRoot?: string;
  sourceHash: string;
}

interface WorkflowPromotionMarkerBody {
  namespace: WorkflowDraftNamespace;
  name: string;
  targetPath: string;
  draftHash: string;
  installedSourceHash: string | null;
  previousPolicyHash: string;
  nextPolicy: { model: string[] };
  nextPolicyHash: string;
  exposure: WorkflowExposure;
  reviewHash: string;
  challengeHash: string;
}

interface WorkflowPromotionMarker extends WorkflowPromotionMarkerBody {
  markerHash: string;
}

export interface WorkflowDraftStoreOptions {
  root?: string;
  userTargetDir?: string;
  projectTargetDir?: (project: string) => string;
  promotionFault?: (point: "after-marker" | "after-source" | "after-policy" | "after-commit") => void | Promise<void>;
}

export interface StageWorkflowDraftInput {
  namespace: WorkflowDraftNamespace;
  name: string;
  source: string;
  cwd: string;
}

export interface ReplaceWorkflowDraftInput extends StageWorkflowDraftInput {
  expectedSourceHash: string;
}

/**
 * Draft source is immutable and content-addressed. Only the tiny head file is
 * mutable, and every replacement is serialized and compare-and-swapped.
 */
export class WorkflowDraftStore {
  readonly root: string;
  private readonly userTargetDir?: string;
  private readonly projectTargetDir?: (project: string) => string;
  private readonly promotionFault?: WorkflowDraftStoreOptions["promotionFault"];

  constructor(options: WorkflowDraftStoreOptions = {}) {
    this.root = path.resolve(options.root ?? workflowDraftRoot());
    this.userTargetDir = options.userTargetDir;
    this.projectTargetDir = options.projectTargetDir;
    this.promotionFault = options.promotionFault;
  }

  async create(input: StageWorkflowDraftInput): Promise<WorkflowDraftRevision> {
    const normalized = await this.normalizeInput(input);
    return await this.withLock(this.lockPath(normalized), async () => {
      const existing = await this.readCurrent(normalized, false);
      if (existing) throw new Error(`Workflow draft ${normalized.namespace}:${normalized.name} already exists`);
      await this.writeRevisionAndHead(normalized);
      return await this.readCurrent(normalized, true) as WorkflowDraftRevision;
    });
  }

  async replace(input: ReplaceWorkflowDraftInput): Promise<WorkflowDraftRevision> {
    assertHash(input.expectedSourceHash, "expected draft source hash");
    const normalized = await this.normalizeInput(input);
    return await this.withLock(this.lockPath(normalized), async () => {
      const existing = await this.readCurrent(normalized, true) as WorkflowDraftRevision;
      if (existing.sourceHash !== input.expectedSourceHash) {
        throw new Error(`Workflow draft ${existing.id} changed (expected ${input.expectedSourceHash}, found ${existing.sourceHash})`);
      }
      await this.writeRevisionAndHead(normalized);
      return await this.readCurrent(normalized, true) as WorkflowDraftRevision;
    });
  }

  async inspect(namespace: WorkflowDraftNamespace, name: string, cwd: string): Promise<WorkflowDraftRevision> {
    const location = await this.location(namespace, name, cwd);
    return await this.readCurrent(location, true) as WorkflowDraftRevision;
  }

  async list(cwd: string, namespace?: WorkflowDraftNamespace): Promise<WorkflowDraftSummary[]> {
    const namespaces = namespace ? [namespace] : ["user", "project"] as const;
    const result: WorkflowDraftSummary[] = [];
    for (const candidate of namespaces) {
      const scope = await this.scopeDirectory(candidate, cwd);
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(scope, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (entries.length > DEFINITION_LIMITS.filesPerNamespace) {
        throw new Error(`Workflow draft scope exceeds ${DEFINITION_LIMITS.filesPerNamespace} entries`);
      }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !FLOW_NAME_PATTERN.test(entry.name)) continue;
        const draft = await this.readCurrent(await this.location(candidate, entry.name, cwd), false);
        if (!draft) continue;
        const { source: _source, ...summary } = draft;
        result.push(summary);
      }
    }
    return result.sort((left, right) => left.id.localeCompare(right.id));
  }

  async discard(
    namespace: WorkflowDraftNamespace,
    name: string,
    cwd: string,
    expectedSourceHash?: string,
  ): Promise<void> {
    if (expectedSourceHash !== undefined) assertHash(expectedSourceHash, "expected draft source hash");
    const location = await this.location(namespace, name, cwd);
    await this.withLock(this.lockPath(location), async () => {
      const current = await this.readCurrent(location, true) as WorkflowDraftRevision;
      if (expectedSourceHash !== undefined && current.sourceHash !== expectedSourceHash) {
        throw new Error(`Workflow draft ${current.id} changed before discard`);
      }
      await fs.promises.rm(location.directory, { recursive: true, force: false });
      await syncDirectory(path.dirname(location.directory));
    });
  }

  /**
   * Commit one TypeScript definition and exposure policy as a fail-closed registry transaction.
   * A durable marker makes the namespace undiscoverable between the two renames and permits exact
   * retry after a process crash.
   */
  async installAndConsume(input: {
    namespace: WorkflowDraftNamespace;
    name: string;
    cwd: string;
    expectedDraftHash: string;
    expectedInstalledSourceHash: string | null;
    expectedPolicyHash: string;
    exposure: WorkflowExposure;
    reviewHash: string;
    challengeHash: string;
  }): Promise<{ sourceHash: string; targetPath: string; exposure: WorkflowExposure; policyHash: string }> {
    assertHash(input.expectedDraftHash, "expected workflow draft hash");
    if (input.expectedInstalledSourceHash !== null) assertHash(input.expectedInstalledSourceHash, "installed workflow source hash");
    assertHash(input.expectedPolicyHash, "expected workflow policy hash");
    assertHash(input.reviewHash, "workflow promotion review hash");
    assertHash(input.challengeHash, "workflow promotion challenge hash");
    const location = await this.location(input.namespace, input.name, input.cwd);
    return await this.withLock(this.lockPath(location), async () => {
      const current = await this.readCurrent(location, true) as WorkflowDraftRevision;
      if (current.sourceHash !== input.expectedDraftHash) throw new Error(`Workflow draft ${current.id} changed before promotion`);
      const targetDirectory = path.dirname(current.targetPath);
      await fs.promises.mkdir(targetDirectory, { recursive: true, mode: 0o700 });
      await assertRegularDirectory(targetDirectory, "Workflow registry target");
      return await this.withLock(path.join(targetDirectory, ".registry-promotion.lock"), async () => {
        const recovered = await this.recoverPromotion(current, input);
        if (recovered) {
          await this.consumeInstalledDraft(location);
          return recovered;
        }
        const installed = await readInstalledHash(current.targetPath);
        if (installed !== input.expectedInstalledSourceHash) throw new Error(`Installed workflow ${current.id} changed before promotion`);
        const policy = await readWorkflowRegistryPolicy(targetDirectory, input.namespace, { ignorePendingPromotion: true });
        if (policy.hash !== input.expectedPolicyHash) throw new Error(`Workflow registry policy changed before promoting ${current.id}`);
        const nextPolicy = workflowRegistryPolicyDocument(policy, current.name, input.exposure);
        const nextPolicyHash = stableHash({ namespace: input.namespace, model: nextPolicy.model });
        const markerBody: WorkflowPromotionMarkerBody = {
          namespace: input.namespace,
          name: current.name,
          targetPath: current.targetPath,
          draftHash: current.sourceHash,
          installedSourceHash: installed,
          previousPolicyHash: policy.hash,
          nextPolicy,
          nextPolicyHash,
          exposure: input.exposure,
          reviewHash: input.reviewHash,
          challengeHash: input.challengeHash,
        };
        const marker: WorkflowPromotionMarker = { ...markerBody, markerHash: stableHash(markerBody) };
        const markerPath = path.join(targetDirectory, WORKFLOW_REGISTRY_PROMOTION_FILE);
        await atomicWrite(markerPath, `${stableJson(marker)}\n`, 0o600);
        await this.promotionFault?.("after-marker");
        await atomicInstall(current.targetPath, current.source);
        await this.promotionFault?.("after-source");
        await atomicWrite(path.join(targetDirectory, WORKFLOW_REGISTRY_POLICY_FILE), `${stableJson(nextPolicy)}\n`, 0o600);
        await this.promotionFault?.("after-policy");
        await fs.promises.rm(markerPath);
        await syncDirectory(targetDirectory);
        await this.promotionFault?.("after-commit");
        await this.consumeInstalledDraft(location);
        return { sourceHash: current.sourceHash, targetPath: current.targetPath, exposure: input.exposure, policyHash: nextPolicyHash };
      });
    });
  }

  /** Resume only the exact already-challenged transaction left by a process crash. */
  async resumePromotion(input: {
    namespace: WorkflowDraftNamespace;
    name: string;
    cwd: string;
    challengeHash: string;
    exposure: WorkflowExposure;
  }): Promise<{ sourceHash: string; targetPath: string; exposure: WorkflowExposure; policyHash: string; reviewHash: string } | undefined> {
    assertHash(input.challengeHash, "workflow promotion challenge hash");
    const location = await this.location(input.namespace, input.name, input.cwd);
    return await this.withLock(this.lockPath(location), async () => {
      const current = await this.readCurrent(location, true) as WorkflowDraftRevision;
      const targetDirectory = path.dirname(current.targetPath);
      return await this.withLock(path.join(targetDirectory, ".registry-promotion.lock"), async () => {
        const marker = await readPromotionMarker(path.join(targetDirectory, WORKFLOW_REGISTRY_PROMOTION_FILE));
        if (!marker) return undefined;
        if (marker.challengeHash !== input.challengeHash || marker.exposure !== input.exposure
          || marker.namespace !== input.namespace || marker.name !== input.name
          || marker.draftHash !== current.sourceHash) {
          throw new Error("Workflow promotion recovery challenge is stale");
        }
        const recovered = await this.recoverPromotion(current, {
          namespace: marker.namespace,
          name: marker.name,
          expectedDraftHash: marker.draftHash,
          expectedInstalledSourceHash: marker.installedSourceHash,
          expectedPolicyHash: marker.previousPolicyHash,
          exposure: marker.exposure,
          reviewHash: marker.reviewHash,
          challengeHash: marker.challengeHash,
        });
        if (!recovered) throw new Error("Workflow promotion marker disappeared during recovery");
        await this.consumeInstalledDraft(location);
        return { ...recovered, reviewHash: marker.reviewHash };
      });
    });
  }

  targetPath(namespace: WorkflowDraftNamespace, name: string, cwd: string): string {
    assertName(name);
    if (namespace === "user") return path.join(this.userTargetDir ?? userWorkflowDir(), `${name}.flow.ts`);
    const project = projectRoot(cwd);
    return path.join(this.projectTargetDir?.(project) ?? projectWorkflowDir(project), `${name}.flow.ts`);
  }

  /** Exact mutable head path used to join Pi's per-file mutation queue. */
  headPath(namespace: WorkflowDraftNamespace, name: string, cwd: string): string {
    assertNamespace(namespace);
    assertName(name);
    const scope = namespace === "user"
      ? path.join(this.root, "user")
      : path.join(this.root, "project", sha256Hex(path.resolve(projectRoot(cwd))));
    return path.join(scope, name, "head.json");
  }

  private async normalizeInput(input: StageWorkflowDraftInput): Promise<DraftLocation & { source: string; sourceHash: string }> {
    assertNamespace(input.namespace);
    assertName(input.name);
    assertSource(input.source);
    const location = await this.location(input.namespace, input.name, input.cwd);
    return { ...location, source: input.source, sourceHash: sha256(input.source) };
  }

  private async location(namespace: WorkflowDraftNamespace, name: string, cwd: string): Promise<DraftLocation> {
    assertNamespace(namespace);
    assertName(name);
    const project = namespace === "project" ? path.resolve(projectRoot(cwd)) : undefined;
    const scope = await this.scopeDirectory(namespace, cwd);
    const directory = path.join(scope, name);
    return {
      namespace,
      name,
      id: `${namespace}:${name}`,
      ...(project ? { projectRoot: project } : {}),
      directory,
      headPath: path.join(directory, "head.json"),
      revisionsDir: path.join(directory, "revisions"),
      targetPath: this.targetPath(namespace, name, cwd),
    };
  }

  private async scopeDirectory(namespace: WorkflowDraftNamespace, cwd: string): Promise<string> {
    if (namespace === "user") return path.join(this.root, "user");
    const project = path.resolve(projectRoot(cwd));
    return path.join(this.root, "project", sha256Hex(project));
  }

  private lockPath(location: Pick<DraftLocation, "directory">): string {
    return `${location.directory}.lock`;
  }

  private async readCurrent(location: DraftLocation, required: boolean): Promise<WorkflowDraftRevision | undefined> {
    let text: string;
    try {
      text = await readBoundedTextFile(location.headPath, 16 * 1024);
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (!required && /ENOENT|no such file/i.test(String((error as Error).message))) return undefined;
      throw error;
    }
    const head = parseHead(text, location);
    const sourcePath = revisionPath(location.revisionsDir, head.sourceHash);
    const source = await readBoundedTextFile(sourcePath, DEFINITION_LIMITS.sourceBytes);
    if (sha256(source) !== head.sourceHash) throw new Error(`Workflow draft revision ${head.sourceHash} is corrupt`);
    const revisionHashes = await listRevisionHashes(location.revisionsDir);
    if (!revisionHashes.includes(head.sourceHash)) throw new Error(`Workflow draft head ${head.sourceHash} has no immutable revision`);
    return {
      ...head,
      source,
      targetPath: location.targetPath,
      revisionHashes,
    };
  }

  private async writeRevisionAndHead(input: DraftLocation & { source: string; sourceHash: string }): Promise<void> {
    await fs.promises.mkdir(input.revisionsDir, { recursive: true, mode: 0o700 });
    const revisions = await listRevisionHashes(input.revisionsDir);
    if (!revisions.includes(input.sourceHash) && revisions.length >= DEFINITION_LIMITS.draftRevisions) {
      throw new Error(`Workflow draft ${input.id} exceeds ${DEFINITION_LIMITS.draftRevisions} revisions`);
    }
    const sourcePath = revisionPath(input.revisionsDir, input.sourceHash);
    try {
      const handle = await fs.promises.open(sourcePath, "wx", 0o400);
      try { await handle.writeFile(input.source, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await syncDirectory(input.revisionsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readBoundedTextFile(sourcePath, DEFINITION_LIMITS.sourceBytes);
      if (sha256(existing) !== input.sourceHash || existing !== input.source) {
        throw new Error(`Immutable workflow draft revision ${input.sourceHash} is corrupt`);
      }
    }
    const head: DraftHead = {
      id: input.id,
      namespace: input.namespace,
      name: input.name,
      ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
      sourceHash: input.sourceHash,
    };
    await atomicWrite(input.headPath, `${stableJson(head)}\n`, 0o600);
  }

  private async recoverPromotion(
    current: WorkflowDraftRevision,
    input: {
      namespace: WorkflowDraftNamespace;
      name: string;
      expectedDraftHash: string;
      expectedInstalledSourceHash: string | null;
      expectedPolicyHash: string;
      exposure: WorkflowExposure;
      reviewHash: string;
      challengeHash: string;
    },
  ): Promise<{ sourceHash: string; targetPath: string; exposure: WorkflowExposure; policyHash: string } | undefined> {
    const targetDirectory = path.dirname(current.targetPath);
    const markerPath = path.join(targetDirectory, WORKFLOW_REGISTRY_PROMOTION_FILE);
    const marker = await readPromotionMarker(markerPath);
    if (!marker) return undefined;
    if (marker.namespace !== input.namespace || marker.name !== input.name
      || marker.targetPath !== current.targetPath || marker.draftHash !== input.expectedDraftHash
      || marker.installedSourceHash !== input.expectedInstalledSourceHash
      || marker.previousPolicyHash !== input.expectedPolicyHash || marker.exposure !== input.exposure
      || marker.reviewHash !== input.reviewHash || marker.challengeHash !== input.challengeHash) {
      throw new Error("Another incomplete workflow promotion blocks this registry");
    }
    const installed = await readInstalledHash(current.targetPath);
    if (installed === marker.installedSourceHash) await atomicInstall(current.targetPath, current.source);
    else if (installed !== marker.draftHash) throw new Error("Workflow promotion source changed during recovery");
    const policy = await readWorkflowRegistryPolicy(targetDirectory, input.namespace, { ignorePendingPromotion: true });
    if (policy.hash === marker.previousPolicyHash) {
      await atomicWrite(
        path.join(targetDirectory, WORKFLOW_REGISTRY_POLICY_FILE),
        `${stableJson(marker.nextPolicy)}\n`,
        0o600,
      );
    } else if (policy.hash !== marker.nextPolicyHash) {
      throw new Error("Workflow promotion policy changed during recovery");
    }
    const finalPolicy = await readWorkflowRegistryPolicy(targetDirectory, input.namespace, { ignorePendingPromotion: true });
    if (finalPolicy.hash !== marker.nextPolicyHash) throw new Error("Workflow promotion recovery produced another policy");
    await fs.promises.rm(markerPath);
    await syncDirectory(targetDirectory);
    return {
      sourceHash: current.sourceHash,
      targetPath: current.targetPath,
      exposure: marker.exposure,
      policyHash: marker.nextPolicyHash,
    };
  }

  private async consumeInstalledDraft(location: DraftLocation): Promise<void> {
    await fs.promises.rm(location.directory, { recursive: true, force: false });
    await syncDirectory(path.dirname(location.directory));
  }

  private async withLock<T>(lockPath: string, body: () => Promise<T>): Promise<T> {
    await fs.promises.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.mkdir(lockPath, { mode: 0o700 });
        try {
          await fs.promises.writeFile(
            path.join(lockPath, "owner.json"),
            `${JSON.stringify({ pid: process.pid })}\n`,
            { flag: "wx", mode: 0o600 },
          );
        } catch (error) {
          await fs.promises.rm(lockPath, { recursive: true, force: true });
          throw error;
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 500) {
          throw new Error(`Could not acquire workflow draft lock ${lockPath}`, { cause: error });
        }
        await clearStaleLock(lockPath);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try { return await body(); }
    finally { await fs.promises.rm(lockPath, { recursive: true, force: true }); }
  }
}

async function clearStaleLock(lockPath: string): Promise<void> {
  try {
    const stat = await fs.promises.lstat(lockPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe workflow draft lock ${lockPath}`);
    let pid: number | undefined;
    try {
      const value = JSON.parse(await fs.promises.readFile(path.join(lockPath, "owner.json"), "utf8")) as { pid?: unknown };
      if (Number.isSafeInteger(value.pid) && (value.pid as number) > 0) pid = value.pid as number;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const ownerAlive = pid !== undefined && processAlive(pid);
    if (!ownerAlive && (pid !== undefined || Date.now() - stat.mtimeMs > 30_000)) {
      await fs.promises.rm(lockPath, { recursive: true, force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

interface DraftLocation {
  namespace: WorkflowDraftNamespace;
  name: string;
  id: WorkflowDraftId;
  projectRoot?: string;
  directory: string;
  headPath: string;
  revisionsDir: string;
  targetPath: string;
}

function parsePromotionMarker(source: string): WorkflowPromotionMarker {
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new Error("Workflow promotion marker is not JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Workflow promotion marker is invalid");
  }
  const marker = value as unknown as WorkflowPromotionMarker;
  const expected = [
    "namespace", "name", "targetPath", "draftHash", "installedSourceHash",
    "previousPolicyHash", "nextPolicy", "nextPolicyHash", "exposure", "reviewHash", "challengeHash", "markerHash",
  ].sort();
  if (Object.keys(value).sort().join("\0") !== expected.join("\0")) {
    throw new Error("Workflow promotion marker has unexpected fields");
  }
  assertNamespace(marker.namespace);
  assertName(marker.name);
  if (!path.isAbsolute(marker.targetPath)) throw new Error("Workflow promotion marker target is invalid");
  assertHash(marker.draftHash, "workflow promotion draft hash");
  if (marker.installedSourceHash !== null) assertHash(marker.installedSourceHash, "workflow promotion installed hash");
  assertHash(marker.previousPolicyHash, "workflow promotion previous policy hash");
  assertHash(marker.nextPolicyHash, "workflow promotion next policy hash");
  assertHash(marker.markerHash, "workflow promotion marker hash");
  assertHash(marker.reviewHash, "workflow promotion marker review hash");
  assertHash(marker.challengeHash, "workflow promotion marker challenge hash");
  if (marker.exposure !== "human" && marker.exposure !== "model") throw new Error("Workflow promotion marker exposure is invalid");
  if (!marker.nextPolicy || Object.keys(marker.nextPolicy).join(",") !== "model"
    || !Array.isArray(marker.nextPolicy.model)
    || marker.nextPolicy.model.some(name => typeof name !== "string" || !FLOW_NAME_PATTERN.test(name))) {
    throw new Error("Workflow promotion marker policy is invalid");
  }
  const { markerHash, ...body } = marker;
  if (stableHash(body) !== markerHash
    || stableHash({ namespace: marker.namespace, model: [...marker.nextPolicy.model].sort() }) !== marker.nextPolicyHash) {
    throw new Error("Workflow promotion marker hash is corrupt");
  }
  return marker;
}

async function readPromotionMarker(markerPath: string): Promise<WorkflowPromotionMarker | undefined> {
  try { return parsePromotionMarker(await readBoundedTextFile(markerPath, 128 * 1024)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseHead(text: string, location: DraftLocation): DraftHead {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error(`Workflow draft ${location.id} head is not JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Workflow draft ${location.id} head is invalid`);
  const record = value as Record<string, unknown>;
  const expected = new Set(["id", "namespace", "name", "sourceHash", ...(location.projectRoot ? ["projectRoot"] : [])]);
  if (Object.keys(record).length !== expected.size || Object.keys(record).some((key) => !expected.has(key))) {
    throw new Error(`Workflow draft ${location.id} head has unexpected fields`);
  }
  if (
    record.id !== location.id || record.namespace !== location.namespace ||
    record.name !== location.name || record.projectRoot !== location.projectRoot
  ) throw new Error(`Workflow draft ${location.id} head binding is invalid`);
  assertHash(record.sourceHash, "draft source hash");
  return record as unknown as DraftHead;
}

async function listRevisionHashes(directory: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (entries.length > DEFINITION_LIMITS.draftRevisions) throw new Error(`Workflow draft exceeds ${DEFINITION_LIMITS.draftRevisions} revisions`);
  return entries.map((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9]{64}\.flow\.ts$/.test(entry.name)) {
      throw new Error(`Unsafe workflow draft revision entry ${entry.name}`);
    }
    return `sha256:${entry.name.slice(0, 64)}`;
  }).sort();
}

function revisionPath(directory: string, hash: string): string {
  assertHash(hash, "draft revision hash");
  return path.join(directory, `${hash.slice(7)}.flow.ts`);
}

async function readInstalledHash(filePath: string): Promise<string | null> {
  try { return sha256(await readBoundedTextFile(filePath, DEFINITION_LIMITS.sourceBytes)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || /ENOENT|no such file/i.test(String((error as Error).message))) return null; throw error; }
}

async function atomicInstall(filePath: string, source: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await atomicWrite(filePath, source, 0o600);
}

async function atomicWrite(filePath: string, contents: string, mode: number): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await fs.promises.open(temporary, "wx", mode);
  try { await handle.writeFile(contents, "utf8"); await handle.sync(); }
  catch (error) { await handle.close().catch(() => undefined); await fs.promises.rm(temporary, { force: true }); throw error; }
  await handle.close();
  try { await fs.promises.rename(temporary, filePath); await syncDirectory(directory); }
  catch (error) { await fs.promises.rm(temporary, { force: true }); throw error; }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, fs.constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function assertRegularDirectory(directory: string, label: string): Promise<void> {
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink directory`);
}

function assertNamespace(value: unknown): asserts value is WorkflowDraftNamespace {
  if (value !== "user" && value !== "project") throw new Error("Workflow draft namespace must be user or project");
}

function assertName(value: string): void {
  if (!FLOW_NAME_PATTERN.test(value)) throw new Error("Workflow draft name must match ^[a-z][a-z0-9_-]{0,63}$");
}

function assertSource(value: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error("Workflow draft source must be a non-empty string");
  if (Buffer.byteLength(value) > DEFINITION_LIMITS.sourceBytes) throw new Error(`Workflow draft source exceeds ${DEFINITION_LIMITS.sourceBytes} bytes`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error("Workflow draft source contains disallowed control characters");
  }
  for (const scalar of value) {
    const point = scalar.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) throw new Error("Workflow draft source contains an unpaired surrogate");
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${label} is invalid`);
}
