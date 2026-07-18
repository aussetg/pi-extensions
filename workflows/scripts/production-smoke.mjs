import fs from "node:fs";
import { agentWorkerEntryPath } from "../dist/src/agents/entry-paths.js";
import { workflowCoordinatorEntryPath } from "../dist/src/runtime/entry-paths.js";

const [extension, agentWorker, coordinator] = await Promise.all([
  import("../dist/src/extension.js"),
  import("../dist/src/agents/sdk-worker.js"),
  import("../dist/src/runtime/run-coordinator.js"),
]);
if (typeof extension.createWorkflowExtension !== "function"
  || typeof agentWorker.agentWorkerMain !== "function"
  || typeof coordinator.workflowCoordinatorMain !== "function") {
  throw new Error("Compiled workflow runtime exports are incomplete");
}

for (const entryPath of [agentWorkerEntryPath(), workflowCoordinatorEntryPath()]) {
  if (!entryPath.includes("/dist/src/") || !fs.statSync(entryPath).isFile()) {
    throw new Error(`Compiled physical entry is unavailable: ${entryPath}`);
  }
}
