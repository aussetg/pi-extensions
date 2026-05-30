import type { RunRecord } from "../types.js";
import { RENDER_LIMITS } from "../constants.js";
import { padToWidth, sanitizeText, truncateToWidth, visibleWidth } from "../utils/truncate.js";
import { isClose, isDown, isEnter, isUp, type ComponentLike, type KeybindingsLike } from "./simple-components.js";

export class WorkflowManagerComponent implements ComponentLike {
  private selected = 0;
  private cachedWidth?: number;
  private cachedSelected?: number;
  private cachedLines?: string[];

  constructor(private readonly runs: RunRecord[], private readonly done: (runId?: string) => void, private readonly theme?: any, private readonly keybindings?: KeybindingsLike) {}

  handleInput(data: string): void {
    if (isClose(data, this.keybindings)) return this.done();
    if (isEnter(data, this.keybindings)) return this.done(this.runs[this.selected]?.runId);
    if (isUp(data, this.keybindings)) this.selected = Math.max(0, this.selected - 1);
    if (isDown(data, this.keybindings)) this.selected = Math.min(Math.max(0, this.runs.length - 1), this.selected + 1);
    this.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width && this.cachedSelected === this.selected) return this.cachedLines;
    const fg = (name: string, text: string) => (this.theme?.fg ? this.theme.fg(name, text) : text);
    const bg = (name: string, text: string) => (this.theme?.bg ? this.theme.bg(name, text) : text);
    const bold = (text: string) => (this.theme?.bold ? this.theme.bold(text) : text);
    const selectedLine = (text: string) => bg("selectedBg", padToWidth(truncateToWidth(text, width, ""), width));
    const lines = [fg("borderMuted", "─".repeat(Math.max(0, width))), fg("accent", "◆ Workflows"), ""];
    if (this.runs.length === 0) lines.push(fg("dim", "No workflow runs yet."));
    const rows = this.runs.slice(0, RENDER_LIMITS.managerRows);
    rows.forEach((run, index) => {
      const isSelected = index === this.selected;
      const cursor = isSelected ? fg("accent", "▸") : " ";
      const counts = `${run.progress.completed}/${run.progress.total}`;
      const color = run.status === "completed" ? "success" : run.status === "failed" || run.status === "aborted" ? "error" : isSelected ? "accent" : "muted";
      const left = `${cursor} ${statusIcon(run.status)} ${fg(color, sanitizeText(run.name, 300))} ${fg("dim", sanitizeText(run.runId, 100))}`;
      const right = fg(color, `${counts} ${run.status}`) + fg("dim", ` ${formatRunAge(run)}`);
      lines.push(isSelected ? selectedLine(bold(joinAligned(left, right, width))) : joinAligned(left, right, width));
      if (isSelected) lines.push(selectedLine(fg("dim", `  ↳ ${sanitizeText(run.description, 1000)}`)));
    });
    if (this.runs.length > rows.length) lines.push(fg("dim", `… ${this.runs.length - rows.length} more run(s)`));
    const position = rows.length > 0 ? ` (${this.selected + 1}/${rows.length})` : "";
    lines.push("", fg("dim", `↑↓ select · Enter open result · Esc/Ctrl-C close${position}`));
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
