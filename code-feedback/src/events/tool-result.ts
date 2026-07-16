import * as path from "node:path";
import { linkDiagnosticsToTouchedRanges, workspaceDiagnosticDelta } from "../diagnostics/provenance.ts";
import { computeTouchedRanges } from "../diagnostics/ranges.ts";
import { diagnosticSeverityRank, flattenDiagnosticSnapshot } from "../diagnostics/snapshots.ts";
import { errorMessage } from "../errors.ts";
import { mapTouchedRangesThroughFormatting } from "../format/mapping.ts";
import type { FormatService } from "../format/service.ts";
import { DEFAULT_TRACKED_FILE_MAX_BYTES, formatBytes, readUtf8IfSmall, type ReadUtf8Result } from "../fs.ts";
import type { LspFileMutation } from "../lsp/file-mutations.ts";
import { uriToFilePath } from "../lsp/positions.ts";
import type { LspService } from "../lsp/service.ts";
import { displayPathFromRoot, resolveInputPath, shouldTrackFile } from "../paths.ts";
import { addTimingPhase, createTimingRecorder, type TimingRecorder } from "../perf.ts";
import type { PiToolResult } from "../pi.ts";
import { renderDelayedDiagnosticFeedback, renderInlineDiagnosticFeedback } from "../render.ts";
import {
  contentHash,
  discardPendingEditsForToolCall,
  enqueueDelayedFeedback,
  fileContentMatchesHash,
  finishDelayedDiagnosticRequest,
  hasPendingEditForFile,
  isFileMutationCurrent,
  nextWriteIndex,
  recordCompletedEdit,
  recordFileMutation,
  startDelayedDiagnosticRequest,
  takePendingEdit,
  type CodeFeedbackRuntime,
  type FileMutationToken,
} from "../runtime.ts";
import {
  CODE_FEEDBACK_DETAILS_KEY,
  isRecord,
  type CodeFeedbackEditDetails,
  type CodeFeedbackToolDetails,
  type CompletedEdit,
  type DiagnosticFilterResult,
  type DiagnosticRefreshResult,
  type DiagnosticSnapshot,
  type FormatterResult,
  type FormatterSummary,
  type LspDiagnostic,
  type PendingEdit,
} from "../types.ts";
import { applyPatchOperationId, readApplyPatchOperations } from "./tool-call.ts";

export interface ToolResultEvent {
  toolName: string;
  toolCallId: string;
  input?: unknown;
  details?: unknown;
  content?: PiToolResult["content"];
  isError?: boolean;
}

export interface ToolResultContext {
  cwd: string;
  signal?: AbortSignal;
}

type FeedbackResultSource = Pick<ToolResultEvent, "content" | "details">;

export interface AppliedLspFileMutation {
  id: string;
  filePath: string;
  originalPath?: string;
  beforeContent: string;
  afterAgentContent: string;
  beforeDiagnostics?: DiagnosticSnapshot;
  startedAt?: number;
}

