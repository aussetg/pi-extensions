# Workflow security model

## Scope and support

This extension is defense in depth for one trusted Linux user on one workstation. It is not a
multi-user service, a privilege boundary against the account that runs Pi, or a portable sandbox.
Only the current checkout, pinned dependencies, public workflow API, and current SQLite layout are
supported. There are no compatibility or security updates for old storage schemas.

The extension module itself executes with the full permissions of the Pi process. Review changes to
this repository and its dependencies before loading it. The restrictions below apply to validated
workflow definitions and spawned effects; they do not sandbox a malicious extension implementation.

For private security reports, send a minimal reproducer through the same private channel used to
share this repository. Do not include provider credentials, private prompts, run databases, or
project snapshots unless they have been sanitized. There is no public vulnerability-response SLA.

## Trust and authority boundaries

- **Installed workflow source is reviewed policy.** It can choose descriptors, control flow,
  resource selectors, candidate scopes, human interactions, and apply sites. Invocation arguments
  are untrusted data validated against the exact installed input schema.
- **Draft source is inert.** Validation parses and reviews it but never calls `run()`. It becomes
  installed policy only after an exact human promotion challenge succeeds.
- **Agent and provider output is untrusted.** Assistant prose is never completion authority. An
  agent operation succeeds only after the host commits a `finish_work` receipt whose payload matches
  the admitted output schema.
- **Human control belongs to the primary Pi session.** Models cannot approve apply, promote drafts,
  or delete runs. Control requests and exact challenge hashes are committed to SQLite.
- **Project resources require Pi project trust.** Project definitions, agent/command/verification/
  measurement profiles, and project drafts are neither enumerated nor used before trust is active.
- **`run.sqlite` is the mutable authority.** Artifact bodies, sessions, manifests, snapshots, and
  checkpoints are accepted only through exact database records, paths, sizes, and digests.

The `workflow` model tool accepts only a model-exposed installed name, its exact JSON arguments, and
delivery mode. The `workflow_draft` tool can stage or validate source but has no promotion,
installation, approval, exposure, or execution operation.

## Workflow language containment

`.flow.ts` accepts erasable TypeScript and one virtual `pi/workflows` import. Strict typechecking and
static review derive every agent profile, command profile, verification profile, measurement class,
workspace mode, network grant, human interaction, and apply site before launch.

Workflow source has no ambient imports or direct process, filesystem, socket, environment, clock,
randomness, code-generation, or workflow-launch primitive. The reviewed JavaScript control program
runs in a separate memory-bounded child with frozen globals, string/Wasm code generation disabled,
bounded typed messages, a synchronous-segment watchdog, and host admission limits for effectful
loops.

Static purity and capture analysis follows local helper calls and returned aliases. Effectful helper
graphs must be finite and nonrecursive. Keyed `parallel`, keyed `map`, and candidate callbacks create
separately checked capture boundaries. Concurrent callbacks cannot mutate captured state or share a
mutable workspace capability.

Descriptors and runtime values are host-minted capabilities. Plain objects that resemble agent
tasks, artifacts, candidates, workspaces, verification receipts, measurements, accepted candidates,
or apply receipts carry no authority. Foreign, stale, revoked, malformed, or cross-run capabilities
fail closed.

## Agent execution and credentials

Each logical agent has a pinned semantic profile, exact provider/model/thinking route, fixed tool
schemas, workspace authority, and network authority. The visible tools are the intersection of:

1. the semantic profile's maximum tool set;
2. snapshot/candidate and mediated-network authority admitted by the descriptor; and
3. the executor's fixed tool catalog.

There is no `workflow` tool in an agent session. The SDK worker uses in-memory Pi settings, an
explicit resource loader, and a run-owned session manager; it does not discover ambient extensions,
skills, prompts, themes, or project context.

The agent Bubblewrap sandbox mounts only the runtime, exact workspace, read-only artifact inputs,
output staging, persistent run-owned session, protocol socket, and selected Pi auth/model files.
Snapshot workspaces are read-only; candidate workspaces are writable only for agents granted
candidate authority.

The agent sandbox intentionally retains network access for provider transport. The model receives no
arbitrary network or shell tool: `web_search` and `web_fetch` are coordinator-mediated Kagi calls,
and `workspace_command` starts a separate networkless service. This is capability containment, not a
general egress firewall for trusted worker code.

