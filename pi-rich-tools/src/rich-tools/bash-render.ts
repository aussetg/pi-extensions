import path from "node:path";
import { DEFAULT_MAX_BYTES, formatSize, keyHint } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import {
  querySharedSyntaxCaptures,
  treeSitterColumnToStringIndex,
  type TreeSitterCapture,
} from "../pierre/syntax-service.ts";
import { parseShellCommand, type ParsedShellCommand } from "../shell-intent.ts";
import {
  binaryBashLineNotice,
  cleanShellPtyArtifacts,
  isBinaryLikeBashLine,
  stripBashModelExitStatusForDisplay,
  visualizeShellControlChars,
} from "./bash-model-output.ts";
import { ansiEscapePattern, stripAnsiEscapes } from "./shell-ansi.ts";
import {
  isRecord,
  isToolError,
  normalizeLineEndings,
  textContent,
  type ShellContextLike,
  type ThemeLike,
  type ToolResultLike,
} from "./util.ts";

type RenderOptions = { expanded: boolean; isPartial: boolean };
type BashCallLine = string | TreeCallLine | PlainCommandCallLine;
type TreeCallLine = {
  type: "tree";
  branch: "├─ " | "└─ ";
  continuation: "│  " | "   ";
  body: string;
  backgroundColor?: string;
};
type PlainCommandCallLine = {
  type: "plain_command";
  command: string;
  active: boolean;
  documentId?: string;
};
type SyntaxCategory =
  | "constant"
  | "comment"
  | "keyword"
  | "function"
  | "variable"
  | "string"
  | "number"
  | "type"
  | "operator"
  | "punctuation";

const BASH_PREVIEW_LINES = 5;
const BASH_INPUT_PREVIEW_LINES = 12;
const BASH_INPUT_PREVIEW_SOURCE_LINES = 12;
const BASH_INPUT_PREVIEW_CHARS = 3000;
const BASH_OUTPUT_SKIPPED_COUNT_MAX_CHARS = 256 * 1024;
const MAX_REMEMBERED_ANSI_OUTPUTS = 200;
const MAX_REMEMBERED_BASH_CALLS = 500;
const rememberedAnsiOutputByToolCallId = new Map<string, string>();

// Pure UI bookkeeping for live-session coalescing. These maps never modify the
// persisted session, tool results, or model context; they only let later bash
// rows render visually inside the first adjacent exploratory bash row.
const bashCallRecordById = new Map<string, BashCallRecord>();
const bashCallGroupById = new Map<string, BashCallGroup>();
let activeBashGroupId: string | undefined;
let bashGroupSequence = 0;
let bashCoalescingGeneration = 0;
let bashCoalescingActive = false;
let currentAssistantStartGroupId: string | undefined;

type BashCallRecord = {
  toolCallId: string;
  args: unknown;
  command: string;
  parsed: ParsedShellCommand[];
  exploratory: boolean;
  groupId?: string;
  generation: number;
  done: boolean;
  isError: boolean;
};

type BashCallGroup = {
  id: string;
  ids: string[];
  leaderId: string;
  generation: number;
  invalidate?: () => void;
};

type BashSummary = {
  command: string;
  parsed: ParsedShellCommand[];
  exploratory: boolean;
};

type ExploringAction = {
  command: ParsedShellCommand;
  isError: boolean;
};

type WrappedBashCallLine = {
  text: string;
  backgroundColor?: string;
};

type BashOutputPreview = {
  lines: string[];
  collapsed: boolean;
  skipped?: BashSkippedOutput;
};

type BashSkippedOutput = {
  lines: number;
  exact: boolean;
};

export function rememberBashAnsiOutput(toolCallId: string, output: string | undefined): void {
  rememberedAnsiOutputByToolCallId.delete(toolCallId);
  if (output === undefined) return;

  rememberedAnsiOutputByToolCallId.set(toolCallId, cleanShellPtyArtifacts(output));
  while (rememberedAnsiOutputByToolCallId.size > MAX_REMEMBERED_ANSI_OUTPUTS) {
    const oldest = rememberedAnsiOutputByToolCallId.keys().next().value;
    if (typeof oldest !== "string") break;
    rememberedAnsiOutputByToolCallId.delete(oldest);
  }
}

export function clearBashCoalescingState(): void {
  activeBashGroupId = undefined;
  currentAssistantStartGroupId = undefined;
  bashCoalescingActive = false;
  bashCoalescingGeneration = 0;
  bashCallRecordById.clear();
  bashCallGroupById.clear();
}

export function startBashCoalescingRun(): void {
  closeActiveBashGroup();
  currentAssistantStartGroupId = undefined;
  bashCoalescingActive = true;
  bashCoalescingGeneration += 1;
}

export function endBashCoalescingRun(): void {
  currentAssistantStartGroupId = undefined;
  bashCoalescingActive = false;
  closeActiveBashGroup();
}

export function beginBashCoalescingAssistantMessage(): void {
  currentAssistantStartGroupId = activeBashGroupId;
}

export function syncBashCoalescingAssistantMessage(message: unknown, finalized = false): void {
  if (!bashCoalescingActive || !isAssistantMessage(message)) return;
  const startGroupId = currentAssistantStartGroupId;
  const previousGroupId = activeBashGroupId;
  activeBashGroupId = scanAssistantBashCoalescing(
    message.content,
    startGroupId,
    bashCoalescingGeneration,
    false,
    finalized,
  );
  if (previousGroupId && previousGroupId !== activeBashGroupId) {
    bashCallGroupById.get(previousGroupId)?.invalidate?.();
  }
  if (finalized) currentAssistantStartGroupId = undefined;
}

export function restoreBashCoalescingGroupsFromMessages(messages: unknown[]): void {
  activeBashGroupId = undefined;
  currentAssistantStartGroupId = undefined;
  bashCoalescingActive = false;
  bashCoalescingGeneration += 1;

  let groupId: string | undefined;
  const finishGroup = () => {
    groupId = undefined;
  };

  for (const message of messages) {
    if (!isRecord(message)) continue;

    if (message.role === "user") {
      finishGroup();
      continue;
    }

    if (isAssistantMessage(message)) {
      groupId = scanAssistantBashCoalescing(message.content, groupId, bashCoalescingGeneration, true);
      continue;
    }

    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const record = bashCallRecordById.get(message.toolCallId);
      if (record) {
        record.done = true;
        record.isError ||= message.isError === true;
      }
    }
  }

  activeBashGroupId = undefined;
  trimBashCoalescingState();
}

