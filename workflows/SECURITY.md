# Workflow security model

This is a defense-in-depth design for one trusted Linux workstation. It is not a multi-tenant
service and does not promise portability.

## Authority boundaries

- The primary Pi session is the only workflow launcher and human-control surface.
- Installed workflow source is reviewed executable policy. Invocation arguments are untrusted data.
- Draft source is inert until an exact human promotion challenge succeeds.
- Agent output is untrusted. Only host tools and validated receipts can create durable authority.
- `run.sqlite` is the sole mutable state authority. Artifact and workspace files are referenced by
  digest or exact database records.

The `workflow` tool accepts only an installed name, JSON arguments, and delivery mode. The
`workflow_draft` tool can stage and validate text but cannot promote it. Project definitions and
profiles are unavailable until Pi reports project trust.

Static validation derives profile, command, measurement, verification, candidate, network,
human-interaction, and apply authority before launch. Workflow source has no ambient import, process,
filesystem, socket, clock, random, code-generation, or workflow-launch primitive. Reviewed control
JavaScript runs in a separate memory-bounded child with frozen globals, disabled string/Wasm code
generation, bounded typed messages, and a synchronous-segment watchdog.

Purity and capture analysis follows ordinary local helper bodies and helper-return aliases. Only
keyed `parallel`, keyed `map`, and candidate callbacks start a separately checked capture boundary.
Loops, branches, helpers, and error handling are ordinary TypeScript; durable identity comes from
scope-local encounter cursors rather than authored scheduler nodes or operation IDs.

## Agent completion and control

An agent succeeds only after `finish_work` parameters match the admitted output schema and the
coordinator commits the receipt before acknowledging the tool. Assistant text, including final
text that resembles JSON, is never a result authority.

`report_progress`, `log_result`, and `publish_artifact` create bounded progress/evidence records.
They cannot affect workflow branching before `finish_work` returns control. A running logical agent
accepts no task-specific host message. The only semantic host message is the fixed missing-receipt
reminder after a clean yield. Stop is process control; changed guidance requires a new agent
operation with a complete initial task.

Provider retries, compaction, worker crashes, and service failures reopen the same persistent Pi
session without consuming receiptless strikes. Three consecutive clean yields with neither a finish
receipt nor meaningful progress pause the operation and preserve its session and workspace.

## Profiles, routes, and tools

Agent profiles contain role instructions and a maximum fixed tool set. Exact model/thinking routes
are host policy, resolved and snapshotted at launch. Authentication files remain operational input:
their contents are not hashed into semantic identity, copied into artifacts, or used to decide
replay.

The model-visible tool set is the intersection of:

1. the semantic profile;
2. snapshot/candidate and network authority admitted for the operation;
3. the executor's exact fixed tool schemas.

There is no workflow tool inside an agent session. Mediated `web_search` and `web_fetch` can coexist
with candidate editing. They are coordinator-mediated tools, not shell access. `workspace_command`
always starts a separate networkless command sandbox.

The SDK worker uses an explicit resource loader, in-memory settings, and a run-owned session manager.
It does not discover ambient extensions, skills, prompts, themes, or project context. Its sandbox
mounts only the system runtime, exact workspace, read-only inputs, output staging, persistent session,
protocol socket, and the minimal Pi model/auth files needed for provider transport.

## Filesystem isolation

Launch capture requires the project and run root on one Btrfs filesystem. Every regular file is
cloned with `COPYFILE_FICLONE_FORCE` and the admitted destination is hashed. VCS internals and
workflow state are excluded and recorded. Escaping links, special files, mutation during capture,
or a non-reflink filesystem fail closed. The captured project tree is never the live project.

Inspection agents receive a read-only bind. Writable agents receive only a disposable candidate
clone with a fixed write scope and lineage. Candidate freeze scans without following links, checks
modes/types/paths/size, computes the exact delta, enforces write scope, and writes immutable manifest
and diff artifacts. A successful mutation is paired transactionally with a restorable Btrfs
checkpoint. Recovery verifies the current candidate tree or restores that checkpoint before reusing
the result.

Commands run as argv without shell interpolation in Bubblewrap and transient user services. System
runtime directories are read-only, credentials and ambient environment are cleared, and network is
unshared. Read-only effects bind the launch snapshot, temporary effects use a discarded tmp-overlay,
and candidate effects bind only the selected candidate. Missing Bubblewrap/systemd support is an
error; there is no host-process fallback.