The coordinator forwards only a fixed set of bounded provider API-key environment variables and an
optional Kagi key. The worker may bind Pi's `auth.json` read-write so Pi can maintain authentication,
and binds `models.json` read-only. Credential contents are operational input: they are not copied into
artifacts, hashed into replay identity, or used as semantic evidence. Run directories are not a safe
place to store secrets deliberately returned by a model.

Agent completion, progress, and evidence use bounded host tools:

- `finish_work` commits the only result authority;
- `report_progress`, `log_result`, and `publish_artifact` record bounded evidence but do not change
  workflow branching before completion;
- tool-call IDs are idempotent: exact repeats return the committed response and conflicting repeats
  fail;
- an effect intent without a receipt after a crash is quarantined and pauses the hierarchy instead
  of blindly repeating an operation with unknown outcome.

Provider retries, compaction, worker crashes, and service failures reopen the same persistent Pi
session. Three consecutive clean yields without a finish receipt or meaningful progress pause the
operation while preserving its session and workspace.

## Filesystem isolation

Launch requires the live project and run root on one Btrfs filesystem. Every admitted regular file
is cloned with `COPYFILE_FICLONE_FORCE`; the destination inode is then hashed. VCS internals and
workflow state directories are excluded and recorded. Escaping symlinks, special files, source
mutation during capture, excessive trees, or missing reflink support abort launch. Agents never
receive the live project as their initial workspace.

Candidate mutation happens only inside a candidate body scope. Candidate creation clones an exact
base tree. Freeze then:

- scans without following symlinks;
- checks path, type, mode, file-size, tree-size, and write-scope limits;
- computes the exact changed path set and diff;
- writes immutable manifest/diff artifacts; and
- pairs successful mutable work with a restorable Btrfs checkpoint.

Recovery verifies the current candidate or restores the exact checkpoint before reusing a settled
mutating result. Verification and apply independently rescan the supposedly frozen candidate and
reject contamination.

Commands never use shell interpolation. A command profile fixes an absolute executable and argv
template; invocation values replace complete reviewed tokens only. Commands, tests, diagnostics,
and measurements run as transient systemd services inside Bubblewrap with a cleared environment,
read-only system runtime, private PID/UTS/IPC namespaces, and an unshared network namespace.
Read-only effects bind the immutable launch snapshot, temporary effects use a discarded tmp overlay,
and candidate effects bind only the selected candidate. There is no host-process fallback.

## Verification, acceptance, and apply

Verification binds the candidate tree, lineage, write scope, project snapshot, profile hash,
executor environment, ordered gate evidence, and optional reviewer finish receipt. Verification
commands are networkless and read-only over the frozen candidate. The adversarial reviewer receives
only its pinned reviewed tools. Changed source or stale bindings prevent a passing result from being
used.

Acceptance binds the exact candidate and passed verification, plus measurement evidence when
provided. Measurement observations remain pending until the candidate is accepted or rejected; the
disposition and metric-state transition commit together.

`flow.apply` always creates a durable human interaction. Its challenge binds the operation,
candidate tree, verification/measurement evidence, changed paths, and observed live-project tree.
After approval, the run becomes paused and must be explicitly resumed.

Apply is serialized across coordinators with a kernel `flock`. Under that lock it repeats all
candidate and live-project drift checks, rejects symlink ancestors, touches only the verified delta,
fsyncs changed files and directories, and records success only after the complete semantic project
tree equals the candidate. Re-entry after a crash is idempotent. There is no unattended or model
approval path.

Approval is not a general backup. It deliberately mutates the current working tree, not a Git
branch, and run deletion can remove the retained candidate/checkpoint evidence.

## Persistence, process ownership, and control

Each run has one SQLite database configured with WAL, foreign keys, full synchronization, and a
bounded busy timeout. Mutations use short `BEGIN IMMEDIATE` transactions and expected revisions.
Rows and canonical JSON that violate current schema or cross-table invariants are treated as corrupt.

Coordinator, agent, command, verification, and measurement processes are deterministic systemd user
services. Systemd, not the Pi extension process, owns their lifetime. Services set memory, task, CPU,
I/O, swap/zswap, kill-mode, and stop-time limits. Coordinators use `Restart=on-failure`; subordinate
effects are reopened or restarted by their durable supervisor. Cancellation sends `SIGTERM`, waits a
bounded interval, then sends `SIGKILL`. Cgroup CPU, I/O, memory, PID, OOM, and pressure evidence is
sampled before inactive units are collected.

