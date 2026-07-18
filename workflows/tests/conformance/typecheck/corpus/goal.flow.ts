// Strict compile fixture for the workflow runtime contract.
import {
  agent,
  schema as s,
  workflow,
  type AgentResult,
  type Candidate,
  type Infer,
} from "pi/workflows";

const OutputDescriptor = s.object({
  id: s.id(),
  kind: s.enum(["finding", "decision", "change", "check", "other"]),
  summary: s.string({ minLength: 1, maxLength: 2_000 }),
});
type OutputDescriptor = Infer<typeof OutputDescriptor>;

const WorkerOutcome = s.object({
  outcome: s.enum(["completed", "handoff", "blocked"]),
  summary: s.string({ minLength: 1, maxLength: 8_000 }),
  outputs: s.array(OutputDescriptor, { maxItems: 16 }),
  nextWork: s.array(s.string({ minLength: 1, maxLength: 2_000 }), { maxItems: 16 }),
  workspace: s.enum(["read-only", "candidate"]),
  blocker: s.nullable(s.string({ minLength: 1, maxLength: 4_000 })),
});
type WorkerOutcome = Infer<typeof WorkerOutcome>;

const BlockedResponse = s.object({
  action: s.enum(["continue", "stop"]),
  guidance: s.string({ maxLength: 8_000 }),
});

const Result = s.object({
  status: s.enum(["completed", "blocked"]),
  summary: s.string({ minLength: 1, maxLength: 12_000 }),
  outputs: s.array(OutputDescriptor, { maxItems: 64 }),
  nextWork: s.array(s.string({ minLength: 1, maxLength: 2_000 }), { maxItems: 16 }),
  changedPaths: s.array(s.safePath(), { maxItems: 4_096, uniqueItems: true }),
  applied: s.boolean(),
});
type Result = Infer<typeof Result>;

const inspectGoal = agent({
  profile: "builtin:researcher",
  network: "research",
  output: WorkerOutcome,
});

const implementGoal = agent({
  profile: "builtin:implementer",
  workspace: "candidate",
  network: "research",
  output: WorkerOutcome,
});

