import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowDraftService } from "../src/drafts/service.js";
import { WorkflowDraftStore } from "../src/drafts/store.js";
import {
  projectWorkflowDraftPromotion,
  projectWorkflowDraftReview,
} from "../src/projection/approval-inspectors.js";
import { WorkflowRegistry } from "../src/registry/structured-workflows.js";
import {
  readWorkflowRegistryPolicy,
  WORKFLOW_REGISTRY_PROMOTION_FILE,
} from "../src/registry/workflow-policy.js";
import {
  presentWorkflowInvocationSchema,
  workflowNamedToolParameters,
} from "../src/tool/named-workflow.js";
import { normalizeMeasurementProfile, type MeasurementProfileSnapshot } from "../src/measurements/profiles.js";
import { stableHash } from "../src/utils/hashes.js";
import { registerWorkflowDraftTool } from "../src/tool/workflow-draft.js";

const roots: string[] = [];
const API = path.resolve("workflow-api.d.ts");
const BUILTINS = path.resolve("src/builtins");
const CORPUS = path.resolve("tests/conformance/v17/typecheck/corpus");

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("workflow v17 draft authoring", () => {
  it("strictly reviews inert .flow.ts drafts and exposes derived authority", async () => {
    const fixture = setup();
    const ctx = context(fixture.project, true);
    const invalid = await fixture.service.create({
      namespace: "user",
      name: "invalid",
      source: "not TypeScript",
    }, ctx as any);
    expect(invalid.targetPath).toBe(path.join(fixture.userTarget, "invalid.flow.ts"));
    expect(await fixture.service.validate("user:invalid", ctx as any)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ severity: "error" })]),
    });

    const source = fs.readFileSync(path.join(CORPUS, "optimize.flow.ts"), "utf8");
    await fixture.service.create({ namespace: "project", name: "optimize", source }, ctx as any);
    const review = await fixture.service.validate("project:optimize", ctx as any);
    expect(review).toMatchObject({
      runtimeVersion: 17,
      valid: true,
      definitionControlLoad: "passed",
      capabilities: expect.arrayContaining(["candidate-write", "host-command", "human-input"]),
      authority: { candidateWrite: true, hostCommand: true, humanInput: true, applySites: 1 },
      dynamicResources: [
        expect.objectContaining({ kind: "measurement-profile", inputPath: "/evaluator" }),
        expect.objectContaining({ kind: "measurement-profile", inputPath: "/evaluator" }),
      ],
      operations: {
        staticSites: expect.any(Number),
        concurrentSites: 0,
        nativeLoops: [expect.objectContaining({ kind: "for", containsEffects: true })],
      },
    });
    expect(review.profiles.map(profile => profile.id)).toEqual([
      "builtin:implementer", "builtin:researcher", "builtin:reviewer", "builtin:synthesizer",
    ]);
    expect(projectWorkflowDraftReview(review)).toMatchObject({
      runtimeVersion: 17,
      valid: true,
      definition: { currentExposure: "human" },
      dynamicResources: [expect.objectContaining({ inputPath: "/evaluator" }), expect.any(Object)],
    });
  }, 30_000);

  it("binds promotion to source, review, policy, target exposure, and installed preimage", async () => {
    const fixture = setup();
    const ctx = context(fixture.project, true);
    const first = await fixture.service.create({
      namespace: "user", name: "promote", source: simpleSource("version one"),
    }, ctx as any);
    const stale = await fixture.service.promotionChallenge("user:promote", "model", ctx as any);
    const second = await fixture.service.replace({
      namespace: "user", name: "promote", source: simpleSource("version two"), expectedSourceHash: first.sourceHash,
    }, ctx as any);
    await expect(fixture.service.promote(
      "user:promote", "model", stale.challenge.challengeHash, ctx as any,
    )).rejects.toThrow(/stale/iu);

    const prepared = await fixture.service.promotionChallenge("user:promote", "model", ctx as any);
    expect(projectWorkflowDraftPromotion(prepared.review, prepared.challenge)).toMatchObject({
      challenge: {
        draftHash: second.sourceHash,
        targetExposure: "model",
        currentPolicyHash: prepared.review.definition?.policyHash,
      },
    });
    const promoted = await fixture.service.promote(
      "user:promote", "model", prepared.challenge.challengeHash, ctx as any,
    );
    expect(promoted).toMatchObject({ sourceHash: second.sourceHash, exposure: "model" });
    expect(promoted.installedPath).toBe(path.join(fixture.userTarget, "promote.flow.ts"));
    expect(fs.readFileSync(promoted.installedPath, "utf8")).toBe(second.source);
    expect(await readWorkflowRegistryPolicy(fixture.userTarget, "user")).toMatchObject({
      model: ["promote"],
      hash: promoted.policyHash,
    });
    const registry = new WorkflowRegistry();
    await registry.refresh(fixture.project, {
      builtinDir: path.join(fixture.root, "missing-builtins"),
      userDir: fixture.userTarget,
      includeProject: false,
      apiPath: API,
    });
    expect(registry.listInvalid()).toEqual([]);
    expect(registry.resolve("user:promote")).toMatchObject({ exposure: "model" });
    await expect(fixture.service.inspect("user:promote", ctx as any)).rejects.toThrow();

    await fixture.service.create({
      namespace: "user", name: "promote", source: simpleSource("version three"),
    }, ctx as any);
    const human = await fixture.service.promotionChallenge("user:promote", "human", ctx as any);
    await fixture.service.promote("user:promote", "human", human.challenge.challengeHash, ctx as any);
    expect(await readWorkflowRegistryPolicy(fixture.userTarget, "user")).toMatchObject({ model: [] });
    await registry.refresh(fixture.project, {
      builtinDir: path.join(fixture.root, "missing-builtins"),
      userDir: fixture.userTarget,
      includeProject: false,
      apiPath: API,
    });
    expect(registry.resolve("user:promote")).toMatchObject({ exposure: "human" });
  }, 30_000);

  it("fails registry discovery closed and exactly resumes a crashed two-file promotion", async () => {
    let fail = true;
    const fixture = setup({
      promotionFault: point => {
        if (fail && point === "after-source") {
          fail = false;
          throw new Error("simulated promotion crash");
        }
      },
    });
    const ctx = context(fixture.project, true);
    await fixture.service.create({ namespace: "user", name: "recover", source: simpleSource("recover") }, ctx as any);
    const prepared = await fixture.service.promotionChallenge("user:recover", "model", ctx as any);
    await expect(fixture.service.promote(
      "user:recover", "model", prepared.challenge.challengeHash, ctx as any,
    )).rejects.toThrow(/simulated promotion crash/);
    expect(fs.existsSync(path.join(fixture.userTarget, WORKFLOW_REGISTRY_PROMOTION_FILE))).toBe(true);

    const blocked = new WorkflowRegistry();
    await blocked.refresh(fixture.project, {
      builtinDir: path.join(fixture.root, "missing-builtins"), userDir: fixture.userTarget,
      includeProject: false, apiPath: API,
    });
    expect(blocked.list()).toEqual([]);
    expect(blocked.listInvalid()).toEqual([
      expect.objectContaining({ kind: "policy", error: expect.stringMatching(/incomplete promotion/) }),
    ]);

    const promoted = await fixture.service.promote(
      "user:recover", "model", prepared.challenge.challengeHash, ctx as any,
    );
    expect(promoted).toMatchObject({ exposure: "model", reviewHash: prepared.review.reviewHash });
    expect(fs.existsSync(path.join(fixture.userTarget, WORKFLOW_REGISTRY_PROMOTION_FILE))).toBe(false);
    const registry = new WorkflowRegistry();
    await registry.refresh(fixture.project, {
      builtinDir: path.join(fixture.root, "missing-builtins"), userDir: fixture.userTarget,
      includeProject: false, apiPath: API,
    });
    expect(registry.resolve("user:recover")).toMatchObject({ exposure: "model" });
  }, 30_000);
});

