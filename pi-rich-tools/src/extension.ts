import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerApplyPatchExtension } from "./apply-patch-extension.ts";
import { reloadPierreRendererConfig } from "./pierre/config.ts";
import { resetPierreRendererState } from "./pierre/reset.ts";
import { registerRichToolRenderers } from "./rich-tools/extension.ts";
import { resetRichToolPayloadState } from "./rich-tools/payloads.ts";

export function registerRichToolsExtension(pi: ExtensionAPI): void {
  resetRichToolsState();
  pi.on("session_start", async () => {
    resetRichToolsState();
  });
  pi.on("session_shutdown", async () => {
    resetRichToolsState();
  });

  registerApplyPatchExtension(pi);
  registerRichToolRenderers(pi);
}

function resetRichToolsState(): void {
  resetRichToolPayloadState();
  resetPierreRendererState();
  reloadPierreRendererConfig();
}
