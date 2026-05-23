import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRichToolsExtension } from "./src/extension.ts";

export default function (pi: ExtensionAPI) {
  registerRichToolsExtension(pi);
}
