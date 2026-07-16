# Performance notes

The runtime optimizes the paths used on this workstation: Btrfs reflinks, synchronous SQLite
transactions, indexed projections, and systemd-owned effects. It does not optimize for portable
fallbacks because none exist.

## Storage and replay

- Launch capture traverses the visible project once, reflinks each file, and hashes the admitted
  destination. Cost is O(visible paths + visible bytes read for hashing).
- Candidate creation and checkpoints are Btrfs reflink clones. Freeze and restore validation are
  intentionally O(candidate paths + semantic bytes); they are safety boundaries.
- Artifacts are content-addressed. Duplicate digests reuse one immutable body per run.
- Same-run replay reads indexed operation/journal rows. Explicit cross-revision replay advances in
  ordinal order and stops at the first mismatch.
- A mutating replay also restores and verifies its last workspace checkpoint; that filesystem work
  is required authority, not avoidable cache overhead.

SQLite uses WAL for concurrent readers, `synchronous=FULL`, foreign keys, a 5-second busy timeout,
and short immediate write transactions. UI reads use one coherent snapshot. No projection scans a
JSON state file or rebuilds current state from the full event history.

## Projection bounds

The shared read model caps an overview at:

- 128 phase operations;
- 16 active agents;
- 4 recent progress/log rows per active agent;
- 24 artifacts, 32 metrics, and 16 checkpoints;
- 256 KiB serialized projection size.

Inspector pages use indexed keyset queries, at most 64 entries, and at most 256 KiB. Operations,
progress history, artifacts, measurements, and events are independently pageable. Current agent
state is one row plus bounded metric/path children; active-agent query cost depends on active agents
and requested recent rows, not transcript length.

TUI components clone plain projection data and cache rendered output by visible fingerprint and
width. The inspector polls at 500 ms only while open. Headless/RPC output uses the same bounded DTO
and does not instantiate terminal components.

## Process and stream costs

Coordinator, agent, command, verification, and measurement startup includes one transient systemd
service. Commands add one Bubblewrap namespace. Streams are consumed incrementally, retain bounded
inline data, hash all observed bytes, and spill overflow to artifact staging.

Cgroup metric reads and full project/candidate scans are deliberately outside semantic cache
identity. Executable versions and unit identities are diagnostics only. Provider usage remains
measured but is never admission authority.

## Measurement

Record these separately in real product trials:

- project snapshot wall time and logical bytes;
- candidate clone/checkpoint/freeze wall time and bytes;
- command service + Bubblewrap startup;
- overview and inspector query/render latency;
- same-run and cross-revision replay-hit latency;
- cgroup CPU, I/O, memory peak, process peak, and pressure.

Use [`benchmark/README.md`](benchmark/README.md) for the required trial matrix. `npm run check` is a
correctness gate, not a performance claim.
