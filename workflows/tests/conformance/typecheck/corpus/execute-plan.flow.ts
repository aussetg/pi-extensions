// Strict compile fixture for the workflow runtime contract.
import {
  agent,
  schema as s,
  workflow,
  type AgentResult,
  type Candidate,
  type Infer,
} from "pi/workflows";

const Check = s.string({ minLength: 1, maxLength: 2_000 });

const PlanPoint = s.object({
  id: s.id(),
  objective: s.string({ minLength: 1, maxLength: 8_000 }),
  checks: s.array(Check, { maxItems: 16 }),
});
type PlanPoint = Infer<typeof PlanPoint>;

const Plan = s.object({
  summary: s.string({ minLength: 1, maxLength: 8_000 }),
  points: s.array(PlanPoint, { maxItems: 24 }),
  finalChecks: s.array(Check, { maxItems: 32 }),
});
type Plan = Infer<typeof Plan>;

const PointEvidence = s.object({
  id: s.id(),
  summary: s.string({ minLength: 1, maxLength: 2_000 }),
});

const PointOutcome = s.object({
  outcome: s.enum(["completed", "skipped", "blocked", "replan", "failed"]),
  pointId: s.id(),
  summary: s.string({ minLength: 1, maxLength: 8_000 }),
  evidence: s.array(PointEvidence, { maxItems: 32 }),
  nextWork: s.array(s.string({ minLength: 1, maxLength: 2_000 }), { maxItems: 16 }),
  blocker: s.nullable(s.string({ minLength: 1, maxLength: 4_000 })),
});
type PointOutcome = Infer<typeof PointOutcome>;

const LedgerEntry = s.object({
  planRevision: s.integer({ minimum: 1, maximum: 9 }),
  pointId: s.id(),
  outcome: s.enum(["completed", "skipped", "blocked", "replan", "failed"]),
  summary: s.string({ minLength: 1, maxLength: 8_000 }),
  evidence: s.array(PointEvidence, { maxItems: 32 }),
});
type LedgerEntry = Infer<typeof LedgerEntry>;

const CandidateOutcome = s.object({
  status: s.enum(["ready", "blocked", "failed"]),
  summary: s.string({ minLength: 1, maxLength: 12_000 }),
  planRevision: s.integer({ minimum: 1, maximum: 9 }),
  ledger: s.array(LedgerEntry, { maxItems: 64 }),
  finalChecks: s.array(Check, { maxItems: 32 }),
});
type CandidateOutcome = Infer<typeof CandidateOutcome>;

const BlockedResponse = s.object({
  action: s.enum(["verify", "stop"]),
});

const Result = s.object({
  status: s.enum(["completed", "blocked", "failed", "verification-failed"]),
  summary: s.string({ minLength: 1, maxLength: 12_000 }),
  planRevision: s.integer({ minimum: 1, maximum: 9 }),
  ledger: s.array(LedgerEntry, { maxItems: 64 }),
  finalChecks: s.array(Check, { maxItems: 32 }),
  changedPaths: s.array(s.safePath(), { maxItems: 4_096, uniqueItems: true }),
  applied: s.boolean(),
});
type Result = Infer<typeof Result>;

const createPlan = agent({
  profile: "builtin:researcher",
  network: "research",
  output: Plan,
});

const executePoint = agent({
  profile: "builtin:implementer",
  workspace: "candidate",
  network: "research",
  output: PointOutcome,
});

const revisePlan = agent({
  profile: "builtin:researcher",
  workspace: "candidate",
  network: "research",
  output: Plan,
});

function duplicatePointId(points: readonly PlanPoint[]): string | undefined {
  return points.find((point, index) =>
    points.findIndex(other => other.id === point.id) !== index)?.id;
}

