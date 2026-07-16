import fs from "node:fs";
import path from "node:path";
import type {
  AgentContextBundle,
  AgentProfileSnapshot,
  AgentRouteSnapshot,
} from "../agents/executor.js";
import type { WorkflowInvocationSnapshot } from "../definition/types.js";
import type { JsonSchema } from "../types.js";
import { sha256, stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import {
  captureProjectSnapshot,
  type ProjectSnapshotManifest,
} from "./project-snapshot.js";

export interface RunContextToolSchema {
  name: string;
  schema: JsonSchema;
  mutatesWorkspace: boolean;
  usesMediatedNetwork: boolean;
}

export interface RunContextIdentity {
  formatVersion: 1;
  project: {
    treeHash: string;
    cwd: string;
  };
  guidance: Array<{
    id: string;
    path: string;
    text: string;
    hash: string;
  }>;
  invocation: {
    workflowId: string;
    definitionHash: string;
    input: WorkflowInvocationSnapshot["input"];
    inputHash: string;
    hash: string;
  };
  workflowSourceHash: string;
  profiles: Array<{
    id: string;
    instructions: string;
    promptHash: string;
  }>;
  tools: Array<RunContextToolSchema & { schemaHash: string }>;
  routes: Array<{
    id: string;
    profileId: string;
    provider: string;
    model: string;
    thinking: AgentRouteSnapshot["thinking"];
    hash: string;
  }>;
  routeSnapshotHash: string;
  hash: string;
}

export interface CaptureRunContextOptions {
  runRoot: string;
  sourceRoot: string;
  sourceCwd: string;
  invocation: WorkflowInvocationSnapshot;
  guidance: AgentContextBundle;
  profiles: readonly AgentProfileSnapshot[];
  tools: readonly RunContextToolSchema[];
  routes: readonly AgentRouteSnapshot[];
}

export interface CapturedRunContext {
  project: ProjectSnapshotManifest;
  identity: RunContextIdentity;
  paths: {
    source: string;
    invocation: string;
    project: string;
    projectManifest: string;
    identity: string;
  };
}

/**
 * Populate the semantic run context in its final layout. This function owns
 * the only live-project capture. It never accepts credentials, executable
 * identities, cgroup settings, or temporary effect paths.
 */
export async function captureRunContext(options: CaptureRunContextOptions): Promise<CapturedRunContext> {
  const runRoot = path.resolve(options.runRoot);
  const contextRoot = path.join(runRoot, "context");
  const paths = {
    source: path.join(runRoot, "source.flow.js"),
    invocation: path.join(contextRoot, "invocation.json"),
    project: path.join(contextRoot, "project"),
    projectManifest: path.join(contextRoot, "project-manifest.json"),
    identity: path.join(contextRoot, "identity.json"),
  };
  const runStat = await fs.promises.lstat(runRoot);
  if (!runStat.isDirectory() || runStat.isSymbolicLink()) throw new Error("Run context root is unsafe");
  await fs.promises.mkdir(contextRoot, { recursive: true, mode: 0o700 });
  const contextStat = await fs.promises.lstat(contextRoot);
  if (!contextStat.isDirectory() || contextStat.isSymbolicLink()) throw new Error("Run context directory is unsafe");

  assertInvocation(options.invocation);
  let projectCreated = false;
  const written: string[] = [];
  try {
    const project = await captureProjectSnapshot(options.sourceRoot, options.sourceCwd, paths.project);
    projectCreated = true;
    const identity = buildRunContextIdentity({
      project,
      invocation: options.invocation,
      guidance: options.guidance,
      profiles: options.profiles,
      tools: options.tools,
      routes: options.routes,
    });
    const { source, installedPath: _installedPath, ...invocation } = options.invocation;
    await writeExclusive(paths.source, source);
    written.push(paths.source);
    await writeExclusive(paths.invocation, `${stableJson(invocation)}\n`);
    written.push(paths.invocation);
    await writeExclusive(paths.projectManifest, `${stableJson(project)}\n`);
    written.push(paths.projectManifest);
    await writeExclusive(paths.identity, `${stableJson(identity)}\n`);
    written.push(paths.identity);
    await syncDirectory(contextRoot);
    await syncDirectory(runRoot);
    return { project, identity, paths };
  } catch (error) {
    for (const filePath of written.reverse()) await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
    if (projectCreated) {
      await makeTreeRemovable(paths.project).catch(() => undefined);
      await fs.promises.rm(paths.project, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

export function buildRunContextIdentity(options: {
  project: ProjectSnapshotManifest;
  invocation: WorkflowInvocationSnapshot;
  guidance: AgentContextBundle;
  profiles: readonly AgentProfileSnapshot[];
  tools: readonly RunContextToolSchema[];
  routes: readonly AgentRouteSnapshot[];
}): RunContextIdentity {
  assertInvocation(options.invocation);
  const guidance = [...options.guidance.entries]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((entry) => {
      const hash = stableHash({ path: entry.path, text: entry.text });
      if (hash !== entry.hash) throw new Error(`Project guidance hash mismatch for ${entry.id}`);
      return { id: entry.id, path: entry.path, text: entry.text, hash };
    });
  if (stableHash(guidance) !== options.guidance.hash) throw new Error("Project guidance bundle hash mismatch");

  const profileIds = new Set<string>();
  const profiles = [...options.profiles]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((profile) => {
      if (profileIds.has(profile.id)) throw new Error(`Duplicate run-context profile ${profile.id}`);
      profileIds.add(profile.id);
      return {
        id: profile.id,
        instructions: profile.instructions,
        promptHash: stableHash(profile.instructions),
      };
    });

  const toolNames = new Set<string>();
  const tools = [...options.tools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(tool.name) || toolNames.has(tool.name)) {
        throw new Error(`Invalid or duplicate run-context tool ${tool.name}`);
      }
      toolNames.add(tool.name);
      return {
        name: tool.name,
        schema: structuredClone(tool.schema),
        schemaHash: stableHash(tool.schema),
        mutatesWorkspace: tool.mutatesWorkspace,
        usesMediatedNetwork: tool.usesMediatedNetwork,
      };
    });

  const routeIds = new Set<string>();
  const routes = [...options.routes]
    .sort((left, right) => left.profileId.localeCompare(right.profileId) || left.id.localeCompare(right.id))
    .map((route) => {
      if (routeIds.has(route.id)) throw new Error(`Duplicate run-context route ${route.id}`);
      routeIds.add(route.id);
      return {
        id: route.id,
        profileId: route.profileId,
        provider: route.provider,
        model: route.model,
        thinking: route.thinking,
        hash: route.hash,
      };
    });
  const routeSnapshotHash = stableHash(routes);
  const invocationBody = {
    workflowId: options.invocation.workflowId,
    definitionHash: options.invocation.definitionHash,
    input: structuredClone(options.invocation.input),
    inputHash: options.invocation.inputHash,
  };
  const invocation = { ...invocationBody, hash: stableHash(invocationBody) };
  const body = {
    formatVersion: 1 as const,
    project: { treeHash: options.project.treeHash, cwd: options.project.cwd },
    guidance,
    invocation,
    workflowSourceHash: options.invocation.sourceHash,
    profiles,
    tools,
    routes,
    routeSnapshotHash,
  };
  return { ...body, hash: stableHash(body) };
}

function assertInvocation(invocation: WorkflowInvocationSnapshot): void {
  if (invocation.formatVersion !== 1 || sha256(invocation.source) !== invocation.sourceHash) {
    throw new Error("Workflow invocation source is corrupt");
  }
  if (stableHash(invocation.input) !== invocation.inputHash) throw new Error("Workflow invocation input hash mismatch");
}

async function writeExclusive(filePath: string, contents: string): Promise<void> {
  const handle = await fs.promises.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function makeTreeRemovable(root: string): Promise<void> {
  let stat: fs.Stats;
  try { stat = await fs.promises.lstat(root); } catch { return; }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.promises.chmod(root, 0o700).catch(() => undefined);
    for (const name of await fs.promises.readdir(root)) await makeTreeRemovable(path.join(root, name));
  } else {
    await fs.promises.chmod(root, 0o600).catch(() => undefined);
  }
}
