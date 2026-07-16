import { CONFIG_DIR_NAME, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { createDefaultConfig, registerFlags, resolveConfig } from "./src/config.ts";
import { registerLspCommand } from "./src/commands/lsp.ts";
import { reconfigureAfterTrustChange, restoreTrustedEnvironmentRoots } from "./src/commands/trust.ts";
import { handleContext } from "./src/events/context.ts";
import { handleToolCall } from "./src/events/tool-call.ts";
import { handleToolResult } from "./src/events/tool-result.ts";
import { createFormatService } from "./src/format/service.ts";
import { createLspService } from "./src/lsp/service.ts";
import { loadLanguageServerConfiguration } from "./src/lsp/server-config.ts";
import { registerLspTool } from "./src/lsp/tool.ts";
import type { PiApi } from "./src/pi.ts";
import { updateFooterStatus } from "./src/render.ts";
import { beginTurn, cancelDelayedDiagnostics, configureFeedbackServices, createRuntime, setProjectRoot, setProjectTrust } from "./src/runtime.ts";

export default function (pi: PiApi) {
  registerFlags(pi);

  const runtime = createRuntime(createDefaultConfig());
  const lspService = createLspService({
    projectRoot: runtime.projectRoot,
    trustedEnvironmentRoots: runtime.trustedEnvironmentRoots,
    idleTimeoutMs: runtime.config.lsp.idleTimeoutMs,
    maxActiveClients: runtime.config.lsp.maxActiveClients,
    initializationConcurrency: runtime.config.lsp.initializationConcurrency,
    diagnosticRefreshConcurrency: runtime.config.lsp.diagnosticRefreshConcurrency,
  });
  const formatService = createFormatService({
    projectRoot: runtime.projectRoot,
    trustedEnvironmentRoots: runtime.trustedEnvironmentRoots,
  });

  registerLspCommand(pi, runtime, lspService, formatService);
  registerLspTool(pi, runtime, lspService, formatService, withFileMutationQueue);

  pi.on("session_start", async (_event, ctx) => {
    runtime.config = resolveConfig(pi);
    setProjectRoot(runtime, ctx.cwd);
    setProjectTrust(runtime, ctx);
    restoreTrustedEnvironmentRoots(runtime, ctx);
    const serverConfiguration = loadLanguageServerConfiguration({
      agentDir: getAgentDir(),
      projectRoot: runtime.projectRoot,
      configDirName: CONFIG_DIR_NAME,
      projectTrusted: runtime.projectTrusted,
    });
    configureFeedbackServices(runtime, lspService, formatService, serverConfiguration);
    if (!runtime.projectTrusted) await lspService.shutdownAll();
    if (serverConfiguration.status.errors.length > 0) {
      ctx.ui.notify(`code-feedback ignored invalid language-server config:\n${serverConfiguration.status.errors.join("\n")}`, "warning");
    }
    updateFooterStatus(ctx, runtime, lspService.getStatus());
  });

  pi.on("session_tree", async (_event, ctx) => {
    setProjectRoot(runtime, ctx.cwd);
    setProjectTrust(runtime, ctx);
    const changed = restoreTrustedEnvironmentRoots(runtime, ctx);
    await reconfigureAfterTrustChange(runtime, lspService, formatService, changed ? "trusted external roots restored from branch" : undefined);
    if (!runtime.projectTrusted) await lspService.shutdownAll();
    updateFooterStatus(ctx, runtime, lspService.getStatus());
  });

  pi.on("turn_start", () => {
    beginTurn(runtime);
  });

  pi.on("tool_call", async (event, ctx) => {
    setProjectTrust(runtime, ctx);
    await handleToolCall(event as Parameters<typeof handleToolCall>[0], ctx, runtime, lspService);
  });

  pi.on("tool_result", async (event, ctx) => {
    setProjectTrust(runtime, ctx);
    const result = await handleToolResult(event as Parameters<typeof handleToolResult>[0], ctx, runtime, lspService, formatService);
    updateFooterStatus(ctx, runtime, lspService.getStatus());
    return result;
  });

  pi.on("context", (event) => {
    return handleContext(event as Parameters<typeof handleContext>[0], runtime);
  });

  pi.on("session_shutdown", async () => {
    cancelDelayedDiagnostics(runtime);
    await lspService.shutdownAll();
  });
}

