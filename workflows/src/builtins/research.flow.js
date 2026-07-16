const angleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "title"],
  properties: {
    id: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
    title: { type: "string", minLength: 1, maxLength: 200 },
  },
};

const findingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "evidence"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 8000 },
    evidence: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "source"],
        properties: {
          claim: { type: "string", maxLength: 1000 },
          source: { type: "string", maxLength: 2000 },
        },
      },
    },
  },
};

const reportSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "claims", "openQuestions"],
  properties: {
    answer: { type: "string", minLength: 1, maxLength: 20000 },
    claims: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "sources"],
        properties: {
          claim: { type: "string", maxLength: 1000 },
          sources: { type: "array", maxItems: 8, items: { type: "string", maxLength: 2000 } },
        },
      },
    },
    openQuestions: { type: "array", maxItems: 32, items: { type: "string", maxLength: 1000 } },
  },
};

const critiqueSchema = {
  type: "object",
  additionalProperties: false,
  required: ["passed", "problems"],
  properties: {
    passed: { type: "boolean" },
    problems: { type: "array", maxItems: 32, items: { type: "string", maxLength: 1000 } },
  },
};

const defaultAngles = [
  { id: "architecture", title: "Architecture and mechanism" },
  { id: "evidence", title: "Primary evidence" },
  { id: "risks", title: "Risks and counterarguments" },
];

export default defineWorkflow({
  name: "research",
  title: "Broad research",
  description: "Research independent angles, synthesize, and challenge the result.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["question"],
    properties: {
      question: { type: "string", minLength: 1, maxLength: 20000 },
      angles: { type: "array", minItems: 1, maxItems: 8, items: angleSchema },
    },
  },
  outputSchema: reportSchema,
  capabilities: ["read-project", "mediated-network"],
  modelVisible: true,
  maxParallelism: 4,

  async run(flow, args) {
    const angles = args.angles ?? defaultAngles;
    const angleResults = await flow.fanOut("angles", angles, {
      key: angle => angle.id,
      concurrency: 4,
      failure: "collect",
    }, async angle => {
      /** @type {FlowAgentProduct<{summary: string, evidence: FlowJsonValue[]}>} */
      const finding = await flow.agent("research", {
        profile: "builtin:researcher",
        prompt: [
          `Research this angle for the question: ${args.question}`,
          `Angle: ${angle.title}`,
          "Return claims with concrete source URLs or project paths.",
          "Report progress while gathering sources, log the strongest finding, and publish the complete source-grounded finding as an artifact before finish_work.",
        ].join("\n"),
        outputSchema: findingSchema,
        network: "research",
        resultMode: "value-and-artifact",
      });
      return { angleId: angle.id, finding: finding.value, artifact: finding.artifact };
    });

    const successes = angleResults.flatMap(result => result.ok ? [result.value] : []);
    const findingInputs = successes.map((result, index) => ({ id: `finding-${index}`, artifact: result.artifact }));
    const findingIndex = successes.map((result, index) => ({
      inputId: `finding-${index}`,
      angleId: result.angleId,
      summary: result.finding.summary,
    }));
    const failures = angleResults.flatMap(result => result.ok === false ? [result.failure] : []);
    if (successes.length === 0) throw new Error("all research angles failed");

    return flow.stage("synthesis", async () => {
      const draft = await flow.agent("draft", {
        profile: "builtin:synthesizer",
        prompt: [
          `Answer ${args.question}`,
          "The attached finding artifacts contain the complete successful angle reports.",
          `Finding index: ${JSON.stringify(findingIndex)}`,
          `Unavailable angles: ${JSON.stringify(failures)}`,
          "Report synthesis progress, log the central conclusion, and publish the complete draft as an artifact before finish_work.",
        ].join("\n\n"),
        inputs: findingInputs,
        outputSchema: reportSchema,
        resultMode: "value-and-artifact",
      });
      /** @type {FlowAgentProduct<{passed: boolean, problems: string[]}>} */
      const critique = await flow.agent("critique", {
        profile: "builtin:reviewer",
        prompt: [
          "Adversarially check this draft against the supplied findings.",
          `Unavailable angles: ${JSON.stringify(failures)}`,
          "Report review progress, log the most consequential problem, and publish the complete critique as an artifact before finish_work.",
        ].join("\n\n"),
        inputs: [...findingInputs, { id: "draft", artifact: draft.artifact }],
        outputSchema: critiqueSchema,
        network: "research",
        resultMode: "value-and-artifact",
      });
      if (critique.value.passed) return draft.value;
      return flow.agent("revision", {
        profile: "builtin:synthesizer",
        prompt: [
          "Revise the draft. Fix every supported critique without inventing evidence.",
          "Report revision progress and log the principal correction before finish_work.",
        ].join("\n\n"),
        inputs: [
          ...findingInputs,
          { id: "draft", artifact: draft.artifact },
          { id: "critique", artifact: critique.artifact },
        ],
        outputSchema: reportSchema,
      });
    });
  },
});

