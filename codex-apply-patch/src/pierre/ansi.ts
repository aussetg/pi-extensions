export const ANSI_RESET = "\u001b[22m\u001b[39m\u001b[49m";

export interface AnsiStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
}

export interface AnsiSegment extends AnsiStyle {
  text: string;
}

const ANSI_STYLE_CACHE_LIMIT = 2048;
const ANSI_COLOR_CACHE_LIMIT = 512;
const ansiStyleCache = new Map<string, string>();
const ansiColorCache = new Map<string, string>();

export function renderAnsiSegments(
  segments: readonly AnsiSegment[],
  base: AnsiStyle,
): string {
  const baseFg = base.fg;
  const baseBg = base.bg;
  const baseBold = base.bold;
  let output = openAnsiStyle(baseFg, baseBg, baseBold);

  for (const segment of segments) {
    output += openAnsiStyle(
      segment.fg ?? baseFg,
      segment.bg ?? baseBg,
      segment.bold ?? baseBold,
    );
    output += segment.text;
  }

  output += openAnsiStyle(baseFg, baseBg, baseBold);
  return output;
}

export function openAnsi(style: AnsiStyle): string {
  return openAnsiStyle(style.fg, style.bg, style.bold);
}

function openAnsiStyle(
  fg: string | undefined,
  bg: string | undefined,
  bold: boolean | undefined,
): string {
  const key = `${bold ? "1" : "0"}|${cachePart(fg)}|${cachePart(bg)}`;
  const cached = ansiStyleCache.get(key);
  if (cached !== undefined) return cached;

  const ansi = `${bold ? "\u001b[1m" : "\u001b[22m"}${colorToAnsi(
    fg,
    "fg",
  )}${colorToAnsi(bg, "bg")}`;
  cacheSet(ansiStyleCache, key, ansi, ANSI_STYLE_CACHE_LIMIT);
  return ansi;
}

function colorToAnsi(
  color: string | undefined,
  slot: "fg" | "bg",
): string {
  const key = `${slot}|${cachePart(color)}`;
  const cached = ansiColorCache.get(key);
  if (cached !== undefined) return cached;

  const ansi = buildColorAnsi(color, slot);
  cacheSet(ansiColorCache, key, ansi, ANSI_COLOR_CACHE_LIMIT);
  return ansi;
}

function cachePart(value: string | undefined): string {
  const text = value ?? "";
  return `${text.length}:${text}`;
}

function buildColorAnsi(
  color: string | undefined,
  slot: "fg" | "bg",
): string {
  const reset = slot === "fg" ? "\u001b[39m" : "\u001b[49m";
  const normalized = color?.trim();
  if (!normalized) return reset;

  if (normalized.includes("\u001b[")) return normalized;

  const rgb = toRgb(normalized);
  if (!rgb) return reset;

  const prefix = slot === "fg" ? "38" : "48";
  return `\u001b[${prefix};2;${rgb.r};${rgb.g};${rgb.b}m`;
}

function toRgb(hex: string) {
  const normalized = hex.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) return undefined;

  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function cacheSet(
  cache: Map<string, string>,
  key: string,
  value: string,
  limit: number,
): void {
  cache.set(key, value);
  if (cache.size <= limit) return;

  const oldestKey = cache.keys().next().value;
  if (typeof oldestKey === "string") cache.delete(oldestKey);
}
