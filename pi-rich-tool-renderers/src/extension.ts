import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { reloadPierreRendererConfig } from "../../codex-apply-patch/src/pierre/config.ts";
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

export function registerRichToolRenderers(pi: ExtensionAPI): void {
  reloadPierreRendererConfig();
  registerDelegatingBuiltInToolOverrides(pi);
  registerWriteSnapshotCapture(pi);

  pi.on?.("session_start", async () => {
    reloadPierreRendererConfig();
  });
}

function registerDelegatingBuiltInToolOverrides(pi: ExtensionAPI): void {
  const cwd = process.cwd();

  // Spread Pi's own definitions first. We intentionally replace only the
  // rendering slots below; execute(), prepareArguments(), prompt metadata, and
  // executionMode stay exactly as Pi defines them.

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
