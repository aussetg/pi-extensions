import type { PiCommandContext } from "../pi.ts";
import type { CodeFeedbackRuntime } from "../runtime.ts";

export const CONTEXT_INJECTION_SUBCOMMANDS = ["status", "on", "off", "toggle"] as const;

export function handleContextInjectionCommand(
  runtime: CodeFeedbackRuntime,
  args: readonly string[],
  ctx: PiCommandContext,
): void {
  const subcommand = (args[0] ?? "status").toLowerCase();

  switch (subcommand) {
    case "status":
      ctx.ui.notify(renderContextInjectionStatus(runtime), "info");
      return;

    case "on":
      runtime.config.contextInjection = true;
      ctx.ui.notify(contextInjectionChangedMessage(runtime), "info");
      return;

    case "off":
      runtime.config.contextInjection = false;
      ctx.ui.notify(contextInjectionChangedMessage(runtime), "warning");
      return;

    case "toggle":
      runtime.config.contextInjection = !runtime.config.contextInjection;
      ctx.ui.notify(contextInjectionChangedMessage(runtime), runtime.config.contextInjection ? "info" : "warning");
      return;

    default:
      ctx.ui.notify(renderContextInjectionHelp(subcommand), "warning");
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
