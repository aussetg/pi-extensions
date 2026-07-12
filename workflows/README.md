# workflows

Pi extension for deterministic JavaScript workflows with one manually-enabled model tool (`workflow`) and one slash command (`/workflow`).

Highlights:

- durable run directories under `~/.pi/agent/workflows/runs/<cwd-hash>/`;
- Pi subagents launched through `agent()`;
- `parallel()`, `pipeline()`, first-class patch `apply()`, `phase()`, `log()`, `args`, `budget`, `cwd`, and declarative `ui` globals;
- restart from a previous run's persisted script and arguments, without replaying agent results;
- `/workflow` manager, enable/disable/status, run/list/save/resume/open, live-control,
  `skip-agent`, preview, and delete commands;
- the model tool is off by default; use `/workflow enable` when you want the agent to call it, and `/workflow disable` afterwards;
- declarative UI validation and bounded renderers.

The extension never installs terminal input handlers or focused custom dialogs. Workflow previews are
rendered as passive widgets/notifications, so Escape, Ctrl-C, and every other key keep their normal Pi
meaning.

Declarative UI views are always persisted as artifacts. Their optional `placement` controls where
else they appear:

- `runPanel` (default): live full dashboard while the run is active, plus final run output;
- `widget`: live compact widget while the run is active;
- `completion`: final completion/failure message only;
- `artifact`: persisted only, previewable with `/workflow open <runId> ui`.

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

Slash command reference:

```text
/workflow                                      # open the manager
/workflow enable|disable|toggle|status         # model tool gate; aliases: on/off
/workflow list [--running|--completed|--all]   # alias: ls
/workflow run <name|scriptPath> [--args <json>] [--await|--async]
/workflow save <runId> [--scope project|user] [--name <slug>]
/workflow resume <runId> [--script <scriptPath>] [--args <json>] [--await|--async]
/workflow pause|continue|stop <runId>          # continue alias: cont
/workflow skip-agent <runId> <callId>
/workflow open <runId> [result|script|journal|transcripts|ui] [viewId] [--profile compact|panel|full] [--width <columns>]
/workflow preview-ui <json> [--profile compact|panel|full] [--width <columns>]
/workflow delete <runId>                       # alias: rm
```

`run` and `resume` default to async mode when Pi has a UI and await mode without UI. `open ui`
previews the first persisted UI view unless a `viewId` is supplied. `open result`, `script`,
`journal`, and `transcripts` are read-only artifact viewers; only UI previews accept `viewId`,
`--profile`, and `--width`.

`resume` currently starts the workflow again from the beginning using the previous run's persisted
script and arguments. Completed agent calls are never replayed. `resumeFromRunId` records lineage only.

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
results. UI operations are queued and batched when left unawaited. Await `ui.define(...)`,
`ui.update(...)`, `ui.dashboard(...)`, `ui.patch(...)`, or `ui.close(...)` when you want that call to
act as a persistence barrier with validation/persistence errors catchable inside the workflow. After a
batch of unawaited UI writes, use `await ui.flush()` as an explicit barrier. Unhandled UI operation
errors still fail the workflow at final flush.
Call `ui.help()` inside a workflow for a tiny reminder of the model-facing API.

Workflow scripts are top-level async JavaScript. They begin with literal `export const meta = {...}`
and then script statements directly; do not use `export default`, imports, `globalThis`,
`Date.now()`, `Math.random()`, argless `new Date()`, `require`, `process`, `fs`, `fetch`, or network
APIs.

Subagent workspace policy is deliberately simple:

- direct `agent()` calls use `workspace: "shared"` by default and may edit the project;
- `agent()` calls inside `parallel()` or `pipeline()` default to `workspace: "readOnly"`; only
  read-only tools are exposed, so analysis lanes can run concurrently without copying the repository;
- `workspace: "patch"` runs an editing agent in a disposable git worktree and returns an opaque patch
  handle. The workflow must explicitly call `await apply(patch)` to update the shared project;
- explicit `agent(prompt, { workspace: "shared" | "readOnly" | "patch" })` always wins.

Parallel implementation uses first-class patches:

```js
const candidates = await parallel(tasks.map((task) => async () => {
  return await agent(`Implement ${task}`, { workspace: "patch", label: task });
}));

for (const candidate of candidates) await apply(candidate.patch);
```

