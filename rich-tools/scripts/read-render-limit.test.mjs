import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

const workflowRequire = createRequire(new URL("../../workflows/package.json", import.meta.url));
const actualTui = pathToFileURL(workflowRequire.resolve("@earendil-works/pi-tui")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-tui") {
      return { shortCircuit: true, url: actualTui };
    }
    return nextResolve(specifier, context);
  },
});

const { DEFAULT_PIERRE_RENDERER_CONFIG } = await import("../src/pierre/config.ts");
const { PierreInlineDiffComponent } = await import("../src/pierre/component.ts");
const { resetPierreRendererState } = await import("../src/pierre/reset.ts");
const { visibleWidth } = await import(actualTui);
const {
  pierreRowCacheStats,
  resetPierreRowCache,
} = await import("../src/pierre/rows.ts");

const theme = { name: "dark" };

test("Pierre rendering respects widths below twenty columns", () => {
  const component = new PierreInlineDiffComponent(
    contextPayload([
      "narrow terminal content",
      "漢字 and emoji 😀",
      "third line",
    ]),
    theme,
    { showFileHeaders: true },
  );

  for (let width = 1; width < 20; width += 1) {
    const full = component.render(width);
    const limited = component.renderLimited(width, 2).lines;

    assert.ok(full.length > 0);
    for (const line of [...full, ...limited]) {
      assert.ok(
        visibleWidth(line) <= width,
        `rendered ${visibleWidth(line)} columns at width ${width}`,
      );
    }
  }
});

test("limited context rendering matches the first rendered terminal lines", () => {
  const payload = contextPayload([
    "short",
    "a line with several words that wraps at a narrow terminal width",
    "漢字かなカナ한글 mixed with words",
    "emoji 😀😀😀 and café",
    "x".repeat(80),
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
  ]);
  const width = 32;
  const fullComponent = new PierreInlineDiffComponent(payload, theme, {
    showFileHeaders: false,
    suppressLeadingSpacing: true,
  });
  const full = fullComponent.render(width);
  const trailing = DEFAULT_PIERRE_RENDERER_CONFIG.spacing.afterDiff;
  const contentEnd = full.length - trailing;

  const limitedComponent = new PierreInlineDiffComponent(payload, theme, {
    showFileHeaders: false,
    suppressLeadingSpacing: true,
  });
  const limited = limitedComponent.renderLimited(width, 10);

  assert.deepEqual(limited.lines, [
    ...full.slice(0, 10),
    ...full.slice(contentEnd),
  ]);
  assert.equal(limited.omittedLines, contentEnd - 10);
  assert.strictEqual(limitedComponent.renderLimited(width, 10).lines, limited.lines);
});

test("limited context rendering does not build or retain every diff row", () => {
  resetPierreRowCache();
  const payload = contextPayload(
    Array.from({ length: 2_000 }, (_, index) => `line ${index + 1}`),
  );
  const component = new PierreInlineDiffComponent(payload, theme, {
    showFileHeaders: false,
    suppressLeadingSpacing: true,
  });

  const rendered = component.renderLimited(120, 10);

  assert.equal(rendered.lines.length, 10 + DEFAULT_PIERRE_RENDERER_CONFIG.spacing.afterDiff);
  assert.equal(rendered.omittedLines, 1_990);
  assert.equal(pierreRowCacheStats().entries, 0);
  resetPierreRowCache();
});

test("limited context rendering highlights only the visible source prefix", async () => {
  resetPierreRendererState();
  const payload = contextPayload(
    Array.from(
      { length: DEFAULT_PIERRE_RENDERER_CONFIG.syntaxHighlight.maxLines + 100 },
      (_, index) => `export const value${index}: number = ${index};`,
    ),
    "read-preview.ts",
    "typescript",
  );
  let resolveInvalidation;
  const invalidated = new Promise((resolve) => {
    resolveInvalidation = resolve;
  });
  const component = new PierreInlineDiffComponent(payload, theme, {
    showFileHeaders: false,
    suppressLeadingSpacing: true,
    onInvalidate: resolveInvalidation,
  });
  const plain = component.renderLimited(120, 10).lines;

  let invalidationTimeout;
  try {
    await Promise.race([
      invalidated,
      new Promise((_, reject) => {
        invalidationTimeout = setTimeout(
          () => reject(new Error("prefix highlighter did not invalidate")),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(invalidationTimeout);
  }

  const highlighted = component.renderLimited(120, 10).lines;
  assert.notDeepEqual(highlighted, plain);
  resetPierreRendererState();
});

function contextPayload(lines, path = "read-preview.txt", lang = "text") {
  const count = lines.length;
  return {
    path,
    metadata: {
      name: path,
      lang,
      type: "change",
      hunks: [{
        collapsedBefore: 0,
        additionStart: 1,
        additionCount: count,
        additionLines: 0,
        additionLineIndex: 0,
        deletionStart: 1,
        deletionCount: count,
        deletionLines: 0,
        deletionLineIndex: 0,
        hunkContent: [{
          type: "context",
          lines: count,
          additionLineIndex: 0,
          deletionLineIndex: 0,
        }],
        hunkSpecs: `@@ -1,${count} +1,${count} @@`,
        splitLineStart: 0,
        splitLineCount: count,
        unifiedLineStart: 0,
        unifiedLineCount: count,
        noEOFCRDeletions: false,
        noEOFCRAdditions: false,
      }],
      splitLineCount: count,
      unifiedLineCount: count,
      isPartial: true,
      deletionLines: [...lines],
      additionLines: [...lines],
      cacheKey: `read-render-limit:${count}:${lines[0] ?? ""}`,
    },
  };
}
