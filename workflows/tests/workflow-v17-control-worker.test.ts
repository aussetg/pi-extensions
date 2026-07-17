import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { parseWorkflowV17 } from "../src/definition/workflow-v17-frontend.js";
import type { WorkflowV17ProductIdentity, WorkflowV17ReferenceIdentity } from "../src/definition/workflow-language-v17.js";
import type { ParsedWorkflowV17 } from "../src/definition/workflow-v17-types.js";
import { sha256, stableHash } from "../src/utils/hashes.js";
import {
  WorkflowV17AuthorityScopeError,
  WorkflowV17ControlAuthorityRegistry,
  WorkflowV17StaleAuthorityError,
} from "../src/runtime/control-authority-v17.js";
import {
  evaluateWorkflowV17Control,
  loadWorkflowV17ControlDefinition,
  WorkflowV17ControlExecutionError,
  WorkflowV17ControlExecutionLimitError,
  type WorkflowV17HostFlow,
} from "../src/runtime/control-worker-host-v17.js";
import { parseWorkflowV17ControlProcessMessage } from "../src/runtime/control-protocol-v17.js";

describe("workflow v17 control process", () => {
  it("loads all six reviewed definitions with realm-owned language constructors", async () => {
    const root = path.join(process.cwd(), "tests", "conformance", "v17", "typecheck", "corpus");
    for (const name of fs.readdirSync(root).filter(name => name.endsWith(".flow.ts")).sort()) {
      const parsed = parseWorkflowV17(fs.readFileSync(path.join(root, name), "utf8"), { fileName: name });
      await expect(loadWorkflowV17ControlDefinition(parsed), name).resolves.toBeUndefined();
    }
  }, 30_000);

  it("executes exact reviewed source with frozen arguments and only the v17 flow surface", async () => {
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
    const authority = new WorkflowV17ControlAuthorityRegistry("run:surface");
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
    const authority = new WorkflowV17ControlAuthorityRegistry("run:products");
    const artifact = authority.product(productIdentity("artifact", "artifact-first"));
    const first = authority.product(productIdentity("agent-result", "agent-first"), {
      output: { answer: "one" }, artifact, published: [artifact],
    });
    const second = authority.product(productIdentity("agent-result", "agent-second"), {
      output: { answer: "two" }, artifact, published: [],
    });
    let calls = 0;
    const flow: WorkflowV17HostFlow = {
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
    const authority = new WorkflowV17ControlAuthorityRegistry("run:candidate-context");
    const workspace = authority.reference(referenceIdentity("candidate-workspace", "workspace-one"), {}, { workspaceId: "one" });
    const artifact = authority.product(productIdentity("artifact", "artifact-edit"));
    const edited = authority.product(productIdentity("agent-result", "agent-edit"), {
      output: { summary: "edited" }, artifact, published: [], checkpoint: artifact,
    });
    const candidate = authority.product(productIdentity("candidate", "candidate-one"), {
      output: { summary: "edited" }, changedPaths: ["src/index.ts"],
    });
    const flow: WorkflowV17HostFlow = {
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
    const authority = new WorkflowV17ControlAuthorityRegistry("run:parallel-context");
    const artifact = authority.product(productIdentity("artifact", "artifact-lanes"));
    const flow: WorkflowV17HostFlow = {
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
    const authority = new WorkflowV17ControlAuthorityRegistry("run:metric-reference");
    const metricSet = authority.reference(referenceIdentity("metric-set", "metric-set-one"));
    const artifact = authority.product(productIdentity("artifact", "artifact-measurement"));
    const measurement = authority.product(productIdentity("measurement", "measurement-one"), {
      measurementId: "measurement_one",
      observations: {},
      artifact,
    });
    const flow: WorkflowV17HostFlow = {
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
    const authority = new WorkflowV17ControlAuthorityRegistry("run:lookalike");
    const artifact = authority.product(productIdentity("artifact", "artifact-lookalike"));
    const result = authority.product(productIdentity("agent-result", "agent-lookalike"), {
      output: { ok: true }, artifact, published: [],
    });
    const flow: WorkflowV17HostFlow = {
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
    const first = new WorkflowV17ControlAuthorityRegistry("run:first");
    const second = new WorkflowV17ControlAuthorityRegistry("run:second");
    const foreign = first.product(productIdentity("artifact", "artifact-foreign"));
    expect(() => second.transport(foreign)).toThrow(WorkflowV17AuthorityScopeError);

    const stale = first.reference(referenceIdentity("candidate-workspace", "workspace-stale"));
    first.revoke(stale);
    expect(() => first.transport(stale)).toThrow(WorkflowV17StaleAuthorityError);

    const workflow = parse("foreign-authority", `
      import { agent, schema as s, workflow } from "pi/workflows";
      const inspect = agent({ profile: "builtin:reviewer", output: s.object({ ok: s.boolean() }) });
      export default workflow({
        description: "Reject foreign authority.", input: s.object({}), output: s.json(),
        async run(flow, _input) { return (await flow.agent(inspect, { prompt: "x" })).output; },
      });
    `);
    const error = new WorkflowV17AuthorityScopeError("foreign result");
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
    const authority = new WorkflowV17ControlAuthorityRegistry("run:stale-roundtrip");
    const artifact = authority.product(productIdentity("artifact", "artifact-stale-roundtrip"));
    const product = authority.product(productIdentity("agent-result", "agent-stale-roundtrip"), {
      output: { ok: true }, artifact, published: [],
    });
    const flow: WorkflowV17HostFlow = {
      agent: () => product,
      ask: () => {
        authority.revoke(product);
        return true;
      },
    };
    await expect(execute(workflow, flow, authority)).rejects.toBeInstanceOf(WorkflowV17StaleAuthorityError);
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
    await expect(execute(unknownSite, {}, new WorkflowV17ControlAuthorityRegistry("run:unknown-site")))
      .rejects.toThrow("Unknown workflow source site site-999999");

    const changedDescriptor = changedExecutable(parsed, parsed.executableSource.replace(
      'profile: "builtin:reviewer"',
      'profile: "builtin:researcher"',
    ));
    await expect(execute(changedDescriptor, {}, new WorkflowV17ControlAuthorityRegistry("run:changed-descriptor")))
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
      new WorkflowV17ControlAuthorityRegistry("run:runaway"),
      {},
      undefined,
      undefined,
      50,
    );
    await expect(execution).rejects.toBeInstanceOf(WorkflowV17ControlExecutionLimitError);
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
      new WorkflowV17ControlAuthorityRegistry("run:wire-depth"),
    );
    await expect(execution).rejects.toBeInstanceOf(WorkflowV17ControlExecutionLimitError);
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
        new WorkflowV17ControlAuthorityRegistry("run:heap-limit"),
        {},
        undefined,
        undefined,
        2_000,
      );
      await expect(execution).rejects.toBeInstanceOf(WorkflowV17ControlExecutionLimitError);
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
    const reason = new Error("cancelled by v17 test");
    const execution = evaluateWorkflowV17Control({
      workflow,
      flow: { agent: async () => await new Promise(() => {}) },
      args: {},
      authority: new WorkflowV17ControlAuthorityRegistry("run:abort-pending"),
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
    const execution = evaluateWorkflowV17Control({
      workflow,
      flow: { agent: async () => await new Promise(resolve => setTimeout(resolve, 1_000)) },
      args: {},
      authority: new WorkflowV17ControlAuthorityRegistry("run:worker-crash"),
      signal: new AbortController().signal,
      rootContext: "root",
      currentContext: () => "root",
      runInContext: (_context, body) => body(),
      onControlStart: pid => setImmediate(() => process.kill(pid, "SIGKILL")),
    });
    await expect(execution).rejects.toBeInstanceOf(WorkflowV17ControlExecutionError);
    await expect(execution).rejects.toThrow(/exited before completion/u);
  });

  it("rejects malformed protocol messages before dispatch", () => {
    expect(() => parseWorkflowV17ControlProcessMessage({
      type: "host-call",
      requestId: "request-1",
      invocationId: "root",
      method: "agent",
      args: { type: "array", values: [] },
      unexpected: true,
    })).toThrow(/unexpected fields/u);
    expect(() => parseWorkflowV17ControlProcessMessage({
      type: "host-call",
      requestId: "request-1",
      invocationId: "root",
      method: "stage",
      args: { type: "array", values: [] },
    })).toThrow(/Unknown workflow v17 async method stage/u);
  });
});

function parse(name: string, source: string): ParsedWorkflowV17 {
  return parseWorkflowV17(source, { fileName: `${name}.flow.ts` });
}

async function execute(
  workflow: ParsedWorkflowV17,
  flow: WorkflowV17HostFlow,
  authority: WorkflowV17ControlAuthorityRegistry,
  args: Record<string, unknown> = {},
  snapshot?: object,
  storage?: AsyncLocalStorage<string>,
  segmentTimeoutMs?: number,
): Promise<unknown> {
  const contexts = storage ?? new AsyncLocalStorage<string>();
  return await contexts.run("root", async () => await evaluateWorkflowV17Control({
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

function productIdentity(kind: WorkflowV17ProductIdentity["kind"], authorityId: string): WorkflowV17ProductIdentity {
  return {
    formatVersion: 1,
    kind,
    authorityId,
    authorityHash: stableHash({ kind, authorityId }),
  };
}

function referenceIdentity(kind: WorkflowV17ReferenceIdentity["kind"], authorityId: string): WorkflowV17ReferenceIdentity {
  return {
    formatVersion: 1,
    kind,
    authorityId,
    authorityHash: stableHash({ kind, authorityId }),
  };
}

function changedExecutable(workflow: ParsedWorkflowV17, executableSource: string): ParsedWorkflowV17 {
  const clone = structuredClone(workflow);
  clone.executableSource = executableSource;
  clone.transform.executableSourceHash = sha256(executableSource);
  return clone;
}
