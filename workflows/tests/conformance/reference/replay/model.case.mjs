// Executable oracle for the workflow runtime conformance contract.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTree,
  callsInOrder,
  candidate,
  effect,
  mapped,
  parallel,
  replayGlobalPrefix,
  replayTree,
  sequence,
} from "./model.js";

const sourceTree = (program) => buildTree(program, { runId: "source-run" });
const targetTree = (program) => buildTree(program, { runId: "target-run" });

test("native repeated call sites receive sequential scope slots", () => {
  const tree = buildTree(sequence(
    effect("attempt", "same-site:input-1"),
    effect("attempt", "same-site:input-2"),
    effect("attempt", "same-site:input-3"),
  ));
  assert.deepEqual(tree.nodes.map((node) => node.path), [
    "run/000000",
    "run/000001",
    "run/000002",
  ]);
});

test("keyed lane identity is independent from completion order", () => {
  const tree = buildTree(sequence(parallel("inspection", {
    architecture: sequence(effect("inspect", "architecture")),
    tests: sequence(effect("inspect", "tests")),
    risks: sequence(effect("inspect", "risks")),
  })));
  assert.deepEqual(Object.keys(tree.nodes[0].lanes), ["architecture", "tests", "risks"]);
  assert.equal(tree.nodes[0].lanes.architecture.nodes[0].path, "run/000000/branch:architecture/000000");
});

test("global prefix reuse of an unchanged sibling depends on source completion timing", () => {
  const source = sourceTree(sequence(parallel("work", {
    changed: sequence(effect("first", "old"), effect("second", "same-a2")),
    stable: sequence(effect("first", "same-b1"), effect("second", "same-b2")),
  })));
  const target = targetTree(sequence(parallel("work", {
    changed: sequence(effect("first", "new"), effect("second", "same-a2")),
    stable: sequence(effect("first", "same-b1"), effect("second", "same-b2")),
  })));

  const changedFirst = callsInOrder(source, [
    "run/000000/branch:changed/000000",
    "run/000000/branch:stable/000000",
    "run/000000/branch:stable/000001",
    "run/000000/branch:changed/000001",
  ]);
  const stableFirst = callsInOrder(source, [
    "run/000000/branch:stable/000000",
    "run/000000/branch:stable/000001",
    "run/000000/branch:changed/000000",
    "run/000000/branch:changed/000001",
  ]);

  assert.deepEqual(replayGlobalPrefix(changedFirst, target).reused, []);
  assert.deepEqual(replayGlobalPrefix(stableFirst, target).reused, [
    "run/000000/branch:stable/000000",
    "run/000000/branch:stable/000001",
  ]);
});

test("causal tree replay always reuses an unchanged sibling lane", () => {
  const source = sourceTree(sequence(parallel("work", {
    changed: sequence(effect("first", "old"), effect("second", "same-a2")),
    stable: sequence(effect("first", "same-b1"), effect("second", "same-b2")),
  })));
  const target = targetTree(sequence(parallel("work", {
    changed: sequence(effect("first", "new"), effect("second", "same-a2")),
    stable: sequence(effect("first", "same-b1"), effect("second", "same-b2")),
  })));

  const replay = replayTree(source, target);
  assert.deepEqual(replay.reused, [
    "run/000000/branch:stable/000000",
    "run/000000/branch:stable/000001",
  ]);
  assert.ok(replay.misses.some((miss) => miss.path === "run/000000/branch:changed/000000"));
  assert.ok(replay.misses.some((miss) => miss.path === "run/000000" && miss.reason === "structural join changed"));
});

test("a lane remains prefix-only after its first mismatch", () => {
  const source = sourceTree(sequence(parallel("work", {
    lane: sequence(effect("one", "same"), effect("two", "old"), effect("three", "same")),
  })));
  const target = targetTree(sequence(parallel("work", {
    lane: sequence(effect("one", "same"), effect("two", "new"), effect("three", "same")),
  })));
  assert.deepEqual(replayTree(source, target).reused, ["run/000000/branch:lane/000000"]);
});

test("map key reorder reuses item lanes but changes the join", () => {
  const lanes = {
    a: sequence(effect("research", "a")),
    b: sequence(effect("research", "b")),
  };
  const source = sourceTree(sequence(mapped("angles", lanes, ["a", "b"])));
  const target = targetTree(sequence(mapped("angles", lanes, ["b", "a"])));
  const replay = replayTree(source, target);
  assert.deepEqual(new Set(replay.reused), new Set([
    "run/000000/item:a/000000",
    "run/000000/item:b/000000",
  ]));
  assert.ok(replay.misses.some((miss) => miss.path === "run/000000" && miss.reason === "structural join changed"));
});

test("added map keys do not invalidate existing item lanes", () => {
  const source = sourceTree(sequence(mapped("angles", {
    a: sequence(effect("research", "a")),
  }, ["a"])));
  const target = targetTree(sequence(mapped("angles", {
    a: sequence(effect("research", "a")),
    b: sequence(effect("research", "b")),
  }, ["a", "b"])));
  const replay = replayTree(source, target);
  assert.deepEqual(replay.reused, ["run/000000/item:a/000000"]);
  assert.ok(replay.misses.some((miss) => miss.path === "run/000000"));
});

