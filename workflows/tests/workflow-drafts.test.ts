import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowDraftService } from "../src/drafts/service.js";
import { WorkflowDraftStore } from "../src/drafts/store.js";
import { routeFlowCommand } from "../src/commands/flow-command.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true, force: true })));
});

describe("workflow draft authoring", () => {
  it("keeps user and project intents separate with immutable source-hashed revisions", async () => {
    const fixture = await setup();
    const user = await fixture.store.create({ namespace: "user", name: "demo", source: source("demo", "return { value: 1 };"), cwd: fixture.project });
    const project = await fixture.store.create({ namespace: "project", name: "demo", source: source("demo", "return { value: 2 };"), cwd: fixture.project });

    expect(user.id).toBe("user:demo");
    expect(project.id).toBe("project:demo");
    expect(user.targetPath).toBe(path.join(fixture.userTarget, "demo.flow.js"));
    expect(project.targetPath).toBe(path.join(fixture.projectTarget, "demo.flow.js"));
    expect(user.sourceHash).not.toBe(project.sourceHash);
    expect((await fixture.store.list(fixture.project)).map((draft) => draft.id)).toEqual(["project:demo", "user:demo"]);

    const replaced = await fixture.store.replace({
      namespace: "user",
      name: "demo",
      source: source("demo", "return { value: 3 };"),
      expectedSourceHash: user.sourceHash,
      cwd: fixture.project,
    });
    expect(replaced.revisionHashes).toEqual(expect.arrayContaining([user.sourceHash, replaced.sourceHash]));
    const revisionFiles = await fs.promises.readdir(path.join(fixture.draftRoot, "user", "demo", "revisions"));
    expect(revisionFiles).toHaveLength(2);
  });

  it("serializes replacement races with exact source-hash CAS", async () => {
    const fixture = await setup();
    const initial = await fixture.store.create({ namespace: "user", name: "race", source: source("race"), cwd: fixture.project });
    const attempts = await Promise.allSettled([
      fixture.store.replace({ namespace: "user", name: "race", source: source("race", "return 1;"), expectedSourceHash: initial.sourceHash, cwd: fixture.project }),
      fixture.store.replace({ namespace: "user", name: "race", source: source("race", "return 2;"), expectedSourceHash: initial.sourceHash, cwd: fixture.project }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
  });

  it("reports invalid source and loads valid definitions without invoking run", async () => {
    const fixture = await setup();
    const ctx = context(fixture.project, true);
    await fixture.service.create({ namespace: "user", name: "invalid", source: "not javascript" }, ctx as any);
    const invalid = await fixture.service.validate("user:invalid", ctx as any);
    expect(invalid.valid).toBe(false);
    expect(invalid.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "parse", severity: "error" }),
    ]));

    await fixture.service.create({
      namespace: "user",
      name: "definition-only",
      source: source("definition-only", 'throw new Error("run body was invoked");'),
    }, ctx as any);
    const valid = await fixture.service.validate("user:definition-only", ctx as any);
    expect(valid.valid).toBe(true);
    expect(valid.definitionControlLoad).toBe("passed");
    expect(valid.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "schema", severity: "info" }),
      expect.objectContaining({ stage: "control-load", severity: "info" }),
    ]));
  }, 15_000);

  it("derives bounded capability, profile, command, network, and operation review data", async () => {
    const fixture = await setup();
    const ctx = context(fixture.project, true);
    await fixture.service.create({
      namespace: "project",
      name: "authority",
      source: source("authority", `
        const result = await flow.candidate("change", async workspace => {
          return await flow.agent("edit", {
            profile: "builtin:implementer",
            prompt: "Implement a reviewed change.",
            workspace,
            network: "research",
          });
        });
        await flow.command("check", { profile: "project:focused-check" });
        return result.metadata;
      `, ["read-project", "candidate-write", "host-command", "mediated-network"]),
    }, ctx as any);

    const review = await fixture.service.validate("project:authority", ctx as any);
    expect(review.valid).toBe(true);
    expect(review.capabilities.declared).toEqual(["candidate-write", "host-command", "mediated-network", "read-project"]);
    expect(review.capabilities.derived).toEqual(["candidate-write", "host-command", "mediated-network", "read-project"]);
    expect(review.profiles).toEqual([
      expect.objectContaining({ selector: "builtin:implementer", id: "builtin:implementer", model: "test/model" }),
    ]);
    expect(review.commandProfiles).toEqual(["project:focused-check"]);
    expect(review.authority).toMatchObject({ candidateWrite: true, mediatedNetwork: true, hostCommand: true });
    expect(review.operations).toMatchObject({ staticSites: 3, dynamicSites: { loops: 0, parallel: 0, fanOut: 0 } });
    expect(Buffer.byteLength(JSON.stringify(review))).toBeLessThanOrEqual(256 * 1024);
  }, 15_000);

  it("binds promotion to the exact draft, installed preimage, target, and review", async () => {
    const fixture = await setup();
    const ctx = context(fixture.project, true);
    const first = await fixture.service.create({ namespace: "user", name: "promote", source: source("promote", "return { version: 1 };"), }, ctx as any);
    const staleDraft = await fixture.service.promotionChallenge("user:promote", ctx as any);
    const replacement = await fixture.service.replace({
      namespace: "user",
      name: "promote",
      source: source("promote", "return { version: 2 };"),
      expectedSourceHash: first.sourceHash,
    }, ctx as any);
    await expect(fixture.service.promote("user:promote", staleDraft.challenge.challengeHash, ctx as any)).rejects.toThrow(/stale/i);

    const staleInstalled = await fixture.service.promotionChallenge("user:promote", ctx as any);
    await fs.promises.mkdir(fixture.userTarget, { recursive: true });
    await fs.promises.writeFile(path.join(fixture.userTarget, "promote.flow.js"), source("promote", "return { external: true };"));
    await expect(fixture.service.promote("user:promote", staleInstalled.challenge.challengeHash, ctx as any)).rejects.toThrow(/stale/i);

    const current = await fixture.service.promotionChallenge("user:promote", ctx as any);
    expect(current.challenge).toMatchObject({
      draftHash: replacement.sourceHash,
      targetNamespace: "user",
      targetPath: path.join(fixture.userTarget, "promote.flow.js"),
      installedSourceHash: expect.stringMatching(/^sha256:/),
      reviewHash: current.review.reviewHash,
    });
    const promoted = await fixture.service.promote("user:promote", current.challenge.challengeHash, ctx as any);
    expect(promoted.sourceHash).toBe(replacement.sourceHash);
    expect(await fs.promises.readFile(promoted.installedPath, "utf8")).toBe(replacement.source);
    await expect(fixture.service.inspect("user:promote", ctx as any)).rejects.toThrow();
  }, 20_000);

  it("requires project trust and supports exact discard", async () => {
    const fixture = await setup();
    const untrusted = context(fixture.project, false);
    await expect(fixture.service.create({ namespace: "project", name: "private", source: source("private") }, untrusted as any))
      .rejects.toThrow(/trusted project/i);
    const trusted = context(fixture.project, true);
    const draft = await fixture.service.create({ namespace: "user", name: "discard", source: source("discard") }, trusted as any);
    await expect(fixture.service.discard("user:discard", trusted as any, `sha256:${"0".repeat(64)}`)).rejects.toThrow(/changed/i);
    await fixture.service.discard("user:discard", trusted as any, draft.sourceHash);
    expect(await fixture.service.list(trusted as any)).toEqual([]);
  });

  it("exposes promotion only as an exact human command challenge", async () => {
    const fixture = await setup();
    const ctx = context(fixture.project, true);
    await fixture.service.create({ namespace: "user", name: "human", source: source("human") }, ctx as any);
    const workflows = { bindContext: vi.fn(), refreshDefinitions: vi.fn() };
    const first = await routeFlowCommand(
      { action: "promote", draftId: "user:human" },
      { workflows, drafts: fixture.service } as any,
      ctx as any,
    );
    expect(first.kind).toBe("flow-draft-promotion-challenge");
    const challenge = (first.data as any).challenge.challengeHash as string;
    expect(await fs.promises.stat(path.join(fixture.userTarget, "human.flow.js")).catch(() => undefined)).toBeUndefined();

    const second = await routeFlowCommand(
      { action: "promote", draftId: "user:human", challenge },
      { workflows, drafts: fixture.service } as any,
      ctx as any,
    );
    expect(second.kind).toBe("flow-draft-promoted");
    expect(workflows.refreshDefinitions).toHaveBeenCalledOnce();
  }, 15_000);
});

