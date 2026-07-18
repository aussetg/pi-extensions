import { fileURLToPath } from "node:url";

/** Physical coordinator entry kept separate from the execution kernel for primary-session loading. */
export function workflowCoordinatorEntryPath(): string {
  return fileURLToPath(new URL("./coordinator-entry.js", import.meta.url));
}
