import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { parseWorkflow } from "../src/definition/workflow-frontend.js";
import type { WorkflowProductIdentity, WorkflowReferenceIdentity } from "../src/definition/workflow-language.js";
import type { ParsedWorkflow } from "../src/definition/workflow-types.js";
import { sha256, stableHash } from "../src/utils/hashes.js";
import {
  WorkflowAuthorityScopeError,
  WorkflowControlAuthorityRegistry,
  WorkflowStaleAuthorityError,
} from "../src/runtime/control-authority.js";
import {
  evaluateWorkflowControl,
  loadWorkflowControlDefinition,
  WorkflowControlExecutionError,
  WorkflowControlExecutionLimitError,
  type WorkflowHostFlow,
} from "../src/runtime/control-worker-host.js";
import { parseWorkflowControlProcessMessage } from "../src/runtime/control-protocol.js";

describe("workflow control process", () => {
  it("loads all six reviewed definitions with realm-owned language constructors", async () => {
    const root = path.join(process.cwd(), "tests", "conformance", "typecheck", "corpus");
    for (const name of fs.readdirSync(root).filter(name => name.endsWith(".flow.ts")).sort()) {
      const parsed = parseWorkflow(fs.readFileSync(path.join(root, name), "utf8"), { fileName: name });
      await expect(loadWorkflowControlDefinition(parsed), name).resolves.toBeUndefined();
    }
  }, 30_000);

  it("executes exact reviewed source with frozen arguments and only the flow surface", async () => {
    const workflow = parse("surface", `
      import { schema as s, workflow } from "pi/workflows";
      export default workflow({
        description: "Inspect the control surface.",
        input: s.object({ value: s.integer() }),
        output: s.json(),
        async run(flow, input) {
          return {
            value: input.value,
            argsFrozen: Object.isFrozen(input),
            snapshotFrozen: Object.isFrozen(flow.snapshot),
          };
        },
      });
    `);
    const authority = new WorkflowControlAuthorityRegistry("run:surface");
    const snapshot = authority.reference(referenceIdentity("launch-snapshot", "snapshot-surface"));
    await expect(execute(workflow, {}, authority, { value: 7 }, snapshot)).resolves.toEqual({
      value: 7,
      argsFrozen: true,
      snapshotFrozen: true,
    });
  });

  it("round-trips reviewed descriptors and nested branded products without exposing authority", async () => {
    const workflow = parse("products", `
      import { agent, schema as s, workflow } from "pi/workflows";
      const inspect = agent({ profile: "builtin:reviewer", output: s.object({ answer: s.string() }) });
      export default workflow({
        description: "Round-trip products.",
        input: s.object({}),
        output: s.json(),
        async run(flow, _input) {
          const first = await flow.agent(inspect, { prompt: "first" });
          const frozen = Object.isFrozen(first) && Object.isFrozen(first.output)
            && Object.isFrozen(first.published) && Object.isFrozen(first.artifact);
          const second = await flow.agent(inspect, {
            prompt: "second",
            artifacts: { first },
          });
          return { answer: second.output.answer, frozen };
        },
      });
    `);
    const authority = new WorkflowControlAuthorityRegistry("run:products");
    const artifact = authority.product(productIdentity("artifact", "artifact-first"));
    const first = authority.product(productIdentity("agent-result", "agent-first"), {
      output: { answer: "one" }, artifact, published: [artifact],
    });
    const second = authority.product(productIdentity("agent-result", "agent-second"), {
      output: { answer: "two" }, artifact, published: [],
    });
    let calls = 0;
    const flow: WorkflowHostFlow = {
      agent: (site, task, invocation) => {
        calls++;
        expect(site).toBe(calls === 1 ? "site-000000" : "site-000001");
        const taskAuthority = authority.describe(task);
        expect(taskAuthority?.family).toBe("descriptor");
        expect((taskAuthority?.privateAuthority as { profile: string }).profile).toBe("builtin:reviewer");
        if (calls === 2) {
          const prior = (invocation as { artifacts: { first: object } }).artifacts.first;
          expect(prior).toBe(first);
          expect(authority.describe(prior)?.identity.kind).toBe("agent-result");
        }
        return calls === 1 ? first : second;
      },
    };
    await expect(execute(workflow, flow, authority)).resolves.toEqual({ answer: "two", frozen: true });
    expect(calls).toBe(2);
  });

  it("preserves callback context and candidate-workspace authority", async () => {
    const workflow = parse("candidate-context", `
      import { agent, schema as s, workflow } from "pi/workflows";
      const edit = agent({
        profile: "builtin:implementer",
        workspace: "candidate",
        output: s.object({ summary: s.string() }),
      });
      export default workflow({
        description: "Exercise candidate callbacks.",
        input: s.object({}),
        output: s.json(),
        async run(flow, _input) {
          const candidate = await flow.candidate(async workspace => {
            const result = await flow.agent(edit, { workspace, prompt: "edit" });
            return result.output;
          }, { writes: ["src"] });
          return { output: candidate.output, changedPaths: candidate.changedPaths };
        },
      });
    `);
    const storage = new AsyncLocalStorage<string>();
    const authority = new WorkflowControlAuthorityRegistry("run:candidate-context");
    const workspace = authority.reference(referenceIdentity("candidate-workspace", "workspace-one"), {}, { workspaceId: "one" });
    const artifact = authority.product(productIdentity("artifact", "artifact-edit"));
    const edited = authority.product(productIdentity("agent-result", "agent-edit"), {
      output: { summary: "edited" }, artifact, published: [], checkpoint: artifact,
    });
    const candidate = authority.product(productIdentity("candidate", "candidate-one"), {
      output: { summary: "edited" }, changedPaths: ["src/index.ts"],
    });
    const flow: WorkflowHostFlow = {
      candidate: async (_site, body) => {
        const output = await storage.run("candidate", async () => await (body as (workspace: object) => Promise<unknown>)(workspace));
        expect(output).toEqual({ summary: "edited" });
        return candidate;
      },
      agent: (_site, _task, invocation) => {
        expect(storage.getStore()).toBe("candidate");
        const received = (invocation as { workspace: object }).workspace;
        expect(received).toBe(workspace);
        expect(authority.describe(received)?.identity.kind).toBe("candidate-workspace");
        return edited;
      },
    };
    await expect(execute(workflow, flow, authority, {}, undefined, storage)).resolves.toEqual({
      output: { summary: "edited" },
      changedPaths: ["src/index.ts"],
    });
  });

  it("propagates keyed parallel callback contexts independently", async () => {
    const workflow = parse("parallel-context", `
      import { agent, schema as s, workflow } from "pi/workflows";
      const inspect = agent({ profile: "builtin:reviewer", output: s.object({ lane: s.string() }) });
      export default workflow({
        description: "Exercise parallel callbacks.",
        input: s.object({}),
        output: s.json(),
        async run(flow, _input) {
          const result = await flow.parallel({
            alpha: async () => (await flow.agent(inspect, { prompt: "alpha" })).output,
            beta: async () => (await flow.agent(inspect, { prompt: "beta" })).output,
          });
          return result;
        },
      });
    `);
    const storage = new AsyncLocalStorage<string>();
    const authority = new WorkflowControlAuthorityRegistry("run:parallel-context");
    const artifact = authority.product(productIdentity("artifact", "artifact-lanes"));
    const flow: WorkflowHostFlow = {
      parallel: async (_site, branches) => Object.fromEntries(await Promise.all(
        Object.entries(branches as Record<string, () => Promise<unknown>>).map(async ([key, body]) => [
          key,
          await storage.run(`lane:${key}`, body),
        ]),
      )),
      agent: (_site, _task, invocation) => {
        const lane = (invocation as { prompt: string }).prompt;
        expect(storage.getStore()).toBe(`lane:${lane}`);
        return authority.product(productIdentity("agent-result", `agent-${lane}`), {
          output: { lane }, artifact, published: [],
        });
      },
    };
    await expect(execute(workflow, flow, authority, {}, undefined, storage)).resolves.toEqual({
      alpha: { lane: "alpha" },
      beta: { lane: "beta" },
    });
  });

  it("supports synchronous metric-set creation and preserves the opaque reference", async () => {
    const workflow = parse("metric-reference", `
      import { schema as s, workflow } from "pi/workflows";
      export default workflow({
        description: "Pass one metric set to measurement.",
        input: s.object({}),
        output: s.json(),
        async run(flow, _input) {
          const metrics = flow.metrics({
            primary: { output: "latency", direction: "minimize" },
          }, { warmups: 0, samples: 1 });
          const measurement = await flow.measure("builtin:test", metrics);
          return { measurementId: measurement.measurementId };
        },
      });
    `);
    const authority = new WorkflowControlAuthorityRegistry("run:metric-reference");
    const metricSet = authority.reference(referenceIdentity("metric-set", "metric-set-one"));
    const artifact = authority.product(productIdentity("artifact", "artifact-measurement"));
    const measurement = authority.product(productIdentity("measurement", "measurement-one"), {
      measurementId: "measurement_one",
      observations: {},
      artifact,
    });
    const flow: WorkflowHostFlow = {
      metrics: site => {
        expect(site).toBe("site-000000");
        return metricSet;
      },
      measure: (site, profile, received) => {
        expect(site).toBe("site-000001");
        expect(profile).toBe("builtin:test");
        expect(received).toBe(metricSet);
        expect(authority.describe(received)?.identity.kind).toBe("metric-set");
        return measurement;
      },
    };
    await expect(execute(workflow, flow, authority)).resolves.toEqual({ measurementId: "measurement_one" });
  });

  it("does not promote structural lookalikes into authority", async () => {
    const workflow = parse("lookalike", `
      import { agent, schema as s, workflow } from "pi/workflows";
      const inspect = agent({ profile: "builtin:reviewer", output: s.object({ ok: s.boolean() }) });
      export default workflow({
        description: "Pass a product lookalike.",
        input: s.object({}),
        output: s.json(),
        async run(flow, _input) {
          const fake = await flow.ask({ prompt: "fake", response: s.json() });
          const result = await flow.agent(inspect, {
            prompt: "inspect",
            artifacts: { fake: fake as never },
          });
          return result.output;
        },
      });
    `);
    const authority = new WorkflowControlAuthorityRegistry("run:lookalike");
    const artifact = authority.product(productIdentity("artifact", "artifact-lookalike"));
    const result = authority.product(productIdentity("agent-result", "agent-lookalike"), {
      output: { ok: true }, artifact, published: [],
    });
    const flow: WorkflowHostFlow = {
      ask: () => ({
        output: { ok: false },
        artifact: { authorityId: "artifact-lookalike", authorityHash: stableHash("fake") },
        published: [],
      }),
      agent: (_site, _task, invocation) => {
        const fake = (invocation as { artifacts: { fake: object } }).artifacts.fake;
        expect(authority.describe(fake)).toBeUndefined();
        expect(Object.getPrototypeOf(fake)).toBeNull();
        return result;
      },
    };
    await expect(execute(workflow, flow, authority)).resolves.toEqual({ ok: true });
  });

  it("rejects foreign and revoked authority instead of serializing it as plain data", async () => {
    const first = new WorkflowControlAuthorityRegistry("run:first");
    const second = new WorkflowControlAuthorityRegistry("run:second");
    const foreign = first.product(productIdentity("artifact", "artifact-foreign"));
    expect(() => second.transport(foreign)).toThrow(WorkflowAuthorityScopeError);

    const stale = first.reference(referenceIdentity("candidate-workspace", "workspace-stale"));
    first.revoke(stale);
    expect(() => first.transport(stale)).toThrow(WorkflowStaleAuthorityError);

    const workflow = parse("foreign-authority", `
      import { agent, schema as s, workflow } from "pi/workflows";
      const inspect = agent({ profile: "builtin:reviewer", output: s.object({ ok: s.boolean() }) });
      export default workflow({
        description: "Reject foreign authority.", input: s.object({}), output: s.json(),
        async run(flow, _input) { return (await flow.agent(inspect, { prompt: "x" })).output; },
      });
    `);
    const error = new WorkflowAuthorityScopeError("foreign result");
    const execution = execute(workflow, { agent: () => {
      try { second.transport(foreign); } catch { throw error; }
    } }, second);
    await expect(execution).rejects.toBe(error);
  });

  it("rechecks revocation when a worker returns an earlier product reference", async () => {
    const workflow = parse("stale-roundtrip", `
      import { agent, schema as s, workflow } from "pi/workflows";
      const inspect = agent({ profile: "builtin:reviewer", output: s.object({ ok: s.boolean() }) });
      export default workflow({
        description: "Reject stale round-tripped authority.", input: s.object({}), output: s.json(),
        async run(flow, _input) {
          const first = await flow.agent(inspect, { prompt: "first" });
          await flow.ask({ prompt: "revoke", response: s.boolean() });
          return (await flow.agent(inspect, { prompt: "second", artifacts: { first } })).output;
        },
      });
    `);
    const authority = new WorkflowControlAuthorityRegistry("run:stale-roundtrip");
    const artifact = authority.product(productIdentity("artifact", "artifact-stale-roundtrip"));
    const product = authority.product(productIdentity("agent-result", "agent-stale-roundtrip"), {
      output: { ok: true }, artifact, published: [],
    });
    const flow: WorkflowHostFlow = {
      agent: () => product,
      ask: () => {
        authority.revoke(product);
        return true;
      },
    };
    await expect(execute(workflow, flow, authority)).rejects.toBeInstanceOf(WorkflowStaleAuthorityError);
  });

  it("runtime-checks instrumented source sites and descriptor definitions", async () => {
    const source = `
      import { agent, schema as s, workflow } from "pi/workflows";
      const inspect = agent({ profile: "builtin:reviewer", output: s.object({ ok: s.boolean() }) });
      export default workflow({
        description: "Runtime instrumentation checks.", input: s.object({}), output: s.json(),
        async run(flow, _input) { return (await flow.agent(inspect, { prompt: "x" })).output; },
      });
    `;
    const parsed = parse("instrumentation", source);
    const unknownSite = changedExecutable(parsed, parsed.executableSource.replace(
      '__flowSourceSite("site-000000")',
      '__flowSourceSite("site-999999")',
    ));
    await expect(execute(unknownSite, {}, new WorkflowControlAuthorityRegistry("run:unknown-site")))
      .rejects.toThrow("Unknown workflow source site site-999999");

    const changedDescriptor = changedExecutable(parsed, parsed.executableSource.replace(
      'profile: "builtin:reviewer"',
      'profile: "builtin:researcher"',
    ));
    await expect(execute(changedDescriptor, {}, new WorkflowControlAuthorityRegistry("run:changed-descriptor")))
      .rejects.toThrow("Workflow descriptor differs from its reviewed definition");
  });

  it("kills an asynchronous continuation that does not yield", async () => {
    const workflow = parse("runaway", `
      import { schema as s, workflow } from "pi/workflows";
      export default workflow({
        description: "Run forever after one continuation.", input: s.object({}), output: s.json(),
        async run(_flow, _input) {
          await 0;
          while (true) {}
        },
      });
    `);
    const execution = execute(
      workflow,
      {},
      new WorkflowControlAuthorityRegistry("run:runaway"),
      {},
      undefined,
      undefined,
      50,
    );
    await expect(execution).rejects.toBeInstanceOf(WorkflowControlExecutionLimitError);
  });

  it("enforces wire depth before a host value enters the control realm", async () => {
    const workflow = parse("wire-depth", `
      import { schema as s, workflow } from "pi/workflows";
      export default workflow({
        description: "Reject a deeply nested host value.", input: s.object({}), output: s.json(),
        async run(flow, _input) {
          return await flow.ask({ prompt: "deep", response: s.json() });
        },
      });
    `);
    let value: unknown = null;
    for (let depth = 0; depth < 64; depth++) value = [value];
    const execution = execute(
      workflow,
      { ask: () => value },
      new WorkflowControlAuthorityRegistry("run:wire-depth"),
    );
    await expect(execution).rejects.toBeInstanceOf(WorkflowControlExecutionLimitError);
  });

  it("enforces wire byte and node ceilings before host values enter control", async () => {
    const workflow = parse("wire-volume", `
      import { schema as s, workflow } from "pi/workflows";
      export default workflow({
        description: "Reject oversized host values.", input: s.object({}), output: s.json(),
        async run(flow, _input) { return await flow.ask({ prompt: "large", response: s.json() }); },
      });
    `);
    await expect(execute(
      workflow,
      { ask: () => "x".repeat(4 * 1024 * 1024 + 1) },
      new WorkflowControlAuthorityRegistry("run:wire-bytes"),
    )).rejects.toBeInstanceOf(WorkflowControlExecutionLimitError);
    await expect(execute(
      workflow,
      { ask: () => Array.from({ length: 50_001 }, () => null) },
      new WorkflowControlAuthorityRegistry("run:wire-nodes"),
    )).rejects.toBeInstanceOf(WorkflowControlExecutionLimitError);
  });

  it("contains control heap exhaustion inside the worker", async () => {
    const workflow = parse("heap-limit", `
      import { schema as s, workflow } from "pi/workflows";
      export default workflow({
        description: "Exhaust the control heap.", input: s.object({}), output: s.json(),
        async run(_flow, _input) {
          return Array.from({ length: 50_000_000 }, () => 1);
        },
      });
    `);
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 20);
    try {
      const execution = execute(
        workflow,
        {},
        new WorkflowControlAuthorityRegistry("run:heap-limit"),
        {},
        undefined,
        undefined,
        2_000,
      );
      await expect(execution).rejects.toBeInstanceOf(WorkflowControlExecutionLimitError);
      expect(timerFired).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  }, 10_000);

  it("aborts promptly while a host operation remains pending", async () => {
    const workflow = parse("abort-pending", `
      import { agent, schema as s, workflow } from "pi/workflows";
      const inspect = agent({ profile: "builtin:reviewer", output: s.object({ ok: s.boolean() }) });
      export default workflow({
        description: "Wait for cancellation.", input: s.object({}), output: s.json(),
        async run(flow, _input) { return (await flow.agent(inspect, { prompt: "wait" })).output; },
      });
    `);
    const controller = new AbortController();
    const reason = new Error("cancelled by test");
    const execution = evaluateWorkflowControl({
      workflow,
      flow: { agent: async () => await new Promise(() => {}) },
      args: {},
      authority: new WorkflowControlAuthorityRegistry("run:abort-pending"),
      signal: controller.signal,
      rootContext: "root",
      currentContext: () => "root",
      runInContext: (_context, body) => body(),
    });
    setTimeout(() => controller.abort(reason), 20);
    await expect(execution).rejects.toBe(reason);
  });

  it("reports a worker crash while an operation is active", async () => {
    const workflow = parse("worker-crash", `
      import { agent, schema as s, workflow } from "pi/workflows";
      const inspect = agent({ profile: "builtin:reviewer", output: s.object({ ok: s.boolean() }) });
      export default workflow({
        description: "Crash the worker.", input: s.object({}), output: s.json(),
        async run(flow, _input) { return (await flow.agent(inspect, { prompt: "wait" })).output; },
      });
    `);
    const execution = evaluateWorkflowControl({
      workflow,
      flow: { agent: async () => await new Promise(resolve => setTimeout(resolve, 1_000)) },
      args: {},
      authority: new WorkflowControlAuthorityRegistry("run:worker-crash"),
      signal: new AbortController().signal,
      rootContext: "root",
      currentContext: () => "root",
      runInContext: (_context, body) => body(),
      onControlStart: pid => setImmediate(() => process.kill(pid, "SIGKILL")),
    });
    await expect(execution).rejects.toBeInstanceOf(WorkflowControlExecutionError);
    await expect(execution).rejects.toThrow(/exited before completion/u);
  });

  it("rejects malformed protocol messages before dispatch", () => {
    expect(() => parseWorkflowControlProcessMessage({
      type: "host-call",
      requestId: "request-1",
      invocationId: "root",
      method: "agent",
      args: { type: "array", values: [] },
      unexpected: true,
    })).toThrow(/unexpected fields/u);
    expect(() => parseWorkflowControlProcessMessage({
      type: "host-call",
      requestId: "request-1",
      invocationId: "root",
      method: "unknown-method",
      args: { type: "array", values: [] },
    })).toThrow(/Unknown workflow async method unknown-method/u);
  });
});

