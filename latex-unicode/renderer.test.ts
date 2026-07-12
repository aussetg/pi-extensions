// @ts-ignore Node types are supplied by the test runner, not this extension.
import assert from "node:assert/strict";
// @ts-ignore Node types are supplied by the test runner, not this extension.
import test from "node:test";
import { patchMarkdownRenderer } from "./renderer.ts";

test("converts only while Markdown renders and caches stable source text", () => {
	class FakeMarkdown {
		text: string;
		constructor(text: string) {
			this.text = text;
		}
		render(width: number): string[] {
			return [`${width}:${this.text}`];
		}
	}

	let conversions = 0;
	const unpatch = patchMarkdownRenderer(FakeMarkdown, (text) => {
		conversions += 1;
		return text.replace("$x^2$", "x²");
	});

	const markdown = new FakeMarkdown("result: $x^2$");
	assert.deepEqual(markdown.render(80), ["80:result: x²"]);
	assert.equal(markdown.text, "result: $x^2$");
	assert.deepEqual(markdown.render(40), ["40:result: x²"]);
	assert.equal(conversions, 1);

	markdown.text = "$x^2$ again";
	assert.deepEqual(markdown.render(40), ["40:x² again"]);
	assert.equal(markdown.text, "$x^2$ again");
	assert.equal(conversions, 2);

	unpatch();
	assert.deepEqual(markdown.render(40), ["40:$x^2$ again"]);
});

test("reloading replaces the patch instead of nesting it", () => {
	class FakeMarkdown {
		text: string;
		constructor(text: string) {
			this.text = text;
		}
		render(): string[] {
			return [this.text];
		}
	}

	patchMarkdownRenderer(FakeMarkdown, (text) => `[old:${text}]`);
	patchMarkdownRenderer(FakeMarkdown, (text) => `[new:${text}]`);
	const markdown = new FakeMarkdown("source");
	assert.deepEqual(markdown.render(), ["[new:source]"]);
	assert.equal(markdown.text, "source");
});
