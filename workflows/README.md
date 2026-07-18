## Durable TypeScript workflows

This extension runs reviewed `.flow.ts` definitions as durable, systemd-owned workflows on one
Linux/Btrfs machine. Workflow source uses ordinary strict TypeScript control flow. Effects remain
explicit through the `pi/workflows` API.

Runtime 17 is the only executable runtime. Its SQLite format is schema 4. Schema-3 databases are
immutable legacy evidence: they may be reported by discovery, but cannot resume or replay.

### Installed surfaces

- Model tool `workflow`: launches only definitions exposed as `model` by registry policy.
- Model tool `workflow_draft`: creates, replaces, or validates inert source. It cannot install,
  expose, promote, approve, or execute a draft.
- `/flow`: launch, inspect, control, replay, approve, and promote from the primary session.
- `/goal` and `/execute-plan`: small aliases for the corresponding built-ins.

Only the primary bound session can launch or control runs. A trusted project is required before
project definitions, project policy, project command profiles, or project measurement profiles are
enumerated or used.

### Definitions

Definitions live at:

- built-in: `src/builtins/NAME.flow.ts`
- user: `~/.pi/agent/workflows/NAME.flow.ts`
- trusted project: `<project>/.pi/workflows/NAME.flow.ts`

Each namespace has a strict `registry.json` exposure policy. Missing, malformed, or incomplete
policy is fail-closed and makes definitions human-only. Installed identity comes from namespace and
filename, not authored metadata.

The source language permits erasable TypeScript and exactly one virtual import:

```ts
import { agent, schema as s, workflow } from "pi/workflows";

const summarize = agent({
  profile: "builtin:researcher",
  output: s.object({ summary: s.string() }),
});

export default workflow({
  description: "Summarize one subject.",
  input: s.object({ subject: s.string() }),
  output: s.object({ summary: s.string() }),
  async run(flow, input) {
    const result = await flow.agent(summarize, { prompt: input.subject });
    return { summary: result.output.summary };
  },
});
```

The canonical editor declaration is [`workflow-api.d.ts`](workflow-api.d.ts). Definitions are
strictly typechecked before TypeScript stripping. Static analysis rejects hidden imports, dynamic
authority, recursion, escaping effectful helpers, unsafe captures, unreviewed resource selection,
and candidate-workspace sharing across concurrent lanes.

### Ordinary control flow and durable effects

Branches, loops, helpers, mutation, and `try`/`catch` are ordinary TypeScript. The runtime
re-executes the exact snapshotted source and reconstructs local state by consuming durable effects
in encounter order.

Each sequential scope owns a cursor and causal chain. `flow.parallel` and keyed, bounded `flow.map`
create durable child scopes. Child scopes are preclaimed atomically, output order follows authored
keys, fail-fast cancellation is durable, and joins are structural. Source-site tokens and display
titles do not contribute semantic identity.

Physical effect completion and semantic call completion are separate durable settlements. A crash
between them cannot execute a settled effect twice. Failed effects and apply execute fresh.

Cross-run replay is conservative and causal:

- reuse is lane-local and prefix-only;
- deterministic structural joins bind child outcomes;
- source call keys and results are retained as provenance;
- artifacts and workspace checkpoints are independently verified and imported;
- changed source, resources, metric profiles, or causal ancestry stop reuse;
- apply is never replayed.

`/flow replay RUN` permits causal reuse. `/flow fresh-run RUN` uses the source input but executes
without cross-run reuse.

### Authority and evidence

Descriptors declared with `agent(...)` and `command(...)` are the reviewed authority. Runtime
values for descriptors, artifacts, products, workspaces, candidates, verification, metrics,
measurements, acceptance, and apply are host-owned and nonforgeable.

Every invocation snapshots:

- exact source and executable transform;
- input/output schemas and derived review;
- runtime API identity and registry policy revision;
- launch actor, project trust, and canonical input;
- exact route, tool, command, executor, environment, and selected measurement resources;
- project Btrfs snapshot identity.

Agent, command, verification, measurement, and experiment outputs become canonical immutable
artifacts. Artifact manifests accept only branded artifact leaves/products and validated named
containers; plain JSON lookalikes, cycles, aliases with unsafe names, and path escapes fail closed.

### Candidates and apply

Mutable project work occurs only in a candidate body scope. Candidate callbacks freeze an exact
tree, lineage, write scope, manifest, and diff. Unchanged candidates are discarded automatically.
Changed candidates must receive exactly one disposition before successful completion.

Verification binds the candidate tree and profile. Acceptance binds the exact passed evidence.
Apply requires a durable human challenge and rejects stale project state. Approval changes only the
working tree represented by that exact candidate; rejection remains durable evidence.

### Generic optimization

The optimizer has no hardcoded benchmark and there is no implicit evaluator. The caller selects a
registered, trust-filtered measurement profile and supplies:

- exactly one primary metric;
- optional guardrails and observations;
- sampling policy;
- optimization policy.

The selected profile is resolved before launch and snapshotted with its command, extractors,
environment, output roles, and hash. Workflow code cannot switch profiles at runtime or submit
arbitrary benchmark commands/argv.

### Human suspension and control

`flow.ask(...)` and `flow.apply(...)` create durable waiting interactions with exact challenge
hashes. Responses and decisions are committed as control requests. The run becomes paused after a
human decision and resumes only through an explicit resume request, making the operator boundary
visible and recoverable.

Pause, resume, stop, and stop-effect are durable database requests. The short-lived coordinator
drains requests while systemd owns process lifetime. Stopping settles active attempts, cancels scope
trees, and abandons pending candidate work without erasing evidence.

### Drafts and promotion

Draft revisions are immutable `.flow.ts` files under `~/.pi/agent/workflow-drafts`. Validation is
inert and never invokes `run()`. Human promotion binds the exact draft hash, installed preimage,
derived review, current policy, target exposure, and challenge hash.

Source and `registry.json` are replaced through a fail-closed promotion marker. Discovery is
unavailable while a transaction is incomplete; exact retry can finish the same transaction after a
crash.

### Run storage

Runs live under `~/.pi/agent/workflow-runs/flow_<32 hex>/`:

```text
source.flow.ts
run.sqlite
context/
  invocation.json
  project/
  project-manifest.json
  static-resources.json
sessions/
workspaces/
artifacts/
outputs/
```

`run.sqlite` uses WAL and revision CAS. Global event sequence is presentation order only and never
semantic identity. The database stores scopes, local cursors, operations, structural joins,
settlements, attempts, artifacts, checkpoints, resources, candidates, verification, metric sets,
measurements, experiments, human interactions, controls, and the final result.

### Development

```sh
npm run typecheck
npm run typecheck:flows
npm run typecheck:conformance:v17
npm run test:unit
npm run test:conformance:v17
npm run check
```

The independent oracle remains under `tests/conformance/v17/`. Production tests use real SQLite,
strict source compilation, crash/replay injection, scheduler permutations, malformed authority and
wire values, candidate/apply lifecycle checks, and an end-to-end prepared coordinator.
