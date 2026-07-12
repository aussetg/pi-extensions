import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UI_LIMITS } from "../src/constants.js";
import { JsonlJournal } from "../src/persistence/journal.js";
import { RunStore } from "../src/persistence/run-store.js";
import { createWorkflowUiGlobal } from "../src/runtime/ui-global.js";
import { loadViewSnapshot, WorkflowViewStore } from "../src/ui/workflow-view-store.js";
import type { WorkflowViewSnapshot } from "../src/types.js";

const meta = { name: "ui_store", description: "test workflow UI store" };
const source = "export const meta = { name: 'ui_store', description: 'test workflow UI store' };\nreturn 'ok';\n";

let oldAgentDir: string | undefined;
let tmp: string;

beforeEach(async () => {
  oldAgentDir = process.env.PI_AGENT_DIR;
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflows-ui-store-"));
  process.env.PI_AGENT_DIR = path.join(tmp, "agent");
});

afterEach(async () => {
  if (oldAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = oldAgentDir;
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("WorkflowViewStore coalesced persistence", () => {
  it("keeps updates in memory and persists only the latest state on final flush", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });
    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: {} });
    const journal = new JsonlJournal(record.journalPath);
    const rendered: WorkflowViewSnapshot[] = [];
    const store = new WorkflowViewStore(record, journal, runStore, (_viewId, snapshot) => rendered.push(snapshot));
    const ui = createWorkflowUiGlobal(store) as any;

    ui.define({
      version: 1,
      id: "slow",
      title: "Slow updates",
      limits: { updateHz: 0.1 },
      initialState: { value: 0 },
      layout: { type: "metric", label: "Value", bind: "/value" },
    });
    await ui.update("slow", { value: 1 });
    await ui.update("slow", { value: 2 });
    await ui.update("slow", { value: 3 });

    const view = record.uiViews.find((v) => v.viewId === "slow")!;
    expect(JSON.parse(await fs.promises.readFile(view.latestStatePath, "utf8"))).toEqual({ value: 0 });
    expect(rendered.map((snapshot) => snapshot.seq)).toEqual([0]);

    await ui.__flush();

    expect(JSON.parse(await fs.promises.readFile(view.latestStatePath, "utf8"))).toEqual({ value: 3 });
    expect(rendered.map((snapshot) => snapshot.seq)).toEqual([0, 3]);
    expect(rendered.map((snapshot) => snapshot.state)).toEqual([{ value: 0 }, { value: 3 }]);

    const events = await journal.readAll();
    expect(events.filter((event) => event.type === "ui_state").map((event) => event.seq)).toEqual([0, 3]);
    await expect(fs.promises.readFile(path.join(record.runDir, "ui", "slow", "state-0003.json"), "utf8").then(JSON.parse)).resolves.toEqual({ value: 3 });
  });

  it("exposes ui.flush as an explicit persistence barrier", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });
    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: {} });
    const journal = new JsonlJournal(record.journalPath);
    const store = new WorkflowViewStore(record, journal, runStore);
    const ui = createWorkflowUiGlobal(store) as any;

    await ui.define({
      version: 1,
      id: "barrier",
      title: "Barrier",
      limits: { updateHz: 0.1 },
      initialState: { value: 0 },
      layout: { type: "metric", label: "Value", bind: "/value" },
    });
    await ui.update("barrier", { value: 1 });
    await ui.update("barrier", { value: 2 });

    const view = record.uiViews.find((v) => v.viewId === "barrier")!;
    expect(JSON.parse(await fs.promises.readFile(view.latestStatePath, "utf8"))).toEqual({ value: 0 });

    await ui.flush();

    expect(JSON.parse(await fs.promises.readFile(view.latestStatePath, "utf8"))).toEqual({ value: 2 });
  });

  it("accepts chart-only and table-only dashboard shorthand through host ui.define", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });
    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: {} });
    const journal = new JsonlJournal(record.journalPath);
    const store = new WorkflowViewStore(record, journal, runStore);
    const ui = createWorkflowUiGlobal(store) as any;

    await ui.define({ charts: [{ label: "tokens", values: [1, 2, 3] }] });

    const first = store.get("dashboard")!;
    expect(first.spec.layout).toEqual({ type: "dashboard" });
    expect(first.state.charts).toEqual([{ type: "sparkline", label: "tokens", values: [1, 2, 3], value: 3 }]);

    await ui.define({ tables: [{ columns: ["lane"], rows: [{ lane: "review" }] }] });

    const second = store.get("dashboard")!;
    expect(second.spec.layout).toEqual({ type: "dashboard" });
    expect(second.state.tables).toEqual([{ columns: [{ key: "lane", label: "Lane" }], rows: [{ lane: "review" }], maxRows: 12 }]);
    expect(record.uiViews.map((view) => view.viewId)).toEqual(["dashboard"]);
  });

  it("does not treat full specs with charts or tables as dashboard shorthand", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });
    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: {} });
    const journal = new JsonlJournal(record.journalPath);
    const store = new WorkflowViewStore(record, journal, runStore);
    const ui = createWorkflowUiGlobal(store) as any;

    await ui.define({
      version: 1,
      id: "chart_spec",
      title: "Chart spec",
      initialState: { charts: [{ label: "tokens", values: [1, 2, 3] }] },
      layout: { type: "dashboard" },
    });

    expect(store.get("chart_spec")?.spec.id).toBe("chart_spec");
    expect(store.get("dashboard")).toBeUndefined();
  });

  it("delivers immutable render snapshots while retaining mutable state for patches", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });
    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: {} });
    const journal = new JsonlJournal(record.journalPath);
    const rendered: WorkflowViewSnapshot[] = [];
    const store = new WorkflowViewStore(record, journal, runStore, (_viewId, snapshot) => rendered.push(snapshot));

    await store.define({
      version: 1,
      id: "snap",
      title: "Snapshots",
      limits: { updateHz: 0.1 },
      initialState: { value: 0 },
      layout: { type: "metric", label: "Value", bind: "/value" },
    });
    const first = rendered[0];
    await store.update("snap", { value: 1 });

    expect(first.state).toEqual({ value: 0 });
    expect(store.get("snap")?.state).toEqual({ value: 1 });

    await store.flush();
    expect(first.state).toEqual({ value: 0 });
    expect(rendered.at(-1)?.state).toEqual({ value: 1 });
  });

  it("patches top-level fields through ui.patch", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });
    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: {} });
    const journal = new JsonlJournal(record.journalPath);
    const store = new WorkflowViewStore(record, journal, runStore);
    const ui = createWorkflowUiGlobal(store) as any;

    await ui.define({
      version: 1,
      id: "patch_top_level",
      title: "Top-level patch",
      initialState: { notes: "old", checks: [] },
      layout: { type: "markdown", bind: "/notes" },
    });

    await ui.patch("patch_top_level", [
      { op: "replace", path: "/notes", value: "new" },
      { op: "add", path: "/checks", value: [{ label: "patched", status: "done" }] },
    ]);

    expect(store.get("patch_top_level")?.state).toEqual({ notes: "new", checks: [{ label: "patched", status: "done" }] });
  });

  it("recovers the UI queue after a caught operation failure", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });
    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: {} });
    const journal = new JsonlJournal(record.journalPath);
    const store = new WorkflowViewStore(record, journal, runStore);
    const ui = createWorkflowUiGlobal(store) as any;

    await expect(ui.define({
      version: 1,
      id: "bad",
      title: "Bad",
      layout: { type: "metric", label: "Value", bind: "/value", onClick: "boom" },
    })).rejects.toThrow(/unsupported key onClick/);

    await ui.define({
      version: 1,
      id: "good",
      title: "Good",
      initialState: { value: 1 },
      layout: { type: "metric", label: "Value", bind: "/value" },
    });
    await ui.__flush();

    expect(record.uiViews.map((view) => view.viewId)).toEqual(["good"]);
  });

  it("surfaces unhandled UI operation failures on flush without poisoning later writes", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });
    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: {} });
    const journal = new JsonlJournal(record.journalPath);
    const store = new WorkflowViewStore(record, journal, runStore);
    const ui = createWorkflowUiGlobal(store) as any;

    ui.define({
      version: 1,
      id: "bad",
      title: "Bad",
      layout: { type: "metric", label: "Value", bind: "/value", onClick: "boom" },
    });
    await ui.define({
      version: 1,
      id: "good",
      title: "Good",
      initialState: { value: 1 },
      layout: { type: "metric", label: "Value", bind: "/value" },
    });

    await expect(ui.flush()).rejects.toThrow(/unsupported key onClick/);
    expect(record.uiViews.map((view) => view.viewId)).toEqual(["good"]);
  });

  it("treats caught host ui.flush failures as handled for later barriers", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });
    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: {} });
    const journal = new JsonlJournal(record.journalPath);
    const store = new WorkflowViewStore(record, journal, runStore);
    const ui = createWorkflowUiGlobal(store) as any;

    ui.define({
      version: 1,
      id: "bad",
      title: "Bad",
      layout: { type: "metric", label: "Value", bind: "/value", onClick: "boom" },
    });

    let caught = "";
    try {
      await ui.flush();
    } catch (err) {
      caught = (err as Error).message;
    }

    await ui.define({
      version: 1,
      id: "good",
      title: "Good",
      initialState: { value: 1 },
      layout: { type: "metric", label: "Value", bind: "/value" },
    });
    await ui.__flush();

    expect(caught).toMatch(/unsupported key onClick/);
    expect(record.uiViews.map((view) => view.viewId)).toEqual(["good"]);
  });

  it("closes views without deleting persisted artifacts", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });
    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: {} });
    const journal = new JsonlJournal(record.journalPath);
    const closed: WorkflowViewSnapshot[] = [];
    const store = new WorkflowViewStore(record, journal, runStore, undefined, (_viewId, snapshot) => closed.push(snapshot));

    await store.define({
      version: 1,
      id: "ephemeral",
      title: "Ephemeral",
      placement: "runPanel",
      initialState: { value: 1 },
      layout: { type: "metric", label: "Value", bind: "/value" },
    });
    await store.update("ephemeral", { value: 2 });
    await store.close("ephemeral");

    expect(store.list().map((snapshot) => snapshot.spec.id)).toEqual(["ephemeral"]);
    expect(store.listByPlacement("runPanel")).toEqual([]);
    expect(record.uiViews.map((view) => view.viewId)).toEqual(["ephemeral"]);
    expect(closed.map((snapshot) => snapshot.spec.id)).toEqual(["ephemeral"]);
    await expect(fs.promises.readFile(record.uiViews[0].latestStatePath, "utf8").then(JSON.parse)).resolves.toEqual({ value: 2 });
    expect((await journal.readAll()).some((event) => event.type === "ui_closed" && event.viewId === "ephemeral")).toBe(true);
    await expect(store.update("ephemeral", { value: 3 })).rejects.toThrow(/closed/);
  });

  it("bounds persisted view snapshot reads", async () => {
    const cwd = path.join(tmp, "project");
    await fs.promises.mkdir(cwd, { recursive: true });
    const runStore = new RunStore();
    const { record } = await runStore.create({ cwd, sessionId: "s", meta, source, args: {} });
    const journal = new JsonlJournal(record.journalPath);
    const store = new WorkflowViewStore(record, journal, runStore);

    await store.define({
      version: 1,
      id: "bounded",
      title: "Bounded",
      initialState: { value: 1 },
      layout: { type: "metric", label: "Value", bind: "/value" },
    });
    await fs.promises.truncate(record.uiViews[0].specPath, UI_LIMITS.maxSpecBytes * 2 + 1);

    await expect(loadViewSnapshot(record, "bounded")).rejects.toThrow(/exceeds/);
  });
});
