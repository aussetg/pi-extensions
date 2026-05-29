import { UI_LIMITS } from "../constants.js";
import type {
  JsonObject,
  JsonValue,
  WorkflowDashboardChart,
  WorkflowDashboardChartDirection,
  WorkflowDashboardChartFormat,
  WorkflowDashboardDocument,
  WorkflowDashboardMetric,
  WorkflowDashboardPanel,
  WorkflowDashboardPanelBlock,
  WorkflowDashboardProgress,
  WorkflowDashboardRow,
  WorkflowDashboardSection,
  WorkflowDashboardTable,
  WorkflowDashboardTableColumn,
  WorkflowDashboardTableRow,
  WorkflowFormat,
} from "../types.js";
import { getByPointer } from "../utils/json-pointer.js";
import { clamp, padToWidth, sanitizeText, truncateToWidth, visibleWidth } from "../utils/truncate.js";

const FORMATS = new Set<WorkflowFormat>(["text", "number", "percent", "duration", "bytes", "tokens", "cost", "status"]);
const CHART_FORMATS = new Set<WorkflowDashboardChartFormat>(["number", "duration", "percent"]);
const CHART_DIRECTIONS = new Set<WorkflowDashboardChartDirection>(["up", "down", "neutral"]);
const PANEL_BLOCKS: WorkflowDashboardPanelBlock[] = ["summary", "progress", "metrics", "charts", "tables", "sections"];
const PANEL_BLOCK_SET = new Set<WorkflowDashboardPanelBlock>(PANEL_BLOCKS);
const BILLBOARD_PANEL_PRIORITY: WorkflowDashboardPanelBlock[] = ["charts", "metrics", "tables", "progress", "sections"];
const LEGACY_PANEL_PRIORITY: WorkflowDashboardPanelBlock[] = ["summary", "progress", "metrics", "sections"];

export interface DashboardRenderOptions {
  profile?: "panel" | "full";
  frameTitle?: string;
  maxSummaryLines?: number;
  maxMetrics?: number;
  maxSections?: number;
  maxRowsPerSection?: number;
  maxLinesPerSection?: number;
  maxPanelLines?: number;
}

export function normalizeDashboardDocument(input: unknown): WorkflowDashboardDocument {
  const object = asRecord(input);
  if (!object) return compactObject({ summary: valueText(input, 1000) }) as WorkflowDashboardDocument;

  return compactObject({
    title: optionalText(object.title, 160),
    status: optionalText(object.status, 80),
    summary: optionalMultilineText(object.summary),
    panel: normalizePanel(object.panel),
    progress: normalizeProgress(object.progress),
    metrics: normalizeMetrics(object.metrics),
    charts: normalizeCharts(object.charts),
    tables: normalizeTables(object.tables),
    sections: normalizeSections(object.sections),
  }) as WorkflowDashboardDocument;
}

export function renderDashboardDocument(input: unknown, width: number, options: DashboardRenderOptions = {}): string[] {
  const doc = normalizeDashboardDocument(input);
  if (options.profile === "panel") return renderDashboardBillboard(doc, Math.max(1, width), options);

  const lines: string[] = [];
  const bodyWidth = Math.max(1, width);
  const frameTitle = sanitizeText(options.frameTitle ?? "", 200).trim();
  const title = sanitizeText(doc.title ?? "", 200).trim();
  const status = sanitizeText(doc.status ?? "", 80).trim();

  if (title && title !== frameTitle) lines.push(titleLine(title, status, bodyWidth));
  else if (status) lines.push(truncateToWidth(`status: ${status}`, bodyWidth));

  if (doc.summary) lines.push(...splitLines(doc.summary, options.maxSummaryLines ?? 6, bodyWidth));
  if (doc.progress) lines.push(renderProgress(doc.progress, bodyWidth));

  const metrics = doc.metrics ?? [];
  if (metrics.length > 0) lines.push(...renderMetrics(metrics, bodyWidth, options.maxMetrics ?? 12));

  const tableLines = renderDashboardTables(doc.tables, bodyWidth);
  if (tableLines.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...tableLines);
  }

  const sections = (doc.sections ?? []).slice(0, bounded(options.maxSections, 8, UI_LIMITS.maxRenderedRows));
  for (const section of sections) {
    const sectionLines = renderSection(section, bodyWidth, options);
    if (sectionLines.length === 0) continue;
    if (lines.length > 0) lines.push("");
    lines.push(...sectionLines);
  }

  if (lines.length === 0) lines.push("(empty dashboard)");
  return lines.map((line) => truncateToWidth(line, bodyWidth));
}

export function dashboardPanelLineBudget(input: unknown, fallback = 8): number {
  return panelLineBudget(normalizeDashboardDocument(input), { maxPanelLines: fallback });
}

