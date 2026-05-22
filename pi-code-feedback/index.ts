import { createDefaultConfig, registerFlags, resolveConfig } from "./src/config.ts";
import { registerLspCommand } from "./src/commands/lsp.ts";
import { handleContext } from "./src/events/context.ts";
import { handleToolCall } from "./src/events/tool-call.ts";
import { handleToolResult } from "./src/events/tool-result.ts";
import { createFormatService } from "./src/format/service.ts";
import { createLspService } from "./src/lsp/service.ts";
import { registerLspTool } from "./src/lsp/tool.ts";
import { asPiApi } from "./src/pi.ts";
import { renderFooterStatus } from "./src/render.ts";
import { beginTurn, createRuntime, refreshRuntimeConfig, setProjectRoot } from "./src/runtime.ts";

export default function (piValue: unknown) {
  const pi = asPiApi(piValue);
  registerFlags(pi);

  const runtime = createRuntime(createDefaultConfig());
  const lspService = createLspService({
    projectRoot: runtime.projectRoot,
    serverOverrides: runtime.config.lsp.servers,
    idleTimeoutMs: runtime.config.lsp.idleTimeoutMs,
  });
  const formatService = createFormatService({
    projectRoot: runtime.projectRoot,
    formatterOverrides: runtime.config.formatters,
  });

  registerLspCommand(pi, runtime, lspService, formatService);
  registerLspTool(pi, runtime, lspService, formatService);

  pi.on?.("session_start", async (_event, ctx) => {
    refreshRuntimeConfig(runtime, resolveConfig(pi));
    setProjectRoot(runtime, ctx.cwd);
    lspService.configure({
      projectRoot: runtime.projectRoot,
      serverOverrides: runtime.config.lsp.servers,
      idleTimeoutMs: runtime.config.lsp.idleTimeoutMs,
    });
    formatService.configure({
      projectRoot: runtime.projectRoot,
      formatterOverrides: runtime.config.formatters,
    });
    ctx.ui.setStatus?.("pi-code-feedback-lsp", renderFooterStatus(runtime, ctx.ui.theme));
  });

  pi.on?.("turn_start", () => {
    beginTurn(runtime);
  });

  pi.on?.("tool_call", async (event, ctx) => {
    await handleToolCall(event as Parameters<typeof handleToolCall>[0], ctx, runtime, lspService);
  });

  pi.on?.("tool_result", async (event, ctx) => {
    return handleToolResult(event as Parameters<typeof handleToolResult>[0], ctx, runtime, lspService, formatService);
  });

  pi.on?.("context", (event) => {
    return handleContext(event as Parameters<typeof handleContext>[0], runtime);
  });

  pi.on?.("session_shutdown", async () => {
    await lspService.shutdownAll();
  });
}