Pause, resume, stop, stop-effect, ask responses, and apply decisions are durable database requests.
The coordinator drains them and exits at durable waiting/paused/terminal boundaries. Extension
shutdown only removes local polling and rendering; it never implicitly stops a unit.

Prepared runs pin exact source and executable transform, input/output schemas, runtime API hash,
derived static review, registry policy revision, launch actor, project trust, invocation resources,
profile/model/tool routes, executors, environments, and project snapshot. A coordinator whose
runtime identity differs refuses to execute that prepared run.

Run data is integrity-checked but not encrypted, signed, or protected from the same local account.
A process with the user's filesystem permissions can read private project snapshots and agent
transcripts or destroy evidence. Root can bypass every boundary described here.

## Replay safety

Same-run recovery re-executes exact snapshotted TypeScript and consumes scope-local calls and
physical settlements. Settled effects are not reissued simply because the coordinator crashed.

Cross-run replay is explicit, causal, and prefix-only per sequential scope. Child lanes match by
parent prefix and authored key; joins bind output order, failure policy, terminal keys, and outcomes.
Sibling lanes can remain reusable independently, but a changed join stops later parent reuse.

Replay identity includes semantic input, reviewed resources, artifacts, workspace/context authority,
and prior local call key. Credentials, cgroup policy, temporary paths, source locations, display
titles, wall time, and unit IDs are excluded. Failed, incomplete, quarantined, or explicitly
nonreplayable effects execute fresh. Apply never replays. Mutating replay must restore and verify its
exact post-workspace checkpoint before the imported call commits.

Replay is an optimization, not a trust escalation: it is restricted to the same canonical project
and current installed workflow identity.

## Draft and registry transactions

Draft revisions are immutable, content-addressed `.flow.ts` files selected by compare-and-swap head
records. Promotion binds the exact draft, installed preimage, static review, current policy,
requested exposure, and challenge hash.

Source and `registry.json` are replaced under a namespace lock with a durable
`.registry-promotion.json` marker. Discovery refuses the namespace while that marker is present.
After a crash, only an exact retry of the challenged transaction may complete it; conflicting source
or policy changes fail closed.

Registry and profile roots/files must be regular non-symlink objects. Missing workflow exposure
policy is human-only. Malformed or incomplete policy never grants model exposure.

Registry frontend caching is process-local and content-addressed. Discovery still rereads exact
source, API declaration, and policy bytes; cache identity also binds the TypeScript version/options,
runtime API, installed filename, and an explicit frontend/analyzer revision. Mtimes are not trusted,
and exposure policy is reapplied independently on every refresh.

## Operational limits and non-goals

The implementation does not provide:

- protection from a malicious Pi extension, the owning Unix account, or root;
- a general outbound-network firewall for trusted provider workers;
- secret redaction from prompts, transcripts, artifacts, command output, or provider requests;
- encrypted run storage or tamper-evident signatures against the local user;
- a portable snapshot, process, sandbox, database, or init-system fallback;
- distributed execution, remote workers, multi-host consensus, or multi-tenant authorization;
- source/storage migrations or long-term compatibility for old runs;
- automatic retention, secure deletion, or backup of run evidence;
- proof that model-generated changes are correct or safe. Human approval remains mandatory but is
  not infallible.

## Hardening and incident handling

The automated test gates exercise strict frontend/type contracts, native-loop and admission runaway
containment, control-worker memory/wire/cancellation bounds, systemd ownership, structured
concurrency, crash matrices, candidate lifecycle, artifact limits, measurement dispositions,
frozen-tree tampering, replay corruption, registry symlinks, project trust, apply drift/locking/
re-entry, and malformed persistence/protocol data.

Before trusting a changed build, also perform product trials with real providers and disposable
projects: approval and rejection, extension reload, coordinator/agent `SIGKILL`, receiptless agent
recovery, network failure, and explicit replay.

If a run behaves unexpectedly:

1. Do not edit `run.sqlite`, manifests, or candidate trees in place.
2. Inspect `/flow open RUN` and `/flow status RUN`.
3. Use `/flow stop-effect RUN OPERATION` for one active effect or `/flow stop RUN` for the run.
4. Inspect remaining units with `systemctl --user list-units 'pi-workflow-*.service'`.
5. Preserve the complete run directory before debugging corruption.
6. Rotate provider/Kagi credentials if logs, artifacts, or snapshots may have exposed them.
7. Rebuild storage rather than attempting an undocumented migration.
