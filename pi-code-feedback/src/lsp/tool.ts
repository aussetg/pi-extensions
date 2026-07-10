import { createHash } from "node:crypto";
import * as path from "node:path";
import { renderCapabilities, renderDiagnosticsStatus, renderStatus } from "../render.ts";
import type { FormatService } from "../format/service.ts";
import { readUtf8IfExists } from "../fs.ts";
import type { LspService } from "./service.ts";
import { displayPathFromRoot, normalizeToolPath } from "../paths.ts";
import { restartLsp, setProjectRoot, setProjectTrust, type CodeFeedbackRuntime } from "../runtime.ts";
import { LSP_ACTIONS, LSP_METHODS, LSP_RESULT_SERVER_ID_KEY, type LspAction, type LspMethod } from "../types.ts";
import type { PiApi, PiToolResult } from "../pi.ts";
import { renderCodeActionApplySelectionError, renderLspActionResult, renderWorkspaceEditApplyResult } from "./render.ts";
import {
  formatLspToolJson,
  limitLspToolDetails,
  limitLspToolText,
  type LspToolDetailsTruncation,
  type LspToolJsonTruncation,
  type LspToolTruncation,
} from "./tool-output.ts";
import { renderLspToolCall, renderLspToolResult } from "./tool-renderer.ts";
import { applyWorkspaceEdit, canResolveCodeActionOnApply, selectCodeActionForApply, workspaceEditSummary, workspaceEditTargetFiles, type WorkspaceEditTargetFilesResult } from "./workspace-edit.ts";

interface ParsedLspMethod {
  method?: LspMethod;
  error?: string;
}

interface LspToolState {
  nextCodeActionId: number;
  codeActions: Map<string, CachedCodeAction>;
}

interface CachedCodeAction {
  id: string;
  createdAt: number;
  projectRoot: string;
  requestFile: CachedFileState;
  editTargets: CachedFileState[];
  targetResolutionError?: string;
  action: Record<string, unknown>;
  summary: CodeActionSummary;
}

interface CachedFileState {
  filePath: string;
  exists: boolean;
  sha256?: string;
  bytes?: number;
}

interface CodeActionSummary {
  id: string;
  title: string;
  kind?: string;
  preferred: boolean;
  server?: string;
  diagnostics: string[];
  applyable: boolean;
  requiresResolve?: boolean;
  editSummary?: string;
}

type PreparedCodeActionForApply =
  | { ok: true; action: Record<string, unknown>; title: string }
  | { ok: false; error: string; details: Record<string, unknown>; hint?: string };

interface RenderedLspText {
  text: string;
  truncation?: LspToolJsonTruncation;
}