## Artifacts and protocol

Artifacts are bounded text, canonical JSON, or bytes. The store writes and syncs the body, moves it
to its digest directory, writes metadata, and then admits the reference in SQLite. Workflow-facing
references are opaque host objects; every use resolves the exact database row and validates body
path, size, media type, and digest. Path escapes and symlink components fail closed.

Agent/coordinator tool traffic uses a private per-run Unix socket and one execution token. Request
values are closed, bounded schemas. Tool-call IDs are idempotent: exact duplicates return the
committed response; conflicting duplicates fail. Coordinator-mediated effects commit a write-ahead
intent before dispatch. An intent left without a receipt is quarantined, its command unit is stopped,
and the agent hierarchy pauses rather than repeating an effect with an unknown outcome.

## SQLite and process ownership

Each run has one SQLite database configured with WAL, foreign keys, full synchronization, and a
bounded busy timeout. State transitions use short `BEGIN IMMEDIATE` transactions and expected
revisions. Data that does not match the current tables and invariants is rejected as corrupt.

Candidate measurement observations remain pending until the exact measurement-bound `accept` or
`reject` operation completes. That operation atomically records the disposition and transitions the
whole cohort. Acceptance advances `current` and the grouped accepted-best reference together;
rejection preserves the prior accepted reference.

The coordinator is a deterministic systemd user service with fixed host limits. Agents, commands,
verifications, and measurements are separate transient services. The run's stored safety policy
supplies their `MemoryMax`, `TasksMax`, CPU quota/weight, output, and command-duration limits; service
classes retain distinct I/O weights and bounded stop timeouts. Swap/zswap stay disabled, kill mode is
mixed, and inactive units are collected. Cancellation sends TERM, waits, then sends KILL. Cgroup CPU,
I/O, memory, process, and pressure data is read before collection.

SQLite is the ordinary control transport. Reopen re-executes exact snapshotted TypeScript and consumes
scope-local calls and durable physical-effect settlements; a settled effect is not repeated. Extension
shutdown drops only presentation polling and does not stop services.

Prepared runs pin the TypeScript source transform, API hash, reviewed definition,
registry exposure policy, launch actor, project trust, static authority, and invocation-selected
resources. A
coordinator with a different revision refuses to resume the run before workflow control or effects
execute; the workflow must be started again under the current revision.

## Verification, replay, and apply

Verification binds candidate tree, lineage, write scope, project snapshot, profile, environment,
ordered gate evidence, and reviewer finish receipt. Verification commands are networkless read-only
sandboxes over the frozen candidate; the adversarial reviewer receives only reviewed read tools.
Source contamination or stale binding prevents a passed receipt.

Cross-revision replay is explicit, causal, and prefix-only per sequential scope. Branch and map lanes
match independently by key and seed; deterministic structural joins bind target order, failure policy,
lane terminal keys, and outcomes. Effect identity includes semantic input, reviewed resources,
artifacts, workspace/context authority, and the prior local call key. Credentials, cgroup policy,
temporary paths, display titles, source locations, and wall time are excluded. Incomplete, failed,
and explicitly nonreplayable calls never replay. Mutating replay must restore the exact post-workspace
checkpoint before its imported call commits.

`flow.apply` always enters an exact human approval interaction. The challenge binds the operation,
candidate tree, verification binding, changed paths, and observed live-project tree. A stale or
changed challenge is rejected. Apply is serialized across coordinator processes with a kernel flock
whose holder dies with its coordinator. Under that lock it repeats tree/drift checks, rejects symlink
ancestors, touches only the verified delta, fsyncs changed files/directories, and returns a receipt
only after the complete live tree equals the candidate. Re-entry after a crash is idempotent. There
is no model approval path and no unattended live-project mutation.

## Required host

- Linux with cgroup v2 and unprivileged user namespaces
- working systemd user manager
- Btrfs reflinks on the project/run filesystem
- Bubblewrap at `/usr/bin/bwrap`
- Node 22 or newer with `node:sqlite`

The implementation intentionally has no alternate snapshot, sandbox, process, database, or workflow
runtime.
