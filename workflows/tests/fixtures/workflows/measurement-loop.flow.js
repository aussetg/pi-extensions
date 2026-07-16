const summarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["baseline", "current", "best", "relativeGain", "observationCount"],
  properties: {
    baseline: { type: "number" },
    current: { type: "number" },
    best: { type: "number" },
    relativeGain: { anyOf: [{ type: "number" }, { type: "null" }] },
    observationCount: { type: "integer", minimum: 1 },
  },
};

export default defineWorkflow({
  name: "measurement-loop-fixture",
  title: "Measurement loop fixture",
  description: "Focused test fixture for grouped measurements and deterministic loops.",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["cohorts", "throughput"],
    properties: {
      cohorts: { type: "integer", minimum: 1, maximum: 3 },
      throughput: summarySchema,
    },
  },
  capabilities: ["read-project", "host-command"],
  modelVisible: false,
  maxParallelism: 1,

  async run(flow, _args) {
    const throughput = flow.metric("throughput", {
      direction: "maximize",
      primary: true,
      target: { kind: "relativeGain", value: 0.5 },
      sampling: { warmups: 1, samples: 2, aggregate: "median" },
    });
    await flow.measure("baseline", {
      measurement: "builtin:runtime-baseline",
      metric: throughput,
      output: "throughput",
    });
    let cohorts = 1;
    await flow.loop("observations", {
      maxIterations: 2,
      while: () => throughput.needsImprovement(),
    }, async () => {
      await flow.measure("sample", {
        measurement: "builtin:runtime-baseline",
        metric: throughput,
        output: "throughput",
      });
      cohorts += 1;
    });
    return { cohorts, throughput: throughput.summary() };
  },
});