async function setup() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "workflow-drafts-"));
  temporary.push(root);
  const project = path.join(root, "project");
  const draftRoot = path.join(root, "drafts");
  const userTarget = path.join(root, "installed-user");
  const projectTarget = path.join(project, ".pi", "workflows");
  await fs.promises.mkdir(path.join(project, ".pi"), { recursive: true });
  await fs.promises.mkdir(path.join(project, ".pi", "commands"), { recursive: true });
  await fs.promises.writeFile(path.join(project, ".pi", "commands", "focused-check.json"), JSON.stringify({
    name: "focused-check",
    description: "A fixed project check used by draft review tests.",
    argv: ["/usr/bin/true"],
    timeoutMs: 5_000,
    outputLimitBytes: 64 * 1024,
    effects: ["read-only"],
  }));
  const store = new WorkflowDraftStore({
    root: draftRoot,
    userTargetDir: userTarget,
    projectTargetDir: () => projectTarget,
  });
  const service = new WorkflowDraftService({ getThinkingLevel: () => "low" } as any, {
    store,
    executorDescriptor: executorDescriptor(),
    routeFile: path.join(root, "no-local-routes.json"),
  });
  return { root, project, draftRoot, userTarget, projectTarget, store, service };
}

function context(cwd: string, trusted: boolean) {
  return {
    cwd,
    mode: "rpc",
    hasUI: true,
    model: { provider: "test", id: "model" },
    modelRegistry: { getAvailable: () => [{ provider: "test", id: "model" }] },
    isProjectTrusted: () => trusted,
    ui: { confirm: vi.fn(), notify: vi.fn() },
  };
}

function executorDescriptor() {
  const authority = (name: string, mutatesWorkspace = false, usesMediatedNetwork = false) => ({
    name,
    schemaHash: "0".repeat(64),
    mutatesWorkspace,
    usesMediatedNetwork,
  });
  return {
    id: "draft-review",
    protocolVersion: 1 as const,
    capabilities: {
      persistentSessions: true,
      candidateWorkspace: true,
      mediatedNetwork: true,
      liveProgress: true,
      artifactPublication: true,
    },
    toolCatalog: [
      authority("read"), authority("grep"), authority("find"), authority("ls"),
      authority("edit", true), authority("write", true), authority("delete_file", true),
      authority("web_search", false, true), authority("web_fetch", false, true),
      authority("workspace_command", true),
    ],
  };
}

function source(name: string, body = "return {};", capabilities: string[] = []): string {
  return `
export default defineWorkflow({
  name: ${JSON.stringify(name)},
  description: "draft fixture",
  inputSchema: { type: "object", additionalProperties: false },
  outputSchema: {},
  capabilities: ${JSON.stringify(capabilities)},
  modelVisible: false,
  async run(flow, args) {
    ${body}
  },
});
`;
}
