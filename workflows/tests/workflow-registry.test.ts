import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  WorkflowRegistry,
  workflowDefinitionHash,
} from "../src/registry/structured-workflows.js";
import {
  WORKFLOW_REGISTRY_POLICY_FILE,
  readWorkflowRegistryPolicy,
} from "../src/registry/workflow-policy.js";
import {
  createWorkflowInvocationSnapshot,
  readWorkflowInvocationSnapshot,
  workflowInvocationFilesystemPaths,
  writeWorkflowInvocationSnapshot,
} from "../src/persistence/workflow-invocation.js";
import {
  MeasurementProfileRegistry,
  type MeasurementProfileDefinition,
} from "../src/measurements/profiles.js";
import {
  WORKFLOW_RUNTIME_API_HASH,
  WORKFLOW_RUNTIME_API_VERSION,
} from "../src/definition/workflow-language.js";
import { stableHash } from "../src/utils/hashes.js";

let root: string;
let builtinDir: string;
let userDir: string;
let projectDir: string;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "workflow-registry-"));
  builtinDir = path.join(root, "builtin");
  userDir = path.join(root, "user");
  projectDir = path.join(root, "project");
  await Promise.all([builtinDir, userDir, projectDir].map(async (directory) =>
    await fs.promises.mkdir(directory, { recursive: true })));
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe("workflow v17 filesystem registry", () => {
  test("discovers only .flow.ts definitions and applies fail-safe namespace policy", async () => {
    await Promise.all([
      writeFlow(builtinDir, "inspect"),
      writeFlow(userDir, "inspect"),
      writeFlow(projectDir, "project-check"),
      fs.promises.writeFile(path.join(userDir, "legacy.flow.js"), "not v17", "utf8"),
      writePolicy(builtinDir, ["inspect"]),
      writePolicy(projectDir, ["project-check"]),
    ]);
    const registry = new WorkflowRegistry();
    await refresh(registry, true);

    expect(registry.list().map((ref) => [ref.id, ref.exposure])).toEqual([
      ["builtin:inspect", "model"],
      ["project:project-check", "model"],
      ["user:inspect", "human"],
    ]);
    expect(registry.get("inspect")).toBeUndefined();
    expect(() => registry.resolve("inspect")).toThrow(/Ambiguous/);
    expect(registry.resolve("builtin:inspect").name).toBe("inspect");
    expect(registry.listInvalid()).toEqual([]);
    expect(Object.isFrozen(registry.resolve("builtin:inspect").parsed)).toBe(true);
    expect(Object.isFrozen(registry.resolve("builtin:inspect").policy)).toBe(true);

    await refresh(registry, false);
    expect(registry.list().map((ref) => ref.id)).toEqual(["builtin:inspect", "user:inspect"]);
  }, 30_000);

  test("rejects unsafe files and malformed policy while keeping valid definitions human-only", async () => {
    await writeFlow(userDir, "safe");
    await fs.promises.writeFile(
      path.join(userDir, WORKFLOW_REGISTRY_POLICY_FILE),
      JSON.stringify({ formatVersion: 1, model: ["safe", "missing"] }),
      "utf8",
    );
    await fs.promises.symlink(path.join(userDir, "safe.flow.ts"), path.join(userDir, "linked.flow.ts"));
    const registry = new WorkflowRegistry();
    await refresh(registry, false);

    expect(registry.resolve("user:safe").exposure).toBe("model");
    expect(registry.listInvalid().map((entry) => [entry.kind, entry.name])).toEqual([
      ["definition", "linked"],
      ["policy", "missing"],
    ]);

    await fs.promises.writeFile(
      path.join(userDir, WORKFLOW_REGISTRY_POLICY_FILE),
      "{not-json",
      "utf8",
    );
    await refresh(registry, false);
    expect(registry.resolve("user:safe").exposure).toBe("human");
    expect(registry.listInvalid().some((entry) => entry.kind === "policy" && /not JSON/.test(entry.error))).toBe(true);
  }, 30_000);

  test("filename identity makes copy and rename explicit while exposure remains non-semantic", async () => {
    await writeFlow(userDir, "alpha");
    await writePolicy(userDir, ["alpha"]);
    const registry = new WorkflowRegistry();
    await refresh(registry, false);
    const alpha = registry.resolve("user:alpha");

    await fs.promises.copyFile(path.join(userDir, "alpha.flow.ts"), path.join(userDir, "beta.flow.ts"));
    await refresh(registry, false);
    const beta = registry.resolve("user:beta");
    expect(beta.exposure).toBe("human");
    expect(beta.definitionHash).not.toBe(alpha.definitionHash);

    await fs.promises.rename(path.join(userDir, "alpha.flow.ts"), path.join(userDir, "gamma.flow.ts"));
    await refresh(registry, false);
    const gammaHuman = registry.resolve("user:gamma");
    expect(gammaHuman.exposure).toBe("human");
    expect(registry.listInvalid().some((entry) => entry.kind === "policy" && entry.name === "alpha")).toBe(true);

    await writePolicy(userDir, ["gamma"]);
    await refresh(registry, false);
    const gammaModel = registry.resolve("user:gamma");
    expect(gammaModel.exposure).toBe("model");
    expect(gammaModel.definitionHash).toBe(gammaHuman.definitionHash);
    expect(workflowDefinitionHash(gammaModel.id, gammaModel.parsed)).toBe(gammaModel.definitionHash);

    await writeFlow(userDir, "gamma", "Edited description.");
    await refresh(registry, false);
    expect(registry.resolve("user:gamma").definitionHash).not.toBe(gammaModel.definitionHash);
  }, 30_000);

  test("policy snapshots have canonical semantic revisions", async () => {
    const absent = await readWorkflowRegistryPolicy(userDir, "user");
    await writePolicy(userDir, []);
    const explicit = await readWorkflowRegistryPolicy(userDir, "user");
    expect(absent.source).toBe("default");
    expect(explicit.source).toBe("file");
    expect(absent.hash).toBe(explicit.hash);

    await writePolicy(userDir, ["zeta", "alpha"]);
    const sorted = await readWorkflowRegistryPolicy(userDir, "user");
    expect(sorted.model).toEqual(["alpha", "zeta"]);
    expect(sorted.hash).not.toBe(absent.hash);
  });
});

