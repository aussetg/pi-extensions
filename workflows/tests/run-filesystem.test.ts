import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../src/runtime/durable-types.js";
import {
  ArtifactStore,
  ArtifactStoreError,
  type ArtifactStoreFaultPoint,
} from "../src/artifacts/store.js";
import { projectRoot, workflowDraftRoot, workflowRunRoot } from "../src/persistence/paths.js";
import { RunCatalog } from "../src/persistence/run-catalog.js";
import { sha256 } from "../src/utils/hashes.js";

const temporaryDirectories: string[] = [];
const NOW = "2026-04-02T12:00:00.000Z";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("run paths and catalog", () => {
  it("uses one run root and one separate draft root", () => {
    const state = temporary("workflow-state-");
    expect(workflowRunRoot(state)).toBe(path.join(state, "workflow-runs"));
    expect(workflowDraftRoot(state)).toBe(path.join(state, "workflow-drafts"));
  });

  it("never mistakes the user's global configuration directory for a project marker", () => {
    const directory = fs.mkdtempSync(path.join(os.homedir(), "workflow-project-root-"));
    temporaryDirectories.push(directory);
    const nested = path.join(directory, "nested");
    fs.mkdirSync(nested);
    expect(projectRoot(nested)).toBe(nested);
  });

  it("creates random exclusive immediate run directories and lists from run.sqlite", async () => {
    const root = path.join(temporary("workflow-catalog-"), "runs");
    const catalog = new RunCatalog(root);
    const first = await catalog.create({ run: runRecord(NOW) });
    const second = await catalog.create({ run: runRecord(later(1)) });
    first.database.close();
    second.database.close();

    expect(first.entry.runId).toMatch(/^flow_[a-f0-9]{32}$/);
    expect(second.entry.runId).toMatch(/^flow_[a-f0-9]{32}$/);
    expect(second.entry.runId).not.toBe(first.entry.runId);
    expect(path.dirname(first.entry.paths.root)).toBe(root);
    expect(await fs.promises.readdir(root)).toEqual(expect.arrayContaining([first.entry.runId, second.entry.runId]));

    // History is not part of catalog discovery. If listing tried to inspect it,
    // this deliberately renamed table would fail the read.
    const raw = new DatabaseSync(first.entry.paths.database);
    raw.exec("ALTER TABLE events RENAME TO unavailable_events");
    raw.close();

    const entries = await catalog.list();
    expect(entries.map((entry) => entry.runId)).toEqual([second.entry.runId, first.entry.runId]);
    expect(entries.every((entry) => entry.run && !entry.error)).toBe(true);
    expect((await catalog.resolve(first.entry.runId.slice(5, 13))).runId).toBe(first.entry.runId);
  });

  it("reports an incomplete run directory and ignores symlinked catalog entries", async () => {
    const state = temporary("workflow-catalog-errors-");
    const root = path.join(state, "runs");
    const catalog = new RunCatalog(root);
    await catalog.ensureRoot();
    const incomplete = `flow_${"a".repeat(32)}`;
    await fs.promises.mkdir(path.join(root, incomplete));
    const outside = path.join(state, "outside");
    await fs.promises.mkdir(outside);
    await fs.promises.symlink(outside, path.join(root, `flow_${"b".repeat(32)}`));

    const entries = await catalog.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ runId: incomplete, error: expect.stringMatching(/open|ENOENT|no such/i) });
  });
});

