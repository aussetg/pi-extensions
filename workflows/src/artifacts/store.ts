import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { JsonObject, JsonValue } from "../types.js";
import type { ArtifactRecord, ArtifactRef, ArtifactMediaType } from "../runtime/durable-types.js";
import {
  canonicalJson,
  canonicalJsonObject,
  canonicalJsonValue,
  type CanonicalJsonLimits,
} from "../definition/canonical-json.js";
import { assertArtifactRecord, assertIsoDate, assertText } from "../persistence/run-database-codec.js";
import { RunDatabase } from "../persistence/run-database.js";
import { readBoundedTextFile } from "../persistence/safe-paths.js";

export const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_ARTIFACT_METADATA_BYTES = 64 * 1024;

const DIGEST = /^sha256:([a-f0-9]{64})$/;
const DIGEST_DIRECTORY = /^[a-f0-9]{64}$/;
const TEMPORARY_BODY = /^\.body-[a-f0-9-]+\.tmp$/;
const OPAQUE_ARTIFACT_REFS = new WeakMap<object, ArtifactRef>();

const BODY_JSON_SHAPE_LIMITS = {
  maxDepth: 64,
  maxNodes: 100_000,
  maxStringScalars: 4_000_000,
} as const;

const METADATA_JSON_SHAPE_LIMITS = {
  maxDepth: 24,
  maxNodes: 5_000,
  maxStringScalars: 32_000,
} as const;

export type ArtifactStoreFaultPoint =
  | "after-body-sync"
  | "after-body-move"
  | "after-metadata"
  | "after-database-commit";

export interface ArtifactStoreOptions {
  maximumArtifactBytes?: number;
  maximumMetadataBytes?: number;
  now?: () => Date;
  /** Deterministic crash boundary used by focused durability tests. */
  faultInjector?: (point: ArtifactStoreFaultPoint) => void | Promise<void>;
}

interface PutArtifactOptions {
  expectedRevision: number;
  kind: string;
  metadata?: JsonObject;
  maximumBytes?: number;
  createdAt?: string;
}

export interface PutTextArtifactOptions extends PutArtifactOptions {
  text: string;
}

export interface PutJsonArtifactOptions extends PutArtifactOptions {
  value: JsonValue;
}

export interface PutFileArtifactOptions extends PutArtifactOptions {
  filePath: string;
}

export interface PutBytesArtifactOptions extends PutArtifactOptions {
  bytes: Uint8Array;
}

export interface StoredArtifact {
  /** Workflow-facing, non-forgeable handle. */
  ref: OpaqueArtifactRef;
  /** Concrete reference for coordinator/database boundaries. */
  artifact: ArtifactRef;
  record: ArtifactRecord;
  bodyPath: string;
}

export interface PreparedArtifactImport {
  artifact: ArtifactRef;
  /** Undefined when this run already has the exact digest row. */
  record?: ArtifactRecord;
  bodyPath: string;
}

export type OpaqueArtifactRef = Readonly<object>;

export function createOpaqueArtifactRef(ref: ArtifactRef): OpaqueArtifactRef {
  assertDigest(ref.digest);
  assertText(ref.kind, "artifact kind", 128);
  if (!isArtifactMediaType(ref.mediaType) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) {
    throw new TypeError("Invalid artifact reference");
  }
  const opaque = Object.create(null) as object;
  OPAQUE_ARTIFACT_REFS.set(opaque, Object.freeze({ ...ref }));
  return Object.freeze(opaque);
}

export function describeOpaqueArtifactRef(value: unknown): ArtifactRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const ref = OPAQUE_ARTIFACT_REFS.get(value as object);
  return ref ? { ...ref } : undefined;
}

export interface ArtifactReconciliation {
  removedTemporaryBodies: number;
  removedUnreferencedArtifacts: number;
  retainedArtifacts: number;
}

interface ArtifactMetadataFile extends ArtifactRecord {
  formatVersion: 1;
}

interface StagedBody {
  path: string;
  digest: string;
  bytes: number;
}

interface PreparedArtifact {
  expectedRevision: number;
  kind: string;
  metadata: JsonObject;
  maximumBytes: number;
  createdAt: string;
}

