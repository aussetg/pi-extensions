import type { PierreRendererConfig } from "./config.ts";
import type { PierreTerminalPalette } from "./theme.ts";
import type { DiffRow } from "./types.ts";

export interface GutterRenderSegment {
  text: string;
  fg?: string;
  bg?: string;
}

type LineRow = Extract<DiffRow, { kind: "line" }>;

export function continuationPrefixSegments(
  prefixWidth: number,
  row: LineRow,
  palette: PierreTerminalPalette,
  config: PierreRendererConfig,
  visibleWidth: (text: string) => number,
): GutterRenderSegment[] {
  const pad = " ".repeat(config.layout.leftPadding);
  const numberBg = lineNumberBg(row.lineType, palette);
  const bar = lineBar(row.lineType, config);

  if (config.gutter.barPosition === "before-number") {
    const rest = Math.max(
      0,
      prefixWidth -
        visibleWidth(pad + bar + config.gutter.barGap) -
        visibleWidth(config.gutter.separator),
    );

    return [
      { text: pad, fg: row.rowFg, bg: palette.editorBg },
      { text: bar, ...lineBarColors(row.lineType, palette) },
      { text: config.gutter.barGap, fg: palette.gutterFg, bg: numberBg },
      { text: " ".repeat(rest), fg: palette.lineNumberFg, bg: numberBg },
      { text: config.gutter.separator, fg: palette.gutterFg, bg: row.rowBg },
    ];
  }

  const rest = Math.max(
    0,
    prefixWidth - visibleWidth(pad + bar + config.gutter.barGap),
  );

  return [
    { text: pad, fg: row.rowFg, bg: palette.editorBg },
    { text: " ".repeat(rest), fg: palette.lineNumberFg, bg: numberBg },
    { text: bar, ...lineBarColors(row.lineType, palette) },
    { text: config.gutter.barGap, fg: row.rowFg, bg: row.rowBg },
  ];
}

export function lineNumberBg(
  lineType: "context" | "addition" | "deletion",
  palette: PierreTerminalPalette,
): string {
  if (lineType === "addition") return palette.additionLineNumberBg;
  if (lineType === "deletion") return palette.deletionLineNumberBg;
  return palette.lineNumberBg;
}

export function lineBar(
  lineType: "context" | "addition" | "deletion",
  config: PierreRendererConfig,
): string {
  return lineType === "addition"
    ? config.gutter.additionBar
    : lineType === "deletion"
      ? config.gutter.deletionBar
      : config.gutter.contextBar;
}

export function lineBarColors(
  lineType: "context" | "addition" | "deletion",
  palette: PierreTerminalPalette,
): Pick<GutterRenderSegment, "fg" | "bg"> {
  if (lineType === "addition") {
    return { fg: palette.additionBarFg, bg: palette.additionBarBg };
  }
  if (lineType === "deletion") {
    return { fg: palette.deletionBarFg, bg: palette.deletionBarBg };
  }
  return { fg: palette.contextBarFg, bg: palette.contextBarBg };
}
