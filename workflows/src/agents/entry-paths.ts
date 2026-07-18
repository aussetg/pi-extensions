import { fileURLToPath } from "node:url";

/** Physical worker entry kept separate from the worker implementation for primary-session loading. */
export function agentWorkerEntryPath(): string {
  return fileURLToPath(new URL("./agent-worker-entry.js", import.meta.url));
}
