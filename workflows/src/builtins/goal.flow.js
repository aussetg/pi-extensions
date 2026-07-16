const goalOutputDescriptorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "summary"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_-]{0,63}$" },
    kind: { type: "string", enum: ["finding", "decision", "change", "check", "other"] },
    summary: { type: "string", minLength: 1, maxLength: 2000 },
  },
};

const goalWorkerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "summary", "outputs", "nextWork", "workspace", "blocker"],
  properties: {
    outcome: { type: "string", enum: ["completed", "handoff", "blocked"] },
    summary: { type: "string", minLength: 1, maxLength: 8000 },
    outputs: { type: "array", maxItems: 16, items: goalOutputDescriptorSchema },
    nextWork: {
      type: "array",
      maxItems: 16,
      items: { type: "string", minLength: 1, maxLength: 2000 },
    },
    workspace: { type: "string", enum: ["read-only", "candidate"] },
    blocker: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 4000 },
        { type: "null" },
      ],
    },
  },
};

const blockedResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "guidance"],
  properties: {
    action: { type: "string", enum: ["continue", "stop"] },
    guidance: { type: "string", maxLength: 8000 },
  },
};

const goalResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "outputs", "nextWork", "changedPaths", "applied"],
  properties: {
    status: { type: "string", enum: ["completed", "blocked"] },
    summary: { type: "string", minLength: 1, maxLength: 12000 },
    outputs: { type: "array", maxItems: 64, items: goalOutputDescriptorSchema },
    nextWork: {
      type: "array",
      maxItems: 16,
      items: { type: "string", minLength: 1, maxLength: 2000 },
    },
    changedPaths: {
      type: "array",
      maxItems: 4096,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 1000 },
    },
    applied: { type: "boolean" },
  },
};

/**
 * @typedef {object} GoalWorkerResult
 * @property {"completed" | "handoff" | "blocked"} outcome
 * @property {string} summary
 * @property {Array<{id: string, kind: "finding" | "decision" | "change" | "check" | "other", summary: string}>} outputs
 * @property {string[]} nextWork
 * @property {"read-only" | "candidate"} workspace
 * @property {string | null} blocker
 */

/**
 * @typedef {object} GoalBlockedResponse
 * @property {"continue" | "stop"} action
 * @property {string} guidance
 */