/** One content-addressed artifact store bound to one run.sqlite writer. */
export class ArtifactStore {
  readonly runDir: string;
  readonly runId: string;
  readonly root: string;
  readonly database: RunDatabase;
  private readonly maximumArtifactBytes: number;
  private readonly maximumMetadataBytes: number;
  private readonly now: () => Date;
  private readonly faultInjector?: ArtifactStoreOptions["faultInjector"];

  constructor(runDir: string, database: RunDatabase, options: ArtifactStoreOptions = {}) {
    this.database = database;
    this.runDir = path.resolve(runDir);
    this.runId = database.readRun().runId;
    if (path.resolve(database.databasePath) !== path.join(this.runDir, "run.sqlite")) {
      throw new Error("Artifact store run directory and database do not match");
    }
    this.root = path.join(this.runDir, "artifacts");
    this.maximumArtifactBytes = positiveBound(
      options.maximumArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
      "maximum artifact bytes",
    );
    this.maximumMetadataBytes = positiveBound(
      options.maximumMetadataBytes ?? DEFAULT_MAX_ARTIFACT_METADATA_BYTES,
      "maximum artifact metadata bytes",
    );
    this.now = options.now ?? (() => new Date());
    this.faultInjector = options.faultInjector;
  }

  async putText(options: PutTextArtifactOptions): Promise<StoredArtifact> {
    if (typeof options.text !== "string") throw new TypeError("Text artifact body must be a string");
    assertUnicodeScalars(options.text, "Text artifact body");
    const body = Buffer.from(options.text, "utf8");
    return await this.putBuffer(body, "text/plain; charset=utf-8", options);
  }

  async putJson(options: PutJsonArtifactOptions): Promise<StoredArtifact> {
    const maximum = this.effectiveMaximum(options.maximumBytes);
    const limits: CanonicalJsonLimits = { ...BODY_JSON_SHAPE_LIMITS, maxBytes: maximum };
    const body = Buffer.from(canonicalJson(options.value, limits), "utf8");
    return await this.putBuffer(body, "application/json", options);
  }

  async putBytes(options: PutBytesArtifactOptions): Promise<StoredArtifact> {
    if (!(options.bytes instanceof Uint8Array)) throw new TypeError("Binary artifact body must be bytes");
    return await this.putBuffer(Buffer.from(options.bytes), "application/octet-stream", options);
  }

  async putFile(options: PutFileArtifactOptions): Promise<StoredArtifact> {
    const common = this.prepareCommon(options);
    await this.ensureRoot();
    const staged = await this.stageFile(path.resolve(options.filePath), common.maximumBytes);
    return await this.commitStaged(staged, "application/octet-stream", common);
  }

  async read(reference: OpaqueArtifactRef | string): Promise<StoredArtifact> {
    const opaqueRef = typeof reference === "string" ? undefined : describeOpaqueArtifactRef(reference);
    if (typeof reference !== "string" && !opaqueRef) throw new ArtifactStoreError("Artifact reference is not an opaque host reference");
    const digest = typeof reference === "string" ? reference : opaqueRef!.digest;
    assertDigest(digest);
    const record = this.database.readArtifact(digest);
    if (!record) throw new ArtifactStoreError(`Unknown artifact ${digest}`);
    if (opaqueRef && !sameRef(opaqueRef, record)) {
      throw new ArtifactStoreError(`Artifact reference ${digest} does not match its database row`);
    }
    return await this.validateStored(record);
  }

