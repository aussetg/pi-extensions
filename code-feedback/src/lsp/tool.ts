import * as path from "node:path";
import { errorMessage } from "../errors.ts";
import { renderCapabilities, renderDiagnosticsStatus, renderStatus, type ExplicitDiagnosticRefreshStatus } from "../render.ts";
import type { FormatService } from "../format/service.ts";
import { EXPLICIT_LSP_DIAGNOSTIC_TIMEOUT_MS, type LspService } from "./service.ts";
import { displayPathFromRoot, normalizeToolPath, projectRelativeText, readToolPath } from "../paths.ts";
import { configureFeedbackServices, restartLsp, setProjectRoot, type CodeFeedbackRuntime } from "../runtime.ts";
import { isRecord, LSP_METHODS, LSP_RESULT_SERVER_ID_KEY, LSP_RESULT_SERVER_SESSION_ID_KEY, type DiagnosticRefreshResult, type DiagnosticSnapshot, type LspMethod, type WorkspaceDiagnosticScanResult } from "../types.ts";
import type { PiApi, PiToolResult } from "../pi.ts";
import { renderLspMethodResult } from "./render.ts";
import { MAX_POSITION_SYMBOL_LENGTH, type ExternalPositionTarget } from "./positions.ts";
import {
  formatLspToolJson,
  limitLspToolDetails,
  limitLspToolText,
  type LspToolDetailsTruncation,
  type LspToolJsonTruncation,
  type LspToolTruncation,
} from "./tool-output.ts";
import { renderLspToolCall, renderLspToolResult } from "./tool-renderer.ts";
import { isCancellation, throwIfAborted } from "./cancellation.ts";
import { DEFAULT_WORKSPACE_DIAGNOSTIC_FILE_LIMIT, MAX_WORKSPACE_DIAGNOSTIC_FILE_LIMIT, normalizeWorkspaceDiagnosticFileLimit } from "./workspace-diagnostics.ts";
import { processAppliedLspFileMutations, type AppliedLspFileMutation } from "../events/tool-result.ts";
import {
  applyFileRenameWorkspaceEdit,
  applyWorkspaceEdit,
  canResolveCodeActionOnApply,
  dedupeWorkspaceEditFileStates,
  readWorkspaceEditFileState,
  resolveFileRenameOperation,
  sameWorkspaceEditFileState,
  workspaceEditSummary,
  workspaceEditTargetFiles,
  type FileMutationQueue,
  type AppliedWorkspaceEditChange,
  type WorkspaceEditApplyOptions,
  type WorkspaceEditFileState,
  type WorkspaceEditTargetFilesResult,
} from "./workspace-edit.ts";

interface ParsedLspMethod {
  method?: LspMethod;
  error?: string;
}

interface LspToolState {
  nextWorkspaceEditId: number;
  workspaceEdits: Map<string, CachedWorkspaceEdit>;
}

interface CachedWorkspaceEditBase {
  id: string;
  createdAt: number;
  projectRoot: string;
  requestFile: CachedFileState;
  editTargets: CachedFileState[];
  targetResolutionError?: string;
  title: string;
  originMethod: "textDocument/codeAction" | "textDocument/rename" | "workspace/renameFile";
}

type CachedWorkspaceEdit =
  | (CachedWorkspaceEditBase & {
      kind: "codeAction";
      action: Record<string, unknown>;
      preview: CodeActionSummary;
    })
  | (CachedWorkspaceEditBase & {
      kind: "rename";
      edit: unknown;
      preview: WorkspaceEditPreview;
    })
  | (CachedWorkspaceEditBase & {
      kind: "fileRename";
      edit: unknown;
      oldFilePath: string;
      newFilePath: string;
      preview: WorkspaceEditPreview;
    });

type CachedFileState = WorkspaceEditFileState;

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

interface WorkspaceEditPreview {
  id: string;
  kind: "rename" | "fileRename";
  title: string;
  applyable: boolean;
  editSummary: string;
  oldPath?: string;
  newPath?: string;
}

type PreparedCodeActionForApply =
  | { ok: true; action: Record<string, unknown>; title: string }
  | { ok: false; error: string; details: Record<string, unknown>; hint?: string };

type PreparedWorkspaceEditForApply =
  | { ok: true; edit: unknown; source: Record<string, unknown>; title: string; details: Record<string, unknown> }
  | { ok: false; error: string; details: Record<string, unknown>; hint?: string };

interface DiagnosticsToolSnapshot {
  mode: "file" | "workspace";
  target: string;
  snapshot?: DiagnosticSnapshot;
  refresh?: ExplicitDiagnosticRefreshStatus;
  workspaceScan?: WorkspaceDiagnosticScanResult;
}

