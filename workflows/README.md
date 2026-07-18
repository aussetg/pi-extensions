# Workflows for Pi

`workflows` is a Pi extension for running reviewed TypeScript workflows as durable, named jobs on
one Linux workstation. A workflow uses normal TypeScript for control flow while the runtime owns
effects, persistence, structured concurrency, candidate workspaces, verification, replay, and human
approval.

This is deliberately not a portable or multi-tenant workflow engine. It targets one systemd/Btrfs
host, has no fallback execution paths, and treats the current source tree and storage layout as one
versioned unit. Read [SECURITY.md](SECURITY.md) before allowing workflows to edit a project.

## What the extension adds

| Surface | Purpose |
| --- | --- |
| `workflow` tool | Runs only installed definitions exposed to the model by namespace policy. Its argument schema is built from the exact definitions available when the Pi session starts. |
| `workflow_draft` tool | Creates, compare-and-swap replaces, and validates inert `.flow.ts` drafts. It cannot install, expose, promote, approve, or execute them. |
| `/flow` | Lists and explains definitions; launches, inspects, controls, replays, and deletes runs; reviews and promotes drafts. |
| `/goal OBJECTIVE` | Awaited alias for `/flow run builtin:goal` with `{ "objective": "..." }`. |
| `/execute-plan OBJECTIVE` | Awaited alias for `/flow run builtin:execute-plan` with `{ "objective": "..." }`. |

Six bundled definitions are model-exposed: `coding`, `execute-plan`, `goal`, `optimize`,
`package-audit`, and `research`.

## Requirements

The runtime intentionally fails closed unless all of these are available:

- Linux with cgroup v2 and unprivileged user namespaces;
- a working systemd user manager, `/usr/bin/systemd-run`, and `/usr/bin/systemctl`;
- Btrfs for both the project and `~/.pi/agent/workflow-runs` (or the equivalent
  `PI_CODING_AGENT_DIR` path), on the same filesystem;
- Bubblewrap at `/usr/bin/bwrap`;
- Node.js 22 or newer, available at `/usr/bin/node` for coordinators;
- Pi `0.80.10` and `typebox` `1.1.39`, matching `package.json`;
- enough local space for project snapshots, candidate clones, agent sessions, artifacts, and
  checkpoints.

Workflow commands and verification profiles commonly reference absolute executables such as
`/usr/bin/npm` and `/usr/bin/cargo`. Those paths must exist if a selected profile uses them.

Check the host before the first real run:

```sh
node --version
systemctl --user show-environment >/dev/null
test -r /sys/fs/cgroup/cgroup.controllers
test -x /usr/bin/bwrap
findmnt -no FSTYPE,TARGET --target "$PWD"
findmnt -no FSTYPE,TARGET --target "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
```

## Installation

Install the extension's pinned dependencies in this directory:

```sh
npm ci
npm run check
```

`npm ci` builds the production JavaScript under `dist/`. Pi loads only a tiny TypeScript bootstrap
before a real session, then activates that compiled runtime; coordinator-only modules are not
transpiled through jiti during ordinary startup.

For a one-session test:

```sh
pi -e "$PWD/index.ts"
```

For normal use, keep the complete directory at
`~/.pi/agent/extensions/workflows/` so Pi discovers `index.ts`, or register its absolute directory
as a local package:

```sh
pi install /absolute/path/to/workflows
```

Local package installation records the path; it does not copy the directory. Keep the checkout and
its `node_modules` in place. After editing extension source, run `npm run build` and then `/reload`.

### Model authentication and routing

By default, every agent profile used by a launch is routed to Pi's currently selected model and
thinking level. Pin profile-specific routes in `~/.pi/agent/workflow-routes.json`:

```json
{
  "routes": {
    "builtin:researcher": {
      "model": "openai-codex/gpt-5.4-mini",
      "thinking": "low"
    },
    "builtin:implementer": {
      "model": "anthropic/claude-sonnet-4-5",
      "thinking": "high"
    }
  }
}
```

The model value is an exact `provider/model` identifier and must be available in the current Pi
model registry. Valid thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and
`max`. Unspecified profiles retain the current-model default.

Agent workers can use Pi's `auth.json` and `models.json`, plus a bounded set of provider environment
variables forwarded by the coordinator. Mediated Kagi tools read `PI_WORKFLOW_KAGI_API_KEY`, falling
back to `KAGI_API_KEY` when the coordinator starts.

