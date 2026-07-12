// @ts-ignore Node types are supplied by the test runner, not this extension.
import assert from "node:assert/strict";
// @ts-ignore Node types are supplied by the test runner, not this extension.
import test from "node:test";
import { rewriteMessage, rewriteMessageInPlace } from "./rewrite.ts";

test("rewrites user strings without mutating the source", () => {
	const source = { role: "user", content: String.raw`Result: $x^2$`, timestamp: 1 };
	const rewritten = rewriteMessage(source);
	assert.equal(rewritten.changed, true);
	assert.equal(rewritten.message.content, "Result: x²");
	assert.equal(source.content, String.raw`Result: $x^2$`);
});

test("rewrites only assistant text blocks and preserves other blocks", () => {
	const toolCall = { type: "toolCall", id: "1" };
	const source = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "$hidden$" }, { type: "text", text: "$x_1$" }, toolCall],
	};
	const rewritten = rewriteMessage(source);
	assert.deepEqual(rewritten.message.content, [
		{ type: "thinking", thinking: "$hidden$" },
		{ type: "text", text: "x₁" },
		toolCall,
	]);
	assert.equal((source.content[1] as { text: string }).text, "$x_1$");
});

test("rewrites loaded history in place while retaining message identity", () => {
	const message = { role: "assistant", content: [{ type: "text", text: String.raw`$\alpha$` }] };
	const identity = message;
	assert.equal(rewriteMessageInPlace(message), true);
	assert.equal(message, identity);
	assert.deepEqual(message.content, [{ type: "text", text: "α" }]);
	assert.equal(rewriteMessageInPlace(message), false);
});

test("ignores tool and custom messages", () => {
	for (const role of ["toolResult", "custom"]) {
		const message = { role, content: "$x$" };
		assert.deepEqual(rewriteMessage(message), { message, changed: false });
	}
});
