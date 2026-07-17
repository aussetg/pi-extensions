// Negative authority checks for the workflow runtime v17 contract.
import {
  agent,
  schema as s,
  type Candidate,
  type Flow,
  type NonPassedVerification,
} from "pi/workflows";

const Output = s.object({ value: s.string() });
const reader = agent({ profile: "builtin:reader", output: Output });
const writer = agent({
  profile: "builtin:writer",
  output: Output,
  workspace: "candidate",
});

export async function authorityErrors(
  flow: Flow,
  candidate: Candidate<{ value: string }>,
  failed: NonPassedVerification,
) {
  // @ts-expect-error candidate tasks require a candidate workspace
  await flow.agent(writer, { prompt: "missing workspace" });

  // @ts-expect-error snapshot tasks do not accept a candidate workspace
  await flow.agent(reader, { workspace: {} as never, prompt: "wrong task class" });

  // @ts-expect-error ordinary JSON is not an artifact input
  await flow.agent(reader, { prompt: "bad artifact", artifacts: { data: { value: "plain" } } });

  // @ts-expect-error a nonpassed verification cannot authorize acceptance
  await flow.accept(candidate, { verification: failed });

  // @ts-expect-error apply requires an accepted candidate
  await flow.apply(candidate);
}