export function dashboardPreview(input: unknown): string | undefined {
  const doc = normalizeDashboardDocument(input);
  if (doc.summary) return oneLine(doc.summary, 300);
  if (doc.progress) return progressPreview(doc.progress);
  const metric = doc.metrics?.[0];
  if (metric) return `${sanitizeText(metric.label, 120)}: ${formatDashboardValue(metric.value, metric.format)}`;
  const section = doc.sections?.[0];
  if (section?.summary) return oneLine(section.summary, 300);
  if (section?.title) return sanitizeText(section.title, 160);
  return doc.status ? `status: ${sanitizeText(doc.status, 80)}` : undefined;
}

function renderDashboardBillboard(doc: WorkflowDashboardDocument, width: number, options: DashboardRenderOptions): string[] {
  const bodyWidth = Math.max(1, width);
  const budget = panelLineBudget(doc, options);
  const lines: string[] = [];

  for (const block of panelPriority(doc)) {
    if (lines.length >= budget) break;
    const remaining = budget - lines.length;
    for (const line of renderPanelBlock(block, doc, bodyWidth, remaining, options)) {
      if (lines.length >= budget) break;
      lines.push(truncateToWidth(line, bodyWidth, ""));
    }
  }

  if (lines.length === 0) lines.push("(empty dashboard)");
  return lines.map((line) => truncateToWidth(line, bodyWidth, ""));
}

function renderPanelBlock(block: WorkflowDashboardPanelBlock, doc: WorkflowDashboardDocument, width: number, remaining: number, options: DashboardRenderOptions): string[] {
  if (remaining <= 0) return [];
  switch (block) {
    case "summary":
      return doc.summary ? splitLines(doc.summary, Math.min(remaining, options.maxSummaryLines ?? 2), width) : [];
    case "charts":
      return renderAlignedSparklines(doc.charts, width).slice(0, remaining);
    case "metrics":
      return renderCompactMetrics(doc.metrics, width, options.maxMetrics ?? 8).slice(0, remaining);
    case "tables":
      return renderPanelTables(doc.tables, width, remaining);
    case "progress":
      return doc.progress ? [renderProgress(doc.progress, width)] : [];
    case "sections":
      return renderPanelSections(doc.sections, width, remaining, options);
  }
}

function renderPanelTables(tables: readonly WorkflowDashboardTable[] | undefined, width: number, remaining: number): string[] {
  const lines: string[] = [];
  for (const table of (tables ?? []).slice(0, UI_LIMITS.maxDashboardTables)) {
    const room = remaining - lines.length;
    if (room <= 0) break;
    const fixedRows = (table.title ? 2 : 1); // title + header, or just header
    if (room <= fixedRows) break;
    const maxRows = Math.max(1, Math.min(UI_LIMITS.maxDashboardTableRows, room - fixedRows));
    lines.push(...renderCompactTable({ ...table, maxRows } as WorkflowDashboardTable, width).slice(0, room));
  }
  return lines;
}

function renderPanelSections(sections: readonly WorkflowDashboardSection[] | undefined, width: number, remaining: number, options: DashboardRenderOptions): string[] {
  const lines: string[] = [];
  for (const section of (sections ?? []).slice(0, bounded(options.maxSections, 8, UI_LIMITS.maxRenderedRows))) {
    const room = remaining - lines.length;
    if (room <= 0) break;
    const sectionLines = renderSection(section, width, {
      ...options,
      maxRowsPerSection: Math.min(room, bounded(options.maxRowsPerSection, 4, UI_LIMITS.maxRenderedRows)),
      maxLinesPerSection: Math.min(room, bounded(options.maxLinesPerSection, 4, UI_LIMITS.maxRenderedRows)),
    });
    lines.push(...sectionLines.slice(0, room));
  }
  return lines;
}

function panelLineBudget(doc: WorkflowDashboardDocument, options: DashboardRenderOptions): number {
  const fallback = boundedRange(options.maxPanelLines, 8, UI_LIMITS.minDashboardPanelLines, UI_LIMITS.maxDashboardPanelLines);
  return boundedRange(doc.panel?.lines, fallback, UI_LIMITS.minDashboardPanelLines, UI_LIMITS.maxDashboardPanelLines);
}

function panelPriority(doc: WorkflowDashboardDocument): WorkflowDashboardPanelBlock[] {
  const explicit = doc.panel?.priority;
  if (Array.isArray(explicit) && explicit.length > 0) {
    return explicit.filter((block): block is WorkflowDashboardPanelBlock => PANEL_BLOCK_SET.has(block as WorkflowDashboardPanelBlock)).slice(0, PANEL_BLOCKS.length);
  }
  return doc.charts?.length || doc.tables?.length ? BILLBOARD_PANEL_PRIORITY : LEGACY_PANEL_PRIORITY;
}

