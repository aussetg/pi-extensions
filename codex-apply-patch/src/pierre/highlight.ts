import type {
  DiffSpan,
  HastNode,
  HighlightedDiffCode,
  HighlightedDiffSet,
  PierreAppearance,
} from "./types.ts";
import { emptyHighlightedDiffSet } from "./types.ts";

export async function loadHighlightedDiff(
  _metadata: unknown,
): Promise<HighlightedDiffSet> {
  return emptyHighlightedDiffSet();
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
  _appearance: PierreAppearance,
  emphasisBg: string,
  fallbackText: string,
): DiffSpan[] {
  const spans: DiffSpan[] = [];

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
    const nextStyle: Pick<DiffSpan, "fg" | "bg"> = {
      // Pierre/Shiki token colors are intentionally ignored here. The terminal
      // renderer should inherit Pi's active theme, so syntax-level colors must
      // not smuggle Pierre's palette into the TUI. We still keep Pierre's
      // token tree so changed-word spans can carry the row-local emphasis bg.
      fg: inherited.fg,
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

function cleanLastNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
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
