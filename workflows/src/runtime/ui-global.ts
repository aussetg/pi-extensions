import type { JsonObject, WorkflowViewSpec } from "../types.js";
import { applyJsonPatch, type JsonPatchOperation } from "../utils/json-pointer.js";
import { WorkflowViewStore } from "../ui/workflow-view-store.js";
import { normalizeDashboardDocument } from "../ui/dashboard.js";

const DEFAULT_DASHBOARD_ID = "dashboard";

interface UiOperation {
  handled: boolean;
  error?: unknown;
}

interface TrackOptions {
  onHandled?: () => void;
}

export function createWorkflowUiGlobal(store: WorkflowViewStore): Record<string, unknown> {
  let chain: Promise<unknown> = Promise.resolve();
  const failures: UiOperation[] = [];
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work);
    chain = next.catch(() => undefined);
    next.catch(() => undefined);
    return next;
  };
  const firstUnhandledFailure = () => failures.find((operation) => operation.error && !operation.handled);
  const markFailedOperationsHandled = () => {
    for (const operation of failures) {
      if (operation.error) operation.handled = true;
    }
  };
  const flushBarrier = (shouldMarkFailuresHandled = () => false): Promise<void> => enqueue(async () => {
    await Promise.resolve();
    const failed = firstUnhandledFailure();
    if (failed) {
      if (shouldMarkFailuresHandled()) markFailedOperationsHandled();
      throw failed.error;
    }
    await store.flush();
  });
  const track = <T>(promise: Promise<T>, fields: Record<string, unknown> = {}, opts: TrackOptions = {}): PromiseLike<T> & Record<string, unknown> => {
    const operation: UiOperation = { handled: false };
    promise.catch((err) => {
      operation.error = err;
      failures.push(operation);
    });
    const markHandled = () => {
      operation.handled = true;
      opts.onHandled?.();
    };
    const handle = Object.create(null) as PromiseLike<T> & Record<string, unknown>;
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) Object.defineProperty(handle, key, { value, enumerable: true, writable: false, configurable: false });
    }
    Object.defineProperties(handle, {
      then: {
        value: (onFulfilled?: ((value: T) => unknown) | null, onRejected?: ((reason: unknown) => unknown) | null) => {
          if (typeof onRejected === "function") markHandled();
          return promise.then(onFulfilled as any, onRejected as any);
        },
        enumerable: false,
        writable: false,
        configurable: false,
      },
      catch: {
        value: (onRejected?: ((reason: unknown) => unknown) | null) => {
          markHandled();
          return promise.catch(onRejected as any);
        },
        enumerable: false,
        writable: false,
        configurable: false,
      },
      finally: {
        value: (onFinally?: (() => void) | null) => {
          return promise.finally(onFinally as any);
        },
        enumerable: false,
        writable: false,
        configurable: false,
      },
    });
    Object.freeze(handle);
    return handle;
  };
  const flush = () => {
    let handled = false;
    const promise = flushBarrier(() => handled);
    return track(promise, {}, {
      onHandled: () => {
        handled = true;
      },
    });
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
    dashboard: (doc: unknown) => track(dashboard(doc), { id: DEFAULT_DASHBOARD_ID }),
    define: (spec: WorkflowViewSpec | unknown) => isDashboardDefineInput(spec) ? track(dashboard(spec), { id: DEFAULT_DASHBOARD_ID }) : track(enqueue(async () => await store.define(spec as WorkflowViewSpec)), { id: isRecord(spec) ? spec.id : undefined }),
    update: (...args: unknown[]) => {
      if (args.length === 1 && isRecord(args[0])) return track(dashboard(args[0]), { id: DEFAULT_DASHBOARD_ID });
      const [viewId, state] = args as [string, JsonObject];
      return track(enqueue(async () => store.update(viewId, state)));
    },
    patch: (viewId: string, patch: JsonPatchOperation[]) => track(enqueue(async () => {
      const snapshot = store.get(viewId);
      if (!snapshot) throw new Error(`Unknown workflow UI view: ${viewId}`);
      await store.update(viewId, applyJsonPatch(snapshot.state, patch) as JsonObject);
    })),
    close: (viewId: string) => track(enqueue(async () => store.close(viewId)), { id: viewId }),
    flush,
    __flush: () => flushBarrier(),
  };
}

function isDashboardDefineInput(input: unknown): boolean {
  const object = isRecord(input) ? input : undefined;
  if (!object) return false;
  if (hasOwn(object, "version")) return false;
  if (hasOwn(object, "layout")) return false;
  return ["title", "status", "summary", "progress", "metrics", "sections", "charts", "tables"].some((key) => hasOwn(object, key));
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
