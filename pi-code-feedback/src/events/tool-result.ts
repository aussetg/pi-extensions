import { linkDiagnosticsToTouchedRanges } from "../diagnostics/provenance.ts";
import { computeTouchedRanges } from "../diagnostics/ranges.ts";
import { readDiagnosticSnapshotFromDetails } from "../diagnostics/snapshots.ts";
import { mapTouchedRangesThroughFormatting } from "../format/mapping.ts";
import type { FormatService } from "../format/service.ts";
import { readUtf8IfExists } from "../fs.ts";
import type { LspService } from "../lsp/service.ts";
import { resolveInputPath, shouldTrackFile } from "../paths.ts";
import type { PiToolResult } from "../pi.ts";
import { renderDelayedDiagnosticFeedback, renderInlineDiagnosticFeedback } from "../render.ts";
import { enqueueDelayedFeedback, recordCompletedEdit, takePendingEdit, type CodeFeedbackRuntime } from "../runtime.ts";
import type { CompletedEdit, DiagnosticRefreshResult, DiagnosticSnapshot, FormatterResult, FormatterSummary, PendingEdit } from "../types.ts";
import { applyPatchOperationId } from "./tool-call.ts";

export interface ToolResultEvent {
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  details?: unknown;
  content?: PiToolResult["content"];
  isError?: boolean;
}

export interface ToolResultContext {
  cwd?: string;
}

export async function handleToolResult(
  event: ToolResultEvent,
  ctx: ToolResultContext,
  runtime: CodeFeedbackRuntime,
  lspService?: LspService,
  formatService?: FormatService,
): Promise<PiToolResult | void> {
  if (!runtime.config.enabled) return;
  if (event.toolName === "apply_patch") {
    return handleApplyPatchToolResult(event, ctx, runtime, lspService, formatService);
  }

  if (event.toolName !== "write" && event.toolName !== "edit") return;

  const filePath = resolveInputPath(event.input, ctx.cwd, runtime.projectRoot);
  if (!filePath || !shouldTrackFile(filePath, runtime.projectRoot)) return;

  const pending = takePendingEdit(runtime, event.toolCallId, filePath, event.toolName);
  if (event.isError) return;

  const afterAgentContent = readUtf8IfExists(filePath);
  if (afterAgentContent === undefined) return;

  const detailsDiff = readDetailsDiff(event.details);
  let touchedRanges = computeTouchedRanges({
    filePath,
    beforeContent: pending?.beforeContent,
    afterContent: afterAgentContent,
    toolName: event.toolName,
    detailsDiff,
  });

  const formatter = await maybeFormatFile(formatService, runtime, filePath, afterAgentContent);
  const finalContent = formatter?.finalContent ?? afterAgentContent;
  if (formatter?.changed) {
    touchedRanges = mapTouchedRangesThroughFormatting(filePath, afterAgentContent, finalContent, touchedRanges);
  }

  const completed: CompletedEdit = {
    id: pending?.id ?? event.toolCallId ?? `${runtime.turnIndex}:${runtime.writeIndex}:${event.toolName}:${filePath}:result`,
    toolName: event.toolName,
    filePath,
    beforeContent: pending?.beforeContent,
    afterAgentContent,
    afterContent: finalContent,
    touchedRanges,
    turnIndex: pending?.turnIndex ?? runtime.turnIndex,
    writeIndex: pending?.writeIndex ?? runtime.writeIndex,
    startedAt: pending?.startedAt ?? Date.now(),
    completedAt: Date.now(),
    detailsDiffPresent: detailsDiff !== undefined,
    formatter: summarizeFormatter(formatter),
  };

  const afterRefresh = await captureAfterDiagnosticRefresh(lspService, filePath, finalContent, runtime);
  const afterDiagnostics = afterRefresh?.fresh
    ? afterRefresh.snapshot
    : readDiagnosticSnapshotFromDetails(event.details, ["afterDiagnostics", "postDiagnostics", "diagnostics"]);
  attachDiagnosticFilter(event, pending, completed, runtime, afterDiagnostics);
  recordCompletedEdit(runtime, completed);
  scheduleDelayedDiagnosticsIfNeeded(afterRefresh, lspService, runtime, completed, pending?.beforeDiagnostics, finalContent);
  return appendInlineFeedback(event, completed, runtime);
}

