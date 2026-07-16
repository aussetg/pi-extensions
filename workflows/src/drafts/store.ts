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
import { sha256, sha256Hex } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import type {
  WorkflowDraftId,
  WorkflowDraftNamespace,
  WorkflowDraftRevision,
  WorkflowDraftSummary,
} from "./types.js";

interface DraftHead {
  formatVersion: 1;
  id: WorkflowDraftId;
  namespace: WorkflowDraftNamespace;
  name: string;
  projectRoot?: string;
  sourceHash: string;
}

export interface WorkflowDraftStoreOptions {
  root?: string;
  userTargetDir?: string;
  projectTargetDir?: (project: string) => string;
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

  constructor(options: WorkflowDraftStoreOptions = {}) {
    this.root = path.resolve(options.root ?? workflowDraftRoot());
    this.userTargetDir = options.userTargetDir;
    this.projectTargetDir = options.projectTargetDir;
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

  /** Atomically replace the installed source after exact draft and preimage checks. */
  async installAndConsume(input: {
    namespace: WorkflowDraftNamespace;
    name: string;
    cwd: string;
    expectedDraftHash: string;
    expectedInstalledSourceHash: string | null;
  }): Promise<{ sourceHash: string; targetPath: string }> {
    assertHash(input.expectedDraftHash, "expected draft hash");
    if (input.expectedInstalledSourceHash !== null) assertHash(input.expectedInstalledSourceHash, "installed source hash");
    const location = await this.location(input.namespace, input.name, input.cwd);
    return await this.withLock(this.lockPath(location), async () => {
      const current = await this.readCurrent(location, true) as WorkflowDraftRevision;
      if (current.sourceHash !== input.expectedDraftHash) throw new Error(`Workflow draft ${current.id} changed before promotion`);
      const targetLock = `${current.targetPath}.promotion-lock`;
      return await this.withLock(targetLock, async () => {
        const installed = await readInstalledHash(current.targetPath);
        if (installed !== input.expectedInstalledSourceHash) {
          throw new Error(`Installed workflow ${current.id} changed before promotion`);
        }
        await atomicInstall(current.targetPath, current.source);
        await fs.promises.rm(location.directory, { recursive: true, force: false });
        await syncDirectory(path.dirname(location.directory));
        return { sourceHash: current.sourceHash, targetPath: current.targetPath };
      });
    });
  }

  targetPath(namespace: WorkflowDraftNamespace, name: string, cwd: string): string {
    assertName(name);
    if (namespace === "user") return path.join(this.userTargetDir ?? userWorkflowDir(), `${name}.flow.js`);
    const project = projectRoot(cwd);
    return path.join(this.projectTargetDir?.(project) ?? projectWorkflowDir(project), `${name}.flow.js`);
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
      formatVersion: 1,
      id: input.id,
      namespace: input.namespace,
      name: input.name,
      ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
      sourceHash: input.sourceHash,
    };
    await atomicWrite(input.headPath, `${stableJson(head)}\n`, 0o600);
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

function parseHead(text: string, location: DraftLocation): DraftHead {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error(`Workflow draft ${location.id} head is not JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Workflow draft ${location.id} head is invalid`);
  const record = value as Record<string, unknown>;
  const expected = new Set(["formatVersion", "id", "namespace", "name", "sourceHash", ...(location.projectRoot ? ["projectRoot"] : [])]);
  if (Object.keys(record).length !== expected.size || Object.keys(record).some((key) => !expected.has(key))) {
    throw new Error(`Workflow draft ${location.id} head has unexpected fields`);
  }
  if (
    record.formatVersion !== 1 || record.id !== location.id || record.namespace !== location.namespace ||
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
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9]{64}\.flow\.js$/.test(entry.name)) {
      throw new Error(`Unsafe workflow draft revision entry ${entry.name}`);
    }
    return `sha256:${entry.name.slice(0, 64)}`;
  }).sort();
}

function revisionPath(directory: string, hash: string): string {
  assertHash(hash, "draft revision hash");
  return path.join(directory, `${hash.slice(7)}.flow.js`);
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
