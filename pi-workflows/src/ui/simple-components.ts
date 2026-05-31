import { RENDER_LIMITS } from "../constants.js";
import { padToWidth, sanitizeText } from "../utils/truncate.js";

export interface ComponentLike {
  render(width: number): string[];
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

export class PagerComponent implements ComponentLike {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(private readonly title: string, private readonly lines: string[]) {}

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const body = this.lines.slice(0, RENDER_LIMITS.pagerLines).map((line) => padToWidth(sanitizeText(line), width));
    this.cachedLines = [
      padToWidth(`◆ ${sanitizeText(this.title, 500)}`, width),
      padToWidth("", width),
      ...body,
    ];
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }
}