## Quick start

Inspect what is installed and the exact input contract before launching:

```text
/flow list
/flow explain builtin:research
/flow run builtin:research --args '{"question":"How does this repository persist state?"}'
```

Other common launches:

```text
/goal Find and explain the root cause of the flaky test
/execute-plan Implement the accepted parser cleanup and run the relevant checks
/flow run builtin:coding --args '{"objective":"Add coverage for empty input"}'
/flow run builtin:package-audit --args '{"packages":[{"id":"core","path":"packages/core"}]}'
```

Workflow names may omit the namespace only when the name is unambiguous. Prefer exact IDs such as
`builtin:research` in scripts and long-lived instructions.

### Awaited and background launches

`/flow run`, `/flow replay`, and `/flow fresh-run` default to `--await`.

- **Awaited** waits until the run becomes `waiting`, `paused`, `completed`, `failed`, or `stopped`.
  A human handoff therefore returns control without pretending the workflow is finished.
- **Background** (`--async`) returns after launch, keeps running under systemd, and posts one
  completion notification to the launching Pi session. It is available only in TUI and RPC modes.
- Closing or reloading Pi removes presentation polling only. It does not stop systemd-owned runs.

Use these commands to inspect and control a run. `RUN` may be a full ID or an unambiguous hexadecimal
prefix of at least four characters.

```text
/flow status
/flow status RUN
/flow open RUN
/flow pause RUN
/flow resume RUN
/flow stop RUN
/flow stop-effect RUN OPERATION
```

`/flow open` opens the paged inspector in TUI mode. In RPC, JSON, and print modes, `/flow` emits a
bounded protocol envelope instead of constructing terminal UI.

### Human questions and apply approval

`flow.ask()` and `flow.apply()` create durable interactions and put the run in `waiting`. In TUI
mode:

```text
/flow respond RUN
/flow approve RUN
/flow reject RUN
/flow resume RUN
```

The response or decision is committed first, then the run becomes `paused`. An explicit
`/flow resume` makes the human boundary visible and prevents an approval from silently restarting
execution.

Outside TUI mode, the first `respond`, `approve`, or `reject` request returns a challenge token.
Repeat the command with that exact token; ask responses also require JSON:

```text
/flow respond RUN --challenge sha256:... --value '{"action":"continue","guidance":"..."}'
/flow approve RUN --challenge sha256:...
/flow resume RUN
```

Stale challenges are rejected.

## Bundled workflows

| ID | Input summary | Behavior |
| --- | --- | --- |
| `builtin:research` | `question`; optional keyed `angles` | Researches up to eight angles with collected failures, synthesizes the evidence, adversarially critiques it, and revises if needed. Read-only. |
| `builtin:package-audit` | One to twelve `{ id, path }` packages | Inventories regular files and concurrently produces package risks and test plans, then synthesizes portfolio priorities. Read-only. |
| `builtin:coding` | `objective` | Runs three read-only inspections, creates one candidate, verifies it with `builtin:coding`, and requests exact approval before apply. |
| `builtin:goal` | `objective` | Pursues open-ended read-only handoffs, moves to bounded candidate workers when mutation is needed, asks on blockers, retries failed verification, and applies only accepted work. |
| `builtin:execute-plan` | `objective` | Produces stable sequential plan points, executes them in one candidate, supports bounded replanning, asks what to do with blocked partial work, verifies, and applies. |
| `builtin:optimize` | Objective, write paths, evaluator, metric policy; optional sampling and iteration limit | Establishes a baseline, measures caller-selected experiments, rejects regressions, verifies acceptable candidates, retains the accepted best candidate, and requests approval before apply. |

The exact schemas are part of each definition. Use `/flow explain ID`; do not treat this table as a
replacement for schema inspection. `builtin:coding`, `goal`, `execute-plan`, and `optimize` require a
usable `builtin:coding` verification profile. The runtime creates that profile only when it can
conservatively discover both tests and diagnostics:

- `package.json` has a `test` script and at least one of `typecheck`, `check`, or `lint`; or
- the project has `Cargo.toml`, enabling `cargo test` and `cargo check`.

There are no bundled measurement profiles. `builtin:optimize` must receive an exact trusted user or
project measurement profile exposed in its launch schema.

## Definitions and exposure policy

Definitions are discovered from three namespaces:

