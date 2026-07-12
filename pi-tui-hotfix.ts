// @ts-ignore The pi runtime provides this package to extensions.
import { Box } from "@earendil-works/pi-tui";

const BOX_RENDER_PATCH = Symbol.for("pi-tui-hotfix.box-render-cache");

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

export default function (): void {
	patchBoxRenderCache();
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
