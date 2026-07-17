import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJsonValue } from "../definition/canonical-json.js";
import type {
  WorkflowCallArtifactV17Input,
  WorkflowArtifactV17Record,
} from "../persistence/run-database-v17-types.js";
import {
  WorkflowRunDatabaseV17,
  WorkflowRunDatabaseV17Reader,
} from "../persistence/run-database-v17.js";
import { sha256 } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";

const METADATA_BYTES = 64 * 1024;
const JSON_LIMITS = {
  maxBytes: METADATA_BYTES,
  maxDepth: 24,
  maxNodes: 5_000,
  maxStringScalars: 32_000,
} as const;

interface ArtifactMetadataV17 extends WorkflowArtifactV17Record {
  formatVersion: 1;
}

export class WorkflowV17ReplayArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowV17ReplayArtifactError";
  }
}

/** Filesystem materialization only; the caller commits returned rows with the replayed call. */
export class WorkflowV17ReplayArtifactImporter {
  private readonly sourceRunDir: string;
  private readonly targetRunDir: string;
  private readonly sourceRoot: string;
  private readonly targetRoot: string;

  constructor(
    sourceRunDir: string,
    private readonly source: WorkflowRunDatabaseV17Reader,
    targetRunDir: string,
    private readonly target: WorkflowRunDatabaseV17,
  ) {
    this.sourceRunDir = path.resolve(sourceRunDir);
    this.targetRunDir = path.resolve(targetRunDir);
    this.sourceRoot = path.join(this.sourceRunDir, "artifacts");
    this.targetRoot = path.join(this.targetRunDir, "artifacts");
  }

  async importOperation(
    sourceOperationId: string,
    createdAt: string,
  ): Promise<WorkflowCallArtifactV17Input[]> {
    const result: WorkflowCallArtifactV17Input[] = [];
    for (const link of this.source.listOperationArtifacts(sourceOperationId)) {
      const artifact = await this.importArtifact(link.artifact, createdAt);
      result.push({
        role: link.role,
        ...(link.name !== undefined ? { name: link.name } : {}),
        ordinal: link.ordinal,
        artifact,
      });
    }
    return result;
  }

  private async importArtifact(
    sourceRecord: WorkflowArtifactV17Record,
    createdAt: string,
  ): Promise<WorkflowArtifactV17Record> {
    const targetRun = this.target.readRun();
    const existing = this.target.readArtifact(sourceRecord.digest);
    if (existing) {
      assertSameArtifactContent(existing, sourceRecord);
      await this.validateTarget(existing);
      return existing;
    }

    await this.validateSource(sourceRecord);
    await ensureRealDirectory(this.targetRunDir);
    await fs.promises.mkdir(this.targetRoot, { recursive: true, mode: 0o700 });
    await ensureRealDirectory(this.targetRoot);
    const hex = digestHex(sourceRecord.digest);
    const directory = path.join(this.targetRoot, hex);
    try { await fs.promises.mkdir(directory, { mode: 0o700 }); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await ensureRealDirectory(directory);
    }

    const targetBody = path.join(directory, "body");
    const sourceBody = path.join(this.sourceRunDir, sourceRecord.bodyPath);
    await installImmutableBody(sourceBody, targetBody, sourceRecord.digest, sourceRecord.bytes);

    const proposed: WorkflowArtifactV17Record = {
      ...structuredClone(sourceRecord),
      runId: targetRun.runId,
      bodyPath: relativeBodyPath(sourceRecord.digest),
      createdAt,
    };
    const metadataPath = path.join(directory, "metadata.json");
    const prior = await readOptionalMetadata(metadataPath);
    if (prior) {
      const record = stripFormat(prior);
      assertSameArtifactContent(record, proposed);
      await validateBody(targetBody, record.digest, record.bytes);
      return record;
    }
    const metadata: ArtifactMetadataV17 = { formatVersion: 1, ...proposed };
    const text = stableJson(metadata);
    if (Buffer.byteLength(text) > METADATA_BYTES) {
      throw new WorkflowV17ReplayArtifactError(`Artifact ${sourceRecord.digest} metadata is too large`);
    }
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
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await readMetadata(metadataPath);
      assertSameArtifactContent(stripFormat(raced), proposed);
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
    await syncDirectory(directory);
    await syncDirectory(this.targetRoot);
    return proposed;
  }

