import type { PiCommandContext } from "../pi.ts";
import { setContextInjectionEnabled, type CodeFeedbackRuntime } from "../runtime.ts";

const SUBCOMMANDS = ["status", "on", "off", "toggle"] as const;

export function contextInjectionArgumentCompletions(prefix: string): Array<{ value: string; label?: string }> {
  const needle = prefix.trim().toLowerCase();
  return SUBCOMMANDS
    .filter((command) => command.startsWith(needle))
    .map((command) => ({ value: command, label: command }));
}

export function handleContextInjectionCommand(
  runtime: CodeFeedbackRuntime,
  args: readonly string[],
  ctx: PiCommandContext,
): void {
  const subcommand = (args[0] ?? "status").toLowerCase();

  switch (subcommand) {
    case "status":
      notify(ctx, renderContextInjectionStatus(runtime), "info");
      return;

    case "on":
      setContextInjectionEnabled(runtime, true);
      notify(ctx, contextInjectionChangedMessage(runtime), "info");
      return;

    case "off":
      setContextInjectionEnabled(runtime, false);
      notify(ctx, contextInjectionChangedMessage(runtime), "warning");
      return;

    case "toggle":
      setContextInjectionEnabled(runtime, !runtime.config.contextInjection);
      notify(ctx, contextInjectionChangedMessage(runtime), runtime.config.contextInjection ? "info" : "warning");
      return;

    default:
      notify(ctx, renderContextInjectionHelp(subcommand), "warning");
  }
}

function renderContextInjectionStatus(runtime: CodeFeedbackRuntime): string {
  return [
    "code-feedback / delayed context injection",
    `  context injection: ${runtime.config.contextInjection ? "enabled" : "disabled"}`,
    `  delayed feedback queued: ${runtime.delayedFeedback.length}`,
    "",
    "This controls only whether slow LSP feedback is prepended to model context. LSP diagnostics, formatting, and cached state remain active.",
  ].join("\n");
}

function contextInjectionChangedMessage(runtime: CodeFeedbackRuntime): string {
  if (runtime.config.contextInjection) {
    return "code-feedback delayed context injection enabled. Queued feedback will be added before the next model request.";
  }
  return "code-feedback delayed context injection disabled. LSP diagnostics and formatting remain active; queued feedback is preserved.";
}

function renderContextInjectionHelp(subcommand: string): string {
  return [
    `Unknown /lsp context subcommand: ${subcommand}`,
    "",
    "Usage:",
    "  /lsp context status",
    "  /lsp context on",
    "  /lsp context off",
    "  /lsp context toggle",
  ].join("\n");
}

function notify(ctx: PiCommandContext, message: string, level: "info" | "warning"): void {
  ctx.ui.notify(message, level);
}
