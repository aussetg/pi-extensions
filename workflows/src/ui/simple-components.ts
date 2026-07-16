import { padToWidth, sanitizeRenderedLine } from "../utils/truncate.js";

const MAX_RENDERED_LINES = 2_000;

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
    this.cachedLines = raw.slice(0, MAX_RENDERED_LINES).map((line) => padToWidth(sanitizeRenderedLine(line, 16_384, { preserveAnsi: this.options.preserveAnsi }), width));
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
