// Strict compile fixture for the workflow runtime contract.
import {
  agent,
  schema as s,
  workflow,
  type AcceptedCandidate,
  type AgentResult,
  type Artifact,
  type Candidate,
  type ExperimentSummary,
  type Infer,
} from "pi/workflows";

const MetricTarget = s.object({
  kind: s.enum(["value", "relativeGain", "absoluteGain"]),
  value: s.number(),
});

const MetricImprovement = s.object({
  minimumAbsolute: s.optional(s.number({ minimum: 0 })),
  minimumRelative: s.optional(s.number({ minimum: 0 })),
});

const PrimaryMetric = s.object({
  output: s.id(),
  title: s.optional(s.string({ minLength: 1, maxLength: 192 })),
  direction: s.enum(["minimize", "maximize"]),
  unit: s.optional(s.string({ minLength: 1, maxLength: 192 })),
  format: s.optional(s.enum(["number", "percent", "duration", "bytes"])),
  aggregate: s.optional(s.enum(["median", "mean", "min", "max"])),
  target: s.optional(MetricTarget),
  improvement: s.optional(MetricImprovement),
});

const GuardrailMetric = s.object({
  output: s.id(),
  title: s.optional(s.string({ minLength: 1, maxLength: 192 })),
  direction: s.enum(["minimize", "maximize"]),
  unit: s.optional(s.string({ minLength: 1, maxLength: 192 })),
  format: s.optional(s.enum(["number", "percent", "duration", "bytes"])),
  aggregate: s.optional(s.enum(["median", "mean", "min", "max"])),
  reference: s.enum(["baseline", "best"]),
  maximumAbsoluteRegression: s.optional(s.number({ minimum: 0 })),
  maximumRelativeRegression: s.optional(s.number({ minimum: 0 })),
});

const ObservedMetric = s.object({
  output: s.id(),
  title: s.optional(s.string({ minLength: 1, maxLength: 192 })),
  direction: s.enum(["minimize", "maximize"]),
  unit: s.optional(s.string({ minLength: 1, maxLength: 192 })),
  format: s.optional(s.enum(["number", "percent", "duration", "bytes"])),
  aggregate: s.optional(s.enum(["median", "mean", "min", "max"])),
});

const MetricSummary = s.object({
  baseline: s.number(),
  current: s.number(),
  best: s.number(),
  relativeGain: s.nullable(s.number()),
  observationCount: s.integer({ minimum: 1 }),
});

const Experiment = s.object({
  hypothesis: s.string({ minLength: 1, maxLength: 1_000 }),
  changeSummary: s.string({ minLength: 1, maxLength: 2_000 }),
  expectedEffect: s.string({ minLength: 1, maxLength: 1_000 }),
  nextFocus: s.string({ minLength: 1, maxLength: 1_000 }),
});
type Experiment = Infer<typeof Experiment>;

const Reflection = s.object({
  learned: s.string({ minLength: 1, maxLength: 2_000 }),
  nextFocus: s.string({ minLength: 1, maxLength: 1_000 }),
});

const Result = s.object({
  changed: s.boolean(),
  evaluator: s.string(),
  metrics: s.record(MetricSummary),
  experiments: s.integer({ minimum: 0, maximum: 32 }),
});

const proposeExperiment = agent({
  profile: "builtin:researcher",
  network: "research",
  output: Experiment,
});

const implementExperiment = agent({
  profile: "builtin:implementer",
  workspace: "candidate",
  network: "research",
  output: Experiment,
});

const reflect = agent({
  profile: "builtin:synthesizer",
  output: Reflection,
});

export default workflow({
  description: "Optimize caller-selected trusted measurements under explicit targets and guardrails.",
  input: s.object({
    objective: s.string({ minLength: 1, maxLength: 20_000 }),
    writePaths: s.array(s.safePath(), { minItems: 1, maxItems: 32, uniqueItems: true }),
    evaluator: s.measurementProfile(),
    metrics: s.object({
      primary: PrimaryMetric,
      guardrails: s.optional(s.array(GuardrailMetric, { maxItems: 8 })),
      observe: s.optional(s.array(ObservedMetric, { maxItems: 8 })),
    }),
    sampling: s.optional(s.object({
      warmups: s.integer({ minimum: 0, maximum: 16 }),
      samples: s.integer({ minimum: 1, maximum: 64 }),
    })),
    maxIterations: s.optional(s.integer({ minimum: 1, maximum: 32 })),
  }),
  output: Result,

  async run(flow, args) {
    const metrics = flow.metrics(args.metrics, args.sampling);
    await flow.measure(args.evaluator, metrics);

    let best: AcceptedCandidate<Experiment> | null = null;
    let priorExperiment: Artifact | null = null;
    const history: ExperimentSummary[] = [];

    for (let iteration = 0; iteration < (args.maxIterations ?? 8); iteration++) {
      if (metrics.primary.reachedTarget()) break;

      const hypothesis: AgentResult<Experiment, "snapshot"> = await flow.agent(proposeExperiment, {
        prompt: [
          args.objective,
          `Design one coherent optimization hypothesis for attempt ${iteration + 1}.`,
          `Optimization policy: ${JSON.stringify(metrics.policy())}`,
          `Accepted metric state: ${JSON.stringify(metrics.summary())}`,
          "Do not repeat an equivalent prior attempt.",
        ].join("\n\n"),
        ...(priorExperiment ? { artifacts: { priorExperiment } } : {}),
      });

      const candidate: Candidate<Experiment> = await flow.candidate(async workspace => {
        return (await flow.agent(implementExperiment, {
          workspace,
          prompt: [
            args.objective,
            `This is attempt ${iteration + 1}.`,
            "Implement the supplied experiment plan as one coherent candidate change.",
          ].join("\n\n"),
          artifacts: { experimentPlan: hypothesis },
        })).output;
      }, {
        base: best ?? flow.snapshot,
        writes: args.writePaths,
      });

      const measurement = await flow.measure(args.evaluator, metrics, { candidate });
      const policy = metrics.evaluate(measurement);

      let learned: string;
      if (!policy.acceptable) {
        await flow.reject(candidate, { measurement, reason: policy.summary });
        learned = `rejected: ${policy.summary}`;
      } else {
        const verification = await flow.verify(candidate, "builtin:coding");
        if (!verification.passed) {
          await flow.reject(candidate, {
            measurement,
            verification,
            reason: `verification ${verification.status}`,
          });
          learned = `rejected: verification ${verification.status}`;
        } else {
          best = await flow.accept(candidate, { measurement, verification });
          learned = `accepted: ${policy.summary}`;
        }
      }

      history.push(await flow.recordExperiment({ candidate, measurement, learned }));
      const reflection = await flow.agent(reflect, {
        prompt: [
          "Produce a compact handoff for the next optimization attempt.",
          learned,
          "Preserve the lesson and name one distinct next focus.",
        ].join("\n\n"),
        artifacts: { hypothesis, measurement },
      });
      priorExperiment = reflection.artifact;
    }

    if (best) await flow.apply(best);
    return {
      changed: best !== null,
      evaluator: args.evaluator,
      metrics: metrics.summary(),
      experiments: history.length,
    };
  },
});
