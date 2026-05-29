import type { JsonObject, WorkflowViewSpec } from "../types.js";
import { applyJsonPatch, type JsonPatchOperation } from "../utils/json-pointer.js";
import { WorkflowViewStore } from "../ui/workflow-view-store.js";
import { normalizeDashboardDocument } from "../ui/dashboard.js";

const DEFAULT_DASHBOARD_ID = "dashboard";

export function createWorkflowUiGlobal(store: WorkflowViewStore): Record<string, unknown> {
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work);
    chain = next;
    next.catch(() => undefined);
    return next;
  };
  const dashboard = (doc: unknown) => enqueue(async () => {
    const state = normalizeDashboardDocument(doc);
    const existing = store.get(DEFAULT_DASHBOARD_ID);
    if (!existing) {
      await store.define({
        version: 1,
        id: DEFAULT_DASHBOARD_ID,
        title: dashboardTitle(state),
        placement: "runPanel",
        initialState: state,
        layout: { type: "dashboard" },
      });
      return { id: DEFAULT_DASHBOARD_ID };
    }
    if (existing.spec.layout.type !== "dashboard") throw new Error(`Default workflow dashboard id ${DEFAULT_DASHBOARD_ID} is already used by a non-dashboard UI view`);
    await store.update(DEFAULT_DASHBOARD_ID, state);
    return { id: DEFAULT_DASHBOARD_ID };
  });

  return {
    dashboard,
    define: (spec: WorkflowViewSpec | unknown) => isDashboardDefineInput(spec) ? dashboard(spec) : enqueue(async () => await store.define(spec as WorkflowViewSpec)),
    update: (...args: unknown[]) => {
      if (args.length === 1 && isRecord(args[0])) return dashboard(args[0]);
      const [viewId, state] = args as [string, JsonObject];
      return enqueue(async () => store.update(viewId, state));
    },
    patch: (viewId: string, patch: JsonPatchOperation[]) => enqueue(async () => {
      const snapshot = store.get(viewId);
      if (!snapshot) throw new Error(`Unknown workflow UI view: ${viewId}`);
      await store.update(viewId, applyJsonPatch(snapshot.state, patch) as JsonObject);
    }),
    close: (viewId: string) => enqueue(async () => store.close(viewId)),
    __flush: async () => {
      await chain;
      await store.flush();
    },
  };
}

function isDashboardDefineInput(input: unknown): boolean {
  const object = isRecord(input) ? input : undefined;
  if (!object) return false;
  if (hasOwn(object, "version")) return false;
  if (hasOwn(object, "layout")) return false;
  return ["title", "status", "summary", "progress", "metrics", "sections"].some((key) => hasOwn(object, key));
}

function dashboardTitle(doc: JsonObject): string {
  const title = typeof doc.title === "string" && doc.title.trim() ? doc.title.trim() : "Workflow dashboard";
  return title.slice(0, 120);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}
