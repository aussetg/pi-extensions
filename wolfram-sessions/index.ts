import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerWolframSessions from "./wolfram.ts";

export default function wolframSessionsExtension(pi: ExtensionAPI): void {
	registerWolframSessions(pi);
}