| Namespace | Directory | Trust |
| --- | --- | --- |
| `builtin` | `src/builtins/*.flow.ts` | Shipped with the extension. |
| `user` | `~/.pi/agent/workflows/*.flow.ts` | Available to all projects. |
| `project` | `<project>/.pi/workflows/*.flow.ts` | Available only after Pi trusts the project. |

`PI_CODING_AGENT_DIR` replaces `~/.pi/agent` for user storage. The project root is the nearest
ancestor containing `.git` or Pi's project config directory; if neither exists, the current working
directory is used.

Installed identity is `namespace:filename`, not authored metadata. A file named
`release.flow.ts` becomes `user:release` or `project:release`. Names must match
`^[a-z][a-z0-9_-]{0,63}$`.

Each workflow directory may contain one strict `registry.json`:

```json
{
  "model": ["release", "triage"]
}
```

- Entries in `model` are callable by the model-facing `workflow` tool.
- Valid installed definitions omitted from `model` remain human-callable through `/flow`.
- A missing policy means every definition in that namespace is human-only.
- Unknown fields, duplicate names, unsafe files, missing named definitions, or an interrupted
  promotion are reported by `/flow list` and fail closed for model exposure.

Project definitions, profiles, and drafts are not enumerated or used until `ctx.isProjectTrusted()`
is true. Promotion refreshes `/flow` discovery immediately, but the model tool's union schema is
session-local. Run `/reload` before expecting a newly model-exposed workflow or measurement profile
to appear to the model.

## Authoring `.flow.ts`

Workflow source is strict, erasable TypeScript with exactly one virtual module:

```ts
import { agent, schema as s, workflow } from "pi/workflows";

const Finding = s.object({
  summary: s.string({ minLength: 1, maxLength: 4_000 }),
  paths: s.array(s.safePath(), { maxItems: 64 }),
});

const inspect = agent({
  profile: "builtin:reviewer",
  output: Finding,
});

export default workflow({
  description: "Inspect one objective without changing the project.",
  input: s.object({
    objective: s.string({ minLength: 1, maxLength: 20_000 }),
  }),
  output: Finding,

  async run(flow, input) {
    const result = await flow.agent(inspect, {
      prompt: input.objective,
    });
    return result.output;
  },
});
```

`workflow-api.d.ts` is the canonical editor and compiler contract. Validation first performs strict
TypeScript checking, strips types, parses the resulting JavaScript, and derives a static authority
review. Validation never invokes `run()`.

### Source rules

- Use one default `workflow({...})` export and the exact `pi/workflows` import.
- Imports, ambient filesystem/process/network access, dynamic code generation, workflow launching,
  clocks, and randomness are unavailable to workflow code.
- Agent and command descriptors must be statically declared reviewed contracts.
- Ordinary branches, bounded loops, local helpers, mutation, and `try`/`catch` are supported.
- Effectful helpers must form a finite, nonrecursive call graph. Direct unstructured promise
  concurrency is rejected; use keyed `flow.parallel()` or `flow.map()`.
- Concurrent callbacks cannot mutate captured outer state or share a mutable candidate workspace.
- Runtime values representing artifacts, candidates, workspaces, verifications, measurements, and
  acceptance are host-owned capabilities, not forgeable JSON shapes.

The schema facade provides `string`, `number`, `integer`, `boolean`, `literal`, `enum`, `nullable`,
`optional`, `array`, `object`, `union`, `record`, `id`, `safePath`, `json`,
`measurementProfile`, and `raw`. Inferred inputs and outputs are deeply read-only.

### Descriptors

`agent({...})` fixes:

- a user, project, or built-in semantic profile;
- the admitted output schema;
- `snapshot` or `candidate` workspace authority;
- `none` or mediated `research` network authority;
- optional reviewed instructions and display title.

`command({...})` fixes a command profile, output mode (`summary`, `text`, or `json`), effect
(`read-only`, `temporary`, or `candidate`), failure policy, and optional title. Runtime arguments can
only fill whole reviewed argv tokens; they never select an executable or pass through a shell.

### Runtime operations

