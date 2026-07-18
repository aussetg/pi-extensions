import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parseWorkflow } from "../src/definition/workflow-frontend.js";
import type { ParsedWorkflow } from "../src/definition/workflow-types.js";
import { stableHash } from "../src/utils/hashes.js";
import { WorkflowScriptError } from "../src/runtime/errors.js";
import {
  WORKFLOW_RESOURCE_KEY,
  WORKFLOW_SAFE_PATH_KEY,
} from "../src/definition/workflow-schema.js";
import { WORKFLOW_RUNTIME_API_HASH } from "../src/definition/workflow-language.js";

const CORPUS = path.resolve("tests/conformance/typecheck/corpus");
const FILES = [
  "coding.flow.ts",
  "execute-plan.flow.ts",
  "goal.flow.ts",
  "optimize.flow.ts",
  "package-audit.flow.ts",
  "research.flow.ts",
] as const;
const parsedCorpus = new Map<string, ParsedWorkflow>();

describe("workflow TypeScript frontend", () => {
  test.each(FILES)("parses and instruments the strict corpus: %s", (fileName) => {
    const filePath = path.join(CORPUS, fileName);
    const parsed = loadCorpus(fileName);

    expect(parsed.installedName).toBe(fileName.slice(0, -".flow.ts".length));
    expect(parsed.metadata.input.type).toBe("object");
    expect(parsed.operations.length).toBeGreaterThan(0);
    expect(parsed.executableSource).toContain("const __flowDefinition = workflow(");
    expect(parsed.executableSource).toContain("__flowSourceSite(\"site-000000\")");
    expect(parsed.executableSource).not.toMatch(/^\s*import\b/mu);
    expect(parsed.executableSource).not.toMatch(/^\s*export\b/mu);
    for (const descriptor of parsed.descriptors) {
      expect(parsed.executableSource).toContain(`__flowSourceSite(\"${descriptor.identity.sourceSite}\")`);
    }
    expect(parsed.transform.operationSites).toHaveLength(parsed.operations.length);
    expect(parsed.transform.descriptorSites).toHaveLength(parsed.descriptors.length);
    expect(parsed.transform.runtimeApiHash).toBe(WORKFLOW_RUNTIME_API_HASH);
    expect(Object.isFrozen(parsed)).toBe(true);
  }, 20_000);

  test("derives the exact review surface for all six workflows", () => {
    const reviews = Object.fromEntries(FILES.map((fileName) => {
      return [fileName, reviewProjection(loadCorpus(fileName))];
    }));
    expect(reviews).toMatchSnapshot();
  }, 30_000);

  test("derives dynamic resources, writes, and structured concurrency without source IDs", () => {
    const optimize = loadCorpus("optimize.flow.ts");
    expect(optimize.review.dynamicResources).toEqual([
      {
        kind: "measurement-profile",
        inputPath: "/evaluator",
        operationSite: "site-000001",
        metricPolicyPath: "/metrics",
        samplingPath: "/sampling",
      },
      {
        kind: "measurement-profile",
        inputPath: "/evaluator",
        operationSite: "site-000005",
        metricPolicyPath: "/metrics",
        samplingPath: "/sampling",
      },
    ]);
    expect(optimize.review.candidateWrites).toEqual([{
      operationSite: "site-000003",
      mode: "input",
      inputPath: "/writePaths",
    }]);

    const codingParallel = loadCorpus("coding.flow.ts").operations[0];
    expect(codingParallel).toMatchObject({
      sourceSite: "site-000000",
      method: "parallel",
      parallelKeys: ["architecture", "tests", "risks"],
      requestedConcurrency: 3,
      errors: "fail-fast",
    });
    const researchMap = loadCorpus("research.flow.ts").operations.find((site) => site.method === "map");
    expect(researchMap).toMatchObject({ requestedConcurrency: 4, errors: "collect" });
    expect(optimize.operations.every((site) => !Object.hasOwn(site, "id"))).toBe(true);
  });

  test("evaluates the complete strict schema facade and preserves resource authority", () => {
    const parsed = parseWorkflow(`
import { schema as s, workflow } from "pi/workflows";

const Raw = s.raw<{ readonly label: string }>({
  type: "object",
  additionalProperties: false,
  required: ["label"],
  properties: { label: { type: "string" } },
});
const RawAlias = Raw;
const Input = s.object({
  text: s.string({ minLength: 1, maxLength: 20, pattern: "^[a-z]+$", format: "plain" }),
  score: s.number({ minimum: 0, exclusiveMaximum: 10 }),
  count: s.integer({ minimum: 0, maximum: 10 }),
  enabled: s.boolean(),
  exact: s.literal("yes"),
  mode: s.enum(["a", "b"]),
  maybe: s.nullable(s.string()),
  note: s.optional(s.string()),
  values: s.array(s.number(), { minItems: 1, maxItems: 4, uniqueItems: true }),
  choice: s.union([s.string(), s.number()]),
  labels: s.record(s.string()),
  id: s.id(),
  path: s.safePath(),
  payload: s.json(),
  evaluator: s.measurementProfile(),
  raw: RawAlias,
});
const Output = s.object({ ok: s.boolean() });

export default workflow({
  description: "Schema facade probe.",
  input: Input,
  output: Output,
  async run(_flow, _input) { return { ok: true }; },
});
`, { fileName: "schema-probe.flow.ts" });

    const properties = parsed.metadata.input.properties as Record<string, Record<string, unknown>>;
    expect(parsed.metadata.input.additionalProperties).toBe(false);
    expect(parsed.metadata.input.required).not.toContain("note");
    expect(properties.path?.[WORKFLOW_SAFE_PATH_KEY]).toBe(true);
    expect(properties.evaluator?.[WORKFLOW_RESOURCE_KEY]).toBe("measurement-profile");
    expect(properties.choice).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
    expect(properties.raw).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["label"],
      properties: { label: { type: "string" } },
    });
  });

  test("preserves original locations through erasable TypeScript stripping", () => {
    const parsed = parseWorkflow(`
import { agent, schema as s, workflow, type AgentResult } from "pi/workflows";
const Output = s.object({ value: s.string() });
type Output = import("pi/workflows").Infer<typeof Output>;
const inspect = agent({ profile: "builtin:reviewer", output: Output });
export default workflow({
  description: "Location probe.", input: s.object({ prompt: s.string() }), output: Output,
  async run(flow, input): Promise<Output> {
    const result: AgentResult<Output, "snapshot"> = await flow.agent(inspect, { prompt: input.prompt });
    return result.output;
  },
});
`, { fileName: "location-probe.flow.ts" });
    expect(parsed.operations).toHaveLength(1);
    expect(parsed.operations[0]?.location).toEqual({ line: 9, column: 59 });
    expect(parsed.strippedSource).toHaveLength(parsed.source.length);
  });

  test("accepts native effectful loops and flags suspicious unbounded loops for review", () => {
    const parsed = parseWorkflow(workflowSource(`
    let index = 0;
    while (index < input.limit) {
      await flow.agent(inspect, { prompt: String(index) });
      index++;
    }
`), { fileName: "native-loop.flow.ts" });
    expect(parsed.review.nativeLoops).toEqual([{
      kind: "while",
      bound: "unknown",
      containsEffects: true,
      location: { line: 17, column: 5 },
    }]);
    expect(parsed.review.suspiciousUnboundedLoops).toEqual([{ line: 17, column: 5 }]);
  });

  test("accepts a named effectful map helper and propagates its concurrent context", () => {
    const parsed = parseWorkflow(workflowSource(`
    async function inspectItem(item: string) {
      return await flow.agent(inspect, { prompt: item });
    }
    await flow.map(input.items, inspectItem, { key: item => item });
`), { fileName: "helper.flow.ts" });
    expect(parsed.helpers.find((helper) => helper.name === "inspectItem")).toMatchObject({
      effectful: true,
      contexts: ["concurrent"],
      effects: ["agent"],
    });
  });

  test("accepts named parallel and candidate helpers with transitive contexts", () => {
    const parallel = parseWorkflow(workflowSource(`
    async function architecture() { return await flow.agent(inspect, { prompt: "architecture" }); }
    async function tests() { return await flow.agent(inspect, { prompt: "tests" }); }
    await flow.parallel({ architecture, tests });
`), { fileName: "parallel-helpers.flow.ts" });
    expect(parallel.helpers.filter((helper) => helper.effectful).map((helper) => ({
      name: helper.name,
      contexts: helper.contexts,
    }))).toEqual([
      { name: "architecture", contexts: ["concurrent"] },
      { name: "tests", contexts: ["concurrent"] },
    ]);

    const candidate = parseWorkflow(workflowSource(`
    async function implement(workspace: CandidateWorkspace) {
      return (await flow.agent(write, { workspace, prompt: "write" })).output;
    }
    const candidate = await flow.candidate(implement);
    await flow.reject(candidate, { reason: "probe" });
`), { fileName: "candidate-helper.flow.ts" });
    expect(candidate.helpers.find((helper) => helper.name === "implement")).toMatchObject({
      effectful: true,
      contexts: ["candidate"],
      effects: ["agent"],
    });
  });

  test("applies candidate capture restrictions through helper chains", () => {
    expectWorkflowError(() => parseWorkflow(workflowSource(`
    const captured: string[] = [];
    async function implement(workspace: CandidateWorkspace) {
      captured.push("changed");
      return (await flow.agent(write, { workspace, prompt: "write" })).output;
    }
    const candidate = await flow.candidate(implement);
    await flow.reject(candidate, { reason: "probe" });
`), { fileName: "candidate-helper-capture.flow.ts" }), /candidate callback may not mutate captured binding captured/, {
      line: 18,
      column: 7,
    });
  });

  test("does not allow dynamic pure callbacks to hide captured mutation", () => {
    expectWorkflowError(() => parseWorkflow(workflowSource(`
    const captured: string[] = [];
    const candidate = await flow.candidate(async _workspace => {
      input.items.forEach(item => captured.push(item));
      return { value: "done" };
    });
    await flow.reject(candidate, { reason: "probe" });
`), { fileName: "dynamic-mutation.flow.ts" }), /State-mutating helper .*direct lexical call/, {
      line: 18,
      column: 35,
    });
  });

  test("does not allow captured state to be hidden inside a mutable local container", () => {
    expectWorkflowError(() => parseWorkflow(workflowSource(`
    const captured = { value: "outside" };
    const candidate = await flow.candidate(async _workspace => {
      const local: Array<{ value: string }> = [];
      local.push(captured);
      return { value: local[0]?.value ?? "none" };
    });
    await flow.reject(candidate, { reason: "probe" });
`), { fileName: "captured-container.flow.ts" }), /may not store captured state in mutable binding local/, {
      line: 19,
      column: 7,
    });
  });

  test.each([
    {
      name: "effectful recursion",
      body: `
    async function recurse(): Promise<void> {
      await flow.agent(inspect, { prompt: "x" });
      await recurse();
    }
    await recurse();`,
      message: /Recursive workflow helper recurse/,
      location: { line: 16, column: 5 },
    },
    {
      name: "effectful helper escape",
      body: `
    async function work() { return await flow.agent(inspect, { prompt: "x" }); }
    const selected = work;
    await selected();`,
      message: /Effectful helper work may not escape/,
      location: { line: 17, column: 22 },
    },
    {
      name: "dynamic structured callback",
      body: `
    async function left(item: string) { return await flow.agent(inspect, { prompt: item }); }
    async function right(item: string) { return await flow.agent(inspect, { prompt: item }); }
    await flow.map(input.items, input.limit > 1 ? left : right, { key: item => item });`,
      message: /lexically known callback/,
      location: { line: 18, column: 33 },
    },
    {
      name: "human interaction through concurrent helper",
      body: `
    async function ask(item: string) {
      return await flow.ask({ prompt: item, response: Answer });
    }
    await flow.map(input.items, ask, { key: item => item });`,
      message: /flow\.ask is unavailable in concurrent callbacks/,
      location: { line: 17, column: 20 },
    },
    {
      name: "candidate captured mutation",
      body: `
    const captured: string[] = [];
    const candidate = await flow.candidate(async workspace => {
      captured.push("changed");
      return (await flow.agent(write, { workspace, prompt: "write" })).output;
    });
    await flow.reject(candidate, { reason: "probe" });`,
      message: /candidate callback may not mutate captured binding captured/,
      location: { line: 18, column: 7 },
    },
    {
      name: "candidate workspace shared into map lanes",
      body: `
    const candidate = await flow.candidate(async workspace => {
      await flow.map(input.items, async item => {
        await flow.agent(write, { workspace, prompt: item });
        return item;
      }, { key: item => item });
      return { value: "done" };
    });
    await flow.reject(candidate, { reason: "probe" });`,
      message: /Candidate workspace authority may not be shared/,
      location: { line: 18, column: 15 },
    },
    {
      name: "direct Promise concurrency",
      body: `
    await Promise.all([
      flow.agent(inspect, { prompt: "x" }),
      flow.agent(inspect, { prompt: "y" }),
    ]);`,
      message: /Direct Promise concurrency is forbidden/,
      location: { line: 16, column: 11 },
    },
    {
      name: "ambient time",
      body: `
    const now = Date.now();
    await flow.agent(inspect, { prompt: String(now) });`,
      message: /Ambient time is unavailable/,
      location: { line: 16, column: 17 },
    },
  ])("rejects $name at its exact source location", ({ body, message, location: expected }) => {
    expectWorkflowError(
      () => parseWorkflow(workflowSource(body), { fileName: "invalid-helper.flow.ts" }),
      message,
      expected,
    );
  });

  test("rejects non-erasable TypeScript at its original location", () => {
    expectWorkflowError(() => parseWorkflow(`
import { schema as s, workflow } from "pi/workflows";
enum State { Ready }
const Output = s.object({ ok: s.boolean() });
export default workflow({
  description: "Bad enum.", input: s.object({}), output: Output,
  async run() { return { ok: true }; },
});
`, { fileName: "enum.flow.ts" }), /erasable syntax.*enum is not supported/i, { line: 3, column: 1 });
  });

  test("reports strict TypeScript diagnostics at the source expression", () => {
    expectWorkflowError(() => parseWorkflow(`
import { schema as s, workflow } from "pi/workflows";
const Output = s.object({ ok: s.boolean() });
export default workflow({
  description: "Bad result.", input: s.object({}), output: Output,
  async run(_flow, _input) { return { ok: "wrong" }; },
});
`, { fileName: "type-error.flow.ts" }), /TypeScript TS2322/, { line: 6, column: 9 });
  });

  test("rejects imports outside the exact virtual module", () => {
    expectWorkflowError(() => parseWorkflow(`
import { readFile } from "node:fs";
import { schema as s, workflow } from "pi/workflows";
const Output = s.object({ ok: s.boolean() });
export default workflow({ description: "Bad import.", input: s.object({}), output: Output,
  async run() { void readFile; return { ok: true }; } });
`, { fileName: "import.flow.ts" }), /exactly one import/, { line: 3, column: 1 });
  });

  test("rejects type-only imports that the executable stripping pass would erase", () => {
    expectWorkflowError(() => parseWorkflow(`
import type { Stats } from "node:fs";
import { schema as s, workflow } from "pi/workflows";
const Output = s.object({ ok: s.boolean() });
export default workflow({ description: "Hidden import.", input: s.object({}), output: Output,
  async run(_flow, _input) { return { ok: true }; } });
`, { fileName: "type-import.flow.ts" }), /exactly one import/, { line: 3, column: 1 });
  });

  test("rejects type-only named exports erased before Acorn review", () => {
    expectWorkflowError(() => parseWorkflow(`
import { schema as s, workflow } from "pi/workflows";
export interface Hidden { value: string }
const Output = s.object({ ok: s.boolean() });
export default workflow({ description: "Hidden export.", input: s.object({}), output: Output,
  async run(_flow, _input) { return { ok: true }; } });
`, { fileName: "type-export.flow.ts" }), /Only the default workflow definition may be exported/, {
      line: 3,
      column: 1,
    });
  });

  test("rejects TypeScript suppression directives before compilation", () => {
    expectWorkflowError(() => parseWorkflow(`
import { schema as s, workflow } from "pi/workflows";
const Output = s.object({ ok: s.boolean() });
export default workflow({ description: "Suppression.", input: s.object({}), output: Output,
  // @ts-ignore
  async run() { return { ok: "wrong" }; } });
`, { fileName: "suppression.flow.ts" }), /suppression directives/, { line: 5, column: 3 });
  });

  test("rejects inline executable authority even when TypeScript could infer it", () => {
    expectWorkflowError(() => parseWorkflow(`
import { agent, schema as s, workflow, type CandidateWorkspace } from "pi/workflows";
const Output = s.object({ value: s.string() });
export default workflow({ description: "Inline authority.", input: s.object({}), output: Output,
  async run(flow, _input) {
    return (await flow.agent(agent({ profile: "builtin:reviewer", output: Output }), { prompt: "x" })).output;
  } });
`, { fileName: "inline.flow.ts" }), /descriptors must initialize a top-level const/, { line: 6, column: 30 });
  });

  test("raw schemas cannot mint reserved resource authority", () => {
    expectWorkflowError(() => parseWorkflow(`
import { schema as s, workflow } from "pi/workflows";
const Input = s.raw<{ readonly evaluator: string }>({
  type: "object", properties: { evaluator: { type: "string" } },
  required: ["evaluator"], additionalProperties: false,
  "x-pi-workflow-resource": "measurement-profile",
});
const Output = s.object({ ok: s.boolean() });
export default workflow({ description: "Raw authority.", input: Input, output: Output,
  async run(_flow, _input) { return { ok: true }; } });
`, { fileName: "raw-authority.flow.ts" }), /may not mint reserved authority field/, { line: 3, column: 53 });
  });

  test("invocation-selected resources are unavailable in effect output schemas", () => {
    expectWorkflowError(() => parseWorkflow(`
import { agent, schema as s, workflow } from "pi/workflows";
const AgentOutput = s.object({ evaluator: s.measurementProfile() });
const inspect = agent({ profile: "builtin:reviewer", output: AgentOutput });
const Output = s.object({ ok: s.boolean() });
export default workflow({ description: "Resource output.", input: s.object({}), output: Output,
  async run(_flow, _input) { void inspect; return { ok: true }; } });
`, { fileName: "resource-output.flow.ts" }), /Agent output schemas may not mint invocation-selected resources/, {
      line: 4,
      column: 62,
    });
  });

  test("rejects local shadowing of reviewed descriptor authority", () => {
    expectWorkflowError(() => parseWorkflow(`
import { agent, schema as s, workflow, type AgentTask, type Infer } from "pi/workflows";
const Output = s.object({ value: s.string() });
const inspect = agent({ profile: "builtin:reviewer", output: Output });
export default workflow({ description: "Shadow.", input: s.object({}), output: Output,
  async run(flow, _input) {
    async function helper(inspect: AgentTask<Infer<typeof Output>, "snapshot">) {
      return await flow.agent(inspect, { prompt: "x" });
    }
    return (await helper(inspect)).output;
  } });
`, { fileName: "descriptor-shadow.flow.ts" }), /Task descriptor binding inspect may not be shadowed/, {
      line: 7,
      column: 27,
    });
  });

  test("rejects shadowing of flow and invocation bindings", () => {
    expectWorkflowError(() => parseWorkflow(`
import { schema as s, workflow } from "pi/workflows";
const Output = s.object({ ok: s.boolean() });
export default workflow({ description: "Flow shadow.", input: s.object({ value: s.string() }), output: Output,
  async run(flow, input) {
    function helper(flow: string) { return flow; }
    void helper(input.value);
    return { ok: true };
  } });
`, { fileName: "flow-shadow.flow.ts" }), /Flow binding flow may not be shadowed/, { line: 6, column: 21 });

    expectWorkflowError(() => parseWorkflow(`
import { schema as s, workflow } from "pi/workflows";
const Output = s.object({ ok: s.boolean() });
export default workflow({ description: "Input shadow.", input: s.object({ value: s.string() }), output: Output,
  async run(_flow, input) {
    function helper(input: string) { return input; }
    void helper(input.value);
    return { ok: true };
  } });
`, { fileName: "input-shadow.flow.ts" }), /Workflow input binding input may not be shadowed/, { line: 6, column: 21 });
  });

  test("rejects unevaluated top-level computation even when it is unused", () => {
    expectWorkflowError(() => parseWorkflow(`
import { schema as s, workflow } from "pi/workflows";
const computed = (() => 1)();
const Output = s.object({ ok: s.boolean() });
export default workflow({ description: "Computed top level.", input: s.object({}), output: Output,
  async run(_flow, _input) { return { ok: true }; } });
`, { fileName: "computed.flow.ts" }), /computed must be static JSON/, { line: 3, column: 18 });
  });

  test("derives and enforces workflow and operation concurrency", () => {
    expectWorkflowError(() => parseWorkflow(`
import { schema as s, workflow } from "pi/workflows";
const Output = s.object({ ok: s.boolean() });
export default workflow({ description: "Concurrency.", input: s.object({}), output: Output, concurrency: 1,
  async run(flow, _input) {
    await flow.parallel({ one: async () => 1, two: async () => 2 }, { concurrency: 2 });
    return { ok: true };
  } });
`, { fileName: "concurrency.flow.ts" }), /Requested concurrency 2 exceeds the workflow ceiling 1/, {
      line: 6,
      column: 11,
    });
  });

  test("keeps display titles out of descriptor authority and operation identity", () => {
    const source = (title: string) => `
import { agent, schema as s, workflow } from "pi/workflows";
const Output = s.object({ value: s.string() });
const inspect = agent({ profile: "builtin:reviewer", output: Output, title: ${JSON.stringify(title)} });
export default workflow({ description: "Titles.", input: s.object({}), output: Output,
  async run(flow, _input) {
    return (await flow.agent(inspect, { prompt: "x", title: ${JSON.stringify(title)} })).output;
  } });
`;
    const left = parseWorkflow(source("Display A"), { fileName: "titles.flow.ts" });
    const right = parseWorkflow(source("Display B"), { fileName: "titles.flow.ts" });
    expect(left.descriptors[0]?.identity.definitionHash).toBe(right.descriptors[0]?.identity.definitionHash);
    expect(left.operations).toEqual(right.operations);
    expect(left.transform.transformHash).not.toBe(right.transform.transformHash);
  });
});

