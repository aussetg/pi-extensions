import type { JsonObject, WorkflowFormat, WorkflowLayoutNode, WorkflowViewSnapshot } from "../types.js";
import { RENDER_LIMITS, UI_LIMITS } from "../constants.js";
import { getByPointer } from "../utils/json-pointer.js";
import { clamp, padToWidth, sanitizeText, truncateToWidth, visibleWidth } from "../utils/truncate.js";
import { dashboardPanelLineBudget, dashboardPreview, renderDashboardDocument } from "./dashboard.js";

export type WorkflowViewRenderProfile = "compact" | "panel" | "full";

export class WorkflowViewRenderer {
  render(snapshot: WorkflowViewSnapshot, width = 100, profile: WorkflowViewRenderProfile = "full"): string[] {
    if (profile === "compact") return this.renderCompact(snapshot, width);
    if (profile === "panel") return this.renderPanel(snapshot, width);
    return this.renderFull(snapshot, width);
  }

  renderCompact(snapshot: WorkflowViewSnapshot, width = 80): string[] {
    try {
      const preview = this.firstPreview(snapshot);
      return limitFramedLines(frameLines(`ui: ${sanitizeText(snapshot.spec.title, 200)}`, preview ? [preview] : [], width), width, RENDER_LIMITS.compactViewLines);
    } catch (err) {
      return [padToWidth(`ui renderer error: ${sanitizeText((err as Error).message, 1000)}`, width)];
    }
  }

  renderPanel(snapshot: WorkflowViewSnapshot, width = 100): string[] {
    try {
      const bodyWidth = Math.max(1, width - 2);
      const lineLimit = this.panelLineLimit(snapshot);
      const bodyBudget = Math.max(1, lineLimit - 2);
      const body = truncateBodyLines(this.renderNode(snapshot.spec.layout, snapshot.state, bodyWidth, snapshot, "panel"), bodyBudget, "… full UI persisted as artifact");
      return limitFramedLines(frameLines(sanitizeText(snapshot.spec.title, 200), body, width), width, lineLimit);
    } catch (err) {
      return [padToWidth(`Workflow UI renderer failed: ${sanitizeText((err as Error).message, 1000)}`, width)];
    }
  }

  panelLineLimit(snapshot: WorkflowViewSnapshot): number {
    const bodyLines = this.panelBodyLineLimit(snapshot);
    return Math.max(3, Math.min(UI_LIMITS.maxDashboardPanelLines + 2, bodyLines + 2));
  }

  renderFull(snapshot: WorkflowViewSnapshot, width = 100): string[] {
    try {
      const bodyWidth = Math.max(1, width - 2);
      const layout = snapshot.spec.expandedLayout ?? snapshot.spec.layout;
      const lines = [...(snapshot.spec.description ? [sanitizeText(snapshot.spec.description, 1000), ""] : []), ...this.renderNode(layout, snapshot.state, bodyWidth, snapshot, "full")];
      const framed = frameLines(sanitizeText(snapshot.spec.title, 200), lines, width);
      return framed.slice(0, RENDER_LIMITS.fullViewLines).map((line) => padToWidth(line, width));
    } catch (err) {
      return [padToWidth(`Workflow UI renderer failed: ${sanitizeText((err as Error).message, 1000)}`, width)];
    }
  }

  renderMarkdown(snapshot: WorkflowViewSnapshot): string {
    const lines = this.renderFull(snapshot, 100).map((line) => `    ${line.trimEnd()}`);
    return `## ${sanitizeText(snapshot.spec.title)}\n\n${lines.join("\n")}\n\nFull state is persisted in the workflow UI artifacts.\n`;
  }

  private panelBodyLineLimit(snapshot: WorkflowViewSnapshot): number {
    const dashboard = findFirstDashboard(snapshot.spec.layout);
    if (!dashboard) return Math.max(1, RENDER_LIMITS.panelViewLines - 2);
    return dashboardPanelLineBudget(getByPointer(snapshot.state, dashboard.bind ?? ""), Math.max(1, RENDER_LIMITS.panelViewLines - 2));
  }