describe("workflow v17 invocation snapshots", () => {
  test("binds launch actor and exact policy without admitting model launches of human workflows", async () => {
    await writeFlow(userDir, "private");
    const registry = new WorkflowRegistry();
    await refresh(registry, false);
    const ref = registry.resolve("user:private");
    expect(() => createWorkflowInvocationSnapshot(ref, { objective: "inspect" }, {
      authority: "model",
    })).toThrow(/human-only/);

    const snapshot = createWorkflowInvocationSnapshot(ref, { objective: "inspect" }, {
      authority: "user",
    });
    expect(snapshot).toMatchObject({
      workflowId: "user:private",
      exposure: "human",
      launch: { authority: "user", policyHash: ref.policy.hash },
      runtimeApiVersion: WORKFLOW_RUNTIME_API_VERSION,
      runtimeApiHash: WORKFLOW_RUNTIME_API_HASH,
      definitionHash: ref.definitionHash,
      sourceHash: ref.sourceHash,
    });
    expect(snapshot.source).toBe(ref.source);
    expect(snapshot.executableSource).toBe(ref.parsed.executableSource);
    expect(Object.isFrozen(snapshot.input)).toBe(true);
    expect(() => createWorkflowInvocationSnapshot(ref, {}, { authority: "user" })).toThrow(/Invalid arguments/);

    await writePolicy(userDir, ["private"]);
    await refresh(registry, false);
    expect(snapshot.exposure).toBe("human");
    expect(snapshot.launch.policyHash).toBe(ref.policy.hash);
    expect(registry.resolve("user:private").definitionHash).toBe(snapshot.definitionHash);

    await writeFlow(projectDir, "trusted-project");
    await refresh(registry, true);
    const project = registry.resolve("project:trusted-project");
    expect(() => createWorkflowInvocationSnapshot(project, { objective: "inspect" }, {
      authority: "user",
    })).toThrow(/requires project trust/);
    expect(createWorkflowInvocationSnapshot(project, { objective: "inspect" }, {
      authority: "user",
      projectTrusted: true,
    }).launch.projectTrusted).toBe(true);
  }, 30_000);

  test("resolves and pins invocation-selected measurement authority with exact output roles", async () => {
    await writeDynamicMeasurementFlow(userDir, "optimize");
    await writePolicy(userDir, ["optimize"]);
    const registry = new WorkflowRegistry();
    await refresh(registry, false);
    const profiles = await measurementRegistry(root, BENCH_PROFILE);
    const args = optimizeArgs();
    const snapshot = createWorkflowInvocationSnapshot(registry.resolve("user:optimize"), args, {
      authority: "model",
      measurementProfiles: profiles,
    });

    expect(snapshot.resources).toHaveLength(1);
    expect(snapshot.resources[0]).toMatchObject({
      inputPath: "/evaluator",
      identity: {
        kind: "measurement-profile",
        selector: "builtin:bench",
        snapshotHash: profiles.resolve("builtin:bench").hash,
      },
      uses: [{
        metricPolicyPath: "/metrics",
        outputs: [
          { output: "latency", role: "primary" },
          { output: "rss", role: "guardrail" },
        ],
      }],
    });
    expect(snapshot.resources[0]!.bindingHash).toMatch(/^sha256:/);
    expect(snapshot.resources[0]!.uses[0]!.policy).toEqual(args.metrics);
    expect(snapshot.resourcesHash).toBe(stableHash(snapshot.resources));

    const changedProfiles = await measurementRegistry(root, { ...BENCH_PROFILE, argv: ["/usr/bin/false"] });
    expect(snapshot.resources[0]!.profile.argv).toEqual(["/usr/bin/true"]);
    expect(changedProfiles.resolve("builtin:bench").hash).not.toBe(snapshot.resources[0]!.profile.hash);

    expect(() => createWorkflowInvocationSnapshot(registry.resolve("user:optimize"), {
      ...args,
      metrics: { primary: { output: "missing", direction: "minimize" } },
    }, { authority: "user", measurementProfiles: profiles })).toThrow(/has no output missing/);
    expect(() => createWorkflowInvocationSnapshot(registry.resolve("user:optimize"), {
      ...args,
      metrics: {
        ...args.metrics,
        observe: [{ output: "latency", direction: "minimize" }],
      },
    }, { authority: "user", measurementProfiles: profiles })).toThrow(/Duplicate optimization output latency/);
    expect(() => createWorkflowInvocationSnapshot(registry.resolve("user:optimize"), {
      ...args,
      evaluator: "project:bench",
    }, { authority: "user", measurementProfiles: profiles })).toThrow(/requires project trust/);
  }, 30_000);

  test("writes and independently reconstructs canonical immutable snapshot files", async () => {
    await writeFlow(userDir, "persisted");
    await writePolicy(userDir, ["persisted"]);
    const registry = new WorkflowRegistry();
    await refresh(registry, false);
    const snapshot = createWorkflowInvocationSnapshot(
      registry.resolve("user:persisted"),
      { objective: "persist" },
      { authority: "model" },
    );
    const runDir = path.join(root, "run");
    await writeWorkflowInvocationSnapshot(runDir, snapshot);
    const paths = workflowInvocationFilesystemPaths(runDir);
    expect(await fs.promises.readFile(paths.source, "utf8")).toBe(snapshot.source);
    expect(await fs.promises.readFile(paths.executable, "utf8")).toBe(snapshot.executableSource);
    expect((await fs.promises.stat(paths.source)).mode & 0o777).toBe(0o600);

    await writeFlow(userDir, "persisted", "Live definition changed.");
    await writePolicy(userDir, []);
    const restored = await readWorkflowInvocationSnapshot(runDir);
    expect(restored.snapshotHash).toBe(snapshot.snapshotHash);
    expect(restored.definitionHash).toBe(snapshot.definitionHash);
    expect(restored.exposure).toBe("model");
    expect(Object.isFrozen(restored.resources)).toBe(true);
    await expect(writeWorkflowInvocationSnapshot(runDir, snapshot)).rejects.toMatchObject({ code: "EEXIST" });
  }, 30_000);

  test("rejects snapshot source or transform tampering", async () => {
    await writeFlow(userDir, "tamper");
    const registry = new WorkflowRegistry();
    await refresh(registry, false);
    const snapshot = createWorkflowInvocationSnapshot(
      registry.resolve("user:tamper"),
      { objective: "test" },
      { authority: "user" },
    );
    const runDir = path.join(root, "tamper-run");
    await writeWorkflowInvocationSnapshot(runDir, snapshot);
    const paths = workflowInvocationFilesystemPaths(runDir);
    await fs.promises.appendFile(paths.executable, "\n// changed\n", "utf8");
    await expect(readWorkflowInvocationSnapshot(runDir)).rejects.toThrow(/source transform is corrupt/);
  }, 30_000);
});

