# Workflows

Durable named workflows for Pi. A reviewed JavaScript definition describes deterministic control
flow; one coordinator owns each run; agents and host effects return through typed receipts. The
primary Pi session launches and controls runs but does not own their lifetime.

> **v17 implementation branch:** the canonical future authoring contract is now
> [`workflow-api.d.ts`](workflow-api.d.ts), with its pinned language identity in
> [`src/definition/workflow-language-v17.ts`](src/definition/workflow-language-v17.ts). The executable
> runtime and the authoring documentation below remain v16 until the atomic cutover; their temporary
> declaration is [`workflow-api-v16.d.ts`](workflow-api-v16.d.ts). The isolated v17 frontend now
> strictly typechecks, strips, reviews, and instruments `.flow.ts` source. A separate production v17
> registry now discovers those definitions, applies fail-safe namespace exposure policy, and writes
> immutable invocation/source/resource snapshots. A separate schema-4 v17 run database now persists
> scope-local cursors, keyed child scopes, structural joins, pinned resources, and explicit candidate
> lifecycle state. The v16 launch service and executable runtime consume neither staged path yet.

This extension is intentionally local and Linux-only. It has no compatibility layer for old run or
definition formats and no portability fallback.

## Host requirements

- Node 22 or newer, including `node:sqlite` and TypeScript type stripping
- a systemd user manager on cgroup v2
- Btrfs, with the project and workflow run root on the same filesystem
- `/usr/bin/bwrap`, `/usr/bin/systemd-run`, and `/usr/bin/systemctl`
- unprivileged user namespaces

On Arch/CachyOS, the non-base package is:

```bash
sudo pacman -S bubblewrap
```

The extension deliberately fails when these assumptions are not met. Project snapshots and
candidate checkpoints require reflinks; commands never fall back to an uncontained process.

## Public surface

The model receives two tools:

- `workflow({ name, args, mode? })` launches an installed definition. It cannot provide source,
  choose a model or tools, inject a command, or approve an apply.
- `workflow_draft({ action, namespace, name, source?, expectedDraftHash? })` creates, replaces, or
  validates inert source. It cannot install that source.

`mode` is `await` by default and may be `async` in TUI/RPC sessions. Async completion appends one
bounded notification to the primary session.

The human command surface is:

```text
/flow list [--active] [--namespace builtin|user|project]
/flow explain NAME
/flow run NAME [--await|--async] [--args JSON]
/flow status [RUN]
/flow open RUN
/flow pause RUN
/flow resume RUN
/flow stop RUN
/flow stop-effect RUN OPERATION
/flow respond RUN [CHECKPOINT] [--challenge HASH] [--value JSON_OR_CHOICE]
/flow approve RUN [--challenge HASH]
/flow reject RUN [--challenge HASH]
/flow replay RUN [--await|--async] [--args JSON]
/flow fresh-run RUN [--await|--async] [--args JSON]
/flow drafts [user:NAME|project:NAME] [--namespace user|project]
/flow validate user:NAME|project:NAME
/flow promote user:NAME|project:NAME [--challenge HASH]
/flow discard-draft user:NAME|project:NAME [--expected-hash HASH]
/flow delete RUN [--challenge HASH]
```

`/goal TEXT` and `/execute-plan TEXT` are only friendly parsers for `builtin:goal` and
`builtin:execute-plan`. They use the same registry, launch path, database, coordinator, and UI as
`/flow run`.

## Built-ins

| Name | Input summary | Purpose |
| --- | --- | --- |
| `builtin:research` | `question`, optional `angles` | Parallel source gathering, synthesis, and critique |
| `builtin:package-audit` | `packages` | Concurrent package inventory, risk review, and test planning |
| `builtin:coding` | `objective` | Candidate implementation, verification, approval, and apply |
| `builtin:optimize` | `objective`, `writePaths` | Measured candidate experiments and verified apply |
| `builtin:goal` | `objective` | Fresh-agent handoffs with optional shared candidate work |
| `builtin:execute-plan` | `objective` | Structured planning and sequential candidate point work |

Use `/flow explain NAME` for the exact input/output schemas and derived authority summary.

## Authoring

Definitions are ordinary `.flow.js` files:

- user: `~/.pi/agent/workflows/NAME.flow.js`
- trusted project: `<project>/.pi/workflows/NAME.flow.js`

The filename must match `name`. Namespace-qualified selectors (`user:name`, `project:name`) avoid
ambiguity. Project definitions and profiles are ignored until Pi marks the project trusted.

```js
const answerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "sources"],
  properties: {
    answer: { type: "string", minLength: 1, maxLength: 12000 },
    sources: {
      type: "array",
      maxItems: 32,
      items: { type: "string", minLength: 1, maxLength: 2000 },
    },
  },
};

export default defineWorkflow({
  name: "answer-question",
  description: "Research and answer one question.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["question"],
    properties: { question: { type: "string", minLength: 1, maxLength: 20000 } },
  },
  outputSchema: answerSchema,
  capabilities: ["read-project", "mediated-network"],
  modelVisible: true,
  maxParallelism: 2,
  async run(flow, args) {
    return await flow.agent("research", {
      profile: "builtin:researcher",
      prompt: `Answer with primary sources: ${args.question}`,
      network: "research",
      outputSchema: answerSchema,
    });
  },
});
```

The available operations are:

```text
flow.stage       flow.loop          flow.parallel      flow.fanOut
flow.agent       flow.command       flow.checkpoint    flow.measure
flow.candidate   flow.verify        flow.accept        flow.reject
flow.recordExperiment               flow.apply
```

Operation IDs, profile selectors, command selectors, and authority-bearing options must be
statically reviewable. The parser rejects imports, ambient Node access, clocks, random values,
dynamic operation identity, code generation, and undeclared authority. A definition may request
less parallelism than the machine ceiling, never more. A running workflow cannot launch another
workflow.

The current v16 editor contract is [`workflow-api-v16.d.ts`](workflow-api-v16.d.ts). Built-ins under
[`src/builtins/`](src/builtins/) are complete examples and are checked with
`npm run typecheck:flows`.

### Drafts and promotion

Agent- or user-authored text follows draft → validate → exact human promotion. Validation performs
static parsing, schema compilation, profile/route resolution, authority derivation, operation-count
analysis, and a definition-only control load. It launches no workflow effects.

Promotion binds the draft source hash, target namespace/path, installed preimage, and review hash.
Changing either the draft or installed file invalidates the challenge. TUI promotion uses a human
confirmation; RPC/headless use a two-step exact challenge.

### Agent profiles and routes

Semantic profiles live in `~/.pi/agent/agents/*.md` or trusted
`<project>/.pi/agents/*.md`. They describe role and maximum tool policy only:

```md
---
name: dependency-auditor
description: Reviews dependency and supply-chain risk
tools: [read, grep, find, ls, web_search, web_fetch]
---
Inspect the supplied project snapshot and artifacts. Cite exact paths and primary URLs.
```

Exact provider routing is machine policy in `~/.pi/agent/workflow-routes.json`:

```json
{
  "formatVersion": 1,
  "routes": {
    "user:dependency-auditor": {
      "model": "anthropic/claude-sonnet-4",
      "thinking": "medium"
    }
  }
}
```

Local routes override the current Pi model defaults and are snapshotted at launch. Credential
contents are neither semantic identity nor persisted evidence.

Agents receive the intersection of their profile policy, operation authority, and the fixed host
catalog. Inspection, candidate editing, mediated research, and workspace commands are independent
sets, so a candidate agent may also receive mediated research. Raw workspace commands always run
without network.

Agent completion requires a valid, durably acknowledged `finish_work` call. `report_progress`,
`log_result`, and `publish_artifact` update evidence and projections while the agent runs. Assistant
text is evidence only. After a clean yield without a finish receipt, the same Pi session is reopened
with one fixed protocol reminder. Three consecutive non-progressing yields pause the operation.

### Command profiles

User command profiles are `~/.pi/agent/commands/*.json`; trusted project profiles are
`<project>/.pi/commands/*.json`. Workflow source names a profile and supplies only declared scalar
arguments. A placeholder occupies a complete argv token; no shell parses it.

