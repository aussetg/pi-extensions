export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function truncateBytes(text: string, maxBytes: number, suffix = "…"): string {
  if (byteLength(text) <= maxBytes) return text;
  let out = text.slice(0, Math.max(0, maxBytes - suffix.length));
  while (byteLength(out + suffix) > maxBytes && out.length > 0) out = out.slice(0, -1);
  return out + suffix;
}

export function truncateLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n… ${lines.length - maxLines} more line(s)`;
}

export function truncateForChat(value: unknown, maxBytes: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return truncateBytes(truncateLines(text ?? "", 200), maxBytes);
}

export function stripAnsi(text: string): string {
  // CSI + OSC-ish control sequences, enough for sanitizing untrusted workflow text.
  return text.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function sanitizeText(value: unknown, maxBytes = 16_384): string {
  const text = stripAnsi(String(value ?? ""))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "�")
    .replace(/\r/g, "");
  return truncateBytes(text, maxBytes);
}

export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

export function truncateToWidth(text: string, width: number, suffix = "…"): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const suffixWidth = visibleWidth(suffix);
  if (width <= suffixWidth) return takeVisible(suffix, width);
  return takeVisible(text, width - suffixWidth) + suffix;
}

export function padToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function takeVisible(text: string, width: number): string {
  let out = "";
  let used = 0;
  for (let i = 0; i < text.length && used < width; ) {
    const ansiEnd = readAnsiSequenceEnd(text, i);
    if (ansiEnd !== undefined) {
      out += text.slice(i, ansiEnd);
      i = ansiEnd;
      continue;
    }

    const codePoint = text.codePointAt(i);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    const charWidth = visibleWidth(char);
    if (used + charWidth > width) break;
    out += char;
    used += charWidth;
    i += char.length;
  }
  return out;
}

function readAnsiSequenceEnd(text: string, start: number): number | undefined {
  if (text.charCodeAt(start) !== 0x1b) return undefined;
  const next = text[start + 1];
  if (!next) return undefined;

  if (next === "[") {
    for (let i = start + 2; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i + 1;
    }
    return text.length;
  }

  if (next === "]") {
    for (let i = start + 2; i < text.length; i++) {
      if (text.charCodeAt(i) === 0x07) return i + 1;
      if (text.charCodeAt(i) === 0x1b && text[i + 1] === "\\") return i + 2;
    }
    return text.length;
  }

  return Math.min(text.length, start + 2);
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
