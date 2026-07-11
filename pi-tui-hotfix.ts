// @ts-ignore The pi runtime provides this package to extensions.
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
// @ts-ignore The pi runtime provides this package to extensions.
import { Box } from "@earendil-works/pi-tui";

const BOX_RENDER_PATCH = Symbol.for("pi-tui-hotfix.box-render-cache");
const GPT5_THINKING_PATCH = Symbol.for("pi-tui-hotfix.gpt5-thinking-placeholders");
const STREAMING_ASSISTANT_MESSAGES = new WeakSet<object>();
const EMPTY_REASONING_SENTINELS = ["<!-- -->", "<!-- />"] as const;

// GPT-5 occasionally emits a reasoning-summary part whose entire body is one
// of these empty sentinels. Match Codex and drop the whole part, including its
// status heading. The self-closing variant is malformed HTML, but GPT-5.6 does
// emit it in practice.
const EMPTY_REASONING_PART_RE =
	/(^|\n)(?:\*\*[^\r\n*][^\r\n]*?\*\*[ \t]*\r?\n(?:[ \t]*\r?\n)?)?<!-- (?:--|\/)>[ \t]*(?=\r?\n|$)/g;

type BoxLike = {
	children: Array<{ render(width: number): string[] }>;
	paddingX: number;
	paddingY: number;
	bgFn?: (text: string) => string;
	cache?: {
		childLines: string[];
		width: number;
		bgSample: string | undefined;
		lines: string[];
		paddingX?: number;
		paddingY?: number;
	};
	applyBg?: (line: string, width: number) => string;
};

type AssistantMessageLike = {
	role?: string;
	model?: string;
	content?: unknown[];
};

type AssistantMessageComponentLike = {
	lastMessage?: AssistantMessageLike;
};

export default function (pi: any): void {
	trackStreamingAssistantMessages(pi);
	patchGpt5ThinkingPlaceholders();
	patchBoxRenderCache();
}

function trackStreamingAssistantMessages(pi: any): void {
	pi.on("message_start", (event: { message?: AssistantMessageLike }) => {
		if (event.message?.role === "assistant") STREAMING_ASSISTANT_MESSAGES.add(event.message);
	});
	pi.on("message_update", (event: { message?: AssistantMessageLike }) => {
		if (event.message?.role === "assistant") STREAMING_ASSISTANT_MESSAGES.add(event.message);
	});
	pi.on("message_end", (event: { message?: AssistantMessageLike }) => {
		if (event.message?.role === "assistant") STREAMING_ASSISTANT_MESSAGES.delete(event.message);
	});
}

function patchGpt5ThinkingPlaceholders(): void {
	const proto = (AssistantMessageComponent as any)?.prototype;
	if (!proto) return;

	const previousPatch = proto[GPT5_THINKING_PATCH] as { originalUpdateContent?: unknown } | undefined;
	const originalUpdateContent =
		typeof previousPatch?.originalUpdateContent === "function" ? previousPatch.originalUpdateContent : proto.updateContent;
	if (typeof originalUpdateContent !== "function") return;

	proto.updateContent = function piTuiHotfixGpt5Thinking(
		this: AssistantMessageComponentLike,
		message: AssistantMessageLike,
	): unknown {
		const renderedMessage = sanitizeGpt5Thinking(message);
		const result = originalUpdateContent.call(this, renderedMessage);
		// Keep the raw message so a later rebuild can apply a revised renderer
		// instead of permanently inheriting this display-only transformation.
		if (renderedMessage !== message) this.lastMessage = message;
		return result;
	};

	if (!previousPatch) {
		Object.defineProperty(proto, GPT5_THINKING_PATCH, {
			value: { originalUpdateContent },
			configurable: false,
		});
	}
}

function sanitizeGpt5Thinking(message: AssistantMessageLike): AssistantMessageLike {
	if (message?.role !== "assistant" || !isGpt5Model(message.model) || !Array.isArray(message.content)) return message;

	let changed = false;
	const content = message.content.map((block) => {
		if (!block || typeof block !== "object") return block;
		const thinkingBlock = block as { type?: string; thinking?: string };
		if (thinkingBlock.type !== "thinking" || typeof thinkingBlock.thinking !== "string") return block;

		const thinking = stripEmptyReasoningParts(
			thinkingBlock.thinking,
			STREAMING_ASSISTANT_MESSAGES.has(message),
		);
		if (thinking === thinkingBlock.thinking) return block;
		changed = true;
		return { ...thinkingBlock, thinking };
	});

	return changed ? { ...message, content } : message;
}

