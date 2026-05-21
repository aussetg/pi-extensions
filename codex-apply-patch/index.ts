import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerApplyPatchExtension } from "./src/extension.ts";

export default function (pi: ExtensionAPI) {
  registerApplyPatchExtension(pi);
}