export async function processAppliedLspFileMutations(
  result: PiToolResult,
  mutations: readonly AppliedLspFileMutation[],
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  formatService: FormatService,
  signal?: AbortSignal,
): Promise<PiToolResult> {
  const completedEdits: CompletedEdit[] = [];
  const timingsByEditId = new Map<string, TimingRecorder>();
  const mutationTokens = mutations.map((mutation) => {
    const finalTracked = shouldTrackFile(mutation.filePath, runtime.projectRoot);
    const originalTracked = mutation.originalPath !== undefined && shouldTrackFile(mutation.originalPath, runtime.projectRoot);
    if (originalTracked && mutation.originalPath && !pathEquals(mutation.originalPath, mutation.filePath)) {
      recordFileMutation(runtime, mutation.originalPath);
    }
    return finalTracked ? recordFileMutation(runtime, mutation.filePath) : undefined;
  });
  notifyLspFileMutations(
    lspService,
    runtime,
    mutations.flatMap((mutation): LspFileMutation[] => {
      const finalTracked = shouldTrackFile(mutation.filePath, runtime.projectRoot);
      const originalTracked = mutation.originalPath !== undefined && shouldTrackFile(mutation.originalPath, runtime.projectRoot);
      if (mutation.originalPath && !pathEquals(mutation.originalPath, mutation.filePath)) {
        if (originalTracked && finalTracked) {
          return [{ type: "renamed", oldFilePath: mutation.originalPath, newFilePath: mutation.filePath }];
        }
        if (originalTracked) return [{ type: "deleted", filePath: mutation.originalPath }];
        if (finalTracked) return [{ type: "created", filePath: mutation.filePath }];
        return [];
      }
      return finalTracked ? [{ type: "changed", filePath: mutation.filePath }] : [];
    }),
  );

  for (const [mutationIndex, mutation] of mutations.entries()) {
    if (!shouldTrackFile(mutation.filePath, runtime.projectRoot)) continue;
    const mutationToken = mutationTokens[mutationIndex];
    if (!mutationToken) continue;

    const timing = createTimingRecorder();
    const writeIndex = nextWriteIndex(runtime);
    const skippedReason = appliedMutationSkippedReason(mutation);
    if (skippedReason) {
      lspService.forgetFile(mutation.filePath);
      const completed: CompletedEdit = {
        id: mutation.id,
        toolName: "lsp",
        filePath: mutation.filePath,
        beforeContent: mutation.beforeContent,
        afterAgentContent: mutation.afterAgentContent,
        afterContent: mutation.afterAgentContent,
        touchedRanges: [],
        turnIndex: runtime.turnIndex,
        writeIndex,
        startedAt: mutation.startedAt ?? Date.now(),
        completedAt: Date.now(),
        skippedReason,
        originalPath: mutation.originalPath,
      };
      completed.timing = timing.snapshot();
      timing.measure("tool_result.record_completed", () => recordCompletedEdit(runtime, completed));
      completed.timing = timing.snapshot();
      completedEdits.push(completed);
      timingsByEditId.set(completed.id, timing);
      continue;
    }

    const rangeComputationResult = timing.measure("tool_result.touched_ranges", () => computeTouchedRanges({
      filePath: mutation.filePath,
      beforeContent: mutation.beforeContent,
      afterContent: mutation.afterAgentContent,
      toolName: "lsp",
    }));
    let touchedRanges = rangeComputationResult.ranges;
    let rangeComputation = rangeComputationResult.computation;

    const formatter = await timing.measureAsync("tool_result.format", () => maybeFormatFile(
      formatService,
      runtime,
      mutation.filePath,
      mutation.afterAgentContent,
      touchedRanges.length > 0,
    ));
    const finalContent = formatter?.finalContent ?? mutation.afterAgentContent;
    if (formatter?.changed) {
      touchedRanges = timing.measure("tool_result.format_map", () => mapTouchedRangesThroughFormatting(
        mutation.filePath,
        mutation.afterAgentContent,
        finalContent,
        touchedRanges,
      ));
      timing.measure("tool_result.notify_file_mutation", () => notifyLspFileMutations(
        lspService,
        runtime,
        [{ type: "changed", filePath: mutation.filePath }],
      ));
    }
    if (
      touchedRanges.length === 0 &&
      mutation.originalPath !== undefined &&
      !pathEquals(mutation.originalPath, mutation.filePath)
    ) {
      const identityChange = timing.measure("tool_result.rename_identity_range", () => computeTouchedRanges({
        filePath: mutation.filePath,
        beforeContent: undefined,
        afterContent: finalContent,
        toolName: "lsp",
      }));
      touchedRanges = identityChange.ranges;
      rangeComputation = identityChange.computation;
    }

    const completed: CompletedEdit = {
      id: mutation.id,
      toolName: "lsp",
      filePath: mutation.filePath,
      beforeContent: mutation.beforeContent,
      afterAgentContent: mutation.afterAgentContent,
      afterContent: finalContent,
      touchedRanges,
      turnIndex: runtime.turnIndex,
      writeIndex,
      startedAt: mutation.startedAt ?? Date.now(),
      completedAt: Date.now(),
      rangeComputation,
      formatter: summarizeFormatter(formatter),
      originalPath: mutation.originalPath,
    };

    const afterRefresh = await timing.measureAsync("tool_result.after_diagnostics", () => captureAfterDiagnosticRefresh(
      lspService,
      mutation.filePath,
      finalContent,
      runtime,
      signal,
    ));
    if (afterRefresh?.fresh) {
      timing.measure("tool_result.filter_diagnostics", () => attachDiagnosticFilterFromSnapshots(
        mutation.beforeDiagnostics,
        completed,
        runtime,
        afterRefresh.snapshot,
      ));
    }
    completed.timing = timing.snapshot();
    timing.measure("tool_result.record_completed", () => recordCompletedEdit(runtime, completed));
    completed.timing = timing.snapshot();
    scheduleDelayedDiagnosticsIfNeeded(afterRefresh, lspService, runtime, completed, mutation.beforeDiagnostics, finalContent, mutationToken);
    completedEdits.push(completed);
    timingsByEditId.set(completed.id, timing);
  }

  return appendInlineFeedbackForEdits(result, completedEdits, runtime, timingsByEditId) ?? result;
}

function appliedMutationSkippedReason(mutation: AppliedLspFileMutation): string | undefined {
  const beforeBytes = Buffer.byteLength(mutation.beforeContent, "utf8");
  const afterBytes = Buffer.byteLength(mutation.afterAgentContent, "utf8");
  const size = Math.max(beforeBytes, afterBytes);
  if (size > DEFAULT_TRACKED_FILE_MAX_BYTES) {
    return `skipped large file (${formatBytes(size)} > ${formatBytes(DEFAULT_TRACKED_FILE_MAX_BYTES)})`;
  }
  if (mutation.beforeContent.includes("\0") || mutation.afterAgentContent.includes("\0")) {
    return "skipped binary file";
  }
  return undefined;
}

