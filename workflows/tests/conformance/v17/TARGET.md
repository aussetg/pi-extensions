# Target workflow system

This is the normative design exercised by the adjacent conformance fixtures.

## Principle

**TypeScript owns control flow. The workflow runtime owns durable effects, resource scopes, and
structured concurrency.**

Graphs are projections of execution, not source syntax.

## Source form

```ts
import { agent, schema as s, workflow } from "pi/workflows";

const inspect = agent({
  profile: "builtin:reviewer",
  output: Inspection,
});

export default workflow({
  description: "Inspect and decide.",
  input: Input,
  output: Result,

  async run(flow, args) {
    const result = await flow.agent(inspect, { prompt: args.objective });
    if (result.output.done) return result.output;
    // ordinary loops, switch, try/catch, local helpers, and mutation
  },
});
```

- `.flow.ts` permits erasable TypeScript only.
- One exact virtual import is allowed and removed before sandbox execution.
- Filename/registry supplies installed identity and exposure policy.
- Capabilities and invocation-selected resource classes are derived review output.
- Input/output schemas use one small strict facade and infer deeply readonly types.
- Agent/command descriptors are mandatory static authority contracts.

## Public operation surface

Structured concurrency:

```text
parallel   map
```

Durable effects/resources:

```text
agent      command      ask
metrics    measure
candidate  verify       accept       reject
recordExperiment        apply
```

`metrics` is a synchronous run-local policy/state declaration. All other listed methods except
structured callbacks cross the host boundary.

There is no `stage`, `loop`, `fanOut`, condition receipt, operation ID argument, or direct Promise
concurrency.

## Values

- Every agent result has `output`, guaranteed canonical `artifact`, additional `published` evidence,
  and a required workspace `checkpoint` for candidate tasks.
- Every command, measurement, and verification result has a canonical artifact.
- Branded products are directly attachable in named artifact bundles.
- Candidate products expose `output` and `changedPaths` and carry private host authority.
- Accepted products bind exact passed verification/measurement evidence; `apply(accepted)` looks it
  up and rechecks current policy/environment binding.
- Apply always enters exact human approval.

## Deterministic execution

- Every sequential scope owns an encounter cursor.
- Root, candidate bodies, fixed branches, and mapped items are scopes.
- Dynamic parallel keys are the only routine author identity.
- Same-run restart executes exact snapshotted source and restores each encountered operation.
- Native loops reconstruct locals by consuming recorded effects in order.
- Candidate callbacks may mutate local state but not captured outer state; completed candidates
  restore without re-entering callbacks.
- Concurrent callbacks may not mutate captured state or share mutable workspace capability.
- Local effectful helpers are allowed through a finite nonrecursive direct call/effect graph.

## Causal replay

- Each sequential scope is a prefix hash chain.
- Child lane seeds bind the parent prefix and key.
- Structural joins hash lane terminal keys, output order, and failure policy.
- Sibling lane prefixes replay independently.
- A changed join stops later parent-lane reuse.
- Replayed calls retain exact source call keys/results; fresh calls use target-run identity.
- Apply and failed effects execute fresh.

This removes completion-order-dependent global replay without allowing reuse past causal changes.

## Generic optimization

Optimize receives a trusted pinned evaluator and caller-defined policy:

```ts
const metrics = flow.metrics(args.metrics, args.sampling);
await flow.measure(args.evaluator, metrics);

for (let iteration = 0; iteration < args.maxIterations; iteration++) {
  if (metrics.primary.reachedTarget()) break;
  // propose → candidate → measure → evaluate → disposition → reflect
}
```

`s.measurementProfile()` marks a constrained invocation resource. Launch resolves it through the
trusted registry, validates selected output IDs, snapshots exact command/extractor/hash authority,
and permits no profile switching during the run.

One primary metric is structurally required. Guardrails and observed metrics are optional. This is a
single-objective optimizer with constraints, not an underspecified multiobjective algorithm.

## Safety

- The external control-process segment watchdog contains synchronous runaway loops.
- Host operation/agent admission limits contain effectful runaway loops.
- Candidate workspace capabilities are structurally lane-owned.
- Successful completion refuses nonempty undisposed candidates.
- Failure/stop/cancellation abandons pending candidates and finalizes pending measurements rejected.
- Static review derives exact descriptors, profile classes, network, writes, human sites, apply sites,
  dynamic resources, concurrency, and suspicious unbounded loops.
- Runtime still validates every opaque capability, resource snapshot, schema, and semantic hash.

## Feasibility

No control-flow compiler is required.

- Node 22 type stripping preserves source positions.
- Existing Acorn review can be extended for the virtual import, schema/descriptor constructors,
  native loops, and finite helper graph.
- Existing semantic AsyncLocalStorage scopes become cursor scopes.
- Existing parallel/map preclaim and cancellation machinery becomes keyed causal lanes.
- Persistence is rebuilt around lane-local call chains and structural joins.
- Existing control-wire host refs extend to explicit branded product variants.
- Existing finish receipts, artifact store, candidate checkpoints, measurement disposition, and
  acceptance records already provide most value authority.

## Laboratory evidence

- 57 behavioral cases cover replay permutations/faults, same-run crash boundaries, artifacts,
  candidates, helpers, and invocation resources; strict TypeScript checks cover the compile-time
  contract separately.
- Six complete workflows compile with strict TypeScript.
- Target corpus: 1,013 lines; current built-ins: 1,436 lines.
- No target workflow uses structural control APIs, manual operation IDs, result modes, capability
  declarations, casts, ignored type errors, or duplicate hand-written result interfaces.
