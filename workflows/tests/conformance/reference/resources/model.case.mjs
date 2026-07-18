// Executable oracle for the workflow runtime conformance contract.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MeasurementRegistry,
  measurementSemanticKey,
  prepareOptimizeInvocation,
} from "./model.js";

const profile = {
  id: "project:parser-benchmark",
  argv: ["./bench-parser"],
  outputs: {
    "p95-latency-ms": { extract: { kind: "json-path", path: "$.p95" } },
    "peak-rss-mib": { extract: { kind: "json-path", path: "$.rss" } },
  },
};

const invocation = {
  objective: "reduce parser latency",
  evaluator: profile.id,
  metrics: {
    primary: { output: "p95-latency-ms", direction: "minimize" },
    guardrails: [{
      output: "peak-rss-mib",
      direction: "minimize",
      reference: "baseline",
      maximumRelativeRegression: 0.05,
    }],
  },
};

test("launch resolves and snapshots one trusted invocation-selected profile", () => {
  const registry = new MeasurementRegistry([profile]);
  const prepared = prepareOptimizeInvocation(invocation, registry, { projectTrusted: true });
  assert.equal(prepared.snapshot.selector, profile.id);
  assert.match(prepared.snapshot.hash, /^sha256:/);
  assert.deepEqual(prepared.resources.measurement(profile.id).profile.argv, ["./bench-parser"]);
});

test("project resource selection is unavailable before project trust", () => {
  const registry = new MeasurementRegistry([profile]);
  assert.throws(
    () => prepareOptimizeInvocation(invocation, registry),
    /requires project trust/,
  );
  assert.deepEqual(registry.toolSchema().enum, []);
  assert.deepEqual(registry.toolSchema({ projectTrusted: true }).enum, [profile.id]);
});

test("requested metric outputs are validated before workflow execution", () => {
  const registry = new MeasurementRegistry([profile]);
  assert.throws(
    () => prepareOptimizeInvocation({
      ...invocation,
      metrics: { primary: { output: "not-declared", direction: "minimize" } },
    }, registry, { projectTrusted: true }),
    /has no output not-declared/,
  );
});

test("duplicate output roles are rejected", () => {
  const registry = new MeasurementRegistry([profile]);
  assert.throws(
    () => prepareOptimizeInvocation({
      ...invocation,
      metrics: {
        ...invocation.metrics,
        observe: [{ output: "p95-latency-ms", direction: "minimize" }],
      },
    }, registry, { projectTrusted: true }),
    /duplicate optimization output p95-latency-ms/,
  );
});

test("runtime cannot switch to a profile not pinned by the invocation", () => {
  const registry = new MeasurementRegistry([
    profile,
    { ...profile, id: "builtin:other" },
  ]);
  const prepared = prepareOptimizeInvocation(invocation, registry, { projectTrusted: true });
  assert.throws(
    () => prepared.resources.measurement("builtin:other"),
    /not pinned by this invocation/,
  );
});

test("registry changes after launch cannot alter the pinned profile", () => {
  const registry = new MeasurementRegistry([profile]);
  const prepared = prepareOptimizeInvocation(invocation, registry, { projectTrusted: true });
  registry.profiles.set(profile.id, { ...profile, argv: ["./different"] });
  assert.deepEqual(prepared.resources.measurement(profile.id).profile.argv, ["./bench-parser"]);
});

test("profile revision changes semantic replay identity", () => {
  const first = prepareOptimizeInvocation(invocation, new MeasurementRegistry([profile]), {
    projectTrusted: true,
  });
  const second = prepareOptimizeInvocation(invocation, new MeasurementRegistry([{
    ...profile,
    argv: ["./bench-parser", "--new"],
  }]), { projectTrusted: true });
  assert.notEqual(
    measurementSemanticKey(first.snapshot, invocation.metrics),
    measurementSemanticKey(second.snapshot, invocation.metrics),
  );
});
