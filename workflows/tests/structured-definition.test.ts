import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseStructuredWorkflow } from "../src/definition/workflow-definition.js";
import {
  StructuredWorkflowRegistry,
  createWorkflowInvocationSnapshot,
  writeWorkflowInvocationSnapshot,
} from "../src/registry/structured-workflows.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
});

describe("structured workflow definitions", () => {
  it("parses every complete built-in definition", async () => {
    const registry = new StructuredWorkflowRegistry();
    await registry.refresh(process.cwd(), { includeProject: false, userDir: await emptyDir() });
    expect(registry.listInvalid()).toEqual([]);
    expect(registry.list().map((ref) => ref.id)).toEqual([
      "builtin:coding",
      "builtin:execute-plan",
      "builtin:goal",
      "builtin:optimize",
      "builtin:package-audit",
      "builtin:research",
    ]);
    expect(registry.list().every((ref) => ref.sourceHash === ref.parsed.sourceHash)).toBe(true);
    for (const ref of registry.list()) {
      expect(ref.parsed.operationLocations.every((operation) => /^[a-z][a-z0-9_-]{0,63}$/.test(operation.id))).toBe(true);
      assertBoundedResultSchema(ref.outputSchema);
    }
  });

  it("keeps checkpoint and measurement-only workflows as focused test fixtures", async () => {
    for (const name of ["checkpoint.flow.js", "measurement-loop.flow.js"]) {
      const source = await fs.promises.readFile(path.join(process.cwd(), "tests", "fixtures", "workflows", name), "utf8");
      const parsed = parseStructuredWorkflow(source);
      expect(parsed.metadata.modelVisible).toBe(false);
      expect(parsed.operationLocations.length).toBeGreaterThan(0);
    }
  });

  it("uses explicit namespaces and rejects ambiguous unqualified names", async () => {
    const root = await tempDir();
    const builtin = path.join(root, "builtin");
    const user = path.join(root, "user");
    const project = path.join(root, "project");
    await Promise.all([builtin, user, project].map((dir) => fs.promises.mkdir(dir, { recursive: true })));
    await fs.promises.writeFile(path.join(builtin, "demo.flow.js"), simpleSource("demo"));
    await fs.promises.writeFile(path.join(user, "demo.flow.js"), simpleSource("demo"));
    await fs.promises.writeFile(path.join(project, "private.flow.js"), simpleSource("private"));

    const registry = new StructuredWorkflowRegistry();
    await registry.refresh(root, { builtinDir: builtin, userDir: user, projectDir: project, includeProject: false });
    expect(registry.list().map((ref) => ref.id)).toEqual(["builtin:demo", "user:demo"]);
    expect(() => registry.resolve("demo")).toThrow(/Ambiguous/);
    expect(registry.resolve("user:demo").namespace).toBe("user");
    expect(() => registry.resolve("project:private")).toThrow(/Unknown/);

    await registry.refresh(root, { builtinDir: builtin, userDir: user, projectDir: project, includeProject: true });
    expect(registry.resolve("private").id).toBe("project:private");
  });

  it("discovers only bounded regular .flow.js files", async () => {
    const root = await tempDir();
    const builtin = path.join(root, "builtin");
    const user = path.join(root, "user");
    await fs.promises.mkdir(builtin, { recursive: true });
    await fs.promises.mkdir(user, { recursive: true });
    const target = path.join(root, "outside.flow.js");
    await fs.promises.writeFile(target, simpleSource("linked"));
    await fs.promises.symlink(target, path.join(user, "linked.flow.js"));
    await fs.promises.writeFile(path.join(user, "wrong.flow.js"), simpleSource("other"));
    const registry = new StructuredWorkflowRegistry();
    await registry.refresh(root, { builtinDir: builtin, userDir: user, includeProject: false });
    expect(registry.list()).toEqual([]);
    expect(registry.listInvalid().map((entry) => entry.name)).toEqual(["linked", "wrong"]);
  });

  it("canonicalizes, validates, freezes, hashes, and writes an exact invocation snapshot", async () => {
    const root = await tempDir();
    const builtin = path.join(root, "builtin");
    const user = path.join(root, "user");
    await fs.promises.mkdir(builtin, { recursive: true });
    await fs.promises.mkdir(user, { recursive: true });
    await fs.promises.writeFile(path.join(user, "demo.flow.js"), simpleSource("demo"));
    const registry = new StructuredWorkflowRegistry();
    await registry.refresh(root, { builtinDir: builtin, userDir: user, includeProject: false });
    const ref = registry.resolve("user:demo");
    const caller = { value: 3, nested: { z: true, a: "first" } };
    const snapshot = createWorkflowInvocationSnapshot(ref, caller);
    caller.value = 9;
    caller.nested.a = "changed";
    expect(snapshot.input).toEqual({ nested: { a: "first", z: true }, value: 3 });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.input)).toBe(true);
    expect(snapshot.source).toBe(ref.source);
    expect(snapshot.sourceHash).toBe(ref.sourceHash);
    expect(snapshot.runtimeApiHash).toMatch(/^sha256:/);
    expect(snapshot.installedPath).toBe(ref.path);
    expect(snapshot.review).toEqual(ref.parsed.review);

    const runDir = path.join(root, "run");
    await writeWorkflowInvocationSnapshot(runDir, snapshot);
    expect(await fs.promises.readFile(path.join(runDir, "source.flow.js"), "utf8")).toBe(ref.source);
    expect(JSON.parse(await fs.promises.readFile(path.join(runDir, "context", "invocation.json"), "utf8")).input).toEqual(snapshot.input);
    await expect(writeWorkflowInvocationSnapshot(runDir, snapshot)).rejects.toMatchObject({ code: "EEXIST" });
    expect(() => createWorkflowInvocationSnapshot(ref, { value: "wrong" })).toThrow(/Invalid arguments/);
  });

  it.each([
    ["ambient process", `const x = process.env;`],
    ["ambient time", `const x = Date.now();`],
    ["ambient Intl wall clock", `const x = Intl.DateTimeFormat("en-US", { second: "numeric" }).format();`],
    ["ambient Temporal clock", `const x = Temporal.Now.instant();`],
    ["randomness", `const x = Math.random();`],
    ["aliased randomness", `const math = Math; return { value: math.random() };`],
    ["destructured randomness", `const { random } = Math; return { value: random() };`],
    ["imports", `import fs from "node:fs";`],
    ["while", `while (true) {}`],
    ["promise fanout", `await Promise.all([]);`],
    ["unawaited effect", `const pending = flow.stage("work", async () => null); return pending;`],
    ["invalid id", `await flow.stage("Not valid", async () => null);`],
    ["aliased flow object", `const other = flow; await other.stage("work", async () => null);`],
    ["aliased flow method", `const stage = flow.stage; await stage("work", async () => null);`],
    ["aliased invocation mutation", `const input = args; input.value = 2;`],
    ["destructured invocation mutation", `const { nested } = args; nested.value = 2;`],
    ["captured branch mutation", `let x = 0; await flow.parallel("work", { a: async () => { x++; return null; } });`],
    ["aliased captured branch mutation", `const x = []; await flow.parallel("work", { a: async () => { const alias = x; alias.push(1); return null; } });`],
    ["captured mutating helper", `const x = []; const mutate = () => x.push(1); await flow.parallel("work", { a: async () => { mutate(); return null; } });`],
    ["effectful for", `for (let i = 0; i < 3; i++) await flow.stage("work", async () => null);`],
    ["mutated local for counter", `for (let i = 0; i < 3; i++) { i--; }`],
    ["captured local for counter mutation", `for (let i = 0; i < 3; i++) { const reset = () => { i = 0; }; reset(); }`],
    ["destructured local for counter mutation", `for (let i = 0; i < 3; i++) { [i] = [0]; }`],
    ["binary allocation", `const bytes = new ArrayBuffer(1024); return { size: bytes.byteLength };`],
  ])("rejects %s before execution", (_label, body) => {
    expect(() => parseStructuredWorkflow(simpleSource("invalid", body))).toThrow();
  });

  it("rejects mutable top-level state", () => {
    expect(() => parseStructuredWorkflow(`let value = 1;\n${simpleSource("invalid")}`)).toThrow(/Top level/);
  });

  it("enforces read-only parallel scopes and candidate-scoped writes lexically", () => {
    expect(() =>
      parseStructuredWorkflow(simpleSource("parallel-write", `
        await flow.parallel("work", { a: () => flow.candidate("write", async () => null) });
      `, { capabilities: ["read-project", "candidate-write"] })),
    ).toThrow(/read-only parallel/);
    expect(() =>
      parseStructuredWorkflow(simpleSource("candidate-read", `
        return await flow.candidate("attempt", async workspace => flow.agent("edit", { profile: "builtin:implementer", prompt: "x" }));
      `, { capabilities: ["read-project", "candidate-write"] })),
    ).toThrow(/requires the candidate workspace/);
    expect(() =>
      parseStructuredWorkflow(simpleSource("candidate-fake", `
        return await flow.candidate("attempt", async workspace => flow.candidate("nested", async () => workspace));
      `, { capabilities: ["candidate-write"] })),
    ).toThrow(/unavailable inside candidate/);
  });

  it("rejects unconditional duplicate sibling ids but permits exclusive branches", () => {
    expect(() =>
      parseStructuredWorkflow(simpleSource("duplicate", `await flow.stage("same", async () => null); await flow.stage("same", async () => null);`)),
    ).toThrow(/Duplicate sibling operation id/);
    expect(() =>
      parseStructuredWorkflow(simpleSource("exclusive", `if (args.value > 0) await flow.stage("same", async () => null); else await flow.stage("same", async () => null);`)),
    ).not.toThrow();
  });

  it("rejects direct and mutual recursion", () => {
    const direct = `
function recurse() { return recurse(); }
${simpleSource("recursive", "return recurse();")}`;
    expect(() => parseStructuredWorkflow(direct)).toThrow(/Recursive/);
    const mutual = `
function a() { return b(); }
function b() { return a(); }
${simpleSource("recursive", "return a();")}`;
    expect(() => parseStructuredWorkflow(mutual)).toThrow(/Recursive/);
    expect(() =>
      parseStructuredWorkflow(
        simpleSource("recursive", `const again = () => again(); return again();`),
      ),
    ).toThrow(/Recursive/);
  });

  it("validates durable checkpoint shape and capability before execution", () => {
    expect(() => parseStructuredWorkflow(simpleSource("checkpoint", `
      return await flow.checkpoint("review", {
        kind: "choice",
        prompt: "Choose",
        choices: [{ id: "same", label: "A" }, { id: "same", label: "B" }],
      });
    `, { capabilities: ["human-input"] }))).toThrow(/Duplicate checkpoint choice/);
    expect(() => parseStructuredWorkflow(simpleSource("checkpoint", `
      return await flow.checkpoint("review", { kind: "confirm", prompt: "Continue?" });
    `))).toThrow(/human-input/);
    expect(() => parseStructuredWorkflow(simpleSource("checkpoint", `
      return await flow.checkpoint("review", { kind: args.kind, prompt: "Continue?" });
    `, { capabilities: ["human-input"] }))).toThrow(/static/);
  });

  it("derives the complete review summary and one-based source locations", () => {
    const parsed = parseStructuredWorkflow(simpleSource("review", `
      const score = flow.metric("score", { direction: "maximize" });
      const prior = await flow.agent("research", {
        profile: "builtin:researcher",
        prompt: "Find primary evidence.",
        network: "research",
        resultMode: "artifact",
      });
      const produced = await flow.candidate("change", async workspace => {
        const result = await flow.agent("edit", {
          profile: "builtin:implementer",
          prompt: "Implement the change.",
          inputs: [{ id: "prior", artifact: prior }],
          workspace,
          network: "research",
        });
        await flow.command("check", {
          profile: "project:focused-check",
          args: { suite: "focused" },
          effect: "candidate",
          workspace,
        });
        return result;
      });
      const measured = await flow.measure("measure", {
        metric: score,
        measurement: "project:benchmark",
        workspace: produced.candidate,
      });
      const verification = await flow.verify("verify", {
        candidate: produced.candidate,
        profile: "project:strict",
      });
      await flow.checkpoint("review", { kind: "confirm", prompt: "Continue?" });
      if (!verification.passed) {
        await flow.reject("reject", { candidate: produced.candidate, measurement: measured, verification, reason: "failed" });
        return { value: args.value };
      }
      const accepted = await flow.accept("accept", { candidate: produced.candidate, measurement: measured, verification });
      await flow.apply("apply", { candidate: accepted, verification });
      return { value: args.value };
    `, {
      capabilities: ["read-project", "candidate-write", "host-command", "mediated-network", "human-input"],
    }));

    expect(parsed.review).toEqual({
      capabilities: ["candidate-write", "host-command", "human-input", "mediated-network", "read-project"],
      agentProfiles: ["builtin:implementer", "builtin:researcher"],
      commandProfiles: ["project:focused-check"],
      measurementProfiles: ["project:benchmark"],
      verificationProfiles: ["project:strict"],
      usesCandidateWrites: true,
      usesMediatedNetwork: true,
      humanCheckpointCount: 1,
      applySiteCount: 1,
    });
    expect(parsed.agentSelections).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspace: "candidate", network: "research" }),
    ]));
    expect(Object.isFrozen(parsed.review)).toBe(true);
    expect(parsed.operationLocations.every((entry) => entry.line >= 1 && entry.column >= 1)).toBe(true);
  });

  it("reports one-based parser and registry diagnostic locations", async () => {
    let caught: unknown;
    try {
      parseStructuredWorkflow(simpleSource("location", `await flow.stage("Bad id", async () => null);`));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ location: { line: expect.any(Number), column: expect.any(Number) } });
    expect((caught as { location: { column: number } }).location.column).toBeGreaterThanOrEqual(1);

    const root = await tempDir();
    const user = path.join(root, "user");
    const builtin = path.join(root, "builtin");
    await Promise.all([user, builtin].map((dir) => fs.promises.mkdir(dir)));
    await fs.promises.writeFile(path.join(user, "location.flow.js"), simpleSource("location", `Date.now();`));
    const registry = new StructuredWorkflowRegistry();
    await registry.refresh(root, { builtinDir: builtin, userDir: user, includeProject: false });
    expect(registry.listInvalid()[0]?.location).toEqual({ line: expect.any(Number), column: expect.any(Number) });
  });

  it("accepts representative goal and execute-plan control programs", () => {
    const goal = parseStructuredWorkflow(simpleSource("goal", `
      let outcome = { status: "handoff", value: args.value };
      await flow.loop("workers", {
        maxIterations: 8,
        while: () => ({ result: outcome.status === "handoff", label: outcome.status }),
      }, async ({ iteration }) => {
        outcome = await flow.agent("worker", {
          profile: "builtin:implementer",
          prompt: \`Complete goal worker \${iteration + 1}\`,
        });
      });
      return outcome;
    `, { capabilities: ["read-project"] }));
    const plan = parseStructuredWorkflow(simpleSource("execute-plan", `
      const plan = await flow.agent("plan", {
        profile: "builtin:reviewer",
        prompt: "Return stable plan points.",
      });
      await flow.loop("points", {
        maxIterations: 16,
        while: () => ({ result: plan.length > 0, label: "remaining points" }),
      }, async ({ iteration }) => {
        await flow.agent("point", {
          profile: "builtin:implementer",
          prompt: \`Execute point \${iteration + 1}\`,
        });
      });
      return { value: args.value };
    `, { capabilities: ["read-project"] }));
    expect(goal.review.agentProfiles).toEqual(["builtin:implementer"]);
    expect(plan.operationLocations.map((entry) => entry.id)).toEqual(["plan", "points", "point"]);
  });

  it("allows a sequential candidate loop to fold point results into candidate-local state", () => {
    const parsed = parseStructuredWorkflow(simpleSource("candidate-plan", `
      const produced = await flow.candidate("workspace", async workspace => {
        let completed = 0;
        await flow.loop("points", {
          maxIterations: 4,
          while: () => ({ result: completed < 2, label: "points remain", operands: { completed } }),
        }, async () => {
          await flow.agent("point", {
            profile: "builtin:implementer",
            prompt: "Execute the next stable point.",
            workspace,
          });
          completed += 1;
        });
        return { completed };
      });
      return produced.metadata;
    `, { capabilities: ["read-project", "candidate-write"] }));
    expect(parsed.operationLocations.map((entry) => entry.id)).toEqual([
      "workspace", "points", "point",
    ]);
  });

  it.each([
    ["sub-orchestration", `await flow.subflow("other", {});`],
    ["exact model", `await flow.agent("work", { profile: "builtin:reviewer", prompt: "x", model: "provider/model" });`],
    ["exact thinking", `await flow.agent("work", { profile: "builtin:reviewer", prompt: "x", thinking: "high" });`],
    ["automatic apply", `await flow.apply("apply", { candidate: {}, verification: {}, confirmation: "automatic" });`],
    ["raw command", `await flow.command("command", { profile: "builtin:check", argv: ["true"] });`],
    ["dynamic operation identity", `await flow.stage(args.value, async () => null);`],
    ["dynamic agent authority", `await flow.agent("work", { profile: args.value, prompt: "x" });`],
    ["dynamic command authority", `await flow.command("command", { profile: args.value });`],
    ["dynamic measurement authority", `const m = flow.metric("m", { direction: "maximize" }); await flow.measure("measure", { metric: m, measurement: args.value });`],
  ])("rejects obsolete or unreviewable %s", (_label, body) => {
    expect(() => parseStructuredWorkflow(simpleSource("rejected", body, {
      capabilities: ["read-project", "candidate-write", "host-command", "human-input"],
    }))).toThrow();
  });

  it("rejects obsolete metadata and undeclared authority", () => {
    const hostPolicy = simpleSource("host-policy").replace(
      "  capabilities:",
      "  executionPolicy: { concurrency: 99 },\n  capabilities:",
    );
    expect(() => parseStructuredWorkflow(hostPolicy)).toThrow(/executionPolicy/);
    expect(() => parseStructuredWorkflow(simpleSource("network", `
      return await flow.agent("research", { profile: "builtin:researcher", prompt: "x", network: "research" });
    `, { capabilities: ["read-project"] }))).toThrow(/mediated-network/);
    expect(() => parseStructuredWorkflow(simpleSource("command", `
      return await flow.command("check", { profile: "builtin:check" });
    `))).toThrow(/host-command/);
    expect(() => parseStructuredWorkflow(simpleSource("candidate", `
      return await flow.candidate("change", async () => null);
    `))).toThrow(/candidate-write/);
  });

  it("keeps the runaway ceiling host-owned and never executes source while parsing", () => {
    const bounded = simpleSource("bounded", `
      await flow.parallel("work", { one: async () => null, two: async () => null }, { concurrency: 3 });
      throw new Error("run() was executed by the parser");
    `).replace("  async run", "  maxParallelism: 2,\n  async run");
    expect(() => parseStructuredWorkflow(bounded)).toThrow(/exceeds the workflow ceiling 2/);

    const notExecuted = simpleSource("not-executed", `
      throw new Error("run() was executed by the parser");
    `);
    expect(() => parseStructuredWorkflow(notExecuted)).not.toThrow();
  });
});

function simpleSource(name: string, body = "return { value: args.value };", options: { capabilities?: string[] } = {}): string {
  return `
export default defineWorkflow({
  name: ${JSON.stringify(name)},
  description: "fixture",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["value"],
    properties: { value: { type: "integer" }, nested: { type: "object" } }
  },
  outputSchema: {},
  capabilities: ${JSON.stringify(options.capabilities ?? [])},
  modelVisible: false,
  async run(flow, args) {
    ${body}
  },
});
`;
}

async function tempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "flow-definition-"));
  temporary.push(dir);
  return dir;
}

async function emptyDir(): Promise<string> {
  const root = await tempDir();
  const dir = path.join(root, "empty");
  await fs.promises.mkdir(dir);
  return dir;
}

function assertBoundedResultSchema(schema: Record<string, unknown>): void {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    if (node.type === "object") expect(node.additionalProperties).toBe(false);
    if (node.type === "array") expect(node.maxItems).toEqual(expect.any(Number));
    if (node.type === "string" && node.enum === undefined && node.const === undefined) {
      expect(node.maxLength).toEqual(expect.any(Number));
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(schema);
}