  /**
   * Link one validated immutable body from an explicitly selected source run.
   * SQLite admission is deliberately left to the caller's effect transaction.
   */
  async prepareImport(sourceRunDirInput: string, source: ArtifactRecord): Promise<PreparedArtifactImport> {
    assertArtifactRecord(source, source.runId);
    const sourceRunDir = path.resolve(sourceRunDirInput);
    if (sourceRunDir === this.runDir) throw new ArtifactStoreError("Artifact replay source must be another run");
    if (source.bodyPath !== relativeBodyPath(source.digest)) {
      throw new ArtifactStoreError(`Source artifact ${source.digest} has a noncanonical body path`);
    }
    const sourceRoot = path.join(sourceRunDir, "artifacts");
    const sourceDirectory = path.join(sourceRoot, digestHex(source.digest));
    const sourceBody = path.join(sourceRunDir, source.bodyPath);
    await assertRealDirectory(sourceRunDir);
    await assertRealDirectory(sourceRoot);
    await assertRealDirectory(sourceDirectory);
    await validateBodyFile(sourceBody, source.digest, source.bytes);
    await validateSourceMetadata(path.join(sourceDirectory, "metadata.json"), source, this.maximumMetadataBytes);

    const existing = this.database.readArtifact(source.digest);
    if (existing) {
      if (!sameRef(existing, source)) throw new ArtifactStoreError(`Artifact digest collision for ${source.digest}`);
      const stored = await this.validateStored(existing);
      return { artifact: stored.artifact, bodyPath: stored.bodyPath };
    }

    await this.ensureRoot();
    const temporary = path.join(this.root, `.body-${crypto.randomUUID()}.tmp`);
    try {
      await fs.promises.link(sourceBody, temporary);
    } catch (error: any) {
      if (error?.code !== "EXDEV") throw error;
      await fs.promises.copyFile(sourceBody, temporary, fs.constants.COPYFILE_FICLONE_FORCE);
      const copied = await fs.promises.open(temporary, "r");
      try { await copied.sync(); } finally { await copied.close(); }
    }
    const target: ArtifactRecord = {
      ...structuredClone(source),
      runId: this.runId,
      bodyPath: relativeBodyPath(source.digest),
    };
    const installed = await this.installBodyAndMetadata({
      path: temporary,
      digest: source.digest,
      bytes: source.bytes,
    }, target);
    const bodyPath = path.join(this.runDir, installed.bodyPath);
    await validateBodyFile(bodyPath, installed.digest, installed.bytes);
    return { artifact: artifactRef(installed), record: installed, bodyPath };
  }

  /**
   * Remove only bodies which SQLite does not reference. Unknown filesystem
   * entries are left alone rather than guessed at.
   */
  async reconcile(): Promise<ArtifactReconciliation> {
    await this.ensureRoot();
    const referenced = new Set<string>();
    let afterDigest: string | undefined;
    while (true) {
      const page = this.database.listArtifacts({ ...(afterDigest ? { afterDigest } : {}), limit: 256 });
      for (const artifact of page) referenced.add(digestHex(artifact.digest));
      if (page.length < 256) break;
      afterDigest = page.at(-1)!.digest;
    }

    let removedTemporaryBodies = 0;
    let removedUnreferencedArtifacts = 0;
    let retainedArtifacts = 0;
    const retained = new Set<string>();
    for (const entry of await fs.promises.readdir(this.root, { withFileTypes: true })) {
      const target = path.join(this.root, entry.name);
      if (entry.isFile() && !entry.isSymbolicLink() && TEMPORARY_BODY.test(entry.name)) {
        await fs.promises.rm(target);
        removedTemporaryBodies++;
        continue;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink() || !DIGEST_DIRECTORY.test(entry.name)) continue;
      if (!referenced.has(entry.name)) {
        await fs.promises.rm(target, { recursive: true, force: false });
        removedUnreferencedArtifacts++;
        continue;
      }
      await this.read(`sha256:${entry.name}`);
      retained.add(entry.name);
      retainedArtifacts++;
    }
    const missing = [...referenced].find((digest) => !retained.has(digest));
    if (missing) throw new ArtifactStoreError(`Committed artifact sha256:${missing} has no safe body directory`);
    if (removedTemporaryBodies || removedUnreferencedArtifacts) await syncDirectory(this.root);
    return { removedTemporaryBodies, removedUnreferencedArtifacts, retainedArtifacts };
  }

  private async putBuffer(
    body: Buffer,
    mediaType: ArtifactMediaType,
    options: PutArtifactOptions,
  ): Promise<StoredArtifact> {
    const common = this.prepareCommon(options);
    if (body.length > common.maximumBytes) throw new ArtifactStoreError(`Artifact exceeds ${common.maximumBytes} bytes`);
    await this.ensureRoot();
    const staged = await this.stageBuffer(body);
    return await this.commitStaged(staged, mediaType, common);
  }

