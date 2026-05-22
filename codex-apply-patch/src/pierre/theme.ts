import type { PierreAppearance } from "./types.ts";
import {
  DEFAULT_PIERRE_RENDERER_CONFIG,
  type PierreColorValue,
  type PierreRendererConfig,
} from "./config.ts";

export interface PiThemeLike {
  name?: string;
  fg?: (color: string, text: string) => string;
  bg?: (color: string, text: string) => string;
  getFgAnsi?: (color: string) => string;
  getBgAnsi?: (color: string) => string;
}

export interface PierreTerminalPalette {
  appearance: PierreAppearance;
  editorBg: string;
  headerBg: string;
  headerFg: string;
  headerAccentFg: string;
  contextFg: string;
  contextRowBg: string;
  additionFg: string;
  additionRowBg: string;
  deletionFg: string;
  deletionRowBg: string;
  lineNumberFg: string;
  lineNumberBg: string;
  additionLineNumberFg: string;
  additionLineNumberBg: string;
  deletionLineNumberFg: string;
  deletionLineNumberBg: string;
  gutterFg: string;
  gutterBg: string;
  contextBarFg: string;
  contextBarBg: string;
  additionBarFg: string;
  additionBarBg: string;
  deletionBarFg: string;
  deletionBarBg: string;
  hunkFg: string;
  hunkKeyFg: string;
  hunkBg: string;
  additionWordBg: string;
  deletionWordBg: string;
  syntaxText: string;
  syntaxComment: string;
  syntaxKeyword: string;
  syntaxFunction: string;
  syntaxVariable: string;
  syntaxString: string;
  syntaxNumber: string;
  syntaxType: string;
  syntaxOperator: string;
  syntaxPunctuation: string;
  metadataFg: string;
  metadataBg: string;
  pendingFg: string;
  pendingBg: string;
  successFg: string;
  successBg: string;
  errorFg: string;
  errorBg: string;
}

export function getPierreAppearance(theme: PiThemeLike): PierreAppearance {
  return theme.name?.toLowerCase().includes("light") ? "light" : "dark";
}

export function getPierrePalette(
  theme: PiThemeLike,
  config: PierreRendererConfig = DEFAULT_PIERRE_RENDERER_CONFIG,
): PierreTerminalPalette {
  return buildPalette(theme, getPierreAppearance(theme), config);
}

