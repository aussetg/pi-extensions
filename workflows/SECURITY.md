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
checkpoint, and apply authority before launch. Workflow source has no import, process, filesystem,
socket, clock, random, code-generation, or workflow-launch primitive. Reviewed control JavaScript
runs in a separate memory-bounded child with frozen globals, disabled string/Wasm code generation,
bounded typed messages, and a synchronous-segment watchdog.

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
committed response; conflicting duplicates fail.

## SQLite and process ownership

Each run has one schema-version-1 SQLite database configured with WAL, foreign keys, full
synchronization, and a bounded busy timeout. State transitions use short `BEGIN IMMEDIATE`
transactions and expected revisions. Unknown schema versions are rejected; there are no migrations.

The coordinator is a deterministic systemd user service. Agents, commands, verifications, and
measurements are separate transient services with fixed `MemoryMax`, no swap/zswap, `TasksMax`, CPU
and I/O weights/quotas, mixed process-tree kill, bounded stop timeout, and inactive collection.
Cancellation sends TERM, waits, then sends KILL. Cgroup CPU, I/O, memory, process, and pressure data
is read before collection.

SQLite is the ordinary control transport. An interrupted `running` row is paused on reopen rather
than silently continued. Extension shutdown does not stop services.

## Verification, replay, and apply

Verification binds candidate tree, lineage, write scope, project snapshot, profile, environment,
ordered gate evidence, and reviewer finish receipt. Verification commands run against an independent
candidate materialization. Source contamination or stale binding prevents a passed receipt.

Cross-revision replay is explicit and prefix-only. The key includes previous journal key, operation
identity, semantic prompt, profile and route, tool/finish schemas, input artifact digests, network
mode, and pre-workspace/context identity. Credentials, executable bytes, cgroup policy, temporary
paths, and wall time are excluded. Incomplete calls and missing finish receipts never replay.
Mutating replay must restore the exact post-workspace checkpoint.

`flow.apply` always enters a human checkpoint. The challenge binds run revision, candidate,
verification, live-project drift, and exact preimage/postimage plan. A stale or changed challenge is
rejected. Apply is serialized per repository, repeats drift/preflight checks immediately before
mutation, touches only the verified delta, and commits a receipt only after exact postimages are
observed. There is no model approval path and no unattended live-project mutation.

## Required host

- Linux with cgroup v2 and unprivileged user namespaces
- working systemd user manager
- Btrfs reflinks on the project/run filesystem
- Bubblewrap at `/usr/bin/bwrap`
- Node 22 or newer with `node:sqlite`

The implementation intentionally has no alternate snapshot, sandbox, process, database, or workflow
runtime.