describe("workflow v17 model tool presentation", () => {
  it("emits exact workflow branches and trust-filtered measurement-profile enums", async () => {
    const root = temporaryRoot();
    const registry = new WorkflowRegistry();
    await registry.refresh(root, {
      builtinDir: BUILTINS,
      userDir: path.join(root, "missing-user"),
      includeProject: false,
      apiPath: API,
    });
    const builtin = measurementProfile("builtin", "safe-bench");
    const project = measurementProfile("project", "private-bench");
    const schema = workflowNamedToolParameters({
      definitions: registry.list(),
      measurementProfiles: [builtin],
    }) as any;
    const optimize = schema.oneOf.find((branch: any) => branch.properties.name.enum.includes("builtin:optimize"));
    expect(optimize.properties.args.properties.evaluator).toMatchObject({
      type: "string",
      enum: ["builtin:safe-bench"],
    });
    expect(JSON.stringify(schema)).not.toContain("private-bench");
    expect(schema.oneOf).toHaveLength(6);
    expect(schema.oneOf.every((branch: any) => branch.properties.name.enum.includes(branch.properties.name.enum[0]))).toBe(true);

    const sourceSchema = registry.resolve("builtin:optimize").input;
    const presented = presentWorkflowInvocationSchema(sourceSchema, [builtin, project]);
    expect((presented as any).properties.evaluator.enum).toEqual(["builtin:safe-bench", "project:private-bench"]);
    expect(JSON.stringify(sourceSchema)).toContain("x-pi-workflow-resource");
    expect(JSON.stringify(presented)).not.toContain("x-pi-workflow-resource");
  });

  it("stages only inert TypeScript source through the v17 draft tool", async () => {
    const fixture = setup();
    const ctx = context(fixture.project, true);
    let registered: any;
    registerWorkflowDraftTool({ registerTool: (tool: unknown) => { registered = tool; } } as any, fixture.service);
    expect(registered).toMatchObject({
      name: "workflow_draft",
      description: expect.stringContaining("TypeScript .flow.ts"),
      parameters: { additionalProperties: false },
    });
    const created = await registered.execute("call-1", {
      action: "create", namespace: "user", name: "tool-draft", source: simpleSource("tool draft"),
    }, undefined, undefined, ctx);
    expect(created.details).toMatchObject({ runtimeVersion: 17, action: "create", draftId: "user:tool-draft" });
    const validated = await registered.execute("call-2", {
      action: "validate", namespace: "user", name: "tool-draft",
    }, undefined, undefined, ctx);
    expect(validated.details).toMatchObject({
      runtimeVersion: 17,
      action: "validate",
      review: { runtimeVersion: 17, valid: true },
    });
    expect(fs.existsSync(path.join(fixture.userTarget, "tool-draft.flow.ts"))).toBe(false);
  }, 20_000);
});