export function registerLspTool(pi: PiApi, runtime: CodeFeedbackRuntime, lspService: LspService, formatService?: FormatService): void {
  const toolState: LspToolState = {
    nextCodeActionId: 1,
    codeActions: new Map(),
  };

  pi.on?.("tool_result", (event: unknown) => {
    if (!isRecord(event) || event.toolName !== "lsp") return undefined;
    if (isLspErrorDetails(event.details)) return { isError: true };
    return undefined;
  });

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: "LSP-lite language-server tool: real LSP method names, flat path/line/column inputs, 1-based positions. Formatting is intentionally not part of this tool.",
    promptSnippet: "Inspect LSP status/capabilities, diagnostics, navigation, semantic tokens, code actions, and renames for source files.",
    promptGuidelines: [
      "Use lsp with method=\"server/status\" when language-server feedback seems missing or stale.",
      "Use lsp with real LSP method names such as method=\"textDocument/hover\", method=\"textDocument/definition\", and method=\"workspace/symbol\"; line and column are 1-based.",
      "Use lsp method=\"textDocument/diagnostic\" with path to refresh one file, or method=\"workspace/diagnostic\" for cached known diagnostics; explicit diagnostics are not touched-line filtered.",
      "Use lsp method=\"textDocument/codeAction\" with path, line, and column to list code actions, then method=\"codeAction/apply\" with the returned id to apply one safely.",
      "Do not use lsp for formatting; formatting is handled by pi-code-feedback's edit pipeline or normal shell/editor tools.",
    ],
    parameters: LspToolParameters,
    renderCall(args, theme) {
      return renderLspToolCall(args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderLspToolResult(result, options, theme, context);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      setProjectRoot(runtime, ctx?.cwd);
      setProjectTrust(runtime, ctx);
      lspService.configure({
        projectRoot: runtime.projectRoot,
        serverOverrides: runtime.config.lsp.servers,
        trustedEnvironmentRoots: runtime.trustedEnvironmentRoots,
        idleTimeoutMs: runtime.config.lsp.idleTimeoutMs,
        diagnosticRefreshConcurrency: runtime.config.lsp.diagnosticRefreshConcurrency,
      });
      formatService?.configure({
        projectRoot: runtime.projectRoot,
        formatterOverrides: runtime.config.formatters,
        trustedEnvironmentRoots: runtime.trustedEnvironmentRoots,
      });
      const parsed = parseToolMethod(params);
      const method = parsed.method;

      if (!method) {
        return errorResult(undefined, parsed.error ?? "lsp requires method", {
          validMethods: LSP_METHODS,
          legacyActions: LSP_ACTIONS,
        });
      }

      if (!runtime.config.enabled && method !== "server/status") {
        return textResult("pi-code-feedback is disabled for this session.", true, statusDetails(runtime, lspService, formatService));
      }

      if (!runtime.config.lsp.enabled && methodRequiresEnabledLsp(method, params)) {
        return textResult("pi-code-feedback LSP clients are disabled for this session. Use /lsp enable to turn them back on.", true, statusDetails(runtime, lspService, formatService));
      }

      if (!runtime.projectTrusted && methodRequiresProjectTrust(method)) {
        return errorResult(method, "Project is not trusted; pi-code-feedback LSP/formatting is paused until project trust is approved.", statusDetails(runtime, lspService, formatService));
      }

      try {
        switch (method) {
        case "server/status":
          return textResult(renderStatus(runtime, lspService.getStatus(), runtime.projectTrusted ? formatService?.getStatus() : undefined), false, statusDetails(runtime, lspService, formatService));

        case "server/capabilities":
          return textResult(renderCapabilities(runtime, lspService.getStatus(), await lspService.capabilities(readPath(params))), false, {
            clients: lspService.getStatus().clients,
            implementedMethods: LSP_METHODS,
            legacyActions: LSP_ACTIONS,
          });

        case "textDocument/diagnostic":
        case "workspace/diagnostic":
          return textResult(renderDiagnosticsStatus(runtime, diagnosticsTarget(method, params), await diagnosticsSnapshot(method, params, runtime, lspService)), false, {
            implemented: true,
            diagnosticSnapshots: true,
            hint: "workspace/diagnostic returns cached diagnostics for files the LSP already knows. Use textDocument/diagnostic with path to refresh one file.",
            recentTouchedRanges: runtime.completedEdits.slice(-5).map((edit) => ({
              filePath: edit.filePath,
              toolName: edit.toolName,
              touchedRanges: edit.touchedRanges,
              rangeComputation: edit.rangeComputation,
              diagnosticFilter: edit.diagnosticFilter?.summary,
            })),
          });

        case "server/reload":
          restartLsp(runtime, "lsp tool");
          await lspService.restart();
          return textResult("pi-code-feedback LSP clients restarted and will be relaunched on demand.", false, statusDetails(runtime, lspService, formatService));

        case "textDocument/hover":
          return rawOrPretty(method, params, await lspService.hover(requirePath(params), params.line, readColumn(params)), runtime.projectRoot);

        case "textDocument/definition":
          return rawOrPretty(method, params, await lspService.definition(requirePath(params), params.line, readColumn(params)), runtime.projectRoot);

        case "textDocument/references":
          return rawOrPretty(method, params, await lspService.references(requirePath(params), params.line, readColumn(params)), runtime.projectRoot);

        case "textDocument/implementation":
          return rawOrPretty(method, params, await lspService.implementation(requirePath(params), params.line, readColumn(params)), runtime.projectRoot);

        case "textDocument/typeDefinition":
          return rawOrPretty(method, params, await lspService.typeDefinition(requirePath(params), params.line, readColumn(params)), runtime.projectRoot);

        case "textDocument/documentSymbol":
          return rawOrPretty(method, params, await lspService.documentSymbols(requirePath(params)), runtime.projectRoot);

        case "workspace/symbol":
          return rawOrPretty(method, params, await lspService.workspaceSymbols(params.query, readPath(params)), runtime.projectRoot);

        case "textDocument/semanticTokens":
          return rawOrPretty(method, params, await lspService.semanticTokens(requirePath(params), {
            waitMs: readNonNegativeNumber(params.waitMs),
            timeoutMs: readNonNegativeNumber(params.timeoutMs),
            forceRefresh: params.refresh === true,
          }), runtime.projectRoot);

        case "textDocument/codeAction":
          return await handleCodeActions(method, params, runtime, lspService, toolState);

        case "codeAction/apply":
          return await handleCodeActionApply(method, params, runtime, lspService, toolState);

        case "textDocument/rename":
          return await handleRename(params, runtime, lspService);

        case "raw/request":
          return rawOrPretty(method, params, await lspService.rawRequest(readPath(params), params.request, params.params), runtime.projectRoot);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const displayMessage = projectRelativeErrorMessage(message, runtime.projectRoot);
        return errorResult(method, `lsp ${method} failed: ${displayMessage}`, statusDetails(runtime, lspService, formatService), hintForError(message));
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
      description: "Deprecated compatibility alias. Prefer method with LSP names like textDocument/hover.",
    },
    method: {
      type: "string",
      enum: LSP_METHODS,
      description: "LSP-lite method to run. Uses real LSP method names where possible; positions are still 1-based.",
    },
    path: { type: "string", description: "File path for file-scoped LSP actions." },
    line: { type: "number", minimum: 1, multipleOf: 1, description: "1-based line for position-scoped LSP actions." },
    column: { type: "number", minimum: 1, multipleOf: 1, description: "1-based column for position-scoped LSP actions. Preferred over legacy character." },
    character: { type: "number", minimum: 1, multipleOf: 1, description: "Legacy 1-based column alias." },
    query: { type: "string", description: "Search query for workspace/symbol, or legacy title/kind substring to select a code action when apply:true." },
    id: { type: "string", description: "Stable id returned by textDocument/codeAction; required for codeAction/apply." },
    newName: { type: "string", description: "New symbol name for rename." },
    apply: { type: "boolean", description: "Legacy shortcut: apply safe text edits for rename or a query-selected code action. Prefer codeAction/apply with id." },
    all: { type: "boolean", description: "Legacy diagnostics flag. Explicit diagnostic methods already return unfiltered diagnostics for the requested target." },
    raw: { type: "boolean", description: "Return raw LSP-ish payloads when useful for debugging." },
    waitMs: { type: "number", description: "Milliseconds to wait for lazy semantic tokens before returning cached/stale overlay state." },
    timeoutMs: { type: "number", description: "Request timeout in milliseconds for semantic token refreshes." },
    refresh: { type: "boolean", description: "Force a semantic token refresh even when cached tokens match the current document version." },
    request: { type: "string", description: "Raw LSP request method for method=raw/request." },
    params: { description: "Raw LSP request params for method=raw/request." },
  },
} satisfies Record<string, unknown>;

function parseAction(value: unknown): LspAction | undefined {
  return typeof value === "string" && (LSP_ACTIONS as readonly string[]).includes(value) ? (value as LspAction) : undefined;
}

function parseMethod(value: unknown): LspMethod | undefined {
  return typeof value === "string" && (LSP_METHODS as readonly string[]).includes(value) ? (value as LspMethod) : undefined;
}

function parseToolMethod(params: Record<string, unknown>): ParsedLspMethod {
  const method = parseMethod(params.method);
  if (method) return { method };
  if (params.method !== undefined) {
    return { error: `Unknown lsp method: ${String(params.method)}` };
  }

  const action = parseAction(params.action);
  if (action) return { method: legacyActionToMethod(action, params) };
  if (params.action !== undefined) {
    return { error: `Unknown legacy lsp action: ${String(params.action)}` };
  }

  return { error: "lsp requires method. Example: method=\"server/status\" or method=\"textDocument/hover\"." };
}

function legacyActionToMethod(action: LspAction, params: Record<string, unknown>): LspMethod {
  switch (action) {
    case "status":
      return "server/status";
    case "capabilities":
      return "server/capabilities";
    case "reload":
      return "server/reload";
    case "diagnostics":
      return params.all === true || !readPath(params) ? "workspace/diagnostic" : "textDocument/diagnostic";
    case "hover":
      return "textDocument/hover";
    case "definition":
      return "textDocument/definition";
    case "references":
      return "textDocument/references";
    case "implementation":
      return "textDocument/implementation";
    case "type_definition":
      return "textDocument/typeDefinition";
    case "symbols":
      return "textDocument/documentSymbol";
    case "workspace_symbols":
      return "workspace/symbol";
    case "semantic_tokens":
      return "textDocument/semanticTokens";
    case "code_actions":
      return "textDocument/codeAction";
    case "rename":
      return "textDocument/rename";
    case "request":
      return "raw/request";
  }
}

function textResult(text: string, isError = false, details?: unknown): PiToolResult {
  const limited = limitLspToolText(text);
  return {
    content: [{ type: "text", text: limited.text }],
    isError: isError || undefined,
    details: withTruncationDetails(isError ? markErrorDetails(details) : details, limited.truncation),
  };
}

function markErrorDetails(details: unknown): unknown {
  if (isRecord(details)) return { ...details, ok: false };
  if (details === undefined) return { ok: false };
  return { ok: false, details };
}

function isLspErrorDetails(details: unknown): boolean {
  return isRecord(details) && details.ok === false;
}

function errorResult(method: LspMethod | undefined, error: string, details?: unknown, hint?: string): PiToolResult {
  const payload = {
    ok: false,
    ...(method ? { method } : {}),
    error,
    ...(hint ? { hint } : {}),
  };
  const text = [error, hint ? `hint: ${hint}` : undefined].filter(Boolean).join("\n");
  return {
    content: [{ type: "text", text }],
    isError: true,
    details: limitedDetails(details === undefined ? payload : { ...payload, details }),
  };
}

function structuredResult(payload: Record<string, unknown>, details?: unknown, isError = false): PiToolResult {
  const rendered = formatLspToolJson(payload);
  const limited = limitLspToolText(rendered.text);
  const resultDetails = withVisibleJsonTruncation(details === undefined ? payload : details, rendered.truncation);
  return {
    content: [{ type: "text", text: limited.text }],
    isError: isError || undefined,
    details: withTruncationDetails(resultDetails, limited.truncation),
  };
}

function withVisibleJsonTruncation(details: unknown, truncation: LspToolJsonTruncation | undefined): unknown {
  if (!truncation) return details;
  if (isRecord(details)) return { visibleJsonTruncation: truncation, ...details };
  return { visibleJsonTruncation: truncation, value: details };
}

function withTruncationDetails(details: unknown, truncation: LspToolTruncation | undefined): unknown {
  const withOutputTruncation = truncation
    ? isRecord(details)
      ? { truncation, ...details }
      : { truncation, value: details }
    : details;
  return limitedDetails(withOutputTruncation);
}

function limitedDetails(details: unknown): unknown {
  if (details === undefined) return undefined;
  const limited = limitLspToolDetails(details);
  if (!limited.truncation) return limited.details;
  return attachDetailsTruncation(limited.details, limited.truncation);
}

function attachDetailsTruncation(details: unknown, truncation: LspToolDetailsTruncation): unknown {
  if (isRecord(details)) return { ...details, detailsTruncation: truncation };
  return { value: details, detailsTruncation: truncation };
}

async function diagnosticsSnapshot(method: LspMethod, params: Record<string, unknown>, runtime: CodeFeedbackRuntime, lspService: LspService) {
  if (method === "workspace/diagnostic" || params.all === true) return lspService.cachedDiagnostics("all");
  const filePath = requirePath(params);
  if (!runtime.config.enabled || !runtime.config.lsp.enabled) return lspService.cachedDiagnostics(filePath);
  return (await lspService.diagnosticsForFile(filePath, undefined, { timeoutMs: 1200, settleMs: 100, snapshotScope: "file" })) ?? lspService.cachedDiagnostics(filePath);
}

function diagnosticsTarget(method: LspMethod, params: Record<string, unknown>): string {
  if (method === "workspace/diagnostic" || params.all === true) return "all";
  return requirePath(params);
}

function statusDetails(runtime: CodeFeedbackRuntime, lspService: LspService, formatService?: FormatService): Record<string, unknown> {
  const serviceStatus = lspService.getStatus();
  return {
    enabled: runtime.config.enabled,
    lspEnabled: runtime.config.lsp.enabled,
    diagnosticRefreshConcurrency: runtime.config.lsp.diagnosticRefreshConcurrency,
    diagnosticRefreshes: serviceStatus.diagnosticRefreshes,
    autoFormat: runtime.config.autoFormat,
    strict: runtime.config.strict,
    projectTrusted: runtime.projectTrusted,
    projectRoot: runtime.projectRoot,
    clientSummary: serviceStatus.clients.length === 0 ? "none yet — starts lazily when you query a source file" : `${serviceStatus.clients.length} client(s)`,
    clients: serviceStatus.clients,
    unavailableServers: serviceStatus.unavailableServers,
    restartCount: runtime.lspRestartCount,
    lastRestartAt: runtime.lastLspRestartAt,
    capturedEdits: runtime.completedEdits.length,
    pendingEdits: runtime.pendingEdits.size,
    delayedFeedback: runtime.delayedFeedback.length,
    format: runtime.projectTrusted ? formatService?.getStatus() : undefined,
  };
}

function readPath(params: Record<string, unknown>): string | undefined {
  if (typeof params.path !== "string" || params.path.length === 0) return undefined;
  const normalized = normalizeToolPath(params.path);
  return normalized.length > 0 ? normalized : undefined;
}

function readColumn(params: Record<string, unknown>): unknown {
  return params.column ?? params.character;
}

function methodRequiresEnabledLsp(method: LspMethod, params: Record<string, unknown>): boolean {
  switch (method) {
    case "server/status":
    case "server/reload":
    case "workspace/diagnostic":
    case "textDocument/diagnostic":
      return false;
    case "server/capabilities":
      return readPath(params) !== undefined;
    default:
      return true;
  }
}

function methodRequiresProjectTrust(method: LspMethod): boolean {
  return method !== "server/status" && method !== "workspace/diagnostic";
}

function requirePath(params: Record<string, unknown>): string {
  const filePath = readPath(params);
  if (!filePath) throw new Error("lsp method requires path");
  return filePath;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function rawOrPretty(method: LspMethod, params: Record<string, unknown>, result: unknown, projectRoot: string): PiToolResult {
  const action = methodToRenderAction(method);
  const raw = params.raw === true;
  const rendered = raw ? formatLspToolJson(result) : renderLspResult(action, result, projectRoot);
  const limited = limitLspToolText(rendered.text);
  return {
    content: [{ type: "text", text: limited.text }],
    details: withTruncationDetails({
      ok: true,
      method,
      raw,
      ...(rendered.truncation ? { visibleJsonTruncation: rendered.truncation } : {}),
      result,
    }, limited.truncation),
  };
}

function methodToRenderAction(method: LspMethod): LspAction | undefined {
  switch (method) {
    case "textDocument/hover":
      return "hover";
    case "textDocument/definition":
      return "definition";
    case "textDocument/references":
      return "references";
    case "textDocument/implementation":
      return "implementation";
    case "textDocument/typeDefinition":
      return "type_definition";
    case "textDocument/documentSymbol":
      return "symbols";
    case "workspace/symbol":
      return "workspace_symbols";
    case "textDocument/semanticTokens":
      return "semantic_tokens";
    case "textDocument/codeAction":
      return "code_actions";
    case "textDocument/rename":
      return "rename";
    default:
      return undefined;
  }
}

function renderLspResult(action: LspAction | undefined, result: unknown, projectRoot: string): RenderedLspText {
  if (action) return { text: renderLspActionResult(action, result, projectRoot || process.cwd()) };
  if (result === null || result === undefined) return { text: "No LSP result." };
  return formatLspToolJson(result);
}

async function handleCodeActions(method: LspMethod, params: Record<string, unknown>, runtime: CodeFeedbackRuntime, lspService: LspService, state: LspToolState): Promise<PiToolResult> {
  if (params.apply === true) {
    const pendingGuard = rejectApplyDuringPendingEdits(runtime, "code action");
    if (pendingGuard) return pendingGuard;
  }

  const filePath = requirePath(params);
  const requestFileStateBefore = readCachedFileState(path.resolve(runtime.projectRoot, filePath));
  const column = readColumn(params);
  const result = await lspService.codeActions(filePath, params.line, column);
  const requestFileStateAfter = readCachedFileState(path.resolve(runtime.projectRoot, filePath));
  if (!sameCachedFileState(requestFileStateBefore, requestFileStateAfter)) {
    return errorResult(method, `File changed while collecting code actions: ${relativePath(runtime.projectRoot, requestFileStateAfter.filePath)}`, {
      before: displayFileState(runtime.projectRoot, requestFileStateBefore),
      after: displayFileState(runtime.projectRoot, requestFileStateAfter),
    }, "Rerun textDocument/codeAction so returned ids match the current file contents.");
  }
  if (params.raw === true) return rawOrPretty(method, params, result, runtime.projectRoot);

  if (params.apply !== true) {
    const actions = Array.isArray(result) ? result.filter(isRecord) : [];
    const summaries = actions.map((action) => cacheCodeAction(state, runtime.projectRoot, action, requestFileStateAfter));
    return structuredResult({
      ok: true,
      method,
      path: filePath,
      line: typeof params.line === "number" ? params.line : undefined,
      column: typeof column === "number" ? column : undefined,
      actions: summaries,
      hint: summaries.some((action) => action.applyable)
        ? "Apply one with method=\"codeAction/apply\" and id."
        : undefined,
    }, {
      ok: true,
      method,
      actions: summaries,
      result,
    });
  }

  const selection = selectCodeActionForApply(result, params.query);
  if (!selection.action) {
    return textResult(renderCodeActionApplySelectionError(selection.error ?? "No code action selected.", selection.candidates), true, {
      result,
      candidates: selection.candidates,
    });
  }

  const prepared = await prepareCodeActionForApply(selection.action, filePath, runtime, lspService, "selected code action");
  if (!prepared.ok) return errorResult(method, prepared.error, prepared.details, prepared.hint);

  const applyResult = await applyWorkspaceEdit(prepared.action.edit, runtime.projectRoot);
  if (applyResult.applied) await resyncChangedFiles(lspService, applyResult.changedFiles, runtime);
  const title = prepared.title;
  return textResult(renderWorkspaceEditApplyResult(applyResult, runtime.projectRoot, `code action "${title}"`), !applyResult.applied, {
    action: prepared.action,
    applyResult,
  });
}

async function handleCodeActionApply(method: LspMethod, params: Record<string, unknown>, runtime: CodeFeedbackRuntime, lspService: LspService, state: LspToolState): Promise<PiToolResult> {
  const pendingGuard = rejectApplyDuringPendingEdits(runtime, "code action");
  if (pendingGuard) return pendingGuard;

  const id = typeof params.id === "string" ? params.id.trim() : "";
  if (!id) return errorResult(method, "codeAction/apply requires id", { cachedIds: [...state.codeActions.keys()].slice(-20) }, "Call textDocument/codeAction first and pass one returned id.");

  const cached = state.codeActions.get(id);
  if (!cached) return errorResult(method, `Unknown code action id: ${id}`, { cachedIds: [...state.codeActions.keys()].slice(-20) }, "Call textDocument/codeAction again; code action ids are session-local and bounded.");
  state.codeActions.delete(id);
  if (path.resolve(cached.projectRoot) !== path.resolve(runtime.projectRoot)) {
    return errorResult(method, `Code action id ${id} belongs to a different project root`, { id, actionProjectRoot: cached.projectRoot, projectRoot: runtime.projectRoot });
  }

  const stale = validateCachedCodeAction(cached, runtime.projectRoot);
  if (stale) {
    return errorResult(method, `Code action id ${id} is stale: ${stale.reason}`, {
      id,
      action: cached.summary,
      stale,
    }, "Call textDocument/codeAction again and apply one of the fresh ids.");
  }

  const prepared = await prepareCodeActionForApply(cached.action, cached.requestFile.filePath, runtime, lspService, `Code action id ${id}`);
  if (!prepared.ok) {
    return errorResult(method, prepared.error, {
      id,
      action: cached.summary,
      targetResolutionError: cached.targetResolutionError,
      ...prepared.details,
    }, prepared.hint);
  }

  const applyResult = await applyWorkspaceEdit(prepared.action.edit, runtime.projectRoot);
  if (applyResult.applied) await resyncChangedFiles(lspService, applyResult.changedFiles, runtime);

  const payload = {
    ok: applyResult.applied,
    method,
    id,
    title: prepared.title,
    applied: applyResult.applied,
    editCount: applyResult.editCount,
    changedFiles: applyResult.changedFiles.map((filePath) => relativePath(runtime.projectRoot, filePath)),
    rejected: applyResult.rejected,
  };
  return structuredResult(payload, {
    ...payload,
    action: prepared.action,
    applyResult,
  }, !applyResult.applied);
}

async function handleRename(params: Record<string, unknown>, runtime: CodeFeedbackRuntime, lspService: LspService): Promise<PiToolResult> {
  if (params.apply === true) {
    const pendingGuard = rejectApplyDuringPendingEdits(runtime, "rename");
    if (pendingGuard) return pendingGuard;
  }

  const result = await lspService.rename(requirePath(params), params.line, readColumn(params), params.newName);
  if (params.apply !== true) return rawOrPretty("textDocument/rename", params, result, runtime.projectRoot);

  const applyResult = await applyWorkspaceEdit(result, runtime.projectRoot);
  if (applyResult.applied) await resyncChangedFiles(lspService, applyResult.changedFiles, runtime);

  const payload = {
    ok: applyResult.applied,
    method: "textDocument/rename",
    newName: String(params.newName),
    applied: applyResult.applied,
    editCount: applyResult.editCount,
    changedFiles: applyResult.changedFiles.map((filePath) => relativePath(runtime.projectRoot, filePath)),
    rejected: applyResult.rejected,
  };
  return structuredResult(payload, {
    ...payload,
    workspaceEdit: result,
    applyResult,
  }, !applyResult.applied);
}

function cacheCodeAction(
  state: LspToolState,
  projectRoot: string,
  action: Record<string, unknown>,
  requestFile: CachedFileState,
): CodeActionSummary {
  pruneCodeActionCache(state);
  const id = `ca_${(state.nextCodeActionId++).toString(36).padStart(4, "0")}`;
  const targetFiles = action.edit === undefined ? undefined : workspaceEditTargetFiles(action.edit, projectRoot);
  const summary = summarizeCodeAction(id, action, targetFiles);
  state.codeActions.set(id, {
    id,
    createdAt: Date.now(),
    projectRoot,
    requestFile,
    editTargets: targetFiles?.ok ? targetFiles.files.map((filePath) => readEditTargetFileState(filePath, requestFile)) : [],
    targetResolutionError: targetFiles && !targetFiles.ok ? targetFiles.reason : undefined,
    action,
    summary,
  });
  return summary;
}

function pruneCodeActionCache(state: LspToolState): void {
  const maxEntries = 200;
  if (state.codeActions.size < maxEntries) return;
  const stale = [...state.codeActions.values()]
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(0, Math.max(1, state.codeActions.size - maxEntries + 1));
  for (const entry of stale) state.codeActions.delete(entry.id);
}

async function prepareCodeActionForApply(
  action: Record<string, unknown>,
  requestFilePath: string,
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  label: string,
): Promise<PreparedCodeActionForApply> {
  let resolvedAction = action;
  const needsResolve = canResolveCodeActionOnApply(action);

  if (action.edit === undefined && !needsResolve) {
    return {
      ok: false,
      error: `${label} is not safely applyable`,
      details: {
        action: summarizeCodeAction("", action, undefined),
        editSummary: workspaceEditSummary(action.edit),
      },
      hint: "Choose an action with applyable: true from textDocument/codeAction.",
    };
  }

  if (needsResolve) {
    try {
      const resolved = await lspService.resolveCodeAction(requestFilePath, action);
      if (!isRecord(resolved)) {
        return {
          ok: false,
          error: `${label} resolved to a non-object result`,
          details: { action, resolved },
          hint: "Call textDocument/codeAction again or choose another action.",
        };
      }
      resolvedAction = resolved;
    } catch (error) {
      return {
        ok: false,
        error: `${label} could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        details: { action },
        hint: "Call textDocument/codeAction again or choose an action with an immediate WorkspaceEdit.",
      };
    }
  }

  const targetFiles = workspaceEditTargetFiles(resolvedAction.edit, runtime.projectRoot);
  const edit = workspaceEditSummary(resolvedAction.edit);
  if (!targetFiles.ok || edit.edits === 0 || edit.resourceOperations !== 0) {
    return {
      ok: false,
      error: `${label} is not safely applyable`,
      details: {
        action: summarizeCodeAction("", resolvedAction, targetFiles),
        targetResolutionError: targetFiles.ok ? undefined : targetFiles.reason,
        editSummary: edit,
      },
      hint: needsResolve
        ? "The selected action resolved without a safe WorkspaceEdit. Choose another action."
        : "Choose an action with applyable: true from textDocument/codeAction.",
    };
  }

  return { ok: true, action: resolvedAction, title: codeActionTitle(resolvedAction) };
}

function summarizeCodeAction(id: string, action: Record<string, unknown>, targetFiles: WorkspaceEditTargetFilesResult | undefined): CodeActionSummary {
  const title = codeActionTitle(action);
  const kind = typeof action.kind === "string" ? action.kind : undefined;
  const server = typeof action[LSP_RESULT_SERVER_ID_KEY] === "string" ? action[LSP_RESULT_SERVER_ID_KEY] : undefined;
  const diagnostics = Array.isArray(action.diagnostics)
    ? action.diagnostics.map(diagnosticMessage).filter((message): message is string => Boolean(message)).slice(0, 5)
    : [];
  const requiresResolve = canResolveCodeActionOnApply(action);
  const edit = requiresResolve || action.edit === undefined ? { files: 0, edits: 0, resourceOperations: 0 } : workspaceEditSummary(action.edit);
  const hasEdit = edit.edits > 0 || edit.resourceOperations > 0;
  return {
    id,
    title,
    kind,
    preferred: action.isPreferred === true,
    server,
    diagnostics,
    applyable: requiresResolve || (targetFiles?.ok === true && edit.edits > 0 && edit.resourceOperations === 0),
    requiresResolve: requiresResolve || undefined,
    editSummary: hasEdit ? formatWorkspaceEditSummary(edit) : requiresResolve ? "resolves edit on apply" : undefined,
  };
}

function codeActionTitle(action: Record<string, unknown>): string {
  return typeof action.title === "string" ? action.title : typeof action.command === "string" ? action.command : "untitled action";
}

function diagnosticMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.message === "string" ? value.message : undefined;
}

function formatWorkspaceEditSummary(summary: { files: number; edits: number; resourceOperations: number }): string {
  const parts = [`${summary.edits} text edit${summary.edits === 1 ? "" : "s"} across ${summary.files} file${summary.files === 1 ? "" : "s"}`];
  if (summary.resourceOperations > 0) parts.push(`${summary.resourceOperations} resource operation${summary.resourceOperations === 1 ? "" : "s"}`);
  return parts.join(", ");
}

function validateCachedCodeAction(cached: CachedCodeAction, projectRoot: string): { reason: string; files?: Array<{ before: Record<string, unknown>; after: Record<string, unknown> }> } | undefined {
  const changedFiles: Array<{ before: Record<string, unknown>; after: Record<string, unknown> }> = [];
  for (const expected of dedupeFileStates([cached.requestFile, ...cached.editTargets])) {
    const current = readCachedFileState(expected.filePath);
    if (sameCachedFileState(expected, current)) continue;
    changedFiles.push({
      before: displayFileState(projectRoot, expected),
      after: displayFileState(projectRoot, current),
    });
  }

  if (changedFiles.length === 0) return undefined;
  return {
    reason: `file state changed since textDocument/codeAction: ${changedFiles.map((entry) => String(entry.after.path)).join(", ")}`,
    files: changedFiles,
  };
}

function dedupeFileStates(states: CachedFileState[]): CachedFileState[] {
  const byPath = new Map<string, CachedFileState>();
  for (const state of states) byPath.set(path.resolve(state.filePath), state);
  return [...byPath.values()];
}

function readCachedFileState(filePath: string): CachedFileState {
  const resolved = path.resolve(filePath);
  const content = readUtf8IfExists(resolved);
  if (content === undefined) return { filePath: resolved, exists: false };
  return {
    filePath: resolved,
    exists: true,
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: Buffer.byteLength(content, "utf8"),
  };
}

function readEditTargetFileState(filePath: string, requestFile: CachedFileState): CachedFileState {
  return path.resolve(filePath) === path.resolve(requestFile.filePath) ? requestFile : readCachedFileState(filePath);
}

function sameCachedFileState(left: CachedFileState, right: CachedFileState): boolean {
  return (
    path.resolve(left.filePath) === path.resolve(right.filePath) &&
    left.exists === right.exists &&
    left.sha256 === right.sha256
  );
}

function displayFileState(projectRoot: string, state: CachedFileState): Record<string, unknown> {
  return {
    path: relativePath(projectRoot, state.filePath),
    exists: state.exists,
    bytes: state.bytes,
    sha256: state.sha256 ? state.sha256.slice(0, 12) : undefined,
  };
}

function relativePath(projectRoot: string, filePath: string): string {
  return displayPathFromRoot(filePath, projectRoot);
}

function rejectApplyDuringPendingEdits(runtime: CodeFeedbackRuntime, label: string): PiToolResult | undefined {
  if (runtime.pendingEdits.size === 0) return undefined;
  return textResult(
    `Refusing to apply ${label} while ${runtime.pendingEdits.size} other file edit${runtime.pendingEdits.size === 1 ? " is" : "s are"} still pending in this tool batch. Retry after the edit tools finish.`,
    true,
    { pendingEdits: runtime.pendingEdits.size },
  );
}

async function resyncChangedFiles(lspService: LspService, changedFiles: string[], runtime: CodeFeedbackRuntime): Promise<void> {
  await Promise.all(changedFiles.slice(0, 20).map((filePath) => lspService.diagnosticsForFile(filePath, undefined, {
    timeoutMs: runtime.config.diagnostics.timeoutMs,
    settleMs: runtime.config.diagnostics.settleMs,
  }).catch(() => undefined)));
}

function hintForError(message: string): string | undefined {
  if (/requires 1-based line and character|requires 1-based line and column/i.test(message)) return "Pass line and column as 1-based numbers.";
  if (/requires path/i.test(message)) return "Pass path for textDocument methods.";
  if (/Cannot read file for LSP request/i.test(message)) return "Check that the path exists and rerun the request against a current file.";
  if (/No language server configured/i.test(message)) return "No configured language server matched this file. Check file extension, config, and installed server commands.";
  if (/No active LSP client|No LSP client available/i.test(message)) return "Pass path to a source file to choose and lazily start a language server.";
  return undefined;
}

function projectRelativeErrorMessage(message: string, projectRoot: string): string {
  const root = path.resolve(projectRoot);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return message.split(prefix).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}


