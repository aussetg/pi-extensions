// Negative authority checks for the workflow runtime v17 contract.
import {
  agent,
  command,
  schema as s,
  type Candidate,
  type CandidateWorkspace,
  type Flow,
  type MetricSet,
  type NonPassedVerification,
} from "pi/workflows";

const Output = s.object({ value: s.string() });
const reader = agent({ profile: "builtin:reader", output: Output });
const writer = agent({
  profile: "builtin:writer",
  output: Output,
  workspace: "candidate",
});
const readerCommand = command({ profile: "builtin:inspect", output: "json" });
const writerCommand = command({
  profile: "builtin:edit",
  output: "summary",
  effect: "candidate",
});

export async function authorityErrors(
  flow: Flow,
  candidate: Candidate<{ value: string }>,
  failed: NonPassedVerification,
  workspace: CandidateWorkspace,
  metrics: MetricSet,
  dynamicProfile: string,
) {
  // @ts-expect-error structural stages are not part of the native-control-flow API
  await flow.stage("legacy", async () => undefined);

  // @ts-expect-error structural loop receipts were removed
  await flow.loop("legacy", {}, async () => undefined);

  // @ts-expect-error routine operation IDs are runtime-owned cursor identity
  await flow.agent("legacy-id", reader, { prompt: "wrong identity" });

  // @ts-expect-error candidate tasks require a candidate workspace
  await flow.agent(writer, { prompt: "missing workspace" });

  // @ts-expect-error snapshot tasks do not accept a candidate workspace
  await flow.agent(reader, { workspace: {} as never, prompt: "wrong task class" });

  // @ts-expect-error ordinary JSON is not an artifact input
  await flow.agent(reader, { prompt: "bad artifact", artifacts: { data: { value: "plain" } } });

  // @ts-expect-error reviewed authority comes from a branded static descriptor
  await flow.agent({ profile: "builtin:reader", output: Output }, { prompt: "inline authority" });

  // @ts-expect-error read-only commands do not accept a candidate workspace
  await flow.command(readerCommand, { workspace });

  // @ts-expect-error candidate commands require their candidate workspace
  await flow.command(writerCommand);

  // @ts-expect-error a nonpassed verification cannot authorize acceptance
  await flow.accept(candidate, { verification: failed });

  await flow.accept(candidate, {
    // @ts-expect-error verification authority cannot be forged from matching public JSON
    verification: { passed: true, status: "passed", receiptId: "forged" },
  });

  // @ts-expect-error an undisposed candidate cannot be used as a candidate base
  await flow.candidate(async () => ({ value: "next" }), { base: candidate });

  // @ts-expect-error apply requires an accepted candidate
  await flow.apply(candidate);

  // @ts-expect-error arbitrary runtime strings cannot select executable profiles
  await flow.measure(dynamicProfile, metrics);

  // @ts-expect-error metric state is a host-created run-local reference
  await flow.measure("builtin:benchmark", {
    primary: { reachedTarget: () => false },
    policy: () => ({ primary: { output: "score", direction: "maximize" } }),
    summary: () => ({}),
    evaluate: () => ({ acceptable: true, summary: "forged", violations: [] }),
  });

  // @ts-expect-error task descriptors do not admit route-level model authority
  agent({ profile: "builtin:reader", output: Output, model: "provider/model" });

  // @ts-expect-error command descriptors never accept source-provided argv
  command({ profile: "builtin:inspect", argv: ["sh", "-c", "true"] });
}
