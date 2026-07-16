import { describe, expect, it } from "vitest";
import { extractMeasurementInvocation, MeasurementOutputError } from "../src/measurements/extractors.js";
import {
  applyMetricCohortDeltaToHandles,
  applyMetricDispositionToHandles,
  buildMetricCohortDelta,
  createMetricHandle,
  evaluateMeasurementPolicy,
  isMetricImprovement,
  isMetricWithinGuardrail,
  metricHandleState,
  normalizeMetricDefinition,
  type MetricObservation,
} from "../src/measurements/metrics.js";
import {
  normalizeMeasurementProfile,
  type MeasurementProfileDefinition,
  type MeasurementProfileSnapshot,
} from "../src/measurements/profiles.js";
import { stableHash } from "../src/utils/hashes.js";

describe("measurement extractor contracts", () => {
  it("keeps physical-core affinity as reviewed measurement profile policy", () => {
    const normalized = normalizeMeasurementProfile({
      name: "pinned-bench",
      description: "physical core benchmark",
      argv: ["bench"],
      timeoutMs: 1_000,
      cpuAffinity: { physicalCores: 2 },
      outputs: { speed: { extract: { kind: "protocol" } } },
    });
    expect(normalized.cpuAffinity).toEqual({ physicalCores: 2 });
    expect(() => normalizeMeasurementProfile({
      ...normalized,
      cpuAffinity: { physicalCores: 0 },
    })).toThrow(/physicalCores/i);
  });

  it("extracts finite JSON-path values and schema-valid diagnostic objects", () => {
    const profile = snapshot({
      name: "json-bench",
      description: "json benchmark",
      argv: ["bench"],
      timeoutMs: 1_000,
      outputs: { speed: { extract: { kind: "json-path", path: "$.results[0].speed" } } },
      diagnostics: {
        extract: { kind: "json-path", path: "$.diagnostic" },
        schema: {
          type: "object", additionalProperties: false, required: ["mode"],
          properties: { mode: { type: "string" } },
        },
      },
    });
    expect(extractMeasurementInvocation(
      profile,
      ["speed"],
      Buffer.from(JSON.stringify({ results: [{ speed: 12.5 }], diagnostic: { mode: "steady" } })),
    )).toEqual({ values: { speed: 12.5 }, diagnostic: { mode: "steady" } });
  });

  it("extracts exactly one regex numeric token with numbered and named groups", () => {
    const numbered = snapshot(regexProfile("speed=(?<value>[0-9.]+)", "value"));
    expect(extractMeasurementInvocation(numbered, ["speed"], Buffer.from("speed=1.25\n"))).toEqual({ values: { speed: 1.25 } });

    const indexed = snapshot(regexProfile("value: ([+-]?[0-9]+)", 1));
    expect(extractMeasurementInvocation(indexed, ["speed"], Buffer.from("value: -4\n"))).toEqual({ values: { speed: -4 } });
    expect(() => extractMeasurementInvocation(indexed, ["speed"], Buffer.from("value: 1 value: 2"))).toThrow(/duplicate/i);
  });

  it("rejects invalid JSON values, missing paths, diagnostics, UTF-8, and mixed extraction protocols", () => {
    const profile = snapshot({
      name: "json-bench",
      description: "json benchmark",
      argv: ["bench"],
      timeoutMs: 1_000,
      outputs: { speed: { extract: { kind: "json-path", path: "$.speed" } } },
      diagnostics: {
        extract: { kind: "json-path", path: "$.diagnostic" },
        schema: { type: "object", required: ["ok"], properties: { ok: { const: true } } },
      },
    });
    for (const bytes of [
      Buffer.from("not-json"),
      Buffer.from(JSON.stringify({ speed: "1", diagnostic: { ok: true } })),
      Buffer.from(JSON.stringify({ diagnostic: { ok: true } })),
      Buffer.from(JSON.stringify({ speed: 1, diagnostic: { ok: false } })),
      Buffer.from([0xff]),
    ]) expect(() => extractMeasurementInvocation(profile, ["speed"], bytes)).toThrow(MeasurementOutputError);

    expect(() => normalizeMeasurementProfile({
      name: "mixed", description: "mixed", argv: ["bench"], timeoutMs: 1_000,
      outputs: {
        speed: { extract: { kind: "protocol" } },
        memory: { extract: { kind: "json-path", path: "$.memory" } },
      },
    })).toThrow(/cannot be mixed/i);
  });

  it("accepts unselected declared protocol outputs but rejects unknown records", () => {
    const profile = snapshot({
      name: "protocol", description: "protocol", argv: ["bench"], timeoutMs: 1_000,
      outputs: {
        memory: { extract: { kind: "protocol" } },
        speed: { extract: { kind: "protocol" } },
      },
    });
    const selected = [
      JSON.stringify({ type: "metric", id: "speed", value: 10 }),
      JSON.stringify({ type: "metric", id: "memory", value: 20 }),
      "",
    ].join("\n");
    expect(extractMeasurementInvocation(profile, ["speed"], Buffer.from(selected))).toEqual({ values: { speed: 10 } });
    expect(() => extractMeasurementInvocation(
      profile,
      ["speed"],
      Buffer.from(`${selected}${JSON.stringify({ type: "metric", id: "other", value: 1 })}\n`),
    )).toThrow(/unexpected measurement output|too many records/i);
  });
});