export default defineWorkflow({
  name: "goal",
  title: "Goal",
  description: "Pursue an open-ended objective through durable worker handoffs, verified candidate work, and exact human-approved apply.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["objective"],
    properties: {
      objective: { type: "string", minLength: 1, maxLength: 20000 },
    },
  },
  outputSchema: goalResultSchema,
  capabilities: ["read-project", "candidate-write", "host-command", "mediated-network", "human-input"],
  modelVisible: true,
  maxParallelism: 1,

  async run(flow, args) {
    let summary = "Goal work has not started.";
    let nextWork = [args.objective];
    let outputs = [];
    let latestReadArtifact = null;
    let guidance = "";
    let readCompleted = false;
    let mutationRequired = false;
    let stopped = false;

    await flow.loop("read-workers", {
      maxIterations: 8,
      while: () => ({
        result: !readCompleted && !mutationRequired && !stopped,
        label: "read-only goal work remains",
        operands: { readCompleted, mutationRequired, stopped },
      }),
    }, async ({ iteration }) => {
      /** @type {FlowAgentProduct<GoalWorkerResult>} */
      const worker = await flow.agent("read-worker", {
        profile: "builtin:researcher",
        prompt: [
          `Objective: ${args.objective}`,
          `This is deliberate worker ${iteration + 1}. Inspect, research, or synthesize without editing the project.`,
          guidance ? `Human guidance: ${guidance}` : "No additional human guidance was supplied.",
          `Explicit next work from the prior worker: ${JSON.stringify(nextWork)}`,
          "Finish with outcome=completed only when workflow-specific evidence supports completion. Use outcome=handoff for a fresh worker and workspace=candidate when project mutation is required. Use outcome=blocked only for a concrete human decision or unavailable prerequisite.",
          "Describe the durable handoff in outputs, publish its full evidence as an artifact, and call finish_work with the exact contract.",
        ].join("\n\n"),
        inputs: latestReadArtifact === null ? [] : [{ id: "prior-worker", artifact: latestReadArtifact }],
        outputSchema: goalWorkerSchema,
        network: "research",
        resultMode: "value-and-artifact",
      });
      summary = worker.value.summary;
      nextWork = worker.value.nextWork;
      outputs.push(...worker.value.outputs);
      outputs = outputs.slice(-64);
      latestReadArtifact = worker.artifact;
      if (worker.value.outcome === "completed") readCompleted = true;
      else if (worker.value.outcome === "handoff") mutationRequired = worker.value.workspace === "candidate";
      else {
        /** @type {GoalBlockedResponse} */
        const response = await flow.checkpoint("read-blocked", {
          kind: "input",
          title: "Goal worker is blocked",
          prompt: `${worker.value.blocker ?? worker.value.summary}\n\nNext work: ${worker.value.nextWork.join("; ")}`,
          responseSchema: blockedResponseSchema,
        });
        if (response.action === "stop") stopped = true;
        else {
          guidance = response.guidance;
          nextWork = worker.value.nextWork;
        }
      }
    });

    if (readCompleted) {
      return { status: "completed", summary, outputs, nextWork, changedPaths: [], applied: false };
    }
    if (stopped) {
      return { status: "blocked", summary, outputs, nextWork, changedPaths: [], applied: false };
    }
    if (!mutationRequired) {
      return {
        status: "blocked",
        summary: "The read-only worker handoff limit was reached without evidence of completion.",
        outputs,
        nextWork,
        changedPaths: [],
        applied: false,
      };
    }

    let candidateSettled = false;
    let candidateBlocked = false;
    let applied = false;
    let changedPaths = [];
    let verificationFailures = 0;

    await flow.loop("candidate-attempts", {
      maxIterations: 3,
      while: () => ({
        result: !candidateSettled && !candidateBlocked,
        label: "candidate goal work remains",
        operands: { candidateSettled, candidateBlocked, verificationFailures },
      }),
    }, async ({ iteration }) => {
      const produced = await flow.candidate("workspace", async workspace => {
        const workerContext = [
          `Objective: ${args.objective}`,
          `This is candidate attempt ${iteration + 1}. Work in the shared disposable candidate workspace.`,
          verificationFailures > 0 ? `A prior candidate failed general verification ${verificationFailures} time(s). Reinspect and produce a corrected implementation rather than assuming its changes survived.` : "No prior candidate failed verification.",
          guidance ? `Human guidance: ${guidance}` : "No additional human guidance was supplied.",
          `Explicit next work: ${JSON.stringify(nextWork)}`,
          "Preserve useful existing candidate work. Finish with outcome=completed only when the objective and relevant checks are complete. Use outcome=handoff to launch a fresh worker in this same candidate workspace, or outcome=blocked for a concrete human decision.",
          "Describe durable outputs, publish the complete handoff as an artifact, and call finish_work with the exact contract.",
        ].join("\n\n");
        /** @type {FlowAgentProduct<GoalWorkerResult>} */
        const first = await flow.agent("write-worker-one", {
          profile: "builtin:implementer",
          prompt: `${workerContext}\n\nYou are candidate worker 1 of at most 3.`,
          inputs: latestReadArtifact === null ? [] : [{ id: "prior-worker", artifact: latestReadArtifact }],
          outputSchema: goalWorkerSchema,
          workspace,
          network: "research",
          resultMode: "value-and-artifact",
        });
        if (first.value.outcome !== "handoff") return first.value;

        /** @type {FlowAgentProduct<GoalWorkerResult>} */
        const second = await flow.agent("write-worker-two", {
          profile: "builtin:implementer",
          prompt: `${workerContext}\n\nYou are candidate worker 2 of at most 3. Continue the explicit handoff in the existing workspace: ${JSON.stringify(first.value.nextWork)}`,
          inputs: [{ id: "prior-worker", artifact: first.artifact }],
          outputSchema: goalWorkerSchema,
          workspace,
          network: "research",
          resultMode: "value-and-artifact",
        });
        if (second.value.outcome !== "handoff") return second.value;

        /** @type {FlowAgentProduct<GoalWorkerResult>} */
        const third = await flow.agent("write-worker-three", {
          profile: "builtin:implementer",
          prompt: `${workerContext}\n\nYou are the final candidate worker. Complete the explicit handoff in the existing workspace: ${JSON.stringify(second.value.nextWork)}`,
          inputs: [{ id: "prior-worker", artifact: second.artifact }],
          outputSchema: goalWorkerSchema,
          workspace,
          network: "research",
          resultMode: "value-and-artifact",
        });
        if (third.value.outcome !== "handoff") return third.value;
        return {
          outcome: "blocked",
          summary: "The shared candidate worker handoff limit was reached without evidence of completion.",
          outputs: third.value.outputs,
          nextWork: third.value.nextWork,
          workspace: "candidate",
          blocker: "Candidate worker handoff limit reached.",
        };
      }, { metadataSchema: goalWorkerSchema });

      summary = produced.metadata.summary;
      nextWork = produced.metadata.nextWork;
      outputs.push(...produced.metadata.outputs);
      outputs = outputs.slice(-64);
      changedPaths = produced.changedPaths;
      if (produced.metadata.outcome === "blocked") {
        /** @type {GoalBlockedResponse} */
        const response = await flow.checkpoint("candidate-blocked", {
          kind: "input",
          title: "Goal candidate worker is blocked",
          prompt: `${produced.metadata.blocker ?? produced.metadata.summary}\n\nNext work: ${produced.metadata.nextWork.join("; ")}`,
          responseSchema: blockedResponseSchema,
        });
        if (response.action === "stop") candidateBlocked = true;
        else {
          guidance = response.guidance;
          nextWork = produced.metadata.nextWork;
        }
        return;
      }
      if (changedPaths.length === 0) {
        candidateSettled = true;
        return;
      }

      const verification = await flow.verify("verification", {
        candidate: produced.candidate,
        profile: "builtin:coding",
      });
      if (!verification.passed) {
        verificationFailures += 1;
        await flow.reject("reject", {
          candidate: produced.candidate,
          verification,
          reason: `general verification ${verification.status}`,
        });
        nextWork = [
          `Rebuild a corrected candidate for ${args.objective}`,
          `Address the prior general verification status: ${verification.status}`,
        ];
        return;
      }
      const accepted = await flow.accept("accept", { candidate: produced.candidate, verification });
      const receipt = await flow.apply("apply", { candidate: accepted, verification });
      changedPaths = receipt.changedPaths;
      applied = true;
      candidateSettled = true;
    });

    if (candidateSettled) {
      return { status: "completed", summary, outputs, nextWork, changedPaths, applied };
    }
    return {
      status: "blocked",
      summary: candidateBlocked ? summary : "General verification did not pass after three corrected candidates.",
      outputs,
      nextWork,
      changedPaths,
      applied: false,
    };
  },
});
