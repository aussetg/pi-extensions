import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerApplyPatchExtension } from "./src/extension.ts";

export default function (pi: ExtensionAPI) {
  registerApplyPatchExtension(pi);
}
