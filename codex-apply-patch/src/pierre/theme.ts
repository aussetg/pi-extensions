import pierreDarkTheme from "@pierre/theme/pierre-dark";
import pierreLightTheme from "@pierre/theme/pierre-light";
import type { PierreAppearance } from "./types.ts";

export interface PiThemeLike {
  name?: string;
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

const PALETTES: Record<PierreAppearance, PierreTerminalPalette> = {
  dark: buildPalette("dark", pierreDarkTheme),
  light: buildPalette("light", pierreLightTheme),
};

export function getPierreAppearance(theme: PiThemeLike): PierreAppearance {
  return theme.name?.toLowerCase().includes("light") ? "light" : "dark";
}

export function getPierrePalette(theme: PiThemeLike): PierreTerminalPalette {
  return PALETTES[getPierreAppearance(theme)];
}

function buildPalette(
  appearance: PierreAppearance,
  resolved: { colors?: Record<string, string>; fg?: string; bg?: string },
): PierreTerminalPalette {
  const colors = resolved.colors ?? {};
  const editorBg = resolved.bg ?? fallback(appearance, "#070707", "#ffffff");
  const foreground =
    colors["terminal.foreground"] ??
    colors.foreground ??
    resolved.fg ??
    fallback(appearance, "#d6d6d8", "#303034");
  const additionFg =
    colors["gitDecoration.addedResourceForeground"] ??
    colors["terminal.ansiGreen"] ??
    fallback(appearance, "#00cab1", "#008a78");
  const deletionFg =
    colors["gitDecoration.deletedResourceForeground"] ??
    colors["terminal.ansiRed"] ??
    fallback(appearance, "#ff5664", "#cf2433");

  return {
    appearance,
    editorBg,
    headerBg:
      colors["sideBar.background"] ?? colors["panel.background"] ?? editorBg,
    headerFg:
      colors["sideBar.foreground"] ??
      colors.foreground ??
      resolved.fg ??
      fallback(appearance, "#fbfbfb", "#070707"),
    headerAccentFg:
      colors["textLink.foreground"] ??
      colors["gitDecoration.modifiedResourceForeground"] ??
      colors.foreground ??
      resolved.fg ??
      fallback(appearance, "#48b7ff", "#0062cc"),
    contextFg: foreground,
    contextRowBg: editorBg,
    additionFg,
    additionRowBg:
      compositeOverBg(colors["diffEditor.insertedTextBackground"], editorBg) ??
      fallback(appearance, "#0c1f1d", "#e6fbf8"),
    deletionFg,
    deletionRowBg:
      compositeOverBg(colors["diffEditor.deletedTextBackground"], editorBg) ??
      fallback(appearance, "#261214", "#ffe9eb"),
    lineNumberFg:
      colors["editorLineNumber.foreground"] ??
      colors["terminal.foreground"] ??
      fallback(appearance, "#84848a", "#909095"),
    metadataFg:
      colors["editorLineNumber.foreground"] ??
      colors["terminal.foreground"] ??
      fallback(appearance, "#84848a", "#909095"),
    metadataBg: editorBg,
    pendingFg:
      colors["textLink.foreground"] ?? fallback(appearance, "#48b7ff", "#0062cc"),
    pendingBg: editorBg,
    successFg: additionFg,
    successBg:
      compositeOverBg(colors["diffEditor.insertedTextBackground"], editorBg) ??
      fallback(appearance, "#0c1f1d", "#e6fbf8"),
    errorFg: deletionFg,
    errorBg:
      compositeOverBg(colors["diffEditor.deletedTextBackground"], editorBg) ??
      fallback(appearance, "#261214", "#ffe9eb"),
  };
}

function compositeOverBg(foreground: string | undefined, background: string | undefined) {
  const fg = toRgbWithAlpha(foreground);
  const bg = toRgb(background);
  if (!fg || !bg) return undefined;

  const alpha = fg.a / 255;
  const r = Math.round(fg.r * alpha + bg.r * (1 - alpha));
  const g = Math.round(fg.g * alpha + bg.g * (1 - alpha));
  const b = Math.round(fg.b * alpha + bg.b * (1 - alpha));
  return toHex({ r, g, b });
}

function toRgbWithAlpha(hex: string | undefined) {
  const normalized = hex?.trim();
  if (!normalized) return undefined;
  if (/^#[0-9a-fA-F]{8}$/.test(normalized)) {
    return {
      r: Number.parseInt(normalized.slice(1, 3), 16),
      g: Number.parseInt(normalized.slice(3, 5), 16),
      b: Number.parseInt(normalized.slice(5, 7), 16),
      a: Number.parseInt(normalized.slice(7, 9), 16),
    };
  }

  const rgb = toRgb(normalized);
  return rgb ? { ...rgb, a: 255 } : undefined;
}

function toRgb(hex: string | undefined) {
  const normalized = hex?.trim();
  if (!normalized || !/^#[0-9a-fA-F]{6}$/.test(normalized)) return undefined;

  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function toHex(rgb: { r: number; g: number; b: number }) {
  return `#${toHexPart(rgb.r)}${toHexPart(rgb.g)}${toHexPart(rgb.b)}`;
}

function toHexPart(value: number) {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
}

function fallback(appearance: PierreAppearance, dark: string, light: string) {
  return appearance === "dark" ? dark : light;
}
