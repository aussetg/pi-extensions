# Performance plan

Goal: measure whether `pi-code-feedback` makes `pi` feel slower, then optimize only changes that are proven by repeatable numbers.

## What we measure

The benchmark avoids model/API noise and drives the extension event handlers directly, using the same file-system and LSP/formatter paths the extension uses in `pi`.

Metrics per scenario:

- wall time: p50, p95, p99, max
- main-process CPU time
- main-process RSS start/end/peak
- LSP child-process CPU and RSS when `/proc` exposes the child process tree

The useful comparison is not one number. We compare layers:

1. `edit/disabled` — extension installed but `enabled=false`
2. `edit/no-lsp-no-format` — extension book-keeping only
3. `edit/formatter-detect-none` — auto-format path when no formatter is configured
4. `formatter/fake-noop` — formatter detection plus process spawn/readback
5. `formatter/fake-change` — formatter spawn plus touched-range remapping
6. `formatter/fake-map-large` — formatter remapping stress case near the LCS threshold
7. `lsp/fake-cold` and `lsp/fake-warm` — deterministic stdio LSP cost
8. `lsp/fake-delay-200` — proves wall time tracks server diagnostic latency
9. `lsp/fake-timeout-120` — proves wall time tracks diagnostic timeout behavior
10. optional `lsp/typescript-live` — real TypeScript language server on this machine

This separates unavoidable feature latency, accidental JavaScript overhead, formatter cost, and language-server cost.

## How to run

```bash
npm run perf
npm --silent run perf -- --json > /tmp/pi-code-feedback-perf.json
npm run perf:live
```

Useful focused runs:

```bash
npm run perf -- --scenario edit -n 100
npm run perf -- --scenario formatter -n 30
npm run perf -- --scenario lsp/fake -n 30
npm run perf:live -- --scenario typescript
```

## Hypothesis tests

LSP diagnostic waiting is the cause if:

- `lsp/fake-warm total.p95 - edit/no-lsp-no-format total.p95` is large while CPU stays low.
- `lsp/fake-delay-200` increases by roughly 400ms per edit: one 200ms wait before the edit and one after it.
- `lsp/fake-timeout-120` lands near two timeout windows, plus polling overhead.
- `lsp/typescript-live` has the same shape as fake delayed/timeout scenarios.

Formatter execution/remapping is the cause if:

- `formatter/fake-noop - edit/formatter-detect-none` is large: formatter spawn/readback dominates.
- `formatter/fake-change - formatter/fake-noop` is large: file rewrite comparison and range remapping matter.
- `formatter/fake-map-large` raises CPU/RSS: LCS range remapping matters on larger files.

## Optimization workflow

1. Run `npm run check` before touching performance-sensitive code.
2. Run `npm run perf -- --json` and save the baseline.
3. Optimize one suspected cost at a time.
4. Re-run `npm run check` and the same benchmark command.
5. Keep an optimization only if feature tests still pass and p95 wall/CPU/RSS improves in the relevant scenario without moving cost elsewhere.

## Realism rules

- Benchmark file edits are actual writes in temporary project roots.
- `tool_call` is measured before the simulated tool write; `tool_result` is measured after it, matching `pi`'s lifecycle.
- Fake LSP and fake formatter scenarios are deterministic and suitable for before/after comparisons.
- Live LSP scenarios are optional and diagnostic, not CI gates, because local language-server cache and machine load matter.
