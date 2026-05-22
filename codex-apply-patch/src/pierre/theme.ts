import type { PierreAppearance } from "./types.ts";

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

export function getPierrePalette(theme: PiThemeLike): PierreTerminalPalette {
  return buildPalette(theme, getPierreAppearance(theme));
}

function buildPalette(theme: PiThemeLike, appearance: PierreAppearance): PierreTerminalPalette {
  const successBg = bg(theme, "toolSuccessBg", fallback(appearance, "#1e2e1e", "#e8f5e8"));
  const errorBg = bg(theme, "toolErrorBg", fallback(appearance, "#2e1e1e", "#f8e8e8"));
  const pendingBg = bg(theme, "toolPendingBg", fallback(appearance, "#1e1e2e", "#ececf8"));

  return {
    appearance,
    editorBg: successBg,
    headerBg: successBg,
    headerFg: fg(theme, "toolTitle", fallback(appearance, "#f5c542", "#805800")),
    headerAccentFg: fg(theme, "accent", fallback(appearance, "#48b7ff", "#0062cc")),
    contextFg: fg(theme, "toolDiffContext", fallback(appearance, "#a0a0a0", "#606060")),
    contextRowBg: successBg,
    additionFg: fg(theme, "toolDiffAdded", fallback(appearance, "#00d787", "#00875f")),
    additionRowBg: successBg,
    deletionFg: fg(theme, "toolDiffRemoved", fallback(appearance, "#ff5f5f", "#d70000")),
    deletionRowBg: errorBg,
    lineNumberFg: fg(theme, "dim", fallback(appearance, "#6f6f6f", "#8a8a8a")),
    metadataFg: fg(theme, "dim", fallback(appearance, "#6f6f6f", "#8a8a8a")),
    metadataBg: successBg,
    pendingFg: fg(theme, "warning", fallback(appearance, "#ffd75f", "#875f00")),
    pendingBg,
    successFg: fg(theme, "success", fallback(appearance, "#00d787", "#00875f")),
    successBg,
    errorFg: fg(theme, "error", fallback(appearance, "#ff5f5f", "#d70000")),
    errorBg,
  };
}

function fallback(appearance: PierreAppearance, dark: string, light: string) {
  return appearance === "dark" ? dark : light;
}

function fg(theme: PiThemeLike, color: string, fallbackColor: string): string {
  return theme.getFgAnsi?.(color) ?? probeAnsi(theme.fg, color) ?? fallbackColor;
}

function bg(theme: PiThemeLike, color: string, fallbackColor: string): string {
  return theme.getBgAnsi?.(color) ?? probeAnsi(theme.bg, color) ?? fallbackColor;
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