function parse(name: string, source: string): ParsedWorkflow {
  return parseWorkflow(source, { fileName: `${name}.flow.ts` });
}

async function execute(
  workflow: ParsedWorkflow,
  flow: WorkflowHostFlow,
  authority: WorkflowControlAuthorityRegistry,
  args: Record<string, unknown> = {},
  snapshot?: object,
  storage?: AsyncLocalStorage<string>,
  segmentTimeoutMs?: number,
): Promise<unknown> {
  const contexts = storage ?? new AsyncLocalStorage<string>();
  return await contexts.run("root", async () => await evaluateWorkflowControl({
    workflow,
    flow,
    args,
    ...(snapshot ? { snapshot } : {}),
    authority,
    signal: new AbortController().signal,
    rootContext: "root",
    currentContext: () => contexts.getStore() ?? "missing",
    runInContext: (context, body) => contexts.run(context, body),
    ...(segmentTimeoutMs !== undefined ? { segmentTimeoutMs } : {}),
  }));
}

function productIdentity(kind: WorkflowProductIdentity["kind"], authorityId: string): WorkflowProductIdentity {
  return {
    kind,
    authorityId,
    authorityHash: stableHash({ kind, authorityId }),
  };
}

function referenceIdentity(kind: WorkflowReferenceIdentity["kind"], authorityId: string): WorkflowReferenceIdentity {
  return {
    kind,
    authorityId,
    authorityHash: stableHash({ kind, authorityId }),
  };
}

function changedExecutable(workflow: ParsedWorkflow, executableSource: string): ParsedWorkflow {
  const clone = structuredClone(workflow);
  clone.executableSource = executableSource;
  clone.transform.executableSourceHash = sha256(executableSource);
  return clone;
}