function isGpt5Model(model: unknown): boolean {
	if (typeof model !== "string") return false;
	const segments = model.trim().split("/");
	const id = segments[segments.length - 1] ?? "";
	return /^gpt-5(?:$|[.-])/i.test(id);
}

function stripEmptyReasoningParts(thinking: string, streaming: boolean): string {
	let stripped = thinking.replace(EMPTY_REASONING_PART_RE, "$1");
	if (streaming) stripped = hidePendingReasoningPart(stripped);
	return stripped === thinking ? thinking : stripped.replace(/\n{3,}/g, "\n\n").trim();
}

function hidePendingReasoningPart(thinking: string): string {
	const lineStart = thinking.lastIndexOf("\n*");
	const start = lineStart >= 0 ? lineStart + 1 : thinking.startsWith("*") ? 0 : -1;
	if (start < 0) return thinking;

	const part = thinking.slice(start);
	if (!couldBecomeEmptyReasoningPart(part)) return thinking;
	return thinking.slice(0, start).trimEnd();
}

function couldBecomeEmptyReasoningPart(part: string): boolean {
	if (part === "*") return true;
	if (!part.startsWith("**")) return false;

	const afterOpen = part.slice(2);
	const close = afterOpen.indexOf("**");
	if (close < 0) return true;
	if (close === 0) return false;

	const body = afterOpen.slice(close + 2).trim();
	return body.length === 0 || EMPTY_REASONING_SENTINELS.some((sentinel) => sentinel.startsWith(body));
}

function patchBoxRenderCache(): void {
	const proto = (Box as any)?.prototype;
	if (!proto) return;

	const previousPatch = proto[BOX_RENDER_PATCH] as { originalRender?: unknown } | undefined;
	const originalRender = typeof previousPatch?.originalRender === "function" ? previousPatch.originalRender : proto.render;
	if (typeof originalRender !== "function") return;

	proto.render = function piTuiHotfixBoxRender(this: BoxLike, width: number): string[] {
		if (!this || !Array.isArray(this.children) || typeof this.applyBg !== "function") {
			return originalRender.call(this, width);
		}

		if (this.children.length === 0) return [];

		const paddingX = Math.max(0, Math.trunc(Number(this.paddingX) || 0));
		const paddingY = Math.max(0, Math.trunc(Number(this.paddingY) || 0));
		const contentWidth = Math.max(1, width - paddingX * 2);
		const leftPad = " ".repeat(paddingX);

		// Keep the exact child line values in the cache key. Pi's bundled Box
		// currently caches after `leftPad + line`, which creates fresh rope strings
		// every render. Then matchCache spends idle frames comparing long padded
		// strings by contents. Comparing the child lines before padding preserves the
		// fast stable-string path for cached child components.
		const childLines: string[] = [];
		for (const child of this.children) {
			const lines = child.render(contentWidth);
			for (const line of lines) childLines.push(line);
		}

		if (childLines.length === 0) return [];

		const bgSample = this.bgFn ? this.bgFn("test") : undefined;
		const cache = this.cache;
		if (
			cache &&
			cache.width === width &&
			cache.paddingX === paddingX &&
			cache.paddingY === paddingY &&
			cache.bgSample === bgSample &&
			Array.isArray(cache.childLines) &&
			cache.childLines.length === childLines.length &&
			cache.childLines.every((line, index) => line === childLines[index])
		) {
			return cache.lines;
		}

		const result: string[] = [];
		for (let i = 0; i < paddingY; i += 1) result.push(this.applyBg("", width));
		for (const line of childLines) result.push(this.applyBg(leftPad + line, width));
		for (let i = 0; i < paddingY; i += 1) result.push(this.applyBg("", width));

		this.cache = { childLines, width, bgSample, lines: result, paddingX, paddingY };
		return result;
	};

	if (!previousPatch) {
		Object.defineProperty(proto, BOX_RENDER_PATCH, {
			value: { originalRender },
			configurable: false,
		});
	}
}