`apply()` accepts only a patch produced by the current workflow run. Patch applications are
serialized, run `git apply --check` before mutation, reject stale or conflicting patches, and
refuse to apply the same patch twice. An empty patch is a successful no-op. Ignored build outputs
remain artifacts and are never copied into the project.

`agent(prompt, opts)` options are strict JSON data. Supported keys are `label`, `phase`, `schema`,
`model`, `thinking`, `workspace`, `agentType`, and `stallMs`; unknown keys, non-string labels/model
names, invalid enum values, non-JSON schemas, accessors, cycles, and oversized values fail before a
subagent is launched. `stallMs` must be an integer between 1 second and the workflow hard timeout.
Use `schema` for a JSON-object response schema.

`parallel()` and `pipeline()` fail fast by default: a branch/item error fails the workflow instead of
being converted to `null`. If best-effort behavior is desired, catch errors inside the thunk/stage and
return an explicit `{ ok, value, error }`-style result.

Patch agents run with cwd inside a disposable git worktree. Their tracked and untracked edits are
captured as a bounded patch artifact before the worktree is removed. Ignored outputs are captured
separately as bounded artifacts for inspection but are not applied. This is a workspace policy, not
a filesystem sandbox: patch agents are told to stay inside the worktree, and writes outside it are
not captured.

Workflow source is parsed before launch to reject nondeterministic and host APIs early. At runtime,
the script talks to the parent through a JSON-only VM membrane: workflow-visible API values are
created inside the VM realm, while host objects stay behind the capability channel. The control child
itself runs under `systemd-run --user --scope` and `bwrap`; that OS sandbox sees a tiny tmpfs
filesystem, a private network namespace, cgroup limits, and a JSON-RPC capability channel back to the
parent for `agent()`, `ui.*`, logging, and child workflows. This sandbox is required: `workflows`
does not silently fall back to an unsandboxed control child.
Subagents are still normal separate Pi child processes launched by the parent; they inherit the
currently active tool allowlist with `workflow` removed. If no allowed tools remain, the subagent is
launched with `--no-tools` rather than Pi defaults. Read-only agents retain only `read`, `grep`,
`find`, `ls`, `web_search`, `web_fetch`, and `view_image`; shared and patch agents retain the full
inherited allowlist. Their cwd follows the workspace policy above.

Subagent thinking is deliberately slightly cheaper than the caller by default: an agent launched
from a workflow uses one thinking level below the Pi session that launched the workflow (`xhigh` →
`high`, `high` → `medium`, …, `minimal` → `off`). Override per call when a lane needs a different
reasoning budget:

```js
await agent("Do the adversarial correctness pass.", {
  label: "review",
  thinking: "high",
});
```

Valid values are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Legacy model suffixes such
as `model: "sonnet:high"` still work unless the full string exactly names a registered model; the
first-class `thinking` option is clearer and overrides a model suffix when both are present.

Child workflows share the parent run's `budgetTokens` and `maxAgents` instead of receiving fresh
limits. When a finite token budget is set, agent starts are serialized across the parent and child
workflow tree so parallel fan-out cannot launch many budget-consuming subagents before the first
usage report arrives. A single subagent can still report usage above the remaining budget; that call
is recorded and the workflow fails immediately after the over-budget usage is charged.

Frame rendering is intentionally bounded: renderers consume only the current run/view snapshot and cap rows, logs, calls, node depth, and table output. They never scan Pi session history during `render(width)`.

Host sandbox requirements and troubleshooting:

- Required host tools: `/usr/bin/systemd-run` from systemd and `/usr/bin/bwrap` from bubblewrap.
  On Arch/CachyOS, `sudo pacman -S systemd bubblewrap` is sufficient on a normal systemd user
  session.
- If `bwrap` is missing, workflow launch fails with
  `workflows requires bwrap on this machine for workflow child sandboxing`.
- If `systemd-run` is missing, launch fails similarly for `systemd-run`. If it exists but cannot
  create a user scope, check `systemctl --user status`, `XDG_RUNTIME_DIR`, and
  `DBUS_SESSION_BUS_ADDRESS` in the Pi process environment.
- If bubblewrap reports namespace or permission errors, the host/container likely disallows the
  required user/mount/network namespaces. Enable unprivileged user namespaces for this machine or run
  Pi outside that restricted container/session.
- These requirements apply to the deterministic workflow control child. Subagents are separate Pi
  child processes launched by the parent with the inherited tool allowlist and the selected workspace
  policy.

Run `npm install` in this directory after checkout, then `/reload` Pi.
