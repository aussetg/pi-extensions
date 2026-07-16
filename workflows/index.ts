import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkflowExtension } from "./src/index.js";

export * from "./src/index.js";

export default async function workflowsExtension(pi: ExtensionAPI): Promise<void> {
  await createWorkflowExtension(pi);
}