describe("immutable artifact store", () => {
  it("stores text, canonical JSON, and files and is idempotent by body digest", async () => {
    const fixture = await artifactFixture();
    const text = await fixture.store.putText({
      expectedRevision: 1,
      kind: "agent-output",
      text: "hello\n",
      metadata: { producer: "agent" },
      createdAt: NOW,
    });
    expect(text.record).toMatchObject({
      digest: sha256("hello\n"),
      mediaType: "text/plain; charset=utf-8",
      bodyPath: `artifacts/${sha256("hello\n").slice(7)}/body`,
      metadata: { producer: "agent" },
    });
    expect(await fs.promises.readFile(text.bodyPath, "utf8")).toBe("hello\n");
    expect(Object.keys(text.ref)).toEqual([]);
    await expect(fixture.store.read({ ...text.artifact })).rejects.toThrow(/opaque/i);

    // A stale expected revision is harmless when the digest is already the
    // exact admitted artifact: no second event or revision is written.
    const duplicate = await fixture.store.putText({
      expectedRevision: 1,
      kind: "agent-output",
      text: "hello\n",
      metadata: { producer: "agent" },
      createdAt: later(10),
    });
    expect(duplicate.record).toEqual(text.record);
    expect(fixture.database.readRun().revision).toBe(2);
    expect(fixture.database.listEvents()).toHaveLength(2);

    const json = await fixture.store.putJson({
      expectedRevision: 2,
      kind: "structured-result",
      value: { z: 2, a: 1 },
      createdAt: later(1),
    });
    expect(await fs.promises.readFile(json.bodyPath, "utf8")).toBe('{"a":1,"z":2}');

    const source = path.join(fixture.state, "payload.bin");
    await fs.promises.writeFile(source, Buffer.from([0, 255, 1, 2]));
    const file = await fixture.store.putFile({
      expectedRevision: 3,
      kind: "published-file",
      filePath: source,
      createdAt: later(2),
    });
    expect(file.record.mediaType).toBe("application/octet-stream");
    expect(await fs.promises.readFile(file.bodyPath)).toEqual(Buffer.from([0, 255, 1, 2]));
    expect(fixture.database.listArtifacts()).toHaveLength(3);
    fixture.database.close();
  });

  it("rejects corrupt bodies, path-escaping rows, unsafe files, and byte-limit violations", async () => {
    const corrupt = await artifactFixture();
    const stored = await corrupt.store.putText({
      expectedRevision: 1,
      kind: "log",
      text: "intact",
      createdAt: NOW,
    });
    await fs.promises.chmod(stored.bodyPath, 0o600);
    await fs.promises.writeFile(stored.bodyPath, "broken");
    await expect(corrupt.store.read(stored.ref)).rejects.toThrow(/digest|size/i);
    corrupt.database.close();

    const escaping = await artifactFixture();
    const escaped = await escaping.store.putText({
      expectedRevision: 1,
      kind: "log",
      text: "safe",
      createdAt: NOW,
    });
    const raw = new DatabaseSync(escaping.database.databasePath);
    raw.prepare("UPDATE artifacts SET body_path = '../../outside' WHERE digest = ?").run(escaped.record.digest);
    raw.close();
    await expect(escaping.store.read(escaped.record.digest)).rejects.toThrow(/escapes/i);

    const source = path.join(escaping.state, "large.bin");
    await fs.promises.writeFile(source, "too large");
    await expect(escaping.store.putFile({
      expectedRevision: 2,
      kind: "file",
      filePath: source,
      maximumBytes: 2,
      createdAt: later(1),
    })).rejects.toThrow(/exceeds/i);
    const link = path.join(escaping.state, "source-link");
    await fs.promises.symlink(source, link);
    await expect(escaping.store.putFile({
      expectedRevision: 2,
      kind: "file",
      filePath: link,
      createdAt: later(1),
    })).rejects.toThrow(/regular file/i);
    escaping.database.close();
  });

  it("removes an orphan left before the SQLite commit", async () => {
    const fixture = await artifactFixture("after-metadata");
    await expect(fixture.store.putText({
      expectedRevision: 1,
      kind: "crash-fixture",
      text: "orphan",
      createdAt: NOW,
    })).rejects.toThrow("simulated crash");
    expect(fixture.database.listArtifacts()).toEqual([]);
    expect(await fs.promises.readdir(fixture.entry.paths.artifacts)).toContain(sha256("orphan").slice(7));

    const reconciler = new ArtifactStore(fixture.entry.paths.root, fixture.database);
    expect(await reconciler.reconcile()).toEqual({
      removedTemporaryBodies: 0,
      removedUnreferencedArtifacts: 1,
      retainedArtifacts: 0,
    });
    expect(await fs.promises.readdir(fixture.entry.paths.artifacts)).toEqual([]);
    fixture.database.close();
  });

  it("retains an artifact when the process dies after the SQLite commit", async () => {
    const fixture = await artifactFixture("after-database-commit");
    await expect(fixture.store.putText({
      expectedRevision: 1,
      kind: "crash-fixture",
      text: "committed",
      createdAt: NOW,
    })).rejects.toThrow("simulated crash");
    expect(fixture.database.readRun().revision).toBe(2);
    expect(fixture.database.listArtifacts()).toHaveLength(1);

    const reconciler = new ArtifactStore(fixture.entry.paths.root, fixture.database);
    expect(await reconciler.reconcile()).toEqual({
      removedTemporaryBodies: 0,
      removedUnreferencedArtifacts: 0,
      retainedArtifacts: 1,
    });
    const retried = await reconciler.putText({
      expectedRevision: 1,
      kind: "crash-fixture",
      text: "committed",
      createdAt: later(10),
    });
    expect(retried.record.digest).toBe(sha256("committed"));
    expect(fixture.database.readRun().revision).toBe(2);
    fixture.database.close();
  });

  it("cleans a synced temporary body left before digest installation", async () => {
    const fixture = await artifactFixture("after-body-sync");
    await expect(fixture.store.putText({
      expectedRevision: 1,
      kind: "crash-fixture",
      text: "temporary",
      createdAt: NOW,
    })).rejects.toThrow("simulated crash");
    const reconciler = new ArtifactStore(fixture.entry.paths.root, fixture.database);
    expect(await reconciler.reconcile()).toEqual({
      removedTemporaryBodies: 1,
      removedUnreferencedArtifacts: 0,
      retainedArtifacts: 0,
    });
    fixture.database.close();
  });
});

async function artifactFixture(fault?: ArtifactStoreFaultPoint) {
  const state = temporary("workflow-artifacts-");
  const catalog = new RunCatalog(path.join(state, "runs"));
  const created = await catalog.create({ run: runRecord(NOW) });
  const store = new ArtifactStore(created.entry.paths.root, created.database, {
    ...(fault ? {
      faultInjector: (point) => {
        if (point === fault) throw new ArtifactStoreError("simulated crash");
      },
    } : {}),
  });
  return { state, store, database: created.database, entry: created.entry };
}

function runRecord(createdAt: string): Omit<RunRecord, "runId"> {
  return {
    revision: 1,
    workflow: {
      id: "builtin:test",
      name: "test",
      sourceHash: sha256("source"),
      definitionHash: sha256("definition"),
      capabilities: ["read-project"],
    },
    invocationHash: sha256("invocation"),
    projectSnapshotHash: sha256("project"),
    routeSnapshotHash: sha256("routes"),
    contextIdentityHash: sha256("context"),
    status: "queued",
    safety: {
      concurrency: 4,
      maximumAgentLaunches: 1_000,
      memoryBytes: 2 ** 30,
      tasks: 256,
      cpuQuotaPercent: 400,
      cpuWeight: 100,
      outputBytes: 64 * 1024 * 1024,
      commandTimeoutMs: 60_000,
    },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      providerRequests: 0,
      cost: 0,
      elapsedMs: 0,
      complete: true,
    },
    createdAt,
    updatedAt: createdAt,
  };
}

function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function later(seconds: number): string {
  return new Date(Date.parse(NOW) + seconds * 1_000).toISOString();
}
