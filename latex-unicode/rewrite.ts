import { convertLatexToUnicode } from "./converter.ts";

interface MessageLike {
	role: string;
	content?: unknown;
	[key: string]: unknown;
}

interface RewriteResult<T extends MessageLike> {
	message: T;
	changed: boolean;
}

function rewriteContent(content: unknown): { content: unknown; changed: boolean } {
	if (typeof content === "string") {
		const converted = convertLatexToUnicode(content);
		return { content: converted.text, changed: converted.changed };
	}
	if (!Array.isArray(content)) return { content, changed: false };

	let changed = false;
	const blocks = content.map((block) => {
		if (!block || typeof block !== "object") return block;
		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate.type !== "text" || typeof candidate.text !== "string") return block;
		const converted = convertLatexToUnicode(candidate.text);
		if (!converted.changed) return block;
		changed = true;
		return { ...candidate, text: converted.text };
	});
	return { content: changed ? blocks : content, changed };
}

/** Return an immutable rewritten user/assistant message. */
export function rewriteMessage<T extends MessageLike>(message: T): RewriteResult<T> {
	if (message.role !== "user" && message.role !== "assistant") return { message, changed: false };
	const rewritten = rewriteContent(message.content);
	if (!rewritten.changed) return { message, changed: false };
	return { message: { ...message, content: rewritten.content }, changed: true };
}

/** Rewrite a loaded message object while retaining references held by the agent. */
export function rewriteMessageInPlace(message: MessageLike): boolean {
	const rewritten = rewriteMessage(message);
	if (!rewritten.changed) return false;
	message.content = rewritten.message.content;
	return true;
}
