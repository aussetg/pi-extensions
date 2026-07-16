export default defineWorkflow({
  name: "checkpoint-fixture",
  title: "Checkpoint fixture",
  description: "Focused test fixture for every durable checkpoint response kind.",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["confirmed", "choice", "input"],
    properties: {
      confirmed: { type: "boolean" },
      choice: { type: "string", enum: ["alpha", "beta"] },
      input: {
        type: "object",
        additionalProperties: false,
        required: ["note"],
        properties: { note: { type: "string", minLength: 1, maxLength: 256 } },
      },
    },
  },
  capabilities: ["human-input"],
  modelVisible: false,
  maxParallelism: 1,

  async run(flow, _args) {
    const confirmed = await flow.checkpoint("confirm", {
      kind: "confirm",
      prompt: "Continue through the checkpoint fixture?",
    });
    const choice = await flow.checkpoint("choice", {
      kind: "choice",
      prompt: "Choose a stable fixture value.",
      choices: [{ id: "alpha", label: "Alpha" }, { id: "beta", label: "Beta" }],
    });
    const input = await flow.checkpoint("input", {
      kind: "input",
      prompt: "Enter the fixture payload.",
      responseSchema: {
        type: "object",
        additionalProperties: false,
        required: ["note"],
        properties: { note: { type: "string", minLength: 1, maxLength: 256 } },
      },
    });
    return { confirmed, choice, input };
  },
});