export async function handleToolResult(
  event: ToolResultEvent,
  ctx: ToolResultContext,
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  formatService: FormatService,
): Promise<PiToolResult | void> {
  if (!runtime.config.enabled) return;
  if (!runtime.projectTrusted) return;
  if (event.toolName === "bash") {
    await reconcileExternalMutations(event, ctx, runtime, lspService);
    return;
  }
  if (event.toolName === "apply_patch") {
    return handleApplyPatchToolResult(event, ctx, runtime, lspService, formatService);
  }

  if (event.toolName !== "write" && event.toolName !== "edit") return;
  const toolName = event.toolName;

  const filePath = resolveInputPath(event.input, ctx.cwd);
  if (!filePath || !shouldTrackFile(filePath, runtime.projectRoot)) return;

  const pending = takePendingEdit(runtime, event.toolCallId);
  const timing = createTimingRecorder(pending?.timing);
  if (event.isError) return;
  const mutationToken = recordFileMutation(runtime, filePath);

  const afterRead = timing.measure("tool_result.read_after", () => readUtf8IfSmall(filePath));
  const afterAgentContent = afterRead.content;
  if (afterAgentContent === undefined) {
    const skippedReason = fileReadSkippedReason(afterRead);
    if (!skippedReason) return;

    timing.measure("tool_result.notify_file_mutation", () => notifyLspFileMutations(
      lspService,
      runtime,
      [simpleToolFileMutation(toolName, filePath, pending)],
    ));
    lspService.forgetFile(filePath);
    const completed = completedEditWithSkippedExactFeedback({
      pending,
      id: pending?.id ?? event.toolCallId,
      toolName,
      filePath,
      runtime,
      skippedReason,
    });
    completed.timing = timing.snapshot();
    timing.measure("tool_result.record_completed", () => recordCompletedEdit(runtime, completed));
    completed.timing = timing.snapshot();
    return appendInlineFeedback(event, completed, runtime, timing);
  }

  const detailsDiff = readDetailsDiff(event.details);
  const rangeComputationResult = timing.measure("tool_result.touched_ranges", () => computeTouchedRanges({
    filePath,
    beforeContent: pending?.beforeContent,
    afterContent: afterAgentContent,
    toolName,
    detailsDiff,
  }));
  let touchedRanges = rangeComputationResult.ranges;

  const formatter = await timing.measureAsync("tool_result.format", () => maybeFormatFile(formatService, runtime, filePath, afterAgentContent, touchedRanges.length > 0));
  const finalContent = formatter?.finalContent ?? afterAgentContent;
  if (formatter?.changed) {
    touchedRanges = timing.measure("tool_result.format_map", () => mapTouchedRangesThroughFormatting(filePath, afterAgentContent, finalContent, touchedRanges));
  }
  timing.measure("tool_result.notify_file_mutation", () => notifyLspFileMutations(
    lspService,
    runtime,
    [simpleToolFileMutation(toolName, filePath, pending)],
  ));

  const completed: CompletedEdit = {
    id: pending?.id ?? event.toolCallId,
    toolName,
    filePath,
    beforeContent: pending?.beforeContent,
    afterAgentContent,
    afterContent: finalContent,
    touchedRanges,
    turnIndex: pending?.turnIndex ?? runtime.turnIndex,
    writeIndex: pending?.writeIndex ?? runtime.writeIndex,
    startedAt: pending?.startedAt ?? Date.now(),
    completedAt: Date.now(),
    rangeComputation: rangeComputationResult.computation,
    formatter: summarizeFormatter(formatter),
  };

  const afterRefresh = await timing.measureAsync("tool_result.after_diagnostics", () => captureAfterDiagnosticRefresh(lspService, filePath, finalContent, runtime));
  if (afterRefresh?.fresh) {
    timing.measure("tool_result.filter_diagnostics", () => attachDiagnosticFilterFromSnapshots(
      pending?.beforeDiagnostics,
      completed,
      runtime,
      afterRefresh.snapshot,
    ));
  }
  completed.timing = timing.snapshot();
  timing.measure("tool_result.record_completed", () => recordCompletedEdit(runtime, completed));
  completed.timing = timing.snapshot();
  scheduleDelayedDiagnosticsIfNeeded(afterRefresh, lspService, runtime, completed, pending?.beforeDiagnostics, finalContent, mutationToken);
  return appendInlineFeedback(event, completed, runtime, timing);
}

async function reconcileExternalMutations(
  event: ToolResultEvent,
  ctx: ToolResultContext,
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
): Promise<void> {
  if (event.isError || !runtime.config.lsp.enabled) return;

  try {
    const result = await lspService.reconcileOpenDocuments({ signal: ctx.signal });
    for (const mutation of result.mutations) {
      if (mutation.type === "renamed") {
        recordFileMutation(runtime, mutation.oldFilePath);
        recordFileMutation(runtime, mutation.newFilePath);
      } else {
        recordFileMutation(runtime, mutation.filePath);
      }
    }
  } catch (error) {
    if (ctx.signal?.aborted) return;
    runtime.lastError = errorMessage(error);
  }
}