export function rememberToolExecutionStart(toolName: string, toolCallId: string, args: unknown): void {
  if (toolName !== "bash") {
    closeActiveBashGroup();
    return;
  }

  const summary = summarizeBashArgs(args, toolCallId);
  if (summary.command.trim() === "") return;

  const existing = bashCallRecordById.get(toolCallId);
  if (existing?.generation === bashCoalescingGeneration) {
    existing.args = args;
    existing.command = summary.command;
    existing.parsed = summary.parsed;
    existing.exploratory = summary.exploratory;
    existing.done = false;
    if (!summary.exploratory) {
      if (existing.groupId) removeBashRecordFromGroup(existing.toolCallId, bashCallGroupById.get(existing.groupId));
      existing.groupId = undefined;
      closeActiveBashGroup();
      return;
    }
    const group = existing.groupId ? bashCallGroupById.get(existing.groupId) : undefined;
    group?.invalidate?.();
    return;
  }

  if (!summary.exploratory) {
    upsertBashCallRecord(toolCallId, args, summary, undefined, bashCoalescingGeneration);
    closeActiveBashGroup();
    return;
  }

  const group = activeBashGroupForCurrentRun();
  const targetGroup = group ?? createBashCallGroup(toolCallId, bashCoalescingGeneration);
  activeBashGroupId = targetGroup.id;

  upsertBashCallRecord(toolCallId, args, summary, targetGroup.id, bashCoalescingGeneration);
  if (!targetGroup.ids.includes(toolCallId)) targetGroup.ids.push(toolCallId);
  targetGroup.invalidate?.();
  trimBashCoalescingState();
}

export function rememberToolExecutionEnd(toolName: string, toolCallId: string, isError: boolean): void {
  if (toolName !== "bash") return;
  const record = bashCallRecordById.get(toolCallId);
  if (!record) return;
  record.done = true;
  record.isError ||= isError;
  const group = record.groupId ? bashCallGroupById.get(record.groupId) : undefined;
  group?.invalidate?.();
}

export function renderBashCall(args: unknown, theme: ThemeLike, context?: ShellContextLike): Component {
  if (shouldDelayBashCallRendering(args, context)) {
    // Once a streamed command has produced a stable exploratory summary, keep
    // that frame while the next quote, pipe, or subcommand is incomplete.
    // Replacing it with an empty component made the whole box disappear and
    // reappear repeatedly as tool-call arguments arrived token by token.
    return context?.lastComponent instanceof BashCallComponent
      ? context.lastComponent
      : EMPTY_COMPONENT;
  }

  const state = bashCallRenderState(args, context, theme);
  if (state.hidden) return EMPTY_COMPONENT;

  const component = context?.lastComponent instanceof BashCallComponent
    ? context.lastComponent
    : new BashCallComponent();
  component.update(state.lines, theme, state.context);
  return component;
}

export function renderBashResult(
  result: ToolResultLike,
  options: RenderOptions,
  theme: ThemeLike,
  context?: ShellContextLike,
): Component {
  if (shouldSuppressExplorationOutput(context)) return EMPTY_COMPONENT;

  const component = context?.lastComponent instanceof BashResultComponent
    ? context.lastComponent
    : new BashResultComponent();
  component.update(result, options, theme, context);
  return component;
}

class BashResultComponent implements Component {
  private result: ToolResultLike = {};
  private options: RenderOptions = { expanded: false, isPartial: false };
  private theme: ThemeLike | undefined;
  private context: ShellContextLike | undefined;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  update(result: ToolResultLike, options: RenderOptions, theme: ThemeLike, context?: ShellContextLike): void {
    this.result = result;
    this.options = options;
    this.theme = theme;
    this.context = context;
    this.clearRenderCache();
  }

  render(width: number): string[] {
    if (!this.theme) return [];
    const safeWidth = Math.max(1, Math.trunc(width));
    if (this.cachedLines && this.cachedWidth === safeWidth) return this.cachedLines;

    const rawOutput = stripBashModelExitStatusForDisplay(
      normalizeLineEndings(rememberedBashAnsiOutput(this.context) ?? textContent(this.result) ?? ""),
    );
    const output = stripPiBashTruncationFooterForDisplay(rawOutput, this.result.details).trim();
    const warning = bashTruncationNotice(this.result.details, this.theme);
    if (!output && !warning) return this.rememberRender(safeWidth, []);

    const contentWidth = Math.max(1, safeWidth - 2);
    const color = isToolError(this.result, this.context) ? "error" : "toolOutput";
    const bodyLines = output
      ? bashOutputPreviewLines(output, this.options.expanded, contentWidth, color, this.theme, this.context)
      : [];

    if (warning) {
      if (bodyLines.length > 0) bodyLines.push("");
      bodyLines.push(warning);
    }

    if (bodyLines.length === 0) return this.rememberRender(safeWidth, []);

    const background = toolBackground(this.theme, this.context);
    return this.rememberRender(safeWidth, [
      ...new Text(bodyLines.join("\n"), 1, 0, background).render(safeWidth),
      backgroundBlankLine(safeWidth, background),
    ]);
  }

  invalidate(): void {
    this.clearRenderCache();
  }