  private renderNode(node: WorkflowLayoutNode, state: JsonObject, width: number, snapshot: WorkflowViewSnapshot, profile: Exclude<WorkflowViewRenderProfile, "compact">): string[] {
    switch (node.type) {
      case "vstack":
        return joinBlocks(node.children.map((child) => this.renderNode(child, state, width, snapshot, profile)));
      case "hstack": {
        const cellWidth = columnWidth(width, node.children.length);
        return renderColumns(node.children.map((child) => this.renderNode(child, state, cellWidth, snapshot, profile)), width);
      }
      case "grid":
        return joinBlocks(chunk(node.children, node.columns).map((row) => {
          const cellWidth = columnWidth(width, row.length);
          return renderColumns(row.map((child) => this.renderNode(child, state, cellWidth, snapshot, profile)), width);
        }));
      case "dashboard":
        return renderDashboardDocument(getByPointer(state, node.bind ?? ""), width, { profile, frameTitle: snapshot.spec.title, maxRowsPerSection: snapshot.spec.limits?.maxRows });
      case "text":
        return sanitizeText(node.text).split("\n");
      case "markdown": {
        const text = node.text ?? String(getByPointer(state, node.bind ?? "") ?? "");
        return sanitizeText(text).split("\n").slice(0, boundedCount(node.maxLines, 30, UI_LIMITS.maxRenderedRows));
      }
      case "metric": {
        const value = getByPointer(state, node.bind);
        const status = thresholdStatus(value, node.threshold);
        return [`${status} ${node.label}: ${formatValue(value, node.format)}`];
      }
      case "progress": {
        const percent = node.percentBind ? Number(getByPointer(state, node.percentBind)) : progressPercent(getByPointer(state, node.valueBind ?? ""), getByPointer(state, node.totalBind ?? ""));
        const value = node.valueBind ? Number(getByPointer(state, node.valueBind)) : undefined;
        const total = node.totalBind ? Number(getByPointer(state, node.totalBind)) : undefined;
        const barWidth = Math.max(10, Math.min(30, width - node.label.length - 20));
        const filled = clamp(Math.round((Number.isFinite(percent) ? percent : 0) * barWidth), 0, barWidth);
        const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
        const suffix = Number.isFinite(value) && Number.isFinite(total) ? ` ${value}/${total}` : ` ${Math.round((percent || 0) * 100)}%`;
        return [`${node.label}: ${bar}${suffix}`];
      }
      case "sparkline": {
        const raw = getByPointer(state, node.bind);
        const maxPoints = boundedCount(node.maxPoints ?? snapshot.spec.limits?.maxSeriesPoints, 80, UI_LIMITS.maxSeriesPoints);
        const values = Array.isArray(raw) ? raw.filter((n): n is number => typeof n === "number" && Number.isFinite(n)).slice(-maxPoints) : [];
        return [`${node.label}: ${sparkline(values, Math.max(0, Math.min(50, width - visibleWidth(node.label) - 3)))}`];
      }
      case "table": {
        const raw = getByPointer(state, node.bind);
        return renderTable(node, raw, snapshot, width);
      }
      case "keyValue": {
        const raw = getByPointer(state, node.bind);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["(no key/value data)"];
        return Object.entries(raw as Record<string, unknown>)
          .slice(0, boundedCount(node.maxItems, 30, UI_LIMITS.maxRenderedRows))
          .map(([key, value]) => `${sanitizeText(key, 120)}: ${formatValue(value)}`);
      }
      case "statusList": {
        const raw = getByPointer(state, node.bind);
        const rows = Array.isArray(raw) ? raw.slice(0, boundedCount(node.maxItems, 30, UI_LIMITS.maxRenderedRows)) : [];
        return rows.map((row) => {
          const object = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
          const status = String(object[node.itemStatusKey ?? "status"] ?? "");
          const label = sanitizeText(String(object[node.itemLabelKey ?? "label"] ?? "item"), 300);
          const detail = object[node.itemDetailKey ?? "detail"];
          return `${statusIcon(status)} ${label}${detail === undefined ? "" : ` · ${formatValue(detail)}`}`;
        });
      }
      case "phaseList": {
        const raw = getByPointer(state, "/phases");
        return (Array.isArray(raw) ? raw : []).slice(0, boundedCount(node.maxItems, 20, UI_LIMITS.maxRenderedRows)).map((phase) => `• ${formatValue(phase)}`);
      }
      case "logTail": {
        const raw = getByPointer(state, node.bind ?? "/logs");
        const rows = Array.isArray(raw) ? raw.slice(-boundedCount(node.maxLines, 20, UI_LIMITS.maxRenderedRows)) : [];
        return rows.map((line) => `› ${formatValue(line)}`);
      }
    }
  }

