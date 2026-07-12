import { convertLatexToUnicode } from "./converter.ts";

const MARKDOWN_PATCH = Symbol.for("latex-unicode.markdown-render");

export interface MarkdownLike {
	text: string;
	render(width: number): string[];
	[MARKDOWN_PATCH]?: { originalRender: (this: MarkdownLike, width: number) => string[] };
}

type MarkdownConstructor = { prototype?: MarkdownLike };
type Convert = (text: string) => string;

/** Install an idempotent, render-only conversion layer on a Markdown class. */
export function patchMarkdownRenderer(
	MarkdownClass: MarkdownConstructor,
	convert: Convert = (text) => convertLatexToUnicode(text).text,
): () => void {
	const prototype = MarkdownClass.prototype;
	if (!prototype || typeof prototype.render !== "function") return () => {};

	const previous = prototype[MARKDOWN_PATCH];
	const originalRender = previous?.originalRender ?? prototype.render;
	const cache = new WeakMap<object, { source: string; rendered: string }>();

	const patchedRender = function renderLatexUnicode(this: MarkdownLike, width: number): string[] {
		const source = this.text;
		let conversion = cache.get(this);
		if (!conversion || conversion.source !== source) {
			conversion = { source, rendered: convert(source) };
			cache.set(this, conversion);
		}

		// Markdown's own render cache keys on `text`, so repeated TUI frames stay
		// cheap after this one cached conversion. Restore immediately: the source
		// message, session file, and model context remain untouched.
		this.text = conversion.rendered;
		try {
			return originalRender.call(this, width);
		} finally {
			this.text = source;
		}
	};
	prototype.render = patchedRender;

	if (!previous) {
		Object.defineProperty(prototype, MARKDOWN_PATCH, {
			value: { originalRender },
			configurable: false,
		});
	}

	return () => {
		// Do not overwrite a patch installed after ours.
		if (prototype.render === patchedRender) prototype.render = originalRender;
	};
}
