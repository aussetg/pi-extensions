export const WORKFLOW_TOOL_DESCRIPTION = "Run a deterministic JavaScript workflow that orchestrates multiple Pi subagents. Use only for complex or non-standard orchestration that a single sequential agent cannot handle: explicit workflow requests, fan-out, adversarial verification, broad audits, large migrations, staged repeatable procedures, or telemetry dashboards. Do not use for work that can be done sequentially with normal tools or by one agent.";

export const WORKFLOW_PROMPT_GUIDELINES = [
  "Use workflow only when the task needs complex or non-standard orchestration that one sequential agent cannot reasonably do.",
  "Good workflow cases: explicit workflow requests, fan-out to multiple subagents, adversarial cross-checking, broad repository audits, large migrations with independent phases, repeatable staged procedures, and declarative telemetry dashboards.",
  "Do not use workflow for ordinary sequential work, single-agent tasks, simple audits, quick reads or edits, normal implementation tasks, or anything that can be done with the regular tools in one agent thread.",
  "Workflow scripts are top-level async JavaScript and must begin with literal export const meta = {...} containing non-empty name and description. Do not use export default or wrap the script in a main() function.",
  "Workflow scripts are deterministic: do not use globalThis, Date.now(), Math.random(), argless new Date(), imports, require, process, fs, fetch, or network APIs.",
  "The parser and child VM membrane enforce the deterministic workflow API; bwrap/systemd contain the control child at the OS boundary.",
  "Direct agent() calls use the shared workspace by default. agent() calls inside parallel() and pipeline() default to isolation: 'worktree'. Explicit opts.isolation always wins.",
  "Use parallel() with thunks, for example items.map(item => () => agent(...)); do not pass already-started promises to parallel().",
  "For workflow UI, prefer ui.dashboard({ title, progress, metrics, charts, tables, sections }); repeated calls update the same default dashboard. Use charts for sparklines and tables for bounded row previews. ui.help() returns a tiny reminder.",
  "Strict ui.define({ version: 1, id, title, initialState, layout }) plus ui.update(id, state) is advanced; use it only when you need custom layouts, placement, widgets, completion/artifact views, or expandedLayout.",
  "Use opts.schema for structured subagent results.",
];
