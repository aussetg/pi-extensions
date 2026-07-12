export const meta = {
  name: 'perf_dashboard_demo',
  description: 'Demonstrate declarative workflow UI for benchmark telemetry',
  phases: [
    { title: 'Discover' },
    { title: 'Benchmark' },
    { title: 'Synthesize' },
  ],
};

ui.define({
  version: 1,
  id: 'perf',
  title: 'Benchmark telemetry',
  placement: 'runPanel',
  initialState: { complete: 0, total: 0, medianMs: null, p95Ms: null, failures: 0, series: [], rows: [] },
  layout: {
    type: 'vstack',
    children: [
      { type: 'progress', label: 'Benchmarks complete', valueBind: '/complete', totalBind: '/total' },
      { type: 'grid', columns: 3, children: [
        { type: 'metric', label: 'Median', bind: '/medianMs', format: 'duration' },
        { type: 'metric', label: 'p95', bind: '/p95Ms', format: 'duration' },
        { type: 'metric', label: 'Failures', bind: '/failures', format: 'number' },
      ]},
      { type: 'sparkline', label: 'Median over time', bind: '/series', format: 'duration', maxPoints: 80 },
      { type: 'table', bind: '/rows', maxRows: 20, columns: [
        { path: '/target', label: 'Target' },
        { path: '/medianMs', label: 'Median', format: 'duration' },
        { path: '/p95Ms', label: 'p95', format: 'duration' },
        { path: '/status', label: 'Status', format: 'status' },
      ]},
    ],
  },
});

phase('Discover');
const targetsResult = await agent('Find benchmark targets in this repository. Return JSON targets.', {
  label: 'discover benchmarks',
  schema: { type: 'object', properties: { targets: { type: 'array', items: { type: 'string' } } }, required: ['targets'] },
});

const targets = targetsResult.targets ?? [];
ui.update('perf', { complete: 0, total: targets.length, medianMs: null, p95Ms: null, failures: 0, series: [], rows: [] });

phase('Benchmark');
const rows = [];
await pipeline(targets, async (target) => {
  const result = await agent(`Benchmark and analyze ${target}.`, {
    label: `benchmark ${target}`,
    schema: {
      type: 'object',
      properties: { target: { type: 'string' }, medianMs: { type: 'number' }, p95Ms: { type: 'number' }, status: { type: 'string' } },
      required: ['target', 'medianMs', 'p95Ms', 'status'],
    },
  });
  rows.push(result);
  const medians = rows.map((r) => r.medianMs).filter((n) => typeof n === 'number');
  const p95s = rows.map((r) => r.p95Ms).filter((n) => typeof n === 'number');
  ui.update('perf', {
    complete: rows.length,
    total: targets.length,
    medianMs: medians.length ? medians[Math.floor(medians.length / 2)] : null,
    p95Ms: p95s.length ? p95s[Math.floor(p95s.length * 0.95)] : null,
    failures: rows.filter((r) => r.status !== 'pass').length,
    series: medians.slice(-80),
    rows,
  });
  return result;
});

phase('Synthesize');
return await agent('Summarize benchmark regressions: ' + JSON.stringify(rows), { label: 'final synthesis' });
