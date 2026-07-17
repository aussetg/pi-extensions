import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalJson,
  canonicalJsonObject,
  canonicalJsonValue,
  type CanonicalJsonLimits,
} from "../definition/canonical-json.js";
import type { WorkflowArtifactV17Record } from "../persistence/run-database-v17-types.js";
import {
  WorkflowRunDatabaseV17,
  WorkflowRunDatabaseV17RevisionConflictError,
  WorkflowRunDatabaseV17StateError,
} from "../persistence/run-database-v17.js";
import type { JsonObject, JsonValue } from "../types.js";
import { sha256 } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";

const MAX_REVISION_RETRIES = 16;
const DEFAULT_MAXIMUM_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAXIMUM_METADATA_BYTES = 64 * 1024;
const DIGEST = /^sha256:([a-f0-9]{64})$/u;

const BODY_LIMITS = {
  maxDepth: 64,
  maxNodes: 100_000,
  maxStringScalars: 4_000_000,
} as const;

const METADATA_LIMITS = {
  maxDepth: 24,
  maxNodes: 5_000,
  maxStringScalars: 32_000,
} as const;

export type WorkflowV17ArtifactStoreFaultPoint =
  | "after-body-sync"
  | "after-body-move"
  | "after-metadata"
  | "after-database-commit";

export interface WorkflowV17ArtifactStoreOptions {
  maximumArtifactBytes?: number;
  maximumMetadataBytes?: number;
  now?: () => Date;
  faultInjector?: (point: WorkflowV17ArtifactStoreFaultPoint) => void | Promise<void>;
}

interface PutCommon {
  kind: string;
  metadata?: JsonObject;
  maximumBytes?: number;
  createdAt?: string;
}

export interface PutWorkflowV17JsonArtifact extends PutCommon { value: JsonValue }
export interface PutWorkflowV17TextArtifact extends PutCommon { text: string }
export interface PutWorkflowV17BytesArtifact extends PutCommon { bytes: Uint8Array }
export interface PutWorkflowV17FileArtifact extends PutCommon { filePath: string }

export interface StoredWorkflowV17Artifact {
  record: WorkflowArtifactV17Record;
  bodyPath: string;
}

interface StagedBody {
  path: string;
  digest: string;
  bytes: number;
}

interface ArtifactMetadataV17 extends WorkflowArtifactV17Record {
  formatVersion: 1;
}

/** Content-addressed schema-4 artifact storage used by v17 product factories and replay. */
export class WorkflowV17ArtifactStore {
  readonly runDir: string;
  readonly root: string;
  readonly runId: string;
  private readonly maximumArtifactBytes: number;
  private readonly maximumMetadataBytes: number;
  private readonly now: () => Date;
  private readonly faultInjector?: WorkflowV17ArtifactStoreOptions["faultInjector"];

  constructor(
    runDirInput: string,
    readonly database: WorkflowRunDatabaseV17,
    options: WorkflowV17ArtifactStoreOptions = {},
  ) {
    this.runDir = path.resolve(runDirInput);
    if (path.resolve(database.databasePath) !== path.join(this.runDir, "run.sqlite")) {
      throw new Error("Workflow v17 artifact store and database directories differ");
    }
    this.root = path.join(this.runDir, "artifacts");
    const run = database.readRun();
    this.runId = run.runId;
    this.maximumArtifactBytes = Math.min(
      positiveInteger(options.maximumArtifactBytes ?? DEFAULT_MAXIMUM_BYTES, "maximum artifact bytes"),
      run.safety.outputBytes,
    );
    this.maximumMetadataBytes = positiveInteger(
      options.maximumMetadataBytes ?? DEFAULT_MAXIMUM_METADATA_BYTES,
      "maximum artifact metadata bytes",
    );
    this.now = options.now ?? (() => new Date());
    this.faultInjector = options.faultInjector;
  }

  async putJson(options: PutWorkflowV17JsonArtifact): Promise<StoredWorkflowV17Artifact> {
    const maximum = this.effectiveMaximum(options.maximumBytes);
    const body = Buffer.from(canonicalJson(options.value, { ...BODY_LIMITS, maxBytes: maximum }), "utf8");
    return await this.putBuffer(body, "application/json", options);
  }

  async putText(options: PutWorkflowV17TextArtifact): Promise<StoredWorkflowV17Artifact> {
    if (typeof options.text !== "string" || /[\ud800-\udfff]/u.test(options.text)) {
      throw new TypeError("Workflow v17 text artifact must contain valid Unicode");
    }
    return await this.putBuffer(Buffer.from(options.text, "utf8"), "text/plain; charset=utf-8", options);
  }

