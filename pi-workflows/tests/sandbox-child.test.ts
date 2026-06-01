import { describe, expect, it } from "vitest";
import { WORKFLOW_RESOURCE_LIMITS } from "../src/constants.js";
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

  it("rejects non-object agent options in the child before RPC", async () => {
    let called = false;
    const globals = fakeGlobals({
      agent: async () => {
        called = true;
        return "unexpected";
      },
    });

    await expect(executeWorkflowSandbox("return await agent('x', null);", globals, new AbortController().signal)).rejects.toThrow(/options must be an object/);
    expect(called).toBe(false);
  });

  it("rejects non-JSON agent options in the child before JSON.stringify can erase them", async () => {
    let called = false;
    const globals = fakeGlobals({
      agent: async () => {
        called = true;
        return "unexpected";
      },
    });

    await expect(executeWorkflowSandbox("return await agent('x', { label: () => 'hidden' });", globals, new AbortController().signal)).rejects.toThrow(/JSON-serializable/);
    await expect(executeWorkflowSandbox("return await agent('x', { label: undefined });", globals, new AbortController().signal)).rejects.toThrow(/JSON-serializable/);
    expect(called).toBe(false);
  });

  it("fails parallel() when a branch fails instead of returning null", async () => {
    const globals = fakeGlobals({
      agent: async (prompt) => {
        if (prompt === "bad") throw new Error("boom");
        return prompt;
      },
    });

    await expect(executeWorkflowSandbox("return await parallel([() => agent('ok'), () => agent('bad')]);", globals, new AbortController().signal)).rejects.toThrow(/parallel branch 1 failed: boom/);
  });

  it("fails pipeline() when an item fails instead of returning null", async () => {
    await expect(
      executeWorkflowSandbox("return await pipeline(['ok', 'bad'], async (item) => { if (item === 'bad') throw new Error('boom'); return item; });", fakeGlobals(), new AbortController().signal),
    ).rejects.toThrow(/pipeline item 1 failed: boom/);
  });

  it("flushes UI persistence when an operation handle is awaited", async () => {
    const calls: string[] = [];
    const result = await executeWorkflowSandbox("await ui.update('view', { value: 1 }); return 'ok';", fakeGlobals({ ui: recordingUi(calls) }), new AbortController().signal);

    expect(result).toBe("ok");
    expect(calls).toEqual(["update:view:1", "flush", "flush"]);
  });

  it("does not flush each unawaited UI operation before the final drain", async () => {
    const calls: string[] = [];
    const result = await executeWorkflowSandbox("ui.update('view', { value: 1 }); return 'ok';", fakeGlobals({ ui: recordingUi(calls) }), new AbortController().signal);

    expect(result).toBe("ok");
    expect(calls).toEqual(["update:view:1", "flush"]);
  });

  it("uses ui.flush as an explicit UI batch barrier", async () => {
    const calls: string[] = [];
    const result = await executeWorkflowSandbox("ui.update('view', { value: 1 }); ui.update('view', { value: 2 }); await ui.flush(); return 'ok';", fakeGlobals({ ui: recordingUi(calls) }), new AbortController().signal);

    expect(result).toBe("ok");
    expect(calls).toEqual(["update:view:1", "update:view:2", "flush", "flush"]);
  });

  it("makes delayed UI persistence failures catchable from awaited operations", async () => {
    const calls: string[] = [];
    let flushCount = 0;
    const ui = recordingUi(calls, {
      flush: async () => {
        calls.push("flush");
        flushCount++;
        if (flushCount === 1) throw new Error("persist failed");
      },
    });

    const result = await executeWorkflowSandbox(
      "let caught = ''; try { await ui.update('view', { value: 1 }); } catch (err) { caught = err.message; } return { caught };",
      fakeGlobals({ ui }),
      new AbortController().signal,
    );

    expect(result).toEqual({ caught: "persist failed" });
    expect(calls).toEqual(["update:view:1", "flush", "flush"]);
  });

  it("lets ui.flush catch and handle earlier unawaited UI failures", async () => {
    const calls: string[] = [];
    const ui = recordingUi(calls, {
      update: async () => {
        calls.push("update:bad");
        throw new Error("bad ui update");
      },
    });
    const log = async () => {
      for (let i = 0; i < 50 && !calls.includes("update:bad"); i++) await delay(1);
      await delay(5);
    };

    const result = await executeWorkflowSandbox(
      "ui.update('view', { value: 1 }); await log('yield'); let caught = ''; try { await ui.flush(); } catch (err) { caught = err.message; } return { caught };",
      fakeGlobals({ ui, log }),
      new AbortController().signal,
    );

    expect(result).toEqual({ caught: "bad ui update" });
    expect(calls).toEqual(["update:bad", "flush"]);
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

  it("uses null-prototype deterministic Math and Date globals", async () => {
    const result = await executeWorkflowSandbox(
      "const d = new Date(0); return { iso: d.toISOString(), isDate: d instanceof Date, parsed: Date.parse('1970-01-01T00:00:00.000Z'), utc: Date.UTC(1970, 0, 1), mathProtoNull: Object.getPrototypeOf(Math) === null, dateProtoNull: Object.getPrototypeOf(Date) === null };",
      fakeGlobals(),
      new AbortController().signal,
    );

    expect(result).toEqual({ iso: "1970-01-01T00:00:00.000Z", isDate: true, parsed: 0, utc: 0, mathProtoNull: true, dateProtoNull: true });
  });

  it("rejects Date and Math nondeterminism through prototype escapes", async () => {
    const globals = fakeGlobals();
    await expect(executeWorkflowSandbox("return Object.getPrototypeOf(Math).random();", globals, new AbortController().signal)).rejects.toThrow(/Cannot read|null|undefined|not deterministic/);
    await expect(executeWorkflowSandbox("return Object.getPrototypeOf(Date).now();", globals, new AbortController().signal)).rejects.toThrow(/Cannot read|null|undefined|not deterministic/);
    await expect(executeWorkflowSandbox("return Object.getPrototypeOf(new Date(0)).constructor.now();", globals, new AbortController().signal)).rejects.toThrow(/Date\.now\(\) is not deterministic/);
    await expect(executeWorkflowSandbox("return Date(0);", globals, new AbortController().signal)).rejects.toThrow(/Date\(\) is not deterministic/);
  });

  it("rejects oversized child protocol output", async () => {
    await expect(
      executeWorkflowSandbox(`return "x".repeat(${WORKFLOW_RESOURCE_LIMITS.workflowProtocolLineBytes + 1});`, fakeGlobals(), new AbortController().signal),
    ).rejects.toThrow(/protocol line exceeded/);
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
      dashboard: async () => ({ id: "dashboard" }),
      patch: async () => undefined,
      close: async () => undefined,
      flush: async () => undefined,
    },
    args: {},
    budget: { total: null, spent: () => 0, remaining: () => Number.POSITIVE_INFINITY },
    cwd: process.cwd(),
    ...overrides,
  };
}

function recordingUi(calls: string[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    define: async (spec: any) => {
      calls.push(`define:${spec?.id ?? ""}`);
      return { id: spec?.id };
    },
    update: async (viewId: string, state: any) => {
      calls.push(`update:${viewId}:${state?.value ?? ""}`);
    },
    dashboard: async () => {
      calls.push("dashboard");
      return { id: "dashboard" };
    },
    patch: async (viewId: string) => {
      calls.push(`patch:${viewId}`);
    },
    close: async (viewId: string) => {
      calls.push(`close:${viewId}`);
    },
    flush: async () => {
      calls.push("flush");
    },
    ...overrides,
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