export function registerLspTool(
  pi: PiApi,
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  formatService: FormatService,
  mutationQueue: FileMutationQueue,
): void {
  const toolState: LspToolState = {
    nextWorkspaceEditId: 1,
    workspaceEdits: new Map(),
  };

  pi.on("tool_result", (event: unknown) => {
    if (!isRecord(event) || event.toolName !== "lsp") return undefined;
    if (isLspErrorDetails(event.details)) return { isError: true };
    return undefined;
  });

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: "LSP-lite language-server tool: real LSP method names where possible, safe file rename transactions, and 1-based positions. Position-scoped methods accept line with either column or exact symbol plus optional occurrence. Formatting is intentionally not part of this tool.",
    promptSnippet: "Inspect LSP status/capabilities, diagnostics, navigation, symbols, and preview-first rename transactions for source files.",
    promptGuidelines: [
      "Use lsp with method=\"server/status\" when language-server feedback seems missing or stale.",
      "Use lsp with real LSP method names such as method=\"textDocument/hover\", method=\"textDocument/definition\", and method=\"workspace/symbol\"; positions use 1-based line plus either column or exact symbol and optional occurrence.",
      "Semantic requests automatically use language-role routes; diagnostics and code actions also use linter-role routes.",
      "Use the optional lsp server parameter to select one configured language server when multiple servers match a file.",
      "Use lsp method=\"textDocument/diagnostic\" with path to refresh one file, or method=\"workspace/diagnostic\" with a project file/directory path for a bounded active scan. Explicit diagnostic calls use a 10-second refresh budget and return only fresh results; timeout, unavailable, or stale cache states are never returned as diagnostics.",
      "Use lsp method=\"textDocument/codeAction\" or method=\"textDocument/rename\" to preview a WorkspaceEdit, then method=\"workspaceEdit/apply\" with its id to apply it safely.",
      "Use lsp method=\"workspace/renameFile\" with path and newPath to preview an LSP-aware file rename, then apply its id with workspaceEdit/apply; file moves are never applied during preview.",
      "Do not use lsp for formatting; formatting is handled by code-feedback's edit pipeline or normal shell/editor tools.",
    ],
    parameters: LspToolParameters,
    renderCall(args, theme) {
      return renderLspToolCall(args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderLspToolResult(result, options, theme, context);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal);
      setProjectRoot(runtime, ctx.cwd);
      configureFeedbackServices(runtime, lspService, formatService);
      const parsed = parseToolMethod(params);
      const method = parsed.method;

      if (!method) {
        return errorResult(undefined, parsed.error ?? "lsp requires method", {
          validMethods: LSP_METHODS,
        });
      }

      if (!runtime.config.enabled && method !== "server/status") {
        return textResult("code-feedback is disabled for this session.", true, statusDetails(runtime, lspService, formatService));
      }

      if (!runtime.config.lsp.enabled && methodRequiresEnabledLsp(method, params)) {
        return textResult("code-feedback LSP clients are disabled for this session. Use /lsp enable to turn them back on.", true, statusDetails(runtime, lspService, formatService));
      }

      if (!runtime.projectTrusted && methodRequiresProjectTrust(method)) {
        return errorResult(method, "Project is not trusted; code-feedback LSP/formatting is paused until project trust is approved.", statusDetails(runtime, lspService, formatService));
      }

      try {
        const server = readServer(params);
        switch (method) {
        case "server/status":
          return textResult(renderStatus(runtime, lspService.getStatus(server), runtime.projectTrusted ? formatService.getStatus() : undefined), false, statusDetails(runtime, lspService, formatService, server));

        case "server/capabilities":
          return textResult(renderCapabilities(runtime, lspService.getStatus(server), await lspService.capabilities(readToolPath(params), signal, server)), false, {
            server,
            clients: lspService.getStatus(server).clients,
            implementedMethods: LSP_METHODS,
          });

        case "textDocument/diagnostic":
        case "workspace/diagnostic":
          return await handleDiagnostics(method, params, runtime, lspService, signal);

        case "server/reload":
          restartLsp(runtime, "lsp tool");
          await lspService.restart(signal);
          return textResult("code-feedback LSP clients restarted and will be relaunched on demand.", false, statusDetails(runtime, lspService, formatService));

        case "textDocument/hover":
          return rawOrPretty(method, params, await lspService.hover(requirePath(params), readPositionTarget(params), signal, server), runtime.projectRoot);

        case "textDocument/definition":
          return rawOrPretty(method, params, await lspService.definition(requirePath(params), readPositionTarget(params), signal, server), runtime.projectRoot);

        case "textDocument/references":
          return rawOrPretty(method, params, await lspService.references(requirePath(params), readPositionTarget(params), signal, server), runtime.projectRoot);

        case "textDocument/implementation":
          return rawOrPretty(method, params, await lspService.implementation(requirePath(params), readPositionTarget(params), signal, server), runtime.projectRoot);

        case "textDocument/typeDefinition":
          return rawOrPretty(method, params, await lspService.typeDefinition(requirePath(params), readPositionTarget(params), signal, server), runtime.projectRoot);

        case "textDocument/documentSymbol":
          return rawOrPretty(method, params, await lspService.documentSymbols(requirePath(params), signal, server), runtime.projectRoot);

        case "workspace/symbol":
          return rawOrPretty(method, params, await lspService.workspaceSymbols(params.query, readToolPath(params), signal, server), runtime.projectRoot);

        case "textDocument/codeAction":
          return await handleCodeActions(method, params, runtime, lspService, toolState, signal);

        case "textDocument/rename":
          return await handleRename(params, runtime, lspService, toolState, signal);

        case "workspace/renameFile":
          return await handleFileRename(params, runtime, lspService, toolState, signal);

        case "workspaceEdit/apply":
          return await handleWorkspaceEditApply(method, params, runtime, lspService, formatService, toolState, mutationQueue, signal);

        }
      } catch (error) {
        if (isCancellation(error, signal)) throw error;
        const message = errorMessage(error);
        const displayMessage = projectRelativeText(message, runtime.projectRoot);
        return errorResult(method, `lsp ${method} failed: ${displayMessage}`, statusDetails(runtime, lspService, formatService), hintForError(message));
      }
    },
  });
}

const LspToolParameters = {
  type: "object",
  additionalProperties: false,
  required: ["method"],
  properties: {
    method: {
      type: "string",
      enum: LSP_METHODS,
      description: "LSP-lite method to run. Uses real LSP method names where possible; positions are still 1-based.",
    },
    path: { type: "string", description: "File path for file-scoped LSP actions, or a project file/directory target for workspace/diagnostic. Required for explicit diagnostic methods." },
    newPath: { type: "string", description: "Destination file path for workspace/renameFile." },
    server: { type: "string", minLength: 1, description: "Configured language-server id. Omit to use all matching servers where the method supports fan-out." },
    limit: { type: "number", minimum: 1, maximum: MAX_WORKSPACE_DIAGNOSTIC_FILE_LIMIT, multipleOf: 1, description: `Maximum files for an active workspace/diagnostic scan (default ${DEFAULT_WORKSPACE_DIAGNOSTIC_FILE_LIMIT}, hard maximum ${MAX_WORKSPACE_DIAGNOSTIC_FILE_LIMIT}).` },
    line: { type: "number", minimum: 1, multipleOf: 1, description: "1-based line for position-scoped LSP actions." },
    column: { type: "number", minimum: 1, multipleOf: 1, description: "1-based column for position-scoped LSP actions. Mutually exclusive with symbol." },
    symbol: { type: "string", minLength: 1, maxLength: MAX_POSITION_SYMBOL_LENGTH, description: "Exact case-sensitive symbol text on line. Mutually exclusive with column." },
    occurrence: { type: "number", minimum: 1, multipleOf: 1, description: "1-based occurrence of symbol on line (default 1)." },
    query: { type: "string", description: "Search query for workspace/symbol." },
    id: { type: "string", description: "Stable id returned by a WorkspaceEdit or file-rename preview; required for workspaceEdit/apply." },
    newName: { type: "string", description: "New symbol name for rename." },
    raw: { type: "boolean", description: "Return raw LSP-ish payloads when useful for debugging." },
  },
} satisfies Record<string, unknown>;