function setup(options: { promotionFault?: (point: "after-marker" | "after-source" | "after-policy" | "after-commit") => void } = {}) {
  const root = temporaryRoot();
  const project = path.join(root, "project");
  const userTarget = path.join(root, "user-workflows");
  const projectTarget = path.join(project, ".pi", "workflows");
  fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({
    scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
  }));
  const store = new WorkflowDraftStore({
    root: path.join(root, "drafts"),
    userTargetDir: userTarget,
    projectTargetDir: () => projectTarget,
    ...(options.promotionFault ? { promotionFault: options.promotionFault } : {}),
  });
  const service = new WorkflowDraftService({ getThinkingLevel: () => "low" } as any, {
    store,
    executorDescriptor: executorDescriptor(),
    routeFile: path.join(root, "no-routes.json"),
    apiPath: API,
  });
  return { root, project, userTarget, projectTarget, store, service };
}

function context(cwd: string, trusted: boolean) {
  return {
    cwd,
    mode: "rpc",
    hasUI: true,
    model: { provider: "test", id: "model" },
    modelRegistry: { getAvailable: () => [{ provider: "test", id: "model" }] },
    isProjectTrusted: () => trusted,
    ui: {},
  };
}

function simpleSource(label: string): string {
  return `
import { schema as s, workflow } from "pi/workflows";
export default workflow({
  description: ${JSON.stringify(label)},
  input: s.object({ value: s.optional(s.string()) }),
  output: s.object({ value: s.string() }),
  async run(_flow, args) { return { value: args.value ?? ${JSON.stringify(label)} }; },
});
`;
}

function executorDescriptor() {
  const authority = (name: string, mutatesWorkspace = false, usesMediatedNetwork = false) => ({
    name, schemaHash: "0".repeat(64), mutatesWorkspace, usesMediatedNetwork,
  });
  return {
    id: "workflow-draft-review",
    protocolVersion: 1 as const,
    capabilities: {
      persistentSessions: true, candidateWorkspace: true, mediatedNetwork: true,
      liveProgress: true, artifactPublication: true,
    },
    toolCatalog: [
      authority("read"), authority("grep"), authority("find"), authority("ls"),
      authority("edit", true), authority("write", true), authority("delete_file", true),
      authority("web_search", false, true), authority("web_fetch", false, true),
      authority("workspace_command", true),
    ],
  };
}

function measurementProfile(namespace: "builtin" | "project", name: string): MeasurementProfileSnapshot {
  const definition = normalizeMeasurementProfile({
    name,
    description: `${name} fixture`,
    argv: ["/usr/bin/true"],
    timeoutMs: 1_000,
    outputs: { latency: { extract: { kind: "protocol" } } },
  });
  return {
    ...definition,
    id: `${namespace}:${name}`,
    namespace,
    path: `/profiles/${name}.json`,
    hash: stableHash({ namespace, definition }),
  };
}

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-phase15-"));
  roots.push(root);
  return root;
}
