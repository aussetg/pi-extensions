import { describe, expect, it } from "vitest";
import { RENDER_LIMITS, UI_LIMITS } from "../src/constants.js";
import type { WorkflowLaunchOutput } from "../src/types.js";
import { WorkflowViewRenderer } from "../src/ui/workflow-view-renderer.js";
import { WorkflowViewValidator } from "../src/ui/workflow-view-validator.js";
import { renderWorkflowCall, renderWorkflowResult } from "../src/tool/workflow-tool-renderer.js";
import { normalizeDashboardDocument, renderAlignedSparklines, renderCompactMetrics, renderCompactTable } from "../src/ui/dashboard.js";
import { renderWorkflowResultMessage } from "../src/ui/messages.js";
import { renderWorkflowResultLines, WorkflowProgressComponent, WorkflowResultComponent } from "../src/ui/workflow-result-component.js";
import { WorkflowViewComponent } from "../src/ui/workflow-view-widget.js";
import { visibleWidth } from "../src/utils/truncate.js";

const spec = {
  version: 1,
  id: "perf",
  title: "Benchmark telemetry",
  initialState: { complete: 1, total: 2, medianMs: 123, rows: [{ target: "parser", medianMs: 123 }] },
  layout: {
    type: "vstack",
    children: [
      { type: "progress", label: "Benchmarks", valueBind: "/complete", totalBind: "/total" },
      { type: "metric", label: "Median", bind: "/medianMs", format: "duration" },
      { type: "table", bind: "/rows", columns: [{ path: "/target", label: "Target" }, { path: "/medianMs", label: "Median", format: "duration" }] },
    ],
  },
} as const;