  private rememberRender(width: number, lines: string[]): string[] {
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private clearRenderCache(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

class BashCallComponent implements Component {
  private lines: BashCallLine[] = [];
  private theme: ThemeLike | undefined;
  private context: ShellContextLike | undefined;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  update(lines: BashCallLine[], theme: ThemeLike, context?: ShellContextLike): void {
    this.lines = lines;
    this.theme = theme;
    this.context = context;
    this.clearRenderCache();
  }

  render(width: number): string[] {
    if (!this.theme) return [];
    const safeWidth = Math.max(1, Math.trunc(width));
    if (this.cachedLines && this.cachedWidth === safeWidth) return this.cachedLines;

    const contentWidth = Math.max(1, safeWidth - 2);
    const background = toolBackground(this.theme, this.context);
    const lines = wrapBashCallLines(this.lines, contentWidth, this.theme, this.context);
    if (!lines.some((line) => line.backgroundColor)) {
      return this.rememberRender(
        safeWidth,
        new Text(lines.map((line) => line.text).join("\n"), 1, 1, background).render(safeWidth),
      );
    }
    return this.rememberRender(
      safeWidth,
      renderPaddedBashCallLines(lines, safeWidth, background, this.theme),
    );
  }

  invalidate(): void {
    this.clearRenderCache();
  }

  private rememberRender(width: number, lines: string[]): string[] {
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private clearRenderCache(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

function bashCallRenderState(
  args: unknown,
  context: ShellContextLike | undefined,
  theme: ThemeLike,
): { hidden: boolean; lines: BashCallLine[]; context?: ShellContextLike } {
  const record = updateBashCallRecordFromRender(args, context);
  const group = record?.groupId ? bashCallGroupById.get(record.groupId) : undefined;

  if (record && group) {
    if (group.leaderId !== record.toolCallId) return { hidden: true, lines: [] };

    group.invalidate = context?.invalidate;
    const records = group.ids
      .map((id) => bashCallRecordById.get(id))
      .filter((item): item is BashCallRecord => item !== undefined);
    const actions = records.flatMap((item) => exploringActions(item.parsed, item.isError));
    // Keep one visual state for the lifetime of an open coalesced group. If we
    // briefly settle between adjacent calls, the background flips success →
    // pending when the next row arrives and the whole box visibly flashes.
    const active = records.some((item) => !item.done)
      || context?.isPartial === true
      || (bashCoalescingActive && activeBashGroupId === group.id);
    const allFailed = records.length > 0 && records.every((item) => item.done && item.isError);
    return {
      hidden: false,
      lines: renderExploringCallLines(actions, active, theme, context),
      context: { ...context, isPartial: active, isError: allFailed },
    };
  }

  const summary = record ?? summarizeBashArgs(args, context?.toolCallId);
  const active = context?.isPartial === true;
  const exploratoryError = record?.isError === true || context?.isError === true;
  const lines = summary.exploratory
    ? renderExploringCallLines(exploringActions(summary.parsed, exploratoryError), active, theme, context)
    : renderPlainCommandCallLines(summary.command, active, context?.toolCallId);
  return {
    hidden: false,
    lines,
    context: summary.exploratory ? { ...context, isError: exploratoryError } : context,
  };
}

function bashOutputPreviewLines(
  output: string,
  expanded: boolean,
  width: number,
  color: "error" | "toolOutput",
  theme: ThemeLike,
  context?: ShellContextLike,
): string[] {
  const bgColor = toolBackgroundColor(context);

  if (expanded) {
    return output
      .split("\n")
      .flatMap((line) => wrapStyledLine(styleShellOutputLine(line, color, bgColor, theme), width));
  }

  const preview = collapsedBashOutputPreviewLines(output, width, color, bgColor, theme);
  if (!preview.collapsed) return preview.lines;

  const hint = bashOutputCollapseHint(preview.skipped, width, theme);
  return [hint, ...preview.lines];
}

function collapsedBashOutputPreviewLines(
  output: string,
  width: number,
  color: "error" | "toolOutput",
  bgColor: string,
  theme: ThemeLike,
): BashOutputPreview {
  const tailLines: string[] = [];
  let skippedWrappedLines = 0;
  let earliestRenderedStart = output.length;
  let end = output.length;
  let reachedStart = false;

  while (tailLines.length <= BASH_PREVIEW_LINES) {
    const newline = output.lastIndexOf("\n", end - 1);
    const start = newline < 0 ? 0 : newline + 1;
    const wantedLines = Math.max(1, BASH_PREVIEW_LINES + 1 - tailLines.length);
    const rendered = tailWrappedShellOutputLine(output, start, end, width, wantedLines, color, bgColor, theme);

    skippedWrappedLines += rendered.skippedLines;
    tailLines.unshift(...rendered.lines);
    earliestRenderedStart = start;
    if (newline < 0) reachedStart = true;

    if (rendered.skippedLines > 0 || tailLines.length > BASH_PREVIEW_LINES) break;
    if (reachedStart) break;

    end = newline;
  }

  if (reachedStart && skippedWrappedLines === 0 && tailLines.length <= BASH_PREVIEW_LINES) {
    return { lines: tailLines, collapsed: false };
  }

  const overRenderedLines = Math.max(0, tailLines.length - BASH_PREVIEW_LINES);
  const skipped = skippedBashOutputSummary(
    output,
    earliestRenderedStart,
    reachedStart,
    skippedWrappedLines + overRenderedLines,
  );

  return {
    lines: tailLines.slice(-BASH_PREVIEW_LINES),
    collapsed: true,
    skipped,
  };
}

function tailWrappedShellOutputLine(
  output: string,
  start: number,
  end: number,
  width: number,
  wantedLines: number,
  color: "error" | "toolOutput",
  bgColor: string,
  theme: ThemeLike,
): { lines: string[]; skippedLines: number } {
  const renderLine = (text: string) => wrapStyledLine(styleShellOutputLine(text, color, bgColor, theme), width);
  const wrapped = renderLine(output.slice(start, end));
  const lines = wrapped.slice(-wantedLines);
  const skippedLines = Math.max(0, wrapped.length - lines.length);
  return { lines, skippedLines };
}

function skippedBashOutputSummary(
  output: string,
  earliestRenderedStart: number,
  reachedStart: boolean,
  exactRenderedSkippedLines: number,
): BashSkippedOutput | undefined {
  if (reachedStart) return { lines: Math.max(1, exactRenderedSkippedLines), exact: true };

  const skippedSourceLines = skippedSourceLinesBefore(output, earliestRenderedStart);
  if (skippedSourceLines === undefined) return undefined;
  return {
    lines: Math.max(1, skippedSourceLines + exactRenderedSkippedLines),
    exact: false,
  };
}

function skippedSourceLinesBefore(text: string, endExclusive: number): number | undefined {
  if (endExclusive <= 0) return 0;
  if (endExclusive > BASH_OUTPUT_SKIPPED_COUNT_MAX_CHARS) return undefined;

  let count = 0;
  for (let index = 0; index < endExclusive; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

function bashOutputCollapseHint(skipped: BashSkippedOutput | undefined, width: number, theme: ThemeLike): string {
  const summary = skipped === undefined
    ? "earlier output"
    : `${skipped.exact ? "" : "at least "}${skipped.lines} earlier ${skipped.lines === 1 ? "line" : "lines"}`;
  const hint = theme.fg("muted", `... (${summary},`) + ` ${keyHint("app.tools.expand", "to expand")})`;
  return truncateToWidth(hint, width, "...");
}

function wrapStyledLine(line: string, width: number): string[] {
  const wrapped = wrapTextWithAnsi(line, width).filter((item) => item.length > 0);
  return wrapped.length > 0 ? wrapped : [""];
}

function wrapBashCallLines(lines: BashCallLine[], width: number, theme: ThemeLike, context?: ShellContextLike): WrappedBashCallLine[] {
  return lines.flatMap((line) => {
    if (typeof line === "string") return wrapStyledLine(line, width).map((text) => ({ text }));
    if (line.type === "plain_command") return wrapPlainCommandCallLine(line, width, theme, context);
    return wrapTreeCallLine(line, width, theme);
  });
}

function renderPaddedBashCallLines(
  lines: WrappedBashCallLine[],
  width: number,
  baseBackground: ((text: string) => string) | undefined,
  theme: ThemeLike,
): string[] {
  const rows = [paintBackground(" ".repeat(width), width, baseBackground)];
  for (const line of lines) {
    const background = line.backgroundColor && theme.bg
      ? (text: string) => theme.bg!(line.backgroundColor!, text)
      : baseBackground;
    rows.push(paintBackground(` ${line.text}`, width, background));
  }
  rows.push(paintBackground(" ".repeat(width), width, baseBackground));
  return rows;
}

function paintBackground(
  text: string,
  width: number,
  background: ((text: string) => string) | undefined,
): string {
  if (!background) return text;
  const pad = Math.max(0, width - safeVisibleWidth(text));
  return background(`${text}${" ".repeat(pad)}`);
}

function safeVisibleWidth(text: string): number {
  try {
    return visibleWidth(text);
  } catch {
    return stripAnsiEscapes(text).length;
  }
}

function wrapPlainCommandCallLine(
  line: PlainCommandCallLine,
  width: number,
  theme: ThemeLike,
  context?: ShellContextLike,
): WrappedBashCallLine[] {
  const status = line.active ? "Running" : "Ran";
  const prefix = `${theme.fg("muted", "•")} ${theme.fg("toolTitle", theme.bold(status))} `;
  const preview = shellInputPreview(line.command, context?.expanded === true);
  const highlightedLines = highlightBashCommand(preview.text, theme, line.documentId).split("\n");
  const visualLines = highlightedLines.flatMap((commandLine, index) =>
    wrapStyledLine(index === 0 ? `${prefix}${commandLine}` : commandLine, width)
  );
  const wrapLines = (items: string[]): WrappedBashCallLine[] => items.map((text) => ({ text }));

  if (context?.expanded === true && !preview.collapsed) return wrapLines(visualLines);

  let visibleLines = visualLines;
  let skippedVisualLines = 0;
  if (visibleLines.length > BASH_INPUT_PREVIEW_LINES) {
    skippedVisualLines = visibleLines.length - BASH_INPUT_PREVIEW_LINES;
    visibleLines = visibleLines.slice(0, BASH_INPUT_PREVIEW_LINES);
  }

  if (!preview.collapsed && skippedVisualLines === 0) return wrapLines(visibleLines);
  return wrapLines([...visibleLines, truncateToWidth(inputCollapseHint(preview, skippedVisualLines, theme), width, "...")]);
}

function shellInputPreview(command: string, expanded: boolean): { text: string; collapsed: boolean; omittedLines: number; omittedChars: number } {
  if (expanded) return { text: command, collapsed: false, omittedLines: 0, omittedChars: 0 };

  const sourceLines = command.split("\n");
  const keptLines = sourceLines.slice(0, BASH_INPUT_PREVIEW_SOURCE_LINES);
  let text = keptLines.join("\n");
  const omittedLines = Math.max(0, sourceLines.length - keptLines.length);
  let omittedChars = Math.max(0, command.length - text.length);

  if (text.length > BASH_INPUT_PREVIEW_CHARS) {
    omittedChars += text.length - BASH_INPUT_PREVIEW_CHARS;
    text = text.slice(0, BASH_INPUT_PREVIEW_CHARS);
  }

  return { text, collapsed: omittedLines > 0 || omittedChars > 0, omittedLines, omittedChars };
}

function inputCollapseHint(
  preview: { collapsed: boolean; omittedLines: number; omittedChars: number },
  skippedVisualLines: number,
  theme: ThemeLike,
): string {
  const details: string[] = [];
  if (preview.omittedLines > 0) details.push(`${preview.omittedLines} more input ${preview.omittedLines === 1 ? "line" : "lines"}`);
  else if (skippedVisualLines > 0) details.push(`${skippedVisualLines} more wrapped input ${skippedVisualLines === 1 ? "line" : "lines"}`);
  if (preview.omittedChars > 0 && preview.omittedLines === 0) details.push(`${formatSize(preview.omittedChars)} more input`);

  const summary = details.length > 0 ? details.join(", ") : "input collapsed";
  return theme.fg("muted", `... (${summary},`) + ` ${keyHint("app.tools.expand", "to expand")})`;
}

function wrapTreeCallLine(line: TreeCallLine, width: number, theme: ThemeLike): WrappedBashCallLine[] {
  const prefixWidth = 3;
  const decorate = (text: string): WrappedBashCallLine => ({ text, backgroundColor: line.backgroundColor });
  if (width <= prefixWidth) return [decorate(`${theme.fg("dim", line.branch)}${line.body}`)];

  const bodyLines = wrapStyledLine(line.body, width - prefixWidth);
  const [first, ...rest] = bodyLines;
  return [
    decorate(`${theme.fg("dim", line.branch)}${first ?? ""}`),
    ...rest.map((item) => decorate(`${theme.fg("dim", line.continuation)}${item}`)),
  ];
}

function styleShellOutputLine(
  line: string,
  color: "error" | "toolOutput",
  bgColor: string,
  theme: ThemeLike,
): string {
  const sgrOnlyLine = stripNonSgrAnsi(line);
  const plainLine = stripAnsiEscapes(sgrOnlyLine);
  if (isBinaryLikeBashLine(plainLine)) {
    return theme.fg("warning", binaryBashLineNotice(plainLine));
  }

  const safeLine = visualizeShellControlCharsPreservingSgr(sgrOnlyLine);
  if (!hasAnsiSgr(safeLine)) return theme.fg(color, safeLine);
  return theme.fg(color, rewriteAnsiResetsForToolShell(safeLine, color, bgColor, theme));
}

function hasAnsiSgr(text: string): boolean {
  return /\x1b\[[0-9;]*m/.test(text);
}

function stripNonSgrAnsi(text: string): string {
  return text.replace(ansiEscapePattern(), (sequence) => isSgrAnsi(sequence) ? sequence : "");
}

function isSgrAnsi(sequence: string): boolean {
  return /^\x1b\[[0-9;]*m$/.test(sequence);
}

function visualizeShellControlCharsPreservingSgr(text: string): string {
  let out = "";
  let offset = 0;
  for (const match of text.matchAll(/\x1b\[[0-9;]*m/g)) {
    const index = match.index ?? offset;
    out += visualizeShellControlChars(text.slice(offset, index));
    out += match[0];
    offset = index + match[0].length;
  }
  out += visualizeShellControlChars(text.slice(offset));
  return out;
}

function rememberedBashAnsiOutput(context?: ShellContextLike): string | undefined {
  return context?.toolCallId ? rememberedAnsiOutputByToolCallId.get(context.toolCallId) : undefined;
}

function scanAssistantBashCoalescing(
  content: unknown[],
  startGroupId: string | undefined,
  generation: number,
  markDone = false,
  argsComplete = markDone,
): string | undefined {
  let group = groupForGeneration(startGroupId, generation);

  for (const item of content) {
    if (!isRecord(item)) continue;

    if (isVisibleAssistantContent(item)) {
      group = undefined;
      continue;
    }

    if (item.type !== "toolCall") continue;
    if (item.name !== "bash" || typeof item.id !== "string") {
      group = undefined;
      continue;
    }

    const summary = summarizeBashArgs(item.arguments, item.id);
    if (!argsComplete && shouldDelayBashCallRendering(item.arguments, {
      isPartial: true,
      argsComplete: false,
      executionStarted: false,
      toolCallId: item.id,
    })) {
      // A streamed command such as `c` may still become `cat`. Do not close
      // the preceding group until enough arguments exist to classify it;
      // success → pending transitions here make the growing box flash.
      continue;
    }
    if (summary.command.trim() === "" || !summary.exploratory) {
      upsertBashCallRecord(item.id, item.arguments, summary, undefined, generation, markDone, false);
      group = undefined;
      continue;
    }

    group ??= createBashCallGroup(item.id, generation);
    const record = upsertBashCallRecord(item.id, item.arguments, summary, group.id, generation, markDone, false);
    moveBashRecordToGroup(record, group);
  }

  return group?.id;
}

function isAssistantMessage(message: unknown): message is { role: "assistant"; content: unknown[] } {
  return isRecord(message) && message.role === "assistant" && Array.isArray(message.content);
}

function isVisibleAssistantContent(item: Record<string, unknown>): boolean {
  if (item.type === "text") return typeof item.text === "string" && item.text.trim().length > 0;
  if (item.type === "thinking") return typeof item.thinking === "string" && item.thinking.trim().length > 0;
  return false;
}

function groupForGeneration(groupId: string | undefined, generation: number): BashCallGroup | undefined {
  if (!groupId) return undefined;
  const group = bashCallGroupById.get(groupId);
  return group?.generation === generation ? group : undefined;
}

function closeActiveBashGroup(): void {
  const groupId = activeBashGroupId;
  activeBashGroupId = undefined;
  if (groupId) bashCallGroupById.get(groupId)?.invalidate?.();
}

function summarizeBashArgs(args: unknown, toolCallId?: string): BashSummary {
  const command = bashCommandArg(args);
  const parsed = parsedBashCommand(command, toolCallId);
  return { command, parsed, exploratory: isExploring(parsed) };
}

function parsedBashCommand(command: string, toolCallId?: string): ParsedShellCommand[] {
  const record = toolCallId ? bashCallRecordById.get(toolCallId) : undefined;
  if (record?.command === command) return record.parsed;
  return parseShellCommand(command);
}

function createBashCallGroup(leaderId: string, generation: number): BashCallGroup {
  const group: BashCallGroup = {
    id: `bash-group-${++bashGroupSequence}`,
    ids: [],
    leaderId,
    generation,
  };
  bashCallGroupById.set(group.id, group);
  return group;
}

function upsertBashCallRecord(
  toolCallId: string,
  args: unknown,
  summary: BashSummary,
  groupId: string | undefined,
  generation: number,
  done?: boolean,
  isError?: boolean,
): BashCallRecord {
  const previous = bashCallRecordById.get(toolCallId);
  const record: BashCallRecord = {
    toolCallId,
    args,
    command: summary.command,
    parsed: summary.parsed,
    exploratory: summary.exploratory,
    groupId,
    generation,
    done: done ?? previous?.done ?? false,
    isError: isError ?? previous?.isError ?? false,
  };
  bashCallRecordById.set(toolCallId, record);
  return record;
}

function updateBashCallRecordFromRender(args: unknown, context?: ShellContextLike): BashCallRecord | undefined {
  if (!context?.toolCallId) return undefined;
  const summary = summarizeBashArgs(args, context.toolCallId);
  let record = bashCallRecordById.get(context.toolCallId);
  const hadRecord = record !== undefined;
  if (!record) {
    const group = summary.exploratory && bashCoalescingActive
      ? (activeBashGroupForCurrentRun() ?? createBashCallGroup(context.toolCallId, bashCoalescingGeneration))
      : undefined;
    record = upsertBashCallRecord(
      context.toolCallId,
      args,
      summary,
      group?.id,
      bashCoalescingGeneration,
    );
    if (group) {
      activeBashGroupId = group.id;
      if (!group.ids.includes(record.toolCallId)) group.ids.push(record.toolCallId);
    }
  }

  record.args = args;
  record.command = summary.command;
  record.parsed = summary.parsed;
  record.exploratory = summary.exploratory;
  if (context.isPartial === false) record.done = true;
  if (context.isError === true) record.isError = true;

  if (!hadRecord && summary.exploratory && bashCoalescingActive && record.generation === bashCoalescingGeneration) {
    coalesceRenderedBashRecord(record);
  } else if (!summary.exploratory) {
    if (record.groupId) removeBashRecordFromGroup(record.toolCallId, bashCallGroupById.get(record.groupId));
    record.groupId = undefined;
    closeActiveBashGroup();
  }

  const group = record.groupId ? bashCallGroupById.get(record.groupId) : undefined;
  if (group?.leaderId === record.toolCallId) group.invalidate = context.invalidate;
  return record;
}

function coalesceRenderedBashRecord(record: BashCallRecord): void {
  const activeGroup = activeBashGroupForCurrentRun();
  const currentGroup = record.groupId ? bashCallGroupById.get(record.groupId) : undefined;

  if (!currentGroup) {
    const group = activeGroup ?? createBashCallGroup(record.toolCallId, record.generation);
    moveBashRecordToGroup(record, group);
    activeBashGroupId = group.id;
    return;
  }

  if (activeGroup && activeGroup.id !== currentGroup.id) {
    mergeBashCallGroups(currentGroup, activeGroup);
    activeBashGroupId = activeGroup.id;
    return;
  }

  activeBashGroupId = currentGroup.id;
}

function activeBashGroupForCurrentRun(): BashCallGroup | undefined {
  if (!activeBashGroupId) return undefined;
  const group = bashCallGroupById.get(activeBashGroupId);
  return group?.generation === bashCoalescingGeneration ? group : undefined;
}

function moveBashRecordToGroup(record: BashCallRecord, group: BashCallGroup): void {
  const oldGroup = record.groupId ? bashCallGroupById.get(record.groupId) : undefined;
  if (oldGroup?.id === group.id) {
    if (!group.ids.includes(record.toolCallId)) group.ids.push(record.toolCallId);
    return;
  }

  if (oldGroup) removeBashRecordFromGroup(record.toolCallId, oldGroup);
  record.groupId = group.id;
  record.generation = group.generation;
  if (!group.ids.includes(record.toolCallId)) group.ids.push(record.toolCallId);
  group.invalidate?.();
}

function mergeBashCallGroups(source: BashCallGroup, target: BashCallGroup): void {
  if (source.id === target.id) return;
  for (const id of source.ids) {
    const record = bashCallRecordById.get(id);
    if (!record) continue;
    record.groupId = target.id;
    record.generation = target.generation;
    if (!target.ids.includes(id)) target.ids.push(id);
  }
  bashCallGroupById.delete(source.id);
  if (activeBashGroupId === source.id) activeBashGroupId = target.id;
  source.invalidate?.();
  target.invalidate?.();
}

function removeBashRecordFromGroup(toolCallId: string, group: BashCallGroup | undefined): void {
  if (!group) return;
  group.ids = group.ids.filter((id) => id !== toolCallId);
  if (group.ids.length === 0) {
    bashCallGroupById.delete(group.id);
    if (activeBashGroupId === group.id) activeBashGroupId = undefined;
  } else if (group.leaderId === toolCallId) {
    group.leaderId = group.ids[0]!;
  }
  group.invalidate?.();
}

function trimBashCoalescingState(): void {
  while (bashCallRecordById.size > MAX_REMEMBERED_BASH_CALLS) {
    const oldest = bashCallRecordById.keys().next().value;
    if (typeof oldest !== "string") return;
    forgetBashCallRecord(oldest);
  }
}

function forgetBashCallRecord(toolCallId: string): void {
  const record = bashCallRecordById.get(toolCallId);
  if (!record) return;
  bashCallRecordById.delete(toolCallId);

  if (!record.groupId) return;
  const group = bashCallGroupById.get(record.groupId);
  if (!group) return;
  removeBashRecordFromGroup(toolCallId, group);
}

function rewriteAnsiResetsForToolShell(
  text: string,
  fgColor: string,
  bgColor: string,
  theme: ThemeLike,
): string {
  const baseFg = theme.getFgAnsi?.(fgColor) ?? "";
  const baseBg = theme.getBgAnsi?.(bgColor) ?? "";
  return text.replace(/\x1b\[([0-9;]*)m/g, (_match, rawParams: string) => {
    const params = rawParams === "" ? ["0"] : String(rawParams).split(";");
    let out = "";
    let pending: string[] = [];
    const flush = () => {
      if (pending.length === 0) return;
      out += `\x1b[${pending.join(";")}m`;
      pending = [];
    };

    for (const param of params) {
      const value = Number.parseInt(param || "0", 10);
      if (value === 0) {
        flush();
        out += "\x1b[22m\x1b[23m\x1b[24m\x1b[27m\x1b[29m" + baseFg + baseBg;
      } else if (value === 39) {
        flush();
        out += baseFg || "\x1b[39m";
      } else if (value === 49) {
        flush();
        out += baseBg || "\x1b[49m";
      } else {
        pending.push(param);
      }
    }

    flush();
    return out;
  });
}

function renderExploringCallLines(
  actions: ExploringAction[],
  active: boolean,
  theme: ThemeLike,
  context?: ShellContextLike,
): BashCallLine[] {
  const lines: BashCallLine[] = [bulletLine(active ? "Exploring" : "Explored", theme)];
  const actionLines = renderExploringActionLines(actions, theme, context);
  for (let i = 0; i < actionLines.length; i += 1) {
    const last = i === actionLines.length - 1;
    const action = actionLines[i]!;
    lines.push({
      type: "tree",
      branch: last ? "└─ " : "├─ ",
      continuation: last ? "   " : "│  ",
      body: action.body,
      backgroundColor: action.isError ? "toolErrorBg" : undefined,
    });
  }
  return lines;
}

function renderPlainCommandCallLines(command: string, active: boolean, documentId?: string): BashCallLine[] {
  return [{ type: "plain_command", command, active, documentId }];
}

function bulletLine(label: string, theme: ThemeLike): string {
  return `${theme.fg("muted", "•")} ${theme.fg("toolTitle", theme.bold(label))}`;
}

function exploringActions(parsed: ParsedShellCommand[], isError: boolean): ExploringAction[] {
  return parsed.map((command) => ({ command, isError }));
}

function renderExploringActionLines(actions: ExploringAction[], theme: ThemeLike, context?: ShellContextLike): Array<{ body: string; isError: boolean }> {
  return actions.map((action) => {
    const item = action.command;
    switch (item.type) {
      case "read":
        return { body: `${theme.fg("accent", "Read")} ${displayShellPath(item.path, context)}`, isError: action.isError };
      case "list_files":
        return { body: `${theme.fg("accent", "List")} ${displayShellPath(item.path ?? ".", context)}`, isError: action.isError };
      case "search":
        return { body: `${theme.fg("accent", "Search")} ${searchDisplay(item, theme, context)}`, isError: action.isError };
      case "unknown":
        return { body: `${theme.fg("accent", "Run")} ${item.cmd}`, isError: action.isError };
    }
  });
}

function searchDisplay(item: Extract<ParsedShellCommand, { type: "search" }>, theme: ThemeLike, context?: ShellContextLike): string {
  if (item.query && item.path) return `${item.query}${theme.fg("dim", " in ")}${displayShellPath(item.path, context)}`;
  if (item.query) return item.query;
  return item.cmd;
}

function displayShellPath(itemPath: string, context?: ShellContextLike): string {
  const cwd = path.resolve(context?.cwd ?? process.cwd());
  const home = homePath();
  const absolute = resolveShellPath(itemPath, cwd, home);

  const cwdRelative = relativePathIfInside(cwd, absolute);
  if (cwdRelative !== undefined) return cwdRelative;

  if (home) {
    const homeRelative = relativePathIfInside(home, absolute);
    if (homeRelative !== undefined) return homeRelative === "." ? "~" : `~/${homeRelative}`;
  }

  return absolute;
}

function resolveShellPath(itemPath: string, cwd: string, home: string | undefined): string {
  if (itemPath === "~" && home) return home;
  if (itemPath.startsWith("~/") && home) return path.resolve(home, itemPath.slice(2));
  if (path.isAbsolute(itemPath)) return path.resolve(itemPath);
  return path.resolve(cwd, itemPath);
}

function relativePathIfInside(root: string, absolutePath: string): string | undefined {
  const relative = path.relative(path.resolve(root), path.resolve(absolutePath));
  if (relative === "") return ".";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative;
}

function homePath(): string | undefined {
  const home = process.env.HOME;
  return home ? path.resolve(home) : undefined;
}

function isExploring(parsed: ParsedShellCommand[]): boolean {
  return parsed.length > 0 && parsed.every((item) => item.type !== "unknown");
}

function shouldSuppressExplorationOutput(context?: ShellContextLike): boolean {
  const parsed = parsedBashCommand(bashCommandArg(context?.args), context?.toolCallId);
  return isExploring(parsed);
}

function shouldDelayBashCallRendering(args: unknown, context?: ShellContextLike): boolean {
  if (context?.isPartial !== true || context.argsComplete === true || context.executionStarted === true) return false;

  const command = bashCommandArg(args).trim();
  if (!command) return true;

  const parsed = parsedBashCommand(command, context.toolCallId);
  if (isExploring(parsed)) return false;

  return couldStillBecomeExploratory(command);
}

const EXPLORATORY_COMMAND_NAMES = [
  "ack",
  "ag",
  "awk",
  "bat",
  "batcat",
  "cat",
  "du",
  "exa",
  "eza",
  "fd",
  "fgrep",
  "find",
  "grep",
  "head",
  "less",
  "ls",
  "more",
  "nl",
  "pt",
  "rg",
  "rga",
  "ripgrep-all",
  "sed",
  "tail",
  "tree",
];

function couldStillBecomeExploratory(command: string): boolean {
  const words = leadingCommandWords(command);
  const head = words[0];
  if (!head) return true;

  if (head === "cd") return true;
  if (head === "git") {
    const subcommand = words[1];
    return !subcommand || "grep".startsWith(subcommand) || "ls-files".startsWith(subcommand);
  }
  if ("git".startsWith(head)) return true;

  return EXPLORATORY_COMMAND_NAMES.some((name) => name.startsWith(head));
}

function leadingCommandWords(command: string): string[] {
  const words: string[] = command.match(/(?:[^\s'"\\]+|"(?:[^"\\]|\\.)*"|'[^']*')+/g) ?? [];
  while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  return words.map((word) => word.replace(/^['"]|['"]$/g, ""));
}

function bashCommandArg(args: unknown): string {
  if (!isRecord(args)) return "";
  const command = args.command;
  return typeof command === "string" ? command : "";
}

function highlightBashCommand(command: string, theme: ThemeLike, documentId?: string): string {
  if (!command) return theme.fg("toolOutput", "...");

  const lines = command.split("\n");
  const styles = lines.map((line) => new Array<SyntaxCategory | undefined>(line.length));
  const captures = querySharedSyntaxCaptures({
    documentId: documentId ? `bash-call:${documentId}` : undefined,
    languageKey: "bash",
    text: command,
  });
  for (const capture of sortedSyntaxCaptures(captures ?? [])) {
    const category = syntaxCategoryForCapture(capture.name);
    if (!category) continue;
    paintSyntaxCapture(lines, styles, capture, category, true);
  }

  paintBashTokenFallbackStyles(lines, styles);

  return lines.map((line, index) => styleSyntaxLine(line, styles[index] ?? [], theme)).join("\n");
}

function sortedSyntaxCaptures(captures: TreeSitterCapture[]): TreeSitterCapture[] {
  return [...captures].sort((left, right) => {
    const leftCategory = syntaxCategoryForCapture(left.name);
    const rightCategory = syntaxCategoryForCapture(right.name);
    return syntaxCategoryPriority(leftCategory) - syntaxCategoryPriority(rightCategory);
  });
}

function paintSyntaxCapture(
  lines: string[],
  styles: Array<Array<SyntaxCategory | undefined>>,
  capture: TreeSitterCapture,
  category: SyntaxCategory,
  overwrite: boolean,
): void {
  const startRow = capture.node.startPosition.row;
  const endRow = capture.node.endPosition.row;
  for (let row = startRow; row <= endRow; row += 1) {
    const line = lines[row];
    const lineStyles = styles[row];
    if (line === undefined || !lineStyles) continue;

    const start = row === startRow ? treeSitterColumnToStringIndex(line, capture.node.startPosition.column) : 0;
    const end = row === endRow ? treeSitterColumnToStringIndex(line, capture.node.endPosition.column) : line.length;
    for (let offset = start; offset < end && offset < lineStyles.length; offset += 1) {
      if (overwrite || lineStyles[offset] === undefined) lineStyles[offset] = category;
    }
  }
}

function paintBashTokenFallbackStyles(
  lines: string[],
  styles: Array<Array<SyntaxCategory | undefined>>,
): void {
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row] ?? "";
    const lineStyles = styles[row];
    if (!lineStyles) continue;

    let expectingCommand = true;
    for (const token of bashFallbackTokens(line)) {
      if (token.kind === "comment") {
        paintStringRange(lineStyles, token.start, token.end, "comment");
        break;
      }

      if (token.kind === "operator") {
        paintStringRange(lineStyles, token.start, token.end, "operator");
        if (isCommandSeparator(token.text)) expectingCommand = true;
        continue;
      }

      if (token.kind === "string") {
        paintStringRange(lineStyles, token.start, token.end, "string");
        expectingCommand = false;
        continue;
      }

      const text = token.text;
      if (expectingCommand && /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) {
        paintStringRange(lineStyles, token.start, token.end, "variable");
        continue;
      }

      if (expectingCommand) {
        paintStringRange(lineStyles, token.start, token.end, "function");
        expectingCommand = false;
        continue;
      }

      if (text.startsWith("$")) paintStringRange(lineStyles, token.start, token.end, "variable");
      else if (/^-{1,2}\w/.test(text)) paintStringRange(lineStyles, token.start, token.end, "constant");
      else if (/^\d+$/.test(text)) paintStringRange(lineStyles, token.start, token.end, "number");
    }
  }
}

type BashFallbackToken = {
  kind: "word" | "string" | "operator" | "comment";
  text: string;
  start: number;
  end: number;
};

function bashFallbackTokens(line: string): BashFallbackToken[] {
  const tokens: BashFallbackToken[] = [];
  let offset = 0;

  while (offset < line.length) {
    const char = line[offset]!;
    if (/\s/.test(char)) {
      offset += 1;
      continue;
    }

    if (char === "#" && (offset === 0 || /\s/.test(line[offset - 1]!))) {
      tokens.push({ kind: "comment", text: line.slice(offset), start: offset, end: line.length });
      break;
    }

    if (char === "'" || char === '"') {
      const start = offset;
      offset = quotedTokenEnd(line, start, char);
      tokens.push({ kind: "string", text: line.slice(start, offset), start, end: offset });
      continue;
    }

    const operator = bashOperatorAt(line, offset);
    if (operator) {
      tokens.push({ kind: "operator", text: operator, start: offset, end: offset + operator.length });
      offset += operator.length;
      continue;
    }

    const start = offset;
    while (offset < line.length) {
      const next = line[offset]!;
      if (/\s/.test(next) || next === "'" || next === '"' || bashOperatorAt(line, offset)) break;
      if (next === "#" && (offset === 0 || /\s/.test(line[offset - 1]!))) break;
      offset += 1;
    }
    if (offset > start) tokens.push({ kind: "word", text: line.slice(start, offset), start, end: offset });
    else offset += 1;
  }

  return tokens;
}

function quotedTokenEnd(line: string, start: number, quote: "'" | '"'): number {
  let offset = start + 1;
  while (offset < line.length) {
    if (quote === '"' && line[offset] === "\\") {
      offset += 2;
      continue;
    }
    if (line[offset] === quote) return offset + 1;
    offset += 1;
  }
  return line.length;
}

function bashOperatorAt(line: string, offset: number): string | undefined {
  const candidates = ["&&", "||", ">>", "<<", ";;", "|&", ">&", "<&", ";", "|", "&", ">", "<"];
  return candidates.find((candidate) => line.startsWith(candidate, offset));
}

function isCommandSeparator(operator: string): boolean {
  return operator === "&&" || operator === "||" || operator === ";" || operator === "|" || operator === "|&";
}

function paintStringRange(
  styles: Array<SyntaxCategory | undefined>,
  start: number,
  end: number,
  category: SyntaxCategory,
): void {
  for (let offset = start; offset < end && offset < styles.length; offset += 1) {
    if (styles[offset] === undefined) styles[offset] = category;
  }
}

function styleSyntaxLine(line: string, styles: Array<SyntaxCategory | undefined>, theme: ThemeLike): string {
  if (line.length === 0) return "";
  let out = "";
  let offset = 0;
  while (offset < line.length) {
    const category = styles[offset];
    let end = offset + 1;
    while (end < line.length && styles[end] === category) end += 1;
    const text = line.slice(offset, end);
    out += category ? theme.fg(syntaxThemeColor(category), text) : theme.fg("toolOutput", text);
    offset = end;
  }
  return out;
}

function syntaxCategoryForCapture(name: string): SyntaxCategory | undefined {
  const dot = name.indexOf(".");
  const head = dot < 0 ? name : name.slice(0, dot);
  switch (head) {
    case "comment":
    case "keyword":
    case "function":
    case "string":
    case "number":
    case "type":
    case "operator":
    case "punctuation":
      return head;
    case "constructor":
      return "type";
    case "constant":
      return "constant";
    case "embedded":
      return "operator";
    case "property":
    case "variable":
      return "variable";
    default:
      return undefined;
  }
}

function syntaxCategoryPriority(category: SyntaxCategory | undefined): number {
  switch (category) {
    case "constant":
      return 25;
    case "punctuation":
      return 10;
    case "operator":
      return 20;
    case "variable":
      return 30;
    case "type":
      return 40;
    case "function":
      return 50;
    case "number":
      return 60;
    case "keyword":
      return 70;
    case "string":
      return 80;
    case "comment":
      return 90;
    default:
      return 0;
  }
}

function syntaxThemeColor(category: SyntaxCategory): string {
  switch (category) {
    case "constant":
      return "syntaxNumber";
    case "comment":
      return "syntaxComment";
    case "keyword":
      return "syntaxKeyword";
    case "function":
      return "syntaxFunction";
    case "variable":
      return "syntaxVariable";
    case "string":
      return "syntaxString";
    case "number":
      return "syntaxNumber";
    case "type":
      return "syntaxType";
    case "operator":
      return "syntaxOperator";
    case "punctuation":
      return "syntaxPunctuation";
  }
}

function bashTruncationNotice(details: unknown, theme: ThemeLike): string | undefined {
  if (!isRecord(details)) return undefined;
  const warnings: string[] = [];

  if (hasFullOutputPath(details)) {
    warnings.push(`Full output: ${details.fullOutputPath}`);
  }

  const truncation = details.truncation;
  if (isRecord(truncation) && truncation.truncated === true) {
    const outputLines = numberField(truncation, "outputLines");
    const totalLines = numberField(truncation, "totalLines");
    const maxBytes = numberField(truncation, "maxBytes") ?? DEFAULT_MAX_BYTES;
    if (truncation.truncatedBy === "lines" && outputLines !== undefined && totalLines !== undefined) {
      warnings.push(`Truncated: showing ${outputLines} of ${totalLines} lines`);
    } else if (outputLines !== undefined) {
      warnings.push(`Truncated: ${outputLines} lines shown (${formatSize(maxBytes)} limit)`);
    } else {
      warnings.push("Output truncated");
    }
  }
  if (details.truncated === true) warnings.push("Output truncated");

  return warnings.length > 0 ? theme.fg("warning", `[${warnings.join(". ")}]`) : undefined;
}

function stripPiBashTruncationFooterForDisplay(text: string, details: unknown): string {
  if (!hasStructuredBashTruncationNotice(details)) return text;
  return text.trimEnd().replace(
    /(?:^|\n)[ \t]*\[Showing (?:(?:lines \d+-\d+ of \d+(?: \([^)]+\))?)|(?:last [^\]\n]+))\. Full output: [^\]\n]+\][ \t]*$/,
    "",
  );
}

function hasStructuredBashTruncationNotice(details: unknown): boolean {
  if (!isRecord(details)) return false;
  const truncation = details.truncation;
  return hasFullOutputPath(details)
    || details.truncated === true
    || (isRecord(truncation) && truncation.truncated === true);
}

function hasFullOutputPath(details: Record<string, unknown>): boolean {
  return typeof details.fullOutputPath === "string" && details.fullOutputPath.length > 0;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function toolBackground(theme: ThemeLike, context?: ShellContextLike): ((text: string) => string) | undefined {
  if (!theme.bg) return undefined;
  const color = toolBackgroundColor(context);
  return (text: string) => theme.bg!(color, text);
}

function toolBackgroundColor(context?: ShellContextLike): string {
  return (context?.isPartial ?? true)
    ? "toolPendingBg"
    : context?.isError
      ? "toolErrorBg"
      : "toolSuccessBg";
}

function backgroundBlankLine(width: number, background: ((text: string) => string) | undefined): string {
  const blank = `\u200b${" ".repeat(Math.max(0, width))}`;
  return background ? background(blank) : blank;
}

const EMPTY_COMPONENT: Component = {
  render: () => [],
  invalidate: () => {},
};