| Operation | Meaning |
| --- | --- |
| `flow.agent` | Runs a pinned profile/model/tool set against the launch snapshot or one candidate workspace. Success requires a validated `finish_work` receipt. |
| `flow.command` | Runs a pinned argv profile in a networkless Bubblewrap/systemd service. |
| `flow.parallel` | Runs a statically named object of keyed child lanes with bounded concurrency. |
| `flow.map` | Runs items in keyed child lanes, preserves authored output order, and supports fail-fast or collected errors. |
| `flow.ask` | Suspends for a schema-validated human response. |
| `flow.candidate` | Opens a disposable writable clone, optionally based on an accepted candidate and restricted by write paths, then freezes its exact tree and diff. |
| `flow.verify` | Runs pinned tests, diagnostics, diff inspection, contamination checks, and optional adversarial review over the frozen candidate. |
| `flow.accept` / `flow.reject` | Gives a changed candidate exactly one evidence-bound disposition. |
| `flow.metrics` / `flow.measure` | Declares one primary metric plus optional guardrails/observations, then samples a pinned measurement profile. |
| `flow.recordExperiment` | Stores the measured hypothesis and lesson as durable evidence. |
| `flow.apply` | Requests human approval and applies only an accepted, current, unchanged candidate. |

Agent, command, verification, and measurement results include canonical artifacts. Agent calls may
also publish bounded artifacts. Artifact references and branded products can be nested in named
artifact inputs for later operations.

Changed candidates must be accepted or rejected before successful completion. Unchanged candidates
are discarded automatically. On failure, stop, or cancellation, pending candidates are abandoned
and pending measurements are finalized as rejected.

## Profiles and pinned resources

Resource selectors use `builtin:name`, `user:name`, or `project:name`. Omitting a namespace is allowed
only when the name is unambiguous.

| Resource | User location | Trusted project location | Format |
| --- | --- | --- | --- |
| Agent profiles | `~/.pi/agent/agents/NAME.md` | `.pi/agents/NAME.md` | Markdown body with strict `name`, `description`, optional `title` and `tools` frontmatter. |
| Command profiles | `~/.pi/agent/commands/NAME.json` | `.pi/commands/NAME.json` | Fixed argv template, typed arguments, env, timeout, output limit, and allowed effects. |
| Verification profiles | `~/.pi/agent/verifications/NAME.json` | `.pi/verifications/NAME.json` | Tests, diagnostics, diff policy, adversarial review, and optional scratch paths. |
| Measurement profiles | `~/.pi/agent/measurements/NAME.json` | `.pi/measurements/NAME.json` | Fixed argv, timeout, optional CPU affinity/env, numeric output extractors, and optional diagnostics. |

Every filename must match its declared `name`. Registries reject symlinked roots/files, duplicates,
unknown fields, oversized values, and malformed profiles.

Agent profiles may only narrow this fixed tool vocabulary:

```text
read grep find ls
edit write delete_file workspace_command
web_search web_fetch
```

Actual tools are the intersection of profile policy, descriptor workspace/network authority, and the
executor's fixed schemas. `workspace_command` is always a separate networkless argv sandbox.

Command profile argv token substitution is deliberately small. For example:

```json
{
  "name": "line-count",
  "description": "Count lines in one project-relative file.",
  "argv": ["/usr/bin/wc", "-l", "${path}"],
  "arguments": {
    "path": { "type": "project-path" }
  },
  "timeoutMs": 30000,
  "outputLimitBytes": 1048576,
  "effects": ["read-only"]
}
```

Measurement profiles support numeric extraction by restricted JSON path, regular expression, or the
measurement protocol. Protocol extraction cannot be mixed with JSON-path or regex extraction in one
profile. `s.measurementProfile()` causes launch input to enumerate only trust-filtered exact profile
IDs and snapshot the selected profile before execution.

## Draft review and promotion

Draft revisions live under `~/.pi/agent/workflow-drafts`. User drafts are global; project drafts are
bound to the canonical project root and require project trust.

The model can stage source safely:

1. `workflow_draft { action: "create", namespace, name, source }`
2. `workflow_draft { action: "validate", namespace, name }`
3. `workflow_draft { action: "replace", ..., expectedDraftHash, source }`

Replacement is compare-and-swap: the exact current source hash is required. Revisions are immutable
and content-addressed; a small head record selects the current revision.

Only a human can promote:

```text
/flow drafts
/flow drafts user:my-workflow
/flow validate user:my-workflow
/flow promote user:my-workflow --exposure human
/flow promote user:my-workflow --exposure model
/flow discard-draft user:my-workflow --expected-hash sha256:...
```

Promotion binds the draft hash, installed preimage, derived review, current registry policy, target
exposure, and challenge. TUI asks for confirmation. Non-TUI callers must repeat the command with the
returned `--challenge` hash. Source and `registry.json` are committed through a recoverable
fail-closed marker; exact retry finishes the same interrupted promotion. A successful promotion
consumes the draft.