  async putBytes(options: PutWorkflowV17BytesArtifact): Promise<StoredWorkflowV17Artifact> {
    if (!(options.bytes instanceof Uint8Array)) throw new TypeError("Workflow v17 binary artifact requires bytes");
    return await this.putBuffer(Buffer.from(options.bytes), "application/octet-stream", options);
  }

  async putFile(options: PutWorkflowV17FileArtifact): Promise<StoredWorkflowV17Artifact> {
    const common = this.normalizeCommon(options);
    await this.ensureRoot();
    const staged = await this.stageFile(path.resolve(options.filePath), common.maximumBytes);
    try { return await this.commit(staged, "application/octet-stream", common); }
    finally { await fs.promises.rm(staged.path, { force: true }).catch(() => undefined); }
  }

  async read(value: string | WorkflowArtifactV17Record): Promise<StoredWorkflowV17Artifact> {
    const digest = typeof value === "string" ? value : value.digest;
    assertDigest(digest);
    const record = this.database.readArtifact(digest);
    if (!record) throw new WorkflowV17ArtifactStoreError(`Unknown workflow v17 artifact ${digest}`);
    if (typeof value !== "string" && !sameArtifact(value, record, true)) {
      throw new WorkflowV17ArtifactStoreError(`Workflow v17 artifact ${digest} changed identity`);
    }
    return await this.validate(record);
  }

  private async putBuffer(
    body: Buffer,
    mediaType: WorkflowArtifactV17Record["mediaType"],
    options: PutCommon,
  ): Promise<StoredWorkflowV17Artifact> {
    const common = this.normalizeCommon(options);
    if (body.length > common.maximumBytes) {
      throw new WorkflowV17ArtifactStoreError(`Workflow v17 artifact exceeds ${common.maximumBytes} bytes`);
    }
    await this.ensureRoot();
    const temporary = path.join(this.root, `.body-${crypto.randomUUID()}.tmp`);
    const handle = await fs.promises.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.fault("after-body-sync");
    try { return await this.commit({ path: temporary, digest: sha256(body), bytes: body.length }, mediaType, common); }
    finally { await fs.promises.rm(temporary, { force: true }).catch(() => undefined); }
  }

  private async stageFile(sourcePath: string, maximumBytes: number): Promise<StagedBody> {
    const before = await fs.promises.lstat(sourcePath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) {
      throw new WorkflowV17ArtifactStoreError("Workflow v17 artifact source is unsafe or too large");
    }
    const source = await fs.promises.open(
      sourcePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const temporary = path.join(this.root, `.body-${crypto.randomUUID()}.tmp`);
    let output: fs.promises.FileHandle | undefined;
    try {
      const opened = await source.stat();
      output = await fs.promises.open(temporary, "wx", 0o600);
      const hash = crypto.createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let bytes = 0;
      while (true) {
        const chunk = await source.read(buffer, 0, buffer.length, null);
        if (chunk.bytesRead === 0) break;
        bytes += chunk.bytesRead;
        if (bytes > maximumBytes) throw new WorkflowV17ArtifactStoreError("Workflow v17 artifact source is too large");
        hash.update(buffer.subarray(0, chunk.bytesRead));
        await output.write(buffer.subarray(0, chunk.bytesRead));
      }
      const after = await source.stat();
      if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || bytes !== opened.size) {
        throw new WorkflowV17ArtifactStoreError("Workflow v17 artifact source changed while copied");
      }
      await output.sync();
      await output.close();
      output = undefined;
      await this.fault("after-body-sync");
      return { path: temporary, digest: `sha256:${hash.digest("hex")}`, bytes };
    } catch (error) {
      await output?.close().catch(() => undefined);
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await source.close();
    }
  }

