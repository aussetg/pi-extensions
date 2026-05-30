import { RENDER_LIMITS } from "../constants.js";
import { padToWidth, sanitizeText } from "../utils/truncate.js";

export interface ComponentLike {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
}

export class StaticTextComponent implements ComponentLike {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(private text: string | string[], private readonly options: { preserveAnsi?: boolean } = {}) {}

  setText(text: string | string[]): void {
    this.text = text;
    this.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const raw = Array.isArray(this.text) ? this.text : this.text.split("\n");
    this.cachedLines = raw.slice(0, RENDER_LIMITS.pagerLines).map((line) => padToWidth(this.options.preserveAnsi ? line : sanitizeText(line), width));
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

export function isEscape(data: string): boolean {
  return data === "\u001b" || data === "\u0003" || data === "escape" || data === "ctrl+c";
}

export function isEnter(data: string): boolean {
  return data === "\r" || data === "\n" || data === "enter";
}

export function isUp(data: string): boolean {
  return data === "\u001b[A" || data === "up";
}

export function isDown(data: string): boolean {
  return data === "\u001b[B" || data === "down";
}

export function isPageUp(data: string): boolean {
  return data === "\u001b[5~" || data === "pageup" || data === "page_up";
}

export function isPageDown(data: string): boolean {
  return data === "\u001b[6~" || data === "pagedown" || data === "page_down";
}

export class PagerComponent implements ComponentLike {
  private offset = 0;
  private cachedWidth?: number;
  private cachedOffset?: number;
  private cachedLines?: string[];

  constructor(private readonly title: string, private readonly lines: string[], private readonly done: () => void) {}

  handleInput(data: string): void {
    if (isEscape(data)) return this.done();
    if (isUp(data)) this.offset = Math.max(0, this.offset - 1);
    if (isDown(data)) this.offset = Math.min(Math.max(0, this.lines.length - 1), this.offset + 1);
    if (isPageUp(data)) this.offset = Math.max(0, this.offset - 10);
    if (isPageDown(data)) this.offset = Math.min(Math.max(0, this.lines.length - 1), this.offset + 10);
    this.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width && this.cachedOffset === this.offset) return this.cachedLines;
    const body = this.lines.slice(this.offset, this.offset + RENDER_LIMITS.pagerLines).map((line) => padToWidth(sanitizeText(line), width));
    this.cachedLines = [
      padToWidth(`◆ ${sanitizeText(this.title, 500)} · ${this.offset + 1}/${Math.max(1, this.lines.length)}`, width),
      padToWidth("", width),
      ...body,
      padToWidth("", width),
      padToWidth("↑↓/PgUp/PgDn scroll · Esc close", width),
    ];
    this.cachedWidth = width;
    this.cachedOffset = this.offset;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
    this.cachedOffset = undefined;
  }
}
