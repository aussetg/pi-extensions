# Render performance notes

Every component returned by this extension renders from a fixed-size snapshot, not from Pi session history.

- Tool result renderer reads only `WorkflowLaunchOutput.details.progress` and displays the last `RENDER_LIMITS.progressCalls` calls plus the last `RENDER_LIMITS.progressLogs` logs.
- `/workflow` manager receives a precomputed run slice capped by `RENDER_LIMITS.managerRows`; `render(width)` never rescans disk or session entries.
- Workflow UI rendering traverses a validated declarative tree capped by `UI_LIMITS.maxNodeCount` and `UI_LIMITS.maxNodeDepth`.
- Tables, status lists, log tails, sparklines, and pagers all apply fixed row/point/line caps before rendering.
- Custom components cache rendered lines by width and local version/selection state.

So per-frame work is O(1) with respect to Pi session size. It is bounded only by small constants configured in `src/constants.ts`.