function buildPalette(
  theme: PiThemeLike,
  appearance: PierreAppearance,
  config: PierreRendererConfig,
): PierreTerminalPalette {
  const colors = config.colors;
  const successBg = bg(
    theme,
    pickColor(colors.successBg, appearance),
    fallback(appearance, "#1e2e1e", "#e8f5e8"),
  );
  const errorBg = bg(
    theme,
    pickColor(colors.errorBg, appearance),
    fallback(appearance, "#2e1e1e", "#f8e8e8"),
  );
  const pendingBg = bg(
    theme,
    pickColor(colors.pendingBg, appearance),
    fallback(appearance, "#1e1e2e", "#ececf8"),
  );

  return {
    appearance,
    editorBg: bg(
      theme,
      pickColor(colors.editorBg, appearance),
      fallback(appearance, "#1e2e1e", "#e8f5e8"),
    ),
    headerBg: bg(
      theme,
      pickColor(colors.headerBg, appearance),
      fallback(appearance, "#1e2e1e", "#e8f5e8"),
    ),
    headerFg: fg(theme, pickColor(colors.headerFg, appearance), fallback(appearance, "#f5c542", "#805800")),
    headerAccentFg: fg(theme, pickColor(colors.headerAccentFg, appearance), fallback(appearance, "#48b7ff", "#0062cc")),
    contextFg: fg(theme, pickColor(colors.contextFg, appearance), fallback(appearance, "#a0a0a0", "#606060")),
    contextRowBg: bg(
      theme,
      pickColor(colors.contextRowBg, appearance),
      fallback(appearance, "#1e2e1e", "#e8f5e8"),
    ),
    additionFg: fg(theme, pickColor(colors.additionFg, appearance), fallback(appearance, "#00d787", "#00875f")),
    additionRowBg: bg(
      theme,
      pickColor(colors.additionRowBg, appearance),
      fallback(appearance, "#1e2e1e", "#e8f5e8"),
    ),
    deletionFg: fg(theme, pickColor(colors.deletionFg, appearance), fallback(appearance, "#ff5f5f", "#d70000")),
    deletionRowBg: bg(
      theme,
      pickColor(colors.deletionRowBg, appearance),
      fallback(appearance, "#2e1e1e", "#f8e8e8"),
    ),
    lineNumberFg: fg(theme, pickColor(colors.lineNumberFg, appearance), fallback(appearance, "#6f6f6f", "#8a8a8a")),
    lineNumberBg: bg(
      theme,
      pickColor(colors.lineNumberBg, appearance),
      fallback(appearance, "#1e2e1e", "#e8f5e8"),
    ),
    additionLineNumberFg: fg(theme, pickColor(colors.additionLineNumberFg, appearance), fallback(appearance, "#00d787", "#00875f")),
    additionLineNumberBg: bg(
      theme,
      pickColor(colors.additionLineNumberBg, appearance),
      fallback(appearance, "#1e2e1e", "#e8f5e8"),
    ),
    deletionLineNumberFg: fg(theme, pickColor(colors.deletionLineNumberFg, appearance), fallback(appearance, "#ff5f5f", "#d70000")),
    deletionLineNumberBg: bg(
      theme,
      pickColor(colors.deletionLineNumberBg, appearance),
      fallback(appearance, "#2e1e1e", "#f8e8e8"),
    ),
    gutterFg: fg(theme, pickColor(colors.gutterFg, appearance), fallback(appearance, "#6f6f6f", "#8a8a8a")),
    gutterBg: bg(
      theme,
      pickColor(colors.gutterBg, appearance),
      fallback(appearance, "#1e2e1e", "#e8f5e8"),
    ),
    contextBarFg: fg(theme, pickColor(colors.contextBarFg, appearance), fallback(appearance, "#6f6f6f", "#8a8a8a")),
    contextBarBg: bg(
      theme,
      pickColor(colors.contextBarBg, appearance),
      fallback(appearance, "#1e2e1e", "#e8f5e8"),
    ),
    additionBarFg: fg(theme, pickColor(colors.additionBarFg, appearance), fallback(appearance, "#00d787", "#00875f")),
    additionBarBg: bg(
      theme,
      pickColor(colors.additionBarBg, appearance),
      fallback(appearance, "#1e2e1e", "#e8f5e8"),
    ),
    deletionBarFg: fg(theme, pickColor(colors.deletionBarFg, appearance), fallback(appearance, "#ff5f5f", "#d70000")),
    deletionBarBg: bg(
      theme,
      pickColor(colors.deletionBarBg, appearance),
      fallback(appearance, "#2e1e1e", "#f8e8e8"),
    ),
    hunkFg: fg(theme, pickColor(colors.hunkFg, appearance), fallback(appearance, "#8a8a8a", "#707070")),
    hunkKeyFg: fg(theme, pickColor(colors.hunkKeyFg, appearance), fallback(appearance, "#6f6f6f", "#8a8a8a")),
    hunkBg: bg(
      theme,
      pickColor(colors.hunkBg, appearance),
      fallback(appearance, "#282828", "#e5e5e5"),
    ),
    additionWordBg: bg(
      theme,
      pickColor(colors.additionWordBg, appearance),
      fallback(appearance, "#214a34", "#c8efd8"),
    ),
    deletionWordBg: bg(
      theme,
      pickColor(colors.deletionWordBg, appearance),
      fallback(appearance, "#5a2a2a", "#ffd0d0"),
    ),
    syntaxText: fg(theme, pickColor(colors.syntaxText, appearance), fallback(appearance, "#ebdbb2", "#3c3836")),
    syntaxComment: fg(theme, pickColor(colors.syntaxComment, appearance), fallback(appearance, "#928374", "#7c6f64")),
    syntaxKeyword: fg(theme, pickColor(colors.syntaxKeyword, appearance), fallback(appearance, "#fb4934", "#9d0006")),
    syntaxFunction: fg(theme, pickColor(colors.syntaxFunction, appearance), fallback(appearance, "#fabd2f", "#b57614")),
    syntaxVariable: fg(theme, pickColor(colors.syntaxVariable, appearance), fallback(appearance, "#ebdbb2", "#3c3836")),
    syntaxString: fg(theme, pickColor(colors.syntaxString, appearance), fallback(appearance, "#b8bb26", "#79740e")),
    syntaxNumber: fg(theme, pickColor(colors.syntaxNumber, appearance), fallback(appearance, "#d3869b", "#8f3f71")),
    syntaxType: fg(theme, pickColor(colors.syntaxType, appearance), fallback(appearance, "#8ec07c", "#427b58")),
    syntaxOperator: fg(theme, pickColor(colors.syntaxOperator, appearance), fallback(appearance, "#fe8019", "#af3a03")),
    syntaxPunctuation: fg(theme, pickColor(colors.syntaxPunctuation, appearance), fallback(appearance, "#a89984", "#7c6f64")),
    metadataFg: fg(theme, pickColor(colors.metadataFg, appearance), fallback(appearance, "#6f6f6f", "#8a8a8a")),
    metadataBg: bg(
      theme,
      pickColor(colors.metadataBg, appearance),
      fallback(appearance, "#1e2e1e", "#e8f5e8"),
    ),
    pendingFg: fg(theme, pickColor(colors.pendingFg, appearance), fallback(appearance, "#ffd75f", "#875f00")),
    pendingBg,
    successFg: fg(theme, pickColor(colors.successFg, appearance), fallback(appearance, "#00d787", "#00875f")),
    successBg,
    errorFg: fg(theme, pickColor(colors.errorFg, appearance), fallback(appearance, "#ff5f5f", "#d70000")),
    errorBg,
  };
}

function pickColor(value: PierreColorValue, appearance: PierreAppearance): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return value[appearance] ?? value.dark ?? value.light ?? "";
}

function fallback(appearance: PierreAppearance, dark: string, light: string) {
  return appearance === "dark" ? dark : light;
}

function fg(theme: PiThemeLike, color: string, fallbackColor: string): string {
  const direct = directColor(color);
  if (direct) return direct;
  return theme.getFgAnsi?.(color) ?? probeAnsi(theme.fg, color) ?? fallbackColor;
}

function bg(theme: PiThemeLike, color: string, fallbackColor: string): string {
  const direct = directColor(color);
  if (direct) return direct;
  return theme.getBgAnsi?.(color) ?? probeAnsi(theme.bg, color) ?? fallbackColor;
}

function directColor(color: string): string | undefined {
  const normalized = color.trim();
  if (!normalized) return undefined;
  if (normalized.includes("\u001b[")) return normalized;
  if (/^#[0-9a-fA-F]{6}$/.test(normalized)) return normalized;
  return undefined;
}

function probeAnsi(
  render: ((color: string, text: string) => string) | undefined,
  color: string,
): string | undefined {
  if (!render) return undefined;
  const marker = "__PI_THEME_PROBE__";
  try {
    const styled = render(color, marker);
    const markerIndex = styled.indexOf(marker);
    if (markerIndex <= 0) return undefined;
    return styled.slice(0, markerIndex);
  } catch {
    return undefined;
  }
}
