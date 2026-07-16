import assert from "node:assert/strict";
import test from "node:test";

import { CONFORMANCE_REQUIREMENTS, PERFORMANCE_GATES, evaluatePerformanceReport, verifyConformanceCoverage } from "../scripts/release-gate.mjs";

test("the release conformance manifest resolves every capability to executable regression tests", () => {
  const coverage = verifyConformanceCoverage();
  assert.equal(coverage.requirementCount, CONFORMANCE_REQUIREMENTS.length);
  assert.ok(coverage.discoveredTestCount >= 191);
  assert.deepEqual(coverage.failures, []);
});

test("the release performance evaluator rejects missing and over-budget scenarios", () => {
  const passingReport = {
    meta: { baseIterations: 30, exposeGc: true },
    results: PERFORMANCE_GATES.map((gate) => ({
      name: gate.scenario,
      metrics: [{ label: "total", wallMs: { p95: gate.maximumMs } }],
      resources: { childRootPids: [] },
    })),
  };
  assert.deepEqual(evaluatePerformanceReport(passingReport).failures, []);

  const failingReport = structuredClone(passingReport);
  failingReport.results.find((result) => result.name === "lsp/fake-delay-200").metrics[0].wallMs.p95 = 91;
  failingReport.results = failingReport.results.filter((result) => result.name !== "lsp/fake-warm");
  const failures = evaluatePerformanceReport(failingReport).failures;
  assert.ok(failures.some((failure) => failure.includes("delayed diagnostic inline budget")));
  assert.ok(failures.some((failure) => failure.includes("warm fake-LSP edit")));

  delete failingReport.meta.baseIterations;
  assert.ok(evaluatePerformanceReport(failingReport).failures.some((failure) => failure.includes("base iterations")));
});