export default workflow({
  description: "Pursue an open-ended objective through durable worker handoffs and verified candidate work.",
  input: s.object({
    objective: s.string({ minLength: 1, maxLength: 20_000 }),
  }),
  output: Result,

  async run(flow, { objective }): Promise<Result> {
    let summary = "Goal work has not started.";
    let nextWork: readonly string[] = [objective];
    let outputs: OutputDescriptor[] = [];
    let latestReadWorker: AgentResult<WorkerOutcome, "snapshot"> | null = null;
    let guidance = "";
    let readCompleted = false;
    let mutationRequired = false;
    let stopped = false;

    for (
      let iteration = 0;
      iteration < 8 && !readCompleted && !mutationRequired && !stopped;
      iteration++
    ) {
      const worker: AgentResult<WorkerOutcome, "snapshot"> = await flow.agent(inspectGoal, {
        prompt: [
          `Objective: ${objective}`,
          `This is deliberate read-only worker ${iteration + 1}.`,
          guidance ? `Human guidance: ${guidance}` : "No additional human guidance was supplied.",
          `Explicit next work: ${JSON.stringify(nextWork)}`,
          "Inspect, research, or synthesize without editing the project.",
          "Return completed only with enough evidence, handoff for fresh work, or blocked for a concrete human decision.",
          "Set workspace=candidate when project mutation is required.",
        ].join("\n\n"),
        ...(latestReadWorker ? { artifacts: { priorWorker: latestReadWorker } } : {}),
      });

      summary = worker.output.summary;
      nextWork = worker.output.nextWork;
      outputs = [...outputs, ...worker.output.outputs].slice(-64);
      latestReadWorker = worker;

      if (worker.output.outcome === "completed") {
        readCompleted = true;
      } else if (worker.output.outcome === "handoff") {
        mutationRequired = worker.output.workspace === "candidate";
      } else {
        const response = await flow.ask({
          title: "Goal worker is blocked",
          prompt: `${worker.output.blocker ?? worker.output.summary}\n\nNext work: ${worker.output.nextWork.join("; ")}`,
          response: BlockedResponse,
        });
        if (response.action === "stop") stopped = true;
        else guidance = response.guidance;
      }
    }

    const finish = (
      status: Result["status"],
      changedPaths: readonly string[] = [],
      applied = false,
    ): Result => ({ status, summary, outputs, nextWork, changedPaths, applied });

    if (readCompleted) return finish("completed");
    if (stopped) return finish("blocked");
    if (!mutationRequired) {
      summary = "The read-only worker handoff limit was reached without evidence of completion.";
      return finish("blocked");
    }

    let verificationFailures = 0;
    let lastChangedPaths: readonly string[] = [];

    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate: Candidate<WorkerOutcome> = await flow.candidate(async workspace => {
        let priorWorker:
          | AgentResult<WorkerOutcome, "snapshot">
          | AgentResult<WorkerOutcome, "candidate">
          | null = latestReadWorker;
        let workerNextWork = nextWork;

        for (let workerIndex = 0; workerIndex < 3; workerIndex++) {
          const worker: AgentResult<WorkerOutcome, "candidate"> = await flow.agent(implementGoal, {
            workspace,
            prompt: [
              `Objective: ${objective}`,
              `Candidate attempt ${attempt + 1}; worker ${workerIndex + 1} of at most 3.`,
              verificationFailures > 0
                ? `A prior candidate failed general verification ${verificationFailures} time(s). Rebuild a corrected implementation.`
                : "No prior candidate failed verification.",
              guidance ? `Human guidance: ${guidance}` : "No additional human guidance was supplied.",
              `Explicit next work: ${JSON.stringify(workerNextWork)}`,
              "Preserve useful work already present in this candidate workspace.",
              "Return completed only when the objective and relevant checks are complete, handoff for a fresh worker, or blocked for a human decision.",
            ].join("\n\n"),
            ...(priorWorker ? { artifacts: { priorWorker } } : {}),
          });

          if (worker.output.outcome !== "handoff") return worker.output;
          priorWorker = worker;
          workerNextWork = worker.output.nextWork;
        }

        if (!priorWorker) throw new Error("candidate worker loop has no prior worker");
        return {
          outcome: "blocked",
          summary: "The shared candidate worker handoff limit was reached without evidence of completion.",
          outputs: priorWorker.output.outputs,
          nextWork: priorWorker.output.nextWork,
          workspace: "candidate",
          blocker: "Candidate worker handoff limit reached.",
        };
      });

      summary = candidate.output.summary;
      nextWork = candidate.output.nextWork;
      outputs = [...outputs, ...candidate.output.outputs].slice(-64);
      lastChangedPaths = candidate.changedPaths;

      if (candidate.output.outcome === "blocked") {
        const response = await flow.ask({
          title: "Goal candidate worker is blocked",
          prompt: `${candidate.output.blocker ?? candidate.output.summary}\n\nNext work: ${candidate.output.nextWork.join("; ")}`,
          response: BlockedResponse,
        });
        await flow.reject(candidate, {
          reason: response.action === "stop"
            ? candidate.output.summary
            : "rebuilding candidate with additional human guidance",
        });
        if (response.action === "stop") return finish("blocked", candidate.changedPaths);
        guidance = response.guidance;
        continue;
      }

      if (candidate.changedPaths.length === 0) return finish("completed");

      const verification = await flow.verify(candidate, "builtin:coding");
      if (!verification.passed) {
        verificationFailures++;
        await flow.reject(candidate, {
          verification,
          reason: `general verification ${verification.status}`,
        });
        nextWork = [
          `Rebuild a corrected candidate for ${objective}`,
          `Address the prior general verification status: ${verification.status}`,
        ];
        continue;
      }

      const accepted = await flow.accept(candidate, { verification });
      const applied = await flow.apply(accepted);
      return finish("completed", applied.changedPaths, true);
    }

    summary = "General verification did not pass after three corrected candidates.";
    return finish("blocked", lastChangedPaths);
  },
});