function parseMethod(value: unknown): LspMethod | undefined {
  return typeof value === "string" && (LSP_METHODS as readonly string[]).includes(value) ? (value as LspMethod) : undefined;
}

function parseToolMethod(params: Record<string, unknown>): ParsedLspMethod {
  const method = parseMethod(params.method);
  if (method) return { method };
  if (params.method !== undefined) {
    return { error: `Unknown lsp method: ${String(params.method)}` };
  }

  return { error: "lsp requires method. Example: method=\"server/status\" or method=\"textDocument/hover\"." };
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

async function handleDiagnostics(
  method: LspMethod,
  params: Record<string, unknown>,
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  signal?: AbortSignal,
): Promise<PiToolResult> {
  const diagnostics = await diagnosticsSnapshot(method, params, runtime, lspService, signal);
  const server = readServer(params);
  const workspaceScan = diagnostics.workspaceScan;
  if (diagnostics.mode === "file" && diagnostics.refresh?.outcome !== "fresh") {
    return explicitDiagnosticFailure(method, diagnostics, server);
  }
  if (!diagnostics.snapshot) {
    return explicitDiagnosticFailure(method, {
      ...diagnostics,
      refresh: diagnostics.refresh ?? { outcome: "unavailable" },
    }, server);
  }
  const workspaceScanDetails = workspaceScan ? {
    ...workspaceScan.summary,
    targetPath: displayPathFromRoot(workspaceScan.summary.targetPath, runtime.projectRoot),
    files: workspaceScan.files.map((file) => ({
      ...file,
      filePath: displayPathFromRoot(file.filePath, runtime.projectRoot),
    })),
  } : undefined;
  const hint = workspaceDiagnosticHint(diagnostics);

  return textResult(renderDiagnosticsStatus(runtime, diagnostics.target, diagnostics.snapshot, workspaceScan, diagnostics.refresh), false, {
    ok: true,
    method,
    implemented: true,
    mode: diagnostics.mode,
    server,
    authoritative: diagnosticsAreAuthoritative(diagnostics),
    diagnosticRefresh: diagnostics.refresh,
    freshDiagnosticsOnly: true,
    workspaceScan: workspaceScanDetails,
    hint,
    recentTouchedRanges: runtime.completedEdits.slice(-5).map((edit) => ({
      filePath: edit.filePath,
      toolName: edit.toolName,
      touchedRanges: edit.touchedRanges,
      rangeComputation: edit.rangeComputation,
      diagnosticFilter: edit.diagnosticFilter?.summary,
      workspaceDelta: edit.workspaceDelta?.summary,
    })),
  });
}

function workspaceDiagnosticHint(diagnostics: DiagnosticsToolSnapshot): string {
  if (diagnostics.mode === "file") return "The displayed diagnostics are fresh for the current file content.";
  const summary = diagnostics.workspaceScan?.summary;
  if (!summary) return "Pass path for an active workspace diagnostic scan.";
  if (summary.fileLimitReached || summary.entryLimitReached) {
    return `The active scan was bounded or incomplete. Narrow path or raise limit up to ${MAX_WORKSPACE_DIAGNOSTIC_FILE_LIMIT}; ignored directories and symlinks remain excluded.`;
  }
  if (!summary.traversalComplete) {
    return "Workspace traversal encountered unreadable directories. Narrow the target or check project permissions before retrying.";
  }
  if (!summary.complete) {
    return "Only fresh diagnostics are shown. Some selected files were not refreshed; inspect timeout/unavailable/skipped counts and server/status, then retry or narrow the target.";
  }
  return "All displayed diagnostics are fresh for this completed scan.";
}

function explicitDiagnosticFailure(method: LspMethod, diagnostics: DiagnosticsToolSnapshot, server: string | undefined): PiToolResult {
  const refresh = diagnostics.refresh ?? { outcome: "unavailable" };
  const duration = refresh.durationMs === undefined ? "" : ` after ${Math.max(0, Math.round(refresh.durationMs))}ms`;
  const state = refresh.outcome === "timed-out" ? `timed out${duration}` : "was unavailable";
  const error = `lsp ${method} ${diagnostics.target} ${state}; no diagnostics returned.`;
  const hint = "Inspect server/status and retry. Explicit diagnostic calls never substitute cached or stale diagnostics.";
  return textResult([error, `hint: ${hint}`].join("\n"), true, {
    ok: false,
    method,
    error,
    hint,
    mode: diagnostics.mode,
    server,
    authoritative: false,
    diagnosticsReturned: false,
    diagnosticRefresh: refresh,
  });
}

async function diagnosticsSnapshot(
  method: LspMethod,
  params: Record<string, unknown>,
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  signal?: AbortSignal,
): Promise<DiagnosticsToolSnapshot> {
  const server = readServer(params);
  if (method === "workspace/diagnostic") {
    const target = readToolPath(params);
    if (!target) throw new Error("workspace/diagnostic requires path for an active fresh scan");
    const workspaceScan = await lspService.diagnosticsForWorkspace(target, {
      limit: readWorkspaceDiagnosticLimit(params),
      timeoutMs: EXPLICIT_LSP_DIAGNOSTIC_TIMEOUT_MS,
      settleMs: 100,
      server,
      signal,
    });
    return {
      mode: "workspace",
      target: displayPathFromRoot(workspaceScan.summary.targetPath, runtime.projectRoot),
      snapshot: workspaceScan.snapshot,
      workspaceScan,
    };
  }
  const filePath = requirePath(params);
  const refresh = await lspService.diagnosticsForFileDetailed(filePath, undefined, {
    timeoutMs: EXPLICIT_LSP_DIAGNOSTIC_TIMEOUT_MS,
    settleMs: 100,
    snapshotScope: "file",
    forceFresh: true,
    server,
    signal,
  });
  if (refresh) {
    return {
      mode: "file",
      target: filePath,
      ...(refresh.fresh ? { snapshot: refresh.snapshot } : {}),
      refresh: explicitDiagnosticRefreshStatus(refresh),
    };
  }
  return {
    mode: "file",
    target: filePath,
    refresh: { outcome: "unavailable" },
  };
}

function explicitDiagnosticRefreshStatus(refresh: DiagnosticRefreshResult): ExplicitDiagnosticRefreshStatus {
  return {
    outcome: refresh.fresh ? "fresh" : refresh.timedOut ? "timed-out" : "unavailable",
    durationMs: Math.max(0, refresh.completedAt - refresh.requestedAt),
  };
}

function diagnosticsAreAuthoritative(diagnostics: DiagnosticsToolSnapshot): boolean {
  if (diagnostics.mode === "file") return diagnostics.refresh?.outcome === "fresh";
  return diagnostics.workspaceScan?.summary.complete === true;
}

function statusDetails(runtime: CodeFeedbackRuntime, lspService: LspService, formatService: FormatService, server?: string): Record<string, unknown> {
  const serviceStatus = lspService.getStatus(server);
  return {
    enabled: runtime.config.enabled,
    lspEnabled: runtime.config.lsp.enabled,
    diagnosticRefreshConcurrency: runtime.config.lsp.diagnosticRefreshConcurrency,
    diagnosticRefreshes: serviceStatus.diagnosticRefreshes,
    clientResources: serviceStatus.clientResources,
    autoFormat: runtime.config.autoFormat,
    contextInjection: runtime.config.contextInjection,
    strict: runtime.config.strict,
    projectTrusted: runtime.projectTrusted,
    projectRoot: runtime.projectRoot,
    server,
    serverConfiguration: serviceStatus.serverConfiguration,
    clientSummary: serviceStatus.clients.length === 0 ? "none yet — starts lazily when you query a source file" : `${serviceStatus.clients.length} client(s)`,
    clients: serviceStatus.clients,
    unavailableServers: serviceStatus.unavailableServers,
    restartCount: runtime.lspRestartCount,
    lastRestartAt: runtime.lastLspRestartAt,
    capturedEdits: runtime.completedEdits.length,
    pendingEdits: runtime.pendingEdits.size,
    delayedFeedback: runtime.delayedFeedback.length,
    format: runtime.projectTrusted ? formatService.getStatus() : undefined,
  };
}

function readPositionTarget(params: Record<string, unknown>): ExternalPositionTarget {
  return {
    line: params.line,
    column: params.column,
    symbol: params.symbol,
    occurrence: params.occurrence,
  };
}

function readServer(params: Record<string, unknown>): string | undefined {
  if (params.server === undefined) return undefined;
  if (typeof params.server !== "string" || params.server.trim().length === 0) {
    throw new Error("lsp server must be a non-empty configured server id");
  }
  if (params.server !== params.server.trim()) throw new Error("lsp server must not contain surrounding whitespace");
  return params.server;
}

function readWorkspaceDiagnosticLimit(params: Record<string, unknown>): number {
  return params.limit === undefined
    ? DEFAULT_WORKSPACE_DIAGNOSTIC_FILE_LIMIT
    : normalizeWorkspaceDiagnosticFileLimit(params.limit);
}

function methodRequiresEnabledLsp(method: LspMethod, params: Record<string, unknown>): boolean {
  switch (method) {
    case "server/status":
    case "server/reload":
      return false;
    case "textDocument/diagnostic":
    case "workspace/diagnostic":
      return true;
    case "server/capabilities":
      return readToolPath(params) !== undefined;
    default:
      return true;
  }
}

function methodRequiresProjectTrust(method: LspMethod): boolean {
  return method !== "server/status";
}

function requirePath(params: Record<string, unknown>): string {
  const filePath = readToolPath(params);
  if (!filePath) throw new Error("lsp method requires path");
  return filePath;
}

function requireNewPath(params: Record<string, unknown>): string {
  if (typeof params.newPath !== "string" || params.newPath.length === 0) {
    throw new Error("workspace/renameFile requires newPath");
  }
  const normalized = normalizeToolPath(params.newPath);
  if (normalized.length === 0) throw new Error("workspace/renameFile requires newPath");
  return normalized;
}

function rawOrPretty(method: LspMethod, params: Record<string, unknown>, result: unknown, projectRoot: string): PiToolResult {
  const raw = params.raw === true;
  const rendered = raw
    ? formatLspToolJson(result)
    : { text: renderLspMethodResult(method, result, projectRoot) };
  const limited = limitLspToolText(rendered.text);
  return {
    content: [{ type: "text", text: limited.text }],
    details: withTruncationDetails({
      ok: true,
      method,
      raw,
      server: readServer(params),
      ...(rendered.truncation ? { visibleJsonTruncation: rendered.truncation } : {}),
      result,
    }, limited.truncation),
  };
}

async function handleCodeActions(
  method: LspMethod,
  params: Record<string, unknown>,
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  state: LspToolState,
  signal?: AbortSignal,
): Promise<PiToolResult> {
  throwIfAborted(signal);
  const filePath = requirePath(params);
  const requestFileStateBefore = readWorkspaceEditFileState(path.resolve(runtime.projectRoot, filePath));
  const target = readPositionTarget(params);
  const server = readServer(params);
  const result = await lspService.codeActions(filePath, target, signal, server);
  throwIfAborted(signal);
  const requestFileStateAfter = readWorkspaceEditFileState(path.resolve(runtime.projectRoot, filePath));
  if (!sameWorkspaceEditFileState(requestFileStateBefore, requestFileStateAfter)) {
    return errorResult(method, `File changed while collecting code actions: ${displayPathFromRoot(requestFileStateAfter.filePath, runtime.projectRoot)}`, {
      before: displayFileState(runtime.projectRoot, requestFileStateBefore),
      after: displayFileState(runtime.projectRoot, requestFileStateAfter),
    }, "Rerun textDocument/codeAction so returned ids match the current file contents.");
  }
  if (params.raw === true) return rawOrPretty(method, params, result, runtime.projectRoot);

  const actions = Array.isArray(result) ? result.filter(isRecord) : [];
  const summaries = actions.map((action) => cacheCodeAction(state, runtime.projectRoot, action, requestFileStateAfter));
  return structuredResult({
    ok: true,
    method,
    path: filePath,
    server,
    line: typeof params.line === "number" ? params.line : undefined,
    column: typeof params.column === "number" ? params.column : undefined,
    symbol: typeof params.symbol === "string" ? params.symbol : undefined,
    occurrence: typeof params.occurrence === "number" ? params.occurrence : undefined,
    actions: summaries,
    hint: summaries.some((action) => action.applyable)
      ? "Apply one with method=\"workspaceEdit/apply\" and id."
      : undefined,
  }, {
    ok: true,
    method,
    server,
    actions: summaries,
    result,
  });
}

async function handleWorkspaceEditApply(
  method: LspMethod,
  params: Record<string, unknown>,
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  formatService: FormatService,
  state: LspToolState,
  mutationQueue: FileMutationQueue,
  signal?: AbortSignal,
): Promise<PiToolResult> {
  throwIfAborted(signal);
  const pendingGuard = rejectApplyDuringPendingEdits(runtime, "WorkspaceEdit");
  if (pendingGuard) return pendingGuard;

  const id = typeof params.id === "string" ? params.id.trim() : "";
  if (!id) return errorResult(method, "workspaceEdit/apply requires id", { cachedIds: [...state.workspaceEdits.keys()].slice(-20) }, "Preview a rename, file rename, or code action first and pass its returned id.");

  const cached = state.workspaceEdits.get(id);
  if (!cached) return errorResult(method, `Unknown WorkspaceEdit id: ${id}`, { cachedIds: [...state.workspaceEdits.keys()].slice(-20) }, "Preview the rename or code action again; WorkspaceEdit ids are session-local and bounded.");
  state.workspaceEdits.delete(id);
  if (path.resolve(cached.projectRoot) !== path.resolve(runtime.projectRoot)) {
    return errorResult(method, `WorkspaceEdit id ${id} belongs to a different project root`, { id, editProjectRoot: cached.projectRoot, projectRoot: runtime.projectRoot });
  }

  const stale = validateCachedWorkspaceEdit(cached, runtime.projectRoot);
  if (stale) {
    return errorResult(method, `WorkspaceEdit id ${id} is stale: ${stale.reason}`, {
      id,
      preview: cached.preview,
      stale,
    }, `Call ${cached.originMethod} again and apply the fresh id.`);
  }

  const prepared = await prepareCachedWorkspaceEdit(cached, runtime, lspService, signal);
  if (!prepared.ok) {
    return errorResult(method, prepared.error, {
      id,
      preview: cached.preview,
      targetResolutionError: cached.targetResolutionError,
      ...prepared.details,
    }, prepared.hint);
  }

  const feedbackStartedAt = Date.now();
  const targetFiles = workspaceEditTargetFiles(prepared.edit, runtime.projectRoot);
  const beforeDiagnostics = new Map<string, DiagnosticSnapshot | undefined>();
  const beforeSnapshotScope = runtime.config.diagnostics.inline === "all" || runtime.config.diagnostics.includeCrossFileRelated
    ? "workspace"
    : "file";
  if (targetFiles.ok) {
    for (const filePath of targetFiles.files) {
      beforeDiagnostics.set(path.resolve(filePath), lspService.cachedDiagnosticsIfKnown(filePath, undefined, beforeSnapshotScope));
    }
  }
  if (cached.kind === "fileRename") {
    beforeDiagnostics.set(path.resolve(cached.oldFilePath), lspService.cachedDiagnosticsIfKnown(cached.oldFilePath, undefined, beforeSnapshotScope));
  }
  const appliedChanges: AppliedWorkspaceEditChange[] = [];
  const applyOptions = {
    ...workspaceEditApplyOptions(
      prepared.edit,
      prepared.source,
      [cached.requestFile, ...cached.editTargets],
      runtime,
      lspService,
      mutationQueue,
      signal,
    ),
    captureAppliedChanges: appliedChanges,
  };
  const applyResult = cached.kind === "fileRename"
    ? await applyFileRenameWorkspaceEdit(
        prepared.edit,
        runtime.projectRoot,
        { oldFilePath: cached.oldFilePath, newFilePath: cached.newFilePath },
        applyOptions,
      )
    : await applyWorkspaceEdit(prepared.edit, runtime.projectRoot, applyOptions);

  const payload = {
    ok: applyResult.applied,
    method,
    id,
    kind: cached.kind,
    title: prepared.title,
    applied: applyResult.applied,
    editCount: applyResult.editCount,
    changedFiles: applyResult.changedFiles.map((filePath) => displayPathFromRoot(filePath, runtime.projectRoot)),
    renamedFile: applyResult.fileRename ? {
      oldPath: displayPathFromRoot(applyResult.fileRename.oldFilePath, runtime.projectRoot),
      newPath: displayPathFromRoot(applyResult.fileRename.newFilePath, runtime.projectRoot),
    } : undefined,
    rejected: applyResult.rejected,
  };
  const result = structuredResult(payload, {
    ...payload,
    ...prepared.details,
    applyResult,
  }, !applyResult.applied);
  if (!applyResult.applied || appliedChanges.length === 0) return result;

  const mutations: AppliedLspFileMutation[] = appliedChanges.map((change, index) => ({
    id: `${id}:${index + 1}`,
    filePath: change.filePath,
    originalPath: change.originalFilePath,
    beforeContent: change.beforeContent,
    afterAgentContent: change.afterContent,
    beforeDiagnostics: beforeDiagnostics.get(path.resolve(change.originalFilePath ?? change.filePath)),
    startedAt: feedbackStartedAt,
  }));
  try {
    return await processAppliedLspFileMutations(result, mutations, runtime, lspService, formatService, signal);
  } catch (error) {
    const message = errorMessage(error);
    runtime.lastError = message;
    return {
      ...result,
      details: isRecord(result.details)
        ? { ...result.details, codeFeedbackError: projectRelativeText(message, runtime.projectRoot) }
        : result.details,
    };
  }
}

async function handleRename(
  params: Record<string, unknown>,
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  state: LspToolState,
  signal?: AbortSignal,
): Promise<PiToolResult> {
  throwIfAborted(signal);
  const requestPath = requirePath(params);
  const requestFileBefore = readWorkspaceEditFileState(path.resolve(runtime.projectRoot, requestPath));
  const server = readServer(params);
  const result = await lspService.rename(requestPath, readPositionTarget(params), params.newName, signal, server);
  throwIfAborted(signal);
  const requestFileAfter = readWorkspaceEditFileState(path.resolve(runtime.projectRoot, requestPath));
  if (!sameWorkspaceEditFileState(requestFileBefore, requestFileAfter)) {
    return errorResult("textDocument/rename", `File changed while collecting rename edits: ${displayPathFromRoot(requestFileAfter.filePath, runtime.projectRoot)}`, {
      before: displayFileState(runtime.projectRoot, requestFileBefore),
      after: displayFileState(runtime.projectRoot, requestFileAfter),
    }, "Rerun textDocument/rename against the current file contents.");
  }
  if (params.raw === true) return rawOrPretty("textDocument/rename", params, result, runtime.projectRoot);

  const preview = cacheRename(state, runtime.projectRoot, result, requestFileAfter, String(params.newName));
  return structuredResult({
    ok: true,
    method: "textDocument/rename",
    path: requestPath,
    server,
    line: typeof params.line === "number" ? params.line : undefined,
    column: typeof params.column === "number" ? params.column : undefined,
    symbol: typeof params.symbol === "string" ? params.symbol : undefined,
    occurrence: typeof params.occurrence === "number" ? params.occurrence : undefined,
    newName: String(params.newName),
    workspaceEdit: preview,
    hint: preview.applyable ? "Apply with method=\"workspaceEdit/apply\" and id." : undefined,
  }, {
    ok: true,
    method: "textDocument/rename",
    server,
    workspaceEdit: preview,
    result,
  });
}

async function handleFileRename(
  params: Record<string, unknown>,
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  state: LspToolState,
  signal?: AbortSignal,
): Promise<PiToolResult> {
  throwIfAborted(signal);
  const requestPath = requirePath(params);
  const requestedNewPath = requireNewPath(params);
  const resolved = resolveFileRenameOperation(requestPath, requestedNewPath, runtime.projectRoot);
  if (!resolved.ok) return errorResult("workspace/renameFile", projectRelativeText(resolved.reason, runtime.projectRoot), {
    path: requestPath,
    newPath: requestedNewPath,
  }, hintForError(resolved.reason));

  const sourceBefore = readWorkspaceEditFileState(resolved.oldFilePath);
  const destinationBefore = readWorkspaceEditFileState(resolved.newFilePath);
  const server = readServer(params);
  const result = await lspService.prepareFileRename(
    resolved.oldFilePath,
    resolved.newFilePath,
    signal,
    server,
  );
  throwIfAborted(signal);

  const sourceAfter = readWorkspaceEditFileState(resolved.oldFilePath);
  const destinationAfter = readWorkspaceEditFileState(resolved.newFilePath);
  if (!sameWorkspaceEditFileState(sourceBefore, sourceAfter) || !sameWorkspaceEditFileState(destinationBefore, destinationAfter)) {
    return errorResult("workspace/renameFile", "File state changed while collecting workspace/willRenameFiles edits", {
      source: {
        before: displayFileState(runtime.projectRoot, sourceBefore),
        after: displayFileState(runtime.projectRoot, sourceAfter),
      },
      destination: {
        before: displayFileState(runtime.projectRoot, destinationBefore),
        after: displayFileState(runtime.projectRoot, destinationAfter),
      },
    }, "Rerun workspace/renameFile so the preview matches the current source and destination.");
  }

  if (params.raw === true) return rawOrPretty("workspace/renameFile", params, result, runtime.projectRoot);

  const preview = cacheFileRename(
    state,
    runtime.projectRoot,
    result,
    sourceAfter,
    destinationAfter,
    resolved.oldFilePath,
    resolved.newFilePath,
    lspService,
  );
  return structuredResult({
    ok: true,
    method: "workspace/renameFile",
    path: displayPathFromRoot(resolved.oldFilePath, runtime.projectRoot),
    newPath: displayPathFromRoot(resolved.newFilePath, runtime.projectRoot),
    server,
    workspaceEdit: preview,
    hint: preview.applyable ? "Apply with method=\"workspaceEdit/apply\" and id." : undefined,
  }, {
    ok: true,
    method: "workspace/renameFile",
    server,
    workspaceEdit: preview,
    result,
  });
}

function cacheCodeAction(
  state: LspToolState,
  projectRoot: string,
  action: Record<string, unknown>,
  requestFile: CachedFileState,
): CodeActionSummary {
  pruneWorkspaceEditCache(state);
  const id = nextWorkspaceEditId(state);
  const targetFiles = action.edit === undefined ? undefined : workspaceEditTargetFiles(action.edit, projectRoot);
  const summary = summarizeCodeAction(id, action, targetFiles);
  state.workspaceEdits.set(id, {
    id,
    createdAt: Date.now(),
    projectRoot,
    requestFile,
    editTargets: targetFiles?.ok ? targetFiles.files.map((filePath) => readEditTargetFileState(filePath, requestFile)) : [],
    targetResolutionError: targetFiles && !targetFiles.ok ? targetFiles.reason : undefined,
    title: summary.title,
    originMethod: "textDocument/codeAction",
    kind: "codeAction",
    action,
    preview: summary,
  });
  return summary;
}

function cacheRename(
  state: LspToolState,
  projectRoot: string,
  edit: unknown,
  requestFile: CachedFileState,
  newName: string,
): WorkspaceEditPreview {
  pruneWorkspaceEditCache(state);
  const id = nextWorkspaceEditId(state);
  const targetFiles = workspaceEditTargetFiles(edit, projectRoot);
  const summary = workspaceEditSummary(edit);
  const preview: WorkspaceEditPreview = {
    id,
    kind: "rename",
    title: `rename → ${newName}`,
    applyable: targetFiles.ok && summary.edits > 0 && summary.resourceOperations === 0,
    editSummary: formatWorkspaceEditSummary(summary),
  };
  state.workspaceEdits.set(id, {
    id,
    createdAt: Date.now(),
    projectRoot,
    requestFile,
    editTargets: targetFiles.ok ? targetFiles.files.map((filePath) => readEditTargetFileState(filePath, requestFile)) : [],
    targetResolutionError: targetFiles.ok ? undefined : targetFiles.reason,
    title: preview.title,
    originMethod: "textDocument/rename",
    kind: "rename",
    edit,
    preview,
  });
  return preview;
}

function cacheFileRename(
  state: LspToolState,
  projectRoot: string,
  edit: unknown,
  sourceFile: CachedFileState,
  destinationFile: CachedFileState,
  oldFilePath: string,
  newFilePath: string,
  lspService: LspService,
): WorkspaceEditPreview {
  pruneWorkspaceEditCache(state);
  const id = nextWorkspaceEditId(state);
  const targetFiles = workspaceEditTargetFiles(edit, projectRoot);
  const summary = workspaceEditSummary(edit);
  const source = isRecord(edit) ? edit : {};
  const serverId = typeof source[LSP_RESULT_SERVER_ID_KEY] === "string" ? source[LSP_RESULT_SERVER_ID_KEY] : undefined;
  const serverSessionId = typeof source[LSP_RESULT_SERVER_SESSION_ID_KEY] === "string" ? source[LSP_RESULT_SERVER_SESSION_ID_KEY] : undefined;
  const liveSourceSession = serverId !== undefined && serverSessionId !== undefined &&
    lspService.documentVersion(oldFilePath, serverId, serverSessionId) !== undefined;
  const oldPath = displayPathFromRoot(oldFilePath, projectRoot);
  const newPath = displayPathFromRoot(newFilePath, projectRoot);
  const preview: WorkspaceEditPreview = {
    id,
    kind: "fileRename",
    title: `rename file ${oldPath} → ${newPath}`,
    applyable: targetFiles.ok && summary.resourceOperations === 0 && liveSourceSession,
    editSummary: formatWorkspaceEditSummary(summary),
    oldPath,
    newPath,
  };
  state.workspaceEdits.set(id, {
    id,
    createdAt: Date.now(),
    projectRoot,
    requestFile: sourceFile,
    editTargets: [
      ...(targetFiles.ok ? targetFiles.files.map((filePath) => readEditTargetFileState(filePath, sourceFile)) : []),
      destinationFile,
    ],
    targetResolutionError: targetFiles.ok ? undefined : targetFiles.reason,
    title: preview.title,
    originMethod: "workspace/renameFile",
    kind: "fileRename",
    edit,
    oldFilePath,
    newFilePath,
    preview,
  });
  return preview;
}

function nextWorkspaceEditId(state: LspToolState): string {
  return `we_${(state.nextWorkspaceEditId++).toString(36).padStart(4, "0")}`;
}

function pruneWorkspaceEditCache(state: LspToolState): void {
  const maxEntries = 200;
  if (state.workspaceEdits.size < maxEntries) return;
  const stale = [...state.workspaceEdits.values()]
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(0, Math.max(1, state.workspaceEdits.size - maxEntries + 1));
  for (const entry of stale) state.workspaceEdits.delete(entry.id);
}

async function prepareCachedWorkspaceEdit(
  cached: CachedWorkspaceEdit,
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  signal?: AbortSignal,
): Promise<PreparedWorkspaceEditForApply> {
  if (cached.kind === "codeAction") {
    const prepared = await prepareCodeActionForApply(cached.action, cached.requestFile.filePath, runtime, lspService, `WorkspaceEdit id ${cached.id}`, signal);
    if (!prepared.ok) return prepared;
    return {
      ok: true,
      edit: prepared.action.edit,
      source: prepared.action,
      title: prepared.title,
      details: { action: prepared.action },
    };
  }

  const targetFiles = workspaceEditTargetFiles(cached.edit, runtime.projectRoot);
  const summary = workspaceEditSummary(cached.edit);
  const fileRename = cached.kind === "fileRename";
  if (!targetFiles.ok || (!fileRename && summary.edits === 0) || summary.resourceOperations !== 0) {
    return {
      ok: false,
      error: `WorkspaceEdit id ${cached.id} is not safely applyable`,
      details: {
        workspaceEdit: cached.preview,
        targetResolutionError: targetFiles.ok ? undefined : targetFiles.reason,
        editSummary: summary,
      },
      hint: `Call ${cached.originMethod} again to obtain a fresh, safe WorkspaceEdit preview.`,
    };
  }

  if (fileRename) {
    const source = isRecord(cached.edit) ? cached.edit : {};
    const serverId = typeof source[LSP_RESULT_SERVER_ID_KEY] === "string" ? source[LSP_RESULT_SERVER_ID_KEY] : undefined;
    const serverSessionId = typeof source[LSP_RESULT_SERVER_SESSION_ID_KEY] === "string" ? source[LSP_RESULT_SERVER_SESSION_ID_KEY] : undefined;
    if (!serverId || !serverSessionId || lspService.documentVersion(cached.oldFilePath, serverId, serverSessionId) === undefined) {
      return {
        ok: false,
        error: `WorkspaceEdit id ${cached.id} is stale: source language-server session is no longer live`,
        details: { workspaceEdit: cached.preview, serverId, serverSessionId },
        hint: "Call workspace/renameFile again so the server can recompute import and reference edits.",
      };
    }
    const resolved = resolveFileRenameOperation(cached.oldFilePath, cached.newFilePath, runtime.projectRoot);
    if (!resolved.ok) {
      return {
        ok: false,
        error: `WorkspaceEdit id ${cached.id} is stale: ${resolved.reason}`,
        details: { workspaceEdit: cached.preview },
        hint: "Call workspace/renameFile again after fixing the source or destination path.",
      };
    }
  }

  return {
    ok: true,
    edit: cached.edit,
    source: isRecord(cached.edit) ? cached.edit : {},
    title: cached.title,
    details: { workspaceEdit: cached.edit },
  };
}

async function prepareCodeActionForApply(
  action: Record<string, unknown>,
  requestFilePath: string,
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  label: string,
  signal?: AbortSignal,
): Promise<PreparedCodeActionForApply> {
  throwIfAborted(signal);
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
      const resolved = await lspService.resolveCodeAction(requestFilePath, action, signal);
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
      if (isCancellation(error, signal)) throw error;
      return {
        ok: false,
        error: `${label} could not be resolved: ${errorMessage(error)}`,
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

function validateCachedWorkspaceEdit(cached: CachedWorkspaceEdit, projectRoot: string): { reason: string; files?: Array<{ before: Record<string, unknown>; after: Record<string, unknown> }> } | undefined {
  const changedFiles: Array<{ before: Record<string, unknown>; after: Record<string, unknown> }> = [];
  for (const expected of dedupeWorkspaceEditFileStates([cached.requestFile, ...cached.editTargets])) {
    const current = readWorkspaceEditFileState(expected.filePath);
    if (sameWorkspaceEditFileState(expected, current)) continue;
    changedFiles.push({
      before: displayFileState(projectRoot, expected),
      after: displayFileState(projectRoot, current),
    });
  }

  if (changedFiles.length === 0) return undefined;
  return {
    reason: `file state changed since ${cached.originMethod}: ${changedFiles.map((entry) => String(entry.after.path)).join(", ")}`,
    files: changedFiles,
  };
}

function workspaceEditApplyOptions(
  edit: unknown,
  source: Record<string, unknown>,
  expected: CachedFileState[],
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  mutationQueue: FileMutationQueue,
  signal?: AbortSignal,
): WorkspaceEditApplyOptions {
  const targetFiles = workspaceEditTargetFiles(edit, runtime.projectRoot);
  const expectedByPath = new Map<string, CachedFileState>();
  for (const state of expected) expectedByPath.set(path.resolve(state.filePath), state);
  if (targetFiles.ok) {
    for (const filePath of targetFiles.files) {
      const resolved = path.resolve(filePath);
      if (!expectedByPath.has(resolved)) expectedByPath.set(resolved, readWorkspaceEditFileState(resolved));
    }
  }

  const serverId = typeof source[LSP_RESULT_SERVER_ID_KEY] === "string" ? source[LSP_RESULT_SERVER_ID_KEY] : undefined;
  const serverSessionId = typeof source[LSP_RESULT_SERVER_SESSION_ID_KEY] === "string" ? source[LSP_RESULT_SERVER_SESSION_ID_KEY] : undefined;
  return {
    expectedFileStates: [...expectedByPath.values()],
    getDocumentVersion: (filePath) => lspService.documentVersion(filePath, serverId, serverSessionId),
    mutationQueue,
    signal,
  };
}

function readEditTargetFileState(filePath: string, requestFile: CachedFileState): CachedFileState {
  return path.resolve(filePath) === path.resolve(requestFile.filePath) ? requestFile : readWorkspaceEditFileState(filePath);
}

function displayFileState(projectRoot: string, state: CachedFileState): Record<string, unknown> {
  return {
    path: displayPathFromRoot(state.filePath, projectRoot),
    exists: state.exists,
    bytes: state.bytes,
    sha256: state.sha256 ? state.sha256.slice(0, 12) : undefined,
    mode: state.mode === undefined ? undefined : state.mode.toString(8).padStart(3, "0"),
  };
}

function rejectApplyDuringPendingEdits(runtime: CodeFeedbackRuntime, label: string): PiToolResult | undefined {
  if (runtime.pendingEdits.size === 0) return undefined;
  return textResult(
    `Refusing to apply ${label} while ${runtime.pendingEdits.size} other file edit${runtime.pendingEdits.size === 1 ? " is" : "s are"} still pending in this tool batch. Retry after the edit tools finish.`,
    true,
    { pendingEdits: runtime.pendingEdits.size },
  );
}

function hintForError(message: string): string | undefined {
  if (/requires 1-based line and character|requires 1-based line and column|accepts either column or symbol|requires symbol (?:when occurrence|to be)|requires occurrence to be/i.test(message)) {
    return "Pass a 1-based line with either a 1-based column or exact symbol; occurrence is 1-based and only valid with symbol.";
  }
  if (/cannot (?:find|resolve) (?:occurrence .* of exact )?symbol|cannot find exact symbol/i.test(message)) {
    return "Check the exact case-sensitive symbol text, line, and 1-based occurrence.";
  }
  if (/workspace\/diagnostic requires path/i.test(message)) return "Pass path=\".\" or a project file/directory for an active fresh scan.";
  if (/requires path/i.test(message)) return "Pass path for textDocument methods.";
  if (/workspace\/renameFile requires newPath/i.test(message)) return "Pass newPath for the destination file inside the trusted project root.";
  if (/File rename (?:source|destination).*outside project root/i.test(message)) return "Choose source and destination files inside the trusted project root.";
  if (/File rename destination already exists/i.test(message)) return "Choose a destination path that does not exist; safe file renames never overwrite files.";
  if (/File rename source (?:does not exist|is not a regular file|must not be a symbolic link)/i.test(message)) return "Choose an existing regular source file; directory and symlink renames are intentionally unsupported.";
  if (/Multiple language servers support/i.test(message)) return "Pass server with one of the matching configured language-server ids.";
  if (/Unknown language server/i.test(message)) return "Use method=\"server/status\" without server to inspect loaded configuration and active clients.";
  if (/Language server .* (?:is unavailable|is disabled|does not support)/i.test(message)) return "Check method=\"server/status\", the route extensions, and the configured command.";
  if (/Workspace diagnostic target .*outside the project root/i.test(message)) return "Choose a file or directory inside the trusted project root.";
  if (/Workspace diagnostic target .*symbolic link/i.test(message)) return "Scan the real project directory instead; active workspace scans do not follow symlinks.";
  if (/Cannot (?:inspect|resolve) workspace diagnostic target/i.test(message)) return "Check that the active-scan path exists inside the project root.";
  if (/Workspace diagnostic target is inside an ignored directory/i.test(message)) return "Choose a source directory outside dependency, cache, virtual-environment, and build output trees.";
  if (/workspace diagnostic file limit/i.test(message)) return `Pass limit as an integer from 1 to ${MAX_WORKSPACE_DIAGNOSTIC_FILE_LIMIT}.`;
  if (/LSP source file is too large/i.test(message)) return "Use a smaller source file or exclude generated output from explicit LSP requests.";
  if (/Cannot read file for LSP request/i.test(message)) return "Check that the path exists and rerun the request against a current file.";
  if (/No language server configured/i.test(message)) return "No configured language server matched this file. Check file extension, config, and installed server commands.";
  if (/No active LSP client|No LSP client available/i.test(message)) return "Pass path to a source file to choose and lazily start a language server.";
  return undefined;
}
