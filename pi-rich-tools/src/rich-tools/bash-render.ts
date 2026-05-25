import path from "node:path";
import { DEFAULT_MAX_BYTES, formatSize, keyHint } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { querySharedSyntaxCaptures, type TreeSitterCapture } from "../pierre/syntax-service.ts";
import { parseShellCommand, type ParsedShellCommand } from "../shell-intent.ts";
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
};
type PlainCommandCallLine = {
  type: "plain_command";
  command: string;
  active: boolean;
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
const MAX_REMEMBERED_ANSI_OUTPUTS = 200;
const MAX_REMEMBERED_BASH_CALLS = 500;
const rememberedAnsiOutputByToolCallId = new Map<string, string>();
const HIDDEN_BASH_CONTINUATION = Symbol.for("pi-rich-tools.hidden-bash-continuation");

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

export function hasAnsiEscapes(text: string): boolean {
  return ansiEscapePattern().test(text);
}

export function stripAnsiEscapes(text: string): string {
  return text.replace(ansiEscapePattern(), "");
}

export function cleanShellPtyArtifacts(text: string): string {
  const withoutNuls = text.replace(/\x00/g, "");
  return withoutNuls.startsWith("^@") ? withoutNuls.slice(2) : withoutNuls;
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
  activeBashGroupId = undefined;
  currentAssistantStartGroupId = undefined;
  bashCoalescingActive = true;
  bashCoalescingGeneration += 1;
}

export function endBashCoalescingRun(): void {
  activeBashGroupId = undefined;
  currentAssistantStartGroupId = undefined;
  bashCoalescingActive = false;
}

export function beginBashCoalescingAssistantMessage(): void {
  currentAssistantStartGroupId = activeBashGroupId;
}

export function syncBashCoalescingAssistantMessage(message: unknown, finalized = false): void {
  if (!bashCoalescingActive || !isAssistantMessage(message)) return;
  const startGroupId = currentAssistantStartGroupId;
  activeBashGroupId = scanAssistantBashCoalescing(message.content, startGroupId, bashCoalescingGeneration);
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

export function isHiddenBashContinuationComponent(component: unknown): boolean {
  return Boolean(component && typeof component === "object" && (component as Record<PropertyKey, unknown>)[HIDDEN_BASH_CONTINUATION]);
}

export function rememberToolExecutionStart(toolName: string, toolCallId: string, args: unknown): void {
  if (toolName !== "bash") {
    activeBashGroupId = undefined;
    return;
  }

  const summary = summarizeBashArgs(args);
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
      activeBashGroupId = undefined;
      return;
    }
    const group = existing.groupId ? bashCallGroupById.get(existing.groupId) : undefined;
    group?.invalidate?.();
    return;
  }

  if (!summary.exploratory) {
    upsertBashCallRecord(toolCallId, args, summary, undefined, bashCoalescingGeneration);
    activeBashGroupId = undefined;
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
  if (shouldDelayBashCallRendering(args, context)) return HIDDEN_BASH_CONTINUATION_COMPONENT;

  const state = bashCallRenderState(args, context, theme);
  if (state.hidden) return HIDDEN_BASH_CONTINUATION_COMPONENT;

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
  if (shouldSuppressExplorationOutput(result, context)) return EMPTY_COMPONENT;

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

  update(result: ToolResultLike, options: RenderOptions, theme: ThemeLike, context?: ShellContextLike): void {
    this.result = result;
    this.options = options;
    this.theme = theme;
    this.context = context;
  }

  render(width: number): string[] {
    if (!this.theme) return [];

    const output = normalizeLineEndings(rememberedBashAnsiOutput(this.context) ?? textContent(this.result) ?? "").trim();
    const warning = bashTruncationNotice(this.result.details, this.theme);
    if (!output && !warning) return [];

    const safeWidth = Math.max(1, Math.trunc(width));
    const contentWidth = Math.max(1, safeWidth - 2);
    const color = isToolError(this.result, this.context) ? "error" : "toolOutput";
    const bodyLines = output
      ? bashOutputPreviewLines(output, this.options.expanded, contentWidth, color, this.theme, this.context)
      : [];

    if (warning) {
      if (bodyLines.length > 0) bodyLines.push("");
      bodyLines.push(warning);
    }

    if (bodyLines.length === 0) return [];

    const background = toolBackground(this.theme, this.context);
    return [
      ...new Text(bodyLines.join("\n"), 1, 0, background).render(safeWidth),
      backgroundBlankLine(safeWidth, background),
    ];
  }

  invalidate(): void {}
}

class BashCallComponent implements Component {
  private lines: BashCallLine[] = [];
  private theme: ThemeLike | undefined;
  private context: ShellContextLike | undefined;

  update(lines: BashCallLine[], theme: ThemeLike, context?: ShellContextLike): void {
    this.lines = lines;
    this.theme = theme;
    this.context = context;
  }

  render(width: number): string[] {
    if (!this.theme) return [];
    const safeWidth = Math.max(1, Math.trunc(width));
    const contentWidth = Math.max(1, safeWidth - 2);
    const background = toolBackground(this.theme, this.context);
    return new Text(wrapBashCallLines(this.lines, contentWidth, this.theme, this.context).join("\n"), 1, 1, background).render(safeWidth);
  }

  invalidate(): void {}
}

const HIDDEN_BASH_CONTINUATION_COMPONENT: Component = {
  [HIDDEN_BASH_CONTINUATION]: true,
  render: () => [],
  invalidate: () => {},
} as Component;

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
    const parsed = records.flatMap((item) => item.parsed);
    const active = records.some((item) => !item.done) || context?.isPartial === true;
    const isError = records.some((item) => item.isError) || context?.isError === true;
    return {
      hidden: false,
      lines: renderExploringCallLines(parsed, active, theme, context),
      context: { ...context, isPartial: active, isError },
    };
  }

  const command = bashCommandArg(args);
  const parsed = parseShellCommand(command);
  const exploring = isExploring(parsed);
  const active = context?.isPartial === true;
  const lines = exploring
    ? renderExploringCallLines(parsed, active, theme, context)
    : renderPlainCommandCallLines(command, active);
  return { hidden: false, lines, context };
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
  const visualLines = output
    .split("\n")
    .flatMap((line) => wrapStyledLine(styleShellOutputLine(line, color, bgColor, theme), width));

  if (expanded || visualLines.length <= BASH_PREVIEW_LINES) return visualLines;

  const skipped = visualLines.length - BASH_PREVIEW_LINES;
  const hint =
    theme.fg("muted", `... (${skipped} earlier lines,`) +
    ` ${keyHint("app.tools.expand", "to expand")})`;
  return [truncateToWidth(hint, width, "..."), ...visualLines.slice(-BASH_PREVIEW_LINES)];
}

