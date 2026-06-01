import { describe, expect, it } from "vitest";
import { parseWorkflowScript, validateWorkflowExecutableSource } from "../src/runtime/parser.js";

const valid = `export const meta = { name: 'x', description: 'desc', phases: [{ title: 'A' }] };\nphase('A');\nreturn await agent('hi');`;

describe("parseWorkflowScript", () => {
  it("accepts literal meta and top-level return", () => {
    const parsed = parseWorkflowScript(valid);
    expect(parsed.meta.name).toBe("x");
    expect(parsed.executableSource).toContain("return await agent");
  });

  it("requires meta first", () => {
    expect(() => parseWorkflowScript("const x = 1;\n" + valid)).toThrow(/First statement/);
  });

  it("rejects non-literal meta", () => {
    expect(() => parseWorkflowScript("const name = 'x';\nexport const meta = { name, description: 'd' };"))
      .toThrow(/First statement/);
    expect(() => parseWorkflowScript("export const meta = { ...base, name: 'x', description: 'd' };"))
      .toThrow(/spreads/);
    expect(() => parseWorkflowScript("export const meta = { ['name']: 'x', description: 'd' };"))
      .toThrow(/computed/);
    expect(() => parseWorkflowScript("export const meta = { get name() { return 'x' }, description: 'd' };"))
      .toThrow(/accessors/);
    expect(() => parseWorkflowScript("export const meta = { __proto__: {}, name: 'x', description: 'd' };"))
      .toThrow(/reserved/);
  });

  it("rejects nondeterministic and Node APIs", () => {
    expect(() => parseWorkflowScript(`export const meta = { name: 'x', description: 'd' };\nDate.now();`)).toThrow(/Date.now/);
    expect(() => parseWorkflowScript(`export const meta = { name: 'x', description: 'd' };\nDate();`)).toThrow(/Date\(\)/);
    expect(() => parseWorkflowScript(`export const meta = { name: 'x', description: 'd' };\nnew Date();`)).toThrow(/argless/);
    expect(() => parseWorkflowScript(`export const meta = { name: 'x', description: 'd' };\nMath.random();`)).toThrow(/Math.random/);
    expect(() => parseWorkflowScript(`export const meta = { name: 'x', description: 'd' };\nprocess.cwd();`)).toThrow(/process/);
    expect(() => parseWorkflowScript(`export const meta = { name: 'x', description: 'd' };\nrequire('fs');`)).toThrow(/require/);
  });

  it("validates executable-only sources for sandbox entrypoints", () => {
    expect(() => validateWorkflowExecutableSource("return await agent('hi');")).not.toThrow();
    expect(() => validateWorkflowExecutableSource("return globalThis.process;")).toThrow(/globalThis/);
    expect(() => validateWorkflowExecutableSource("import fs from 'node:fs';\nreturn fs;")).toThrow(/may not import/);
    expect(() => validateWorkflowExecutableSource("return import('node:fs');")).toThrow(/may not import/);
    expect(() => validateWorkflowExecutableSource("export const x = 1;")).toThrow(/may not export/);
  });
});