function renderSection(section: WorkflowDashboardSection, width: number, options: DashboardRenderOptions): string[] {
  const lines: string[] = [];
  if (section.title) lines.push(sectionTitle(section.title, width));
  if (section.summary) lines.push(...splitLines(section.summary, 4, width));
  if (section.progress) lines.push(renderProgress(section.progress, width));
  if (section.metrics?.length) lines.push(...renderMetrics(section.metrics, width, Math.min(options.maxMetrics ?? 12, 8)));

  const maxRows = bounded(options.maxRowsPerSection, 12, UI_LIMITS.maxRenderedRows);
  const rows = (section.rows ?? []).slice(0, maxRows);
  for (const row of rows) lines.push(renderRow(row, width));
  if ((section.rows?.length ?? 0) > rows.length) lines.push(truncateToWidth(`… ${(section.rows?.length ?? 0) - rows.length} more row(s)`, width));

  const maxLines = bounded(options.maxLinesPerSection, 12, UI_LIMITS.maxRenderedRows);
  const rawLines = section.lines ?? [];
  const logLines = rawLines.slice(-maxLines);
  if (rawLines.length > logLines.length) lines.push(truncateToWidth(`… ${rawLines.length - logLines.length} earlier line(s)`, width));
  for (const line of logLines) lines.push(truncateToWidth(`› ${sanitizeText(line, 1000)}`, width));
  return lines;
}

function renderMetrics(metrics: WorkflowDashboardMetric[], width: number, max: number): string[] {
  const visible = metrics.slice(0, bounded(max, 12, UI_LIMITS.maxRenderedRows));
  const columns = width >= 90 ? 3 : width >= 56 ? 2 : 1;
  const cellWidth = Math.max(1, Math.floor((width - 2 * (columns - 1)) / columns));
  const rows: string[] = [];

  for (let i = 0; i < visible.length; i += columns) {
    const cells = visible.slice(i, i + columns).map((metric) => padToWidth(metricCell(metric), cellWidth));
    rows.push(truncateToWidth(cells.join("  ").trimEnd(), width));
  }
  if (metrics.length > visible.length) rows.push(truncateToWidth(`… ${metrics.length - visible.length} more metric(s)`, width));
  return rows;
}

export function renderAlignedSparklines(charts: readonly WorkflowDashboardChart[] | undefined, width: number): string[] {
  const visible = (charts ?? []).slice(0, UI_LIMITS.maxDashboardCharts).filter((chart) => Array.isArray(chart.values) && chart.values.length > 0);
  if (visible.length === 0) return [];

  const bodyWidth = Math.max(1, width);
  const valueWidth = clamp(Math.max(...visible.map((chart) => visibleWidth(chartValue(chart))), 3), 3, Math.min(12, bodyWidth));
  const maxLabelWidth = Math.max(6, Math.min(18, Math.floor(bodyWidth * 0.28)));
  const labelWidth = clamp(Math.max(...visible.map((chart) => visibleWidth(chartLabel(chart)))), 1, maxLabelWidth);
  const gaps = 4;
  const sparkWidth = Math.max(1, bodyWidth - labelWidth - valueWidth - gaps);

  return visible.map((chart) => {
    const label = padToWidth(truncateToWidth(chartLabel(chart), labelWidth, ""), labelWidth);
    const spark = sparkline(chart.values.slice(-UI_LIMITS.maxDashboardChartPoints), sparkWidth);
    const value = padLeftToWidth(chartValue(chart), valueWidth);
    return truncateToWidth(`${label}  ${spark}  ${value}`, bodyWidth, "");
  });
}

export function renderCompactMetrics(metrics: readonly WorkflowDashboardMetric[] | undefined, width: number, max = 8): string[] {
  const visible = (metrics ?? []).slice(0, bounded(max, 8, UI_LIMITS.maxRenderedRows));
  if (visible.length === 0) return [];

  const bodyWidth = Math.max(1, width);
  const columns = bodyWidth >= 96 ? 4 : bodyWidth >= 72 ? 3 : bodyWidth >= 44 ? 2 : 1;
  const cellWidth = Math.max(1, Math.floor((bodyWidth - 2 * (columns - 1)) / columns));
  const valueWidth = clamp(Math.max(...visible.map((metric) => visibleWidth(metricValue(metric)))), 1, Math.min(12, cellWidth));
  const rows: string[] = [];

  for (let i = 0; i < visible.length; i += columns) {
    const cells = visible.slice(i, i + columns).map((metric) => metricCompactCell(metric, cellWidth, valueWidth));
    rows.push(truncateToWidth(cells.join("  ").trimEnd(), bodyWidth, ""));
  }
  return rows;
}

export function renderCompactTable(table: WorkflowDashboardTable | undefined, width: number): string[] {
  if (!table) return [];
  const bodyWidth = Math.max(1, width);
  const columns = (table.columns ?? []).slice(0, UI_LIMITS.maxDashboardTableColumns).map(normalizeTableColumn).filter((column): column is WorkflowDashboardTableColumn => column !== undefined);
  if (columns.length === 0) return [];
  const rowLimit = bounded(table.maxRows, UI_LIMITS.maxDashboardTableRows, UI_LIMITS.maxDashboardTableRows);
  const rows = (Array.isArray(table.rows) ? table.rows : []).slice(0, rowLimit);
  const widths = compactTableColumnWidths(columns, rows, bodyWidth);
  const numeric = columns.map((column) => isNumericTableColumn(column, rows));
  const out: string[] = [];

  if (table.title) out.push(sectionTitle(table.title, bodyWidth));
  out.push(renderCompactTableRow(columns.map((column) => tableColumnLabel(column)), widths, numeric.map(() => false), bodyWidth));
  for (const row of rows) {
    out.push(renderCompactTableRow(columns.map((column) => formatDashboardValue(tableCellValue(row, column), column.format)), widths, numeric, bodyWidth));
  }
  return out;
}

