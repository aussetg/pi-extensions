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

export function sanitizeLine(value: unknown, maxBytes = 16_384): string {
  return sanitizeText(value, maxBytes)
    .replace(/\t/g, " ")
    .replace(/\n+/g, " ↵ ")
    .replace(/ {2,}/g, " ");
}

export interface SanitizeRenderedLineOptions {
  preserveAnsi?: boolean;
  tabWidth?: number;
}

const SGR_RESET = "\u001b[0m";

export function sanitizeRenderedLine(value: unknown, maxBytes = 16_384, options: SanitizeRenderedLineOptions = {}): string {
  const tabWidth = clamp(Math.trunc(options.tabWidth ?? 4), 1, 16);
  const text = options.preserveAnsi ? stripAnsiExceptSgr(String(value ?? "")) : stripAnsiSequences(String(value ?? ""));
  const controls = options.preserveAnsi ? /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g : /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
  const sanitized = text
    .replace(/\r\n?/g, "\n")
    .replace(controls, "�")
    .replace(/\t/g, " ".repeat(tabWidth))
    .replace(/\n+/g, " ↵ ");
  const truncated = truncateBytes(sanitized, maxBytes);
  return options.preserveAnsi ? appendSgrResetIfOpen(stripAnsiExceptSgr(truncated), maxBytes) : truncated;
}

export class BoundedTextAccumulator {
  private readonly chunks: string[] = [];
  private bytes = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number, private readonly suffix = "\n… truncated …") {}

  append(value: string): void {
    if (this.truncated || this.maxBytes <= 0 || value.length === 0) return;
    const remaining = this.maxBytes - this.bytes;
    if (byteLength(value) <= remaining) {
      this.chunks.push(value);
      this.bytes += byteLength(value);
      return;
    }

    const room = Math.max(0, remaining - byteLength(this.suffix));
    if (room > 0) this.chunks.push(truncateBytes(value, room, ""));
    if (remaining >= byteLength(this.suffix)) this.chunks.push(this.suffix);
    this.bytes = this.maxBytes;
    this.truncated = true;
  }

  byteLength(): number {
    return this.bytes;
  }

  wasTruncated(): boolean {
    return this.truncated;
  }

  toString(): string {
    return this.chunks.join("");
  }
}

export function visibleWidth(text: string): number {
  let width = 0;
  const clean = stripAnsi(text);
  for (let i = 0; i < clean.length; ) {
    const codePoint = clean.codePointAt(i);
    if (codePoint === undefined) break;
    width += codePointWidth(codePoint);
    i += codePoint > 0xffff ? 2 : 1;
  }
  return width;
}

export function truncateToWidth(text: string, width: number, suffix = "…"): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return appendSgrResetIfOpen(text);
  const suffixWidth = visibleWidth(suffix);
  if (width <= suffixWidth) return appendSgrResetIfOpen(takeVisible(suffix, width));
  return appendSgrResetIfOpen(takeVisible(text, width - suffixWidth) + suffix);
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
    const charWidth = codePointWidth(codePoint);
    if (used + charWidth > width) break;
    out += char;
    used += charWidth;
    i += char.length;
  }
  return out;
}

function codePointWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  if (codePoint === 0x09) return 4;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (isCombiningOrFormat(codePoint)) return 0;
  if (isWideCodePoint(codePoint)) return 2;
  return 1;
}

function isCombiningOrFormat(codePoint: number): boolean {
  return (
    codePoint === 0x200d ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
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

function stripAnsiSequences(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    if (text.charCodeAt(i) === 0x1b) {
      i = readAnsiSequenceEnd(text, i) ?? i + 1;
      continue;
    }
    const codePoint = text.codePointAt(i);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    out += char;
    i += char.length;
  }
  return out;
}

function stripAnsiExceptSgr(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    if (text.charCodeAt(i) === 0x1b) {
      const end = readAnsiSequenceEnd(text, i) ?? i + 1;
      const sequence = text.slice(i, end);
      if (isSafeSgrSequence(sequence)) out += sequence;
      i = end;
      continue;
    }
    const codePoint = text.codePointAt(i);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    out += char;
    i += char.length;
  }
  return out;
}

function appendSgrResetIfOpen(text: string, maxBytes?: number): string {
  if (!hasOpenSgr(text)) return text;
  if (maxBytes === undefined || byteLength(text + SGR_RESET) <= maxBytes) return text + SGR_RESET;

  const room = maxBytes - byteLength(SGR_RESET);
  if (room <= 0) return truncateBytes(stripAnsi(text), maxBytes, "");

  const clipped = stripAnsiExceptSgr(truncateBytes(text, room, ""));
  if (!hasOpenSgr(clipped)) return clipped;
  return clipped + SGR_RESET;
}

function hasOpenSgr(text: string): boolean {
  let active = false;
  for (let i = 0; i < text.length; ) {
    if (text.charCodeAt(i) === 0x1b) {
      const end = readAnsiSequenceEnd(text, i) ?? i + 1;
      const sequence = text.slice(i, end);
      if (isSafeSgrSequence(sequence)) active = applySgrSequence(active, sequence);
      i = end;
      continue;
    }

    const codePoint = text.codePointAt(i);
    if (codePoint === undefined) break;
    i += String.fromCodePoint(codePoint).length;
  }
  return active;
}

function applySgrSequence(active: boolean, sequence: string): boolean {
  const body = sequence.slice(2, -1);
  if (body === "") return false;

  let next = active;
  for (const token of body.split(/[;:]/)) {
    if (!token) continue;
    const code = Number(token);
    if (!Number.isInteger(code)) continue;
    if (code === 0) next = false;
    else if (!isSgrResetOnlyCode(code)) next = true;
  }
  return next;
}

function isSgrResetOnlyCode(code: number): boolean {
  return code === 22 || code === 23 || code === 24 || code === 25 || code === 27 || code === 28 || code === 29 || code === 39 || code === 49 || code === 59;
}

function isSafeSgrSequence(sequence: string): boolean {
  if (!sequence.startsWith("\u001b[") || !sequence.endsWith("m") || sequence.length > 96) return false;
  return /^[0-9;:]*$/.test(sequence.slice(2, -1));
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
