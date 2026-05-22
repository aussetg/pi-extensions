import { renderCapabilities, renderDiagnosticsStatus, renderStatus } from "../render.ts";
import type { FormatService } from "../format/service.ts";
import type { LspService } from "./service.ts";
import { restartLsp, setProjectRoot, type CodeFeedbackRuntime } from "../runtime.ts";
import { LSP_ACTIONS, type LspAction } from "../types.ts";
import type { PiApi, PiToolResult } from "../pi.ts";
import { renderCodeActionApplySelectionError, renderLspActionResult, renderWorkspaceEditApplyResult } from "./render.ts";
import { applyWorkspaceEdit, selectCodeActionForApply } from "./workspace-edit.ts";

export function registerLspTool(pi: PiApi, runtime: CodeFeedbackRuntime, lspService: LspService, formatService?: FormatService): void {
  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: "Inspect language-server state and ask language-server questions. Formatting is intentionally not part of this tool.",
    promptSnippet: "Inspect LSP status/capabilities, diagnostics, and navigation for source files.",
    promptGuidelines: [
      "Use lsp with action=\"status\" when language-server feedback seems missing or stale.",
      "Use lsp with action=\"diagnostics\" for explicit diagnostic inspection; inline edit feedback already filters diagnostics to touched lines.",
      "Do not use lsp for formatting; formatting is handled by pi-code-feedback's edit pipeline or normal shell/editor tools.",
    ],
    parameters: LspToolParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      setProjectRoot(runtime, ctx?.cwd);
      lspService.configure({
        projectRoot: runtime.projectRoot,
        serverOverrides: runtime.config.lsp.servers,
        idleTimeoutMs: runtime.config.lsp.idleTimeoutMs,
      });
      formatService?.configure({
        projectRoot: runtime.projectRoot,
        formatterOverrides: runtime.config.formatters,
      });
      const action = parseAction(params.action);

      if (!action) {
        return textResult(`Unknown lsp action: ${String(params.action)}\nValid actions: ${LSP_ACTIONS.join(", ")}`, true, {
          validActions: LSP_ACTIONS,
        });
      }

      try {
        switch (action) {
        case "status":
          return textResult(renderStatus(runtime, lspService.getStatus(), formatService?.getStatus()), false, statusDetails(runtime, lspService, formatService));

        case "capabilities":
          return textResult(renderCapabilities(runtime, lspService.getStatus(), await lspService.capabilities(readPath(params))), false, {
            activeServers: lspService.getStatus().clients,
            implementedActions: LSP_ACTIONS,
          });

        case "diagnostics":
          return textResult(renderDiagnosticsStatus(runtime, params.all === true ? "all" : readPath(params), await diagnosticsSnapshot(params, lspService)), false, {
            implemented: true,
            diagnosticSnapshots: true,
            recentTouchedRanges: runtime.completedEdits.slice(-5).map((edit) => ({
              filePath: edit.filePath,
              toolName: edit.toolName,
              touchedRanges: edit.touchedRanges,
              detailsDiffPresent: edit.detailsDiffPresent,
              diagnosticFilter: edit.diagnosticFilter?.summary,
            })),
          });

        case "reload":
          restartLsp(runtime, "lsp tool");
          await lspService.restart();
          return textResult("pi-code-feedback LSP clients restarted and will be relaunched on demand.", false, statusDetails(runtime, lspService, formatService));

        case "hover":
          return rawOrPretty(params, await lspService.hover(requirePath(params), params.line, params.character), runtime.projectRoot);

        case "definition":
          return rawOrPretty(params, await lspService.definition(requirePath(params), params.line, params.character), runtime.projectRoot);

        case "references":
          return rawOrPretty(params, await lspService.references(requirePath(params), params.line, params.character), runtime.projectRoot);

        case "implementation":
          return rawOrPretty(params, await lspService.implementation(requirePath(params), params.line, params.character), runtime.projectRoot);

        case "type_definition":
          return rawOrPretty(params, await lspService.typeDefinition(requirePath(params), params.line, params.character), runtime.projectRoot);

        case "symbols":
          return rawOrPretty(params, await lspService.documentSymbols(requirePath(params)), runtime.projectRoot);

        case "workspace_symbols":
          return rawOrPretty(params, await lspService.workspaceSymbols(params.query, readPath(params)), runtime.projectRoot);

        case "code_actions":
          return handleCodeActions(params, runtime, lspService);

        case "rename":
          return handleRename(params, runtime, lspService);

        case "request":
          return rawOrPretty(params, await lspService.rawRequest(readPath(params), params.request, params.params), runtime.projectRoot);

        default:
          return textResult(renderActionStub(action, params), false, {
            action,
            implemented: false,
            next: "This should be unreachable; all declared LSP actions are handled.",
          });
        }
      } catch (error) {
        return textResult(`lsp ${action} failed: ${error instanceof Error ? error.message : String(error)}`, true, statusDetails(runtime, lspService, formatService));
      }
    },
  });
}

const LspToolParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: LSP_ACTIONS,
      description: "LSP action to run.",
    },
    path: { type: "string", description: "File path for file-scoped LSP actions." },
    line: { type: "number", description: "1-based line for position-scoped LSP actions." },
    character: { type: "number", description: "1-based character/column for position-scoped LSP actions." },
    query: { type: "string", description: "Search query for workspace_symbols, or a title/kind substring to select a code action when apply:true." },
    newName: { type: "string", description: "New symbol name for rename." },
    apply: { type: "boolean", description: "Apply safe text edits for rename or the selected code action. Resource operations are rejected." },
    all: { type: "boolean", description: "For diagnostics, include all diagnostics instead of touched/provenance-filtered diagnostics." },
    raw: { type: "boolean", description: "Return raw LSP-ish payloads when useful for debugging." },
    request: { type: "string", description: "Raw LSP request method for action=request." },
    params: { description: "Raw LSP request params for action=request." },
  },
  required: ["action"],
} satisfies Record<string, unknown>;

