# workflows

Pi extension for constrained JavaScript workflows with one manually enabled model tool (`workflow`)
and one slash command (`/workflow`).

The extension provides:

- durable run directories under `~/.pi/agent/workflows/runs/<cwd-hash>/`;
- Pi subagents launched through `agent()`;
- `parallel()`, `pipeline()`, `apply()`, `phase()`, `log()`, `workflow()`, `args`, `budget`,
  and `cwd` globals;
- explicit read-only, shared, and isolated-patch workspaces;
- bounded journals, logs, outputs, and patch artifacts;
- restart-from-script resume with lineage metadata;
- `/workflow` management and live controls.

The model tool is off by default. Use `/workflow enable` when it is useful and `/workflow disable`
afterward.

## Workflow scripts

Scripts are top-level async JavaScript. They begin with a literal metadata declaration and then
contain statements directly:

```js
export const meta = {
  name: "review_and_fix",
  description: "Review independent areas, apply isolated fixes, then verify",
  phases: [
    { title: "Review" },
    { title: "Apply" },
    { title: "Verify" },
  ],
};

phase("Review");
const candidates = await parallel(
  args.tasks.map((task) => async () =>
    await agent(`Review and fix ${task}`, {
      label: task,
      workspace: "patch",
    }),
  ),
);

phase("Apply");
for (const candidate of candidates) await apply(candidate.patch);

phase("Verify");
return await agent("Run the relevant checks and review the resulting diff.", {
  label: "verification",
  workspace: "shared",
});
```

Do not use `export default`, imports, `globalThis`, ambient time/randomness (`Date.now()`,
`Math.random()`, argless `new Date()`), `require`, `process`, filesystem modules, `fetch`, or network
APIs in the control script. Subagents may use their allowed Pi tools.

## Workspace modes

- Direct `agent()` calls default to `workspace: "shared"` and may edit the project.
- Agents inside `parallel()` and `pipeline()` default to `workspace: "readOnly"`. Their tool list is
  restricted to `read`, `grep`, `find`, `ls`, `web_search`, `web_fetch`, and `view_image` when those
  tools are active in the parent.
- `workspace: "patch"` runs an editing agent in a disposable git worktree and returns
  `{ result, patch }`.
- `await apply(patch)` checks and applies an opaque patch produced by the current run. Applications
  are serialized, abortable, conflict-checked, and one-shot.

Ignored outputs created in patch worktrees are retained as bounded artifacts for inspection but are
not copied into the project.

`agent(prompt, options)` accepts only:

- `label`, `phase`, `schema`, `model`, `thinking`, `workspace`, and `stallMs`;
- thinking levels `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`;
- workspace modes `shared`, `readOnly`, and `patch`.

Subagents inherit the active Pi tool allowlist with `workflow` removed. If no permitted tools remain,
the child runs with `--no-tools`. Unless explicitly overridden, subagent thinking is one level below
the launching session.

`parallel()` and `pipeline()` fail fast. Catch errors inside a branch or stage when best-effort
behavior is intentional.

## Progress and results

Workflow scripts do not define UI. The extension derives one bounded progress/result view directly
from execution:

- metadata phases and the current `phase()`;
- agent calls dynamically created by loops, branches, `parallel()`, and `pipeline()`;
- call state, model, usage, elapsed time, and recent `log()` entries;
- final result, error, and artifact path.

This keeps presentation synchronized with what actually ran. Generic JavaScript control flow that
does not launch an agent or emit a phase/log event intentionally creates no separate UI state.

## Resume

`/workflow resume <runId>` starts a new run from the persisted script and arguments. It never replays
completed agent results. `resumeFromRunId` records lineage only.

## Commands

```text
/workflow
/workflow enable|disable|toggle|status
/workflow list [--running|--completed|--all]
/workflow run <name|scriptPath> [--args <json>] [--await|--async]
/workflow save <runId> [--scope project|user] [--name <slug>]
/workflow resume <runId> [--script <scriptPath>] [--args <json>] [--await|--async]
/workflow pause|continue|stop <runId>
/workflow skip-agent <runId> <callId>
/workflow open <runId> [result|script|journal|transcripts]
/workflow delete <runId>
```

`run` and `resume` default to async mode when Pi has a UI and await mode otherwise.

## Isolation requirements

The control child runs through `systemd-run --user --scope` and `bwrap`, with a private network
namespace, a small filesystem view, and cgroup limits. Launch fails rather than falling back to an
unsandboxed control child.

Required host tools:

- `/usr/bin/systemd-run` from systemd;
- `/usr/bin/bwrap` from bubblewrap.

On Arch/CachyOS: `sudo pacman -S systemd bubblewrap`.

Subagents are separate Pi processes. Patch worktrees isolate repository edits, but shared subagents
are intentionally normal coding agents in the project workspace.

Run `npm install` in this directory after checkout, then `/reload` Pi.
