import type { RunRecord } from "../types.js";
import { RENDER_LIMITS } from "../constants.js";
import { padToWidth, sanitizeText, truncateToWidth } from "../utils/truncate.js";
import { isEscape, type ComponentLike } from "./simple-components.js";

export class WorkflowManagerComponent implements ComponentLike {
  private selected = 0;
  private cachedWidth?: number;
  private cachedSelected?: number;
  private cachedLines?: string[];

  constructor(private readonly runs: RunRecord[], private readonly done: (runId?: string) => void, private readonly theme?: any) {}

  handleInput(data: string): void {
    if (isEscape(data)) return this.done();
    if (data === "\r" || data === "\n") return this.done(this.runs[this.selected]?.runId);
    if (data === "\u001b[A") this.selected = Math.max(0, this.selected - 1);
    if (data === "\u001b[B") this.selected = Math.min(Math.max(0, this.runs.length - 1), this.selected + 1);
    this.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width && this.cachedSelected === this.selected) return this.cachedLines;
    const fg = (name: string, text: string) => (this.theme?.fg ? this.theme.fg(name, text) : text);
    const lines = [fg("borderMuted", "─".repeat(Math.max(0, width))), fg("accent", "◆ Workflows"), ""];
    if (this.runs.length === 0) lines.push(fg("dim", "No workflow runs yet."));
    const rows = this.runs.slice(0, RENDER_LIMITS.managerRows);
    rows.forEach((run, index) => {
      const cursor = index === this.selected ? "›" : " ";
      const counts = `${run.progress.completed}/${run.progress.total}`;
      const color = run.status === "completed" ? "success" : run.status === "failed" || run.status === "aborted" ? "error" : index === this.selected ? "accent" : "muted";
      lines.push(fg(color, `${cursor} ${statusIcon(run.status)} ${sanitizeText(run.runId, 100)} ${sanitizeText(run.name, 300)} ${counts} ${run.status}`));
      if (index === this.selected) lines.push(fg("dim", `    ${sanitizeText(run.description, 1000)}`));
    });
    if (this.runs.length > rows.length) lines.push(fg("dim", `… ${this.runs.length - rows.length} more run(s)`));
    lines.push("", fg("dim", "↑↓ select · Enter open result · Esc close"));
    this.cachedLines = lines.map((line) => padToWidth(truncateToWidth(line, width), width));
    this.cachedWidth = width;
    this.cachedSelected = this.selected;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
    this.cachedSelected = undefined;
  }
}

export function formatRunList(runs: RunRecord[]): string {
  if (runs.length === 0) return "No workflow runs.";
  return runs.map((run) => `${run.runId}\t${run.status}\t${run.name}\t${run.progress.completed}/${run.progress.total}\t${run.startedAt}`).join("\n");
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