  private firstPreview(snapshot: WorkflowViewSnapshot): string | undefined {
    const dashboard = findFirstDashboard(snapshot.spec.layout);
    if (dashboard) {
      const preview = dashboardPreview(getByPointer(snapshot.state, dashboard.bind ?? ""));
      if (preview) return preview;
    }
    const metric = findFirstMetric(snapshot.spec.layout);
    return metric ? `${sanitizeText(metric.label, 120)}: ${formatValue(getByPointer(snapshot.state, metric.bind), metric.format)}` : undefined;
  }
}

function frameLines(title: string, body: string[], width: number): string[] {
  if (width < 8) return [title, ...body].map((line) => padToWidth(truncateToWidth(line, width), width));
  const inner = Math.max(1, width - 2);
  const label = truncateToWidth(` ${sanitizeText(title, 240)} `, inner, "");
  const top = `┌${label}${"─".repeat(Math.max(0, inner - visibleWidth(label)))}┐`;
  const bottom = `└${"─".repeat(inner)}┘`;
  const rows = body.length > 0 ? body : [""];
  return [top, ...rows.map((line) => `│${padToWidth(line, inner)}│`), bottom].map((line) => padToWidth(line, width));
}

function truncateBodyLines(lines: string[], maxLines: number, notice: string): string[] {
  if (lines.length <= maxLines) return lines;
  if (maxLines <= 0) return [];
  if (maxLines === 1) return [notice];
  return [...lines.slice(0, maxLines - 1), notice];
}

function limitFramedLines(lines: string[], width: number, maxLines: number): string[] {
  return lines.slice(0, maxLines).map((line) => padToWidth(line, width));
}

function joinBlocks(blocks: string[][]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (out.length > 0 && block.length > 0) out.push("");
    out.push(...block);
  }
  return out;
}

function renderColumns(blocks: string[][], width: number): string[] {
  if (blocks.length === 0) return [];
  const gap = "  ";
  const cellWidth = columnWidth(width, blocks.length);
  const height = Math.max(...blocks.map((block) => block.length));
  const out: string[] = [];
  for (let row = 0; row < height; row++) {
    out.push(blocks.map((block) => padToWidth(block[row] ?? "", cellWidth)).join(gap).trimEnd());
  }
  return out;
}

function columnWidth(width: number, columns: number): number {
  const count = Math.max(1, columns);
  const gapWidth = 2 * (count - 1);
  return Math.max(1, Math.floor((Math.max(1, width) - gapWidth) / count));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)));
  return out;
}

function findFirstMetric(node: WorkflowLayoutNode): Extract<WorkflowLayoutNode, { type: "metric" }> | undefined {
  if (node.type === "metric") return node;
  if ("children" in node) for (const child of node.children) {
    const found = findFirstMetric(child);
    if (found) return found;
  }
  return undefined;
}

function findFirstDashboard(node: WorkflowLayoutNode): Extract<WorkflowLayoutNode, { type: "dashboard" }> | undefined {
  if (node.type === "dashboard") return node;
  if ("children" in node) for (const child of node.children) {
    const found = findFirstDashboard(child);
    if (found) return found;
  }
  return undefined;
}

function renderTable(node: Extract<WorkflowLayoutNode, { type: "table" }>, raw: unknown, snapshot: WorkflowViewSnapshot, width: number): string[] {
  const maxRows = boundedCount(node.maxRows ?? snapshot.spec.limits?.maxRows, UI_LIMITS.maxRenderedRows, UI_LIMITS.maxRenderedRows);
  const rows = Array.isArray(raw) ? raw.slice(0, maxRows) : [];
  const widths = tableColumnWidths(node.columns, rows, width);
  const header = renderTableRow(node.columns.map((col) => col.label), widths, width);
  const separator = truncateToWidth(widths.map((w) => "─".repeat(w)).join("─┼─"), width, "");
  const out = [header, separator];

  for (const row of rows) {
    out.push(renderTableRow(node.columns.map((col) => formatValue(getByPointer(row, columnPath(col)), col.format)), widths, width));
  }
  if (Array.isArray(raw) && raw.length > rows.length) out.push(truncateToWidth(`… ${raw.length - rows.length} more row(s)`, width));
  return out;
}

