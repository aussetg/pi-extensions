import { RENDER_LIMITS } from "../constants.js";
import { padToWidth, sanitizeText } from "../utils/truncate.js";

export interface ComponentLike {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
}

export interface KeybindingsLike {
  matches?(data: string, keybinding: string): boolean;
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

export function isEscape(data: string, keybindings?: KeybindingsLike): boolean {
  return keyMatches(keybindings, data, "tui.select.cancel") || keyMatches(keybindings, data, "app.interrupt") || matchesParsedKey(data, "escape", 0) || matchesParsedKey(data, "c", CTRL);
}

export function isExit(data: string, keybindings?: KeybindingsLike): boolean {
  return keyMatches(keybindings, data, "app.exit") || matchesParsedKey(data, "d", CTRL);
}

export function isClose(data: string, keybindings?: KeybindingsLike): boolean {
  return isEscape(data, keybindings) || isExit(data, keybindings);
}

export function isEnter(data: string, keybindings?: KeybindingsLike): boolean {
  return keyMatches(keybindings, data, "tui.select.confirm") || matchesParsedKey(data, "enter", 0);
}

export function isUp(data: string, keybindings?: KeybindingsLike): boolean {
  return keyMatches(keybindings, data, "tui.select.up") || matchesParsedKey(data, "up", 0);
}

export function isDown(data: string, keybindings?: KeybindingsLike): boolean {
  return keyMatches(keybindings, data, "tui.select.down") || matchesParsedKey(data, "down", 0);
}

export function isPageUp(data: string, keybindings?: KeybindingsLike): boolean {
  return keyMatches(keybindings, data, "tui.select.pageUp") || matchesParsedKey(data, "pageUp", 0);
}

export function isPageDown(data: string, keybindings?: KeybindingsLike): boolean {
  return keyMatches(keybindings, data, "tui.select.pageDown") || matchesParsedKey(data, "pageDown", 0);
}

const CTRL = 4;
const LOCK_MASK = 64 + 128;

interface ParsedKey {
  key: string;
  modifier: number;
}

function keyMatches(keybindings: KeybindingsLike | undefined, data: string, keybinding: string): boolean {
  try {
    return Boolean(keybindings?.matches?.(data, keybinding));
  } catch {
    return false;
  }
}

function matchesParsedKey(data: string, key: string, modifier: number): boolean {
  const parsed = parseWorkflowKey(data);
  return parsed?.key === key && (parsed.modifier & ~LOCK_MASK) === modifier;
}

function parseWorkflowKey(data: string): ParsedKey | undefined {
  const named = data.toLowerCase().replace(/[_-]/g, "");
  if (named === "escape" || named === "esc") return { key: "escape", modifier: 0 };
  if (named === "enter" || named === "return") return { key: "enter", modifier: 0 };
  if (named === "up") return { key: "up", modifier: 0 };
  if (named === "down") return { key: "down", modifier: 0 };
  if (named === "pageup") return { key: "pageUp", modifier: 0 };
  if (named === "pagedown") return { key: "pageDown", modifier: 0 };
  if (named === "ctrl+c") return { key: "c", modifier: CTRL };
  if (named === "ctrl+d") return { key: "d", modifier: CTRL };

  if (data === "\u001b") return { key: "escape", modifier: 0 };
  if (data === "\u0003") return { key: "c", modifier: CTRL };
  if (data === "\u0004") return { key: "d", modifier: CTRL };
  if (data === "\r" || data === "\n" || data === "\u001bOM") return { key: "enter", modifier: 0 };
  if (data === "\u001b[A" || data === "\u001bOA") return { key: "up", modifier: 0 };
  if (data === "\u001b[B" || data === "\u001bOB") return { key: "down", modifier: 0 };
  if (data === "\u001b[5~" || data === "\u001b[[5~") return { key: "pageUp", modifier: 0 };
  if (data === "\u001b[6~" || data === "\u001b[[6~") return { key: "pageDown", modifier: 0 };

  const arrow = data.match(/^\u001b\[1;(\d+)(?::\d+)?([ABCD])$/);
  if (arrow) {
    const key = ({ A: "up", B: "down", C: "right", D: "left" } as const)[arrow[2] as "A" | "B" | "C" | "D"];
    return { key, modifier: Number.parseInt(arrow[1], 10) - 1 };
  }

  const func = data.match(/^\u001b\[(\d+)(?:;(\d+))?(?::\d+)?~$/);
  if (func) {
    const keyNum = Number.parseInt(func[1], 10);
    const key = keyNum === 5 ? "pageUp" : keyNum === 6 ? "pageDown" : undefined;
    if (key) return { key, modifier: Number.parseInt(func[2] ?? "1", 10) - 1 };
  }

  const csiU = data.match(/^\u001b\[(\d+)(?::\d*)?(?::\d+)?(?:;(\d+))?(?::\d+)?u$/);
  if (csiU) {
    const codepoint = Number.parseInt(csiU[1], 10);
    const modifier = Number.parseInt(csiU[2] ?? "1", 10) - 1;
    const key = keyFromCodepoint(codepoint);
    if (key) return { key, modifier };
  }

  const modifyOtherKeys = data.match(/^\u001b\[27;(\d+);(\d+)~$/);
  if (modifyOtherKeys) {
    const modifier = Number.parseInt(modifyOtherKeys[1], 10) - 1;
    const codepoint = Number.parseInt(modifyOtherKeys[2], 10);
    const key = keyFromCodepoint(codepoint);
    if (key) return { key, modifier };
  }

  return undefined;
}

function keyFromCodepoint(codepoint: number): string | undefined {
  if (codepoint === 27) return "escape";
  if (codepoint === 13 || codepoint === 57414) return "enter";
  if (codepoint === 99 || codepoint === 67) return "c";
  if (codepoint === 100 || codepoint === 68) return "d";
  return undefined;
}

export class PagerComponent implements ComponentLike {
  private offset = 0;
  private cachedWidth?: number;
  private cachedOffset?: number;
  private cachedLines?: string[];

  constructor(private readonly title: string, private readonly lines: string[], private readonly done: () => void, private readonly keybindings?: KeybindingsLike) {}

  handleInput(data: string): void {
    if (isClose(data, this.keybindings)) return this.done();
    if (isUp(data, this.keybindings)) this.offset = Math.max(0, this.offset - 1);
    if (isDown(data, this.keybindings)) this.offset = Math.min(Math.max(0, this.lines.length - 1), this.offset + 1);
    if (isPageUp(data, this.keybindings)) this.offset = Math.max(0, this.offset - 10);
    if (isPageDown(data, this.keybindings)) this.offset = Math.min(Math.max(0, this.lines.length - 1), this.offset + 10);
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
      padToWidth("↑↓/PgUp/PgDn scroll · Esc/Ctrl-C close", width),
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