  private prepareCommon(options: PutArtifactOptions): PreparedArtifact {
    if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1) {
      throw new TypeError("Invalid expected run revision");
    }
    assertText(options.kind, "artifact kind", 128);
    const metadataLimits: CanonicalJsonLimits = {
      ...METADATA_JSON_SHAPE_LIMITS,
      maxBytes: this.maximumMetadataBytes,
    };
    const metadata = canonicalJsonObject(options.metadata ?? {}, metadataLimits);
    const createdAt = options.createdAt ?? this.now().toISOString();
    assertIsoDate(createdAt, "artifact createdAt");
    return {
      expectedRevision: options.expectedRevision,
      kind: options.kind,
      metadata,
      maximumBytes: this.effectiveMaximum(options.maximumBytes),
      createdAt,
    };
  }

  private effectiveMaximum(requested: number | undefined): number {
    if (requested === undefined) return this.maximumArtifactBytes;
    return Math.min(positiveBound(requested, "artifact byte limit"), this.maximumArtifactBytes);
  }

  private async stageBuffer(body: Buffer): Promise<StagedBody> {
    const temporary = path.join(this.root, `.body-${crypto.randomUUID()}.tmp`);
    const handle = await fs.promises.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.fault("after-body-sync");
    return { path: temporary, digest: digestBuffer(body), bytes: body.length };
  }

  private async stageFile(sourcePath: string, maximumBytes: number): Promise<StagedBody> {
    const before = await fs.promises.lstat(sourcePath);
    if (!before.isFile() || before.isSymbolicLink()) throw new ArtifactStoreError("Artifact source must be a regular file");
    if (before.size > maximumBytes) throw new ArtifactStoreError(`Artifact exceeds ${maximumBytes} bytes`);
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    const source = await fs.promises.open(sourcePath, fs.constants.O_RDONLY | noFollow);
    const temporary = path.join(this.root, `.body-${crypto.randomUUID()}.tmp`);
    let output: fs.promises.FileHandle | undefined;
    try {
      const opened = await source.stat();
      if (!opened.isFile() || opened.size > maximumBytes) throw new ArtifactStoreError("Artifact source is unsafe or too large");
      output = await fs.promises.open(temporary, "wx", 0o600);
      const hash = crypto.createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let bytes = 0;
      while (true) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        bytes += bytesRead;
        if (bytes > maximumBytes) throw new ArtifactStoreError(`Artifact exceeds ${maximumBytes} bytes`);
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        await output.write(chunk);
      }
      const after = await source.stat();
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || bytes !== opened.size) {
        throw new ArtifactStoreError("Artifact source changed while it was copied");
      }
      await output.sync();
      await output.close();
      output = undefined;
      await this.fault("after-body-sync");
      return { path: temporary, digest: `sha256:${hash.digest("hex")}`, bytes };
    } catch (error) {
      await output?.close().catch(() => undefined);
      throw error;
    } finally {
      await source.close();
    }
  }

  private async commitStaged(
    staged: StagedBody,
    mediaType: ArtifactMediaType,
    common: PreparedArtifact,
  ): Promise<StoredArtifact> {
    const bodyPath = relativeBodyPath(staged.digest);
    let record: ArtifactRecord = {
      digest: staged.digest,
      runId: this.runId,
      kind: common.kind,
      mediaType,
      bytes: staged.bytes,
      bodyPath,
      metadata: common.metadata,
      createdAt: common.createdAt,
    };
    assertArtifactRecord(record, this.runId);

    const existingRow = this.database.readArtifact(staged.digest);
    if (existingRow) {
      await fs.promises.rm(staged.path, { force: true });
      assertSameArtifact(existingRow, record, false);
      return await this.validateStored(existingRow);
    }

    record = await this.installBodyAndMetadata(staged, record);
    await this.fault("after-metadata");
    try {
      this.database.registerArtifact(common.expectedRevision, record, {
        type: "artifact-registered",
        payload: { digest: record.digest, kind: record.kind, mediaType: record.mediaType },
        at: record.createdAt,
      });
    } catch (error) {
      const raced = this.database.readArtifact(record.digest);
      if (!raced) throw error;
      assertSameArtifact(raced, record, true);
      record = raced;
    }
    await this.fault("after-database-commit");
    return await this.validateStored(record);
  }

  private async installBodyAndMetadata(staged: StagedBody, proposed: ArtifactRecord): Promise<ArtifactRecord> {
    const directory = path.join(this.root, digestHex(staged.digest));
    const bodyPath = path.join(directory, "body");
    let created = false;
    try {
      await fs.promises.mkdir(directory, { mode: 0o700 });
      created = true;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }

    if (created) {
      await fs.promises.rename(staged.path, bodyPath);
      await fs.promises.chmod(bodyPath, 0o400);
      await syncDirectory(directory);
      await syncDirectory(this.root);
      await this.fault("after-body-move");
    } else {
      await fs.promises.rm(staged.path, { force: true });
      await validateBodyFile(bodyPath, staged.digest, staged.bytes);
    }

    const metadataPath = path.join(directory, "metadata.json");
    const existingMetadata = await this.readOptionalMetadata(metadataPath);
    if (existingMetadata) {
      assertSameArtifact(existingMetadata, proposed, false);
      return stripMetadataFormat(existingMetadata);
    }

    const metadata: ArtifactMetadataFile = { formatVersion: 1, ...proposed };
    const metadataText = canonicalJson(metadata, {
      ...METADATA_JSON_SHAPE_LIMITS,
      maxBytes: this.maximumMetadataBytes + 4_096,
    });
    const temporary = path.join(directory, `.metadata-${crypto.randomUUID()}.tmp`);
    const handle = await fs.promises.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(metadataText, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.promises.link(temporary, metadataPath);
      await fs.promises.chmod(metadataPath, 0o400);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const raced = await this.readMetadata(metadataPath);
      assertSameArtifact(raced, proposed, false);
      return stripMetadataFormat(raced);
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
    await syncDirectory(directory);
    return proposed;
  }

  private async validateStored(record: ArtifactRecord): Promise<StoredArtifact> {
    assertArtifactRecord(record, this.runId);
    const expectedBodyPath = relativeBodyPath(record.digest);
    if (record.bodyPath !== expectedBodyPath) throw new ArtifactStoreError("Artifact body path escapes its digest directory");
    const directory = path.join(this.root, digestHex(record.digest));
    await assertRealDirectory(this.root);
    await assertRealDirectory(directory);
    const metadata = await this.readMetadata(path.join(directory, "metadata.json"));
    assertSameArtifact(metadata, record, true);
    const bodyPath = path.join(directory, "body");
    await validateBodyFile(bodyPath, record.digest, record.bytes);

    if (record.mediaType !== "application/octet-stream") {
      const body = await fs.promises.readFile(bodyPath);
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(body); }
      catch { throw new ArtifactStoreError(`Artifact ${record.digest} is not valid UTF-8`); }
      if (record.mediaType === "application/json") {
        let parsed: unknown;
        try { parsed = JSON.parse(text); }
        catch { throw new ArtifactStoreError(`Artifact ${record.digest} is not valid JSON`); }
        const canonical = JSON.stringify(canonicalJsonValue(parsed, {
          ...BODY_JSON_SHAPE_LIMITS,
          maxBytes: Math.max(record.bytes, 1),
        }));
        if (canonical !== text) throw new ArtifactStoreError(`Artifact ${record.digest} is not canonical JSON`);
      }
    }
    const concrete = artifactRef(record);
    return { ref: createOpaqueArtifactRef(concrete), artifact: concrete, record, bodyPath };
  }

  private async readOptionalMetadata(metadataPath: string): Promise<ArtifactMetadataFile | undefined> {
    try { return await this.readMetadata(metadataPath); }
    catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async readMetadata(metadataPath: string): Promise<ArtifactMetadataFile> {
    const source = await readBoundedTextFile(metadataPath, this.maximumMetadataBytes + 4_096);
    let parsed: unknown;
    try { parsed = JSON.parse(source); }
    catch { throw new ArtifactStoreError("Artifact metadata is not valid JSON"); }
    const canonical = canonicalJsonValue(parsed, {
      ...METADATA_JSON_SHAPE_LIMITS,
      maxBytes: this.maximumMetadataBytes + 4_096,
    });
    if (JSON.stringify(canonical) !== source || !canonical || typeof canonical !== "object" || Array.isArray(canonical)) {
      throw new ArtifactStoreError("Artifact metadata is not canonical JSON");
    }
    const keys = Object.keys(canonical).sort();
    const expected = ["bodyPath", "bytes", "createdAt", "digest", "formatVersion", "kind", "mediaType", "metadata", "runId"].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
      throw new ArtifactStoreError("Artifact metadata contains unexpected fields");
    }
    const metadata = canonical as unknown as ArtifactMetadataFile;
    if (metadata.formatVersion !== 1) throw new ArtifactStoreError("Unsupported artifact metadata format");
    assertArtifactRecord(metadata, this.runId);
    return metadata;
  }

  private async ensureRoot(): Promise<void> {
    await assertRealDirectory(this.runDir);
    await fs.promises.mkdir(this.root, { mode: 0o700 }).catch(async (error: any) => {
      if (error?.code !== "EEXIST") throw error;
    });
    await assertRealDirectory(this.root);
  }

  private async fault(point: ArtifactStoreFaultPoint): Promise<void> {
    await this.faultInjector?.(point);
  }
}