describe("workflow UI", () => {
  it("validates and renders bounded lines", () => {
    const validator = new WorkflowViewValidator();
    const checked = validator.validateSpec(spec);
    const state = validator.validateState(checked, spec.initialState);
    const lines = new WorkflowViewRenderer().renderFull({ spec: checked, state, seq: 0 }, 80);
    expect(lines.join("\n")).toContain("Median");
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("lays out grid children in columns", () => {
    const gridSpec = {
      version: 1,
      id: "grid",
      title: "Grid",
      initialState: { a: 1, b: 2, c: 3 },
      layout: {
        type: "grid",
        columns: 3,
        children: [
          { type: "metric", label: "A", bind: "/a" },
          { type: "metric", label: "B", bind: "/b" },
          { type: "metric", label: "C", bind: "/c" },
        ],
      },
    } as const;
    const checked = new WorkflowViewValidator().validateSpec(gridSpec);
    const state = new WorkflowViewValidator().validateState(checked, gridSpec.initialState);
    const lines = new WorkflowViewRenderer().renderFull({ spec: checked, state, seq: 0 }, 100);
    const metricLine = lines.find((line) => line.includes("A:") && line.includes("B:") && line.includes("C:"));
    expect(metricLine).toBeTruthy();
  });

  it("validates and renders normalized dashboard documents", () => {
    const checked = new WorkflowViewValidator().validateSpec({
      version: 1,
      id: "dashboard",
      title: "Dashboard",
      initialState: {
        title: "Live dashboard",
        status: "running",
        summary: "Streaming telemetry",
        progress: { label: "Ticks", value: 2, total: 4 },
        metrics: [
          { label: "Latency", value: 123, format: "duration" },
          { label: "Rows", value: 8, format: "number" },
        ],
        sections: [
          {
            title: "Checklist",
            rows: [
              { label: "define dashboard", status: "done" },
              { label: "stream updates", status: "running", detail: "2/4" },
            ],
          },
          { title: "Log", lines: ["tick 1", "tick 2"] },
        ],
      },
      layout: { type: "dashboard" },
    });

    const lines = new WorkflowViewRenderer().renderFull({ spec: checked, state: checked.initialState!, seq: 0 }, 88);
    const text = lines.join("\n");
    expect(text).toContain("Streaming telemetry");
    expect(text).toContain("Ticks:");
    expect(text).toContain("Latency: 123ms");
    expect(text).toContain("▸ Checklist");
    expect(text).toContain("[done] define dashboard");
    expect(text).toContain("› tick 2");
    expect(lines.every((line) => visibleWidth(line) <= 88)).toBe(true);
  });

  it("normalizes natural dashboard charts, tables, and panel hints within fixed caps", () => {
    const columns = ["lane", "score", "risk", "move", "owner", "eta", "extra"];
    const rows = Array.from({ length: UI_LIMITS.maxDashboardTableRows + 8 }, (_, index) => ({
      lane: `lane-${index}`,
      score: index,
      risk: index / 100,
      move: "ship",
      owner: "pi",
      eta: "now",
      extra: "hidden",
    }));

    const doc = normalizeDashboardDocument({
      title: "Bounded dashboard",
      panel: { lines: 999, priority: ["charts", "table", "metrics", "nope", "charts"] },
      charts: Array.from({ length: UI_LIMITS.maxDashboardCharts + 3 }, (_, index) => ({
        label: `chart-${index}`,
        values: Array.from({ length: UI_LIMITS.maxDashboardChartPoints + 20 }, (_ignored, point) => point),
        format: "percent",
        direction: index % 2 === 0 ? "up" : "down",
      })),
      tables: Array.from({ length: UI_LIMITS.maxDashboardTables + 2 }, (_, index) => ({ title: `table-${index}`, columns, rows, maxRows: 999 })),
    });

    expect(doc.panel).toEqual({ lines: UI_LIMITS.maxDashboardPanelLines, priority: ["charts", "tables", "metrics"] });
    expect(doc.charts).toHaveLength(UI_LIMITS.maxDashboardCharts);
    expect(doc.charts?.[0].values).toHaveLength(UI_LIMITS.maxDashboardChartPoints);
    expect(doc.charts?.[0].values[0]).toBe(20);
    expect(doc.tables).toHaveLength(UI_LIMITS.maxDashboardTables);
    expect(doc.tables?.[0].rows).toHaveLength(UI_LIMITS.maxDashboardTableRows);
    expect(doc.tables?.[0].columns).toHaveLength(UI_LIMITS.maxDashboardTableColumns);
    expect(doc.tables?.[0].maxRows).toBe(UI_LIMITS.maxDashboardTableRows);

    expect(normalizeDashboardDocument({ panel: { lines: 1 } }).panel?.lines).toBe(UI_LIMITS.minDashboardPanelLines);
  });

  it("renders aligned dashboard sparklines, compact metrics, and compact tables", () => {
    const doc = normalizeDashboardDocument({
      charts: [
        { label: "Launch", values: [0.1, 0.2, 0.3, 0.5, 0.7, 0.79], value: 0.79, format: "percent" },
        { label: "Confidence", values: [0.2, 0.28, 0.35, 0.5, 0.72, 0.68], value: 0.72, format: "percent" },
        { label: "Risk", values: [0.9, 0.75, 0.55, 0.3, 0.19, 0.22], value: 0.19, format: "percent" },
      ],
      metrics: { agents: "5/5", signal: "79%", risk: "19%", confidence: "72%" },
      tables: [{
        columns: ["lane", { key: "score", format: "number" }, { key: "risk", format: "percent" }, "move"],
        maxRows: 2,
        rows: [
          { lane: "visual", score: 86, risk: 0.18, move: "crop tighter" },
          { lane: "trust", score: 81, risk: 0.22, move: "show agents" },
          { lane: "hidden", score: 1, risk: 0.99, move: "this row must not affect width" },
        ],
      }],
    });

    const chartLines = renderAlignedSparklines(doc.charts, 44);
    const sparkStarts = chartLines.map((line) => line.search(/[▁▂▃▄▅▆▇█]/));
    const valueStarts = chartLines.map((line) => line.search(/\d+%\s*$/));
    expect(new Set(sparkStarts).size).toBe(1);
    expect(new Set(valueStarts).size).toBe(1);
    expect(chartLines.every((line) => visibleWidth(line) <= 44)).toBe(true);

    const metricLines = renderCompactMetrics(doc.metrics, 64, 4);
    expect(metricLines.join("\n")).toContain("agents");
    expect(metricLines.every((line) => visibleWidth(line) <= 64)).toBe(true);

    const tableLines = renderCompactTable(doc.tables?.[0], 64);
    expect(tableLines.join("\n")).toContain("visual");
    expect(tableLines.join("\n")).not.toContain("hidden");
    expect(tableLines.every((line) => visibleWidth(line) <= 64)).toBe(true);
  });

  it("uses the compact billboard renderer for dashboard panels", () => {
    const checked = new WorkflowViewValidator().validateSpec({
      version: 1,
      id: "billboard",
      title: "Billboard",
      initialState: normalizeDashboardDocument({
        charts: [
          { label: "Launch", values: [0.1, 0.2, 0.4, 0.79], value: 0.79, format: "percent" },
          { label: "Risk", values: [0.7, 0.4, 0.2, 0.19], value: 0.19, format: "percent" },
        ],
        metrics: { agents: "5/5", signal: "79%" },
        tables: [{ columns: ["lane", "score", "risk", "move"], rows: [{ lane: "visual", score: 86, risk: "18%", move: "crop" }] }],
        progress: { label: "Launch sequence", value: 4, total: 4 },
        sections: [{ title: "Log", lines: ["should not fit before higher priority blocks"] }],
      }),
      layout: { type: "dashboard" },
    });

    const panel = new WorkflowViewRenderer().renderPanel({ spec: checked, state: checked.initialState!, seq: 0 }, 90);
    const text = panel.join("\n");
    const chartIndex = text.indexOf("Launch");
    const metricIndex = text.indexOf("agents");
    const tableIndex = text.indexOf("Lane");
    const progressIndex = text.indexOf("Launch sequence");

    expect(chartIndex).toBeGreaterThanOrEqual(0);
    expect(metricIndex).toBeGreaterThan(chartIndex);
    expect(tableIndex).toBeGreaterThan(metricIndex);
    expect(progressIndex).toBeGreaterThan(tableIndex);
    expect(text.indexOf("should not fit")).toBeGreaterThan(progressIndex);
    expect(panel.every((line) => visibleWidth(line) <= 90)).toBe(true);
  });

  it("lets natural dashboards raise the bounded panel line budget", () => {
    const initialState = normalizeDashboardDocument({
      panel: { lines: 16 },
      charts: [
        { label: "Launch", values: [0.1, 0.2, 0.4, 0.79], value: 0.79, format: "percent" },
        { label: "Risk", values: [0.7, 0.4, 0.2, 0.19], value: 0.19, format: "percent" },
      ],
      metrics: { agents: "5/5", signal: "79%", risk: "19%", confidence: "72%" },
      tables: [{ columns: ["lane", "score", "risk", "move"], rows: Array.from({ length: 12 }, (_, i) => ({ lane: `lane-${i}`, score: 80 + i, risk: `${i}%`, move: "ship" })) }],
      progress: { label: "Launch sequence", value: 4, total: 4 },
    });
    const checked = new WorkflowViewValidator().validateSpec({ version: 1, id: "deep_billboard", title: "Deep billboard", initialState, layout: { type: "dashboard" } });
    const snapshot = { spec: checked, state: checked.initialState!, seq: 0 };

    const panel = new WorkflowViewRenderer().renderPanel(snapshot, 92);
    expect(panel.length).toBeGreaterThan(RENDER_LIMITS.panelViewLines);
    expect(panel.length).toBeLessThanOrEqual(16 + 2);
    expect(panel.join("\n")).toContain("lane-5");

    const resultPanel = renderWorkflowResultLines(sampleWorkflowDetails({ status: "completed", uiViews: [snapshot] }), { profile: "panel" }, undefined, 92);
    expect(resultPanel.length).toBeGreaterThan(RENDER_LIMITS.panelViewLines);
    expect(resultPanel.length).toBeLessThanOrEqual(UI_LIMITS.maxDashboardPanelLines + 2);
    expect(resultPanel.join("\n")).toContain("lane-5");
  });

  it("renders natural dashboard tables fully in expanded dashboard views", () => {
    const rows = Array.from({ length: UI_LIMITS.maxDashboardTableRows + 4 }, (_, index) => ({
      lane: `lane-${index}`,
      score: 80 + index,
      risk: index / 100,
      move: `move-${index}`,
    }));
    const checked = new WorkflowViewValidator().validateSpec({
      version: 1,
      id: "natural_table",
      title: "Natural table",
      initialState: normalizeDashboardDocument({
        title: "Table dashboard",
        tables: [{ title: "Agent lanes", columns: ["lane", { key: "score", format: "number" }, { key: "risk", format: "percent" }, "move"], rows, maxRows: 999 }],
      }),
      layout: { type: "dashboard" },
    });

    const full = new WorkflowViewRenderer().renderFull({ spec: checked, state: checked.initialState!, seq: 0 }, 88);
    const text = full.join("\n");

    expect(text).toContain("▸ Agent lanes");
    expect(text).toContain("Lane");
    expect(text).toContain("Score");
    expect(text).toContain("Risk");
    expect(text).toContain("lane-11");
    expect(text).not.toContain("lane-12");
    expect(text).toContain("────────");
    expect(full.every((line) => visibleWidth(line) <= 88)).toBe(true);
  });

  it("uses layout for panel rendering and expandedLayout for full rendering", () => {
    const checked = new WorkflowViewValidator().validateSpec({
      version: 1,
      id: "expanded",
      title: "Expanded UI",
      initialState: { summary: "compact summary", details: "expanded detail", count: 3 },
      layout: { type: "markdown", bind: "/summary", maxLines: 2 },
      expandedLayout: {
        type: "vstack",
        children: [
          { type: "markdown", bind: "/details", maxLines: 2 },
          { type: "metric", label: "Count", bind: "/count", format: "number" },
        ],
      },
    });
    const snapshot = { spec: checked, state: checked.initialState!, seq: 0 };
    const renderer = new WorkflowViewRenderer();

    const panel = renderer.renderPanel(snapshot, 80).join("\n");
    const full = renderer.renderFull(snapshot, 80).join("\n");

    expect(panel).toContain("compact summary");
    expect(panel).not.toContain("expanded detail");
    expect(full).toContain("expanded detail");
    expect(full).toContain("Count: 3");
    expect(full).not.toContain("compact summary");
  });

  it("keeps UI result artifacts as a compact hint when expanded", () => {
    const details = sampleWorkflowDetails({
      status: "completed",
      uiViews: [{
        seq: 0,
        spec: {
          version: 1,
          id: "view",
          title: "View",
          initialState: { summary: "visible UI" },
          layout: { type: "markdown", bind: "/summary" },
          expandedLayout: { type: "markdown", text: "expanded UI" },
        },
        state: { summary: "visible UI" },
      }],
    });

    const expanded = renderWorkflowResult({ details }, { expanded: true, isPartial: false }).render(88).join("\n");

    expect(expanded).toContain("expanded UI");
    expect(expanded).toContain("artifacts:");
    expect(expanded).not.toContain("┌ Artifacts");
    expect(expanded).not.toContain("result payload");
  });

  it("renders dashboard nodes defensively for odd JSON", () => {
    const checked = new WorkflowViewValidator().validateSpec({
      version: 1,
      id: "defensive_dashboard",
      title: "Defensive dashboard",
      initialState: {
        nested: {
          summary: ["alpha", "beta"],
          progress: 200,
          metrics: { huge: "x".repeat(500), ok: true },
          sections: { Odd: { rows: ["plain row", { anything: { nested: [1, 2, 3] } }], lines: "one\ntwo" } },
        },
      },
      layout: { type: "dashboard", bind: "/nested" },
    });

    const renderer = new WorkflowViewRenderer();
    const panel = renderer.renderPanel({ spec: checked, state: checked.initialState!, seq: 0 }, 40);
    const compact = renderer.renderCompact({ spec: checked, state: checked.initialState!, seq: 0 }, 40);

    expect(panel.join("\n")).toContain("alpha");
    expect(compact.join("\n")).toContain("alpha");
    expect([...panel, ...compact].every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  it("rejects executable fields", () => {
    const bad = { version: 1, id: "bad", title: "Bad", layout: { type: "metric", label: "x", bind: "/x", onClick: "() => 1" } };
    expect(() => new WorkflowViewValidator().validateSpec(bad)).toThrow(/unsupported key/);
  });

  it("caps over-eager UI limits instead of failing the workflow", () => {
    const checked = new WorkflowViewValidator().validateSpec({
      ...spec,
      id: "fast",
      limits: { updateHz: 60, maxRows: 10_000, maxSeriesPoints: 10_000 },
    });

    expect(checked.limits).toEqual({ updateHz: 4, maxRows: 500, maxSeriesPoints: 500 });
  });

  it("normalizes node limits and renders table columns by JSON pointer", () => {
    const checked = new WorkflowViewValidator().validateSpec({
      version: 1,
      id: "table_paths",
      title: "Table paths",
      initialState: { rows: [{ target: "parser", stats: { medianMs: 123 }, status: "pass" }] },
      layout: {
        type: "table",
        bind: "/rows",
        maxRows: 10_000,
        columns: [
          { path: "/target", label: "Target", width: 10_000 },
          { path: "/stats/medianMs", label: "Median", format: "duration" },
        ],
      },
    });

    expect(checked.layout.type).toBe("table");
    if (checked.layout.type !== "table") return;
    expect(checked.layout.maxRows).toBe(UI_LIMITS.maxRenderedRows);
    expect(checked.layout.columns[0].width).toBe(UI_LIMITS.maxColumnWidth);

    const lines = new WorkflowViewRenderer().renderFull({ spec: checked, state: checked.initialState!, seq: 0 }, 80);
    expect(lines.join("\n")).toContain("123ms");
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("normalizes table key fields to JSON pointers", () => {
    const checked = new WorkflowViewValidator().validateSpec({
      version: 1,
      id: "legacy_table",
      title: "Legacy table",
      initialState: { rows: [{ target: "parser", stats: { medianMs: 123 } }] },
      layout: { type: "table", bind: "/rows", columns: [{ key: "target", label: "Target" }, { key: "stats.medianMs", label: "Median", format: "duration" }] },
    });

    expect(checked.layout.type).toBe("table");
    if (checked.layout.type !== "table") return;
    expect(checked.layout.columns.map((column) => column.path)).toEqual(["/target", "/stats/medianMs"]);
    expect(checked.layout.columns.some((column) => "key" in column)).toBe(false);
    expect(new WorkflowViewRenderer().renderFull({ spec: checked, state: checked.initialState!, seq: 0 }, 80).join("\n")).toContain("123ms");
  });

  it("preserves trusted theme styling while capping visible width", () => {
    const component = renderWorkflowCall({ name: "demo" }, { fg: (_name: string, text: string) => `\u001b[31m${text}\u001b[0m` });
    const [line] = component.render(20);
    expect(line).toContain("\u001b[31m");
    expect(visibleWidth(line)).toBeLessThanOrEqual(20);
  });

  it("renders the standard workflow dashboard as a filled frame", () => {
    const startedAt = new Date(Date.now() - 90_000).toISOString();
    const lines = renderWorkflowResultLines({
      status: "async_launched",
      taskId: "task",
      runId: "run_test",
      name: "migration",
      description: "Port a feature in phases",
      phases: [{ title: "Inventory" }, { title: "Migration" }],
      summary: "running",
      scriptPath: "/tmp/script.js",
      transcriptDir: "/tmp/subagents",
      startedAt,
      progress: {
        total: 2,
        running: 1,
        completed: 1,
        failed: 0,
        cached: 0,
        skipped: 0,
        phase: "Migration",
        calls: [
          { callId: "0001", label: "inventory", phase: "Inventory", status: "done", startedAt, endedAt: new Date().toISOString() },
          { callId: "0002", label: "migrate ui", phase: "Migration", status: "running", startedAt },
        ],
        recentLogs: [],
        updatedAt: new Date().toISOString(),
      },
    }, { partial: true }, undefined, 96);

    expect(lines.join("\n")).toContain("Phases");
    expect(lines.join("\n")).toContain("Migration");
    expect(lines.every((line) => visibleWidth(line) === 96)).toBe(true);
  });

  it("renders per-agent usage telemetry in workflow progress rows", () => {
    const startedAt = new Date(0).toISOString();
    const endedAt = new Date(28_000).toISOString();
    const lines = renderWorkflowResultLines({
      status: "completed",
      taskId: "task",
      runId: "run_usage",
      name: "usage_dashboard",
      description: "Render per-agent usage",
      phases: [{ title: "Implementation" }],
      summary: "done",
      scriptPath: "/tmp/script.js",
      transcriptDir: "/tmp/subagents",
      startedAt,
      endedAt,
      usage: { agentCount: 1, subagentTokens: 48_700, toolUses: 9, durationMs: 28_000, estimated: false },
      progress: {
        total: 1,
        running: 0,
        completed: 1,
        failed: 0,
        cached: 0,
        skipped: 0,
        phase: "Implementation",
        calls: [{
          callId: "0001",
          label: "implementation",
          phase: "Implementation",
          model: "opus-test",
          status: "done",
          startedAt,
          endedAt,
          usage: { agentCount: 1, subagentTokens: 48_700, toolUses: 9, durationMs: 28_000, estimated: false },
        }],
        recentLogs: [],
        updatedAt: endedAt,
      },
    }, { profile: "full", partial: true }, undefined, 140);

    const text = lines.join("\n");
    expect(text).toContain("opus-test");
    expect(text).toContain("48.7k tok");
    expect(text).toContain("9 tools");
    expect(text).toContain("28s");
    expect(lines.every((line) => visibleWidth(line) <= 140)).toBe(true);
  });

  it("uses the two-pane phase/agent dashboard for wide collapsed workflow progress", () => {
    const details = wideWorkflowProgressDetails();

    const lines = renderWorkflowResultLines(details, { profile: "panel", partial: true }, undefined, 140);
    const text = lines.join("\n");

    expect(text).toContain("Phases");
    expect(text).toContain("Infrastructure");
    expect(text).toContain("infra:tsconfig.json");
    expect(text).toContain("Opus 4.8");
    expect(text).toContain("48.7k tok");
    expect(text).toContain("9 tools");
    expect(lines.length).toBeLessThanOrEqual(RENDER_LIMITS.workflowPanelLines);
    expect(lines.every((line) => visibleWidth(line) <= 140)).toBe(true);

    const component = new WorkflowProgressComponent(() => details);
    const liveLines = component.render(140);
    expect(liveLines.join("\n")).toContain("Phases");
    expect(liveLines.join("\n")).toContain("infra:tsconfig.json");
    expect(liveLines.length).toBeLessThanOrEqual(RENDER_LIMITS.workflowPanelLines);
    expect(liveLines.every((line) => visibleWidth(line) <= 140)).toBe(true);
  });

  it("uses readable themed borders for nested progress frames", () => {
    const theme = {
      fg: (name: string, text: string) => `\u001b[${name === "muted" ? 2 : name === "accent" ? 33 : name === "success" ? 32 : 90}m${text}\u001b[0m`,
      bold: (text: string) => text,
    };
    const text = renderWorkflowResultLines(wideWorkflowProgressDetails(), { profile: "panel", partial: true }, theme, 140).join("\n");

    expect(text).toContain("\u001b[2m┌ Phases");
    expect(text).toContain("\u001b[2m│\u001b[0m");
    expect(text).toContain("\u001b[33m▶ 0004");
  });

  it("marks passed no-agent phases and terminal current phase as done", () => {
    const startedAt = new Date(0).toISOString();
    const endedAt = new Date(8_000).toISOString();
    const details: WorkflowLaunchOutput = {
      status: "completed",
      taskId: "task",
      runId: "run_phase_done",
      name: "phase_done",
      description: "Exercise phase completion without agents in every phase",
      phases: [{ title: "Start" }, { title: "Checks" }, { title: "Done" }],
      summary: "done",
      scriptPath: "/tmp/script.js",
      transcriptDir: "/tmp/subagents",
      outputPath: "/tmp/output.json",
      startedAt,
      endedAt,
      progress: {
        total: 2,
        running: 0,
        completed: 2,
        failed: 0,
        cached: 0,
        skipped: 0,
        phase: "Done",
        calls: [
          { callId: "0001", label: "readability", phase: "Checks", status: "done", startedAt, endedAt },
          { callId: "0002", label: "surface", phase: "Checks", status: "done", startedAt, endedAt },
        ],
        recentLogs: [],
        updatedAt: endedAt,
      },
    };

    const text = renderWorkflowResultLines(details, { profile: "panel" }, undefined, 140).join("\n");

    expect(text).toContain("✓ 1 Start");
    expect(text).toContain("✓ 2 Checks");
    expect(text).toContain("✓ 3 Done");
    expect(text).toContain("Agents · 2");
    expect(text).not.toContain("Done · 2 agents");
  });

  it("keeps the framed phase layout before any agents start", () => {
    const startedAt = new Date(0).toISOString();
    const details: WorkflowLaunchOutput = {
      status: "async_launched",
      taskId: "task",
      runId: "run_no_agents_yet",
      name: "no_agents_yet",
      description: "Exercise early phase layout",
      phases: [{ title: "Warmup" }, { title: "Quiet ticker" }, { title: "Checks" }],
      summary: "running",
      scriptPath: "/tmp/script.js",
      transcriptDir: "/tmp/subagents",
      startedAt,
      progress: {
        total: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cached: 0,
        skipped: 0,
        phase: "Quiet ticker",
        calls: [],
        recentLogs: ["Quiet ticker has no agents; Warmup should now show done"],
        updatedAt: startedAt,
      },
    };

    const lines = renderWorkflowResultLines(details, { profile: "panel", partial: true }, undefined, 140);
    const text = lines.join("\n");

    expect(text).toContain("┌ Phases");
    expect(text).toContain("┌ Activity");
    expect(text).toContain("✓ 1 Warmup");
    expect(text).toContain("› 2 Quiet ticker");
    expect(text).toContain("No agents have started yet.");
    expect(text).toContain("log: Quiet ticker has no agents");
    expect(text).toContain("└");
    expect(text).not.toContain("more line(s)");
    expect(lines.length).toBeLessThanOrEqual(RENDER_LIMITS.workflowPanelLines);
    expect(lines.every((line) => visibleWidth(line) <= 140)).toBe(true);
  });

  it("marks the active phase as failed when the workflow fails outside an agent", () => {
    const details = wideWorkflowProgressDetails();
    const failed: WorkflowLaunchOutput = {
      ...details,
      status: "failed",
      progress: { ...details.progress!, phase: "Verify & Report", failed: 0, running: 0 },
      error: "token budget exhausted",
    };

    const text = renderWorkflowResultLines(failed, { profile: "panel" }, undefined, 140).join("\n");

    expect(text).toContain("✗ 6 Verify & Report");
  });

  it("keeps narrow collapsed workflow progress compact", () => {
    const lines = renderWorkflowResultLines(wideWorkflowProgressDetails(), { profile: "panel", partial: true }, undefined, 72);
    const text = lines.join("\n");

    expect(text).toContain("progress:");
    expect(text).not.toContain("┌ Phases");
    expect(lines.length).toBeLessThanOrEqual(RENDER_LIMITS.panelViewLines);
    expect(lines.every((line) => visibleWidth(line) <= 72)).toBe(true);
  });

  it("keeps live custom UI visible after the default wide progress panel", () => {
    const checked = new WorkflowViewValidator().validateSpec({
      version: 1,
      id: "custom_live",
      title: "Custom live",
      placement: "runPanel",
      initialState: { summary: "custom telemetry" },
      layout: { type: "markdown", bind: "/summary", maxLines: 1 },
    });
    const details = { ...wideWorkflowProgressDetails(), uiViews: [{ spec: checked, state: checked.initialState!, seq: 1 }] };

    const lines = renderWorkflowResultLines(details, { profile: "panel", partial: true }, undefined, 140);
    const text = lines.join("\n");

    expect(text).toContain("Phases");
    expect(text).toContain("Custom live");
    expect(lines.length).toBeLessThanOrEqual(RENDER_LIMITS.workflowPanelLines);
    expect(lines.every((line) => visibleWidth(line) <= 140)).toBe(true);
  });

  it("renders workflow views through compact, panel, and full profiles", () => {
    const checked = new WorkflowViewValidator().validateSpec({
      version: 1,
      id: "profiles",
      title: "Profiles",
      initialState: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`m${i}`, i])),
      layout: {
        type: "vstack",
        children: Array.from({ length: 20 }, (_, i) => ({ type: "metric", label: `Metric ${i}`, bind: `/m${i}` })),
      },
    });
    const snapshot = { spec: checked, state: checked.initialState!, seq: 0 };
    const renderer = new WorkflowViewRenderer();

    const compact = renderer.render(snapshot, 72, "compact");
    const panel = renderer.render(snapshot, 72, "panel");
    const full = renderer.render(snapshot, 72, "full");

    expect(compact.length).toBeLessThanOrEqual(RENDER_LIMITS.compactViewLines);
    expect(panel.length).toBeLessThanOrEqual(RENDER_LIMITS.panelViewLines);
    expect(full.length).toBeGreaterThan(panel.length);
    expect([...compact, ...panel, ...full].every((line) => visibleWidth(line) <= 72)).toBe(true);
    expect(panel.join("\n")).toContain("full UI persisted");
  });

  it("renders workflow results through compact, panel, and full profiles", () => {
    const details = sampleWorkflowDetails({ status: "async_launched" });

    const compact = renderWorkflowResultLines(details, { profile: "compact" }, undefined, 80);
    const panel = renderWorkflowResultLines(details, { profile: "panel" }, undefined, 80);
    const full = renderWorkflowResultLines(details, { profile: "full", partial: true }, undefined, 80);

    expect(compact.length).toBeLessThanOrEqual(RENDER_LIMITS.compactViewLines);
    expect(panel.length).toBeLessThanOrEqual(RENDER_LIMITS.panelViewLines);
    expect(full.length).toBeGreaterThan(panel.length);
    expect(panel.join("\n")).toContain("progress");
    expect([...compact, ...panel, ...full].every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("live view components shrink instead of preserving previous height", () => {
    const renderer = new WorkflowViewRenderer();
    const large = new WorkflowViewValidator().validateSpec({
      version: 1,
      id: "large_live",
      title: "Large live",
      initialState: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`m${i}`, i])),
      layout: {
        type: "vstack",
        children: Array.from({ length: 20 }, (_, i) => ({ type: "metric", label: `Metric ${i}`, bind: `/m${i}` })),
      },
    });
    const small = new WorkflowViewValidator().validateSpec({
      version: 1,
      id: "small_live",
      title: "Small live",
      initialState: { value: 1 },
      layout: { type: "metric", label: "Value", bind: "/value" },
    });
    const component = new WorkflowViewComponent({ spec: large, state: large.initialState!, seq: 0 }, renderer, "panel");
    const tall = component.render(80);
    component.update({ spec: small, state: small.initialState!, seq: 1 });
    const short = component.render(80);

    expect(tall.length).toBe(RENDER_LIMITS.panelViewLines);
    expect(short.length).toBeLessThan(tall.length);
    expect(short.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("standard progress widget uses the panel profile and shrinks", () => {
    let details = sampleWorkflowDetails({ status: "async_launched" });
    const component = new WorkflowProgressComponent(() => details);
    const tall = component.render(80);
    details = {
      ...details,
      progress: {
        total: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cached: 0,
        skipped: 0,
        calls: [],
        recentLogs: [],
        updatedAt: new Date(Date.now() + 1).toISOString(),
      },
    };
    component.invalidate();
    const short = component.render(80);

    expect(tall.length).toBeLessThanOrEqual(RENDER_LIMITS.panelViewLines);
    expect(short.length).toBeLessThan(tall.length);
    expect([...tall, ...short].every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("maps tool renderer expanded and partial flags to safe profiles", () => {
    const details = sampleWorkflowDetails({ status: "completed" });

    const collapsed = renderWorkflowResult({ details }, { expanded: false, isPartial: false }).render(80);
    const expanded = renderWorkflowResult({ details }, { expanded: true, isPartial: false }).render(80);
    const partialCollapsed = renderWorkflowResult({ details }, { expanded: false, isPartial: true }).render(80);
    const partialExpanded = renderWorkflowResult({ details }, { expanded: true, isPartial: true }).render(80);

    expect(collapsed.length).toBeLessThanOrEqual(RENDER_LIMITS.panelViewLines);
    expect(partialCollapsed.length).toBeLessThanOrEqual(RENDER_LIMITS.panelViewLines);
    expect(partialExpanded.length).toBeLessThanOrEqual(RENDER_LIMITS.panelViewLines);
    expect(collapsed.join("\n")).toContain("progress");
    expect(partialCollapsed).toEqual(partialExpanded);
    expect(expanded.join("\n")).toContain("Artifacts");
    expect(partialExpanded.join("\n")).not.toContain("Artifacts");
    expect(expanded.length).toBeGreaterThan(collapsed.length);
    expect([...collapsed, ...expanded, ...partialCollapsed, ...partialExpanded].every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("updates a reused workflow result component with fresh partial details", () => {
    const first = sampleWorkflowDetails({ status: "async_launched" });
    const second = {
      ...first,
      progress: {
        ...first.progress!,
        phase: "Second phase",
        calls: first.progress!.calls.map((call, index, calls) => index === calls.length - 1 ? { ...call, label: "fresh partial row" } : call),
        updatedAt: new Date(Date.now() + 10_000).toISOString(),
      },
    };

    const component = renderWorkflowResult({ details: first }, { expanded: false, isPartial: true }) as WorkflowResultComponent;
    expect(component.render(100).join("\n")).not.toContain("fresh partial row");
    const reused = renderWorkflowResult({ details: second }, { expanded: false, isPartial: true }, undefined, { lastComponent: component });

    expect(reused).toBe(component);
    expect(component.render(100).join("\n")).toContain("fresh partial row");
  });

  it("keeps result JSON previews out of the collapsed workflow panel", () => {
    const details = sampleWorkflowDetails({ status: "completed", resultPreview: '{\n  "checks": ["ok"],\n  "verdict": "done"\n}' });

    const panel = renderWorkflowResultLines(details, { profile: "panel" }, undefined, 100).join("\n");
    const full = renderWorkflowResultLines(details, { profile: "full" }, undefined, 100).join("\n");

    expect(panel).not.toContain("result:");
    expect(panel).not.toContain('"checks"');
    expect(full).toContain("Result");
    expect(full).toContain('"checks"');
  });

  it("maps workflow result message expansion to panel and full profiles", () => {
    const details = sampleWorkflowDetails({ status: "completed" });

    const collapsed = renderWorkflowResultMessage({ details, content: details.summary }, { expanded: false }).render(80);
    const expanded = renderWorkflowResultMessage({ details, content: details.summary }, { expanded: true }).render(80);

    expect(collapsed.length).toBeLessThanOrEqual(RENDER_LIMITS.panelViewLines);
    expect(collapsed.join("\n")).not.toContain("Artifacts");
    expect(expanded.join("\n")).toContain("Artifacts");
    expect(expanded.length).toBeGreaterThan(collapsed.length);
    expect([...collapsed, ...expanded].every((line) => visibleWidth(line) <= 80)).toBe(true);
  });
});

function sampleWorkflowDetails(overrides: Partial<WorkflowLaunchOutput> = {}): WorkflowLaunchOutput {
  const startedAt = new Date(Date.now() - 90_000).toISOString();
  const status = overrides.status ?? "completed";
  return {
    status,
    taskId: "task",
    runId: "run_profiles",
    name: "profiles",
    description: "Exercise bounded profiles",
    summary: "running",
    scriptPath: "/tmp/script.js",
    transcriptDir: "/tmp/subagents",
    outputPath: "/tmp/output.json",
    resultPreview: "result payload",
    startedAt,
    endedAt: status === "async_launched" ? undefined : new Date().toISOString(),
    progress: {
      total: 12,
      running: status === "async_launched" ? 1 : 0,
      completed: status === "async_launched" ? 7 : 12,
      failed: status === "failed" ? 1 : 0,
      cached: 0,
      skipped: 0,
      phase: "Migration",
      calls: Array.from({ length: 12 }, (_, i) => ({
        callId: String(i + 1).padStart(4, "0"),
        label: `agent ${i + 1}`,
        phase: "Migration",
        status: status === "async_launched" && i === 11 ? "running" : "done",
        startedAt,
        endedAt: status === "async_launched" && i === 11 ? undefined : new Date().toISOString(),
      })),
      recentLogs: ["one", "two", "three"],
      updatedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

function wideWorkflowProgressDetails(): WorkflowLaunchOutput {
  const startedAt = new Date(0).toISOString();
  const endedAt = new Date(28_000).toISOString();
  const labels = [
    "infra:package.json",
    "infra:vite.config.ts",
    "infra:tsconfig.json",
    "infra:index.tsx",
    "infra:appStore.ts",
    "infra:reactivity.ts",
    "infra:setupTests.ts",
    "infra:.eslintrc.cjs",
    "infra:README.md",
    "infra:smoke.md",
  ];
  const calls = labels.map((label, index) => ({
    callId: String(index + 1).padStart(4, "0"),
    label,
    phase: "Infrastructure",
    model: "Opus 4.8",
    status: index < 3 ? "done" as const : index === 3 ? "running" as const : "pending" as const,
    startedAt,
    endedAt: index < 3 ? endedAt : undefined,
    usage: index < 3 ? { agentCount: 1, subagentTokens: 48_700, toolUses: 9, durationMs: 28_000, estimated: false } : undefined,
  }));

  return {
    status: "async_launched",
    taskId: "task",
    runId: "run_wide",
    name: "react-to-solid-migration",
    description: "Non-destructive React→Solid.js port across 6 phases",
    phases: [
      { title: "Inventory" },
      { title: "Pattern Analysis" },
      { title: "Infrastructure" },
      { title: "Migrate Core" },
      { title: "Migrate App" },
      { title: "Verify & Report" },
    ],
    summary: "running",
    scriptPath: "/tmp/script.js",
    transcriptDir: "/tmp/subagents",
    startedAt,
    usage: { agentCount: 10, subagentTokens: 430_000, toolUses: 71, durationMs: 330_000, estimated: false },
    progress: {
      total: 10,
      running: 7,
      completed: 3,
      failed: 0,
      cached: 0,
      skipped: 0,
      phase: "Infrastructure",
      calls,
      recentLogs: ["latest event should not take space in wide panel"],
      updatedAt: endedAt,
    },
  };
}
