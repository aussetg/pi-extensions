import * as path from "node:path";
import { renderCapabilities, renderDiagnosticsStatus, renderStatus } from "../render.ts";
import type { FormatService } from "../format/service.ts";
import type { LspService } from "./service.ts";
import { displayPathFromRoot, normalizeToolPath } from "../paths.ts";
import { restartLsp, setProjectRoot, setProjectTrust, type CodeFeedbackRuntime } from "../runtime.ts";
import { LSP_METHODS, LSP_RESULT_SERVER_ID_KEY, LSP_RESULT_SERVER_SESSION_ID_KEY, type DiagnosticSnapshot, type LspMethod } from "../types.ts";
import type { PiApi, PiToolResult } from "../pi.ts";
import { renderLspMethodResult } from "./render.ts";
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
import { processAppliedLspFileMutations, type AppliedLspFileMutation } from "../events/tool-result.ts";
import {
  applyWorkspaceEdit,
  canResolveCodeActionOnApply,
  readWorkspaceEditFileState,
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
  originMethod: "textDocument/codeAction" | "textDocument/rename";
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
  kind: "rename";
  title: string;
  applyable: boolean;
  editSummary: string;
}

type PreparedCodeActionForApply =
  | { ok: true; action: Record<string, unknown>; title: string }
  | { ok: false; error: string; details: Record<string, unknown>; hint?: string };

type PreparedWorkspaceEditForApply =
  | { ok: true; edit: unknown; source: Record<string, unknown>; title: string; details: Record<string, unknown> }
  | { ok: false; error: string; details: Record<string, unknown>; hint?: string };

interface RenderedLspText {
  text: string;
  truncation?: LspToolJsonTruncation;
}