## Durability, replay, and storage

TypeScript control flow is re-executed from the exact snapshotted source. Each sequential scope owns
an encounter cursor and causal hash chain. Previously settled calls reconstruct local state in order;
keyed parallel/map lanes have independent cursors and deterministic structural joins. A crash after a
physical effect settles but before its semantic call settles does not repeat that effect.

Explicit replay creates a new run:

```text
/flow replay SOURCE_RUN
/flow replay SOURCE_RUN --args '{"question":"revised input"}'
/flow fresh-run SOURCE_RUN
```

- `replay` attempts conservative, lane-local, prefix-only reuse from one source run.
- Changed source, arguments, resources, artifacts, workspace authority, causal ancestry, or joins
  stop reuse at the affected prefix.
- Completed mutating calls import and verify their exact workspace checkpoint before reuse.
- Failed, incomplete, and explicitly nonreplayable calls execute again. Apply is never replayed.
- The source run must belong to the same canonical project, and the currently installed workflow ID
  must still resolve.
- `fresh-run` reuses the source input by default but disables cross-run reuse.

Runs are stored under `~/.pi/agent/workflow-runs/flow_<32 hex>/`:

```text
source.flow.ts
run.sqlite
context/
  invocation.json
  project/
  project-manifest.json
  static-resources.json
  replay.json                 # replay runs only
sessions/
workspaces/
  candidates/
  checkpoints/
artifacts/
outputs/
```

SQLite uses WAL, foreign keys, full synchronization, short `BEGIN IMMEDIATE` transactions, and
revision compare-and-swap. The database is the mutable authority; filesystem bodies are admitted by
exact records and digests.

Terminal run evidence is retained until explicitly deleted:

```text
/flow delete RUN
```

Deletion requires a terminal run, an inactive coordinator, and exact human confirmation/challenge.
There is no automatic retention policy or schema migration. Back up evidence you need before
updating or rebuilding this private extension.

## Limits and performance

Important hard bounds include:

- 512 KiB workflow source and 128 definitions per namespace;
- 256 parallel branches or map items, maximum authored concurrency 64;
- 10,000 semantic operations and 1,000 agent launches per run;
- 50,000 project files, 512 MiB per file, and 4 GiB total semantic project bytes;
- 10,000 changed candidate paths;
- 64 artifact leaves per operation input bundle;
- default run-wide physical effect concurrency 4;
- 2 GiB memory, 256 tasks, 400% CPU quota, 64 MiB command output, and a 10-minute host command
  ceiling for normal run effects.

Snapshot capture is O(visible paths + bytes read for hashing). Candidate clone/checkpoint creation
uses Btrfs reflinks, but freeze, restore, verification, and apply intentionally rescan and hash trees.
Those scans are authority checks, not optional cache overhead. Commands also pay for one transient
systemd service and Bubblewrap namespace.

Registry refresh always rereads and hashes workflow source, the public API declaration, and exposure
policy. A bounded process-local cache reuses frozen frontend results only when the exact source,
installed filename, API declaration, TypeScript version/options, runtime API, and explicit
frontend/analyzer revision match. Filesystem mtimes are never cache authority.

The production entry registers only a session bootstrap. It loads the compiled primary runtime when
a real session starts, while coordinator and agent worker implementations remain isolated behind
their physical service entries.

One local five-file production trial on 2026-07-16 observed 7.1 ms median snapshot capture,
34.6 ms candidate creation, 39.0 ms checkpoint creation, and 219 ms median for a transient systemd +
Bubblewrap `/usr/bin/true`. A fresh research run took 122.6 s while full-prefix replay took 2.59 s.
These measurements describe one machine and are not performance promises.

## Development and verification

```sh
npm run build
npm run typecheck
npm run typecheck:flows
npm run typecheck:conformance
npm run test:unit
npm run test:conformance
npm run check
```

`npm run check` runs strict extension typechecking, the public workflow declaration and built-in
corpus, the independent conformance type fixtures, production unit/integration tests, and the
independent executable oracle. Tests cover real SQLite, systemd/Bubblewrap/Btrfs fixtures where
available, crash/restart boundaries, scheduler permutations, malformed authority values, replay,
candidate/apply lifecycle, measurements, projections, and draft promotion.