export default workflow({
  description: "Plan and execute stable sequential points in one durable candidate with explicit replanning.",
  input: s.object({
    objective: s.string({ minLength: 1, maxLength: 20_000 }),
  }),
  output: Result,

  async run(flow, { objective }): Promise<Result> {
    const initial = await flow.agent(createPlan, {
      prompt: [
        `Objective: ${objective}`,
        "Inspect the launch project and return an executable sequential plan.",
        "Every point needs a stable lowercase ID, one bounded objective, and concrete checks.",
        "Keep points independently finishable and order them by dependency.",
        "Final checks must cover the whole plan.",
      ].join("\n\n"),
    });

    const candidate: Candidate<CandidateOutcome> = await flow.candidate(async workspace => {
      let plan: Plan = initial.output;
      let planArtifact = initial.artifact;
      let planRevision = 1;
      let pointIndex = 0;
      let replans = 0;
      let ledger: LedgerEntry[] = [];
      let latestPoint: AgentResult<PointOutcome, "candidate"> | null = null;
      const initialDuplicate = duplicatePointId(plan.points);
      let status: CandidateOutcome["status"] = initialDuplicate === undefined ? "ready" : "failed";
      let summary = initialDuplicate === undefined
        ? plan.summary
        : `Initial plan contains duplicate point ID ${initialDuplicate}.`;

      let admissions = 0;
      for (
        ;
        admissions < 64 && status === "ready" && pointIndex < plan.points.length;
        admissions++
      ) {
        const point = plan.points[pointIndex];
        if (!point) throw new Error(`plan point ${pointIndex} disappeared`);
        const alreadyCompleted = ledger.some(entry =>
          entry.pointId === point.id && entry.outcome === "completed");
        if (alreadyCompleted) {
          pointIndex++;
          continue;
        }

        const pointResult: AgentResult<PointOutcome, "candidate"> = await flow.agent(executePoint, {
          title: `Point ${point.id}`,
          workspace,
          prompt: [
            `Overall objective: ${objective}`,
            `Plan revision: ${planRevision}. Point ${pointIndex + 1}/${plan.points.length}.`,
            `Stable point ID: ${point.id}`,
            `Point objective: ${point.objective}`,
            `Point checks: ${JSON.stringify(point.checks)}`,
            `Whole-plan final checks: ${JSON.stringify(plan.finalChecks)}`,
            `Completed-point ledger: ${JSON.stringify(ledger)}`,
            "Preserve prior point work and run relevant bounded checks.",
            "Return completed only with evidence; otherwise return skipped, blocked, replan, or failed.",
            "The returned pointId must exactly match the stable point ID.",
          ].join("\n\n"),
          artifacts: {
            currentPlan: planArtifact,
            ...(latestPoint ? { priorPoint: latestPoint } : {}),
          },
        });

        latestPoint = pointResult;
        const matchesPoint = pointResult.output.pointId === point.id;
        const outcome: PointOutcome["outcome"] = matchesPoint
          ? pointResult.output.outcome
          : "failed";
        summary = matchesPoint
          ? pointResult.output.summary
          : `Point agent returned ${pointResult.output.pointId} while executing ${point.id}.`;
        ledger.push({
          planRevision,
          pointId: point.id,
          outcome,
          summary,
          evidence: pointResult.output.evidence,
        });
        ledger = ledger.slice(-64);

        if (outcome === "completed" || outcome === "skipped") {
          pointIndex++;
          continue;
        }
        if (outcome === "blocked" || outcome === "failed") {
          status = outcome;
          summary = pointResult.output.blocker ?? summary;
          continue;
        }
        if (replans >= 8) {
          status = "blocked";
          summary = "The execute-plan replan limit was reached with all evidence preserved.";
          continue;
        }

        const replanned: AgentResult<Plan, "candidate"> = await flow.agent(revisePlan, {
          title: `Replan ${planRevision + 1}`,
          workspace,
          prompt: [
            `Overall objective: ${objective}`,
            `Current plan revision: ${planRevision}.`,
            `Replan request: ${JSON.stringify(pointResult.output.nextWork)}`,
            `Completed-point ledger: ${JSON.stringify(ledger)}`,
            "Preserve completed candidate work and return a fresh plan for only the remaining work.",
            "Omit completed point IDs unless a new objective genuinely requires revisiting them.",
          ].join("\n\n"),
          artifacts: {
            currentPlan: planArtifact,
            completedPoint: pointResult,
            workspaceCheckpoint: pointResult.checkpoint,
          },
        });

        const duplicate = duplicatePointId(replanned.output.points);
        if (duplicate !== undefined) {
          status = "failed";
          summary = `Replanned plan contains duplicate point ID ${duplicate}.`;
          continue;
        }

        plan = replanned.output;
        planArtifact = replanned.artifact;
        planRevision++;
        replans++;
        pointIndex = 0;
        summary = plan.summary;
      }

      if (status === "ready" && pointIndex < plan.points.length && admissions === 64) {
        status = "blocked";
        summary = "The execute-plan point admission limit was reached with all evidence preserved.";
      }

      return {
        status,
        summary,
        planRevision,
        ledger,
        finalChecks: plan.finalChecks,
      };
    });

    const result = (
      status: Result["status"],
      summary: string,
      applied = false,
      changedPaths: readonly string[] = candidate.changedPaths,
    ): Result => ({
      status,
      summary,
      planRevision: candidate.output.planRevision,
      ledger: candidate.output.ledger,
      finalChecks: candidate.output.finalChecks,
      changedPaths,
      applied,
    });

    if (candidate.output.status === "failed") {
      await flow.reject(candidate, { reason: candidate.output.summary });
      return result("failed", candidate.output.summary);
    }

    if (candidate.output.status === "blocked") {
      const response = await flow.ask({
        title: "Execute-plan point is blocked",
        prompt: `${candidate.output.summary}\n\nVerify and apply the exact completed work, or stop?`,
        response: BlockedResponse,
      });
      if (response.action === "stop") {
        await flow.reject(candidate, { reason: candidate.output.summary });
        return result("blocked", candidate.output.summary);
      }
    }

    const verification = await flow.verify(candidate, "builtin:coding");
    if (!verification.passed) {
      await flow.reject(candidate, {
        verification,
        reason: `Final execute-plan verification ${verification.status}`,
      });
      return result(
        "verification-failed",
        `Final verification ${verification.status}: ${candidate.output.summary}`,
      );
    }

    const accepted = await flow.accept(candidate, { verification });
    const applied = await flow.apply(accepted);
    return result("completed", candidate.output.summary, true, applied.changedPaths);
  },
});
