/**
 * LaTeX-to-Unicode conversion optimized for PragmataPro Semiotics.
 *
 * `render` (default) changes only TUI Markdown. `rewrite` changes loaded and
 * future user/assistant messages, including what is sent to the model.
 * Pi 0.80 exposes custom renderers only for `custom` messages, so render mode
 * patches Markdown's input as the narrowest display-only hook available.
 */

// @ts-ignore Pi provides this package to extensions at runtime.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-ignore Pi provides this package to extensions at runtime.
import { Markdown } from "@earendil-works/pi-tui";
import { loadConfig, type LatexUnicodeMode } from "./config";
import { patchMarkdownRenderer } from "./renderer";
import { rewriteMessage, rewriteMessageInPlace } from "./rewrite";

export default function (pi: ExtensionAPI): void {
	pi.registerFlag("latex-unicode-mode", {
		description: "Override latex-unicode.json mode: render or rewrite.",
		type: "string",
	});

	const config = loadConfig();
	const flagMode = pi.getFlag("latex-unicode-mode");
	const warnings = config.warning ? [config.warning] : [];
	let mode: LatexUnicodeMode = config.mode;
	if (flagMode === "render" || flagMode === "rewrite") {
		mode = flagMode;
	} else if (flagMode !== undefined) {
		warnings.push(`Unknown --latex-unicode-mode ${JSON.stringify(flagMode)}; using ${mode}.`);
	}

	if (mode === "render") {
		const unpatch = patchMarkdownRenderer(Markdown);
		pi.on("session_shutdown", unpatch);
	} else {
		registerRewriteMode(pi);
	}

	if (warnings.length > 0) {
		pi.on("session_start", (_event: any, ctx: any) => {
			for (const warning of warnings) ctx.ui.notify(warning, "warning");
		});
	}
}

function registerRewriteMode(pi: ExtensionAPI): void {
	// Session entries and the agent's loaded context share message objects. Rewrite
	// every branch in memory before the transcript is built. The JSONL remains
	// append-only; resuming it simply performs this cheap pass again.
	pi.on("session_start", (_event: any, ctx: any) => {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "message") rewriteMessageInPlace(entry.message);
		}
	});

	// Convert typed user input before message_start so it is immediately rendered
	// in its rewritten form.
	pi.on("input", (event: any) => {
		const rewritten = rewriteMessage({ role: "user", content: event.text });
		if (!rewritten.changed) return { action: "continue" };
		return { action: "transform", text: rewritten.message.content as string, images: event.images };
	});

	// Final assistant messages (and non-interactive user-message sources) become
	// canonical Unicode before persistence and later turns.
	pi.on("message_end", (event: any) => {
		const rewritten = rewriteMessage(event.message);
		if (!rewritten.changed) return;
		return { message: rewritten.message as typeof event.message };
	});

	// This also covers context reconstructed from old files or compaction paths
	// whose objects were not shared with SessionManager.
	pi.on("context", (event: any) => {
		let changed = false;
		const messages = event.messages.map((message: any) => {
			const rewritten = rewriteMessage(message);
			changed ||= rewritten.changed;
			return rewritten.message as typeof message;
		});
		return changed ? { messages } : undefined;
	});
}
