// Positive inference checks for the workflow runtime v17 contract.
import {
  agent,
  schema as s,
  type AgentResult,
  type Artifact,
  type Flow,
  type Infer,
} from "pi/workflows";

const Output = s.object({ value: s.string() });
const read = agent({ profile: "builtin:reader", output: Output });
const write = agent({ profile: "builtin:writer", output: Output, workspace: "candidate" });

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
