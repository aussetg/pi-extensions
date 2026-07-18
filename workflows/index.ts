import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RUNTIME_MODULE = "./dist/src/extension.js";

/** Tiny source bootstrap. The production runtime is compiled and loaded only for a real session. */
export default function workflowsExtension(pi: ExtensionAPI): void {
  let activation: Promise<void> | undefined;
  pi.on("session_start", (_event, ctx) => {
    activation ??= import(RUNTIME_MODULE).then(async ({ createWorkflowExtension }) => {
      await createWorkflowExtension(pi, ctx);
    });
    return activation;
  });
}
