import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  beginBashCoalescingAssistantMessage,
  cleanShellPtyArtifacts,
  clearBashCoalescingState,
  endBashCoalescingRun,
  hasAnsiEscapes,
  isHiddenBashContinuationComponent,
  rememberBashAnsiOutput,
  rememberToolExecutionEnd,
  rememberToolExecutionStart,
  renderBashCall,
  renderBashResult,
  restoreBashCoalescingGroupsFromMessages,
  startBashCoalescingRun,
  syncBashCoalescingAssistantMessage,
  stripAnsiEscapes,
} from "./bash-render.ts";
import { captureWriteSnapshot } from "./payloads.ts";
import {
  renderEditCall,
  renderEditResult,
  renderReadCall,
  renderReadResult,
  renderWriteCall,
  renderWriteResult,
} from "./render.ts";
import { isRecord, type ShellContextLike, type ThemeLike, type ToolResultLike } from "./util.ts";

type RenderOptions = { expanded: boolean; isPartial: boolean };
const DEFAULT_BASH = "/bin/bash";
const SHELL_CLEANING_CARRY_CHARS = 4096;

export function registerRichToolRenderers(pi: ExtensionAPI): void {
  installHiddenToolRowPatch();
  registerDelegatingBuiltInToolOverrides(pi);
  registerWriteSnapshotCapture(pi);
  registerBashAnsiSanitizer(pi);
  registerBashCoalescing(pi);
}

function registerDelegatingBuiltInToolOverrides(pi: ExtensionAPI): void {
  const cwd = process.cwd();

  // Spread Pi's own definitions first. We intentionally replace only the
  // rendering slots below; execute(), prepareArguments(), prompt metadata, and
  // executionMode stay exactly as Pi defines them.

  const bash = createBashTool(cwd, {
    spawnHook(context: BashSpawnContextLike): BashSpawnContextLike {
      return {
        ...context,
        command: colorPtyCommand(context.command),
        env: colorShellEnv(context.env),
      };
    },
  }) as DelegatingToolDefinition;
  pi.registerTool({
    ...bash,
    renderShell: "self",
    renderCall(args: unknown, theme: ThemeLike, context?: ShellContextLike) {
      return renderBashCall(args, theme, context);
    },
    renderResult(result: ToolResultLike, options: RenderOptions, theme: ThemeLike, context?: ShellContextLike) {
      return renderBashResult(result, options, theme, context);
    },
  });

  const read = createReadToolDefinition(cwd) as DelegatingToolDefinition;
  pi.registerTool({
    ...read,
    renderShell: "self",
    renderCall(args: unknown, theme: ThemeLike, context?: ShellContextLike) {
      return renderReadCall(args, theme, context);
    },
    renderResult(result: ToolResultLike, options: RenderOptions, theme: ThemeLike, context?: ShellContextLike) {
      return renderReadResult(result, options, theme, context);
    },
  });

  const write = createWriteToolDefinition(cwd) as DelegatingToolDefinition;
  pi.registerTool({
    ...write,
    renderShell: "self",
    renderCall(args: unknown, theme: ThemeLike, context?: ShellContextLike) {
      return renderWriteCall(args, theme, context);
    },
    renderResult(result: ToolResultLike, options: RenderOptions, theme: ThemeLike, context?: ShellContextLike) {
      return renderWriteResult(result, options, theme, context);
    },
  });

  const edit = createEditToolDefinition(cwd) as DelegatingToolDefinition;
  pi.registerTool({
    ...edit,
    renderShell: "self",
    renderCall(args: unknown, theme: ThemeLike, context?: ShellContextLike) {
      return renderEditCall(args, theme, context);
    },
    renderResult(result: ToolResultLike, options: RenderOptions, theme: ThemeLike, context?: ShellContextLike) {
      return renderEditResult(result, options, theme, context);
    },
  });
}

function registerWriteSnapshotCapture(pi: ExtensionAPI): void {
  pi.on?.("tool_call", async (event: unknown, ctx: { cwd?: string } = {}) => {
    if (!isToolCallEvent(event, "write")) return;
    if (!isWriteParams(event.input)) return;

    await captureWriteSnapshot({
      toolCallId: event.toolCallId,
      cwd: ctx.cwd,
      path: event.input.path,
      nextContent: event.input.content,
    });
  });
}

