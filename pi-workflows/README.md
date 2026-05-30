# pi-workflows

Pi extension for deterministic JavaScript workflows with one manually-enabled model tool (`workflow`) and one slash command (`/workflow`).

Highlights:

- durable run directories under `~/.pi/agent/workflows/runs/<cwd-hash>/`;
- Pi subagents launched through `agent()`;
- `parallel()`, `pipeline()`, `phase()`, `log()`, `args`, `budget`, `cwd`, and declarative `ui` globals;
- journal-based resume for unchanged completed `agent()` calls;
- `/workflow` manager, run/list/save/resume/open/pause/continue/stop/delete controls;
- the model tool is off by default; use `/workflow enable` when you want the agent to call it, and `/workflow disable` afterwards;
- declarative UI validation and bounded renderers.

Declarative UI views are always persisted as artifacts. Their optional `placement` controls where
else they appear:

- `runPanel` (default): live full dashboard while the run is active, plus final run output;
- `widget`: live compact widget while the run is active;
- `completion`: final completion/failure message only;
- `artifact`: persisted only, inspectable with `/workflow open <runId> ui`.

For model-authored progress UI, prefer the model-native dashboard helper:

```js
ui.dashboard({
  title: "Launch scan",
  status: step === total ? "done" : "running",
  summary: `${step}/${total} · ${note}`,
  panel: { lines: 16 },
  progress: { value: step, total },
  metrics: { agents: "5/5", signal: "79%", risk: "19%" },
  charts: [
    { label: "Launch", values: signalSeries, value: 0.79, format: "percent" },
    { label: "Risk", values: riskSeries, value: 0.19, format: "percent", direction: "down" },
  ],
  tables: [
    {
      title: "Agent lanes",
      columns: ["lane", { key: "score", format: "number" }, { key: "risk", format: "percent" }, "move"],
      rows,
      maxRows: 8,
    },
  ],
  sections: [
    {
      title: "Checklist",
      rows: [
        { label: "define dashboard", status: "done" },
        { label: "stream updates", status: step > 1 ? "done" : "pending" },
      ],
    },
    { title: "Log", lines: logLines },
  ],
});
```

`ui.dashboard()` defines the default `runPanel` dashboard on first call and updates it on later
calls. Prefer `ui.dashboard({ title, progress, metrics, charts, tables, sections })` for telemetry.
Charts, tables, rows, columns, points, and panel height are hard-capped before rendering so UI cost is
bounded by the current snapshot, not by session size. `panel.lines` may request a taller collapsed
dashboard and is clamped to a small bounded range. `ui.define({ title, status, summary, metrics,
charts, tables, sections })` and `ui.update({ ... })` are accepted as dashboard shims.

Preview a persisted UI snapshot without scanning transcripts or session history:

```bash
/workflow open <runId> ui --profile panel --width 140
/workflow open <runId> ui <viewId> --profile full --width 140
/workflow preview-ui '{"title":"Preview","tables":[{"columns":["lane","score"],"rows":[{"lane":"ux","score":91}]}]}' --profile panel --width 140
```

The strict declarative API is still available for advanced layouts:

```js
ui.define({
  version: 1,
  id: "custom",
  title: "Custom workflow UI",
  placement: "runPanel",
  initialState: { summary: "running", details: "expanded details" },
  layout: { type: "markdown", bind: "/summary" },
  expandedLayout: { type: "markdown", bind: "/details" },
});

await ui.update("custom", { summary: "done", details: "full final details" });
```

Use `layout` for live/running/collapsed UI. Use optional `expandedLayout` for richer expanded
results. Call `ui.help()` inside a workflow for a tiny reminder of the model-facing API.

Workflow scripts are top-level async JavaScript. They begin with literal `export const meta = {...}`
and then script statements directly; do not use `export default`, imports, `globalThis`,
`Date.now()`, `Math.random()`, argless `new Date()`, `require`, `process`, `fs`, `fetch`, or network
APIs.

Subagent workspace policy is deliberately simple:

- direct `agent()` calls use the shared project workspace by default;
- `agent()` calls made inside `parallel()` or `pipeline()` default to `isolation: "worktree"` so
  sibling fan-out agents do not stomp each other;
- explicit `agent(prompt, { isolation: "shared" | "worktree" })` always wins.

Worktree-isolated agents run in a disposable git worktree. Their edits are captured as patch
artifacts and are not applied to the user's main working tree automatically.

Workflow source is parsed before launch to reject nondeterministic and host APIs early. At runtime,
the script talks to the parent through a JSON-only VM membrane: workflow-visible API values are
created inside the VM realm, while host objects stay behind the capability channel. The control child
itself runs under `systemd-run --user --scope` and `bwrap`; that OS sandbox sees a tiny tmpfs
filesystem, a private network namespace, cgroup limits, and a JSON-RPC capability channel back to the
parent for `agent()`, `ui.*`, logging, and child workflows.
Subagents are still normal separate Pi child processes launched by the parent; they keep the usual
tools and network access. Their cwd is either the shared project workspace or a disposable worktree,
according to the isolation policy above.

Frame rendering is intentionally bounded: renderers consume only the current run/view snapshot and cap rows, logs, calls, node depth, and table output. They never scan Pi session history during `render(width)`.

Run `npm install` in this directory after checkout, then `/reload` Pi.
