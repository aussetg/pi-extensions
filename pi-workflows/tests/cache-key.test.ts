import { describe, expect, it } from "vitest";
import { computeAgentChainKey } from "../src/runtime/cache-key.js";

describe("computeAgentChainKey", () => {
  it("is stable for the same prompt, chain, options, and tools", () => {
    const input = {
      previousChainKey: "prev",
      prompt: "scan parser",
      opts: { label: "parser", phase: "Scan", isolation: "shared" as const },
      activeTools: ["bash", "read"],
    };

    expect(computeAgentChainKey(input)).toBe(computeAgentChainKey({ ...input }));
  });

  it("changes when prompt or previous chain changes", () => {
    const base = computeAgentChainKey({ previousChainKey: "prev", prompt: "scan parser", opts: {}, activeTools: ["bash"] });

    expect(computeAgentChainKey({ previousChainKey: "prev", prompt: "scan renderer", opts: {}, activeTools: ["bash"] })).not.toBe(base);
    expect(computeAgentChainKey({ previousChainKey: "other", prompt: "scan parser", opts: {}, activeTools: ["bash"] })).not.toBe(base);
  });

  it("changes when output-affecting options change", () => {
    const base = computeAgentChainKey({ prompt: "scan", opts: { isolation: "shared" }, activeTools: ["bash"] });

    expect(computeAgentChainKey({ prompt: "scan", opts: { isolation: "worktree" }, activeTools: ["bash"] })).not.toBe(base);
    expect(computeAgentChainKey({ prompt: "scan", opts: { model: "other" }, activeTools: ["bash"] })).not.toBe(base);
    expect(computeAgentChainKey({ prompt: "scan", opts: { schema: { type: "object", properties: { ok: { type: "boolean" } } } }, activeTools: ["bash"] })).not.toBe(base);
  });

  it("normalizes active tools and ignores workflow because subagents cannot use it", () => {
    const a = computeAgentChainKey({ prompt: "scan", opts: {}, activeTools: ["workflow", "write", "bash", "bash"] });
    const b = computeAgentChainKey({ prompt: "scan", opts: {}, activeTools: ["bash", "write"] });
    const c = computeAgentChainKey({ prompt: "scan", opts: {}, activeTools: ["bash", "read", "write"] });
    const d = computeAgentChainKey({ prompt: "scan", opts: {}, activeTools: ["workflow"] });
    const e = computeAgentChainKey({ prompt: "scan", opts: {} });

    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(d).toBe(e);
  });

  it("uses the v3 prefix and has no scriptHash or argsHash input", () => {
    expect(computeAgentChainKey({ prompt: "scan", opts: {} })).toMatch(/^v3:/);
  });
});