export class ArtifactStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

function artifactRef(record: ArtifactRecord): ArtifactRef {
  return { digest: record.digest, kind: record.kind, mediaType: record.mediaType, bytes: record.bytes };
}

function sameRef(ref: ArtifactRef, record: ArtifactRecord): boolean {
  return ref.digest === record.digest && ref.kind === record.kind
    && ref.mediaType === record.mediaType && ref.bytes === record.bytes;
}

function isArtifactMediaType(value: string): value is ArtifactMediaType {
  return value === "text/plain; charset=utf-8" || value === "application/json" || value === "application/octet-stream";
}

function assertSameArtifact(actual: ArtifactRecord, expected: ArtifactRecord, includeCreatedAt: boolean): void {
  const fields: Array<keyof ArtifactRecord> = ["digest", "runId", "kind", "mediaType", "bytes", "bodyPath"];
  if (includeCreatedAt) fields.push("createdAt");
  for (const field of fields) {
    if (actual[field] !== expected[field]) throw new ArtifactStoreError(`Artifact digest collision at ${String(field)}`);
  }
  if (JSON.stringify(actual.metadata) !== JSON.stringify(expected.metadata)) {
    throw new ArtifactStoreError("Artifact digest collision at metadata");
  }
}

function stripMetadataFormat(metadata: ArtifactMetadataFile): ArtifactRecord {
  const { formatVersion: _formatVersion, ...record } = metadata;
  return record;
}

