import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentContextBundle, AgentProfileSnapshot, AgentRouteSnapshot } from "../src/agents/executor.js";
import type { WorkflowInvocationSnapshot } from "../src/definition/types.js";
import { bubblewrapProjectViewArgs } from "../src/workspaces/bubblewrap-project-view.js";
import {
  captureProjectSnapshot,
  verifyProjectSnapshot,
} from "../src/workspaces/project-snapshot.js";
import {
  buildRunContextIdentity,
  captureRunContext,
  type RunContextToolSchema,
} from "../src/workspaces/run-context.js";
import { sha256, stableHash } from "../src/utils/hashes.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await makeWritable(root).catch(() => undefined);
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

describe("semantic project snapshot", () => {
  it("captures the dirty visible tree once, records exclusions, and uses real Btrfs reflinks", async () => {
    const root = await btrfsTemporary("snapshot-dirty-");
    const project = path.join(root, "project");
    const snapshot = path.join(root, "captured");
    await fs.promises.mkdir(project);
    git(project, "init", "-q");
    git(project, "config", "user.name", "Snapshot Test");
    git(project, "config", "user.email", "snapshot@example.invalid");
    await fs.promises.writeFile(path.join(project, "tracked.txt"), "tracked\n");
    await fs.promises.writeFile(path.join(project, "staged.txt"), "committed\n");
    await fs.promises.writeFile(path.join(project, "unstaged.txt"), "committed\n");
    await fs.promises.writeFile(path.join(project, ".gitignore"), "ignored.log\n");
    git(project, "add", ".");
    git(project, "-c", "commit.gpgSign=false", "commit", "-qm", "base");
    await fs.promises.writeFile(path.join(project, "staged.txt"), "staged\n");
    git(project, "add", "staged.txt");
    await fs.promises.writeFile(path.join(project, "unstaged.txt"), "unstaged\n");
    await fs.promises.writeFile(path.join(project, "untracked.txt"), "untracked\n");
    await fs.promises.writeFile(path.join(project, "ignored.log"), "permitted ignored content\n");
    await fs.promises.writeFile(path.join(project, "large.bin"), crypto.randomBytes(2 * 1024 * 1024));
    await fs.promises.symlink("tracked.txt", path.join(project, "tracked-link"));
    await fs.promises.mkdir(path.join(project, ".pi", "workflow-runs"), { recursive: true });
    await fs.promises.writeFile(path.join(project, ".pi", "workflow-runs", "secret"), "state");
    await fs.promises.mkdir(path.join(project, ".pi", "workflow-drafts"));
    await fs.promises.writeFile(path.join(project, ".pi", "workflow-drafts", "draft"), "state");
    await fs.promises.mkdir(path.join(project, "nested", ".hg"), { recursive: true });
    await fs.promises.writeFile(path.join(project, "nested", ".hg", "state"), "vcs");

    const manifest = await captureProjectSnapshot(project, project, snapshot);
    await verifyProjectSnapshot(snapshot, manifest);
    expect(await fs.promises.readFile(path.join(snapshot, "tracked.txt"), "utf8")).toBe("tracked\n");
    expect(await fs.promises.readFile(path.join(snapshot, "staged.txt"), "utf8")).toBe("staged\n");
    expect(await fs.promises.readFile(path.join(snapshot, "unstaged.txt"), "utf8")).toBe("unstaged\n");
    expect(await fs.promises.readFile(path.join(snapshot, "untracked.txt"), "utf8")).toBe("untracked\n");
    expect(await fs.promises.readFile(path.join(snapshot, "ignored.log"), "utf8")).toBe("permitted ignored content\n");
    expect(await fs.promises.readlink(path.join(snapshot, "tracked-link"))).toBe("tracked.txt");
    await expect(fs.promises.lstat(path.join(snapshot, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.promises.lstat(path.join(snapshot, ".pi", "workflow-runs"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(manifest.exclusions).toEqual([
      { path: ".git", type: "directory", reason: "vcs-internal" },
      { path: ".pi/workflow-drafts", type: "directory", reason: "workflow-state" },
      { path: ".pi/workflow-runs", type: "directory", reason: "workflow-state" },
      { path: "nested/.hg", type: "directory", reason: "vcs-internal" },
    ]);
    expect(manifest.treeHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const extents = spawnSync("filefrag", ["-v", path.join(project, "large.bin"), path.join(snapshot, "large.bin")], {
      encoding: "utf8",
    });
    expect(extents.status, extents.stderr).toBe(0);
    expect(extents.stdout).toMatch(/shared/);

    await fs.promises.writeFile(path.join(project, "tracked.txt"), "changed later\n");
    expect(await fs.promises.readFile(path.join(snapshot, "tracked.txt"), "utf8")).toBe("tracked\n");
  });

  it("detects a regular file changing while its reflink is admitted", async () => {
    const root = await btrfsTemporary("snapshot-mutation-");
    const project = path.join(root, "project");
    const snapshot = path.join(root, "captured");
    await fs.promises.mkdir(project);
    const mutable = path.join(project, "mutable.bin");
    await fs.promises.writeFile(mutable, crypto.randomBytes(64 * 1024 * 1024));
    const handle = await fs.promises.open(mutable, "r+");
    let running = true;
    let value = 0;
    const mutator = (async () => {
      while (running) {
        await handle.write(Buffer.from([value++ & 0xff]), 0, 1, 0);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })();
    try {
      await expect(captureProjectSnapshot(project, project, snapshot)).rejects.toThrow(/changed .*snapshot capture/i);
    } finally {
      running = false;
      await mutator;
      await handle.close();
    }
    await expect(fs.promises.lstat(snapshot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("binds paths, modes, file content, and symlink targets into the Merkle tree", async () => {
    const root = await btrfsTemporary("snapshot-merkle-");
    const project = path.join(root, "project");
    await fs.promises.mkdir(project);
    await fs.promises.writeFile(path.join(project, "a"), "same\n", { mode: 0o644 });
    await fs.promises.writeFile(path.join(project, "b"), "same\n");
    await fs.promises.symlink("a", path.join(project, "link"));
    const original = await captureProjectSnapshot(project, project, path.join(root, "snapshot-1"));

    await fs.promises.chmod(path.join(project, "a"), 0o755);
    const modeChanged = await captureProjectSnapshot(project, project, path.join(root, "snapshot-2"));
    expect(modeChanged.treeHash).not.toBe(original.treeHash);

    await fs.promises.rm(path.join(project, "link"));
    await fs.promises.symlink("b", path.join(project, "link"));
    const linkChanged = await captureProjectSnapshot(project, project, path.join(root, "snapshot-3"));
    expect(linkChanged.treeHash).not.toBe(modeChanged.treeHash);

    await fs.promises.rename(path.join(project, "b"), path.join(project, "renamed"));
    const pathChanged = await captureProjectSnapshot(project, project, path.join(root, "snapshot-4"));
    expect(pathChanged.treeHash).not.toBe(linkChanged.treeHash);
  });

  it("binds inspection read-only and discards temporary Bubblewrap overlay writes", async () => {
    const root = await btrfsTemporary("snapshot-bwrap-");
    const project = path.join(root, "project");
    const snapshot = path.join(root, "captured");
    await fs.promises.mkdir(project);
    await fs.promises.writeFile(path.join(project, "state.txt"), "captured\n");
    await captureProjectSnapshot(project, project, snapshot);

    const inspect = runBwrap(bubblewrapProjectViewArgs(snapshot, "/workspace", "inspection"),
      "printf changed > /workspace/state.txt");
    expect(inspect.status).not.toBe(0);
    expect(await fs.promises.readFile(path.join(snapshot, "state.txt"), "utf8")).toBe("captured\n");

    const temporary = runBwrap(bubblewrapProjectViewArgs(snapshot, "/workspace", "temporary"),
      "printf changed > /workspace/state.txt && printf added > /workspace/new.txt && cat /workspace/state.txt");
    expect(temporary.status, temporary.stderr).toBe(0);
    expect(temporary.stdout).toBe("changed");
    expect(await fs.promises.readFile(path.join(snapshot, "state.txt"), "utf8")).toBe("captured\n");
    await expect(fs.promises.lstat(path.join(snapshot, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    const aliased = runBwrap([
      ...bubblewrapProjectViewArgs(snapshot, "/project", "temporary"),
      "--symlink", "/project", "/workspace",
    ], "printf aliased > /workspace/state.txt && cat /project/state.txt");
    expect(aliased.status, aliased.stderr).toBe(0);
    expect(aliased.stdout).toBe("aliased");
    expect(await fs.promises.readFile(path.join(snapshot, "state.txt"), "utf8")).toBe("captured\n");
  });
});

describe("semantic run context identity", () => {
  it("changes for every model-visible input and ignores ambient credentials and executables", async () => {
    const root = await btrfsTemporary("snapshot-identity-");
    const project = path.join(root, "project");
    await fs.promises.mkdir(project);
    await fs.promises.writeFile(path.join(project, "source.ts"), "export const value = 1;\n");
    const firstProject = await captureProjectSnapshot(project, project, path.join(root, "snapshot-1"));
    const fixture = identityFixture(firstProject);
    const first = buildRunContextIdentity(fixture);

    const changed = (patch: Partial<typeof fixture>) => buildRunContextIdentity({ ...fixture, ...patch });
    const invocationInput = invocation({ task: "different" });
    expect(changed({ invocation: invocationInput }).hash).not.toBe(first.hash);
    const changedSource = invocation({ task: "inspect" }, "export default defineWorkflow({ name: 'changed' });");
    expect(changed({ invocation: changedSource }).hash).not.toBe(first.hash);
    const guidance = context([{ id: "project", path: "AGENTS.md", text: "Changed guidance." }]);
    expect(changed({ guidance }).hash).not.toBe(first.hash);
    expect(changed({ profiles: [{ ...fixture.profiles[0]!, instructions: "Changed profile prompt." }] }).hash).not.toBe(first.hash);
    expect(changed({ tools: [{ ...fixture.tools[0]!, schema: { type: "object", required: ["path"] } }] }).hash).not.toBe(first.hash);
    expect(changed({ routes: [{ ...fixture.routes[0]!, model: "provider/other", hash: stableHash("other-route") }] }).hash).not.toBe(first.hash);

    await fs.promises.writeFile(path.join(project, "source.ts"), "export const value = 2;\n");
    const secondProject = await captureProjectSnapshot(project, project, path.join(root, "snapshot-2"));
    expect(changed({ project: secondProject }).hash).not.toBe(first.hash);

    const withAmbientNoise = buildRunContextIdentity({
      ...fixture,
      credentials: { token: "refreshed" },
      executables: { bwrap: "upgraded" },
    } as typeof fixture & { credentials: object; executables: object });
    expect(withAmbientNoise.hash).toBe(first.hash);
    expect(JSON.stringify(first)).not.toMatch(/credential|executable|api.?key|token/i);
  });

  it("writes the exact source, invocation, project manifest, and identity into run context", async () => {
    const root = await btrfsTemporary("snapshot-context-");
    const project = path.join(root, "project");
    const runRoot = path.join(root, "run");
    await fs.promises.mkdir(project);
    await fs.promises.mkdir(runRoot);
    await fs.promises.writeFile(path.join(project, "visible.txt"), "visible\n");
    const input = invocation({ task: "capture" });
    const template = identityFixture({} as never);
    const captured = await captureRunContext({
      runRoot,
      sourceRoot: project,
      sourceCwd: project,
      invocation: input,
      guidance: template.guidance,
      profiles: template.profiles,
      tools: template.tools,
      routes: template.routes,
    });

    expect(await fs.promises.readFile(captured.paths.source, "utf8")).toBe(input.source);
    expect(JSON.parse(await fs.promises.readFile(captured.paths.invocation, "utf8"))).not.toHaveProperty("installedPath");
    expect(JSON.parse(await fs.promises.readFile(captured.paths.projectManifest, "utf8")).treeHash).toBe(captured.project.treeHash);
    expect(JSON.parse(await fs.promises.readFile(captured.paths.identity, "utf8")).hash).toBe(captured.identity.hash);
    expect(await fs.promises.readFile(path.join(captured.paths.project, "visible.txt"), "utf8")).toBe("visible\n");
  });
});

function identityFixture(project: Awaited<ReturnType<typeof captureProjectSnapshot>>) {
  const profiles: AgentProfileSnapshot[] = [{
    id: "builtin:base",
    name: "base",
    description: "Inspect",
    instructions: "Inspect the exact project.",
    allowedTools: ["read"],
    hash: stableHash("profile"),
    sourcePath: "<builtin:base>",
  }];
  const routes: AgentRouteSnapshot[] = [{
    id: "route_fixture",
    profileId: "builtin:base",
    provider: "provider",
    model: "provider/model",
    thinking: "low",
    hash: stableHash("route"),
  }];
  const tools: RunContextToolSchema[] = [{
    name: "read",
    schema: { type: "object", additionalProperties: false, properties: { path: { type: "string" } } },
    mutatesWorkspace: false,
    usesMediatedNetwork: false,
  }];
  return {
    project,
    invocation: invocation({ task: "inspect" }),
    guidance: context([{ id: "project", path: "AGENTS.md", text: "Pinned guidance." }]),
    profiles,
    tools,
    routes,
  };
}

function invocation(input: Record<string, string>, source = "export default defineWorkflow({ name: 'fixture' });"): WorkflowInvocationSnapshot {
  return {
    formatVersion: 1,
    workflowId: "builtin:fixture",
    namespace: "builtin",
    name: "fixture",
    description: "fixture",
    capabilities: ["read-project"],
    modelVisible: true,
    source,
    sourceHash: sha256(source),
    definitionHash: stableHash({ source }),
    runtimeApiVersion: 1,
    runtimeApiHash: stableHash("api"),
    inputSchema: { type: "object" },
    outputSchema: {},
    input,
    inputHash: stableHash(input),
    review: {
      capabilities: ["read-project"],
      agentProfiles: ["builtin:base"],
      commandProfiles: [],
      measurementProfiles: [],
      verificationProfiles: [],
      usesCandidateWrites: false,
      usesMediatedNetwork: false,
      humanCheckpointCount: 0,
      applySiteCount: 0,
    },
    installedPath: "<builtin:fixture>",
  };
}

function context(entries: Array<{ id: string; path: string; text: string }>): AgentContextBundle {
  const normalized = entries.map((entry) => ({ ...entry, hash: stableHash({ path: entry.path, text: entry.text }) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return { entries: normalized, hash: stableHash(normalized) };
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

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

async function btrfsTemporary(prefix: string): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(process.cwd(), `.phase8-${prefix}`));
  roots.push(root);
  const type = spawnSync("stat", ["-f", "-c", "%T", root], { encoding: "utf8" });
  if (type.status !== 0 || type.stdout.trim() !== "btrfs") throw new Error("Phase 8 integration tests require Btrfs");
  return root;
}

async function makeWritable(target: string): Promise<void> {
  let stat: fs.Stats;
  try { stat = await fs.promises.lstat(target); } catch { return; }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.promises.chmod(target, 0o700).catch(() => undefined);
    for (const name of await fs.promises.readdir(target)) await makeWritable(path.join(target, name));
  } else {
    await fs.promises.chmod(target, 0o600).catch(() => undefined);
  }
}
