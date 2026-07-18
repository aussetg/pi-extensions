// Strict compile fixture for the workflow runtime contract.
import { agent, command, schema as s, workflow } from "pi/workflows";

const Package = s.object({
  id: s.id(),
  path: s.safePath(),
});

const Inventory = s.object({
  packageId: s.id(),
  summary: s.string({ minLength: 1, maxLength: 6_000 }),
  files: s.array(s.safePath(), { maxItems: 512 }),
  observations: s.array(s.string({ minLength: 1, maxLength: 1_000 }), { maxItems: 32 }),
});

const Risks = s.object({
  packageId: s.id(),
  summary: s.string({ minLength: 1, maxLength: 6_000 }),
  risks: s.array(s.string({ minLength: 1, maxLength: 1_000 }), { maxItems: 32 }),
});

const TestPlan = s.object({
  packageId: s.id(),
  summary: s.string({ minLength: 1, maxLength: 6_000 }),
  tests: s.array(s.string({ minLength: 1, maxLength: 1_000 }), { maxItems: 64 }),
});

const Portfolio = s.object({
  summary: s.string({ minLength: 1, maxLength: 20_000 }),
  priorities: s.array(s.string({ maxLength: 1_000 }), { maxItems: 64 }),
});

const trackedFiles = command({
  profile: "builtin:tracked-files",
  output: "text",
});

const inventoryPackage = agent({
  profile: "builtin:reviewer",
  output: Inventory,
});

const analyzeRisks = agent({
  profile: "builtin:reviewer",
  output: Risks,
});

const proposeTests = agent({
  profile: "builtin:reviewer",
  output: TestPlan,
});

const synthesizePortfolio = agent({
  profile: "builtin:synthesizer",
  output: Portfolio,
});

export default workflow({
  description: "Inventory, analyze, and propose tests for each package concurrently.",
  input: s.object({
    packages: s.array(Package, { minItems: 1, maxItems: 12 }),
  }),
  output: Portfolio,
  concurrency: 4,

  async run(flow, { packages }) {
    async function auditPackage(pkg: (typeof packages)[number]) {
      const files = await flow.command(trackedFiles, { args: { path: pkg.path } });

      const inventory = await flow.agent(inventoryPackage, {
        prompt: `Inspect package ${pkg.id} at ${pkg.path} using the exact tracked-file inventory.`,
        artifacts: { trackedFiles: files },
      });

      const risks = await flow.agent(analyzeRisks, {
        prompt: `Analyze failure modes for package ${pkg.id} from the exact inventory.`,
        artifacts: { inventory },
      });

      const tests = await flow.agent(proposeTests, {
        prompt: `Propose high-value tests for package ${pkg.id} from the inventory and risks.`,
        artifacts: { inventory, risks },
      });

      return { packageId: pkg.id, inventory, risks, tests };
    }

    const analyses = await flow.map(packages, auditPackage, {
      key: pkg => pkg.id,
      concurrency: 4,
    });

    return (await flow.agent(synthesizePortfolio, {
      prompt: [
        "Synthesize a cross-package audit and ranked priorities.",
        `Package order: ${analyses.map(result => result.packageId).join(", ")}`,
      ].join("\n\n"),
      artifacts: {
        inventories: analyses.map(result => result.inventory),
        risks: analyses.map(result => result.risks),
        tests: analyses.map(result => result.tests),
      },
    })).output;
  },
});