function parseAction(value: unknown): LspAction | undefined {
  return typeof value === "string" && (LSP_ACTIONS as readonly string[]).includes(value) ? (value as LspAction) : undefined;
}

function textResult(text: string, isError = false, details?: unknown): PiToolResult {
  return {
    content: [{ type: "text", text }],
    isError: isError || undefined,
    details,
  };
}

async function diagnosticsSnapshot(params: Record<string, unknown>, lspService: LspService) {
  if (params.all === true) return lspService.cachedDiagnostics("all");
  const filePath = readPath(params);
  if (!filePath) return lspService.cachedDiagnostics();
  return (await lspService.diagnosticsForFile(filePath, undefined, { timeoutMs: 1200, settleMs: 100 })) ?? lspService.cachedDiagnostics(filePath);
}

function statusDetails(runtime: CodeFeedbackRuntime, lspService: LspService, formatService?: FormatService): Record<string, unknown> {
  const serviceStatus = lspService.getStatus();
  return {
    enabled: runtime.config.enabled,
    lspEnabled: runtime.config.lsp.enabled,
    autoFormat: runtime.config.autoFormat,
    strict: runtime.config.strict,
    projectRoot: runtime.projectRoot,
    activeClients: serviceStatus.activeClients,
    clients: serviceStatus.clients,
    unavailableServers: serviceStatus.unavailableServers,
    restartCount: runtime.lspRestartCount,
    lastRestartAt: runtime.lastLspRestartAt,
    capturedEdits: runtime.completedEdits.length,
    pendingEdits: runtime.pendingEdits.size,
    delayedFeedback: runtime.delayedFeedback.length,
    format: formatService?.getStatus(),
  };
}

function readPath(params: Record<string, unknown>): string | undefined {
  return typeof params.path === "string" && params.path.length > 0 ? params.path : undefined;
}

function requirePath(params: Record<string, unknown>): string {
  const filePath = readPath(params);
  if (!filePath) throw new Error("lsp action requires path");
  return filePath;
}

function rawOrPretty(params: Record<string, unknown>, result: unknown, projectRoot: string): PiToolResult {
  const action = parseAction(params.action);
  const text = params.raw === true ? (JSON.stringify(result, null, 2) ?? "undefined") : renderLspResult(action, result, projectRoot);
  return {
    content: [{ type: "text", text }],
    details: { result },
  };
}

function renderLspResult(action: LspAction | undefined, result: unknown, projectRoot: string): string {
  if (action) return renderLspActionResult(action, result, projectRoot || process.cwd());
  if (result === null || result === undefined) return "No LSP result.";
  const text = JSON.stringify(result, null, 2) ?? String(result);
  return text.length <= 12_000 ? text : `${text.slice(0, 12_000)}\n... truncated`;
}

async function handleCodeActions(params: Record<string, unknown>, runtime: CodeFeedbackRuntime, lspService: LspService): Promise<PiToolResult> {
  const result = await lspService.codeActions(requirePath(params), params.line, params.character);
  if (params.apply !== true) return rawOrPretty(params, result, runtime.projectRoot);

  const selection = selectCodeActionForApply(result, params.query);
  if (!selection.action) {
    return textResult(renderCodeActionApplySelectionError(selection.error ?? "No code action selected.", selection.candidates), true, {
      result,
      candidates: selection.candidates,
    });
  }

  const applyResult = await applyWorkspaceEdit(selection.action.edit, runtime.projectRoot);
  if (applyResult.applied) await resyncChangedFiles(lspService, applyResult.changedFiles, runtime);
  const title = typeof selection.action.title === "string" ? selection.action.title : "selected code action";
  return textResult(renderWorkspaceEditApplyResult(applyResult, runtime.projectRoot, `code action "${title}"`), !applyResult.applied, {
    action: selection.action,
    applyResult,
  });
}

async function handleRename(params: Record<string, unknown>, runtime: CodeFeedbackRuntime, lspService: LspService): Promise<PiToolResult> {
  const result = await lspService.rename(requirePath(params), params.line, params.character, params.newName);
  if (params.apply !== true) return rawOrPretty(params, result, runtime.projectRoot);

  const applyResult = await applyWorkspaceEdit(result, runtime.projectRoot);
  if (applyResult.applied) await resyncChangedFiles(lspService, applyResult.changedFiles, runtime);
  return textResult(renderWorkspaceEditApplyResult(applyResult, runtime.projectRoot, `rename to "${String(params.newName)}"`), !applyResult.applied, {
    workspaceEdit: result,
    applyResult,
  });
}

async function resyncChangedFiles(lspService: LspService, changedFiles: string[], runtime: CodeFeedbackRuntime): Promise<void> {
  await Promise.all(changedFiles.slice(0, 20).map((filePath) => lspService.diagnosticsForFile(filePath, undefined, {
    timeoutMs: runtime.config.diagnostics.timeoutMs,
    settleMs: runtime.config.diagnostics.settleMs,
  }).catch(() => undefined)));
}

function renderActionStub(action: LspAction, params: Record<string, unknown>): string {
  const target = typeof params.path === "string" ? ` for ${params.path}` : "";
  return [
    `lsp action \"${action}\"${target} is declared but was not dispatched.`,
    "This should be unreachable; all declared LSP actions have handlers.",
  ].join("\n");
}