async function handleApplyPatchToolResult(
  event: ToolResultEvent,
  ctx: ToolResultContext,
  runtime: CodeFeedbackRuntime,
  lspService?: LspService,
  formatService?: FormatService,
): Promise<PiToolResult | void> {
  if (event.isError) return;
  const results = readApplyPatchResults(event.details);
  if (results.length === 0) return;

  const completedEdits: CompletedEdit[] = [];

  for (const [index, result] of results.entries()) {
    if (result.status !== "completed") continue;

    const filePath = resolveInputPath({ path: result.path }, ctx.cwd, runtime.projectRoot);
    if (!filePath || !shouldTrackFile(filePath, runtime.projectRoot)) continue;

    const pendingId = applyPatchOperationId(event.toolCallId, runtime.turnIndex, runtime.writeIndex, index);
    const pending = takePendingEdit(runtime, pendingId, filePath, "apply_patch");
    const afterAgentContent = result.type === "delete_file" ? undefined : readUtf8IfExists(filePath);
    if (result.type !== "delete_file" && afterAgentContent === undefined) continue;

    const detailsDiff = typeof result.diff === "string" && result.diff.length > 0 ? result.diff : undefined;
    let touchedRanges = afterAgentContent === undefined
      ? []
      : computeTouchedRanges({
          filePath,
          beforeContent: pending?.beforeContent,
          afterContent: afterAgentContent,
          toolName: "apply_patch",
          detailsDiff,
        });

    const formatter = afterAgentContent === undefined ? undefined : await maybeFormatFile(formatService, runtime, filePath, afterAgentContent);
    const finalContent = formatter?.finalContent ?? afterAgentContent;
    if (formatter?.changed && afterAgentContent !== undefined && finalContent !== undefined) {
      touchedRanges = mapTouchedRangesThroughFormatting(filePath, afterAgentContent, finalContent, touchedRanges);
    }

    const completed: CompletedEdit = {
      id: pending?.id ?? pendingId,
      toolName: "apply_patch",
      filePath,
      beforeContent: pending?.beforeContent,
      afterAgentContent,
      afterContent: finalContent,
      touchedRanges,
      turnIndex: pending?.turnIndex ?? runtime.turnIndex,
      writeIndex: pending?.writeIndex ?? runtime.writeIndex,
      startedAt: pending?.startedAt ?? Date.now(),
      completedAt: Date.now(),
      skippedReason: result.type === "delete_file" ? "deleted" : undefined,
      detailsDiffPresent: detailsDiff !== undefined,
      formatter: summarizeFormatter(formatter),
      applyPatchOperationIndex: index,
      originalPath: pending?.originalPath,
    };

    const afterRefresh = finalContent === undefined
      ? undefined
      : await captureAfterDiagnosticRefresh(lspService, filePath, finalContent, runtime);
    const afterDiagnostics = afterRefresh?.fresh
      ? afterRefresh.snapshot
      : readDiagnosticSnapshotFromDetails(event.details, ["afterDiagnostics", "postDiagnostics", "diagnostics"]);
    attachDiagnosticFilter(event, pending, completed, runtime, afterDiagnostics);
    recordCompletedEdit(runtime, completed);
    if (finalContent !== undefined) {
      scheduleDelayedDiagnosticsIfNeeded(afterRefresh, lspService, runtime, completed, pending?.beforeDiagnostics, finalContent);
    }
    completedEdits.push(completed);
  }

  return appendInlineFeedbackForEdits(event, completedEdits, runtime);
}

async function captureAfterDiagnosticRefresh(
  lspService: LspService | undefined,
  filePath: string,
  content: string,
  runtime: CodeFeedbackRuntime,
): Promise<DiagnosticRefreshResult | undefined> {
  if (!lspService) return undefined;
  if (!runtime.config.lsp.enabled) return undefined;
  return lspService.diagnosticsForFileDetailed(filePath, content, {
    timeoutMs: runtime.config.diagnostics.timeoutMs,
    settleMs: runtime.config.diagnostics.settleMs,
  });
}

async function maybeFormatFile(
  formatService: FormatService | undefined,
  runtime: CodeFeedbackRuntime,
  filePath: string,
  content: string,
): Promise<FormatterResult | undefined> {
  if (!formatService) return undefined;
  if (!runtime.config.autoFormat || runtime.config.formatMode !== "immediate") return undefined;
  return formatService.formatFile(filePath, content);
}

function summarizeFormatter(result: FormatterResult | undefined): FormatterSummary | undefined {
  if (!result) return undefined;
  return {
    formatterName: result.formatterName,
    command: result.command,
    changed: result.changed,
    errors: result.errors,
    skippedReason: result.skippedReason,
    durationMs: result.durationMs,
  };
}

function attachDiagnosticFilter(
  event: ToolResultEvent,
  pending: PendingEdit | undefined,
  completed: CompletedEdit,
  runtime: CodeFeedbackRuntime,
  afterDiagnostics: DiagnosticSnapshot | undefined,
): void {
  if (!afterDiagnostics) return;

  const beforeDiagnostics = readDiagnosticSnapshotFromDetails(event.details, ["beforeDiagnostics", "preDiagnostics"]);
  attachDiagnosticFilterFromSnapshots(beforeDiagnostics ?? pending?.beforeDiagnostics, completed, runtime, afterDiagnostics);
}