function reviewProjection(parsed: ParsedWorkflow) {
  return {
    installedName: parsed.installedName,
    metadata: {
      title: parsed.metadata.title ?? null,
      description: parsed.metadata.description,
      concurrency: parsed.metadata.concurrency ?? null,
      inputHash: stableHash(parsed.metadata.input),
      outputHash: stableHash(parsed.metadata.output),
    },
    descriptors: parsed.descriptors.map((descriptor) => ({
      ...descriptor,
      ...(descriptor.kind === "agent-task" ? { output: stableHash(descriptor.output) } : {}),
    })),
    operations: parsed.operations,
    helpers: parsed.helpers,
    review: parsed.review,
  };
}

function loadCorpus(fileName: typeof FILES[number]): ParsedWorkflow {
  const cached = parsedCorpus.get(fileName);
  if (cached) return cached;
  const filePath = path.join(CORPUS, fileName);
  const parsed = parseWorkflow(fs.readFileSync(filePath, "utf8"), { fileName: filePath });
  parsedCorpus.set(fileName, parsed);
  return parsed;
}

function workflowSource(body: string): string {
  return `
import { agent, schema as s, workflow, type CandidateWorkspace } from "pi/workflows";
const Answer = s.object({ action: s.enum(["continue", "stop"]) });
const AgentOutput = s.object({ value: s.string() });
const Result = s.object({ ok: s.boolean() });
const inspect = agent({ profile: "builtin:reviewer", output: AgentOutput });
const write = agent({ profile: "builtin:writer", output: AgentOutput, workspace: "candidate" });
export default workflow({
  description: "Frontend analysis probe.",
  input: s.object({
    items: s.array(s.string(), { maxItems: 8 }),
    limit: s.integer({ minimum: 0, maximum: 8 }),
  }),
  output: Result,
  async run(flow, input) {${body}
    return { ok: true };
  },
});
`;
}

function expectWorkflowError(
  body: () => unknown,
  message: RegExp,
  expectedLocation: { line: number; column: number },
): void {
  try {
    body();
    throw new Error("Expected workflow parsing to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowScriptError);
    expect((error as Error).message).toMatch(message);
    expect((error as WorkflowScriptError).location).toEqual(expectedLocation);
  }
}
