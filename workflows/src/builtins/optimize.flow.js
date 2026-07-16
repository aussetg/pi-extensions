const metricSummarySchema = {
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

const experimentMetadataSchema = {
  type: "object",
  additionalProperties: false,
  required: ["hypothesis", "changeSummary", "expectedEffect", "nextFocus"],
  properties: {
    hypothesis: { type: "string", minLength: 1, maxLength: 1000 },
    changeSummary: { type: "string", minLength: 1, maxLength: 2000 },
    expectedEffect: { type: "string", minLength: 1, maxLength: 1000 },
    nextFocus: { type: "string", minLength: 1, maxLength: 1000 },
  },
};

const reflectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["learned", "nextFocus"],
  properties: {
    learned: { type: "string", minLength: 1, maxLength: 2000 },
    nextFocus: { type: "string", minLength: 1, maxLength: 1000 },
  },
};

const writePathSchema = {
  type: "string",
  minLength: 1,
  maxLength: 500,
  pattern: "^(?!/)(?!.*//)(?!.*(?:^|/)\\.\\.?(?:/|$))(?!.*(?:^|/)\\.git(?:/|$))(?!.*[?*\\[\\]{}])[^\\u0000-\\u001f]+$",
};

export default defineWorkflow({
  name: "optimize",
  title: "Optimize",
  description: "Improve a trusted metric, reverify the best candidate, and apply it after approval.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["objective", "writePaths"],
    properties: {
      objective: { type: "string", minLength: 1, maxLength: 20000 },
      writePaths: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: writePathSchema },
      targetRelativeGain: { type: "number", minimum: 0, maximum: 10 },
      maxIterations: { type: "integer", minimum: 1, maximum: 12 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["changed", "metrics", "experiments"],
    properties: {
      changed: { type: "boolean" },
      metrics: {
        type: "object",
        additionalProperties: false,
        required: ["throughput", "peakRss"],
        properties: { throughput: metricSummarySchema, peakRss: metricSummarySchema },
      },
      experiments: { type: "integer", minimum: 0, maximum: 12 },
    },
  },
  capabilities: ["read-project", "candidate-write", "host-command", "mediated-network", "human-input"],
  modelVisible: true,
  maxParallelism: 1,

  async run(flow, args) {
    const performance = flow.metric("performance", {
      title: "Throughput",
      direction: "maximize",
      unit: "req/s",
      primary: true,
      target: { kind: "relativeGain", value: args.targetRelativeGain ?? 0.20 },
      sampling: { warmups: 1, samples: 3, aggregate: "median" },
      improvement: { minimumRelative: 0.01 },
    });
    const peakMemory = flow.metric("peak-memory", {
      title: "Peak RSS",
      direction: "minimize",
      unit: "MiB",
      sampling: { warmups: 1, samples: 3, aggregate: "median" },
      guardrail: { reference: "baseline", maximumRelativeRegression: 0.10 },
    });
    await flow.measure("baseline", {
      metrics: { throughput: performance, "peak-rss": peakMemory },
      measurement: "builtin:runtime-baseline",
    });

    let best = null;
    let bestVerification = null;
    let bestThroughput = null;
    let bestPeakMemory = null;
    let targetReached = (args.targetRelativeGain ?? 0.20) === 0;
    const history = [];
    let priorExperiment = null;
    await flow.loop("experiments", {
      maxIterations: args.maxIterations ?? 8,
      while: () => ({
        result: !targetReached,
        label: targetReached ? "throughput target reached" : "throughput still needs improvement",
        operands: { targetReached },
      }),
    }, async ({ iteration }) => {
      const hypothesis = await flow.agent("hypothesis", {
        profile: "builtin:researcher",
        prompt: [
          args.objective,
          `Design one coherent optimization hypothesis for attempt ${iteration + 1}.`,
          `Current throughput state: ${JSON.stringify(performance.summary())}`,
          `Current peak-memory state: ${JSON.stringify(peakMemory.summary())}`,
          "A prior experiment handoff is supplied when one exists. Do not repeat an equivalent attempt.",
          "Use mediated research only for primary technical evidence. Report progress, log the chosen hypothesis, and publish the complete experiment plan as an artifact before finish_work.",
        ].join("\n\n"),
        inputs: priorExperiment === null ? [] : [{ id: "prior-experiment", artifact: priorExperiment }],
        outputSchema: experimentMetadataSchema,
        network: "research",
        resultMode: "value-and-artifact",
      });
      /** @type {FlowProducedCandidate<FlowExperimentMetadata>} */
      const produced = await flow.candidate("attempt", async workspace => {
        return flow.agent("implementation", {
          profile: "builtin:implementer",
          prompt: [
            args.objective,
            `This is attempt ${iteration + 1}.`,
            "Implement the supplied experiment plan as one coherent candidate change.",
            "Use mediated research only when primary documentation is needed. Report progress and log consequential implementation decisions before finish_work.",
          ].join("\n\n"),
          inputs: [{ id: "experiment-plan", artifact: hypothesis.artifact }],
          outputSchema: experimentMetadataSchema,
          workspace,
          network: "research",
        });
      }, {
        base: best ?? flow.snapshot,
        metadataSchema: experimentMetadataSchema,
        writes: { allow: args.writePaths },
      });
      const attempt = produced.candidate;
      const measured = await flow.measure("benchmark", {
        metrics: { throughput: performance, "peak-rss": peakMemory },
        measurement: "builtin:runtime-baseline",
        workspace: attempt,
      });
      const throughput = measured.observations.throughput;
      const memory = measured.observations["peak-rss"];
      let learned;
      if (bestThroughput !== null && throughput.value <= bestThroughput) {
        await flow.reject("reject", { candidate: attempt, measurement: measured, reason: "did not improve the accepted best" });
        learned = `rejected: throughput ${throughput.value} did not improve accepted best ${bestThroughput}`;
      } else if (!performance.isImprovement(throughput)) {
        await flow.reject("reject", { candidate: attempt, measurement: measured, reason: "below minimum improvement" });
        learned = `rejected: throughput ${throughput.value} did not clear the minimum improvement`;
      } else if (!peakMemory.isWithinGuardrail(memory)) {
        await flow.reject("reject", { candidate: attempt, measurement: measured, reason: "peak-memory guardrail exceeded" });
        learned = `rejected: peak RSS ${memory.value} MiB exceeded the baseline guardrail`;
      } else {
        const verification = await flow.verify("verification", { candidate: attempt, profile: "builtin:coding" });
        if (!verification.passed) {
          await flow.reject("reject", {
            candidate: attempt,
            measurement: measured,
            verification,
            reason: `verification ${verification.status}`,
          });
          learned = `rejected: verification ${verification.status}`;
        } else {
          best = await flow.accept("accept", { candidate: attempt, measurement: measured, verification });
          bestVerification = verification;
          bestThroughput = throughput.value;
          bestPeakMemory = memory.value;
          const baseline = performance.summary().baseline;
          targetReached = baseline !== null && baseline !== 0 &&
            (throughput.value - baseline) / Math.abs(baseline) >= (args.targetRelativeGain ?? 0.20);
          learned = `accepted: throughput ${throughput.value} with peak RSS ${memory.value} MiB`;
        }
      }
      history.push(await flow.recordExperiment("record", { candidate: produced, measurement: measured, learned }));
      const reflection = await flow.agent("reflection", {
        profile: "builtin:synthesizer",
        prompt: [
          "Produce a compact handoff for the next optimization attempt.",
          `Observed outcome: ${learned}`,
          `Throughput: ${throughput.value}; peak RSS: ${memory.value}.`,
          "Preserve the lesson and name one distinct next focus. Report progress, log the lesson, and publish the complete handoff as an artifact before finish_work.",
        ].join("\n\n"),
        inputs: [{ id: "experiment-plan", artifact: hypothesis.artifact }],
        outputSchema: reflectionSchema,
        resultMode: "value-and-artifact",
      });
      priorExperiment = reflection.artifact;
    });

    const result = () => {
      const throughput = performance.summary();
      const memory = peakMemory.summary();
      return {
        metrics: {
          throughput: bestThroughput === null ? throughput : {
            ...throughput,
            current: bestThroughput,
            best: bestThroughput,
            relativeGain: throughput.baseline === 0 ? null :
              (bestThroughput - throughput.baseline) / Math.abs(throughput.baseline),
          },
          peakRss: bestPeakMemory === null ? memory : {
            ...memory,
            current: bestPeakMemory,
            best: bestPeakMemory,
            relativeGain: memory.baseline === 0 ? null :
              (memory.baseline - bestPeakMemory) / Math.abs(memory.baseline),
          },
        },
        experiments: history.length,
      };
    };
    if (best === null) return { changed: false, ...result() };
    if (bestVerification === null) throw new Error("accepted candidate has no verification receipt");
    await flow.apply("apply", { candidate: best, verification: bestVerification });
    return { changed: true, ...result() };
  },
});

