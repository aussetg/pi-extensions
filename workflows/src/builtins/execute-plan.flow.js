const planCheckSchema = {
  type: "string",
  minLength: 1,
  maxLength: 2000,
};

const planPointSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "objective", "checks"],
  properties: {
    id: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z][a-z0-9_-]{0,63}$",
    },
    objective: { type: "string", minLength: 1, maxLength: 8000 },
    checks: { type: "array", maxItems: 16, items: planCheckSchema },
  },
};

const planSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "points", "finalChecks"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 8000 },
    points: { type: "array", maxItems: 24, items: planPointSchema },
    finalChecks: { type: "array", maxItems: 32, items: planCheckSchema },
  },
};

const pointEvidenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "summary"],
  properties: {
    id: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z][a-z0-9_-]{0,63}$",
    },
    summary: { type: "string", minLength: 1, maxLength: 2000 },
  },
};

const pointOutcomeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "pointId", "summary", "evidence", "nextWork", "blocker"],
  properties: {
    outcome: {
      type: "string",
      enum: ["completed", "skipped", "blocked", "replan", "failed"],
    },
    pointId: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z][a-z0-9_-]{0,63}$",
    },
    summary: { type: "string", minLength: 1, maxLength: 8000 },
    evidence: { type: "array", maxItems: 32, items: pointEvidenceSchema },
    nextWork: {
      type: "array",
      maxItems: 16,
      items: { type: "string", minLength: 1, maxLength: 2000 },
    },
    blocker: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 4000 },
        { type: "null" },
      ],
    },
  },
};

const ledgerEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["planRevision", "pointId", "outcome", "summary", "evidence"],
  properties: {
    planRevision: { type: "integer", minimum: 1, maximum: 9 },
    pointId: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z][a-z0-9_-]{0,63}$",
    },
    outcome: {
      type: "string",
      enum: ["completed", "skipped", "blocked", "replan", "failed"],
    },
    summary: { type: "string", minLength: 1, maxLength: 8000 },
    evidence: { type: "array", maxItems: 32, items: pointEvidenceSchema },
  },
};

const candidateMetadataSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "planRevision", "ledger", "finalChecks"],
  properties: {
    status: { type: "string", enum: ["ready", "blocked", "failed"] },
    summary: { type: "string", minLength: 1, maxLength: 12000 },
    planRevision: { type: "integer", minimum: 1, maximum: 9 },
    ledger: { type: "array", maxItems: 64, items: ledgerEntrySchema },
    finalChecks: { type: "array", maxItems: 32, items: planCheckSchema },
  },
};

const blockedResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["verify", "stop"] },
  },
};

const executePlanResultSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status", "summary", "planRevision", "ledger", "finalChecks", "changedPaths", "applied",
  ],
  properties: {
    status: {
      type: "string",
      enum: ["completed", "blocked", "failed", "verification-failed"],
    },
    summary: { type: "string", minLength: 1, maxLength: 12000 },
    planRevision: { type: "integer", minimum: 1, maximum: 9 },
    ledger: { type: "array", maxItems: 64, items: ledgerEntrySchema },
    finalChecks: { type: "array", maxItems: 32, items: planCheckSchema },
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
 * @typedef {object} PlanPoint
 * @property {string} id
 * @property {string} objective
 * @property {string[]} checks
 */

/**
 * @typedef {object} ExecutePlan
 * @property {string} summary
 * @property {PlanPoint[]} points
 * @property {string[]} finalChecks
 */

/**
 * @typedef {object} PointOutcome
 * @property {"completed" | "skipped" | "blocked" | "replan" | "failed"} outcome
 * @property {string} pointId
 * @property {string} summary
 * @property {Array<{id: string, summary: string}>} evidence
 * @property {string[]} nextWork
 * @property {string | null} blocker
 */

/**
 * @typedef {object} BlockedResponse
 * @property {"verify" | "stop"} action
 */

export default defineWorkflow({
  name: "execute-plan",
  title: "Execute plan",
  description: "Plan and execute stable sequential points in one durable candidate, with explicit replanning, final verification, and exact human-approved apply.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["objective"],
    properties: {
      objective: { type: "string", minLength: 1, maxLength: 20000 },
    },
  },
  outputSchema: executePlanResultSchema,
  capabilities: ["read-project", "candidate-write", "host-command", "mediated-network", "human-input"],
  modelVisible: true,
  maxParallelism: 1,

  async run(flow, args) {
    /** @type {FlowAgentProduct<ExecutePlan>} */
    const initial = await flow.agent("planner", {
      profile: "builtin:researcher",
      prompt: [
        `Objective: ${args.objective}`,
        "Inspect the immutable launch project and return an executable sequential plan.",
        "Every point needs a stable lowercase ID, one bounded objective, and concrete checks. Keep points independently finishable and order them by dependency.",
        "finalChecks must describe the whole-plan checks that the host verification policy should cover.",
        "Publish the complete plan as a durable JSON artifact and call finish_work with the exact plan contract.",
      ].join("\n\n"),
      outputSchema: planSchema,
      network: "research",
      resultMode: "value-and-artifact",
    });

    const produced = await flow.candidate("workspace", async workspace => {
      let plan = initial.value;
      let planArtifact = initial.artifact;
      let planRevision = 1;
      let pointIndex = 0;
      let replans = 0;
      let ledger = [];
      let latestPointArtifact = null;
      const initialDuplicate = plan.points.find((point, index) =>
        plan.points.findIndex(candidate => candidate.id === point.id) !== index);
      let candidateStatus = initialDuplicate === undefined ? "ready" : "failed";
      let candidateSummary = initialDuplicate === undefined
        ? plan.summary
        : `Initial plan contains duplicate point ID ${initialDuplicate.id}.`;

      const pointLoop = await flow.loop("points", {
        maxIterations: 64,
        while: () => ({
          result: candidateStatus === "ready" && pointIndex < plan.points.length,
          label: "planned points remain",
          operands: {
            planRevision,
            pointIndex,
            pointCount: plan.points.length,
            completed: ledger.filter(entry => entry.outcome === "completed").length,
            skipped: ledger.filter(entry => entry.outcome === "skipped").length,
            replans,
          },
        }),
      }, async () => {
        const point = plan.points[pointIndex];
        const alreadyCompleted = ledger.find(entry =>
          entry.pointId === point.id && entry.outcome === "completed");
        if (alreadyCompleted) {
          pointIndex += 1;
          return;
        }

        const pointInputs = latestPointArtifact === null
          ? [{ id: "current-plan", artifact: planArtifact }]
          : [
              { id: "current-plan", artifact: planArtifact },
              { id: "prior-point-checkpoint", artifact: latestPointArtifact },
            ];
        /** @type {FlowAgentProduct<PointOutcome>} */
        const pointResult = await flow.agent("point", {
          profile: "builtin:implementer",
          prompt: [
            `Overall objective: ${args.objective}`,
            `Plan revision: ${planRevision}. Sequential point ${pointIndex + 1}/${plan.points.length}.`,
            `Stable point ID: ${point.id}`,
            `Point objective: ${point.objective}`,
            `Point checks: ${JSON.stringify(point.checks)}`,
            `Whole-plan final checks: ${JSON.stringify(plan.finalChecks)}`,
            `Completed/skipped/replan ledger: ${JSON.stringify(ledger)}`,
            "Work only in the shared disposable candidate. Preserve prior point work and run relevant bounded checks.",
            "Return completed only with evidence. Return skipped only when the point is demonstrably unnecessary, blocked for a concrete human decision, replan when the remaining plan is invalid, or failed when this point cannot safely complete.",
            "The returned pointId must exactly match the stable point ID above. Publish a durable completed-point-ledger artifact containing the complete prior ledger plus this exact outcome, evidence, and workspace state summary, then call finish_work with the exact contract.",
          ].join("\n\n"),
          inputs: pointInputs,
          outputSchema: pointOutcomeSchema,
          workspace,
          network: "research",
          resultMode: "value-and-artifact",
        });

        latestPointArtifact = pointResult.artifact;
        const workspaceCheckpointArtifact = pointResult.workspaceCheckpointArtifact;
        if (workspaceCheckpointArtifact === undefined) {
          candidateStatus = "failed";
          candidateSummary = `Point ${point.id} completed without a host workspace-checkpoint artifact.`;
          return;
        }
        const outcome = pointResult.value.pointId === point.id
          ? pointResult.value.outcome
          : "failed";
        const summary = pointResult.value.pointId === point.id
          ? pointResult.value.summary
          : `Point agent returned ${pointResult.value.pointId} while executing ${point.id}.`;
        ledger.push({
          planRevision,
          pointId: point.id,
          outcome,
          summary,
          evidence: pointResult.value.evidence,
        });
        ledger = ledger.slice(-64);
        candidateSummary = summary;

        if (outcome === "completed" || outcome === "skipped") {
          pointIndex += 1;
          return;
        }
        if (outcome === "blocked") {
          candidateStatus = "blocked";
          candidateSummary = pointResult.value.blocker ?? summary;
          return;
        }
        if (outcome === "failed") {
          candidateStatus = "failed";
          return;
        }
        if (replans >= 8) {
          candidateStatus = "blocked";
          candidateSummary = "The execute-plan replan limit was reached with all evidence preserved.";
          return;
        }

        /** @type {FlowAgentProduct<ExecutePlan>} */
        const replanned = await flow.agent("replanner", {
          profile: "builtin:researcher",
          prompt: [
            `Overall objective: ${args.objective}`,
            `Current plan revision: ${planRevision}. Replan request: ${JSON.stringify(pointResult.value.nextWork)}`,
            `Completed-point ledger: ${JSON.stringify(ledger)}`,
            "Inspect the exact current shared candidate workspace. Preserve completed work and omit already completed point IDs unless a new objective genuinely depends on revisiting them.",
            "The current-plan artifact is the prior exact plan. The completed-point-ledger input is the latest durable point outcome. The workspace-checkpoint input is the host-authored descriptor of the exact restored candidate checkpoint.",
            "Return fresh stable point IDs/objectives for remaining work and updated whole-plan final checks. Publish the replacement plan as a durable artifact and call finish_work with the exact contract.",
          ].join("\n\n"),
          inputs: [
            { id: "current-plan", artifact: planArtifact },
            { id: "completed-point-ledger", artifact: pointResult.artifact },
            { id: "workspace-checkpoint", artifact: workspaceCheckpointArtifact },
          ],
          outputSchema: planSchema,
          workspace,
          network: "research",
          resultMode: "value-and-artifact",
        });
        const duplicate = replanned.value.points.find((replannedPoint, index) =>
          replanned.value.points.findIndex(candidate => candidate.id === replannedPoint.id) !== index);
        if (duplicate !== undefined) {
          candidateStatus = "failed";
          candidateSummary = `Replanned plan contains duplicate point ID ${duplicate.id}.`;
          return;
        }
        plan = replanned.value;
        planArtifact = replanned.artifact;
        planRevision += 1;
        replans += 1;
        pointIndex = 0;
        candidateSummary = plan.summary;
      });

      const admissionExhausted = pointLoop.stoppedBy === "limit"
        && candidateStatus === "ready"
        && pointIndex < plan.points.length;
      return {
        status: admissionExhausted ? "blocked" : candidateStatus,
        summary: admissionExhausted
          ? "The execute-plan point admission limit was reached with all point evidence preserved."
          : candidateSummary,
        planRevision,
        ledger,
        finalChecks: plan.finalChecks,
      };
    }, { metadataSchema: candidateMetadataSchema });

    if (produced.metadata.status === "failed") {
      await flow.reject("reject-failed", {
        candidate: produced.candidate,
        reason: produced.metadata.summary,
      });
      return {
        status: "failed",
        summary: produced.metadata.summary,
        planRevision: produced.metadata.planRevision,
        ledger: produced.metadata.ledger,
        finalChecks: produced.metadata.finalChecks,
        changedPaths: produced.changedPaths,
        applied: false,
      };
    }

    if (produced.metadata.status === "blocked") {
      /** @type {BlockedResponse} */
      const response = await flow.checkpoint("blocked", {
        kind: "input",
        title: "Execute-plan point is blocked",
        prompt: `${produced.metadata.summary}\n\nVerify and apply the exact work already completed, or stop with the candidate untouched?`,
        responseSchema: blockedResponseSchema,
      });
      if (response.action === "stop") {
        await flow.reject("reject-blocked", {
          candidate: produced.candidate,
          reason: produced.metadata.summary,
        });
        return {
          status: "blocked",
          summary: produced.metadata.summary,
          planRevision: produced.metadata.planRevision,
          ledger: produced.metadata.ledger,
          finalChecks: produced.metadata.finalChecks,
          changedPaths: produced.changedPaths,
          applied: false,
        };
      }
    }

    const verification = await flow.verify("final-verification", {
      candidate: produced.candidate,
      profile: "builtin:coding",
    });
    if (!verification.passed) {
      await flow.reject("reject-verification", {
        candidate: produced.candidate,
        verification,
        reason: `Final execute-plan verification ${verification.status}`,
      });
      return {
        status: "verification-failed",
        summary: `Final verification ${verification.status}: ${produced.metadata.summary}`,
        planRevision: produced.metadata.planRevision,
        ledger: produced.metadata.ledger,
        finalChecks: produced.metadata.finalChecks,
        changedPaths: produced.changedPaths,
        applied: false,
      };
    }

    const accepted = await flow.accept("accept", {
      candidate: produced.candidate,
      verification,
    });
    const receipt = await flow.apply("apply", { candidate: accepted, verification });
    return {
      status: "completed",
      summary: produced.metadata.summary,
      planRevision: produced.metadata.planRevision,
      ledger: produced.metadata.ledger,
      finalChecks: produced.metadata.finalChecks,
      changedPaths: receipt.changedPaths,
      applied: true,
    };
  },
});