const BENCH_PROFILE: MeasurementProfileDefinition = {
  name: "bench",
  description: "Deterministic test benchmark.",
  argv: ["/usr/bin/true"],
  timeoutMs: 1_000,
  outputs: {
    latency: { extract: { kind: "json-path", path: "$.latency" } },
    rss: { extract: { kind: "json-path", path: "$.rss" } },
  },
};

function simpleFlow(description: string): string {
  return `import { schema as s, workflow } from "pi/workflows";
const Input = s.object({ objective: s.string({ minLength: 1, maxLength: 200 }) });
const Output = s.object({ objective: s.string() });
export default workflow({
  description: ${JSON.stringify(description)},
  input: Input,
  output: Output,
  async run(_flow, input) { return { objective: input.objective }; },
});
`;
}

async function writeFlow(directory: string, name: string, description = "Registry fixture."): Promise<void> {
  await fs.promises.writeFile(path.join(directory, `${name}.flow.ts`), simpleFlow(description), "utf8");
}

async function writeDynamicMeasurementFlow(directory: string, name: string): Promise<void> {
  const source = `import { schema as s, workflow } from "pi/workflows";
const Metric = s.object({ output: s.string(), direction: s.enum(["minimize", "maximize"]) });
const Input = s.object({
  evaluator: s.measurementProfile(),
  metrics: s.object({
    primary: Metric,
    guardrails: s.optional(s.array(s.object({
      output: s.string(),
      direction: s.enum(["minimize", "maximize"]),
      reference: s.enum(["baseline", "best"]),
      maximumRelativeRegression: s.number({ minimum: 0 }),
    }))),
    observe: s.optional(s.array(Metric)),
  }),
});
const Output = s.object({ ok: s.boolean() });
export default workflow({
  description: "Dynamic measurement fixture.", input: Input, output: Output,
  async run(flow, input) {
    const metrics = flow.metrics(input.metrics);
    await flow.measure(input.evaluator, metrics);
    return { ok: true };
  },
});
`;
  await fs.promises.writeFile(path.join(directory, `${name}.flow.ts`), source, "utf8");
}

async function writePolicy(directory: string, model: string[]): Promise<void> {
  await fs.promises.writeFile(
    path.join(directory, WORKFLOW_REGISTRY_POLICY_FILE),
    `${JSON.stringify({ formatVersion: 1, model })}\n`,
    "utf8",
  );
}

async function refresh(registry: WorkflowRegistry, includeProject: boolean): Promise<void> {
  await registry.refresh(root, { builtinDir, userDir, projectDir, includeProject });
}

async function measurementRegistry(
  cwd: string,
  profile: MeasurementProfileDefinition,
): Promise<MeasurementProfileRegistry> {
  const registry = new MeasurementProfileRegistry();
  await registry.refresh(cwd, {
    builtins: [profile],
    userDir: path.join(root, "missing-measurements"),
    includeProject: false,
  });
  return registry;
}

function optimizeArgs() {
  return {
    evaluator: "builtin:bench",
    metrics: {
      primary: { output: "latency", direction: "minimize" },
      guardrails: [{
        output: "rss",
        direction: "minimize",
        reference: "baseline",
        maximumRelativeRegression: 0.05,
      }],
    },
  };
}
