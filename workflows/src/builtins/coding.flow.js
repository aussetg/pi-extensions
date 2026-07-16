const inspectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 4000 },
    findings: {
      type: "array",
      maxItems: 32,
      items: { type: "string", minLength: 1, maxLength: 1000 },
    },
  },
};

const implementationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "changedPaths", "checks"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 4000 },
    changedPaths: {
      type: "array",
      maxItems: 256,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
    checks: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 1000 },
    },
  },
};

const codingResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "changedPaths"],
  properties: {
    status: { type: "string", enum: ["applied", "rejected"] },
    changedPaths: {
      type: "array",
      maxItems: 256,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
    reason: { type: "string", minLength: 1, maxLength: 2000 },
  },
};

export default defineWorkflow({
  name: "coding",
  title: "Verified coding",
  description: "Produce, verify, approve, and apply one immutable candidate.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["objective"],
    properties: { objective: { type: "string", minLength: 1, maxLength: 20000 } },
  },
  outputSchema: codingResultSchema,
  capabilities: ["read-project", "candidate-write", "host-command", "mediated-network", "human-input"],
  modelVisible: true,
  maxParallelism: 3,

  async run(flow, args) {
    const inspection = await flow.parallel("inspection", {
      architecture: () => flow.agent("architecture", {
        profile: "builtin:reviewer",
        prompt: [
          `Inspect architecture relevant to this objective. Do not edit.\n${args.objective}`,
          "Report progress while traversing the project, log the most important constraint, and publish the complete inspection as an artifact before finish_work.",
        ].join("\n\n"),
        outputSchema: inspectionSchema,
        resultMode: "value-and-artifact",
      }),
      tests: () => flow.agent("tests", {
        profile: "builtin:reviewer",
        prompt: [
          `Inspect tests and verification commands relevant to this objective. Do not edit.\n${args.objective}`,
          "Report progress, log the highest-value check, and publish the complete inspection as an artifact before finish_work.",
        ].join("\n\n"),
        outputSchema: inspectionSchema,
        resultMode: "value-and-artifact",
      }),
      risks: () => flow.agent("risks", {
        profile: "builtin:reviewer",
        prompt: [
          `Find likely regressions and edge cases for this objective. Do not edit.\n${args.objective}`,
          "Report progress, log the most serious risk, and publish the complete risk review as an artifact before finish_work.",
        ].join("\n\n"),
        outputSchema: inspectionSchema,
        resultMode: "value-and-artifact",
      }),
    }, { concurrency: 3 });

    const produced = await flow.candidate("implementation", async workspace => {
      return flow.agent("implement", {
        profile: "builtin:implementer",
        prompt: [
          args.objective,
          "Implement the complete change in the candidate workspace.",
          "The architecture, test, and risk inspections are supplied as exact artifacts. Read them instead of repeating discovery.",
          "Use mediated research only when external primary documentation is needed. Report progress and log consequential decisions before finish_work.",
        ].join("\n\n"),
        inputs: [
          { id: "architecture", artifact: inspection.architecture.artifact },
          { id: "tests", artifact: inspection.tests.artifact },
          { id: "risks", artifact: inspection.risks.artifact },
        ],
        outputSchema: implementationSchema,
        workspace,
        network: "research",
      });
    }, { metadataSchema: implementationSchema });
    const verification = await flow.verify("verification", { candidate: produced.candidate, profile: "builtin:coding" });
    if (!verification.passed) {
      const rejected = await flow.reject("reject", {
        candidate: produced.candidate,
        verification,
        reason: `verification ${verification.status}`,
      });
      return { status: "rejected", changedPaths: rejected.changedPaths, reason: rejected.reason };
    }
    const accepted = await flow.accept("accept", { candidate: produced.candidate, verification });
    const applied = await flow.apply("apply", { candidate: accepted, verification });
    return { status: "applied", changedPaths: applied.changedPaths };
  },
});