function renderDashboardTables(tables: readonly WorkflowDashboardTable[] | undefined, width: number): string[] {
  const out: string[] = [];
  for (const table of (tables ?? []).slice(0, UI_LIMITS.maxDashboardTables)) {
    const lines = renderDashboardTable(table, width);
    if (lines.length === 0) continue;
    if (out.length > 0) out.push("");
    out.push(...lines);
  }
  return out;
}

function renderDashboardTable(table: WorkflowDashboardTable, width: number): string[] {
  const bodyWidth = Math.max(1, width);
  const columns = (table.columns ?? []).slice(0, UI_LIMITS.maxDashboardTableColumns).map(normalizeTableColumn).filter((column): column is WorkflowDashboardTableColumn => column !== undefined);
  if (columns.length === 0) return [];
  const rowLimit = bounded(table.maxRows, UI_LIMITS.maxDashboardTableRows, UI_LIMITS.maxDashboardTableRows);
  const rows = (Array.isArray(table.rows) ? table.rows : []).slice(0, rowLimit);
  const widths = compactTableColumnWidths(columns, rows, bodyWidth);
  const numeric = columns.map((column) => isNumericTableColumn(column, rows));
  const out: string[] = [];

  if (table.title) out.push(sectionTitle(table.title, bodyWidth));
  out.push(renderCompactTableRow(columns.map((column) => tableColumnLabel(column)), widths, numeric.map(() => false), bodyWidth));
  out.push(renderTableSeparator(widths, bodyWidth));
  for (const row of rows) {
    out.push(renderCompactTableRow(columns.map((column) => formatDashboardValue(tableCellValue(row, column), column.format)), widths, numeric, bodyWidth));
  }
  return out;
}

function renderTableSeparator(widths: number[], width: number): string {
  return truncateToWidth(widths.map((columnWidth) => "─".repeat(columnWidth)).join("──"), width, "");
}

function chartLabel(chart: WorkflowDashboardChart): string {
  return sanitizeText(chart.label ?? "chart", 120).replace(/\n+/g, " ↵ ");
}

function chartValue(chart: WorkflowDashboardChart): string {
  return formatCompactDashboardValue(chart.value ?? chart.values.at(-1), chart.format);
}

function metricValue(metric: WorkflowDashboardMetric): string {
  return formatCompactDashboardValue(metric.value, metric.format);
}

function metricCompactCell(metric: WorkflowDashboardMetric, cellWidth: number, valueWidth: number): string {
  const value = padLeftToWidth(metricValue(metric), Math.min(valueWidth, cellWidth));
  if (cellWidth <= valueWidth + 1) return padToWidth(value, cellWidth);
  const labelWidth = Math.max(1, cellWidth - valueWidth - 1);
  const label = padToWidth(truncateToWidth(sanitizeText(metric.label, 120), labelWidth, ""), labelWidth);
  return padToWidth(`${label} ${value}`, cellWidth);
}

function sparkline(values: readonly number[], width: number): string {
  if (width <= 0) return "";
  const samples = values.filter((n) => Number.isFinite(n)).slice(-width);
  if (samples.length === 0) return padToWidth("", width);
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const chars = "▁▂▃▄▅▆▇█";
  const line = samples.map((value) => chars[Math.round(((value - min) / (max - min || 1)) * (chars.length - 1))]).join("");
  return padToWidth(line, width);
}

function compactTableColumnWidths(columns: WorkflowDashboardTableColumn[], rows: WorkflowDashboardTableRow[], width: number): number[] {
  const gapWidth = Math.max(0, columns.length - 1) * 2;
  const available = Math.max(1, width - gapWidth);
  const widths = columns.map((column) => {
    if (column.width !== undefined) return clamp(column.width, 1, UI_LIMITS.maxColumnWidth);
    const samples = [tableColumnLabel(column), ...rows.map((row) => formatDashboardValue(tableCellValue(row, column), column.format))];
    return clamp(Math.max(1, ...samples.map((sample) => visibleWidth(oneLine(sample, 500)))), 1, UI_LIMITS.maxColumnWidth);
  });

  while (sum(widths) > available && widths.some((w) => w > 1)) widths[indexOfLargest(widths)]--;
  return widths;
}

function renderCompactTableRow(cells: string[], widths: number[], rightAlign: boolean[], width: number): string {
  const rendered = cells.map((cell, index) => {
    const columnWidth = widths[index] ?? 1;
    const text = oneLine(cell, 500);
    return rightAlign[index] ? padLeftToWidth(text, columnWidth) : padToWidth(text, columnWidth);
  });
  return truncateToWidth(rendered.join("  ").trimEnd(), width, "");
}

