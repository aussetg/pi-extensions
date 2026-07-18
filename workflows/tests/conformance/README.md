# Workflow runtime conformance oracle

These fixtures are the executable contract for the native-TypeScript workflow redesign. They are
deliberately independent from the current production runtime so the implementation can be rebuilt
against settled behavior instead of gradually redefining the target.

It contains:

- framework-independent reference models for causal replay, same-run recovery, artifacts, candidate
  lifecycle, helper analysis, and invocation-selected resources;
- the production `pi/workflows` declaration in `workflow-api.d.ts`;
- the pinned runtime/API identity in `src/definition/workflow-language.ts`;
- all six complete target workflows as strict TypeScript compile fixtures;
- positive inference and negative authority checks;
- the consolidated target specification.

The executable oracle currently contains 57 behavioral cases. TypeScript assertions are checked
separately because they are compile-time contracts rather than runtime tests.

Run the executable reference cases:

```bash
npm run test:conformance
```

Compile the target API and workflow corpus:

```bash
npm run typecheck:conformance
```

The normal `npm run check` runs both commands. The runtime declaration is the canonical public
contract. A production implementation may replace model code
with imports from `src/` only after the corresponding behavior exists there. Changing expected
behavior requires an explicit contract decision; tests must not be weakened merely to accommodate an
implementation.

The production TypeScript frontend now exists under `src/definition/workflow-*`. Its own tests
parse all six corpus files, pin exact derived review snapshots, and exercise malformed source with
source locations. The reference models in this directory remain independent: later persistence and
runtime phases must still reproduce them rather than importing away the oracle.

The production persistence substrate exists in `src/persistence/run-database*`.
Its tests use real WAL SQLite to cover root/local cursor identity, caught failure calls,
atomic keyed scope preclaim, completion-order-independent join records, pinned resource integrity,
candidate measurement/verification/disposition/apply state, automatic discard/abandonment, workspace
lane ownership, revision conflicts, and corruption detection.

The production causal identity/replay implementation now exists under
`src/runtime/causal-{identity,replay}.ts`, with bounded artifact and workspace materializers. Real
SQLite tests reproduce the oracle's lane-prefix, scheduler-permutation, map-reorder, structural-join,
failure, apply, result/key provenance, restart, artifact, workspace, and corruption behavior. Fault
tests also restart after
artifact publication, workspace restoration, call commit, and join commit; the independent oracle
remains the contract.

The production cursor engine now exists in `src/runtime/semantic-engine.ts`. It uses scope-local
encounter cursors, durable host settlements, same-run call restoration, recorded failure rethrow,
causal replay before fresh execution, and database-enforced operation/agent admission. Keyed
`parallel`/`map` execution preclaims child scopes, bounds scheduling, preserves output order, supports
fail-fast cancellation and typed collection, restores terminal structures without callback
re-entry, and commits deterministic success/failure joins. Real SQLite tests cover sequential and
structured crash matrices, nested groups, cancellation, map reorder, independent sibling replay,
drift, and no duplicate settled physical execution.

The production control implementation exists under `src/runtime/control-*.*`. It evaluates
the frontend's exact instrumented executable in a hardened child process, reconstructs the virtual
language with control-realm intrinsics, validates reviewed descriptor and operation sites, and uses
explicit product/reference wire variants backed by host WeakMap authority. Production tests load all
six corpus definitions and cover descriptor/product/reference round trips, nested public artifacts,
lookalikes, foreign/revoked authority, callback contexts, synchronous references, source tampering,
protocol/wire limits, cancellation, worker death, runnable-segment runaway, and heap exhaustion.

The production artifact implementation now exists under `src/artifacts/*.ts`. Its store
uses the same immutable body and metadata format as replay; the product factory binds public frozen
agent, command, verification, and measurement values to canonical artifact evidence through the host
authority registry. The recursive manifest and read-only materializer reproduce the independent
artifact oracle for nested/repeated/empty inputs, exact path failures, anti-forgery, and unsafe names.
Production tests additionally cover crash recovery before SQLite admission, binary/file safety,
filesystem tampering, and a complete branded control-wire → manifest → agent-input round trip.

The production effect path exists in `src/runtime/{effect-adapters,executable-runtime}.ts`
and `src/candidates/runtime.ts`. It runs reviewed descriptor calls through static pinned bindings,
canonical products, cursor effects, candidate-body scopes, workspace checkpoints, verification-bound
dispositions, and never-replayed apply. Real SQLite/control-worker tests cover accepted/rejected/
unchanged/pending candidates, schema-invalid human input, stale apply evidence, authority lookalikes,
and restart after candidate freeze without callback re-entry.

The production metric path now exists in `src/measurements/{metric-set,adapter}.ts`. Synchronous
metric-set methods cross a dedicated authority-checked protocol channel; profile execution accepts
only exact static or invocation-pinned resources and binds policy, sampling, executor, environment,
workspace, and candidate authority. metric/measurement/experiment rows reconstruct baseline
and candidate cohorts transactionally with candidate dispositions. Vertical tests cover accepted and
guardrail-rejected experiments, environment drift, runtime profile switching, lookalikes, crash
recovery before both baseline and candidate disposition, profile-revision identity, and causal
baseline replay without evaluator execution. The independent resource/candidate/replay models remain
the contract.

All six corpus definitions also exist unchanged as production `.flow.ts` builtins and are
strictly checked by `typecheck:flows`. End-to-end tests execute each definition through
the control and effect runtime, deliberately crash and reconstruct it, and assert its keyed lanes,
candidate/metric/experiment evidence, dynamic titles, dispositions, and apply result. The optimize
fixture measures a file in the candidate workspace rather than returning a canned sequence.

This vertical pass made two explicit contract refinements. Safe artifact path segments allow ASCII
camelCase names used naturally by TypeScript object keys while continuing to reject traversal and
unsafe punctuation; the independent artifact oracle now covers that case. Completed structured
results may contain attachable branded products, so production persistence uses a validated authority
tree and reconstructs those products without re-entering completed callbacks. Metric control methods
likewise observe only the measurement/disposition prefix encountered in the current reconstruction,
not future durable rows.

The production review/projection path reads coherent evidence into bounded plain
data. It groups operations by root/parallel/map/candidate scopes, preserves dynamic titles and
descriptor identity for display, and projects candidates, verification, measurements, experiments,
dispositions, checkpoints, replay, and apply from native TypeScript control structures.
Research, optimize, goal, and execute-plan have exact renderer snapshots, and every inspector page
uses bounded cursors.

The production authoring/tool path strictly validates inert `.flow.ts`, reports derived authority
and invocation-resource classes, and promotes source plus external model exposure under one
fail-closed recoverable registry transaction. Session-local workflow tool schemas include only
model-exposed definitions and enumerate exact trusted measurement profiles at protected resource
fields. The coordinator is the only installed launcher.
