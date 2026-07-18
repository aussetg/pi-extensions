import type { WorkflowRunProjection } from "./types.js";
import { boundedWorkflowProjectionText } from "./run-projection.js";

/** Plain deterministic inspector text shared by snapshots, headless output, and the future TUI adapter. */
export function renderWorkflowRunProjection(projection: WorkflowRunProjection): string[] {
  const lines = [
    `${projection.title ?? humanize(projection.workflowName)} · ${projection.status} · ${sumCounts(projection.operationCounts)} operations`,
    `launch · ${projection.launch.authority} · ${projection.launch.exposure} exposure · concurrency ${projection.safety.concurrency}`,
  ];

  for (const resource of projection.resources) {
    const roles = [...new Set(resource.outputs.map(output => `${output.role}:${output.output}`))].join(", ");
    const sites = new Set(resource.outputs.map(output => output.operationSite)).size;
    lines.push(`resource · ${resource.selector} · ${sites} measurement site${sites === 1 ? "" : "s"} · ${roles}`);
  }

  if (projection.operations.length) {
    lines.push("operations");
    for (const operation of projection.operations) {
      const lane = operation.laneKey ? `${operation.laneKey} · ` : "";
      const label = operation.title
        ?? (operation.descriptor?.binding ? humanize(operation.descriptor.binding) : undefined)
        ?? operation.descriptor?.profile
        ?? humanize(operation.kind);
      const operationLabel = label.toLowerCase() === operation.kind.replaceAll("-", " ")
        ? label
        : `${label} · ${operation.kind}`;
      const suffix = [
        operation.replay ? "replayed" : undefined,
        operation.checkpoint ? "checkpoint" : undefined,
      ].filter(Boolean).join(" · ");
      lines.push(`${"  ".repeat(Math.min(operation.depth + 1, 8))}${lane}${safe(operationLabel)} · ${operation.status}${suffix ? ` · ${suffix}` : ""}`);
    }
    if (projection.operationOmittedCount) lines.push(`  … ${projection.operationOmittedCount} operations omitted`);
  }

  for (const metricSet of projection.metricSets) {
    lines.push("metrics");
    for (const metric of metricSet.metrics) {
      lines.push(`  ${safe(metric.title)} · ${metric.role} · baseline ${number(metric.baseline)} · current ${number(metric.current)} · best ${number(metric.best)}${metric.relativeGain === null ? "" : ` · gain ${formatGain(metric.relativeGain)}`}`);
    }
  }

  if (projection.experiments.length) {
    lines.push("experiments");
    projection.experiments.forEach((experiment, index) => {
      lines.push(`  ${index + 1} · ${experiment.disposition} · ${safe(experiment.learned)}`);
    });
  }

  if (projection.candidates.length) {
    lines.push("candidates");
    projection.candidates.forEach((candidate, index) => {
      lines.push(`  ${index + 1} · ${candidate.state} · ${candidate.changedPathCount} paths${candidate.parentCandidateId ? " · based on accepted candidate" : ""}`);
      for (const verification of candidate.verification) {
        lines.push(`    verification · ${verification.status}`);
      }
      if (candidate.measurement) lines.push(`    measurement · ${candidate.measurement.status}`);
      if (candidate.disposition) lines.push(`    disposition · ${candidate.disposition.disposition}`);
      if (candidate.apply) lines.push(`    apply · completed`);
    });
  }

  for (const attention of projection.attention) lines.push(`attention · ${attention.code} · ${safe(attention.summary)}`);
  return lines.map(line => safe(line, 4_096));
}

export function renderWorkflowRunProjectionText(projection: WorkflowRunProjection): string {
  return `${renderWorkflowRunProjection(projection).join("\n")}\n`;
}

function sumCounts(counts: WorkflowRunProjection["operationCounts"]): number {
  return Object.values(counts).reduce((total, value) => total + (value ?? 0), 0);
}
function humanize(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/[-_]+/gu, " ").replace(/(^|\s)\S/gu, part => part.toUpperCase());
}
function number(value: number | null): string { return value === null ? "—" : String(value); }
function formatGain(value: number): string { return `${(value * 100).toFixed(1).replace(/\.0$/u, "")}%`; }
function safe(value: unknown, maximum: number = 512): string { return boundedWorkflowProjectionText(value, maximum); }
