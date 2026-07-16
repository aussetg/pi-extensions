import { renderCapabilities, renderDiagnosticsStatus, renderFooterStatus, renderStatus } from "../render.ts";
import type { FormatService } from "../format/service.ts";
import type { LspService } from "../lsp/service.ts";
import { normalizeToolPath } from "../paths.ts";
import { restartLsp, setLspEnabled, setProjectRoot, setProjectTrust, type CodeFeedbackRuntime } from "../runtime.ts";
import type { PiApi, PiCommandContext } from "../pi.ts";
import { contextInjectionArgumentCompletions, handleContextInjectionCommand } from "./context-injection.ts";
import { handleTrustCommand, trustArgumentCompletions } from "./trust.ts";

const SUBCOMMANDS = ["status", "enable", "disable", "restart", "diagnostics", "capabilities", "context", "trust", "help"] as const;

export function registerLspCommand(pi: PiApi, runtime: CodeFeedbackRuntime, lspService: LspService, formatService?: FormatService): void {
  pi.registerCommand("lsp", {
    description: "Manage code-feedback LSP feedback. Usage: /lsp status | enable | disable | restart | diagnostics | capabilities | context | trust",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      if (trimmed.toLowerCase().startsWith("context ")) return contextInjectionArgumentCompletions(trimmed.slice("context ".length));
      if (trimmed.toLowerCase().startsWith("trust ")) return trustArgumentCompletions(trimmed.slice("trust ".length));
      const needle = trimmed.toLowerCase();
      return SUBCOMMANDS
        .filter((command) => command.startsWith(needle))
        .map((command) => ({ value: command, label: command }));
    },
    handler: async (args, ctx) => {
      setProjectRoot(runtime, ctx.cwd);
      setProjectTrust(runtime, ctx);
      lspService.configure({
        projectRoot: runtime.projectRoot,
        trustedEnvironmentRoots: runtime.trustedEnvironmentRoots,
        idleTimeoutMs: runtime.config.lsp.idleTimeoutMs,
        diagnosticRefreshConcurrency: runtime.config.lsp.diagnosticRefreshConcurrency,
      });
      formatService?.configure({
        projectRoot: runtime.projectRoot,
        trustedEnvironmentRoots: runtime.trustedEnvironmentRoots,
      });
      const [subcommand = "status", ...rest] = normalizeArgs(args);

      switch (subcommand.toLowerCase()) {
        case "status":
          notify(ctx, renderStatus(runtime, lspService.getStatus(), runtime.projectTrusted ? formatService?.getStatus() : undefined), "info");
          return;

        case "enable":
        case "on":
          if (!runtime.config.enabled) {
            notify(ctx, "code-feedback is disabled for this session; LSP feedback cannot be enabled.", "warning");
            return;
          }
          setLspEnabled(runtime, true);
          setFooterStatus(ctx, runtime, lspService);
          notify(ctx, "code-feedback LSP feedback enabled for this session. Use /lsp status to inspect it.", "info");
          return;

        case "disable":
        case "off":
          setLspEnabled(runtime, false);
          await lspService.shutdownAll();
          setFooterStatus(ctx, runtime, lspService);
          notify(ctx, "code-feedback LSP feedback disabled for this session. Use /lsp enable to turn it back on.", "warning");
          return;

        case "restart":
        case "reload":
          if (!runtime.config.enabled) {
            notify(ctx, "code-feedback is disabled for this session; LSP clients will not be restarted.", "warning");
            return;
          }
          if (!runtime.projectTrusted) {
            await lspService.shutdownAll();
            setFooterStatus(ctx, runtime, lspService);
            notify(ctx, "Project is not trusted; LSP clients are paused until project trust is approved.", "warning");
            return;
          }
          restartLsp(runtime, "human command");
          await lspService.restart();
          setFooterStatus(ctx, runtime, lspService);
          notify(ctx, "code-feedback LSP clients restarted and config will be reused on demand.", "info");
          return;

        case "capabilities":
          if (!runtime.config.enabled || !runtime.config.lsp.enabled) {
            notify(ctx, renderCapabilities(runtime, lspService.getStatus()), "warning");
            return;
          }
          if (!runtime.projectTrusted) {
            notify(ctx, "Project is not trusted; LSP capabilities are unavailable until project trust is approved.", "warning");
            return;
          }
          notify(ctx, renderCapabilities(runtime, lspService.getStatus(), await lspService.capabilities(normalizeOptionalPath(rest[0]))), "info");
          return;

        case "diagnostics":
          notify(ctx, renderDiagnosticsStatus(runtime, normalizeOptionalPath(rest[0]), lspService.cachedDiagnostics(normalizeOptionalPath(rest[0]))), "info");
          return;

        case "context":
          handleContextInjectionCommand(runtime, rest, ctx);
          return;

        case "trust":
          if (!formatService) {
            notify(ctx, "Formatter service is unavailable; cannot update trusted environment roots.", "warning");
            return;
          }
          await handleTrustCommand(pi, runtime, lspService, formatService, rest, ctx);
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

function normalizeOptionalPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeToolPath(value);
  return normalized.length > 0 ? normalized : undefined;
}

function notify(ctx: PiCommandContext, message: string, level: "info" | "warning" | "error"): void {
  ctx.ui.notify(message, level);
}

function setFooterStatus(ctx: PiCommandContext, runtime: CodeFeedbackRuntime, lspService: LspService): void {
  ctx.ui.setStatus?.("code-feedback-lsp", renderFooterStatus(runtime, ctx.ui.theme, lspService.getStatus()));
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