function tableColumnLabel(column: WorkflowDashboardTableColumn): string {
  return sanitizeText(column.label ?? columnLabel(column.path ?? column.key ?? "column"), 80);
}

function tableCellValue(row: unknown, column: WorkflowDashboardTableColumn): unknown {
  if (column.path) return safeGetByPointer(row, column.path);
  if (!column.key || !row || typeof row !== "object" || Array.isArray(row)) return undefined;
  const object = row as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(object, column.key)) return object[column.key];
  return column.key.split(".").reduce<unknown>((current, part) => current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>)[part] : undefined, object);
}

function isNumericTableColumn(column: WorkflowDashboardTableColumn, rows: WorkflowDashboardTableRow[]): boolean {
  if (["number", "percent", "duration", "bytes", "tokens", "cost"].includes(column.format ?? "")) return true;
  const values = rows.map((row) => tableCellValue(row, column)).filter((value) => value !== undefined && value !== null);
  return values.length > 0 && values.every((value) => typeof value === "number" && Number.isFinite(value));
}

function safeGetByPointer(root: unknown, pointer: string): unknown {
  try {
    return getByPointer(root, pointer);
  } catch {
    return undefined;
  }
}

function formatCompactDashboardValue(value: unknown, format: WorkflowFormat | string = "text"): string {
  if (typeof value === "number" && Number.isFinite(value) && format === "percent") return `${Math.round(value * 100)}%`;
  return formatDashboardValue(value, format);
}

function padLeftToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "");
  return `${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}${clipped}`;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function indexOfLargest(values: number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

function metricCell(metric: WorkflowDashboardMetric): string {
  const status = metric.status ? `[${sanitizeText(metric.status, 40)}] ` : "";
  const detail = metric.detail ? ` · ${sanitizeText(metric.detail, 200)}` : "";
  return `${status}${sanitizeText(metric.label, 120)}: ${formatDashboardValue(metric.value, metric.format)}${detail}`;
}

function renderRow(row: WorkflowDashboardRow, width: number): string {
  const label = rowLabel(row);
  const status = row.status ? `[${sanitizeText(row.status, 40)}] ` : "";
  const value = row.value === undefined ? "" : `: ${formatDashboardValue(row.value)}`;
  const detail = row.detail === undefined ? "" : ` · ${formatDashboardValue(row.detail)}`;
  if (label) return truncateToWidth(`${status}${label}${value}${detail}`, width);

  const cells = Object.entries(row)
    .filter(([key]) => !["status", "detail", "value"].includes(key))
    .slice(0, 5)
    .map(([key, value]) => `${sanitizeText(key, 60)}: ${formatDashboardValue(value)}`);
  return truncateToWidth(`${status}${cells.length > 0 ? cells.join(" · ") : formatDashboardValue(row.value ?? row.detail ?? "")}`, width);
}

function renderProgress(progress: WorkflowDashboardProgress, width: number): string {
  const label = sanitizeText(progress.label ?? "Progress", 80);
  const percent = progressPercent(progress);
  const barWidth = Math.max(8, Math.min(30, width - visibleWidth(label) - 20));
  const filled = clamp(Math.round(percent * barWidth), 0, barWidth);
  const bar = `${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`;
  const suffix = typeof progress.value === "number" && typeof progress.total === "number" ? ` ${formatNumber(progress.value)}/${formatNumber(progress.total)}` : ` ${Math.round(percent * 100)}%`;
  const detail = progress.detail ? ` · ${sanitizeText(progress.detail, 200)}` : "";
  return truncateToWidth(`${label}: ${bar}${suffix}${detail}`, width);
}

function progressPreview(progress: WorkflowDashboardProgress): string {
  const label = sanitizeText(progress.label ?? "Progress", 80);
  if (typeof progress.value === "number" && typeof progress.total === "number") return `${label}: ${formatNumber(progress.value)}/${formatNumber(progress.total)}`;
  return `${label}: ${Math.round(progressPercent(progress) * 100)}%`;
}

function titleLine(title: string, status: string, width: number): string {
  return status ? truncateToWidth(`${title} · ${status}`, width) : truncateToWidth(title, width);
}

function sectionTitle(title: string, width: number): string {
  return truncateToWidth(`▸ ${sanitizeText(title, 160)}`, width);
}

function splitLines(text: string, maxLines: number, width: number): string[] {
  const lines = sanitizeText(text, 4000).split("\n").slice(0, Math.max(1, maxLines));
  return lines.map((line) => truncateToWidth(line, width));
}

function normalizePanel(input: unknown): WorkflowDashboardPanel | undefined {
  const object = asRecord(input);
  if (!object) return undefined;

  const panel = compactObject({
    lines: boundedRangeOptional(object.lines ?? object.maxLines, UI_LIMITS.minDashboardPanelLines, UI_LIMITS.maxDashboardPanelLines),
    priority: normalizePanelPriority(object.priority ?? object.order),
  });
  return Object.keys(panel).length > 0 ? panel as WorkflowDashboardPanel : undefined;
}

function normalizePanelPriority(input: unknown): WorkflowDashboardPanelBlock[] | undefined {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[\s,]+/) : [];
  const out: WorkflowDashboardPanelBlock[] = [];
  for (const item of raw) {
    const block = normalizePanelBlock(item);
    if (!block || out.includes(block)) continue;
    out.push(block);
    if (out.length >= PANEL_BLOCKS.length) break;
  }
  return out.length > 0 ? out : undefined;
}

