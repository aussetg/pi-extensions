import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRichToolRenderers } from "./src/extension.ts";

export default function (pi: ExtensionAPI) {
  registerRichToolRenderers(pi);
}
