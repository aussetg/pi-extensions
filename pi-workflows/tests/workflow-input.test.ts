import { Ajv2020 } from "ajv/dist/2020.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowRegistry } from "../src/persistence/registry.js";
import { RunStore } from "../src/persistence/run-store.js";
import { WorkflowRunner } from "../src/runtime/runner.js";
import { createWorkflowTool, WorkflowInputSchema } from "../src/tool/workflow-tool.js";

const validScript = "export const meta = { name: 'x', description: 'd' };\nreturn 'ok';\n";

describe("WorkflowInputSchema", () => {
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(WorkflowInputSchema);

  it("uses an object root for provider function-calling compatibility", () => {
    expect(WorkflowInputSchema.type).toBe("object");
  });

  it("does not use top-level composition keywords rejected by Codex", () => {
    for (const keyword of ["oneOf", "anyOf", "allOf", "enum", "not"]) {
      expect(Object.prototype.hasOwnProperty.call(WorkflowInputSchema, keyword)).toBe(false);
    }
  });

  it("accepts supported workflow source shapes", () => {
    expect(validate({ script: "export const meta = { name: 'x', description: 'd' };" })).toBe(true);
    expect(validate({ name: "saved_workflow", args: { q: "x" }, mode: "await" })).toBe(true);
    expect(validate({ scriptPath: "./workflow.js", budgetTokens: 1000, maxAgents: 3 })).toBe(true);
  });

  it("leaves exactly-one source validation to the runner", () => {
    expect(validate({ args: {} })).toBe(true);
    expect(validate({ script: "x", name: "saved" })).toBe(true);
    expect(validate({ script: "x", scriptPath: "./x.js" })).toBe(true);
    expect(validate({ name: "saved", scriptPath: "./x.js" })).toBe(true);
    expect(validate({ script: "x", name: "saved", scriptPath: "./x.js" })).toBe(true);
  });

  it("still rejects invalid field shapes", () => {
    expect(validate({ name: "saved", args: [] })).toBe(false);
  });
});

describe("WorkflowRunner input validation", () => {
  it("rejects ambiguous workflow sources before resolution", async () => {
    const runner = new WorkflowRunner({} as any);
    await expect(runner.launchOrRun({ toolCallId: "test", input: { script: "x", name: "saved" }, ctx: {} })).rejects.toThrow(/exactly one/);
  });

  it("rejects missing workflow sources before resolution", async () => {
    const runner = new WorkflowRunner({} as any);
    await expect(runner.launchOrRun({ toolCallId: "test", input: { args: {} }, ctx: {} })).rejects.toThrow(/exactly one/);
  });

  it("rejects blank workflow sources", async () => {
    const runner = new WorkflowRunner({} as any);
    await expect(runner.launchOrRun({ toolCallId: "test", input: { scriptPath: "   " }, ctx: {} })).rejects.toThrow(/non-empty/);
  });

  it("rejects unknown and invalid API fields before launch", async () => {
    const runner = new WorkflowRunner({} as any);
    await expect(runner.launchOrRun({ toolCallId: "test", input: { script: validScript, unknown: true } as any, ctx: {} })).rejects.toThrow(/Unknown workflow input field/);
    await expect(runner.launchOrRun({ toolCallId: "test", input: { script: validScript, args: [] } as any, ctx: {} })).rejects.toThrow(/workflow args must be a JSON object/);
    await expect(runner.launchOrRun({ toolCallId: "test", input: { script: validScript, mode: "later" } as any, ctx: {} })).rejects.toThrow(/mode must be await or async/);
    await expect(runner.launchOrRun({ toolCallId: "test", input: { script: validScript, budgetTokens: 0 } as any, ctx: {} })).rejects.toThrow(/budgetTokens/);
    await expect(runner.launchOrRun({ toolCallId: "test", input: { script: validScript, maxAgents: 0 } as any, ctx: {} })).rejects.toThrow(/maxAgents/);
    await expect(runner.launchOrRun({ toolCallId: "test", input: { script: validScript, resumeFromRunId: "" } as any, ctx: {} })).rejects.toThrow(/resumeFromRunId/);
  });

  it("rejects unknown resume sources before creating a new run", async () => {
    const oldAgentDir = process.env.PI_AGENT_DIR;
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-resume-missing-"));
    try {
      process.env.PI_AGENT_DIR = path.join(tmp, "agent");
      const cwd = path.join(tmp, "project");
      await fs.promises.mkdir(cwd, { recursive: true });
      const runStore = new RunStore();
      const runner = new WorkflowRunner({ pi: {} as any, runStore, registry: new WorkflowRegistry() });

      await expect(runner.launchOrRun({ toolCallId: "test", input: { script: validScript, resumeFromRunId: "wr_missing" }, ctx: { cwd, hasUI: false } })).rejects.toThrow(/Unknown workflow run to resume: wr_missing/);
      expect(runStore.list("all")).toEqual([]);
    } finally {
      if (oldAgentDir === undefined) delete process.env.PI_AGENT_DIR;
      else process.env.PI_AGENT_DIR = oldAgentDir;
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });

  it("converts launch validation errors into model-visible tool results", async () => {
    const tool = createWorkflowTool({} as any);
    const result = await tool.execute("test", { args: {} }, new AbortController().signal, () => undefined, { cwd: process.cwd() });

    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("failed");
    expect(result.content[0].text).toMatch(/exactly one/);
  });
});