test("failed collect lane is not cross-run replayed while successful sibling is", () => {
  const source = sourceTree(sequence(mapped("angles", {
    failed: sequence(effect("research", "failed", null, { failure: "provider unavailable" })),
    good: sequence(effect("research", "good", { answer: 1 })),
  }, ["failed", "good"], { errors: "collect" })));
  const target = targetTree(sequence(mapped("angles", {
    failed: sequence(effect("research", "failed", { answer: 2 })),
    good: sequence(effect("research", "good", { answer: 1 })),
  }, ["failed", "good"], { errors: "collect" })));
  const replay = replayTree(source, target);
  assert.deepEqual(replay.reused, ["run/000000/item:good/000000"]);
  assert.ok(replay.misses.some((miss) => miss.path === "run/000000/item:failed/000000"));
});

test("candidate child prefix replays but changed provenance prevents downstream root reuse", () => {
  const source = sourceTree(sequence(
    candidate("implementation", sequence(
      effect("inspect", "same"),
      effect("implement", "old", { changed: ["a"] }),
    ), { changedPaths: ["a"] }),
    effect("verify", "verification:a"),
  ));
  const target = targetTree(sequence(
    candidate("implementation", sequence(
      effect("inspect", "same"),
      effect("implement", "new", { changed: ["a"] }),
    ), { changedPaths: ["a"] }),
    effect("verify", "verification:a"),
  ));
  const replay = replayTree(source, target);
  assert.deepEqual(replay.reused, ["run/000000/candidate/000000"]);
  assert.ok(!replay.reused.includes("run/000001"));
});

test("apply is never replayable and ends its sequential prefix", () => {
  const source = sourceTree(sequence(
    effect("accept", "candidate:a"),
    effect("apply", "candidate:a", { applied: true }, { replayable: false }),
  ));
  const target = targetTree(sequence(
    effect("accept", "candidate:a"),
    effect("apply", "candidate:a", { applied: true }, { replayable: false }),
  ));
  const replay = replayTree(source, target);
  assert.deepEqual(replay.reused, ["run/000000"]);
  assert.equal(replay.misses[0].reason, "non-replayable");
});

test("matching semantics import source results and call keys rather than hypothetical target results", () => {
  const source = sourceTree(sequence(
    effect("agent", "same-input", { answer: "source" }),
    effect("synthesis", "uses-source-answer", { report: 1 }),
  ));
  const target = targetTree(sequence(
    effect("renamed display only", "same-input", { answer: "would-have-differed" }),
    effect("synthesis", "uses-source-answer", { report: 999 }),
  ));
  const replay = replayTree(source, target);
  assert.deepEqual(replay.reused, ["run/000000", "run/000001"]);
  assert.equal(replay.terminalKey, source.terminalKey);
});

test("a changed parallel join prevents downstream parent-lane reuse", () => {
  const source = sourceTree(sequence(
    parallel("inspection", {
      a: sequence(effect("inspect", "old")),
      b: sequence(effect("inspect", "stable")),
    }),
    effect("synthesize", "same-looking-downstream"),
  ));
  const target = targetTree(sequence(
    parallel("inspection", {
      a: sequence(effect("inspect", "new")),
      b: sequence(effect("inspect", "stable")),
    }),
    effect("synthesize", "same-looking-downstream"),
  ));
  const replay = replayTree(source, target);
  assert.deepEqual(replay.reused, ["run/000000/branch:b/000000"]);
  assert.ok(!replay.reused.includes("run/000001"));
});

test("a prior parent-lane mismatch makes later structured children ineligible", () => {
  const source = sourceTree(sequence(
    effect("prepare", "old"),
    parallel("inspection", { a: sequence(effect("inspect", "same")) }),
  ));
  const target = targetTree(sequence(
    effect("prepare", "new"),
    parallel("inspection", { a: sequence(effect("inspect", "same")) }),
  ));
  assert.deepEqual(replayTree(source, target).reused, []);
});

test("changing collect/fail-fast policy reuses lane calls but changes the join", () => {
  const lanes = { a: sequence(effect("inspect", "same")) };
  const source = sourceTree(sequence(parallel("inspection", lanes, { errors: "fail-fast" })));
  const target = targetTree(sequence(parallel("inspection", lanes, { errors: "collect" })));
  const replay = replayTree(source, target);
  assert.deepEqual(replay.reused, ["run/000000/branch:a/000000"]);
  assert.ok(replay.misses.some((miss) => miss.reason === "structural join changed"));
});

test("causal reuse is scheduler-permutation invariant while global prefix is not", () => {
  const source = sourceTree(sequence(parallel("work", {
    changed: sequence(effect("one", "old"), effect("two", "a2")),
    stable: sequence(effect("one", "b1"), effect("two", "b2")),
  })));
  const target = targetTree(sequence(parallel("work", {
    changed: sequence(effect("one", "new"), effect("two", "a2")),
    stable: sequence(effect("one", "b1"), effect("two", "b2")),
  })));
  const paths = [
    "run/000000/branch:changed/000000",
    "run/000000/branch:changed/000001",
    "run/000000/branch:stable/000000",
    "run/000000/branch:stable/000001",
  ];
  const legalOrders = interleavings(
    paths.slice(0, 2),
    paths.slice(2),
  );
  const globalReuseCounts = new Set(legalOrders.map((order) =>
    replayGlobalPrefix(callsInOrder(source, order), target).reused.length));
  assert.deepEqual(globalReuseCounts, new Set([0, 1, 2]));
  assert.deepEqual(replayTree(source, target).reused, [
    "run/000000/branch:stable/000000",
    "run/000000/branch:stable/000001",
  ]);
});

function interleavings(left, right) {
  if (left.length === 0) return [right];
  if (right.length === 0) return [left];
  return [
    ...interleavings(left.slice(1), right).map((tail) => [left[0], ...tail]),
    ...interleavings(left, right.slice(1)).map((tail) => [right[0], ...tail]),
  ];
}