function attachDiagnosticFilterFromSnapshots(
  beforeDiagnostics: DiagnosticSnapshot | undefined,
  completed: CompletedEdit,
  runtime: CodeFeedbackRuntime,
  afterDiagnostics: DiagnosticSnapshot,
): void {
  completed.diagnosticFilter = linkDiagnosticsToTouchedRanges({
    beforeSnapshot: beforeDiagnostics,
    afterSnapshot: afterDiagnostics,
    touchedRanges: completed.touchedRanges,
    maxInline: runtime.config.diagnostics.maxInline,
    includeCrossFileRelated: runtime.config.diagnostics.includeCrossFileRelated,
  });
}

function scheduleDelayedDiagnosticsIfNeeded(
  firstRefresh: DiagnosticRefreshResult | undefined,
  lspService: LspService | undefined,
  runtime: CodeFeedbackRuntime,
  completed: CompletedEdit,
  beforeDiagnostics: DiagnosticSnapshot | undefined,
  finalContent: string,
): void {
  if (!lspService || !runtime.config.lsp.enabled) return;
  if (!firstRefresh || firstRefresh.fresh) return;
  if (completed.touchedRanges.length === 0) return;
  if (completed.diagnosticFilter?.linked.length) return;

  void lspService.diagnosticsForFileDetailed(completed.filePath, finalContent, {
    timeoutMs: Math.max(runtime.config.diagnostics.delayedTimeoutMs, runtime.config.diagnostics.timeoutMs),
    settleMs: runtime.config.diagnostics.settleMs,
  }).then((refresh) => {
    if (!runtime.config.enabled || !runtime.config.lsp.enabled) return;
    if (!refresh?.fresh) return;

    attachDiagnosticFilterFromSnapshots(beforeDiagnostics, completed, runtime, refresh.snapshot);
    const text = renderDelayedDiagnosticFeedback(runtime, completed);
    if (!text) return;

    enqueueDelayedFeedback(runtime, {
      id: `delayed:${completed.id}`,
      editId: completed.id,
      filePath: completed.filePath,
      turnIndex: completed.turnIndex,
      writeIndex: completed.writeIndex,
      queuedAt: Date.now(),
      text,
    });
  }).catch((error) => {
    runtime.lastError = error instanceof Error ? error.message : String(error);
  });
}

function appendInlineFeedback(event: ToolResultEvent, completed: CompletedEdit, runtime: CodeFeedbackRuntime): PiToolResult | void {
  const feedback = renderInlineDiagnosticFeedback(runtime, completed);
  if (!feedback) return;
  const isStrictError = runtime.config.strict && completed.diagnosticFilter?.linked.some((linked) => linked.diagnostic.severity === "error");
  return {
    content: [...(event.content ?? []), { type: "text", text: feedback }],
    isError: isStrictError || undefined,
  };
}

function appendInlineFeedbackForEdits(event: ToolResultEvent, completedEdits: CompletedEdit[], runtime: CodeFeedbackRuntime): PiToolResult | void {
  const feedbackBlocks = completedEdits
    .map((edit) => renderInlineDiagnosticFeedback(runtime, edit))
    .filter((feedback): feedback is string => feedback !== undefined);
  if (feedbackBlocks.length === 0) return;

  const isStrictError = runtime.config.strict && completedEdits.some((edit) => edit.diagnosticFilter?.linked.some((linked) => linked.diagnostic.severity === "error"));
  return {
    content: [...(event.content ?? []), { type: "text", text: feedbackBlocks.join("\n\n") }],
    isError: isStrictError || undefined,
  };
}

function readDetailsDiff(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const diff = (details as { diff?: unknown }).diff;
  return typeof diff === "string" && diff.length > 0 ? diff : undefined;
}

function readApplyPatchResults(details: unknown): ApplyPatchResultInput[] {
  if (!details || typeof details !== "object") return [];
  const done = details as { stage?: unknown; results?: unknown };
  if (done.stage !== "done" || !Array.isArray(done.results)) return [];
  return done.results.filter(isApplyPatchResultInput);
}

function isApplyPatchResultInput(value: unknown): value is ApplyPatchResultInput {
  if (!value || typeof value !== "object") return false;
  const result = value as { type?: unknown; path?: unknown; status?: unknown; diff?: unknown };
  return (
    (result.type === "create_file" || result.type === "update_file" || result.type === "delete_file") &&
    typeof result.path === "string" &&
    (result.status === "completed" || result.status === "failed") &&
    (result.diff === undefined || typeof result.diff === "string")
  );
}

interface ApplyPatchResultInput {
  type: "create_file" | "update_file" | "delete_file";
  path: string;
  status: "completed" | "failed";
  diff?: string;
}