- The production frontend now strictly typechecks and strip-parses all six fixtures, evaluates their
  schemas/descriptors, derives exact authority/review snapshots, validates helper contexts and native
  loops, and injects non-semantic source-site tokens.
- The separate production v17 registry now discovers `.flow.ts` by namespace/filename, applies
  fail-safe external exposure policy, derives definition identity, validates canonical invocation
  input, pins trusted dynamic measurement resources, and writes independently reconstructable source,
  executable, policy, resource, and language snapshots. The v16 launch/runtime path remains unchanged.
- The separate schema-4 v17 run database now persists immutable run/resource identity, sequential
  scope cursors, keyed child scopes, local calls, structural joins, attempts/checkpoints/artifacts,
  and explicit candidate workspace/measurement/verification/disposition/apply state. Real SQLite
  tests enforce revision CAS, atomic preclaim, completion-order independence, lifecycle termination,
  legacy refusal, and corruption detection.
- The production causal replay importer now validates one explicit schema-4 source, reconstructs
  durable per-scope prefix eligibility, reuses keyed siblings independently, authenticates structural
  joins, retains exact source results/call keys, imports artifact evidence, and restores exact Btrfs
  workspace checkpoints before atomic replay completion. Failed, changed, and `never` calls remain
  fresh. Restart tests cover each materialization/commit boundary.
- The production sequential cursor engine now reruns ordinary control against `{scope, cursor,
  previousCallKey}`, consumes completed calls and durable pre-call settlements, restores failures into
  ordinary catch, rejects semantic drift at the first slot, consults causal replay before fresh host
  execution, and enforces operation/agent admission. Crash-matrix tests cover every sequential
  durable boundary without duplicate settled execution.
- The production structured runtime now preclaims keyed parallel/map scopes atomically, uses bounded
  scheduling plus a run-wide host-effect limiter, preserves target output order, supports fail-fast
  sibling cancellation and typed collected failures, persists deterministic success/failure joins,
  restores completed capture boundaries directly, and reconstructs incomplete lanes from local calls.
  Real-SQLite tests cover nested groups, scheduler timing, cancellation, structural crash boundaries,
  independent sibling replay, map reorder, and semantic-policy drift.
- The production v17 control process now reconstructs the strict schema facade, workflow wrapper,
  reviewed descriptors, flow/source-site wrappers, callbacks, and frozen product/reference views from
  control-realm intrinsics. Explicit wire variants retain host WeakMap authority while rejecting plain
  lookalikes, foreign scopes, revocation, changed identities, malformed messages, and unreviewed
  source sites. Tests load all six definitions and contain memory, wire, callback, cancellation,
  worker-crash, and asynchronous-runaway failures. The path remains isolated before effect adapters
  and runtime cutover.
- The production v17 artifact layer now stores canonical schema-4 bodies/metadata, reconstructs exact
  artifact and attachable-product authority, generates canonical agent/command/verification/
  measurement evidence, and normalizes nested records/arrays into sorted named manifests. Immutable
  agent-input trees validate every digest and reject plain leaves, lookalikes, nonattachable products,
  unsafe segments, cycles, foreign identity, and filesystem tampering. A protocol-17 test exercises a
  whole agent product from host to worker and back through manifest materialization.
- The production v17 effect runtime now connects reviewed control calls to cursor effects. Static
  agent/command/verification bindings are definition-hashed; candidate workspace effects carry exact
  checkpoint authority; `ask` validates response schemas; candidate freeze owns a durable structural
  join; and verification-bound accept/reject/apply restores branded authority from SQLite. Tests cover
  accepted, rejected, unchanged, pending, crashed, forged, and stale-apply paths without weakening the
  independent candidate oracle.
- The production v17 metric runtime now mints unforgeable run-local metric sets, executes only exact
  launch-pinned profiles through a pinned command/environment substrate, persists grouped baseline and
  candidate cohorts, and finalizes state in the same candidate disposition transaction. Dedicated
  synchronous method transport keeps `policy`, `summary`, `reachedTarget`, and `evaluate` host-
  authoritative. Tests cover acceptance, guardrail rejection, environment drift, profile switching,
  crash recovery, experiment evidence, profile revision identity, and causal baseline materialization.
- The exact six-workflow corpus is now installed alongside v16 as staged `.flow.ts` builtins with
  explicit model exposure and its own strict production typecheck. End-to-end tests run and crash-
  reconstruct every builtin through control, effects, candidates, measurements, dispositions, and
  apply. Research/package-audit preserve branded products through completed keyed structures;
  optimize measures candidate-local file contents; goal reconstructs a failed-verification retry;
  execute-plan reconstructs point and replan state.
- Structured result persistence now uses an explicit authority tree when attachable products occur,
  and metric methods use an encounter-local state view. These close two future-evidence leaks found
  only by complete native-control workflows. Safe artifact names now admit ordinary ASCII camelCase
  keys while still rejecting path traversal and unsafe segments.
- The schema-4 projection path now derives review and inspector views from causal scope/operation
  evidence. Keyed lanes, descriptor bindings, dynamic titles, candidates, verification,
  measurements, experiments, dispositions, checkpoints, replay, and apply are bounded plain data;
  four complete builtin renderer snapshots demonstrate that stage/loop syntax is unnecessary.
- The staged v17 draft/tool path now strictly reviews inert `.flow.ts`, binds promotion to source,
  review, policy preimage, and target exposure, and uses a recoverable fail-closed marker to commit
  source plus `registry.json`. Trust-filtered workflow schemas expose only model-visible definitions
  and enumerate exact available measurement profiles. Launch remains deferred to atomic cutover.