function normalizePanelBlock(input: unknown): WorkflowDashboardPanelBlock | undefined {
  const value = optionalText(input, 40)?.toLowerCase();
  if (!value) return undefined;
  const alias = value === "chart" ? "charts" : value === "table" ? "tables" : value === "section" ? "sections" : value;
  return PANEL_BLOCK_SET.has(alias as WorkflowDashboardPanelBlock) ? alias as WorkflowDashboardPanelBlock : undefined;
}

function normalizeCharts(input: unknown): WorkflowDashboardChart[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const charts = input
    .slice(0, UI_LIMITS.maxDashboardCharts)
    .map(normalizeChart)
    .filter((chart): chart is WorkflowDashboardChart => chart !== undefined);
  return charts.length > 0 ? charts : undefined;
}

function normalizeChart(input: unknown, index: number): WorkflowDashboardChart | undefined {
  const object = asRecord(input);
  const rawValues = Array.isArray(input) ? input : object?.values ?? object?.series ?? object?.data ?? object?.points;
  const values = normalizeNumberSeries(rawValues, UI_LIMITS.maxDashboardChartPoints);
  if (values.length === 0) return undefined;

  const format = typeof object?.format === "string" && CHART_FORMATS.has(object.format as WorkflowDashboardChartFormat) ? object.format as WorkflowDashboardChartFormat : undefined;
  const direction = typeof object?.direction === "string" && CHART_DIRECTIONS.has(object.direction as WorkflowDashboardChartDirection) ? object.direction as WorkflowDashboardChartDirection : undefined;
  const explicitValue = object ? toJsonValue(object.value ?? object.current ?? object.latest ?? object.last) : undefined;

  return compactObject({
    type: "sparkline",
    label: optionalText(object?.label ?? object?.name ?? object?.title, 120) ?? `chart ${index + 1}`,
    values,
    format,
    direction,
    value: explicitValue ?? values.at(-1),
    status: optionalText(object?.status, 80),
    detail: optionalText(object?.detail ?? object?.description, 240),
  }) as WorkflowDashboardChart;
}

function normalizeNumberSeries(input: unknown, maxPoints: number): number[] {
  if (!Array.isArray(input)) return [];
  return input
    .map(finiteNumber)
    .filter((n): n is number => n !== undefined)
    .slice(-maxPoints);
}

function normalizeTables(input: unknown): WorkflowDashboardTable[] | undefined {
  const tablesInput = Array.isArray(input)
    ? input
    : Object.entries(asRecord(input) ?? {}).map(([title, value]) => ({ title, ...(asRecord(value) ?? { rows: value }) }));
  const tables = tablesInput
    .slice(0, UI_LIMITS.maxDashboardTables)
    .map(normalizeTable)
    .filter((table): table is WorkflowDashboardTable => table !== undefined);
  return tables.length > 0 ? tables : undefined;
}

function normalizeTable(input: unknown, index: number): WorkflowDashboardTable | undefined {
  const object = asRecord(input);
  const rawRows = object ? object.rows ?? object.items ?? object.data : input;
  const rowLimit = bounded(object?.maxRows ?? object?.limit, UI_LIMITS.maxDashboardTableRows, UI_LIMITS.maxDashboardTableRows);
  const rows = normalizeTableRows(rawRows, rowLimit);
  const columns = normalizeTableColumns(object?.columns ?? object?.cols, rows);
  if (columns.length === 0) return undefined;

  const table: Record<string, JsonValue> = {
    columns: columns as unknown as JsonValue[],
    rows: rows as unknown as JsonValue[],
    maxRows: rowLimit,
  };
  const title = optionalText(object?.title ?? object?.name, 160) ?? (index === 0 ? undefined : `Table ${index + 1}`);
  if (title) table.title = title;
  return table as WorkflowDashboardTable;
}

function normalizeTableRows(input: unknown, maxRows: number): WorkflowDashboardTableRow[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, maxRows).map(normalizeTableRow);
}

function normalizeTableRow(input: unknown, index: number): WorkflowDashboardTableRow {
  const object = asRecord(input);
  if (!object) return compactObject({ value: (toJsonValue(input) ?? valueText(input, 500)) || `row ${index + 1}` }) as WorkflowDashboardTableRow;
  const row: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(object).slice(0, 32)) {
    const json = toJsonValue(value);
    if (json !== undefined) row[key] = json;
  }
  return row as WorkflowDashboardTableRow;
}

