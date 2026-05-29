import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkflowExtension } from "./src/index.js";

export default function workflowsExtension(pi: ExtensionAPI): void {
  createWorkflowExtension(pi);
}