function wrapStyledLine(line: string, width: number): string[] {
  const wrapped = wrapTextWithAnsi(line, width).filter((item) => item.length > 0);
  return wrapped.length > 0 ? wrapped : [""];
}

function wrapBashCallLines(lines: BashCallLine[], width: number, theme: ThemeLike, context?: ShellContextLike): string[] {
  return lines.flatMap((line) => {
    if (typeof line === "string") return wrapStyledLine(line, width);
    if (line.type === "plain_command") return wrapPlainCommandCallLine(line, width, theme, context);
    return wrapTreeCallLine(line, width, theme);
  });
}

function wrapPlainCommandCallLine(
  line: PlainCommandCallLine,
  width: number,
  theme: ThemeLike,
  context?: ShellContextLike,
): string[] {
  const status = line.active ? "Running" : "Ran";
  const prefix = `${theme.fg("muted", "•")} ${theme.fg("toolTitle", theme.bold(status))} `;
  const preview = shellInputPreview(line.command, context?.expanded === true);
  const highlightedLines = highlightBashCommand(preview.text, theme).split("\n");
  const visualLines = highlightedLines.flatMap((commandLine, index) =>
    wrapStyledLine(index === 0 ? `${prefix}${commandLine}` : commandLine, width)
  );

  if (context?.expanded === true && !preview.collapsed) return visualLines;

  let visibleLines = visualLines;
  let skippedVisualLines = 0;
  if (visibleLines.length > BASH_INPUT_PREVIEW_LINES) {
    skippedVisualLines = visibleLines.length - BASH_INPUT_PREVIEW_LINES;
    visibleLines = visibleLines.slice(0, BASH_INPUT_PREVIEW_LINES);
  }

  if (!preview.collapsed && skippedVisualLines === 0) return visibleLines;
  return [...visibleLines, truncateToWidth(inputCollapseHint(preview, skippedVisualLines, theme), width, "...")];
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

function wrapTreeCallLine(line: TreeCallLine, width: number, theme: ThemeLike): string[] {
  const prefixWidth = 3;
  if (width <= prefixWidth) return [`${theme.fg("dim", line.branch)}${line.body}`];

  const bodyLines = wrapStyledLine(line.body, width - prefixWidth);
  const [first, ...rest] = bodyLines;
  return [
    `${theme.fg("dim", line.branch)}${first ?? ""}`,
    ...rest.map((item) => `${theme.fg("dim", line.continuation)}${item}`),
  ];
}

function styleShellOutputLine(
  line: string,
  color: "error" | "toolOutput",
  bgColor: string,
  theme: ThemeLike,
): string {
  if (!hasAnsiSgr(line)) return theme.fg(color, line);
  return theme.fg(color, rewriteAnsiResetsForToolShell(line, color, bgColor, theme));
}

function hasAnsiSgr(text: string): boolean {
  return /\x1b\[[0-9;]*m/.test(text);
}

function ansiEscapePattern(): RegExp {
  return /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[=>]|\x1b[@-_]/g;
}

function rememberedBashAnsiOutput(context?: ShellContextLike): string | undefined {
  return context?.toolCallId ? rememberedAnsiOutputByToolCallId.get(context.toolCallId) : undefined;
}

function scanAssistantBashCoalescing(
  content: unknown[],
  startGroupId: string | undefined,
  generation: number,
  markDone = false,
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

    const summary = summarizeBashArgs(item.arguments);
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

function summarizeBashArgs(args: unknown): { command: string; parsed: ParsedShellCommand[]; exploratory: boolean } {
  const command = bashCommandArg(args);
  const parsed = parseShellCommand(command);
  return { command, parsed, exploratory: isExploring(parsed) };
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
  summary: { command: string; parsed: ParsedShellCommand[]; exploratory: boolean },
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
  const summary = summarizeBashArgs(args);
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
    activeBashGroupId = undefined;
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
  parsed: ParsedShellCommand[],
  active: boolean,
  theme: ThemeLike,
  context?: ShellContextLike,
): BashCallLine[] {
  const lines: BashCallLine[] = [bulletLine(active ? "Exploring" : "Explored", theme)];
  const actionLines = parsedActionLines(parsed, theme, context);
  for (let i = 0; i < actionLines.length; i += 1) {
    const last = i === actionLines.length - 1;
    lines.push({
      type: "tree",
      branch: last ? "└─ " : "├─ ",
      continuation: last ? "   " : "│  ",
      body: actionLines[i]!,
    });
  }
  return lines;
}

function renderPlainCommandCallLines(command: string, active: boolean): BashCallLine[] {
  return [{ type: "plain_command", command, active }];
}

function bulletLine(label: string, theme: ThemeLike): string {
  return `${theme.fg("muted", "•")} ${theme.fg("toolTitle", theme.bold(label))}`;
}

function parsedActionLines(parsed: ParsedShellCommand[], theme: ThemeLike, context?: ShellContextLike): string[] {
  return parsed.map((item) => {
    switch (item.type) {
      case "read":
        return `${theme.fg("accent", "Read")} ${displayShellPath(item.path, context)}`;
      case "list_files":
        return `${theme.fg("accent", "List")} ${item.path ? displayShellPath(item.path, context) : item.cmd}`;
      case "search":
        return `${theme.fg("accent", "Search")} ${searchDisplay(item, theme, context)}`;
      case "unknown":
        return `${theme.fg("accent", "Run")} ${item.cmd}`;
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

function shouldSuppressExplorationOutput(result: ToolResultLike, context?: ShellContextLike): boolean {
  if (isToolError(result, context) || hasBashTruncationNotice(result.details)) return false;
  const parsed = parseShellCommand(bashCommandArg(context?.args));
  return parsed.length > 0 && parsed.every((item) => item.type !== "unknown");
}

function shouldDelayBashCallRendering(args: unknown, context?: ShellContextLike): boolean {
  if (context?.isPartial !== true || context.argsComplete === true || context.executionStarted === true) return false;

  const command = bashCommandArg(args).trim();
  if (!command) return true;

  const parsed = parseShellCommand(command);
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

function highlightBashCommand(command: string, theme: ThemeLike): string {
  if (!command) return theme.fg("toolOutput", "...");

  const lines = command.split("\n");
  const styles = lines.map((line) => new Array<SyntaxCategory | undefined>(line.length));
  const captures = querySharedSyntaxCaptures({ languageKey: "bash", text: command });
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

    const start = row === startRow ? byteColumnToStringIndex(line, capture.node.startPosition.column) : 0;
    const end = row === endRow ? byteColumnToStringIndex(line, capture.node.endPosition.column) : line.length;
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

function byteColumnToStringIndex(line: string, column: number): number {
  if (column <= 0) return 0;

  let bytes = 0;
  for (let index = 0; index < line.length;) {
    const codePoint = line.codePointAt(index);
    if (codePoint === undefined) break;
    const width = codePoint > 0xffff ? 2 : 1;
    const byteWidth = Buffer.byteLength(line.slice(index, index + width), "utf8");
    if (bytes + byteWidth > column) return index;
    bytes += byteWidth;
    index += width;
  }

  return line.length;
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

function hasBashTruncationNotice(details: unknown): boolean {
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