function normalizeTableColumns(input: unknown, rows: WorkflowDashboardTableRow[]): WorkflowDashboardTableColumn[] {
  const raw = Array.isArray(input) ? input : deriveTableColumns(rows);
  return raw
    .slice(0, UI_LIMITS.maxDashboardTableColumns)
    .map(normalizeTableColumn)
    .filter((column): column is WorkflowDashboardTableColumn => column !== undefined);
}

function deriveTableColumns(rows: WorkflowDashboardTableRow[]): string[] {
  const first = rows.find((row) => row && typeof row === "object" && !Array.isArray(row));
  return first ? Object.keys(first).slice(0, UI_LIMITS.maxDashboardTableColumns) : [];
}

function normalizeTableColumn(input: unknown): WorkflowDashboardTableColumn | undefined {
  if (typeof input === "string" || typeof input === "number") return tableColumnFromKey(String(input));
  const object = asRecord(input);
  if (!object) return undefined;

  const rawPath = optionalText(object.path ?? object.pointer, 160);
  const rawKey = optionalText(object.key ?? object.name ?? object.id, 120);
  const path = rawPath?.startsWith("/") ? rawPath : undefined;
  const key = path ? undefined : rawKey ?? rawPath;
  if (!path && !key) return undefined;

  const format = typeof object.format === "string" && FORMATS.has(object.format as WorkflowFormat) ? object.format as WorkflowFormat : undefined;
  const column = compactObject({
    ...(path ? { path } : { key }),
    label: optionalText(object.label ?? object.title, 80) ?? columnLabel(path ?? key ?? "column"),
    format,
    width: boundedOptional(object.width, UI_LIMITS.maxColumnWidth),
  });
  return column as WorkflowDashboardTableColumn;
}

function tableColumnFromKey(raw: string): WorkflowDashboardTableColumn | undefined {
  const key = optionalText(raw, 120);
  if (!key) return undefined;
  const field = key.startsWith("/") ? { path: key } : { key };
  return compactObject({ ...field, label: columnLabel(key) }) as WorkflowDashboardTableColumn;
}

function columnLabel(key: string): string {
  const leaf = key.split(/[/.]/).filter(Boolean).at(-1) ?? key;
  const spaced = leaf.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return optionalText(spaced.replace(/^./, (char) => char.toUpperCase()), 80) ?? "Column";
}

function normalizeProgress(input: unknown): WorkflowDashboardProgress | undefined {
  if (typeof input === "number" && Number.isFinite(input)) return compactObject({ percent: normalizePercent(input) }) as WorkflowDashboardProgress;
  const object = asRecord(input);
  if (!object) return undefined;
  const progress = compactObject({
    label: optionalText(object.label ?? object.title, 80),
    value: finiteNumber(object.value ?? object.current ?? object.done ?? object.complete ?? object.step),
    total: finiteNumber(object.total ?? object.max),
    percent: finiteNumber(object.percent ?? object.pct) === undefined ? undefined : normalizePercent(finiteNumber(object.percent ?? object.pct)!),
    detail: optionalText(object.detail ?? object.summary, 240),
  });
  return Object.keys(progress).length > 0 ? progress as WorkflowDashboardProgress : undefined;
}

function normalizeMetrics(input: unknown): WorkflowDashboardMetric[] | undefined {
  if (Array.isArray(input)) return input.map(normalizeMetric).filter(Boolean).slice(0, UI_LIMITS.maxRenderedRows) as WorkflowDashboardMetric[];
  const object = asRecord(input);
  if (!object) return undefined;
  return Object.entries(object)
    .slice(0, UI_LIMITS.maxRenderedRows)
    .map(([key, value]) => compactObject({ label: key, value: toJsonValue(value) ?? valueText(value, 500) }) as WorkflowDashboardMetric);
}

function normalizeMetric(input: unknown, index: number): WorkflowDashboardMetric | undefined {
  const object = asRecord(input);
  if (!object) return compactObject({ label: `metric ${index + 1}`, value: toJsonValue(input) ?? valueText(input, 500) }) as WorkflowDashboardMetric;
  const format = typeof object.format === "string" && FORMATS.has(object.format as WorkflowFormat) ? object.format : undefined;
  return compactObject({
    label: optionalText(object.label ?? object.name ?? object.title, 120) ?? `metric ${index + 1}`,
    value: toJsonValue(object.value ?? object.current ?? object.total ?? object.summary),
    format,
    status: optionalText(object.status, 80),
    detail: optionalText(object.detail ?? object.description, 240),
  }) as WorkflowDashboardMetric;
}

function normalizeSections(input: unknown): WorkflowDashboardSection[] | undefined {
  if (Array.isArray(input)) return input.map(normalizeSection).filter(Boolean).slice(0, UI_LIMITS.maxRenderedRows) as WorkflowDashboardSection[];
  const object = asRecord(input);
  if (!object) return undefined;
  return Object.entries(object)
    .slice(0, UI_LIMITS.maxRenderedRows)
    .map(([key, value]) => normalizeSection({ title: key, ...(asRecord(value) ?? { summary: valueText(value, 1000) }) }))
    .filter(Boolean) as WorkflowDashboardSection[];
}

