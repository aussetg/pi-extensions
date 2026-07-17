# Workflow runtime v17 conformance oracle

These fixtures are the executable contract for the native-TypeScript workflow redesign. They are
deliberately independent from the current production runtime so the implementation can be rebuilt
against settled behavior instead of gradually redefining the target.

It contains:

- framework-independent reference models for causal replay, same-run recovery, artifacts, candidate
  lifecycle, helper analysis, and invocation-selected resources;
- the production `pi/workflows` declaration in `workflow-api.d.ts`;
- the pinned runtime/API identity in `src/definition/workflow-language-v17.ts`;
- all six complete target workflows as strict TypeScript compile fixtures;
- positive inference and negative authority checks;
- the consolidated target specification.

The executable oracle currently contains 56 behavioral cases. TypeScript assertions are checked
separately because they are compile-time contracts rather than runtime tests.

Run the executable reference cases:

```bash
npm run test:conformance:v17
```

Compile the target API and workflow corpus:

```bash
npm run typecheck:conformance:v17
```

The normal `npm run check` runs both commands. The v17 declaration is now the canonical public
contract; the separate `workflow-api-v16.d.ts` exists only to typecheck the old runtime until the
atomic cutover. A production implementation may replace model code
with imports from `src/` only after the corresponding behavior exists there. Changing expected
behavior requires an explicit contract decision; tests must not be weakened merely to accommodate an
implementation.

The production TypeScript frontend now exists under `src/definition/workflow-v17-*`. Its own tests
parse all six corpus files, pin exact derived review snapshots, and exercise malformed source with
source locations. The reference models in this directory remain independent: later persistence and
runtime phases must still reproduce them rather than importing away the oracle.

The separate production v17 persistence substrate now exists in `src/persistence/run-database-v17*`.
Its schema-4 tests use real WAL SQLite to cover root/local cursor identity, caught failure calls,
atomic keyed scope preclaim, completion-order-independent join records, pinned resource integrity,
candidate measurement/verification/disposition/apply state, automatic discard/abandonment, workspace
lane ownership, revision conflicts, legacy-version refusal, and corruption detection. It remains
unwired from v16 launch and execution.

The production causal identity/replay implementation now exists under
`src/runtime/causal-{identity,replay}-v17.ts`, with bounded artifact and workspace materializers. Real
SQLite tests reproduce the oracle's lane-prefix, scheduler-permutation, map-reorder, structural-join,
failure, apply, result/key provenance, restart, artifact, workspace, and corruption behavior. Fault
tests also restart after
artifact publication, workspace restoration, call commit, and join commit; the independent oracle
remains the contract.

The production cursor engine now exists in `src/runtime/semantic-engine-v17.ts`. It uses scope-local
encounter cursors, durable host settlements, same-run call restoration, recorded failure rethrow,
causal replay before fresh execution, and database-enforced operation/agent admission. Keyed
`parallel`/`map` execution preclaims child scopes, bounds scheduling, preserves output order, supports
fail-fast cancellation and typed collection, restores terminal structures without callback
re-entry, and commits deterministic success/failure joins. Real SQLite tests cover sequential and
structured crash matrices, nested groups, cancellation, map reorder, independent sibling replay,
drift, and no duplicate settled physical execution.

The separate v17 control implementation now exists under `src/runtime/control-*-v17.*`. It evaluates
the frontend's exact instrumented executable in a hardened child process, reconstructs the virtual
language with control-realm intrinsics, validates reviewed descriptor and operation sites, and uses
explicit product/reference wire variants backed by host WeakMap authority. Production tests load all
six corpus definitions and cover descriptor/product/reference round trips, nested public artifacts,
lookalikes, foreign/revoked authority, callback contexts, synchronous references, source tampering,
protocol/wire limits, cancellation, worker death, runnable-segment runaway, and heap exhaustion. It
remains unwired from the v16 coordinator pending effect adapters.

The production artifact implementation now exists under `src/artifacts/*-v17.ts`. Its schema-4 store
uses the same immutable body and metadata format as replay; the product factory binds public frozen
agent, command, verification, and measurement values to canonical artifact evidence through the host
authority registry. The recursive manifest and read-only materializer reproduce the independent
artifact oracle for nested/repeated/empty inputs, exact path failures, anti-forgery, and unsafe names.
Production tests additionally cover crash recovery before SQLite admission, binary/file safety,
filesystem tampering, and a complete branded control-wire → manifest → agent-input round trip.

The staged production effect path now exists in `src/runtime/{effect-adapters,executable-runtime}-v17.ts`
and `src/candidates/runtime-v17.ts`. It runs reviewed descriptor calls through static pinned bindings,
canonical products, cursor effects, candidate-body scopes, workspace checkpoints, verification-bound
dispositions, and never-replayed apply. Real SQLite/control-worker tests cover accepted/rejected/
unchanged/pending candidates, schema-invalid human input, stale apply evidence, authority lookalikes,
and restart after candidate freeze without callback re-entry. It remains separate from the v16
coordinator.

The production metric path now exists in `src/measurements/{metric-set,adapter}-v17.ts`. Synchronous
metric-set methods cross a dedicated authority-checked protocol channel; profile execution accepts
only exact static or invocation-pinned resources and binds policy, sampling, executor, environment,
workspace, and candidate authority. Schema-4 metric/measurement/experiment rows reconstruct baseline
and candidate cohorts transactionally with candidate dispositions. Vertical tests cover accepted and
guardrail-rejected experiments, environment drift, runtime profile switching, lookalikes, crash
recovery before both baseline and candidate disposition, profile-revision identity, and causal
baseline replay without evaluator execution. The independent resource/candidate/replay models remain
the contract.

All six corpus definitions now also exist unchanged as staged production `.flow.ts` builtins and are
strictly checked by `typecheck:flows:v17`. End-to-end schema-4 tests execute each definition through
the v17 control and effect runtime, deliberately crash and reconstruct it, and assert its keyed lanes,
candidate/metric/experiment evidence, dynamic titles, dispositions, and apply result. The optimize
fixture measures a file in the candidate workspace rather than returning a canned sequence.

This vertical pass made two explicit contract refinements. Safe artifact path segments allow ASCII
camelCase names used naturally by TypeScript object keys while continuing to reject traversal and
unsafe punctuation; the independent artifact oracle now covers that case. Completed structured
results may contain attachable branded products, so production persistence uses a validated authority
tree and reconstructs those products without re-entering completed callbacks. Metric control methods
likewise observe only the measurement/disposition prefix encountered in the current reconstruction,
not future durable rows.

The staged production review/projection path now reads coherent schema-4 evidence into bounded plain
data. It groups operations by root/parallel/map/candidate scopes, preserves dynamic titles and
descriptor identity for display, and projects candidates, verification, measurements, experiments,
dispositions, checkpoints, replay, and apply without introducing authored stage/loop structures.
Research, optimize, goal, and execute-plan have exact renderer snapshots, and every inspector page
uses bounded cursors.

The separate v17 authoring/tool path strictly validates inert `.flow.ts`, reports derived authority
and invocation-resource classes, and promotes source plus external model exposure under one
fail-closed recoverable registry transaction. Session-local workflow tool schemas include only
model-exposed definitions and enumerate exact trusted measurement profiles at protected resource
fields. The v16 coordinator remains the only launcher until cutover.
