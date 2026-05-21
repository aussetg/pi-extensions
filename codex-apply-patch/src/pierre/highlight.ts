import {
  cleanLastNewline,
  getHighlighterOptions,
  getSharedHighlighter,
  renderDiffWithHighlighter,
  type FileDiffMetadata,
} from "@pierre/diffs";
import type {
  DiffSpan,
  HastNode,
  HighlightedDiffCode,
  HighlightedDiffSet,
  PierreAppearance,
} from "./types.ts";
import { emptyHighlightedDiffSet } from "./types.ts";

const PIERRE_THEME_NAMES = {
  dark: "pierre-dark",
  light: "pierre-light",
} as const;

const PIERRE_RENDER_OPTIONS = {
  dark: {
    theme: PIERRE_THEME_NAMES.dark,
    useTokenTransformer: false,
    tokenizeMaxLineLength: 1000,
    lineDiffType: "word-alt" as const,
    maxLineDiffLength: 2000,
  },
  light: {
    theme: PIERRE_THEME_NAMES.light,
    useTokenTransformer: false,
    tokenizeMaxLineLength: 1000,
    lineDiffType: "word-alt" as const,
    maxLineDiffLength: 2000,
  },
} as const;

type HighlightOptions = ReturnType<typeof getHighlighterOptions>;

const highlighterOptionsByKey = new Map<string, HighlightOptions>();

export async function loadHighlightedDiff(
  metadata: FileDiffMetadata,
): Promise<HighlightedDiffSet> {
  const [dark, light] = await Promise.all([
    highlightForAppearance(metadata, "dark"),
    highlightForAppearance(metadata, "light"),
  ]);

  return { dark, light };
}

export function normalizeHighlightedDiffSet(
  highlighted: unknown,
): HighlightedDiffSet {
  if (!highlighted || typeof highlighted !== "object") {
    return emptyHighlightedDiffSet();
  }

  const candidate = highlighted as Partial<HighlightedDiffSet>;
  return {
    dark: normalizeHighlightedDiffCode(candidate.dark),
    light: normalizeHighlightedDiffCode(candidate.light),
  };
}

export function hasHighlightedLines(highlighted: HighlightedDiffSet): boolean {
  return (
    highlighted.dark.deletionLines.length > 0 ||
    highlighted.dark.additionLines.length > 0 ||
    highlighted.light.deletionLines.length > 0 ||
    highlighted.light.additionLines.length > 0
  );
}

export function flattenHighlightedLine(
  node: HastNode | undefined,
  appearance: PierreAppearance,
  emphasisBg: string,
  fallbackText: string,
): DiffSpan[] {
  const spans: DiffSpan[] = [];
  const colorVariable =
    appearance === "light" ? "--diffs-token-light" : "--diffs-token-dark";

  const visit = (
    current: HastNode | undefined,
    inherited: Pick<DiffSpan, "fg" | "bg">,
  ) => {
    if (!current) return;

    if (current.type === "text") {
      mergeSpan(spans, {
        text: tabify(current.value),
        fg: inherited.fg,
        bg: inherited.bg,
      });
      return;
    }

    const properties = current.properties ?? {};
    const styles = parseStyleValue(properties.style);
    const nextStyle: Pick<DiffSpan, "fg" | "bg"> = {
      fg: styles.get(colorVariable) ?? styles.get("color") ?? inherited.fg,
      bg: Object.prototype.hasOwnProperty.call(properties, "data-diff-span")
        ? emphasisBg
        : inherited.bg,
    };

    for (const child of current.children ?? []) visit(child, nextStyle);
  };

  visit(node, {});

  return spans.length > 0
    ? spans
    : fallbackText.length > 0
      ? [{ text: fallbackText }]
      : [];
}

export function cleanDiffLine(line: string | undefined): string {
  return tabify(cleanLastNewline(line ?? "").replace(/\r$/, ""));
}

async function highlightForAppearance(
  metadata: FileDiffMetadata,
  appearance: PierreAppearance,
): Promise<HighlightedDiffCode> {
  try {
    const language = metadata.lang ?? "text";
    const cacheKey = `${appearance}:${language}`;
    const highlighterOptions =
      highlighterOptionsByKey.get(cacheKey) ??
      getHighlighterOptions(language, { theme: PIERRE_THEME_NAMES[appearance] });

    if (!highlighterOptionsByKey.has(cacheKey)) {
      highlighterOptionsByKey.set(cacheKey, highlighterOptions);
    }

    const highlighter = await getSharedHighlighter({
      ...highlighterOptions,
      preferredHighlighter: "shiki-js",
    });

    const highlighted = renderDiffWithHighlighter(
      metadata,
      highlighter,
      PIERRE_RENDER_OPTIONS[appearance],
    );

    return {
      deletionLines: highlighted.code.deletionLines as Array<HastNode | undefined>,
      additionLines: highlighted.code.additionLines as Array<HastNode | undefined>,
    };
  } catch {
    return { deletionLines: [], additionLines: [] };
  }
}

function normalizeHighlightedDiffCode(code: unknown): HighlightedDiffCode {
  if (!code || typeof code !== "object") {
    return { deletionLines: [], additionLines: [] };
  }

  const candidate = code as Partial<HighlightedDiffCode>;
  return {
    deletionLines: Array.isArray(candidate.deletionLines)
      ? candidate.deletionLines
      : [],
    additionLines: Array.isArray(candidate.additionLines)
      ? candidate.additionLines
      : [],
  };
}

function tabify(text: string): string {
  return text.replace(/\t/g, "    ");
}

function parseStyleValue(styleValue: unknown): Map<string, string> {
  const styles = new Map<string, string>();
  if (typeof styleValue !== "string") return styles;

  for (const segment of styleValue.split(";")) {
    const separator = segment.indexOf(":");
    if (separator <= 0) continue;

    const key = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (key && value) styles.set(key, value);
  }

  return styles;
}

function mergeSpan(target: DiffSpan[], next: DiffSpan): void {
  if (next.text.length === 0) return;

  const previous = target[target.length - 1];
  if (previous && previous.fg === next.fg && previous.bg === next.bg) {
    previous.text += next.text;
    return;
  }

  target.push(next);
}
