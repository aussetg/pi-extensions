import type { RunRecord } from "../types.js";
import { RENDER_LIMITS } from "../constants.js";
import { padToWidth, sanitizeLine, truncateToWidth, visibleWidth } from "../utils/truncate.js";
import type { ComponentLike } from "./simple-components.js";

export class WorkflowManagerComponent implements ComponentLike {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(private readonly runs: RunRecord[], private readonly theme?: any) {}

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const fg = (name: string, text: string) => (this.theme?.fg ? this.theme.fg(name, text) : text);
    const lines = [fg("borderMuted", "─".repeat(Math.max(0, width))), fg("accent", "◆ Workflows"), ""];
    if (this.runs.length === 0) lines.push(fg("dim", "No workflow runs yet."));
    const rows = this.runs.slice(0, RENDER_LIMITS.managerRows);
    rows.forEach((run, index) => {
      const cursor = `${index + 1}.`.padStart(3, " ");
      const counts = `${run.progress.completed}/${run.progress.total}`;
      const color = run.status === "completed" ? "success" : run.status === "failed" || run.status === "aborted" ? "error" : "muted";
      const left = `${cursor} ${statusIcon(run.status)} ${fg(color, sanitizeLine(run.name, 300))} ${fg("dim", sanitizeLine(run.runId, 100))}`;
      const right = fg(color, `${counts} ${run.status}`) + fg("dim", ` ${formatRunAge(run)}`);
      lines.push(joinAligned(left, right, width));
      lines.push(fg("dim", `    ↳ ${sanitizeLine(run.description, 1000)}`));
    });
    if (this.runs.length > rows.length) lines.push(fg("dim", `… ${this.runs.length - rows.length} more run(s)`));
    lines.push("", fg("dim", "Non-interactive preview. Use /workflow open <runId> result to inspect artifacts."));
    this.cachedLines = lines.map((line) => padToWidth(truncateToWidth(line, width), width));
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }
}

export function formatRunList(runs: RunRecord[]): string {
  if (runs.length === 0) return "No workflow runs.";
  return runs.map((run) => `${run.runId}\t${run.status}\t${run.name}\t${run.progress.completed}/${run.progress.total}\t${run.startedAt}`).join("\n");
}

function joinAligned(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  const leftWidth = Math.max(0, width - rightWidth - 1);
  const clippedLeft = truncateToWidth(left, leftWidth, "…");
  const gap = Math.max(1, width - visibleWidth(clippedLeft) - rightWidth);
  return `${clippedLeft}${" ".repeat(gap)}${right}`;
}

function formatRunAge(run: RunRecord): string {
  const raw = run.endedAt ?? run.startedAt;
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

function statusIcon(status: RunRecord["status"]): string {
  switch (status) {
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "aborted":
      return "■";
    case "paused":
      return "Ⅱ";
    case "stale":
      return "?";
    default:
      return "▶";
  }
}