async function handleApplyPatchToolResult(
  event: ToolResultEvent,
  ctx: ToolResultContext,
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  formatService: FormatService,
): Promise<PiToolResult | void> {
  if (event.isError) {
    discardApplyPatchPendingBatch(event, runtime);
    return;
  }
  const indexedResults = readApplyPatchResults(event.details);
  if (indexedResults.length === 0) {
    discardApplyPatchPendingBatch(event, runtime);
    return;
  }

  const completedEdits: CompletedEdit[] = [];
  const timingsByEditId = new Map<string, TimingRecorder>();
  const recordedMutations = recordApplyPatchMutations(event, ctx, runtime, indexedResults);
  const mutationTokens = recordedMutations.tokens;
  notifyLspFileMutations(lspService, runtime, recordedMutations.fileMutations);

  for (const { operationIndex, result } of indexedResults) {
    if (result.status === "completed") continue;
    takeApplyPatchPendingEdit(event, runtime, operationIndex);
  }

  try {
    for (const { operationIndex: index, result } of indexedResults) {
      if (result.status !== "completed") continue;

      const resultPath = resolveInputPath({ path: result.path }, ctx.cwd);
      const pending = takeApplyPatchPendingEdit(event, runtime, index);
      if (!resultPath) continue;

      const pendingId = applyPatchOperationId(event.toolCallId, index);
      const timing = createTimingRecorder(pending?.timing);
      const filePath = pending?.filePath ?? resultPath;
      if (!shouldTrackFile(filePath, runtime.projectRoot)) {
        forgetOriginalPathIfMoved(lspService, pending, filePath);
        continue;
      }
      const detailsDiff = result.change?.type === "update" && result.change.unifiedDiff.length > 0
        ? result.change.unifiedDiff
        : undefined;
      const afterRead = result.type === "delete_file" ? undefined : timing.measure("tool_result.read_after", () => readUtf8IfSmall(filePath));
      const afterAgentContent = afterRead?.content;
      if (result.type !== "delete_file" && afterAgentContent === undefined) {
        const skippedReason = fileReadSkippedReason(afterRead);
        if (skippedReason) lspService.forgetFile(filePath);
        if (skippedReason) {
          const completed = completedEditWithSkippedExactFeedback({
            pending,
            id: pending?.id ?? pendingId,
            toolName: "apply_patch",
            filePath,
            runtime,
            skippedReason,
            applyPatchOperationIndex: index,
            originalPath: pending?.originalPath,
          });
          completed.timing = timing.snapshot();
          timing.measure("tool_result.record_completed", () => recordCompletedEdit(runtime, completed));
          completed.timing = timing.snapshot();
          completedEdits.push(completed);
          timingsByEditId.set(completed.id, timing);
        }
        forgetOriginalPathIfMoved(lspService, pending, filePath);
        continue;
      }

      const rangeComputationResult = afterAgentContent === undefined
        ? undefined
        : timing.measure("tool_result.touched_ranges", () => computeTouchedRanges({
            filePath,
            beforeContent: pending?.beforeContent,
            afterContent: afterAgentContent,
            toolName: "apply_patch",
            detailsDiff,
          }));
      let touchedRanges = rangeComputationResult?.ranges ?? [];

      const formatter = afterAgentContent === undefined ? undefined : await timing.measureAsync("tool_result.format", () => maybeFormatFile(formatService, runtime, filePath, afterAgentContent, touchedRanges.length > 0));
      const finalContent = formatter?.finalContent ?? afterAgentContent;
      if (formatter?.changed && afterAgentContent !== undefined && finalContent !== undefined) {
        touchedRanges = timing.measure("tool_result.format_map", () => mapTouchedRangesThroughFormatting(filePath, afterAgentContent, finalContent, touchedRanges));
        timing.measure("tool_result.notify_file_mutation", () => notifyLspFileMutations(
          lspService,
          runtime,
          [{ type: "changed", filePath }],
        ));
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
        rangeComputation: rangeComputationResult?.computation,
        formatter: summarizeFormatter(formatter),
        applyPatchOperationIndex: index,
        originalPath: pending?.originalPath,
      };

      const afterRefresh = finalContent === undefined
        ? undefined
        : await timing.measureAsync("tool_result.after_diagnostics", () => captureAfterDiagnosticRefresh(lspService, filePath, finalContent, runtime));
      if (afterRefresh?.fresh) {
        timing.measure("tool_result.filter_diagnostics", () => attachDiagnosticFilterFromSnapshots(
          pending?.beforeDiagnostics,
          completed,
          runtime,
          afterRefresh.snapshot,
        ));
      }
      completed.timing = timing.snapshot();
      timing.measure("tool_result.record_completed", () => recordCompletedEdit(runtime, completed));
      completed.timing = timing.snapshot();
      forgetOriginalPathIfMoved(lspService, pending, filePath);
      if (result.type === "delete_file") lspService.forgetFile(filePath);
      if (finalContent !== undefined) {
        const mutationToken = mutationTokens.get(index);
        if (mutationToken) {
          scheduleDelayedDiagnosticsIfNeeded(afterRefresh, lspService, runtime, completed, pending?.beforeDiagnostics, finalContent, mutationToken);
        }
      }
      completedEdits.push(completed);
      timingsByEditId.set(completed.id, timing);
    }
  } finally {
    discardApplyPatchPendingBatch(event, runtime);
  }

  return appendInlineFeedbackForEdits(event, completedEdits, runtime, timingsByEditId);
}

