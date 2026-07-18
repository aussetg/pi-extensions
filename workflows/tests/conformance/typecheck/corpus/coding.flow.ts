// Strict compile fixture for the workflow runtime contract.
import { agent, schema as s, workflow, type Infer } from "pi/workflows";

const Inspection = s.object({
  summary: s.string({ minLength: 1, maxLength: 4_000 }),
  findings: s.array(s.string({ minLength: 1, maxLength: 1_000 }), { maxItems: 32 }),
});

const Implementation = s.object({
  summary: s.string({ minLength: 1, maxLength: 4_000 }),
  changedPaths: s.array(s.safePath(), { maxItems: 256, uniqueItems: true }),
  checks: s.array(s.string({ minLength: 1, maxLength: 1_000 }), { maxItems: 64 }),
});

const Result = s.object({
  status: s.enum(["applied", "rejected"]),
  changedPaths: s.array(s.safePath(), { maxItems: 256 }),
  reason: s.optional(s.string({ minLength: 1, maxLength: 2_000 })),
});

const inspect = agent({
  profile: "builtin:reviewer",
  output: Inspection,
});

const implement = agent({
  profile: "builtin:implementer",
  workspace: "candidate",
  network: "research",
  output: Implementation,
});

export default workflow({
  description: "Produce, verify, approve, and apply one immutable candidate.",
  input: s.object({
    objective: s.string({ minLength: 1, maxLength: 20_000 }),
  }),
  output: Result,
  concurrency: 3,

  async run(flow, { objective }): Promise<Infer<typeof Result>> {
    const inspection = await flow.parallel({
      architecture: () => flow.agent(inspect, {
        prompt: `Inspect architecture relevant to this objective. Do not edit.\n\n${objective}`,
      }),
      tests: () => flow.agent(inspect, {
        prompt: `Inspect tests and verification commands relevant to this objective. Do not edit.\n\n${objective}`,
      }),
      risks: () => flow.agent(inspect, {
        prompt: `Find likely regressions and edge cases for this objective. Do not edit.\n\n${objective}`,
      }),
    }, { concurrency: 3 });

    const candidate = await flow.candidate(async workspace => {
      return (await flow.agent(implement, {
        workspace,
        prompt: [
          objective,
          "Implement the complete change in the candidate workspace.",
          "Use the supplied inspections instead of repeating discovery.",
        ].join("\n\n"),
        artifacts: { inspection },
      })).output;
    });

    const verification = await flow.verify(candidate, "builtin:coding");
    if (!verification.passed) {
      const rejection = await flow.reject(candidate, {
        verification,
        reason: `verification ${verification.status}`,
      });
      return {
        status: "rejected",
        changedPaths: rejection.changedPaths,
        reason: rejection.reason,
      };
    }

    const accepted = await flow.accept(candidate, { verification });
    const applied = await flow.apply(accepted);
    return { status: "applied", changedPaths: applied.changedPaths };
  },
});