describe("metric normalization and policy", () => {
  it("normalizes omitted sampling and rejects empty, negative, or conflicting policy", () => {
    expect(normalizeMetricDefinition({ direction: "maximize" }, "score").sampling).toEqual({
      warmups: 0, samples: 1, aggregate: "median",
    });
    expect(normalizeMetricDefinition({
      direction: "minimize", sampling: { samples: 2, aggregate: "max" },
    }, "latency").sampling).toEqual({ warmups: 0, samples: 2, aggregate: "max" });

    for (const definition of [
      { direction: "maximize", improvement: {} },
      { direction: "maximize", improvement: { minimumAbsolute: -1 } },
      { direction: "maximize", guardrail: { reference: "baseline" } },
      { direction: "maximize", guardrail: { reference: "best", maximumRelativeRegression: -1 } },
      { direction: "maximize", primary: true, guardrail: { reference: "baseline", maximumAbsoluteRegression: 1 } },
      { direction: "maximize", target: { kind: "relativeGain", value: -0.1 } },
      { direction: "maximize", sampling: { warmups: 1, samples: 0, aggregate: "mean" } },
    ]) expect(() => normalizeMetricDefinition(definition, "score")).toThrow();
  });

  it("requires both minimum-improvement thresholds and reverses change for minimize metrics", () => {
    const strict = createMetricHandle("strict", { direction: "maximize" });
    const maximize = createMetricHandle("speed", {
      direction: "maximize",
      improvement: { minimumAbsolute: 5, minimumRelative: 0.05 },
    });
    const minimize = createMetricHandle("latency", {
      direction: "minimize",
      improvement: { minimumAbsolute: 10, minimumRelative: 0.1 },
    });
    establishBaselines([
      { outputId: "strict", handle: strict, value: 100 },
      { outputId: "speed", handle: maximize, value: 100 },
      { outputId: "latency", handle: minimize, value: 100 },
    ]);
    expect(isMetricImprovement(strict, observation("strict", "strict", 100, "0"))).toBe(false);
    expect(isMetricImprovement(strict, observation("strict", "strict", 100.0001, "f"))).toBe(true);
    expect(isMetricImprovement(maximize, observation("speed", "speed", 105, "1"))).toBe(true);
    expect(isMetricImprovement(maximize, observation("speed", "speed", 104.99, "2"))).toBe(false);
    expect(isMetricImprovement(minimize, observation("latency", "latency", 90, "3"))).toBe(true);
    expect(isMetricImprovement(minimize, observation("latency", "latency", 91, "4"))).toBe(false);
  });

  it("uses the same primary, guardrail, missing-observation, and secondary non-veto policy", () => {
    const primary = createMetricHandle("speed", {
      direction: "maximize", primary: true,
      improvement: { minimumAbsolute: 5, minimumRelative: 0.05 },
    });
    const guardrail = createMetricHandle("memory", {
      direction: "minimize",
      guardrail: { reference: "baseline", maximumAbsoluteRegression: 5, maximumRelativeRegression: 0.1 },
    });
    const secondary = createMetricHandle("quality", { direction: "maximize" });
    establishBaselines([
      { outputId: "speed", handle: primary, value: 100 },
      { outputId: "memory", handle: guardrail, value: 50 },
      { outputId: "quality", handle: secondary, value: 10 },
    ]);
    const passing = evaluateMeasurementPolicy([primary, guardrail, secondary], {
      speed: observation("speed", "speed", 105, "5"),
      memory: observation("memory", "memory", 55, "6"),
    });
    expect(passing).toMatchObject({
      eligible: true,
      primary: { metricId: "speed", present: true, passed: true },
      guardrails: [{ metricId: "memory", present: true, passed: true }],
      secondary: [{ metricId: "quality", present: false }],
      violations: [],
    });
    expect(evaluateMeasurementPolicy([primary, guardrail, secondary], {
      speed: observation("speed", "speed", 104, "7"),
      memory: observation("memory", "memory", 56, "8"),
      quality: observation("quality", "quality", -1_000, "9"),
    })).toMatchObject({ eligible: false, violations: ["primary:speed", "guardrail:memory"] });
    expect(evaluateMeasurementPolicy([primary, guardrail], {
      speed: observation("speed", "speed", 105, "a"),
    })).toMatchObject({ eligible: false, violations: ["guardrail:memory"] });
    expect(evaluateMeasurementPolicy([guardrail], {
      memory: observation("memory", "memory", 55, "b"),
    }).eligible).toBe(true);
  });

  it("rejects duplicate primary authority and relative guardrails on a zero reference", () => {
    expect(() => evaluateMeasurementPolicy([
      createMetricHandle("first", { direction: "maximize", primary: true }),
      createMetricHandle("second", { direction: "maximize", primary: true }),
    ], {})).toThrow(/only one primary/i);

    const relative = createMetricHandle("relative", {
      direction: "minimize",
      guardrail: { reference: "baseline", maximumRelativeRegression: 0.1 },
    });
    const absolute = createMetricHandle("absolute", {
      direction: "minimize",
      guardrail: { reference: "baseline", maximumAbsoluteRegression: 1 },
    });
    establishBaselines([
      { outputId: "relative", handle: relative, value: 0 },
      { outputId: "absolute", handle: absolute, value: 0 },
    ]);
    expect(() => isMetricWithinGuardrail(relative, observation("relative", "relative", 0.1, "c"))).toThrow(/zero reference/i);
    expect(isMetricWithinGuardrail(absolute, observation("absolute", "absolute", 1, "d"))).toBe(true);
    expect(isMetricWithinGuardrail(absolute, observation("absolute", "absolute", 1.01, "e"))).toBe(false);
  });

  it("uses baseline as the best-reference guardrail fallback before any accepted candidate", () => {
    const guardrail = createMetricHandle("memory", {
      direction: "minimize",
      guardrail: { reference: "best", maximumAbsoluteRegression: 5 },
    });
    establishBaselines([{ outputId: "memory", handle: guardrail, value: 50 }]);
    expect(isMetricWithinGuardrail(guardrail, observation("memory", "memory", 55, "1"))).toBe(true);
    expect(isMetricWithinGuardrail(guardrail, observation("memory", "memory", 55.1, "2"))).toBe(false);
  });

  it("advances grouped accepted references and leaves rejected observations out of them", () => {
    const speed = createMetricHandle("speed", { direction: "maximize", primary: true });
    const memory = createMetricHandle("memory", {
      direction: "minimize",
      guardrail: { reference: "best", maximumAbsoluteRegression: 10 },
    });
    const handles = new Map([["speed", speed], ["memory", memory]]);
    establishBaselines([
      { outputId: "speed", handle: speed, value: 100 },
      { outputId: "memory", handle: memory, value: 50 },
    ]);

    const accepted = candidateDelta("a", "b", [
      { outputId: "speed", handle: speed, value: 110 },
      { outputId: "memory", handle: memory, value: 55 },
    ]);
    applyMetricCohortDeltaToHandles(handles, accepted);
    expect(metricHandleState(speed).recentObservations.at(-1)).toMatchObject({
      status: "pending", bestReference: 100,
    });
    applyMetricDispositionToHandles(handles, accepted, "accepted");
    expect(metricHandleState(speed)).toMatchObject({ current: 110, best: 110, relativeGain: 0.1 });
    expect(metricHandleState(memory)).toMatchObject({ current: 55, best: 55, relativeGain: -0.1 });
    expect(metricHandleState(memory).recentObservations.at(-1)).toMatchObject({ status: "accepted" });

    const rejected = candidateDelta("c", "d", [
      { outputId: "speed", handle: speed, value: 90 },
      { outputId: "memory", handle: memory, value: 70 },
    ]);
    applyMetricCohortDeltaToHandles(handles, rejected);
    applyMetricDispositionToHandles(handles, rejected, "rejected");
    expect(metricHandleState(speed)).toMatchObject({ current: 110, best: 110, relativeGain: 0.1 });
    expect(metricHandleState(memory)).toMatchObject({ current: 55, best: 55, relativeGain: -0.1 });
    expect(metricHandleState(speed).recentObservations.at(-1)).toMatchObject({
      status: "rejected", bestReference: 110,
    });
  });
});