  private async validateSource(record: WorkflowArtifactV17Record): Promise<void> {
    if (record.runId !== this.source.readRun().runId
      || record.bodyPath !== relativeBodyPath(record.digest)) {
      throw new WorkflowV17ReplayArtifactError(`Source artifact ${record.digest} has invalid identity`);
    }
    await ensureRealDirectory(this.sourceRunDir);
    await ensureRealDirectory(this.sourceRoot);
    const directory = path.join(this.sourceRoot, digestHex(record.digest));
    await ensureRealDirectory(directory);
    await validateBody(path.join(directory, "body"), record.digest, record.bytes);
    const metadata = await readMetadata(path.join(directory, "metadata.json"));
    if (stableJson(metadata) !== stableJson({ formatVersion: 1, ...record })) {
      throw new WorkflowV17ReplayArtifactError(`Source artifact ${record.digest} metadata differs from SQLite`);
    }
  }

  private async validateTarget(record: WorkflowArtifactV17Record): Promise<void> {
    if (record.bodyPath !== relativeBodyPath(record.digest)) {
      throw new WorkflowV17ReplayArtifactError(`Target artifact ${record.digest} has a noncanonical body path`);
    }
    const directory = path.join(this.targetRoot, digestHex(record.digest));
    await ensureRealDirectory(directory);
    await validateBody(path.join(directory, "body"), record.digest, record.bytes);
    const metadata = await readMetadata(path.join(directory, "metadata.json"));
    if (stableJson(metadata) !== stableJson({ formatVersion: 1, ...record })) {
      throw new WorkflowV17ReplayArtifactError(`Target artifact ${record.digest} metadata differs from SQLite`);
    }
  }
}

async function installImmutableBody(
  source: string,
  target: string,
  digest: string,
  bytes: number,
): Promise<void> {
  try {
    await validateBody(target, digest, bytes);
    return;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const stat = await fs.promises.lstat(target).catch(() => undefined);
      if (stat) throw error;
    }
  }
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    // A reflink/copy gives the target run an independent immutable inode; a hardlink would let later
    // source-run tampering change evidence already admitted by the target.
    await fs.promises.copyFile(source, temporary, fs.constants.COPYFILE_FICLONE);
    await validateBody(temporary, digest, bytes);
    await fs.promises.chmod(temporary, 0o400);
    try { await fs.promises.rename(temporary, target); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
  await validateBody(target, digest, bytes);
}

async function validateBody(filePath: string, digest: string, bytes: number): Promise<void> {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes) {
    throw new WorkflowV17ReplayArtifactError(`Artifact body ${digest} is unsafe or has the wrong size`);
  }
  const handle = await fs.promises.open(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const body = await handle.readFile();
    if (body.length !== bytes || sha256(body) !== digest) {
      throw new WorkflowV17ReplayArtifactError(`Artifact body ${digest} failed its digest check`);
    }
  } finally {
    await handle.close();
  }
}

async function readOptionalMetadata(filePath: string): Promise<ArtifactMetadataV17 | undefined> {
  try { return await readMetadata(filePath); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readMetadata(filePath: string): Promise<ArtifactMetadataV17> {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > METADATA_BYTES) {
    throw new WorkflowV17ReplayArtifactError("Artifact metadata file is unsafe");
  }
  const text = await fs.promises.readFile(filePath, "utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new WorkflowV17ReplayArtifactError("Artifact metadata is invalid JSON"); }
  const canonical = canonicalJsonValue(parsed, JSON_LIMITS);
  if (stableJson(canonical) !== text || !canonical || typeof canonical !== "object"
    || Array.isArray(canonical) || (canonical as { formatVersion?: unknown }).formatVersion !== 1) {
    throw new WorkflowV17ReplayArtifactError("Artifact metadata is not canonical v17 metadata");
  }
  return canonical as unknown as ArtifactMetadataV17;
}

function assertSameArtifactContent(
  left: WorkflowArtifactV17Record,
  right: WorkflowArtifactV17Record,
): void {
  const content = (record: WorkflowArtifactV17Record) => ({
    digest: record.digest,
    kind: record.kind,
    mediaType: record.mediaType,
    bytes: record.bytes,
    bodyPath: record.bodyPath,
    metadata: record.metadata,
  });
  if (stableJson(content(left)) !== stableJson(content(right))) {
    throw new WorkflowV17ReplayArtifactError(`Artifact ${right.digest} changed identity`);
  }
}

function stripFormat(metadata: ArtifactMetadataV17): WorkflowArtifactV17Record {
  const { formatVersion: _formatVersion, ...record } = metadata;
  return record;
}

function digestHex(digest: string): string {
  const match = /^sha256:([a-f0-9]{64})$/u.exec(digest);
  if (!match) throw new TypeError("Invalid workflow v17 artifact digest");
  return match[1]!;
}

function relativeBodyPath(digest: string): string {
  return `artifacts/${digestHex(digest)}/body`;
}

async function ensureRealDirectory(directory: string): Promise<void> {
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || await fs.promises.realpath(directory) !== path.resolve(directory)) {
    throw new WorkflowV17ReplayArtifactError(`Unsafe artifact directory ${directory}`);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
