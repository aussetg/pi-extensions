import { fork, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FileDiffMetadata } from "../../node_modules/@pierre/diffs/dist/types.js";
import type { PierreRendererConfig } from "./config.ts";
import {
  emptyHighlightedDiffSet,
  type HighlightedDiffSet,
} from "./types.ts";

type TimerHandle = ReturnType<typeof setTimeout> & {
  unref?: () => void;
};

type WorkerResponse = {
  id?: number;
  highlighted?: HighlightedDiffSet;
  error?: string;
};

type PendingRequest = {
  resolve: (value: HighlightedDiffSet) => void;
  timeout: TimerHandle;
};

type WorkerClient = {
  child: ChildProcess;
  nextId: number;
  pending: Map<number, PendingRequest>;
};

type WorkerState = {
  client?: WorkerClient;
  generation: number;
  requests: Map<string, Promise<HighlightedDiffSet>>;
};

const workerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "highlight-worker.mjs",
);
const DEFAULT_WORKER_TIMEOUT_MS = 5_000;
const GLOBAL_WORKER_STATE_KEY = "__piRichToolsHighlightWorkerState";

export function requestHighlightedDiff(
  metadata: FileDiffMetadata,
  config: PierreRendererConfig,
  requestKey?: string,
): Promise<HighlightedDiffSet> {
  const state = workerState();
  const existing = requestKey ? state.requests.get(requestKey) : undefined;
  if (existing) return existing;

  const request = requestAfterRenderTurn(metadata, config, state.generation);
  if (requestKey) {
    state.requests.set(requestKey, request);
    const forgetRequest = () => {
      if (state.requests.get(requestKey) === request) {
        state.requests.delete(requestKey);
      }
    };
    void request.then(forgetRequest, forgetRequest);
  }
  return request;
}

export function resetHighlightWorker(): void {
  const state = workerState();
  state.generation += 1;
  state.requests.clear();
  if (state.client) restartWorker(state.client);
}

async function requestAfterRenderTurn(
  metadata: FileDiffMetadata,
  config: PierreRendererConfig,
  generation: number,
): Promise<HighlightedDiffSet> {
  // This is normally started from Component.render(). Paint the plain rows
  // before lazily forking the worker or serializing a large metadata object.
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (workerState().generation !== generation) {
    return emptyHighlightedDiffSet();
  }
  return requestFromWorker(metadata, config);
}

function requestFromWorker(
  metadata: FileDiffMetadata,
  config: PierreRendererConfig,
): Promise<HighlightedDiffSet> {
  const client = getWorkerClient();
  const requestId = client.nextId++;

  refWorker(client);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      client.pending.delete(requestId);
      resolve(emptyHighlightedDiffSet());
      restartWorker(client);
    }, workerTimeoutMs()) as TimerHandle;
    timeout.unref?.();

    client.pending.set(requestId, { resolve, timeout });
    try {
      client.child.send?.(
        { id: requestId, metadata, config },
        (error: Error | null) => {
          if (!error) return;
          restartWorker(client);
        },
      );
    } catch {
      restartWorker(client);
    }
  });
}

function getWorkerClient(): WorkerClient {
  const state = workerState();
  if (state.client) return state.client;

  const child = fork(workerPath, [], {
    execPath: workerNodePath(),
    execArgv: [],
    // Pi's standalone executable is Bun while the worker is Node. Their
    // advanced IPC serializers are not interoperable. This protocol carries
    // only JSON-compatible metadata and highlighted spans.
    serialization: "json",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const client: WorkerClient = {
    child,
    nextId: 1,
    pending: new Map(),
  };
  state.client = client;

  child.on("message", (message: unknown) => {
    const response = normalizeResponse(message);
    if (!response || typeof response.id !== "number") return;
    settleRequest(client, response.id, response);
  });
  child.on("exit", () => {
    if (workerState().client === client) workerState().client = undefined;
    settleAllRequests(client);
  });
  child.on("error", () => restartWorker(client));

  maybeUnrefWorker(client);
  return client;
}

function workerState(): WorkerState {
  const scope = globalThis as typeof globalThis & {
    [GLOBAL_WORKER_STATE_KEY]?: WorkerState;
  };
  scope[GLOBAL_WORKER_STATE_KEY] ??= {
    generation: 0,
    requests: new Map(),
  };
  const state = scope[GLOBAL_WORKER_STATE_KEY];
  state.generation ??= 0;
  state.requests ??= new Map();
  return state;
}

function normalizeResponse(message: unknown): WorkerResponse | undefined {
  if (!message || typeof message !== "object") return undefined;
  const response = message as WorkerResponse;
  return typeof response.id === "number" ? response : undefined;
}

function settleRequest(
  client: WorkerClient,
  requestId: number,
  response: WorkerResponse | undefined,
): void {
  const pending = client.pending.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  client.pending.delete(requestId);
  pending.resolve(
    response && !response.error && response.highlighted
      ? restoreSparseHighlightLines(response.highlighted)
      : emptyHighlightedDiffSet(),
  );
  maybeUnrefWorker(client);
}

function restoreSparseHighlightLines(
  highlighted: HighlightedDiffSet,
): HighlightedDiffSet {
  const restore = <T>(lines: Array<T | undefined>): Array<T | undefined> => {
    const sparse: Array<T | undefined> = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line != null) sparse[index] = line;
    }
    return sparse;
  };

  return {
    dark: {
      deletionLines: restore(highlighted.dark.deletionLines),
      additionLines: restore(highlighted.dark.additionLines),
    },
    light: {
      deletionLines: restore(highlighted.light.deletionLines),
      additionLines: restore(highlighted.light.additionLines),
    },
  };
}

function settleAllRequests(client: WorkerClient): void {
  for (const pending of client.pending.values()) {
    clearTimeout(pending.timeout);
    pending.resolve(emptyHighlightedDiffSet());
  }
  client.pending.clear();
}

function restartWorker(client: WorkerClient): void {
  if (workerState().client === client) workerState().client = undefined;
  settleAllRequests(client);
  client.child.kill();
}

function refWorker(client: WorkerClient): void {
  client.child.ref?.();
  client.child.channel?.ref?.();
}

function maybeUnrefWorker(client: WorkerClient): void {
  if (client.pending.size > 0) return;
  client.child.unref?.();
  client.child.channel?.unref?.();
}

function workerNodePath(): string {
  return process.env.PI_PIERRE_HIGHLIGHT_NODE ??
    process.env.PI_TREE_SITTER_NODE ??
    "node";
}

function workerTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.PI_PIERRE_HIGHLIGHT_WORKER_TIMEOUT_MS ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_WORKER_TIMEOUT_MS;
}
