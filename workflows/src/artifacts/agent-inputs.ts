import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentInputBundleHandle } from "../agents/executor.js";
import { DEFINITION_LIMITS, FLOW_NAME_PATTERN } from "../definition/limits.js";
import { sha256, stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import { ArtifactStore, describeOpaqueArtifactRef } from "./store.js";

interface InputManifest {
  formatVersion: 1;
  hash: string;
  entries: Array<{
    id: string;
    artifact: NonNullable<ReturnType<typeof describeOpaqueArtifactRef>>;
    file: string;
  }>;
}

/** Materialize exact content-addressed inputs once for one persistent session. */
export async function materializeAgentInputs(options: {
  store: ArtifactStore;
  root: string;
  inputs: readonly { id: string; artifact: unknown }[];
}): Promise<AgentInputBundleHandle> {
  if (options.inputs.length > DEFINITION_LIMITS.agentInputs) throw new Error("Too many agent input artifacts");
  const ids = new Set<string>();
  const resolved = [];
  let totalBytes = 0;
  for (const input of options.inputs) {
    if (typeof input.id !== "string" || !FLOW_NAME_PATTERN.test(input.id) || ids.has(input.id)) {
      throw new TypeError(`Invalid or duplicate agent input id ${String(input.id)}`);
    }
    ids.add(input.id);
    const artifact = describeOpaqueArtifactRef(input.artifact);
    if (!artifact) throw new TypeError(`Agent input ${input.id} is not an opaque artifact reference`);
    const stored = await options.store.read(input.artifact as Readonly<object>);
    totalBytes += artifact.bytes;
    if (totalBytes > DEFINITION_LIMITS.agentInputTotalBytes) {
      throw new Error("Agent input artifacts exceed their aggregate byte limit");
    }
    const extension = artifact.mediaType === "application/json" ? ".json"
      : artifact.mediaType.startsWith("text/plain") ? ".txt" : ".bin";
    resolved.push({ id: input.id, artifact, sourcePath: stored.bodyPath, file: `${input.id}${extension}` });
  }
  resolved.sort((left, right) => left.id.localeCompare(right.id));
  const identity = resolved.map(({ id, artifact, file }) => ({ id, artifact, file }));
  const hash = stableHash(identity);
  const root = path.resolve(options.root);
  const manifest: InputManifest = { formatVersion: 1, hash, entries: identity };
  if (await existingBundle(root, manifest)) return bundle(root, manifest);

  const parent = path.dirname(root);
  await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${root}.tmp-${crypto.randomUUID()}`;
  await fs.promises.mkdir(temporary, { mode: 0o700 });
  try {
    for (const entry of resolved) {
      const destination = path.join(temporary, entry.file);
      await fs.promises.copyFile(entry.sourcePath, destination, fs.constants.COPYFILE_FICLONE);
      const body = await fs.promises.readFile(destination);
      if (body.length !== entry.artifact.bytes || sha256(body) !== entry.artifact.digest) {
        throw new Error(`Materialized agent input ${entry.id} changed during copy`);
      }
      await fs.promises.chmod(destination, 0o400);
    }
    await fs.promises.writeFile(path.join(temporary, ".bundle.json"), `${stableJson(manifest)}\n`, {
      encoding: "utf8",
      mode: 0o400,
      flag: "wx",
    });
    await fs.promises.chmod(temporary, 0o500);
    try {
      await fs.promises.rename(temporary, root);
      await syncDirectory(parent);
    } catch (error: any) {
      if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
      await makeRemovable(temporary);
      await fs.promises.rm(temporary, { recursive: true, force: true });
      if (!await existingBundle(root, manifest)) throw new Error("Agent input bundle identity collision");
    }
  } catch (error) {
    await makeRemovable(temporary).catch(() => undefined);
    await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return bundle(root, manifest);
}

function bundle(root: string, manifest: InputManifest): AgentInputBundleHandle {
  return Object.freeze({
    root,
    entries: Object.freeze(manifest.entries.map((entry) => Object.freeze({
      id: entry.id,
      artifact: Object.freeze({ ...entry.artifact }),
      path: path.join(root, entry.file),
    }))),
    hash: manifest.hash,
  });
}

async function existingBundle(root: string, expected: InputManifest): Promise<boolean> {
  try {
    const rootStat = await fs.promises.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Agent input root is unsafe");
    const source = await fs.promises.readFile(path.join(root, ".bundle.json"), "utf8");
    const actual = JSON.parse(source) as InputManifest;
    if (source !== `${stableJson(actual)}\n` || stableJson(actual) !== stableJson(expected)) return false;
    for (const entry of actual.entries) {
      const target = path.join(root, entry.file);
      const stat = await fs.promises.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.artifact.bytes) return false;
      if (sha256(await fs.promises.readFile(target)) !== entry.artifact.digest) return false;
    }
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function makeRemovable(root: string): Promise<void> {
  let stat: fs.Stats;
  try { stat = await fs.promises.lstat(root); } catch { return; }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.promises.chmod(root, 0o700);
    for (const name of await fs.promises.readdir(root)) await makeRemovable(path.join(root, name));
  } else await fs.promises.chmod(root, 0o600);
}
