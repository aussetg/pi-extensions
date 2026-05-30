import { describe, expect, it } from "vitest";
import { executeWorkflowSandbox } from "../src/runtime/sandbox.js";
import type { SandboxGlobals } from "../src/runtime/sandbox-types.js";

describe("workflow child sandbox", () => {
  it("runs workflow code through child-process RPC", async () => {
    const calls: Array<{ prompt: unknown; opts: unknown }> = [];
    const globals = fakeGlobals({
      agent: async (prompt, opts) => {
        calls.push({ prompt, opts });
        return { ok: true, prompt, label: (opts as any).label };
      },
    });

    const result = await executeWorkflowSandbox("phase('A'); await log('hello'); return await agent('hi', { label: 'one' });", globals, new AbortController().signal);

    expect(result).toEqual({ ok: true, prompt: "hi", label: "one" });
    expect(calls).toEqual([{ prompt: "hi", opts: { label: "one" } }]);
  });

  it("fails when critical child operations are left unawaited", async () => {
    const globals = fakeGlobals({
      agent: async () => await new Promise((resolve) => setTimeout(() => resolve("late"), 250)),
    });

    await expect(executeWorkflowSandbox("agent('leaked'); return 'done';", globals, new AbortController().signal)).rejects.toThrow(/pending agent\/workflow/);
  });

  it("leaves direct agent isolation to the parent scheduler default", async () => {
    const calls: Array<{ prompt: unknown; opts: unknown }> = [];
    const globals = fakeGlobals({
      agent: async (prompt, opts) => {
        calls.push({ prompt, opts });
        return prompt;
      },
    });

    await executeWorkflowSandbox("return await agent('solo', { label: 'direct' });", globals, new AbortController().signal);

    expect(calls).toEqual([{ prompt: "solo", opts: { label: "direct" } }]);
  });

  it("defaults parallel branch agents to worktree isolation", async () => {
    const calls: Array<{ prompt: unknown; opts: unknown }> = [];
    const globals = fakeGlobals({
      agent: async (prompt, opts) => {
        calls.push({ prompt, opts });
        return prompt;
      },
    });

    await executeWorkflowSandbox("return await parallel([() => agent('branch')]);", globals, new AbortController().signal);

    expect(calls).toEqual([{ prompt: "branch", opts: { isolation: "worktree" } }]);
  });

  it("defaults pipeline stage agents to worktree isolation", async () => {
    const calls: Array<{ prompt: unknown; opts: unknown }> = [];
    const globals = fakeGlobals({
      agent: async (prompt, opts) => {
        calls.push({ prompt, opts });
        return prompt;
      },
    });

    await executeWorkflowSandbox("return await pipeline(['item'], async (item) => await agent('stage ' + item));", globals, new AbortController().signal);

    expect(calls).toEqual([{ prompt: "stage item", opts: { isolation: "worktree" } }]);
  });

  it("preserves explicit isolation inside parallel branches", async () => {
    const calls: Array<{ prompt: unknown; opts: unknown }> = [];
    const globals = fakeGlobals({
      agent: async (prompt, opts) => {
        calls.push({ prompt, opts });
        return prompt;
      },
    });

    await executeWorkflowSandbox("return await parallel([() => agent('branch', { label: 'shared branch', isolation: 'shared' })]);", globals, new AbortController().signal);

    expect(calls).toEqual([{ prompt: "branch", opts: { label: "shared branch", isolation: "shared" } }]);
  });

  it("rejects direct constructor escapes on workflow API functions", async () => {
    await expect(executeWorkflowSandbox("return agent.constructor('return process')().cwd();", fakeGlobals(), new AbortController().signal)).rejects.toThrow(/Function constructor|Code generation|not available/);
  });

  it("rejects computed constructor escapes on workflow API functions", async () => {
    await expect(executeWorkflowSandbox("const key = 'con' + 'structor'; return agent[key]('return Date.now()')();", fakeGlobals(), new AbortController().signal)).rejects.toThrow(/Function constructor|Code generation|not available/);
  });

  it("rejects constructor escapes through workflow args", async () => {
    await expect(executeWorkflowSandbox("return args.constructor.constructor('return process')().cwd();", fakeGlobals({ args: { ok: true } }), new AbortController().signal)).rejects.toThrow(/Function constructor|Code generation|not available/);
  });

  it("rejects constructor escapes through agent results", async () => {
    const globals = fakeGlobals({ agent: async () => ({ ok: true }) });

    await expect(executeWorkflowSandbox("const result = await agent('x'); return result.constructor.constructor('return process')().cwd();", globals, new AbortController().signal)).rejects.toThrow(/Function constructor|Code generation|not available/);
  });

  it("rejects constructor escapes through caught RPC errors", async () => {
    const globals = fakeGlobals({
      agent: async () => {
        throw new Error("boom");
      },
    });

    await expect(executeWorkflowSandbox("try { await agent('x'); } catch (err) { return err.constructor.constructor('return process')().cwd(); }", globals, new AbortController().signal)).rejects.toThrow(/Function constructor|Code generation|not available/);
  });

  it("uses opaque numeric timer ids and supports awaited timers", async () => {
    const result = await executeWorkflowSandbox(
      "return await new Promise((resolve) => { const id = setTimeout(() => resolve({ type: typeof id, id }), 1); });",
      fakeGlobals(),
      new AbortController().signal,
    );

    expect(result).toEqual({ type: "number", id: expect.any(Number) });
  });

  it("fails when timers are left pending", async () => {
    await expect(executeWorkflowSandbox("setTimeout(() => undefined, 1000); return 'done';", fakeGlobals(), new AbortController().signal)).rejects.toThrow(/pending timer/);
  });
});

function fakeGlobals(overrides: Partial<SandboxGlobals> = {}): SandboxGlobals {
  const logs: string[] = [];
  return {
    agent: async (prompt: unknown) => prompt,
    phase: () => undefined,
    log: async (message: string) => {
      logs.push(message);
    },
    workflow: async () => null,
    ui: {
      define: async (spec: any) => ({ id: spec?.id }),
      update: async () => undefined,
      patch: async () => undefined,
    },
    args: {},
    budget: { total: null, spent: () => 0, remaining: () => Number.POSITIVE_INFINITY },
    cwd: process.cwd(),
    ...overrides,
  };
}