  private async commit(
    staged: StagedBody,
    mediaType: WorkflowArtifactV17Record["mediaType"],
    common: ReturnType<WorkflowV17ArtifactStore["normalizeCommon"]>,
  ): Promise<StoredWorkflowV17Artifact> {
    let proposed: WorkflowArtifactV17Record = {
      digest: staged.digest,
      runId: this.runId,
      kind: common.kind,
      mediaType,
      bytes: staged.bytes,
      bodyPath: relativeBodyPath(staged.digest),
      metadata: common.metadata,
      createdAt: common.createdAt,
    };
    const existing = this.database.readArtifact(staged.digest);
    if (existing) {
      await fs.promises.rm(staged.path, { force: true });
      assertSameArtifact(existing, proposed, false);
      return await this.validate(existing);
    }

    proposed = await this.install(staged, proposed);
    await this.fault("after-metadata");
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      const raced = this.database.readArtifact(proposed.digest);
      if (raced) {
        assertSameArtifact(raced, proposed, true);
        return await this.validate(raced);
      }
      try {
        const record = this.database.insertArtifact(this.database.readRun().revision, proposed);
        await this.fault("after-database-commit");
        return await this.validate(record);
      } catch (error) {
        if (error instanceof WorkflowRunDatabaseV17RevisionConflictError) continue;
        if (error instanceof WorkflowRunDatabaseV17StateError) {
          const after = this.database.readArtifact(proposed.digest);
          if (after) {
            assertSameArtifact(after, proposed, true);
            return await this.validate(after);
          }
        }
        throw error;
      }
    }
    throw new WorkflowV17ArtifactStoreError(`Could not admit workflow v17 artifact ${proposed.digest}`);
  }

  private async install(
    staged: StagedBody,
    proposed: WorkflowArtifactV17Record,
  ): Promise<WorkflowArtifactV17Record> {
    const directory = path.join(this.root, digestHex(staged.digest));
    const bodyPath = path.join(directory, "body");
    let created = false;
    try {
      await fs.promises.mkdir(directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await ensureRealDirectory(directory);
    }
    if (created) {
      await fs.promises.rename(staged.path, bodyPath);
      await fs.promises.chmod(bodyPath, 0o400);
      await syncDirectory(directory);
      await syncDirectory(this.root);
      await this.fault("after-body-move");
    } else {
      await fs.promises.rm(staged.path, { force: true });
      await validateBody(bodyPath, staged.digest, staged.bytes);
    }

    const metadataPath = path.join(directory, "metadata.json");
    const prior = await readOptionalMetadata(metadataPath, this.maximumMetadataBytes);
    if (prior) {
      const record = stripFormat(prior);
      assertSameArtifact(record, proposed, false);
      return record;
    }
    const metadata: ArtifactMetadataV17 = { formatVersion: 1, ...proposed };
    const text = canonicalJson(metadata as unknown as JsonValue, {
      ...METADATA_LIMITS,
      maxBytes: this.maximumMetadataBytes + 4_096,
    });
    const temporary = path.join(directory, `.metadata-${crypto.randomUUID()}.tmp`);
    const handle = await fs.promises.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.promises.link(temporary, metadataPath);
      await fs.promises.chmod(metadataPath, 0o400);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await readMetadata(metadataPath, this.maximumMetadataBytes);
      const record = stripFormat(raced);
      assertSameArtifact(record, proposed, false);
      return record;
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
    await syncDirectory(directory);
    return proposed;
  }

  private async validate(record: WorkflowArtifactV17Record): Promise<StoredWorkflowV17Artifact> {
    if (record.runId !== this.runId || record.bodyPath !== relativeBodyPath(record.digest)) {
      throw new WorkflowV17ArtifactStoreError(`Workflow v17 artifact ${record.digest} has invalid run identity`);
    }
    await ensureRealDirectory(this.root);
    const directory = path.join(this.root, digestHex(record.digest));
    await ensureRealDirectory(directory);
    const metadata = stripFormat(await readMetadata(path.join(directory, "metadata.json"), this.maximumMetadataBytes));
    if (!sameArtifact(metadata, record, true)) {
      throw new WorkflowV17ArtifactStoreError(`Workflow v17 artifact ${record.digest} metadata differs from SQLite`);
    }
    const bodyPath = path.join(directory, "body");
    await validateBody(bodyPath, record.digest, record.bytes);
    return { record: structuredClone(record), bodyPath };
  }

  private normalizeCommon(value: PutCommon): {
    kind: string;
    metadata: JsonObject;
    maximumBytes: number;
    createdAt: string;
  } {
    if (typeof value.kind !== "string" || !value.kind.trim() || value.kind.length > 128
      || /[\u0000-\u001f\u007f]/u.test(value.kind)) {
      throw new TypeError("Workflow v17 artifact kind is invalid");
    }
    const metadataLimits: CanonicalJsonLimits = {
      ...METADATA_LIMITS,
      maxBytes: this.maximumMetadataBytes,
    };
    const metadata = canonicalJsonObject(value.metadata ?? {}, metadataLimits);
    const createdAt = value.createdAt ?? this.now().toISOString();
    if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
      throw new TypeError("Workflow v17 artifact time is invalid");
    }
    return {
      kind: value.kind,
      metadata,
      maximumBytes: this.effectiveMaximum(value.maximumBytes),
      createdAt,
    };
  }

  private effectiveMaximum(value: number | undefined): number {
    return Math.min(
      value === undefined ? this.maximumArtifactBytes : positiveInteger(value, "artifact maximum bytes"),
      this.maximumArtifactBytes,
    );
  }

  private async ensureRoot(): Promise<void> {
    await ensureRealDirectory(this.runDir);
    try { await fs.promises.mkdir(this.root, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await ensureRealDirectory(this.root);
  }

  private async fault(point: WorkflowV17ArtifactStoreFaultPoint): Promise<void> {
    await this.faultInjector?.(point);
  }
}

export class WorkflowV17ArtifactStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowV17ArtifactStoreError";
  }
}

