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

  it("fails when slow critical child operations are left unawaited", async () => {
    const globals = fakeGlobals({
      agent: async () => await new Promise((resolve) => setTimeout(() => resolve("late"), 250)),
    });

    await expect(executeWorkflowSandbox("agent('leaked'); return 'done';", globals, new AbortController().signal)).rejects.toThrow(/unawaited agent\/workflow/);
  });

  it("fails when fast-resolved critical child operations are left unawaited", async () => {
    const calls: unknown[] = [];
    const globals = fakeGlobals({
      agent: async (prompt) => {
        calls.push(prompt);
        return "fast";
      },
      log: async () => {
        await delay(5);
      },
    });

    await expect(executeWorkflowSandbox("agent('leaked'); await log('yield'); return 'done';", globals, new AbortController().signal)).rejects.toThrow(/unawaited agent\/workflow/);
    expect(calls).toEqual(["leaked"]);
  });

  it("treats returned critical child operations as awaited", async () => {
    const result = await executeWorkflowSandbox("return agent('returned');", fakeGlobals(), new AbortController().signal);

    expect(result).toBe("returned");
  });

  it("treats Promise.all critical child operations as awaited", async () => {
    const result = await executeWorkflowSandbox("return await Promise.all([agent('a'), agent('b')]);", fakeGlobals(), new AbortController().signal);

    expect(result).toEqual(["a", "b"]);
  });

  it("fails when child workflow operations are left unawaited", async () => {
    const calls: unknown[] = [];
    const globals = fakeGlobals({
      workflow: async (nameOrRef) => {
        calls.push(nameOrRef);
        return "child result";
      },
      log: async () => {
        await delay(5);
      },
    });

    await expect(executeWorkflowSandbox("workflow('child'); await log('yield'); return 'done';", globals, new AbortController().signal)).rejects.toThrow(/unawaited agent\/workflow/);
    expect(calls).toEqual(["child"]);
  });

  it("aborts in-flight host agent RPCs when the workflow is aborted", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted!: (value: string) => void;
    const abortedPromise = new Promise<string>((resolve) => {
      aborted = resolve;
    });
    const globals = fakeGlobals({
      agent: async (_prompt, _opts, context) => {
        started();
        return await new Promise((_, reject) => {
          context?.signal.addEventListener("abort", () => {
            aborted(context.signal.reason instanceof Error ? context.signal.reason.message : "aborted");
            reject(context.signal.reason);
          }, { once: true });
        });
      },
    });

    const run = executeWorkflowSandbox("return await agent('slow');", globals, controller.signal);
    await startedPromise;
    controller.abort(new Error("stop now"));

    await expect(run).rejects.toThrow(/stop now/);
    await expect(withTimeout(abortedPromise, 500, "host agent was not aborted")).resolves.toBe("stop now");
  });

  it("aborts slow sibling host RPCs after parallel fail-fast", async () => {
    let slowStarted!: () => void;
    const slowStartedPromise = new Promise<void>((resolve) => {
      slowStarted = resolve;
    });
    let slowAborted!: (value: string) => void;
    const slowAbortedPromise = new Promise<string>((resolve) => {
      slowAborted = resolve;
    });
    const globals = fakeGlobals({
      agent: async (prompt, _opts, context) => {
        if (prompt === "bad") {
          await delay(10);
          throw new Error("boom");
        }
        slowStarted();
        return await new Promise((_, reject) => {
          context?.signal.addEventListener("abort", () => {
            slowAborted(context.signal.reason instanceof Error ? context.signal.reason.name : "aborted");
            reject(context.signal.reason);
          }, { once: true });
        });
      },
    });

    const run = executeWorkflowSandbox("return await parallel([() => agent('slow'), () => agent('bad')]);", globals, new AbortController().signal);
    await slowStartedPromise;

    await expect(run).rejects.toThrow(/parallel branch 1 failed: boom/);
    await expect(withTimeout(slowAbortedPromise, 500, "slow sibling was not aborted")).resolves.toBe("WorkflowAbortError");
  });

  it("cancels parallel siblings before waiting on failure logging", async () => {
    let slowStarted!: () => void;
    const slowStartedPromise = new Promise<void>((resolve) => {
      slowStarted = resolve;
    });
    let slowAborted!: (value: string) => void;
    const slowAbortedPromise = new Promise<string>((resolve) => {
      slowAborted = resolve;
    });
    const globals = fakeGlobals({
      agent: async (prompt, _opts, context) => {
        if (prompt === "bad") {
          await delay(10);
          throw new Error("boom");
        }
        slowStarted();
        return await new Promise((_, reject) => {
          context?.signal.addEventListener("abort", () => {
            slowAborted(context.signal.reason instanceof Error ? context.signal.reason.name : "aborted");
            reject(context.signal.reason);
          }, { once: true });
        });
      },
      log: async () => {
        await slowAbortedPromise;
      },
    });

    const run = executeWorkflowSandbox("return await parallel([() => agent('slow'), () => agent('bad')]);", globals, new AbortController().signal);
    await slowStartedPromise;

    await expect(withTimeout(run, 800, "parallel failed without canceling sibling work")).rejects.toThrow(/parallel branch 1 failed: boom/);
    await expect(withTimeout(slowAbortedPromise, 500, "slow sibling was not aborted")).resolves.toBe("WorkflowAbortError");
  });

  it("allows work after a caught parallel failure without letting canceled siblings continue", async () => {
    let slowStarted!: () => void;
    const slowStartedPromise = new Promise<void>((resolve) => {
      slowStarted = resolve;
    });
    let slowAborted!: () => void;
    const slowAbortedPromise = new Promise<void>((resolve) => {
      slowAborted = resolve;
    });
    const prompts: unknown[] = [];
    const globals = fakeGlobals({
      agent: async (prompt, _opts, context) => {
        prompts.push(prompt);
        if (prompt === "bad") throw new Error("boom");
        if (prompt === "slow") {
          slowStarted();
          return await new Promise((_, reject) => {
            context?.signal.addEventListener("abort", () => {
              slowAborted();
              reject(context.signal.reason);
            }, { once: true });
          });
        }
        return prompt;
      },
    });

    const run = executeWorkflowSandbox(`
let caught = '';
try { await parallel([() => agent('slow'), () => agent('bad')]); } catch (err) { caught = err.message; }
const after = await agent('after');
return { caught, after };
`, globals, new AbortController().signal);
    await slowStartedPromise;

    await expect(withTimeout(run, 800, "caught parallel failure did not continue")).resolves.toEqual({ caught: "parallel branch 1 failed: boom", after: "after" });
    await expect(withTimeout(slowAbortedPromise, 500, "canceled sibling continued after caught failure")).resolves.toBeUndefined();
    expect(prompts).toEqual(["slow", "bad", "after"]);
  });

  it("aborts pending host RPCs when unawaited critical operations fail completion", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted!: (value: string) => void;
    const abortedPromise = new Promise<string>((resolve) => {
      aborted = resolve;
    });
    const globals = fakeGlobals({
      agent: async (_prompt, _opts, context) => {
        started();
        return await new Promise((_, reject) => {
          context?.signal.addEventListener("abort", () => {
            aborted(context.signal.reason instanceof Error ? context.signal.reason.name : "aborted");
            reject(context.signal.reason);
          }, { once: true });
        });
      },
    });

    const run = executeWorkflowSandbox("agent('slow'); return 'done';", globals, new AbortController().signal);
    await startedPromise;

    await expect(run).rejects.toThrow(/unawaited agent\/workflow/);
    await expect(withTimeout(abortedPromise, 500, "unawaited host RPC was not aborted")).resolves.toBe("WorkflowAbortError");
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

  it("cancels pipeline sibling items before waiting on failure logging", async () => {
    let slowStarted!: () => void;
    const slowStartedPromise = new Promise<void>((resolve) => {
      slowStarted = resolve;
    });
    let slowAborted!: (value: string) => void;
    const slowAbortedPromise = new Promise<string>((resolve) => {
      slowAborted = resolve;
    });
    const globals = fakeGlobals({
      agent: async (prompt, _opts, context) => {
        if (prompt === "bad") {
          await delay(10);
          throw new Error("boom");
        }
        slowStarted();
        return await new Promise((_, reject) => {
          context?.signal.addEventListener("abort", () => {
            slowAborted(context.signal.reason instanceof Error ? context.signal.reason.name : "aborted");
            reject(context.signal.reason);
          }, { once: true });
        });
      },
      log: async () => {
        await slowAbortedPromise;
      },
    });

    const run = executeWorkflowSandbox("return await pipeline(['slow', 'bad'], async (item) => await agent(item));", globals, new AbortController().signal);
    await slowStartedPromise;

    await expect(withTimeout(run, 800, "pipeline failed without canceling sibling work")).rejects.toThrow(/pipeline item 1 failed: boom/);
    await expect(withTimeout(slowAbortedPromise, 500, "slow pipeline item was not aborted")).resolves.toBe("WorkflowAbortError");
  });

  it("does not cancel best-effort parallel branches that catch their own failures", async () => {
    const prompts: unknown[] = [];
    const globals = fakeGlobals({
      agent: async (prompt) => {
        prompts.push(prompt);
        if (prompt === "bad") throw new Error("boom");
        await delay(5);
        return prompt;
      },
    });

    const result = await executeWorkflowSandbox(`
return await parallel([
  async () => { try { return { ok: true, value: await agent('bad') }; } catch (err) { return { ok: false, error: err.message }; } },
  async () => ({ ok: true, value: await agent('ok') })
]);
`, globals, new AbortController().signal);

    expect(result).toEqual([{ ok: false, error: "boom" }, { ok: true, value: "ok" }]);
    expect(prompts.sort()).toEqual(["bad", "ok"]);
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

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
