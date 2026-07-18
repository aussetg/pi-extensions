// Executable oracle for the workflow runtime conformance contract.
import test from "node:test";
import assert from "node:assert/strict";
import { DurableRuntime, SameRunJournal, SimulatedCrash } from "./runtime.js";

async function representativeProgram(flow) {
  let total = 0;
  const values = [];
  for (let iteration = 0; iteration < 3; iteration++) {
    const value = await flow.effect("repeated-site", { iteration }, async () => iteration + 1);
    total += value;
    values.push(value);
  }

  let failure = "";
  try {
    await flow.effect("expected-failure", { attempt: 1 }, async () => {
      throw new Error("provider unavailable");
    });
  } catch (error) {
    if (error instanceof SimulatedCrash) throw error;
    failure = error.message;
  }

  const candidate = await flow.candidate("implementation", async () => {
    let candidateTotal = 0;
    for (let point = 0; point < 2; point++) {
      candidateTotal += await flow.effect("point", { point }, async () => 10 + point);
    }
    return { candidateTotal };
  }, { changedPaths: ["src/a.ts"] });

  const verification = await flow.effect(
    "verification",
    { candidate: candidate.output },
    async () => ({ passed: true }),
  );
  return { total, values, failure, candidate, verification };
}

test("native loops and local state reconstruct after a crash at every semantic transition", async () => {
  const baselineJournal = new SameRunJournal();
  const baseline = await new DurableRuntime(baselineJournal).run(representativeProgram);
  const transitions = baselineJournal.transitions.length;
  assert.ok(transitions > 10);

  for (let crashAt = 1; crashAt <= transitions; crashAt++) {
    const journal = new SameRunJournal();
    await assert.rejects(
      () => new DurableRuntime(journal, { crashAt }).run(representativeProgram),
      SimulatedCrash,
      `expected crash at transition ${crashAt}`,
    );
    const recovered = await new DurableRuntime(journal).run(representativeProgram);
    assert.deepEqual(recovered, baseline, `different result after crash transition ${crashAt}`);
    for (const count of journal.executions.values()) {
      assert.equal(count, 1, `effect physically executed more than once after crash transition ${crashAt}`);
    }
  }
});

test("completed effects restore their recorded failure into ordinary catch control", async () => {
  const journal = new SameRunJournal();
  const first = await new DurableRuntime(journal).run(representativeProgram);
  const second = await new DurableRuntime(journal).run(representativeProgram);
  assert.equal(first.failure, "provider unavailable");
  assert.deepEqual(second, first);
  assert.equal(journal.executions.get("run/000003"), 1);
});

test("candidate callback-local state reconstructs from restored child effects", async () => {
  let bodyCalls = 0;
  const program = async (flow) => await flow.candidate("candidate", async () => {
    bodyCalls++;
    const first = await flow.effect("first", {}, async () => 2);
    const second = await flow.effect("second", {}, async () => 3);
    return { total: first + second };
  });
  const journal = new SameRunJournal();
  await assert.rejects(
    () => new DurableRuntime(journal, { crashAt: 7 }).run(program),
    SimulatedCrash,
  );
  const recovered = await new DurableRuntime(journal).run(program);
  assert.equal(recovered.output.total, 5);
  assert.equal(bodyCalls, 2);
  assert.equal(journal.executions.get("run/000000/candidate/000000"), 1);
  assert.equal(journal.executions.get("run/000000/candidate/000001"), 1);
});

test("mutating captured outer state in a candidate callback is observably unsafe", async () => {
  const program = async (flow) => {
    let outer = 0;
    const candidate = await flow.candidate("candidate", async () => {
      outer++;
      await flow.effect("child", {}, async () => true);
      return { observedOuter: outer };
    });
    return { outer, candidate: candidate.output.observedOuter };
  };

  const baseline = await new DurableRuntime(new SameRunJournal()).run(program);
  assert.deepEqual(baseline, { outer: 1, candidate: 1 });

  const journal = new SameRunJournal();
  await assert.rejects(
    () => new DurableRuntime(journal, { crashAt: 6 }).run(program),
    SimulatedCrash,
  );
  const recovered = await new DurableRuntime(journal).run(program);
  assert.deepEqual(recovered, { outer: 0, candidate: 1 });
});

test("same-run recovery rejects semantic source drift at a cursor position", async () => {
  const journal = new SameRunJournal();
  await new DurableRuntime(journal).run((flow) =>
    flow.effect("display", { prompt: "old" }, async () => "result"));
  await assert.rejects(
    () => new DurableRuntime(journal).run((flow) =>
      flow.effect("renamed display", { prompt: "new" }, async () => "result")),
    /semantic operation mismatch at run\/000000/,
  );
});

test("display name changes do not alter semantic identity", async () => {
  const journal = new SameRunJournal();
  await new DurableRuntime(journal).run((flow) =>
    flow.effect("old display", { prompt: "same" }, async () => "result"));
  const restored = await new DurableRuntime(journal).run((flow) =>
    flow.effect("new display", { prompt: "same" }, async () => "different live result"));
  assert.equal(restored, "result");
});
