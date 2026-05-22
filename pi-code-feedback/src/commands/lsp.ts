import { renderCapabilities, renderDiagnosticsStatus, renderFooterStatus, renderStatus } from "../render.ts";
import type { FormatService } from "../format/service.ts";
import type { LspService } from "../lsp/service.ts";
import { restartLsp, setLspEnabled, setProjectRoot, type CodeFeedbackRuntime } from "../runtime.ts";
import type { PiApi, PiCommandContext } from "../pi.ts";

const SUBCOMMANDS = ["status", "enable", "disable", "restart", "diagnostics", "capabilities", "help"] as const;

export function registerLspCommand(pi: PiApi, runtime: CodeFeedbackRuntime, lspService: LspService, formatService?: FormatService): void {
  pi.registerCommand("lsp", {
    description: "Manage pi-code-feedback LSP feedback. Usage: /lsp status | enable | disable | restart | diagnostics | capabilities",
    getArgumentCompletions: (prefix) => {
      const needle = prefix.trim().toLowerCase();
      return SUBCOMMANDS
        .filter((command) => command.startsWith(needle))
        .map((command) => ({ value: command, label: command }));
    },
    handler: async (args, ctx) => {
      setProjectRoot(runtime, ctx.cwd);
      lspService.configure({
        projectRoot: runtime.projectRoot,
        serverOverrides: runtime.config.lsp.servers,
        idleTimeoutMs: runtime.config.lsp.idleTimeoutMs,
      });
      formatService?.configure({
        projectRoot: runtime.projectRoot,
        formatterOverrides: runtime.config.formatters,
      });
      const [subcommand = "status", ...rest] = normalizeArgs(args);

      switch (subcommand.toLowerCase()) {
        case "status":
          notify(ctx, renderStatus(runtime, lspService.getStatus(), formatService?.getStatus()), "info");
          return;

        case "enable":
        case "on":
          setLspEnabled(runtime, true);
          setFooterStatus(ctx, runtime);
          notify(ctx, "pi-code-feedback LSP feedback enabled for this session. Use /lsp status to inspect it.", "info");
          return;

        case "disable":
        case "off":
          setLspEnabled(runtime, false);
          setFooterStatus(ctx, runtime);
          notify(ctx, "pi-code-feedback LSP feedback disabled for this session. Use /lsp enable to turn it back on.", "warning");
          return;

        case "restart":
        case "reload":
          restartLsp(runtime, "human command");
          await lspService.restart();
          setFooterStatus(ctx, runtime);
          notify(ctx, "pi-code-feedback LSP clients restarted and config will be reused on demand.", "info");
          return;

        case "capabilities":
          notify(ctx, renderCapabilities(runtime, lspService.getStatus(), await lspService.capabilities(rest[0])), "info");
          return;

        case "diagnostics":
          notify(ctx, renderDiagnosticsStatus(runtime, rest[0], lspService.cachedDiagnostics(rest[0])), "info");
          return;

        case "help":
        default:
          notify(ctx, renderHelp(subcommand), subcommand === "help" ? "info" : "warning");
          return;
      }
    },
  });
}

function normalizeArgs(args: unknown): string[] {
  if (Array.isArray(args)) {
    return args.filter((arg): arg is string => typeof arg === "string" && arg.length > 0);
  }
  if (typeof args === "string") {
    return args.trim().split(/\s+/).filter(Boolean);
  }
  return [];
}

function notify(ctx: PiCommandContext, message: string, level: "info" | "warning" | "error"): void {
  ctx.ui.notify(message, level);
}

function setFooterStatus(ctx: PiCommandContext, runtime: CodeFeedbackRuntime): void {
  ctx.ui.setStatus?.("pi-code-feedback-lsp", renderFooterStatus(runtime, ctx.ui.theme));
}

function renderHelp(command: string): string {
  const prefix = command === "help" ? "pi-code-feedback / LSP command" : `Unknown /lsp subcommand: ${command}`;
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
  ].join("\n");
}