function regexProfile(pattern: string, group: number | string): MeasurementProfileDefinition {
  return {
    name: "regex", description: "regex benchmark", argv: ["bench"], timeoutMs: 1_000,
    outputs: { speed: { extract: { kind: "regex", pattern, group } } },
  };
}

function snapshot(definition: MeasurementProfileDefinition): MeasurementProfileSnapshot {
  const normalized = normalizeMeasurementProfile(definition);
  return {
    ...normalized,
    id: `project:${normalized.name}`,
    namespace: "project",
    path: `<project:${normalized.name}>`,
    hash: stableHash({ namespace: "project", definition: normalized }),
  };
}

function establishBaselines(mappings: Array<{ outputId: string; handle: object; value: number }>): void {
  const delta = buildMetricCohortDelta({
    measurementId: `measurement_${"0".repeat(32)}`,
    operationPath: "run/measure:baseline",
    profileId: "project:bench",
    profileHash: `sha256:${"1".repeat(64)}`,
    environmentHash: `sha256:${"2".repeat(64)}`,
    mappings: mappings.map((mapping) => ({ ...mapping, samples: [mapping.value] })),
  });
  applyMetricCohortDeltaToHandles(
    new Map(mappings.map((mapping) => [metricHandleState(mapping.handle).metricId, mapping.handle])),
    delta,
  );
}

function candidateDelta(
  measurementSuffix: string,
  candidateSuffix: string,
  mappings: Array<{ outputId: string; handle: object; value: number }>,
) {
  return buildMetricCohortDelta({
    measurementId: `measurement_${measurementSuffix.repeat(32)}`,
    operationPath: `run/measure:candidate-${measurementSuffix}`,
    profileId: "project:bench",
    profileHash: `sha256:${"1".repeat(64)}`,
    environmentHash: `sha256:${"2".repeat(64)}`,
    candidate: {
      candidateId: `candidate_${candidateSuffix.repeat(32)}`,
      treeHash: `sha256:${"3".repeat(64)}`,
      lineageHash: `sha256:${"4".repeat(64)}`,
    },
    mappings: mappings.map((mapping) => ({ ...mapping, samples: [mapping.value] })),
  });
}

function observation(metricId: string, outputId: string, value: number, suffix: string): MetricObservation {
  return {
    observationId: `observation_${suffix.padEnd(32, suffix)}`,
    metricId,
    outputId,
    value,
    samples: [value],
  };
}
