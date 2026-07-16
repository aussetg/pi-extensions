import { renderCapabilities, renderDiagnosticsStatus, renderStatus, updateFooterStatus } from "../render.ts";
import type { FormatService } from "../format/service.ts";
import type { LspService } from "../lsp/service.ts";
import { normalizeToolPath } from "../paths.ts";
import { configureFeedbackServices, restartLsp, setLspEnabled, setProjectRoot, setProjectTrust, type CodeFeedbackRuntime } from "../runtime.ts";
import type { PiApi } from "../pi.ts";
import { CONTEXT_INJECTION_SUBCOMMANDS, handleContextInjectionCommand } from "./context-injection.ts";
import { handleTrustCommand, TRUST_SUBCOMMANDS } from "./trust.ts";

const SUBCOMMANDS = ["status", "enable", "disable", "restart", "diagnostics", "capabilities", "context", "trust", "help"] as const;

export function registerLspCommand(pi: PiApi, runtime: CodeFeedbackRuntime, lspService: LspService, formatService: FormatService): void {
  pi.registerCommand("lsp", {
    description: "Manage code-feedback LSP feedback. Usage: /lsp status | enable | disable | restart | diagnostics | capabilities | context | trust",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      if (trimmed.toLowerCase().startsWith("context ")) return completeSubcommands(CONTEXT_INJECTION_SUBCOMMANDS, trimmed.slice("context ".length));
      if (trimmed.toLowerCase().startsWith("trust ")) return completeSubcommands(TRUST_SUBCOMMANDS, trimmed.slice("trust ".length));
      return completeSubcommands(SUBCOMMANDS, trimmed);
    },
    handler: async (args, ctx) => {
      setProjectRoot(runtime, ctx.cwd);
      setProjectTrust(runtime, ctx);
      configureFeedbackServices(runtime, lspService, formatService);
      const [subcommand = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);

      switch (subcommand.toLowerCase()) {
        case "status":
          ctx.ui.notify(renderStatus(runtime, lspService.getStatus(), runtime.projectTrusted ? formatService.getStatus() : undefined), "info");
          return;

        case "enable":
          if (!runtime.config.enabled) {
            ctx.ui.notify("code-feedback is disabled for this session; LSP feedback cannot be enabled.", "warning");
            return;
          }
          setLspEnabled(runtime, true);
          updateFooterStatus(ctx, runtime, lspService.getStatus());
          ctx.ui.notify("code-feedback LSP feedback enabled for this session. Use /lsp status to inspect it.", "info");
          return;

        case "disable":
          setLspEnabled(runtime, false);
          await lspService.shutdownAll();
          updateFooterStatus(ctx, runtime, lspService.getStatus());
          ctx.ui.notify("code-feedback LSP feedback disabled for this session. Use /lsp enable to turn it back on.", "warning");
          return;

        case "restart":
          if (!runtime.config.enabled) {
            ctx.ui.notify("code-feedback is disabled for this session; LSP clients will not be restarted.", "warning");
            return;
          }
          if (!runtime.projectTrusted) {
            await lspService.shutdownAll();
            updateFooterStatus(ctx, runtime, lspService.getStatus());
            ctx.ui.notify("Project is not trusted; LSP clients are paused until project trust is approved.", "warning");
            return;
          }
          restartLsp(runtime, "human command");
          await lspService.restart();
          updateFooterStatus(ctx, runtime, lspService.getStatus());
          ctx.ui.notify("code-feedback LSP clients restarted and config will be reused on demand.", "info");
          return;

        case "capabilities":
          if (!runtime.config.enabled || !runtime.config.lsp.enabled) {
            ctx.ui.notify(renderCapabilities(runtime, lspService.getStatus()), "warning");
            return;
          }
          if (!runtime.projectTrusted) {
            ctx.ui.notify("Project is not trusted; LSP capabilities are unavailable until project trust is approved.", "warning");
            return;
          }
          ctx.ui.notify(renderCapabilities(runtime, lspService.getStatus(), await lspService.capabilities(normalizeOptionalPath(rest[0]))), "info");
          return;

        case "diagnostics":
          ctx.ui.notify(renderDiagnosticsStatus(runtime, normalizeOptionalPath(rest[0]), lspService.cachedDiagnostics(normalizeOptionalPath(rest[0]))), "info");
          return;

        case "context":
          handleContextInjectionCommand(runtime, rest, ctx);
          return;

        case "trust":
          await handleTrustCommand(pi, runtime, lspService, formatService, rest, ctx);
          return;

        case "help":
        default:
          ctx.ui.notify(renderHelp(subcommand), subcommand === "help" ? "info" : "warning");
          return;
      }
    },
  });
}

function normalizeOptionalPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeToolPath(value);
  return normalized.length > 0 ? normalized : undefined;
}

function completeSubcommands(commands: readonly string[], prefix: string): Array<{ value: string; label: string }> {
  const needle = prefix.trim().toLowerCase();
  return commands
    .filter((command) => command.startsWith(needle))
    .map((command) => ({ value: command, label: command }));
}

function renderHelp(command: string): string {
  const prefix = command === "help" ? "code-feedback / LSP command" : `Unknown /lsp subcommand: ${command}`;
  return [
    prefix,
    "",
    "Usage:",
    "  /lsp status",
    "  /lsp enable",
    "  /lsp disable",
    "  /lsp restart",
    "  /lsp diagnostics [path|all]",
    "  /lsp capabilities [path]",
    "  /lsp context [status|on|off|toggle]",
    "  /lsp trust [status|add <path>|remove <path>|clear]",
  ].join("\n");
}