function recordApplyPatchMutations(
  event: ToolResultEvent,
  ctx: ToolResultContext,
  runtime: CodeFeedbackRuntime,
  indexedResults: readonly IndexedApplyPatchResultInput[],
): { tokens: Map<number, FileMutationToken>; fileMutations: LspFileMutation[] } {
  const tokens = new Map<number, FileMutationToken>();
  const fileMutations: LspFileMutation[] = [];
  const operations = readApplyPatchOperations(event.input);
  for (const { operationIndex: index, result } of indexedResults) {
    if (result.status !== "completed") continue;

    const pendingId = applyPatchOperationId(event.toolCallId, index);
    const pending = runtime.pendingEdits.get(pendingId);
    const resultPath = resolveInputPath({ path: result.path }, ctx.cwd);
    const operation = operations[index];
    const operationPath = operation
      ? resolveInputPath({ path: operation.path }, ctx.cwd)
      : undefined;
    const requestedFinalPath = operation?.type === "update_file" && operation.move_path
      ? resolveInputPath({ path: operation.move_path }, ctx.cwd)
      : operationPath;
    const finalPath = pending?.filePath ?? resultPath ?? requestedFinalPath;
    if (finalPath && shouldTrackFile(finalPath, runtime.projectRoot)) {
      tokens.set(index, recordFileMutation(runtime, finalPath));
    }

    const originalPath = pending?.originalPath ?? operationPath;
    if (
      originalPath &&
      (!finalPath || !pathEquals(originalPath, finalPath)) &&
      shouldTrackFile(originalPath, runtime.projectRoot)
    ) {
      recordFileMutation(runtime, originalPath);
    }

    const finalTracked = finalPath !== undefined && shouldTrackFile(finalPath, runtime.projectRoot);
    const originalTracked = originalPath !== undefined && shouldTrackFile(originalPath, runtime.projectRoot);
    const moved = originalPath !== undefined && finalPath !== undefined && !pathEquals(originalPath, finalPath);
    if (result.type === "delete_file") {
      if (originalTracked && originalPath) fileMutations.push({ type: "deleted", filePath: originalPath });
    } else if (moved && originalPath && finalPath) {
      if (originalTracked && finalTracked) {
        fileMutations.push({ type: "renamed", oldFilePath: originalPath, newFilePath: finalPath });
      } else if (originalTracked) {
        fileMutations.push({ type: "deleted", filePath: originalPath });
      } else if (finalTracked) {
        fileMutations.push({ type: "created", filePath: finalPath });
      }
    } else if (finalTracked && finalPath) {
      fileMutations.push({ type: result.type === "create_file" ? "created" : "changed", filePath: finalPath });
    }
  }
  return { tokens, fileMutations };
}

function simpleToolFileMutation(
  toolName: "write" | "edit",
  filePath: string,
  pending: PendingEdit | undefined,
): LspFileMutation {
  return {
    type: toolName === "write" && pending?.beforeFileExisted === false ? "created" : "changed",
    filePath,
  };
}

function notifyLspFileMutations(
  lspService: LspService,
  runtime: CodeFeedbackRuntime,
  mutations: readonly LspFileMutation[],
): void {
  if (!runtime.config.lsp.enabled || mutations.length === 0) return;
  lspService.notifyFileMutations(mutations);
}

function takeApplyPatchPendingEdit(
  event: ToolResultEvent,
  runtime: CodeFeedbackRuntime,
  operationIndex: number,
): PendingEdit | undefined {
  return takePendingEdit(runtime, applyPatchOperationId(event.toolCallId, operationIndex));
}

function discardApplyPatchPendingBatch(event: ToolResultEvent, runtime: CodeFeedbackRuntime): void {
  discardPendingEditsForToolCall(runtime, event.toolCallId, "apply_patch");
}

function forgetOriginalPathIfMoved(lspService: LspService, pending: PendingEdit | undefined, finalPath: string): void {
  if (!pending?.originalPath) return;
  if (pathEquals(pending.originalPath, finalPath)) return;
  lspService.forgetFile(pending.originalPath);
}

