 # Runtime hardening

This phase hardens the runtime before deployment. It deliberately does **not** perform product rollout,
provider trials, extension replacement, branch merge, or worktree archival.

## Threat review

The review treats installed workflow source as reviewed policy, invocation/model values as untrusted,
run files as integrity-sensitive local evidence, and concurrent coordinator processes as mutually
untrusted until they prove exact run/project authority.

The hardening pass found and corrected these production-path gaps:

- coordinator services did not receive the deterministic unit identity required by their own cgroup
  ownership check;
- replay accepted a host-incompatible mode and did not reject a source run from another project;
- asynchronous completion watchers were not bound to their launch session/project, stopped polling at
  human handoffs, and could notify more than once;
- a failed launch-directory publish race could remove a final path the launcher had not created;
- apply was not serialized across coordinator processes and re-read mutable manifest files after
  prepared-context validation;
- apply compared missing tree entries through JSON serialization, breaking real file additions and
  deletions; manifest leaf overflow was similarly masked as an authority error;
- apply did not fsync its postimages, reject symlink ancestors, or recover its own interrupted staging
  file;
- prepared execution trusted the launch-manifest hash without rescanning the immutable project tree;
- verification/apply did not independently reject mutation of a supposedly frozen candidate tree;
- the adversarial-review resource was prepared as a snapshot agent despite executing over a candidate;
- run-catalog listing followed a symlinked catalog root;

The public TypeScript API and independent conformance oracle remain the reviewed contract. Exact API
hashes are regenerated whenever that contract changes.

## Automated hardening gates

- Real systemd launch of a prepared coordinator, including deterministic unit/cgroup identity.
- Native-loop and effect-admission runaway containment.
- Control worker heap, async-segment, cancellation, crash, wire depth, wire bytes, and wire node bounds.
- All semantic-engine, structured-concurrency, candidate, measurement, and causal-replay crash points.
- Full 256-item keyed map with bounded physical concurrency and deterministic output/join order.
- Exact 64-leaf artifact bound and 65th-leaf rejection.
- Real apply postimage, partial-reentry, drift/conflict, symlink-root, kernel-lock, and orphan-staging
  behavior.
- Frozen-candidate tamper refusal before verification.
- Cross-project replay refusal and async notification ownership/deduplication.
- database integrity/canonical-JSON corruption, replay-source corruption, artifact tampering,
  registry symlinks, and project trust.
- Dependency audit, strict TypeScript surfaces, complete unit/conformance tests, diagnostics, and diff
  checks.

## Deferred rollout gates

The following are intentionally postponed to the rollout phase:

- running all six built-ins through the installed extension with `pi -ne -e`;
- real provider, Kagi/network, Bubblewrap command, and agent-session recovery trials;
- extension reload and coordinator/agent `SIGKILL` product trials;
- approval/rejection trials against a disposable live repository through the actual TUI;
- recording production snapshot/checkpoint/replay/projection latency and cgroup evidence;
- merging the implementation branch and archiving its worktree.

See `benchmark/README.md` for the rollout evidence matrix.
