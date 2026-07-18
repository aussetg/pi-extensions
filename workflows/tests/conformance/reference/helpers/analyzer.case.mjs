// Executable oracle for the workflow runtime conformance contract.
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeHelpers } from "./analyzer.js";

test("accepts a named effectful helper as the exact map callback", () => {
  const analysis = analyzeHelpers(`
    async function run(flow, args) {
      async function audit(pkg) {
        const files = await flow.command(filesTask, { args: { path: pkg.path } });
        return await flow.agent(reviewTask, { prompt: pkg.id, artifacts: { files } });
      }
      return await flow.map(args.packages, audit, { key: pkg => pkg.id });
    }
  `);
  assert.deepEqual(
    analysis.functions.find((fn) => fn.name === "audit"),
    { name: "audit", effectful: true, contexts: ["concurrent"], effects: ["command", "agent"] },
  );
});

test("propagates candidate context through direct local helper calls", () => {
  const analysis = analyzeHelpers(`
    async function run(flow) {
      async function implement(workspace) {
        return await flow.agent(writer, { workspace, prompt: "write" });
      }
      return await flow.candidate(async workspace => await implement(workspace));
    }
  `);
  assert.deepEqual(
    analysis.functions.find((fn) => fn.name === "implement").contexts,
    ["candidate"],
  );
});

test("accepts directly called helpers in native loops", () => {
  const analysis = analyzeHelpers(`
    async function run(flow) {
      async function attempt(index) {
        return await flow.agent(worker, { prompt: String(index) });
      }
      const results = [];
      for (let index = 0; index < 3; index++) results.push(await attempt(index));
      return results;
    }
  `);
  assert.deepEqual(
    analysis.functions.find((fn) => fn.name === "attempt").contexts,
    ["root"],
  );
});

test("accepts named helpers as fixed parallel branch values", () => {
  const analysis = analyzeHelpers(`
    async function run(flow) {
      async function architecture() { return await flow.agent(review, { prompt: "architecture" }); }
      async function tests() { return await flow.agent(review, { prompt: "tests" }); }
      return await flow.parallel({ architecture, tests });
    }
  `);
  assert.deepEqual(
    analysis.functions.filter((fn) => fn.name === "architecture" || fn.name === "tests")
      .map((fn) => fn.contexts),
    [["concurrent"], ["concurrent"]],
  );
});

test("rejects recursive helper graphs", () => {
  assert.throws(() => analyzeHelpers(`
    async function run(flow) { return await recurse(); }
    async function recurse() { await flow.agent(worker, { prompt: "x" }); return recurse(); }
  `), /recursive helper recurse/);
});

test("rejects effectful helper escape and dynamic dispatch", () => {
  assert.throws(() => analyzeHelpers(`
    async function run(flow) {
      async function work() { return await flow.agent(worker, { prompt: "x" }); }
      const selected = work;
      return await selected();
    }
  `), /may not escape or use dynamic dispatch/);
});

test("rejects human/apply effects reachable from concurrent callbacks", () => {
  assert.throws(() => analyzeHelpers(`
    async function run(flow, args) {
      async function ask(item) { return await flow.ask({ prompt: item, response: Answer }); }
      return await flow.map(args.items, ask, { key: item => item });
    }
  `), /flow.ask is unavailable in concurrent helper ask/);
});

test("rejects unknown callback expressions rather than interpreting JavaScript dynamically", () => {
  assert.throws(() => analyzeHelpers(`
    async function run(flow, args) {
      return await flow.map(args.items, chooseCallback(args.mode), { key: item => item.id });
    }
  `), /lexically known callback/);
});
