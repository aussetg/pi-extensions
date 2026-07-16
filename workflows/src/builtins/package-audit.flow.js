const packageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "path"],
  properties: {
    id: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
    path: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      pattern: "^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))[^\\u0000-\\u001f]+$",
    },
  },
};

const portfolioSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "priorities"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 20000 },
    priorities: { type: "array", maxItems: 64, items: { type: "string", maxLength: 1000 } },
  },
};

const inventorySchema = {
  type: "object",
  additionalProperties: false,
  required: ["packageId", "summary", "files", "observations"],
  properties: {
    packageId: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
    summary: { type: "string", minLength: 1, maxLength: 6000 },
    files: {
      type: "array",
      maxItems: 512,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
    observations: {
      type: "array",
      maxItems: 32,
      items: { type: "string", minLength: 1, maxLength: 1000 },
    },
  },
};

const riskSchema = {
  type: "object",
  additionalProperties: false,
  required: ["packageId", "summary", "risks"],
  properties: {
    packageId: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
    summary: { type: "string", minLength: 1, maxLength: 6000 },
    risks: {
      type: "array",
      maxItems: 32,
      items: { type: "string", minLength: 1, maxLength: 1000 },
    },
  },
};

const testPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["packageId", "summary", "tests"],
  properties: {
    packageId: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
    summary: { type: "string", minLength: 1, maxLength: 6000 },
    tests: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 1000 },
    },
  },
};

export default defineWorkflow({
  name: "package-audit",
  title: "Package audit",
  description: "Inventory, analyze, and propose tests for each package concurrently.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["packages"],
    properties: { packages: { type: "array", minItems: 1, maxItems: 12, items: packageSchema } },
  },
  outputSchema: portfolioSchema,
  capabilities: ["read-project", "host-command"],
  modelVisible: true,
  maxParallelism: 4,

  async run(flow, args) {
    const analyses = await flow.fanOut("packages", args.packages, {
      key: pkg => pkg.id,
      concurrency: 4,
    }, async pkg => {
      const files = await flow.command("files", {
        profile: "builtin:tracked-files",
        args: { path: pkg.path },
        output: "stdout",
      });
      if (!files.outputArtifact) throw new Error(`tracked-file inventory for ${pkg.id} was not passable text`);
      const inventory = await flow.agent("inventory", {
        profile: "builtin:reviewer",
        prompt: [
          `Inspect package ${pkg.id} at ${pkg.path}. The tracked-file inventory is supplied as an artifact.`,
          "Report progress, log the most important structural observation, and publish the complete inventory analysis as an artifact before finish_work.",
        ].join("\n\n"),
        inputs: [{ id: "tracked-files", artifact: files.outputArtifact }],
        outputSchema: inventorySchema,
        resultMode: "value-and-artifact",
      });
      const risks = await flow.agent("risks", {
        profile: "builtin:reviewer",
        prompt: [
          `Analyze failure modes for package ${pkg.id} from the exact inventory artifact.`,
          "Report progress, log the highest-impact failure mode, and publish the complete risk analysis as an artifact before finish_work.",
        ].join("\n\n"),
        inputs: [{ id: "inventory", artifact: inventory.artifact }],
        outputSchema: riskSchema,
        resultMode: "value-and-artifact",
      });
      const testPlan = await flow.agent("test-plan", {
        profile: "builtin:reviewer",
        prompt: [
          `Propose high-value tests for package ${pkg.id} from the exact inventory and risk artifacts.`,
          "Report progress, log the highest-value test, and publish the complete test plan as an artifact before finish_work.",
        ].join("\n\n"),
        inputs: [
          { id: "inventory", artifact: inventory.artifact },
          { id: "risks", artifact: risks.artifact },
        ],
        outputSchema: testPlanSchema,
        resultMode: "value-and-artifact",
      });
      return {
        packageId: pkg.id,
        inventory: inventory.artifact,
        risks: risks.artifact,
        testPlan: testPlan.artifact,
      };
    });
    return flow.agent("portfolio", {
      profile: "builtin:synthesizer",
      prompt: [
        `Synthesize a cross-package audit and ranked priorities. Artifact prefixes map to packages as follows: ${analyses.map((analysis, index) => `package-${index}=${analysis.packageId}`).join(", ")}. Every package's inventory, risks, and test plan are supplied as exact artifacts.`,
        "Report synthesis progress and log the highest portfolio priority before finish_work.",
      ].join("\n\n"),
      inputs: analyses.flatMap((analysis, index) => [
        { id: `package-${index}-inventory`, artifact: analysis.inventory },
        { id: `package-${index}-risks`, artifact: analysis.risks },
        { id: `package-${index}-tests`, artifact: analysis.testPlan },
      ]),
      outputSchema: portfolioSchema,
    });
  },
});