function normalizeSection(input: unknown, index = 0): WorkflowDashboardSection | undefined {
  const object = asRecord(input);
  if (!object) return compactObject({ title: `Section ${index + 1}`, summary: valueText(input, 1000) }) as WorkflowDashboardSection;
  return compactObject({
    title: optionalText(object.title ?? object.name, 160),
    summary: optionalMultilineText(object.summary ?? object.text),
    progress: normalizeProgress(object.progress),
    metrics: normalizeMetrics(object.metrics),
    rows: normalizeRows(object.rows ?? object.items ?? object.checks),
    lines: normalizeLines(object.lines ?? object.log ?? object.logs),
  }) as WorkflowDashboardSection;
}

function normalizeRows(input: unknown): WorkflowDashboardRow[] | undefined {
  if (!Array.isArray(input)) return undefined;
  return input.map(normalizeRow).slice(0, UI_LIMITS.maxRenderedRows);
}

function normalizeRow(input: unknown, index: number): WorkflowDashboardRow {
  const object = asRecord(input);
  if (!object) return compactObject({ label: valueText(input, 500) || `row ${index + 1}` }) as WorkflowDashboardRow;
  const row: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(object).slice(0, 16)) {
    const json = toJsonValue(value);
    if (json !== undefined) row[key] = json;
  }
  for (const [key, max] of [["label", 200], ["name", 200], ["title", 200], ["status", 80], ["detail", 500]] as const) {
    if (object[key] !== undefined) row[key] = optionalText(object[key], max) ?? "";
  }
  return row as WorkflowDashboardRow;
}

function normalizeLines(input: unknown): string[] | undefined {
  if (typeof input === "string") return sanitizeText(input, 4000).split("\n").slice(0, UI_LIMITS.maxRenderedRows);
  if (!Array.isArray(input)) return undefined;
  return input.map((line) => valueText(line, 1000)).slice(0, UI_LIMITS.maxRenderedRows);
}

function rowLabel(row: WorkflowDashboardRow): string | undefined {
  const raw = row.label ?? row.name ?? row.title;
  return raw === undefined ? undefined : sanitizeText(raw, 240);
}

function progressPercent(progress: WorkflowDashboardProgress): number {
  if (typeof progress.percent === "number" && Number.isFinite(progress.percent)) return clamp(progress.percent, 0, 1);
  if (typeof progress.value === "number" && typeof progress.total === "number" && Number.isFinite(progress.value) && Number.isFinite(progress.total) && progress.total > 0) return clamp(progress.value / progress.total, 0, 1);
  return 0;
}

function normalizePercent(value: number): number {
  return clamp(value > 1 && value <= 100 ? value / 100 : value, 0, 1);
}

function formatDashboardValue(value: unknown, format: WorkflowFormat | string = "text"): string {
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
        return formatNumber(value);
    }
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return sanitizeText(value, 500).replace(/\n+/g, " ↵ ");
  return sanitizeText(safeJsonStringify(value), 500);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
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

function optionalText(value: unknown, maxBytes: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = sanitizeText(value, maxBytes).trim();
  return text === "" ? undefined : text;
}

function optionalMultilineText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = Array.isArray(value) ? value.map((item) => valueText(item, 1000)).join("\n") : sanitizeText(value, 4000);
  return text.trim() === "" ? undefined : text;
}

function oneLine(value: unknown, maxBytes: number): string {
  return sanitizeText(value, maxBytes).replace(/\n+/g, " ↵ ");
}

function valueText(value: unknown, maxBytes: number): string {
  if (typeof value === "string") return sanitizeText(value, maxBytes);
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return sanitizeText(safeJsonStringify(value), maxBytes);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function compactObject(object: Record<string, unknown>): JsonObject {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const json = toJsonValue(value);
    if (json !== undefined) out[key] = json;
  }
  return out;
}

function toJsonValue(value: unknown, depth = 0): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (depth > 4) return valueText(value, 500);
  if (Array.isArray(value)) return value.slice(0, Math.max(UI_LIMITS.maxRenderedRows, UI_LIMITS.maxDashboardChartPoints)).map((item) => toJsonValue(item, depth + 1) ?? null);
  const object = asRecord(value);
  if (!object) return undefined;
  const out: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(object).slice(0, 32)) {
    const json = toJsonValue(child, depth + 1);
    if (json !== undefined) out[key] = json;
  }
  return out;
}

function bounded(value: unknown, fallback: number, max: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? Math.min(value as number, max) : fallback;
}

function boundedOptional(value: unknown, max: number): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : undefined;
}

function boundedRange(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? clamp(n, min, max) : fallback;
}

function boundedRangeOptional(value: unknown, min: number, max: number): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? clamp(n, min, max) : undefined;
}