async function validateBody(filePath: string, digest: string, bytes: number): Promise<void> {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes) {
    throw new WorkflowV17ArtifactStoreError(`Workflow v17 artifact body ${digest} is unsafe`);
  }
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const body = await handle.readFile();
    if (body.length !== bytes || sha256(body) !== digest) {
      throw new WorkflowV17ArtifactStoreError(`Workflow v17 artifact body ${digest} failed validation`);
    }
  } finally {
    await handle.close();
  }
}

async function readOptionalMetadata(
  filePath: string,
  maximumBytes: number,
): Promise<ArtifactMetadataV17 | undefined> {
  try { return await readMetadata(filePath, maximumBytes); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readMetadata(filePath: string, maximumBytes: number): Promise<ArtifactMetadataV17> {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes + 4_096) {
    throw new WorkflowV17ArtifactStoreError("Workflow v17 artifact metadata is unsafe");
  }
  const text = await fs.promises.readFile(filePath, "utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new WorkflowV17ArtifactStoreError("Workflow v17 artifact metadata is invalid JSON"); }
  const canonical = canonicalJsonValue(parsed, { ...METADATA_LIMITS, maxBytes: maximumBytes + 4_096 });
  if (stableJson(canonical) !== text || !canonical || typeof canonical !== "object" || Array.isArray(canonical)
    || (canonical as { formatVersion?: unknown }).formatVersion !== 1) {
    throw new WorkflowV17ArtifactStoreError("Workflow v17 artifact metadata is not canonical");
  }
  return canonical as unknown as ArtifactMetadataV17;
}

function assertSameArtifact(
  actual: WorkflowArtifactV17Record,
  expected: WorkflowArtifactV17Record,
  includeCreatedAt: boolean,
): void {
  if (!sameArtifact(actual, expected, includeCreatedAt)) {
    throw new WorkflowV17ArtifactStoreError(`Workflow v17 artifact digest collision ${expected.digest}`);
  }
}

function sameArtifact(
  left: WorkflowArtifactV17Record,
  right: WorkflowArtifactV17Record,
  includeCreatedAt: boolean,
): boolean {
  return left.digest === right.digest && left.runId === right.runId && left.kind === right.kind
    && left.mediaType === right.mediaType && left.bytes === right.bytes && left.bodyPath === right.bodyPath
    && stableJson(left.metadata) === stableJson(right.metadata)
    && (!includeCreatedAt || left.createdAt === right.createdAt);
}

function stripFormat(value: ArtifactMetadataV17): WorkflowArtifactV17Record {
  const { formatVersion: _formatVersion, ...record } = value;
  return record;
}

function assertDigest(value: string): void {
  if (!DIGEST.test(value)) throw new TypeError("Workflow v17 artifact digest is invalid");
}

function digestHex(value: string): string {
  const match = DIGEST.exec(value);
  if (!match) throw new TypeError("Workflow v17 artifact digest is invalid");
  return match[1]!;
}

function relativeBodyPath(digest: string): string {
  return `artifacts/${digestHex(digest)}/body`;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Workflow v17 ${label} is invalid`);
  return value;
}

async function ensureRealDirectory(directory: string): Promise<void> {
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.promises.realpath(directory) !== path.resolve(directory)) {
    throw new WorkflowV17ArtifactStoreError(`Unsafe workflow v17 artifact directory ${directory}`);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
