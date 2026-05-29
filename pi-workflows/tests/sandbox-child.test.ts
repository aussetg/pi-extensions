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

  it("keeps constructor escapes inside the bubblewrap child", async () => {
    const result = await executeWorkflowSandbox("return agent.constructor('return process')().cwd();", fakeGlobals(), new AbortController().signal);
    expect(result).toBe("/tmp");
  });
});

function fakeGlobals(overrides: Partial<SandboxGlobals> = {}): SandboxGlobals {
  const logs: string[] = [];
  return {
    agent: async (prompt: unknown) => prompt,
    parallel: async () => [],
    pipeline: async () => [],
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
    console,
    setTimeout,
    clearTimeout,
    ...overrides,
  };
}
