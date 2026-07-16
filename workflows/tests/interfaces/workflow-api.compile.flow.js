export default defineWorkflow({
  name: "phase-one-interface",
  description: "Compile the final authoring surface without executing it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["objective"],
    properties: { objective: { type: "string" } },
  },
  outputSchema: { type: "object" },
  capabilities: ["read-project", "candidate-write", "host-command", "mediated-network", "human-input"],
  modelVisible: false,
  maxParallelism: 2,

  async run(flow, args) {
    const prior = await flow.agent("inspect", {
      profile: "builtin:researcher",
      prompt: `Inspect ${args.objective}`,
      network: "research",
      resultMode: "artifact",
    });

    const produced = await flow.candidate(
      "candidate",
      async (workspace) => {
        const result = await flow.agent("edit", {
          profile: "builtin:coder",
          prompt: "Implement the requested change.",
          inputs: [{ id: "prior", artifact: prior }],
          outputSchema: { type: "object" },
          workspace,
          network: "research",
          resultMode: "value-and-artifact",
        });
        await flow.command("check", {
          profile: "builtin:project-check",
          args: { suite: "focused" },
          effect: "candidate",
          workspace,
          output: "summary",
        });
        return result.value;
      },
      { writes: { allow: ["src/", "tests/"] } },
    );

    const verification = await flow.verify("verify", {
      candidate: produced.candidate,
      profile: "builtin:general",
    });
    if (!verification.passed) {
      await flow.reject("reject", {
        candidate: produced.candidate,
        verification,
        reason: "Verification did not pass.",
      });
      return { status: "rejected" };
    }

    const accepted = await flow.accept("accept", {
      candidate: produced.candidate,
      verification,
    });
    // @ts-expect-error apply approval is always an exact human checkpoint
    await flow.apply("unattended-apply", { candidate: accepted, verification, confirmation: "unattended" });
    const receipt = await flow.apply("apply", { candidate: accepted, verification });
    return { status: "completed", changedPaths: receipt.changedPaths };
  },
});

defineWorkflow({
  name: "phase-one-interface-rejections",
  description: "Host authority must not type-check.",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  capabilities: [],
  modelVisible: false,
  // @ts-expect-error workflow definitions do not own host execution policy
  executionPolicy: { concurrency: 99 },
  async run(flow) {
    // @ts-expect-error the public language has no generic host-effect escape hatch
    await flow.effect("legacy-effect", {});
    // @ts-expect-error workflows cannot launch another orchestration
    await flow.subflow("other", {});
    // @ts-expect-error model selection belongs to the profile route registry
    await flow.agent("model", { profile: "builtin:coder", prompt: "x", model: "provider/model" });
    // @ts-expect-error thinking selection belongs to the profile route registry
    await flow.agent("thinking", { profile: "builtin:coder", prompt: "x", thinking: "high" });
    // @ts-expect-error commands use reviewed profiles, never source-provided argv
    await flow.command("raw-command", { profile: "builtin:check", argv: ["sh", "-c", "true"] });
    return {};
  },
});