function digestBuffer(body: Buffer): string {
  return `sha256:${crypto.createHash("sha256").update(body).digest("hex")}`;
}

function assertDigest(digest: string): void {
  if (!DIGEST.test(digest)) throw new TypeError("Invalid artifact digest");
}

function digestHex(digest: string): string {
  const match = DIGEST.exec(digest);
  if (!match) throw new TypeError("Invalid artifact digest");
  return match[1]!;
}

function relativeBodyPath(digest: string): string {
  return `artifacts/${digestHex(digest)}/body`;
}

async function validateBodyFile(bodyPath: string, digest: string, expectedBytes: number): Promise<void> {
  const stat = await fs.promises.lstat(bodyPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedBytes) {
    throw new ArtifactStoreError(`Artifact body ${digest} is unsafe or has the wrong size`);
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const handle = await fs.promises.open(bodyPath, fs.constants.O_RDONLY | noFollow);
  try {
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    if (bytes !== expectedBytes || `sha256:${hash.digest("hex")}` !== digest) {
      throw new ArtifactStoreError(`Artifact body ${digest} failed its digest check`);
    }
  } finally {
    await handle.close();
  }
}

async function validateSourceMetadata(
  metadataPath: string,
  expected: ArtifactRecord,
  maximumMetadataBytes: number,
): Promise<void> {
  const source = await readBoundedTextFile(metadataPath, maximumMetadataBytes + 4_096);
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch { throw new ArtifactStoreError(`Source artifact ${expected.digest} metadata is invalid JSON`); }
  const canonical = canonicalJsonValue(parsed, {
    ...METADATA_JSON_SHAPE_LIMITS,
    maxBytes: maximumMetadataBytes + 4_096,
  });
  if (JSON.stringify(canonical) !== source || !canonical || typeof canonical !== "object" || Array.isArray(canonical)) {
    throw new ArtifactStoreError(`Source artifact ${expected.digest} metadata is not canonical`);
  }
  const metadata = canonical as unknown as ArtifactMetadataFile;
  if (metadata.formatVersion !== 1) throw new ArtifactStoreError("Unsupported source artifact metadata format");
  assertArtifactRecord(metadata, expected.runId);
  assertSameArtifact(metadata, expected, true);
}

async function assertRealDirectory(directory: string): Promise<void> {
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ArtifactStoreError(`Unsafe artifact directory: ${directory}`);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function positiveBound(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid ${label}`);
  return value;
}

function assertUnicodeScalars(value: string, label: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`${label} contains an unpaired surrogate`);
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} contains an unpaired surrogate`);
    }
  }
}