function pathEquals(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function fileReadSkippedReason(result: ReadUtf8Result | undefined): string | undefined {
  if (!result?.skippedReason) return undefined;
  if (result.skippedReason === "missing") return undefined;
  if (result.skippedReason === "too-large") {
    const size = result.size === undefined ? "unknown size" : formatBytes(result.size);
    const limit = result.limitBytes === undefined ? "limit" : formatBytes(result.limitBytes);
    return `skipped large file (${size} > ${limit})`;
  }
  switch (result.skippedReason) {
    case "binary":
      return "skipped binary file";
    case "not-file":
      return "skipped non-regular file";
    case "read-error":
      return "skipped unreadable file";
  }
}

function completedEditWithSkippedExactFeedback(input: {
  pending: PendingEdit | undefined;
  id: string;
  toolName: CompletedEdit["toolName"];
  filePath: string;
  runtime: CodeFeedbackRuntime;
  skippedReason: string;
  applyPatchOperationIndex?: number;
  originalPath?: string;
}): CompletedEdit {
  return {
    id: input.id,
    toolName: input.toolName,
    filePath: input.filePath,
    beforeContent: input.pending?.beforeContent,
    afterContent: undefined,
    touchedRanges: [],
    turnIndex: input.pending?.turnIndex ?? input.runtime.turnIndex,
    writeIndex: input.pending?.writeIndex ?? input.runtime.writeIndex,
    startedAt: input.pending?.startedAt ?? Date.now(),
    completedAt: Date.now(),
    skippedReason: input.skippedReason,
    applyPatchOperationIndex: input.applyPatchOperationIndex,
    originalPath: input.originalPath,
  };
}

async function captureAfterDiagnosticRefresh(
  lspService: LspService,
  filePath: string,
  content: string,
  runtime: CodeFeedbackRuntime,
  signal?: AbortSignal,
): Promise<DiagnosticRefreshResult | undefined> {
  if (!runtime.config.lsp.enabled) return undefined;
  return lspService.diagnosticsForFileDetailed(filePath, content, {
    timeoutMs: runtime.config.strict
      ? runtime.config.diagnostics.timeoutMs
      : Math.min(runtime.config.diagnostics.inlineTimeoutMs, runtime.config.diagnostics.timeoutMs),
    settleMs: runtime.config.strict ? runtime.config.diagnostics.settleMs : 0,
    snapshotScope: inlineDiagnosticSnapshotScope(runtime),
    signal,
  });
}

function inlineDiagnosticSnapshotScope(runtime: CodeFeedbackRuntime): "file" | "workspace" {
  return runtime.config.diagnostics.inline === "all" || runtime.config.diagnostics.includeCrossFileRelated
    ? "workspace"
    : "file";
}

async function maybeFormatFile(
  formatService: FormatService,
  runtime: CodeFeedbackRuntime,
  filePath: string,
  content: string,
  changedByTool: boolean,
): Promise<FormatterResult | undefined> {
  if (!runtime.config.autoFormat) return undefined;
  if (!changedByTool) {
    return {
      changed: false,
      finalContent: content,
      errors: [],
      skippedReason: "unchanged by tool",
      durationMs: 0,
    };
  }
  if (hasPendingEditForFile(runtime, filePath)) {
    return {
      changed: false,
      finalContent: content,
      errors: [],
      skippedReason: "pending sibling edit for same file",
    };
  }
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

function attachDiagnosticFilterFromSnapshots(
  beforeDiagnostics: DiagnosticSnapshot | undefined,
  completed: CompletedEdit,
  runtime: CodeFeedbackRuntime,
  afterDiagnostics: DiagnosticSnapshot,
): void {
  if (runtime.config.diagnostics.inline === "all") {
    completed.diagnosticFilter = allDiagnosticsFilter(afterDiagnostics, runtime.config.diagnostics.maxInline);
    return;
  }

  completed.diagnosticFilter = linkDiagnosticsToTouchedRanges({
    beforeSnapshot: beforeDiagnostics,
    afterSnapshot: afterDiagnostics,
    touchedRanges: completed.touchedRanges,
    maxInline: runtime.config.diagnostics.maxInline,
    includeCrossFileRelated: runtime.config.diagnostics.includeCrossFileRelated,
  });
  if (runtime.config.diagnostics.includeCrossFileRelated) {
    completed.workspaceDelta = workspaceDiagnosticDelta({
      beforeSnapshot: beforeDiagnostics,
      afterSnapshot: afterDiagnostics,
      touchedRanges: completed.touchedRanges,
      linkedDiagnostics: completed.diagnosticFilter.allLinked,
      maxDiagnostics: runtime.config.diagnostics.maxInline,
    });
  }
}

function scheduleDelayedDiagnosticsIfNeeded(
  firstRefresh: DiagnosticRefreshResult | undefined,
  lspService: LspService,
  runtime: CodeFeedbackRuntime,
  completed: CompletedEdit,
  beforeDiagnostics: DiagnosticSnapshot | undefined,
  finalContent: string,
  mutationToken: FileMutationToken,
): void {
  if (!runtime.config.lsp.enabled) return;
  if (runtime.config.diagnostics.inline === "off") return;
  if (!firstRefresh || firstRefresh.fresh) return;
  if (completed.touchedRanges.length === 0) return;
  if (completed.diagnosticFilter?.linked.length) return;
  if (!isFileMutationCurrent(runtime, mutationToken)) return;

  const controller = startDelayedDiagnosticRequest(runtime, mutationToken);
  if (!controller) return;
  const finalContentHash = contentHash(finalContent);

  const delayedStartedAt = Date.now();
  void lspService.diagnosticsForFileDetailed(completed.filePath, finalContent, {
    timeoutMs: Math.max(runtime.config.diagnostics.delayedTimeoutMs, runtime.config.diagnostics.timeoutMs),
    settleMs: runtime.config.diagnostics.settleMs,
    snapshotScope: inlineDiagnosticSnapshotScope(runtime),
    signal: controller.signal,
  }).then((refresh) => {
    completed.timing = addTimingPhase(completed.timing, "delayed.diagnostics", Date.now() - delayedStartedAt);
    if (!runtime.config.enabled || !runtime.config.lsp.enabled) return;
    if (!isFileMutationCurrent(runtime, mutationToken)) return;
    if (!fileContentMatchesHash(completed.filePath, finalContentHash)) return;
    if (!refresh?.fresh) return;

    attachDiagnosticFilterFromSnapshots(beforeDiagnostics, completed, runtime, refresh.snapshot);
    const text = renderDelayedDiagnosticFeedback(runtime, completed);
    if (!text) return;
    const validationContentHashes = delayedFeedbackValidationHashes(completed, runtime.projectRoot);
    if (!validationContentHashes) return;

    enqueueDelayedFeedback(runtime, {
      id: `delayed:${completed.id}`,
      editId: completed.id,
      filePath: completed.filePath,
      mutationGeneration: mutationToken.generation,
      contentHash: finalContentHash,
      validationContentHashes,
      turnIndex: completed.turnIndex,
      writeIndex: completed.writeIndex,
      queuedAt: Date.now(),
      text,
    });
  }).catch((error) => {
    completed.timing = addTimingPhase(completed.timing, "delayed.diagnostics", Date.now() - delayedStartedAt);
    if (controller.signal.aborted) return;
    runtime.lastError = errorMessage(error);
  }).finally(() => {
    finishDelayedDiagnosticRequest(runtime, mutationToken, controller);
  });
}

const MAX_DELAYED_VALIDATION_FILES = 32;

function delayedFeedbackValidationHashes(
  completed: CompletedEdit,
  projectRoot: string,
): Array<{ filePath: string; contentHash: string }> | undefined {
  const diagnosticUris = [
    ...(completed.diagnosticFilter?.linked.map((entry) => entry.diagnostic.uri) ?? []),
    ...(completed.workspaceDelta?.diagnostics.map((diagnostic) => diagnostic.uri) ?? []),
  ];
  const paths = new Set<string>();
  for (const uri of diagnosticUris) {
    const filePath = uriToFilePath(uri);
    if (!filePath) return undefined;
    if (pathEquals(filePath, completed.filePath)) continue;
    if (!shouldTrackFile(filePath, projectRoot)) return undefined;
    paths.add(path.resolve(filePath));
    if (paths.size > MAX_DELAYED_VALIDATION_FILES) return undefined;
  }

  const hashes: Array<{ filePath: string; contentHash: string }> = [];
  for (const filePath of paths) {
    const content = readUtf8IfSmall(filePath).content;
    if (content === undefined) return undefined;
    hashes.push({ filePath, contentHash: contentHash(content) });
  }
  return hashes;
}

function allDiagnosticsFilter(snapshot: DiagnosticSnapshot, maxInline: number): DiagnosticFilterResult {
  const allDiagnostics = flattenDiagnosticSnapshot(snapshot).sort(compareDiagnostics);
  const shownDiagnostics = allDiagnostics.slice(0, Math.max(0, maxInline));
  return {
    linked: shownDiagnostics.map((diagnostic) => ({
      diagnostic,
      linkReason: "all-diagnostics",
      isNewOrWorsened: false,
    })),
    allLinked: allDiagnostics.map((diagnostic) => ({
      diagnostic,
      linkReason: "all-diagnostics",
      isNewOrWorsened: false,
    })),
    summary: {
      totalDiagnostics: allDiagnostics.length,
      linkedDiagnostics: allDiagnostics.length,
      shownDiagnostics: shownDiagnostics.length,
      hiddenUnrelated: 0,
      hiddenByLimit: Math.max(0, allDiagnostics.length - shownDiagnostics.length),
    },
  };
}

function compareDiagnostics(left: LspDiagnostic, right: LspDiagnostic): number {
  return (
    diagnosticSeverityRank(right.severity) - diagnosticSeverityRank(left.severity) ||
    left.uri.localeCompare(right.uri) ||
    left.range.start.line - right.range.start.line ||
    left.range.start.character - right.range.start.character ||
    String(left.code ?? "").localeCompare(String(right.code ?? "")) ||
    left.message.localeCompare(right.message)
  );
}

function appendInlineFeedback(event: FeedbackResultSource, completed: CompletedEdit, runtime: CodeFeedbackRuntime, timing?: TimingRecorder): PiToolResult | void {
  const feedback = timing
    ? timing.measure("tool_result.render", () => renderInlineDiagnosticFeedback(runtime, completed))
    : renderInlineDiagnosticFeedback(runtime, completed);
  if (timing) completed.timing = timing.snapshot();
  if (!feedback) return;
  const isStrictError = runtime.config.strict && completed.diagnosticFilter?.linked.some((linked) => linked.diagnostic.severity === "error");
  const result: PiToolResult = {
    content: [...(event.content ?? []), { type: "text", text: feedback }],
  };
  if (isStrictError) result.isError = true;
  const details = appendCodeFeedbackDetails(event.details, runtime, feedback, [completed]);
  if (details !== undefined) result.details = details;
  return result;
}

function appendInlineFeedbackForEdits(
  event: FeedbackResultSource,
  completedEdits: CompletedEdit[],
  runtime: CodeFeedbackRuntime,
  timingsByEditId?: Map<string, TimingRecorder>,
): PiToolResult | void {
  const renderedFeedback = completedEdits
    .map((edit) => {
      const timing = timingsByEditId?.get(edit.id);
      const text = timing
        ? timing.measure("tool_result.render", () => renderInlineDiagnosticFeedback(runtime, edit))
        : renderInlineDiagnosticFeedback(runtime, edit);
      if (timing) edit.timing = timing.snapshot();
      return { edit, text };
    })
    .filter((entry): entry is { edit: CompletedEdit; text: string } => entry.text !== undefined);
  if (renderedFeedback.length === 0) return;

  const feedback = renderedFeedback.map((entry) => entry.text).join("\n\n");
  const feedbackEdits = renderedFeedback.map((entry) => entry.edit);

  const isStrictError = runtime.config.strict && completedEdits.some((edit) => edit.diagnosticFilter?.linked.some((linked) => linked.diagnostic.severity === "error"));
  const result: PiToolResult = {
    content: [...(event.content ?? []), { type: "text", text: feedback }],
  };
  if (isStrictError) result.isError = true;
  const details = appendCodeFeedbackDetails(event.details, runtime, feedback, feedbackEdits);
  if (details !== undefined) result.details = details;
  return result;
}

function appendCodeFeedbackDetails(
  details: unknown,
  runtime: CodeFeedbackRuntime,
  inlineText: string,
  edits: CompletedEdit[],
): unknown | undefined {
  const feedback: CodeFeedbackToolDetails = {
    version: 1,
    inlineText,
    edits: edits.map((edit) => toCodeFeedbackEditDetails(runtime, edit)),
  };

  if (details === undefined) {
    return { [CODE_FEEDBACK_DETAILS_KEY]: feedback };
  }
  if (!isRecord(details)) return undefined;

  return {
    ...details,
    [CODE_FEEDBACK_DETAILS_KEY]: feedback,
  };
}

function toCodeFeedbackEditDetails(runtime: CodeFeedbackRuntime, edit: CompletedEdit): CodeFeedbackEditDetails {
  const displayPath = displayPathFromRoot(edit.filePath, runtime.projectRoot);
  const filter = edit.diagnosticFilter;
  return {
    id: edit.id,
    toolName: edit.toolName,
    filePath: edit.filePath,
    displayPath,
    touchedRanges: edit.touchedRanges,
    rangeComputation: edit.rangeComputation,
    timing: edit.timing,
    formatter: edit.formatter,
    diagnostics: filter
      ? {
          label: runtime.config.diagnostics.inline === "all" ? "diagnostics" : "touched diagnostics",
          linked: filter.linked,
          summary: filter.summary,
        }
      : undefined,
    workspaceDelta: edit.workspaceDelta,
  };
}

function readDetailsDiff(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  const diff = details.diff;
  return typeof diff === "string" && diff.length > 0 ? diff : undefined;
}

function readApplyPatchResults(details: unknown): IndexedApplyPatchResultInput[] {
  if (!isRecord(details)) return [];
  const done = details;
  if (done.stage !== "done" || !Array.isArray(done.results)) return [];
  return done.results.flatMap((result, operationIndex) => (
    isApplyPatchResultInput(result) ? [{ operationIndex, result }] : []
  ));
}

function isApplyPatchResultInput(value: unknown): value is ApplyPatchResultInput {
  if (!isRecord(value)) return false;
  const result = value;
  return (
    (result.type === "create_file" || result.type === "update_file" || result.type === "delete_file") &&
    typeof result.path === "string" &&
    (result.status === "completed" || result.status === "failed") &&
    (result.change === undefined || isApplyPatchChangeInput(result.change))
  );
}

function isApplyPatchChangeInput(value: unknown): value is ApplyPatchChangeInput {
  if (!isRecord(value)) return false;
  const change = value;
  if (change.type === "add" || change.type === "delete") {
    return typeof change.content === "string";
  }
  if (change.type === "update") {
    return (
      typeof change.unifiedDiff === "string" &&
      (change.movePath === undefined || typeof change.movePath === "string")
    );
  }
  return false;
}

interface ApplyPatchResultInput {
  type: "create_file" | "update_file" | "delete_file";
  path: string;
  status: "completed" | "failed";
  change?: ApplyPatchChangeInput;
}

interface IndexedApplyPatchResultInput {
  operationIndex: number;
  result: ApplyPatchResultInput;
}

type ApplyPatchChangeInput =
  | { type: "add"; content: string }
  | { type: "delete"; content: string }
  | { type: "update"; unifiedDiff: string; movePath?: string };