function tableColumnWidths(columns: Extract<WorkflowLayoutNode, { type: "table" }>["columns"], rows: unknown[], width: number): number[] {
  const separatorWidth = Math.max(0, columns.length - 1) * 3;
  const available = Math.max(1, width - separatorWidth);
  const widths = columns.map((col) => {
    if (col.width !== undefined) return clamp(col.width, 1, UI_LIMITS.maxColumnWidth);
    const samples = [col.label, ...rows.map((row) => formatValue(getByPointer(row, columnPath(col)), col.format))];
    return clamp(Math.max(3, ...samples.map((sample) => visibleWidth(oneLine(sample)))), 1, UI_LIMITS.maxColumnWidth);
  });

  while (sum(widths) > available && widths.some((w) => w > 1)) widths[indexOfLargest(widths)]--;

  const flexible = columns.map((col, index) => (col.width === undefined ? index : -1)).filter((index) => index >= 0);
  let guard = available + UI_LIMITS.maxColumnWidth * columns.length;
  while (flexible.length > 0 && sum(widths) < available && guard-- > 0) {
    let changed = false;
    for (const index of flexible) {
      if (sum(widths) >= available) break;
      if (widths[index] >= UI_LIMITS.maxColumnWidth) continue;
      widths[index]++;
      changed = true;
    }
    if (!changed) break;
  }
  return widths;
}

function renderTableRow(cells: string[], widths: number[], width: number): string {
  return truncateToWidth(cells.map((cell, index) => padToWidth(oneLine(cell), widths[index] ?? 1)).join(" │ "), width, "");
}

function columnPath(column: { path?: string; key?: string }): string {
  if (column.path) return column.path;
  if (column.key?.startsWith("/")) return column.key;
  return `/${(column.key ?? "").split(".").map((part) => part.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

function oneLine(value: unknown): string {
  return sanitizeText(value, 500).replace(/\n+/g, " ↵ ");
}

function boundedCount(value: unknown, fallback: number, max: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? Math.min(value as number, max) : fallback;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function indexOfLargest(values: number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

function formatValue(value: unknown, format: WorkflowFormat | string = "text"): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "—";
    switch (format) {
      case "percent":
        return `${(value * 100).toFixed(1)}%`;
      case "duration":
        return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(2)}s`;
      case "bytes":
        return formatUnits(value, ["B", "KB", "MB", "GB"]);
      case "tokens":
        return formatUnits(value, ["", "k", "M"], 1000);
      case "cost":
        return `$${value.toFixed(4)}`;
      default:
        return Number.isInteger(value) ? String(value) : value.toFixed(2);
    }
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return sanitizeText(value, 500);
  return sanitizeText(JSON.stringify(value), 500);
}

function progressPercent(value: unknown, total: unknown): number {
  const v = Number(value);
  const t = Number(total);
  return Number.isFinite(v) && Number.isFinite(t) && t > 0 ? clamp(v / t, 0, 1) : 0;
}

function thresholdStatus(value: unknown, threshold?: { warnAbove?: number; errorAbove?: number; warnBelow?: number; errorBelow?: number }): string {
  const n = Number(value);
  if (!threshold || !Number.isFinite(n)) return "◆";
  if ((threshold.errorAbove !== undefined && n > threshold.errorAbove) || (threshold.errorBelow !== undefined && n < threshold.errorBelow)) return "✗";
  if ((threshold.warnAbove !== undefined && n > threshold.warnAbove) || (threshold.warnBelow !== undefined && n < threshold.warnBelow)) return "!";
  return "✓";
}

function statusIcon(status: string): string {
  const s = status.toLowerCase();
  if (["ok", "pass", "done", "success"].includes(s)) return "✓";
  if (["fail", "failed", "error"].includes(s)) return "✗";
  if (["warn", "warning"].includes(s)) return "!";
  return "•";
}

function sparkline(values: number[], width: number): string {
  if (values.length === 0 || width <= 0) return "(no data)";
  const samples = values.slice(-width);
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const chars = "▁▂▃▄▅▆▇█";
  return samples.map((value) => chars[Math.round(((value - min) / (max - min || 1)) * (chars.length - 1))]).join("");
}

function formatUnits(value: number, units: string[], base = 1024): string {
  let n = value;
  let i = 0;
  while (Math.abs(n) >= base && i < units.length - 1) {
    n /= base;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}