function registerBashAnsiSanitizer(pi: ExtensionAPI): void {
  pi.on?.("tool_result", async (event: unknown) => {
    if (!isToolResultEvent(event, "bash")) return;

    const rawText = firstTextContent(event.content);
    if (rawText === undefined) {
      rememberBashAnsiOutput(event.toolCallId, undefined);
      await cleanShellFullOutputFile(event.details);
      return;
    }

    if (hasAnsiEscapes(rawText)) rememberBashAnsiOutput(event.toolCallId, rawText);
    else rememberBashAnsiOutput(event.toolCallId, undefined);

    await cleanShellFullOutputFile(event.details);

    const cleanedText = contextShellText(rawText);
    if (cleanedText === rawText) return;

    return {
      content: replaceFirstTextContent(event.content, cleanedText),
      details: event.details,
    };
  });
}

function registerBashCoalescing(pi: ExtensionAPI): void {
  pi.on?.("session_start", (_event: unknown, ctx: unknown) => {
    clearBashCoalescingState();
    restoreBashCoalescingGroupsFromMessages(sessionMessages(ctx));
  });

  pi.on?.("agent_start", () => {
    startBashCoalescingRun();
  });

  pi.on?.("agent_end", () => {
    endBashCoalescingRun();
  });

  pi.on?.("message_start", (event: unknown) => {
    if (isAssistantMessageEvent(event)) beginBashCoalescingAssistantMessage();
  });

  pi.on?.("message_update", (event: unknown) => {
    if (isAssistantMessageEvent(event)) syncBashCoalescingAssistantMessage(event.message);
  });

  pi.on?.("message_end", (event: unknown) => {
    if (isAssistantMessageEvent(event)) syncBashCoalescingAssistantMessage(event.message, true);
  });

  pi.on?.("tool_execution_start", (event: unknown) => {
    if (!isToolExecutionStartEvent(event)) return;
    rememberToolExecutionStart(event.toolName, event.toolCallId, event.args);
  });

  pi.on?.("tool_execution_end", (event: unknown) => {
    if (!isToolExecutionEndEvent(event)) return;
    rememberToolExecutionEnd(event.toolName, event.toolCallId, event.isError === true);
  });
}

function installHiddenToolRowPatch(): void {
  const ToolExecutionComponent = (PiCodingAgent as Record<string, unknown>).ToolExecutionComponent;
  const componentClass = ToolExecutionComponent as unknown as { prototype?: Record<string, unknown> } | undefined;
  const proto = componentClass?.prototype;
  if (!proto || proto.__piRichToolsHiddenToolPatch === true) return;

  const originalRender = proto.render;
  if (typeof originalRender !== "function") return;

  proto.__piRichToolsHiddenToolPatch = true;
  proto.render = function patchedToolExecutionRender(this: Record<string, unknown>, width: number): string[] {
    if (isHiddenBashContinuationComponent(this.callRendererComponent)) return [];
    return (originalRender as (this: Record<string, unknown>, width: number) => string[]).call(this, width);
  };
}

function sessionMessages(ctx: unknown): unknown[] {
  if (!isRecord(ctx)) return [];
  const manager = ctx.sessionManager;
  if (!isRecord(manager)) return [];

  const buildSessionContext = manager.buildSessionContext;
  if (typeof buildSessionContext === "function") {
    const sessionContext = buildSessionContext.call(manager);
    if (isRecord(sessionContext) && Array.isArray(sessionContext.messages)) return sessionContext.messages;
  }

  const getBranch = manager.getBranch;
  if (typeof getBranch !== "function") return [];
  const branch = getBranch.call(manager);
  if (!Array.isArray(branch)) return [];
  return branch.flatMap((entry) => (isRecord(entry) && entry.type === "message" && "message" in entry ? [entry.message] : []));
}

type ToolRendererRegistration = {
  renderShell?: "default" | "self";
  renderCall?: (args: unknown, theme: ThemeLike, context?: ShellContextLike) => unknown;
  renderResult?: (
    result: ToolResultLike,
    options: RenderOptions,
    theme: ThemeLike,
    context?: ShellContextLike,
  ) => unknown;
};

type DelegatingToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  renderShell?: "default" | "self";
  renderCall?: ToolRendererRegistration["renderCall"];
  renderResult?: ToolRendererRegistration["renderResult"];
  [key: string]: unknown;
};

type BashSpawnContextLike = {
  command: string;
  cwd: string;
  env: Record<string, string | undefined>;
};

function colorPtyCommand(command: string): string {
  const forcedBashCommand = bashShellCommand(command);
  if (process.env.PI_RICH_TOOLS_DISABLE_COLOR_PTY === "1") return forcedBashCommand;
  if (!existsSync("/usr/bin/script")) return forcedBashCommand;
  return `/usr/bin/script -qefc ${shellSingleQuote(forcedBashCommand)} /dev/null`;
}

function colorShellEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    ...env,
    SHELL: DEFAULT_BASH,
    TERM: env.TERM && env.TERM !== "dumb" ? env.TERM : "xterm-256color",
    PAGER: "cat",
    GIT_PAGER: "cat",
    DELTA_PAGER: "cat",
    BAT_PAGER: "cat",
    GH_PAGER: "cat",
    SYSTEMD_PAGER: "cat",
    MANPAGER: "cat",
    LESS: "-FRX",
    COLORTERM: env.COLORTERM ?? "truecolor",
    FORCE_COLOR: env.FORCE_COLOR ?? "3",
    CLICOLOR_FORCE: env.CLICOLOR_FORCE ?? "1",
    npm_config_color: env.npm_config_color ?? "always",
    PY_COLORS: env.PY_COLORS ?? "1",
    NO_COLOR: undefined,
  };
}

function bashShellCommand(command: string): string {
  return `${DEFAULT_BASH} -c ${shellSingleQuote(command)}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function firstTextContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") return item.text;
  }
  return undefined;
}

function replaceFirstTextContent(content: unknown, text: string): unknown {
  if (!Array.isArray(content)) return content;
  let replaced = false;
  return content.map((item) => {
    if (!replaced && isRecord(item) && item.type === "text" && typeof item.text === "string") {
      replaced = true;
      return { ...item, text };
    }
    return item;
  });
}

async function cleanShellFullOutputFile(details: unknown): Promise<void> {
  if (!isRecord(details) || typeof details.fullOutputPath !== "string") return;
  const outputPath = details.fullOutputPath;
  const tempPath = `${outputPath}.pi-rich-tools-cleaning-${process.pid}-${Date.now()}`;
  let changed = false;
  let carry = "";

  try {
    await pipeline(
      createReadStream(outputPath, { encoding: "utf8" }),
      new Transform({
        decodeStrings: false,
        transform(chunk, _encoding, callback) {
          const text = carry + String(chunk);
          let emitLength = Math.max(0, text.length - SHELL_CLEANING_CARRY_CHARS);
          if (emitLength > 0 && text[emitLength - 1] === "\r") emitLength -= 1;
          if (emitLength === 0) {
            carry = text;
            callback();
            return;
          }

          const raw = text.slice(0, emitLength);
          carry = text.slice(emitLength);
          const cleaned = contextShellText(raw);
          if (cleaned !== raw) changed = true;
          callback(null, cleaned);
        },
        flush(callback) {
          const cleaned = contextShellText(carry);
          if (cleaned !== carry) changed = true;
          callback(null, cleaned);
        },
      }),
      createWriteStream(tempPath, { encoding: "utf8" }),
    );

    if (changed) await rename(tempPath, outputPath);
    else await rm(tempPath, { force: true });
  } catch {
    await rm(tempPath, { force: true }).catch(() => {});
    // Best effort. The tool result content is still stripped for model context.
  }
}

function contextShellText(rawText: string): string {
  return stripAnsiEscapes(cleanShellPtyArtifacts(rawText)).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function isWriteParams(value: unknown): value is { path: string; content: string } {
  return isRecord(value) && typeof value.path === "string" && typeof value.content === "string";
}

function isToolCallEvent(
  value: unknown,
  toolName: string,
): value is { toolName: string; toolCallId: string; input: unknown } {
  return (
    isRecord(value) &&
    value.toolName === toolName &&
    typeof value.toolCallId === "string" &&
    "input" in value
  );
}

function isToolResultEvent(
  value: unknown,
  toolName: string,
): value is { toolName: string; toolCallId: string; content: unknown; details?: unknown } {
  return (
    isRecord(value) &&
    value.toolName === toolName &&
    typeof value.toolCallId === "string" &&
    "content" in value
  );
}

function isAssistantMessageEvent(value: unknown): value is { message: unknown } {
  if (!isRecord(value)) return false;
  const message = value.message;
  return isRecord(message) && message.role === "assistant";
}

function isToolExecutionStartEvent(
  value: unknown,
): value is { toolName: string; toolCallId: string; args: unknown } {
  return (
    isRecord(value) &&
    typeof value.toolName === "string" &&
    typeof value.toolCallId === "string" &&
    "args" in value
  );
}

function isToolExecutionEndEvent(
  value: unknown,
): value is { toolName: string; toolCallId: string; isError?: boolean } {
  return (
    isRecord(value) &&
    typeof value.toolName === "string" &&
    typeof value.toolCallId === "string"
  );
}