```json
{
  "name": "focused-check",
  "description": "Run one reviewed check target",
  "argv": ["/usr/bin/node", "scripts/check.mjs", "${suite}"],
  "arguments": {
    "suite": { "type": "string", "enum": ["unit", "integration"] }
  },
  "timeoutMs": 30000,
  "outputLimitBytes": 1048576,
  "effects": ["read-only", "temporary", "candidate"]
}
```

Every command runs as argv in Bubblewrap inside a transient systemd service. Read-only commands see
the immutable snapshot, temporary commands get a discarded tmp-overlay, and candidate commands bind
only the candidate tree. Stdout/stderr are bounded and overflow is retained as artifact evidence.

### Measurement and verification profiles

Measurement profiles live under `measurements/` and verification profiles under `verifications/`
in the same user/project configuration roots. Both are strict JSON and own their exact argv,
environment, timeouts, extractors, and gate policy. Workflow arguments cannot supply profile bodies
or raw commands.

Measurements support protocol, JSON-path, and regex extraction, grouped samples, CPU affinity,
primary/guardrail metric policy, and cgroup/pressure diagnostics. Verification binds ordered tests,
diagnostics, diff policy, adversarial review, candidate tree/lineage/write scope, project snapshot,
and environment evidence.

## Persistence and recovery

The staged v17 registry uses `registry.json` beside each namespace's definitions. Its strict shape is
`{"formatVersion":1,"model":["explicitly-exposed-name"]}`; absent names are human-only. Exposure is
snapshotted at launch but excluded from executable definition identity. The staged v17 invocation
writer records the original `.flow.ts`, reviewed executable JavaScript, exact frontend transform,
language descriptor, policy revision, launch actor/trust, and invocation-selected measurement
profile snapshots.

The staged v17 `run.sqlite` is a clean schema-4 rebuild. A root, candidate body, parallel branch, or
mapped item is one sequential scope with its own cursor and call chain. Global operation ordinals are
retained only for event/UI ordering. Child scopes bind their owner operation, lane key, and seed;
structural join rows bind exact output order and every child terminal key. Invocation resource rows
store the exact launch snapshot rather than selectors into a live registry. Candidate workspaces,
frozen authority, changed paths, pending measurement, verification, one disposition, and apply receipt
are separate constrained records. Completion discards unchanged candidates, rejects changed pending
candidates, and failure/stop abandons work and rejects pending measurements atomically. Schema-3 files
remain untouched legacy evidence and are never migrated in place.

This database remains disconnected from coordinator execution until causal replay and the cursor
semantic engine are implemented and the runtime is cut over atomically.

The following describes the currently executable v16 layout.

Runs live at `~/.pi/agent/workflow-runs/flow_<32 hex>/`:

```text
run.sqlite
source.flow.js
context/
  invocation.json
  project-manifest.json
  identity.json
  resources.json
  project/
sessions/
workspaces/
  candidates/
  checkpoints/
  overlays/
artifacts/<sha256>/
  body
  metadata.json
outputs/<execution-id>/
```

`run.sqlite` is the only state authority. It uses WAL, foreign keys, full synchronization, bounded
busy waiting, short immediate transactions, and revision checks. Immediate run directories are the
catalog; there is no second global index. Artifact bodies are immutable and content-addressed.

The launch snapshot is one Btrfs reflink tree hashed from admitted destination bytes. Writable
agents use disposable candidates; every successful mutation gets a restorable reflink checkpoint.
Replay of a mutating result is impossible without the matching restored checkpoint.

Same-run resume returns already committed operations. Explicit `/flow replay` consumes the exact
matching journal prefix from a selected earlier run and stops at the first semantic mismatch.
`/flow fresh-run` deliberately ignores that prefix. Live apply is never replayed as a mutation.

Coordinator, agent, command, verification, and measurement processes use deterministic transient
systemd services. SQLite carries ordinary control requests. Reloading or closing Pi drops only local
rendering/polling state; it does not stop active services.

## Development

```bash
npm install
npm run check
```

`npm run check` runs TypeScript, authoring-interface checks, built-in flow checks, and Vitest. Real
machine trials are separate; see [`benchmark/README.md`](benchmark/README.md).

Security details are in [`SECURITY.md`](SECURITY.md). Projection and storage costs are in
[`PERFORMANCE.md`](PERFORMANCE.md).
