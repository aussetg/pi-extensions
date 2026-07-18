// Positive inference checks for the workflow runtime contract.
import {
  agent,
  command,
  schema as s,
  type AgentResult,
  type Artifact,
  type Candidate,
  type Flow,
  type Infer,
  type MeasurementProfileSelector,
} from "pi/workflows";

const Output = s.object({ value: s.string() });
const read = agent({ profile: "builtin:reader", output: Output });
const write = agent({ profile: "builtin:writer", output: Output, workspace: "candidate" });
const textCommand = command({ profile: "builtin:describe", output: "text" });
const jsonCommand = command({ profile: "builtin:inspect", output: "json", effect: "temporary" });

export async function inferSequential(flow: Flow) {
  const first = await flow.agent(read, { prompt: "first" });
  const second = await flow.agent(read, { prompt: "second", artifacts: { first } });
  return second.output.value;
}

export async function inferCandidate(flow: Flow) {
  const plan = await flow.agent(read, { prompt: "plan" });
  const candidate = await flow.candidate(async workspace => {
    return (await flow.agent(write, {
      workspace,
      prompt: "write",
      artifacts: { plan },
    })).output;
  });
  return candidate.output.value;
}

export async function inferLoop(flow: Flow) {
  let prior: Artifact | null = null;
  for (let index = 0; index < 3; index++) {
    const current: AgentResult<Infer<typeof Output>, "snapshot"> = await flow.agent(read, {
      prompt: "next",
      ...(prior ? { artifacts: { prior } } : {}),
    });
    prior = current.artifact;
  }
  return prior;
}

export async function inferStructuredConcurrency(flow: Flow) {
  const parallel = await flow.parallel({
    name: async () => "native" as const,
    count: async () => 2 as const,
  });
  const collected = await flow.map(["a", "b"] as const, async value => value.length, {
    key: value => value,
    errors: "collect",
  });
  if (!collected[0]?.ok) return parallel.name;
  const count: number = collected[0].value;
  const exactName: "native" = parallel.name;
  const exactCount: 2 = parallel.count;
  return `${exactName}:${exactCount}:${count}`;
}

export async function inferCommandsAndAsk(flow: Flow) {
  const text = await flow.command(textCommand);
  const json = await flow.command(jsonCommand, { args: { detail: true } });
  const decision = await flow.ask({
    prompt: "Continue?",
    response: s.enum(["continue", "stop"]),
  });
  const output: string = text.output;
  const structured: import("pi/workflows").JsonValue = json.output;
  const exactDecision: "continue" | "stop" = decision;
  return { output, structured, exactDecision };
}

export function inferSchemaResources(value: Infer<ReturnType<typeof resourceInput>>) {
  const evaluator: MeasurementProfileSelector = value.evaluator;
  const mode: "fast" | "thorough" | undefined = value.mode;
  return { evaluator, mode };
}

function resourceInput() {
  return s.object({
    evaluator: s.measurementProfile(),
    mode: s.optional(s.enum(["fast", "thorough"])),
  });
}

export async function inferVerification(flow: Flow, candidate: Candidate<{ value: string }>) {
  const verification = await flow.verify(candidate, "builtin:coding");
  await flow.agent(read, { prompt: "summarize evidence", artifacts: { verification } });
  if (!verification.passed) return verification.status;
  const accepted = await flow.accept(candidate, { verification });
  return (await flow.apply(accepted)).applied;
}
