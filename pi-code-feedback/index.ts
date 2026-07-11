import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { createDefaultConfig, registerFlags, resolveConfig } from "./src/config.ts";
import { registerLspCommand } from "./src/commands/lsp.ts";
import { reconfigureTrustedEnvironmentServices, restoreTrustedEnvironmentRoots } from "./src/commands/trust.ts";
import { handleContext } from "./src/events/context.ts";
import { handleToolCall } from "./src/events/tool-call.ts";
import { handleToolResult } from "./src/events/tool-result.ts";
import { createFormatService } from "./src/format/service.ts";
import { createLspService } from "./src/lsp/service.ts";
import { registerLspTool } from "./src/lsp/tool.ts";
import { asPiApi } from "./src/pi.ts";
import { renderFooterStatus } from "./src/render.ts";
import { beginTurn, createRuntime, refreshRuntimeConfig, setProjectRoot, setProjectTrust } from "./src/runtime.ts";

export default function (piValue: unknown) {
  const pi = asPiApi(piValue);
  registerFlags(pi);

  const runtime = createRuntime(createDefaultConfig());
  const lspService = createLspService({
    projectRoot: runtime.projectRoot,
    serverOverrides: runtime.config.lsp.servers,
    trustedEnvironmentRoots: runtime.trustedEnvironmentRoots,
    idleTimeoutMs: runtime.config.lsp.idleTimeoutMs,
    diagnosticRefreshConcurrency: runtime.config.lsp.diagnosticRefreshConcurrency,
  });
  const formatService = createFormatService({
    projectRoot: runtime.projectRoot,
    formatterOverrides: runtime.config.formatters,
    trustedEnvironmentRoots: runtime.trustedEnvironmentRoots,
  });

  registerLspCommand(pi, runtime, lspService, formatService);
  registerLspTool(pi, runtime, lspService, formatService, withFileMutationQueue);

  pi.on?.("session_start", async (_event, ctx) => {
    refreshRuntimeConfig(runtime, resolveConfig(pi));
    setProjectRoot(runtime, ctx.cwd);
    setProjectTrust(runtime, ctx);
    restoreTrustedEnvironmentRoots(runtime, ctx);
    lspService.configure({
      projectRoot: runtime.projectRoot,
      serverOverrides: runtime.config.lsp.servers,
      trustedEnvironmentRoots: runtime.trustedEnvironmentRoots,
      idleTimeoutMs: runtime.config.lsp.idleTimeoutMs,
      diagnosticRefreshConcurrency: runtime.config.lsp.diagnosticRefreshConcurrency,
    });
    formatService.configure({
      projectRoot: runtime.projectRoot,
      formatterOverrides: runtime.config.formatters,
      trustedEnvironmentRoots: runtime.trustedEnvironmentRoots,
    });
    if (!runtime.projectTrusted) await lspService.shutdownAll();
    ctx.ui?.setStatus?.("pi-code-feedback-lsp", renderFooterStatus(runtime, ctx.ui?.theme, lspService.getStatus()));
  });

  pi.on?.("session_tree", async (_event, ctx) => {
    setProjectRoot(runtime, ctx.cwd);
    setProjectTrust(runtime, ctx);
    const changed = restoreTrustedEnvironmentRoots(runtime, ctx);
    await reconfigureTrustedEnvironmentServices(runtime, lspService, formatService, changed ? "trusted external roots restored from branch" : undefined);
    if (!runtime.projectTrusted) await lspService.shutdownAll();
    ctx.ui?.setStatus?.("pi-code-feedback-lsp", renderFooterStatus(runtime, ctx.ui?.theme, lspService.getStatus()));
  });

  pi.on?.("turn_start", () => {
    beginTurn(runtime);
  });

  pi.on?.("tool_call", async (event, ctx) => {
    setProjectTrust(runtime, ctx);
    await handleToolCall(event as Parameters<typeof handleToolCall>[0], ctx, runtime, lspService);
  });

  pi.on?.("tool_result", async (event, ctx) => {
    setProjectTrust(runtime, ctx);
    const result = await handleToolResult(event as Parameters<typeof handleToolResult>[0], ctx, runtime, lspService, formatService);
    ctx.ui?.setStatus?.("pi-code-feedback-lsp", renderFooterStatus(runtime, ctx.ui?.theme, lspService.getStatus()));
    return result;
  });

  pi.on?.("context", (event) => {
    return handleContext(event as Parameters<typeof handleContext>[0], runtime);
  });

  pi.on?.("session_shutdown", async () => {
    await lspService.shutdownAll();
  });
}

