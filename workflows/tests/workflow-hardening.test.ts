import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanCandidateTree } from "../src/candidates/tree.js";
import { WorkflowRunCatalog } from "../src/persistence/run-catalog.js";
import {
  applyWorkflowCandidateTree,
} from "../src/runtime/production-effects.js";
import { withWorkflowApplyLock } from "../src/workspaces/apply-lock.js";
import { stableHash } from "../src/utils/hashes.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.promises.rm(root, { recursive: true, force: true })));
});

describe("workflow production hardening", () => {
  it("applies only exact candidate paths and remains idempotent after partial mutation", async () => {
    const root = await temporary("workflow-apply-tree-");
    const launch = path.join(root, "launch");
    const candidate = path.join(root, "candidate");
    const live = path.join(root, "live");
    await Promise.all([launch, candidate, live].map(directory => fs.promises.mkdir(directory)));
    await Promise.all([
      fs.promises.writeFile(path.join(launch, "changed.txt"), "before\n"),
      fs.promises.writeFile(path.join(launch, "kept.txt"), "same\n"),
      fs.promises.writeFile(path.join(candidate, "changed.txt"), "after\n"),
      fs.promises.writeFile(path.join(candidate, "kept.txt"), "same\n"),
      fs.promises.writeFile(path.join(candidate, "added.txt"), "added\n"),
      fs.promises.writeFile(path.join(live, "changed.txt"), "after\n"),
      fs.promises.writeFile(path.join(live, "kept.txt"), "same\n"),
    ]);
    const [before, after] = await Promise.all([scanCandidateTree(launch), scanCandidateTree(candidate)]);
    const orphanSuffix = stableHash({
      candidateTreeHash: after.treeHash,
      entryPath: "added.txt",
    }).slice(7, 23);
    await fs.promises.writeFile(
      path.join(live, `.added.txt.pi-workflow-${orphanSuffix}.tmp`),
      "interrupted copy",
    );
    const apply = async () => await applyWorkflowCandidateTree({
      sourceRoot: live,
      launchRoot: launch,
      candidateRoot: candidate,
      expectedLaunchTreeHash: before.treeHash,
      expectedCandidateTreeHash: after.treeHash,
      changedPaths: ["added.txt", "changed.txt"],
      signal: new AbortController().signal,
    });
    await apply();
    expect((await scanCandidateTree(live)).treeHash).toBe(after.treeHash);
    await expect(apply()).resolves.toBeUndefined();
  });

  it("rejects live drift outside scope and conflicting drift inside scope", async () => {
    const root = await temporary("workflow-apply-drift-");
    const launch = path.join(root, "launch");
    const candidate = path.join(root, "candidate");
    const live = path.join(root, "live");
    for (const directory of [launch, candidate, live]) await fs.promises.mkdir(directory);
    for (const directory of [launch, candidate, live]) {
      await fs.promises.writeFile(path.join(directory, "changed.txt"), directory === candidate ? "after\n" : "before\n");
      await fs.promises.writeFile(path.join(directory, "kept.txt"), "same\n");
    }
    const [before, after] = await Promise.all([scanCandidateTree(launch), scanCandidateTree(candidate)]);
    const options = {
      sourceRoot: live,
      launchRoot: launch,
      candidateRoot: candidate,
      expectedLaunchTreeHash: before.treeHash,
      expectedCandidateTreeHash: after.treeHash,
      changedPaths: ["changed.txt"],
      signal: new AbortController().signal,
    };
    await fs.promises.writeFile(path.join(live, "kept.txt"), "external\n");
    await expect(applyWorkflowCandidateTree(options)).rejects.toThrow("drifted outside apply scope");
    await fs.promises.rm(path.join(live, "kept.txt"));
    await expect(applyWorkflowCandidateTree(options)).rejects.toThrow("drifted outside apply scope");
    await fs.promises.writeFile(path.join(live, "kept.txt"), "same\n");
    await fs.promises.writeFile(path.join(live, "changed.txt"), "third value\n");
    await expect(applyWorkflowCandidateTree(options)).rejects.toThrow("conflicts with apply");
  });

  it("rejects a symlink inserted into a changed path's live ancestor", async () => {
    const root = await temporary("workflow-apply-ancestor-");
    const launch = path.join(root, "launch");
    const candidate = path.join(root, "candidate");
    const live = path.join(root, "live");
    const outside = path.join(root, "outside");
    for (const directory of [launch, candidate, live, outside]) await fs.promises.mkdir(directory);
    for (const directory of [launch, candidate, live]) await fs.promises.mkdir(path.join(directory, "src"));
    await Promise.all([
      fs.promises.writeFile(path.join(launch, "src", "index.ts"), "before\n"),
      fs.promises.writeFile(path.join(candidate, "src", "index.ts"), "after\n"),
      fs.promises.writeFile(path.join(live, "src", "index.ts"), "before\n"),
      fs.promises.writeFile(path.join(outside, "index.ts"), "outside\n"),
    ]);
    const [before, after] = await Promise.all([scanCandidateTree(launch), scanCandidateTree(candidate)]);
    await fs.promises.rm(path.join(live, "src"), { recursive: true });
    await fs.promises.symlink(outside, path.join(live, "src"));
    await expect(applyWorkflowCandidateTree({
      sourceRoot: live,
      launchRoot: launch,
      candidateRoot: candidate,
      expectedLaunchTreeHash: before.treeHash,
      expectedCandidateTreeHash: after.treeHash,
      changedPaths: ["src/index.ts"],
      signal: new AbortController().signal,
    })).rejects.toThrow("Workflow apply ancestor is unsafe");
    expect(await fs.promises.readFile(path.join(outside, "index.ts"), "utf8")).toBe("outside\n");
  });

  it("serializes concurrent live-project mutation with a crash-releasing kernel lock", async () => {
    const root = await temporary("workflow-apply-lock-");
    const project = path.join(root, "project");
    const locks = path.join(root, "locks");
    await fs.promises.mkdir(project);
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const signal = new AbortController().signal;
    const first = withWorkflowApplyLock(project, signal, async () => {
      events.push("first-enter");
      await firstGate;
      events.push("first-leave");
    }, { lockRoot: locks, timeoutMs: 5_000 });
    await waitUntil(() => events.includes("first-enter"));
    const second = withWorkflowApplyLock(project, signal, async () => {
      events.push("second-enter");
    }, { lockRoot: locks, timeoutMs: 5_000 });
    await delay(50);
    expect(events).toEqual(["first-enter"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-enter", "first-leave", "second-enter"]);
  });

  it("cancels a waiting apply lock without poisoning the next acquirer", async () => {
    const root = await temporary("workflow-apply-lock-cancel-");
    const project = path.join(root, "project");
    const locks = path.join(root, "locks");
    await fs.promises.mkdir(project);
    let releaseFirst!: () => void;
    let entered = false;
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const first = withWorkflowApplyLock(project, new AbortController().signal, async () => {
      entered = true;
      await gate;
    }, { lockRoot: locks, timeoutMs: 5_000 });
    await waitUntil(() => entered);
    const controller = new AbortController();
    const reason = new Error("cancel waiting apply");
    const waiting = withWorkflowApplyLock(project, controller.signal, async () => undefined, {
      lockRoot: locks,
      timeoutMs: 5_000,
    });
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    releaseFirst();
    await first;
    await expect(withWorkflowApplyLock(project, new AbortController().signal, async () => "next", {
      lockRoot: locks,
      timeoutMs: 5_000,
    })).resolves.toBe("next");
  });

  it("rejects symlinked apply and lock roots before invoking flock", async () => {
    const root = await temporary("workflow-apply-symlink-");
    const project = path.join(root, "project");
    const target = path.join(root, "target");
    const linkedProject = path.join(root, "linked-project");
    const linkedLocks = path.join(root, "linked-locks");
    await Promise.all([fs.promises.mkdir(project), fs.promises.mkdir(target)]);
    await Promise.all([
      fs.promises.symlink(project, linkedProject),
      fs.promises.symlink(target, linkedLocks),
    ]);
    const signal = new AbortController().signal;
    await expect(withWorkflowApplyLock(linkedProject, signal, async () => undefined, {
      lockRoot: path.join(root, "locks"),
    })).rejects.toThrow("project root is unsafe");
    await expect(withWorkflowApplyLock(project, signal, async () => undefined, {
      lockRoot: linkedLocks,
    })).rejects.toThrow("lock root is unsafe");
  });

  it("refuses a symlinked global run catalog root", async () => {
    const root = await temporary("workflow-catalog-symlink-");
    const target = path.join(root, "target");
    const linked = path.join(root, "runs");
    await fs.promises.mkdir(target);
    await fs.promises.symlink(target, linked);
    await expect(new WorkflowRunCatalog(linked).list()).rejects.toThrow("Unsafe workflow run root");
  });
});

async function temporary(prefix: string): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for workflow hardening fixture");
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
