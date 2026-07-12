export const WORKFLOW_TOOL_DESCRIPTION = "Run a deterministic JavaScript workflow that orchestrates multiple Pi subagents. Use only for complex or non-standard orchestration that a single sequential agent cannot handle: explicit workflow requests, fan-out, adversarial verification, broad audits, large migrations, staged repeatable procedures, or telemetry dashboards. Do not use for work that can be done sequentially with normal tools or by one agent.";

export const WORKFLOW_PROMPT_GUIDELINES = [
  "Use workflow only when the task needs complex or non-standard orchestration that one sequential agent cannot reasonably do.",
  "Good workflow cases: explicit workflow requests, fan-out to multiple subagents, adversarial cross-checking, broad repository audits, large migrations with independent phases, repeatable staged procedures, and declarative telemetry dashboards.",
  "Do not use workflow for ordinary sequential work, single-agent tasks, simple audits, quick reads or edits, normal implementation tasks, or anything that can be done with the regular tools in one agent thread.",
  "Workflow scripts are top-level async JavaScript and must begin with literal export const meta = {...} containing non-empty name and description. Do not use export default or wrap the script in a main() function.",
  "Workflow scripts are deterministic: do not use globalThis, Date.now(), Math.random(), argless new Date(), imports, require, process, fs, fetch, or network APIs.",
  "The parser and child VM membrane enforce the deterministic workflow API; bwrap/systemd-run contain the control child at the OS boundary, and launch fails rather than falling back unsandboxed if those host tools are unavailable.",
  "Direct agent() calls default to workspace: 'shared'. Agents inside parallel() and pipeline() default to workspace: 'readOnly', which exposes only read-only tools. Explicit opts.workspace always wins.",
  "agent(prompt, opts) accepts only strict JSON options: label, phase, schema, model, thinking, workspace, agentType, and stallMs. workspace is 'shared', 'readOnly', or 'patch'. Unknown keys or invalid values fail before launch.",
  "Use workspace: 'patch' for isolated editing. It returns { result, patch }; apply the opaque patch with await apply(patch). apply() checks that the patch still applies cleanly before changing the shared workspace and rejects conflicts or duplicate application.",
  "Subagents inherit the currently active tool allowlist with workflow removed; if no non-workflow tools remain, subagents run with no tools rather than default tools.",
  "Subagents default to one thinking level below the session that launched the workflow. Override per call with agent(prompt, { thinking: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }).",
  "Child workflows share the parent budgetTokens and maxAgents limits. Finite token budgets serialize agent starts across parent and child workflows; an over-budget usage report fails the run.",
  "Use parallel() with thunks, for example items.map(item => () => agent(...)); do not pass already-started promises to parallel(). Fan-out is read-only unless an agent explicitly requests workspace: 'patch' or 'shared'.",
  "parallel() and pipeline() fail fast by default. For best-effort fan-out, catch inside each thunk/stage and return explicit ok/error objects.",
  "For workflow UI, prefer ui.dashboard({ title, progress, metrics, charts, tables, sections }); repeated calls update the same default dashboard. Use charts for sparklines and tables for bounded row previews. ui.help() returns a tiny reminder.",
  "UI operations are queued and batched when unawaited. Await ui.define/update/dashboard/patch/close as a persistence barrier, or await ui.flush() after a batch; unhandled UI errors fail the workflow at final flush.",
  "Strict ui.define({ version: 1, id, title, initialState, layout }) plus ui.update(id, state) is advanced; use it only when you need custom layouts, placement, widgets, completion/artifact views, or expandedLayout.",
  "Use opts.schema for structured subagent results.",
];
