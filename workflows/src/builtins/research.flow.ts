// Strict compile fixture for the workflow runtime contract.
import { agent, schema as s, workflow } from "pi/workflows";

const Angle = s.object({
  id: s.id(),
  title: s.string({ minLength: 1, maxLength: 200 }),
});

const Evidence = s.object({
  claim: s.string({ maxLength: 1_000 }),
  source: s.string({ maxLength: 2_000 }),
});

const Finding = s.object({
  summary: s.string({ minLength: 1, maxLength: 8_000 }),
  evidence: s.array(Evidence, { maxItems: 32 }),
});

const Claim = s.object({
  claim: s.string({ maxLength: 1_000 }),
  sources: s.array(s.string({ maxLength: 2_000 }), { maxItems: 8 }),
});

const Report = s.object({
  answer: s.string({ minLength: 1, maxLength: 20_000 }),
  claims: s.array(Claim, { maxItems: 64 }),
  openQuestions: s.array(s.string({ maxLength: 1_000 }), { maxItems: 32 }),
});

const Critique = s.object({
  passed: s.boolean(),
  problems: s.array(s.string({ maxLength: 1_000 }), { maxItems: 32 }),
});

const researchAngle = agent({
  profile: "builtin:researcher",
  network: "research",
  output: Finding,
});

const writeReport = agent({
  profile: "builtin:synthesizer",
  output: Report,
});

const critiqueReport = agent({
  profile: "builtin:reviewer",
  network: "research",
  output: Critique,
});

const defaultAngles = [
  { id: "architecture", title: "Architecture and mechanism" },
  { id: "evidence", title: "Primary evidence" },
  { id: "risks", title: "Risks and counterarguments" },
];

export default workflow({
  description: "Research independent angles, synthesize, and challenge the result.",
  input: s.object({
    question: s.string({ minLength: 1, maxLength: 20_000 }),
    angles: s.optional(s.array(Angle, { minItems: 1, maxItems: 8 })),
  }),
  output: Report,
  concurrency: 4,

  async run(flow, { question, angles = defaultAngles }) {
    const results = await flow.map(angles, async angle => ({
      angle,
      finding: await flow.agent(researchAngle, {
        prompt: [
          `Question: ${question}`,
          `Research angle: ${angle.title}`,
          "Return claims with concrete source URLs or project paths.",
        ].join("\n\n"),
      }),
    }), {
      key: angle => angle.id,
      concurrency: 4,
      errors: "collect",
    });

    const findings = results.flatMap(result => result.ok ? [result.value] : []);
    const unavailable = results.flatMap(result => result.ok ? [] : [result.error.summary]);
    if (findings.length === 0) throw new Error("all research angles failed");

    const draft = await flow.agent(writeReport, {
      title: "Synthesize report",
      prompt: [
        `Answer: ${question}`,
        `Finding index: ${JSON.stringify(findings.map(({ angle, finding }) => ({
          angle: angle.id,
          summary: finding.output.summary,
        })))}`,
        `Unavailable angles: ${JSON.stringify(unavailable)}`,
      ].join("\n\n"),
      artifacts: { findings: findings.map(result => result.finding) },
    });

    const review = await flow.agent(critiqueReport, {
      prompt: [
        "Adversarially check the draft against the supplied findings.",
        `Unavailable angles: ${JSON.stringify(unavailable)}`,
      ].join("\n\n"),
      artifacts: {
        findings: findings.map(result => result.finding),
        draft,
      },
    });

    if (review.output.passed) return draft.output;

    return (await flow.agent(writeReport, {
      title: "Revise report",
      prompt: "Revise the draft. Fix every supported critique without inventing evidence.",
      artifacts: {
        findings: findings.map(result => result.finding),
        draft,
        critique: review,
      },
    })).output;
  },
});
