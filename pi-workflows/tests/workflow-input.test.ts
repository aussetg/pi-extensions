import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { WorkflowRunner } from "../src/runtime/runner.js";
import { createWorkflowTool, WorkflowInputSchema } from "../src/tool/workflow-tool.js";

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

  it("converts launch validation errors into model-visible tool results", async () => {
    const tool = createWorkflowTool({} as any);
    const result = await tool.execute("test", { args: {} }, new AbortController().signal, () => undefined, { cwd: process.cwd() });

    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("failed");
    expect(result.content[0].text).toMatch(/exactly one/);
  });
});