export function registerLspTool(
  pi: PiApi,
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  formatService?: FormatService,
  mutationQueue?: FileMutationQueue,
): void {
  const toolState: LspToolState = {
    nextWorkspaceEditId: 1,
    workspaceEdits: new Map(),
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
    promptSnippet: "Inspect LSP status/capabilities, diagnostics, navigation, code actions, and renames for source files.",
    promptGuidelines: [
      "Use lsp with method=\"server/status\" when language-server feedback seems missing or stale.",
      "Use lsp with real LSP method names such as method=\"textDocument/hover\", method=\"textDocument/definition\", and method=\"workspace/symbol\"; line and column are 1-based.",
      "Use lsp method=\"textDocument/diagnostic\" with path to refresh one file, or method=\"workspace/diagnostic\" for cached known diagnostics; explicit diagnostics are not touched-line filtered.",
      "Use lsp method=\"textDocument/codeAction\" or method=\"textDocument/rename\" to preview a WorkspaceEdit, then method=\"workspaceEdit/apply\" with its id to apply it safely.",
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
        switch (method) {
        case "server/status":
          return textResult(renderStatus(runtime, lspService.getStatus(), runtime.projectTrusted ? formatService?.getStatus() : undefined), false, statusDetails(runtime, lspService, formatService));

        case "server/capabilities":
          return textResult(renderCapabilities(runtime, lspService.getStatus(), await lspService.capabilities(readPath(params), signal)), false, {
            clients: lspService.getStatus().clients,
            implementedMethods: LSP_METHODS,
          });

        case "textDocument/diagnostic":
        case "workspace/diagnostic":
          return textResult(renderDiagnosticsStatus(runtime, diagnosticsTarget(method, params), await diagnosticsSnapshot(method, params, runtime, lspService, signal)), false, {
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
          await lspService.restart(signal);
          return textResult("code-feedback LSP clients restarted and will be relaunched on demand.", false, statusDetails(runtime, lspService, formatService));

        case "textDocument/hover":
          return rawOrPretty(method, params, await lspService.hover(requirePath(params), params.line, readColumn(params), signal), runtime.projectRoot);

        case "textDocument/definition":
          return rawOrPretty(method, params, await lspService.definition(requirePath(params), params.line, readColumn(params), signal), runtime.projectRoot);

        case "textDocument/references":
          return rawOrPretty(method, params, await lspService.references(requirePath(params), params.line, readColumn(params), signal), runtime.projectRoot);

        case "textDocument/implementation":
          return rawOrPretty(method, params, await lspService.implementation(requirePath(params), params.line, readColumn(params), signal), runtime.projectRoot);

        case "textDocument/typeDefinition":
          return rawOrPretty(method, params, await lspService.typeDefinition(requirePath(params), params.line, readColumn(params), signal), runtime.projectRoot);

        case "textDocument/documentSymbol":
          return rawOrPretty(method, params, await lspService.documentSymbols(requirePath(params), signal), runtime.projectRoot);

        case "workspace/symbol":
          return rawOrPretty(method, params, await lspService.workspaceSymbols(params.query, readPath(params), signal), runtime.projectRoot);

        case "textDocument/codeAction":
          return await handleCodeActions(method, params, runtime, lspService, toolState, signal);

        case "textDocument/rename":
          return await handleRename(params, runtime, lspService, toolState, signal);

        case "workspaceEdit/apply":
          return await handleWorkspaceEditApply(method, params, runtime, lspService, formatService, toolState, mutationQueue, signal);

        }
      } catch (error) {
        if (isCancellation(error, signal)) throw error;
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
  required: ["method"],
  properties: {
    method: {
      type: "string",
      enum: LSP_METHODS,
      description: "LSP-lite method to run. Uses real LSP method names where possible; positions are still 1-based.",
    },
    path: { type: "string", description: "File path for file-scoped LSP actions." },
    line: { type: "number", minimum: 1, multipleOf: 1, description: "1-based line for position-scoped LSP actions." },
    column: { type: "number", minimum: 1, multipleOf: 1, description: "1-based column for position-scoped LSP actions." },
    query: { type: "string", description: "Search query for workspace/symbol." },
    id: { type: "string", description: "Stable id returned by a WorkspaceEdit preview; required for workspaceEdit/apply." },
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

async function diagnosticsSnapshot(
  method: LspMethod,
  params: Record<string, unknown>,
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  signal?: AbortSignal,
) {
  if (method === "workspace/diagnostic") return lspService.cachedDiagnostics("all");
  const filePath = requirePath(params);
  if (!runtime.config.enabled || !runtime.config.lsp.enabled) return lspService.cachedDiagnostics(filePath);
  return (await lspService.diagnosticsForFile(filePath, undefined, {
    timeoutMs: 1200,
    settleMs: 100,
    snapshotScope: "file",
    signal,
  })) ?? lspService.cachedDiagnostics(filePath);
}

function diagnosticsTarget(method: LspMethod, params: Record<string, unknown>): string {
  if (method === "workspace/diagnostic") return "all";
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
  return params.column;
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

function rawOrPretty(method: LspMethod, params: Record<string, unknown>, result: unknown, projectRoot: string): PiToolResult {
  const raw = params.raw === true;
  const rendered = raw ? formatLspToolJson(result) : renderLspResult(method, result, projectRoot);
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

function renderLspResult(method: LspMethod, result: unknown, projectRoot: string): RenderedLspText {
  return { text: renderLspMethodResult(method, result, projectRoot || process.cwd()) };
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
  const requestFileStateBefore = readCachedFileState(path.resolve(runtime.projectRoot, filePath));
  const column = readColumn(params);
  const result = await lspService.codeActions(filePath, params.line, column, signal);
  throwIfAborted(signal);
  const requestFileStateAfter = readCachedFileState(path.resolve(runtime.projectRoot, filePath));
  if (!sameCachedFileState(requestFileStateBefore, requestFileStateAfter)) {
    return errorResult(method, `File changed while collecting code actions: ${relativePath(runtime.projectRoot, requestFileStateAfter.filePath)}`, {
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
    line: typeof params.line === "number" ? params.line : undefined,
    column: typeof column === "number" ? column : undefined,
    actions: summaries,
    hint: summaries.some((action) => action.applyable)
      ? "Apply one with method=\"workspaceEdit/apply\" and id."
      : undefined,
  }, {
    ok: true,
    method,
    actions: summaries,
    result,
  });
}

async function handleWorkspaceEditApply(
  method: LspMethod,
  params: Record<string, unknown>,
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  formatService: FormatService | undefined,
  state: LspToolState,
  mutationQueue: FileMutationQueue | undefined,
  signal?: AbortSignal,
): Promise<PiToolResult> {
  throwIfAborted(signal);
  const pendingGuard = rejectApplyDuringPendingEdits(runtime, "WorkspaceEdit");
  if (pendingGuard) return pendingGuard;

  const id = typeof params.id === "string" ? params.id.trim() : "";
  if (!id) return errorResult(method, "workspaceEdit/apply requires id", { cachedIds: [...state.workspaceEdits.keys()].slice(-20) }, "Preview a rename or code action first and pass its returned id.");

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
  if (targetFiles.ok) {
    for (const filePath of targetFiles.files) {
      beforeDiagnostics.set(path.resolve(filePath), lspService.cachedDiagnosticsIfKnown(filePath));
    }
  }
  const appliedChanges: AppliedWorkspaceEditChange[] = [];

  const applyResult = await applyWorkspaceEdit(
    prepared.edit,
    runtime.projectRoot,
    {
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
    },
  );

  const payload = {
    ok: applyResult.applied,
    method,
    id,
    kind: cached.kind,
    title: prepared.title,
    applied: applyResult.applied,
    editCount: applyResult.editCount,
    changedFiles: applyResult.changedFiles.map((filePath) => relativePath(runtime.projectRoot, filePath)),
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
    beforeContent: change.beforeContent,
    afterAgentContent: change.afterContent,
    beforeDiagnostics: beforeDiagnostics.get(path.resolve(change.filePath)),
    startedAt: feedbackStartedAt,
  }));
  try {
    return await processAppliedLspFileMutations(result, mutations, runtime, lspService, formatService, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.lastError = message;
    return {
      ...result,
      details: isRecord(result.details)
        ? { ...result.details, codeFeedbackError: projectRelativeErrorMessage(message, runtime.projectRoot) }
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
  const requestFileBefore = readCachedFileState(path.resolve(runtime.projectRoot, requestPath));
  const result = await lspService.rename(requestPath, params.line, readColumn(params), params.newName, signal);
  throwIfAborted(signal);
  const requestFileAfter = readCachedFileState(path.resolve(runtime.projectRoot, requestPath));
  if (!sameCachedFileState(requestFileBefore, requestFileAfter)) {
    return errorResult("textDocument/rename", `File changed while collecting rename edits: ${relativePath(runtime.projectRoot, requestFileAfter.filePath)}`, {
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
    newName: String(params.newName),
    workspaceEdit: preview,
    hint: preview.applyable ? "Apply with method=\"workspaceEdit/apply\" and id." : undefined,
  }, {
    ok: true,
    method: "textDocument/rename",
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
  if (!targetFiles.ok || summary.edits === 0 || summary.resourceOperations !== 0) {
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

function validateCachedWorkspaceEdit(cached: CachedWorkspaceEdit, projectRoot: string): { reason: string; files?: Array<{ before: Record<string, unknown>; after: Record<string, unknown> }> } | undefined {
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
  mutationQueue: FileMutationQueue | undefined,
  signal?: AbortSignal,
): WorkspaceEditApplyOptions {
  const targetFiles = workspaceEditTargetFiles(edit, runtime.projectRoot);
  const expectedByPath = new Map<string, CachedFileState>();
  for (const state of expected) expectedByPath.set(path.resolve(state.filePath), state);
  if (targetFiles.ok) {
    for (const filePath of targetFiles.files) {
      const resolved = path.resolve(filePath);
      if (!expectedByPath.has(resolved)) expectedByPath.set(resolved, readCachedFileState(resolved));
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

function dedupeFileStates(states: CachedFileState[]): CachedFileState[] {
  const byPath = new Map<string, CachedFileState>();
  for (const state of states) byPath.set(path.resolve(state.filePath), state);
  return [...byPath.values()];
}

function readCachedFileState(filePath: string): CachedFileState {
  return readWorkspaceEditFileState(filePath);
}

function readEditTargetFileState(filePath: string, requestFile: CachedFileState): CachedFileState {
  return path.resolve(filePath) === path.resolve(requestFile.filePath) ? requestFile : readCachedFileState(filePath);
}

function sameCachedFileState(left: CachedFileState, right: CachedFileState): boolean {
  return sameWorkspaceEditFileState(left, right);
}

function displayFileState(projectRoot: string, state: CachedFileState): Record<string, unknown> {
  return {
    path: relativePath(projectRoot, state.filePath),
    exists: state.exists,
    bytes: state.bytes,
    sha256: state.sha256 ? state.sha256.slice(0, 12) : undefined,
    mode: state.mode === undefined ? undefined : state.mode.toString(8).padStart(3, "0"),
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

function hintForError(message: string): string | undefined {
  if (/requires 1-based line and character|requires 1-based line and column/i.test(message)) return "Pass line and column as 1-based numbers.";
  if (/requires path/i.test(message)) return "Pass path for textDocument methods.";
  if (/LSP source file is too large/i.test(message)) return "Use a smaller source file or exclude generated output from explicit LSP requests.";
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


