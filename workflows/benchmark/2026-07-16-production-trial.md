# Production trial — 2026-07-16

Machine: CachyOS Linux, Btrfs, systemd user manager, cgroup v2, Bubblewrap, SQLite WAL, and Node 22.
The final OpenAI-only trials covered reload, process recovery, mediated-network failure, and replay.
Earlier matrix entries retain their original route snapshots. The final route file selects
`openai-codex/gpt-5.4-mini` with low thinking for every builtin profile.

## Product evidence

| Trial | Durable run | Result |
| --- | --- | --- |
| Structured research and receipt-only completion | `c3d739fb` | Completed with published evidence and an acknowledged `finish_work`. |
| Receiptless yield, reminder, and extension reload | `37c60104` | Session survived reload and later completed with four durable finish receipts. |
| Mediated research, candidate edit, exact approval, and apply | `165b0000` | Completed; live bytes changed only after the exact approval challenge. |
| Exact rejection | `ad9697cd` | Stopped as `approval-rejected`; the proposed file was not applied. |
| Goal handoff and provider interruption | `445ce6ec` | Handoff was retained; malformed provider responses paused rather than discarding the session. |
| Two-point execute-plan | `0caf74bf` | Both points completed and the approved result was applied. |
| Agent and coordinator `SIGKILL` | `5f66158c` | Agent PID `644992` was replaced by `648214`; coordinator PID `650733` was replaced by `652646`; revision 94 recorded `coordinator-recovered`; run completed at revision 301. |
| Mediated-network failure | `fca72cc4` | Every Kagi call returned a deliberate invalid-token error; the session retained those tool results and still committed durable artifacts and finish receipts. |
| Explicit prefix replay | `e8af1322` → `478ada75` | Three semantic calls replayed, with zero provider requests and zero replayed token cost. |

The `5f66158c` attempts recorded CPU use, I/O, memory peak, and process peak. Memory peaks were
179–186 MiB and process peaks were 13. Live unit inspection confirmed `MemoryMax=2 GiB`,
`MemorySwapMax=0`, `CPUQuota=400%`, `IOWeight=100`, `TasksMax=256` for agents and `TasksMax=1024`
for coordinators. Coordinators used `Restart=on-failure`; agents remained supervisor-restarted.

## Timings

These are local measurements, not portable promises.

| Path | Samples | Result |
| --- | ---: | --- |
| Five-file project snapshot, reflink + hash | 10 | 7.1 ms median; 17.1 ms max |
| Candidate creation | 10 | 34.6 ms median; 39.6 ms max |
| Durable candidate checkpoint | 10 | 39.0 ms median; 47.1 ms max |
| Checkpoint freeze verification | 10 | 0.46 ms median; 0.71 ms max |
| Checkpoint clone + restore verification | 10 | 39.8 ms median; 44.2 ms max |
| systemd service + networkless Bubblewrap `/usr/bin/true` | 10 | 219 ms median wall time; 232 ms max |
| Bounded overview projection for the 301-revision recovery run | 1,000 | 0.965 ms median; 1.71 ms p95; 2.78 ms max |
| Fresh one-angle research | 1 | 122.6 s wall; 21 requests; 27,358 input + output tokens excluding cache reads |
| Full-prefix replay of that research | 1 | 2.59 s wall; 3 hits; 0 requests; 0 tokens |

The replay was about 47× faster by end-to-end command wall time. Its durable coordinator interval
was 314 ms, versus 120.2 s for the fresh run. There is no retained quantitative pre-rebuild
baseline, so no synthetic comparison is claimed. The meaningful local comparison is fresh durable
execution versus replay under the rebuilt runtime.

## Correctness gate

`npm run check` passed from one clean process: all three TypeScript checks and 249 tests across 27
files. The integration suite ran serialized so transient systemd fixtures could not interfere with
one another.
