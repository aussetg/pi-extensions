import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowInspectorPageKind, WorkflowRunProjection } from "../projection/types.js";
import type { WorkflowNamedClient } from "../runtime/named-workflow-types.js";
import { boundedWorkflowProjectionText } from "../projection/run-projection.js";

/** Compact TUI inspector backed exclusively by bounded projections and pages. */
export async function openWorkflowInspector(
  workflows: WorkflowNamedClient,
  runRef: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  for (;;) {
    const projection = await workflows.open(runRef, ctx);
    const actions = choices(projection);
    const selected = await ctx.ui.select(title(projection), actions.map(item => item.label));
    if (selected === undefined || selected === "Close") return;
    const action = actions.find(item => item.label === selected)?.action;
    if (!action) continue;
    if (action.startsWith("page:")) {
      await showPage(workflows, runRef, action.slice(5) as WorkflowInspectorPageKind, ctx);
      continue;
    }
    if (action === "pause" || action === "resume" || action === "stop") {
      const confirmed = action === "stop" ? await ctx.ui.confirm("Stop workflow?", `${projection.workflowId} · ${projection.runId}`) : true;
      if (confirmed) await workflows[action](runRef, ctx);
    }
  }
}

async function showPage(
  workflows: WorkflowNamedClient,
  runRef: string,
  kind: WorkflowInspectorPageKind,
  ctx: ExtensionCommandContext,
): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const page = await workflows.inspectPage(runRef, kind, { ...(cursor ? { cursor } : {}), limit: 32 }, ctx);
    const lines = page.entries.map((entry, index) => `${index + 1}. ${boundedWorkflowProjectionText(JSON.stringify(entry), 1_000)}`);
    const options = [...lines, ...(page.nextCursor ? ["Next page"] : []), "Back"];
    const selected = await ctx.ui.select(`${kind} · r${page.revision}`, options);
    if (selected === undefined || selected === "Back") return;
    if (selected === "Next page" && page.nextCursor) cursor = page.nextCursor;
  }
}

function title(projection: WorkflowRunProjection): string {
  const attention = projection.attention[0]?.summary;
  return `${projection.workflowId} (${projection.shortRunId}) · ${projection.status} · r${projection.revision}${attention ? ` · ${attention}` : ""}`;
}

function choices(projection: WorkflowRunProjection): Array<{ label: string; action: string }> {
  const pages: WorkflowInspectorPageKind[] = ["operations", "attempts", "candidates", "measurements", "experiments", "artifacts", "resources", "events"];
  const result = pages.map(kind => ({ label: `${kind[0]!.toUpperCase()}${kind.slice(1)}`, action: `page:${kind}` }));
  if (projection.status === "running" || projection.status === "queued") result.push({ label: "Pause", action: "pause" });
  if (projection.status === "paused" || projection.status === "waiting") result.push({ label: "Resume", action: "resume" });
  if (!new Set(["completed", "failed", "stopped"]).has(projection.status)) result.push({ label: "Stop", action: "stop" });
  result.push({ label: "Close", action: "close" });
  return result;
}
