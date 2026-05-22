import * as path from "node:path";
import { linkDiagnosticsToTouchedRanges } from "../diagnostics/provenance.ts";
import { computeTouchedRanges } from "../diagnostics/ranges.ts";
import { readDiagnosticSnapshotFromDetails } from "../diagnostics/snapshots.ts";
import { mapTouchedRangesThroughFormatting } from "../format/mapping.ts";
import type { FormatService } from "../format/service.ts";
import { readUtf8IfExists } from "../fs.ts";
import type { LspService } from "../lsp/service.ts";
import { resolveInputPath, shouldTrackFile } from "../paths.ts";
import { addTimingPhase, createTimingRecorder, type TimingRecorder } from "../perf.ts";
import type { PiToolResult } from "../pi.ts";
import { renderDelayedDiagnosticFeedback, renderInlineDiagnosticFeedback } from "../render.ts";
import { enqueueDelayedFeedback, hasPendingEditForFile, recordCompletedEdit, takePendingEdit, type CodeFeedbackRuntime } from "../runtime.ts";
import {
  CODE_FEEDBACK_DETAILS_KEY,
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
  const toolName = event.toolName;

  const filePath = resolveInputPath(event.input, ctx.cwd, runtime.projectRoot);
  if (!filePath || !shouldTrackFile(filePath, runtime.projectRoot)) return;

  const pending = takePendingEdit(runtime, event.toolCallId, filePath, toolName);
  const timing = createTimingRecorder(pending?.timing);
  if (event.isError) return;

  const afterAgentContent = timing.measure("tool_result.read_after", () => readUtf8IfExists(filePath));
  if (afterAgentContent === undefined) return;

  const detailsDiff = readDetailsDiff(event.details);
  let touchedRanges = timing.measure("tool_result.touched_ranges", () => computeTouchedRanges({
    filePath,
    beforeContent: pending?.beforeContent,
    afterContent: afterAgentContent,
    toolName,
    detailsDiff,
  }));

  const formatter = await timing.measureAsync("tool_result.format", () => maybeFormatFile(formatService, runtime, filePath, afterAgentContent, touchedRanges.length > 0));
  const finalContent = formatter?.finalContent ?? afterAgentContent;
  if (formatter?.changed) {
    touchedRanges = timing.measure("tool_result.format_map", () => mapTouchedRangesThroughFormatting(filePath, afterAgentContent, finalContent, touchedRanges));
  }

  const completed: CompletedEdit = {
    id: pending?.id ?? event.toolCallId ?? `${runtime.turnIndex}:${runtime.writeIndex}:${toolName}:${filePath}:result`,
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
    detailsDiffPresent: detailsDiff !== undefined,
    formatter: summarizeFormatter(formatter),
  };

  const afterRefresh = await timing.measureAsync("tool_result.after_diagnostics", () => captureAfterDiagnosticRefresh(lspService, filePath, finalContent, runtime));
  const afterDiagnostics = afterRefresh?.fresh
    ? afterRefresh.snapshot
    : readDiagnosticSnapshotFromDetails(event.details, ["afterDiagnostics", "postDiagnostics", "diagnostics"]);
  timing.measure("tool_result.filter_diagnostics", () => attachDiagnosticFilter(event, pending, completed, runtime, afterDiagnostics));
  completed.timing = timing.snapshot();
  timing.measure("tool_result.record_completed", () => recordCompletedEdit(runtime, completed));
  completed.timing = timing.snapshot();
  scheduleDelayedDiagnosticsIfNeeded(afterRefresh, lspService, runtime, completed, pending?.beforeDiagnostics, finalContent);
  return appendInlineFeedback(event, completed, runtime, timing);
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
  const timingsByEditId = new Map<string, TimingRecorder>();

  for (const [index, result] of results.entries()) {
    if (result.status !== "completed") continue;

    const resultPath = resolveInputPath({ path: result.path }, ctx.cwd, runtime.projectRoot);
    if (!resultPath) continue;

    const pendingId = applyPatchOperationId(event.toolCallId, runtime.turnIndex, runtime.writeIndex, index);
    const pending = takePendingEdit(runtime, pendingId, resultPath, "apply_patch");
    const timing = createTimingRecorder(pending?.timing);
    const filePath = pending?.filePath ?? resultPath;
    if (!shouldTrackFile(filePath, runtime.projectRoot)) {
      forgetOriginalPathIfMoved(lspService, pending, filePath);
      continue;
    }
    const afterAgentContent = result.type === "delete_file" ? undefined : timing.measure("tool_result.read_after", () => readUtf8IfExists(filePath));
    if (result.type !== "delete_file" && afterAgentContent === undefined) continue;

    const detailsDiff = typeof result.diff === "string" && result.diff.length > 0 ? result.diff : undefined;
    let touchedRanges = afterAgentContent === undefined
      ? []
      : timing.measure("tool_result.touched_ranges", () => computeTouchedRanges({
          filePath,
          beforeContent: pending?.beforeContent,
          afterContent: afterAgentContent,
          toolName: "apply_patch",
          detailsDiff,
        }));

    const formatter = afterAgentContent === undefined ? undefined : await timing.measureAsync("tool_result.format", () => maybeFormatFile(formatService, runtime, filePath, afterAgentContent, touchedRanges.length > 0));
    const finalContent = formatter?.finalContent ?? afterAgentContent;
    if (formatter?.changed && afterAgentContent !== undefined && finalContent !== undefined) {
      touchedRanges = timing.measure("tool_result.format_map", () => mapTouchedRangesThroughFormatting(filePath, afterAgentContent, finalContent, touchedRanges));
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
      : await timing.measureAsync("tool_result.after_diagnostics", () => captureAfterDiagnosticRefresh(lspService, filePath, finalContent, runtime));
    const afterDiagnostics = afterRefresh?.fresh
      ? afterRefresh.snapshot
      : readDiagnosticSnapshotFromDetails(event.details, ["afterDiagnostics", "postDiagnostics", "diagnostics"]);
    timing.measure("tool_result.filter_diagnostics", () => attachDiagnosticFilter(event, pending, completed, runtime, afterDiagnostics));
    completed.timing = timing.snapshot();
    timing.measure("tool_result.record_completed", () => recordCompletedEdit(runtime, completed));
    completed.timing = timing.snapshot();
    forgetOriginalPathIfMoved(lspService, pending, filePath);
    if (result.type === "delete_file") lspService?.forgetFile(filePath);
    if (finalContent !== undefined) {
      scheduleDelayedDiagnosticsIfNeeded(afterRefresh, lspService, runtime, completed, pending?.beforeDiagnostics, finalContent);
    }
    completedEdits.push(completed);
    timingsByEditId.set(completed.id, timing);
  }

  return appendInlineFeedbackForEdits(event, completedEdits, runtime, timingsByEditId);
}

function forgetOriginalPathIfMoved(lspService: LspService | undefined, pending: PendingEdit | undefined, finalPath: string): void {
  if (!lspService || !pending?.originalPath) return;
  if (pathEquals(pending.originalPath, finalPath)) return;
  lspService.forgetFile(pending.originalPath);
}

function pathEquals(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
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
    timeoutMs: inlineDiagnosticTimeoutMs(runtime),
    settleMs: inlineDiagnosticSettleMs(runtime),
  });
}

function inlineDiagnosticTimeoutMs(runtime: CodeFeedbackRuntime): number {
  if (runtime.config.strict) return runtime.config.diagnostics.timeoutMs;
  return Math.min(runtime.config.diagnostics.inlineTimeoutMs, runtime.config.diagnostics.timeoutMs);
}

function inlineDiagnosticSettleMs(runtime: CodeFeedbackRuntime): number {
  return runtime.config.strict ? runtime.config.diagnostics.settleMs : 0;
}

async function maybeFormatFile(
  formatService: FormatService | undefined,
  runtime: CodeFeedbackRuntime,
  filePath: string,
  content: string,
  changedByTool: boolean,
): Promise<FormatterResult | undefined> {
  if (!formatService) return undefined;
  if (!runtime.config.autoFormat || runtime.config.formatMode !== "immediate") return undefined;
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

function attachDiagnosticFilter(
  event: ToolResultEvent,
  pending: PendingEdit | undefined,
  completed: CompletedEdit,
  runtime: CodeFeedbackRuntime,
  afterDiagnostics: DiagnosticSnapshot | undefined,
): void {
  if (!afterDiagnostics) return;
  if (runtime.config.diagnostics.inline === "off") return;

  const beforeDiagnostics = readDiagnosticSnapshotFromDetails(event.details, ["beforeDiagnostics", "preDiagnostics"]);
  attachDiagnosticFilterFromSnapshots(beforeDiagnostics ?? pending?.beforeDiagnostics, completed, runtime, afterDiagnostics);
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
  if (runtime.config.diagnostics.inline === "off") return;
  if (!firstRefresh || firstRefresh.fresh) return;
  if (completed.touchedRanges.length === 0) return;
  if (completed.diagnosticFilter?.linked.length) return;

  const delayedStartedAt = Date.now();
  void lspService.diagnosticsForFileDetailed(completed.filePath, finalContent, {
    timeoutMs: Math.max(runtime.config.diagnostics.delayedTimeoutMs, runtime.config.diagnostics.timeoutMs),
    settleMs: runtime.config.diagnostics.settleMs,
  }).then((refresh) => {
    completed.timing = addTimingPhase(completed.timing, "delayed.diagnostics", Date.now() - delayedStartedAt);
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
    completed.timing = addTimingPhase(completed.timing, "delayed.diagnostics", Date.now() - delayedStartedAt);
    runtime.lastError = error instanceof Error ? error.message : String(error);
  });
}

function allDiagnosticsFilter(snapshot: DiagnosticSnapshot, maxInline: number): DiagnosticFilterResult {
  const allDiagnostics = flattenSnapshot(snapshot).sort(compareDiagnostics);
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

function flattenSnapshot(snapshot: DiagnosticSnapshot): LspDiagnostic[] {
  return [...snapshot.byUri.values()].flat();
}

function compareDiagnostics(left: LspDiagnostic, right: LspDiagnostic): number {
  return (
    severityRank(right.severity) - severityRank(left.severity) ||
    left.uri.localeCompare(right.uri) ||
    left.range.start.line - right.range.start.line ||
    left.range.start.character - right.range.start.character ||
    String(left.code ?? "").localeCompare(String(right.code ?? "")) ||
    left.message.localeCompare(right.message)
  );
}

function severityRank(severity: LspDiagnostic["severity"]): number {
  switch (severity) {
    case "error":
      return 4;
    case "warning":
      return 3;
    case "information":
      return 2;
    case "hint":
      return 1;
  }
}

function appendInlineFeedback(event: ToolResultEvent, completed: CompletedEdit, runtime: CodeFeedbackRuntime, timing?: TimingRecorder): PiToolResult | void {
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
  event: ToolResultEvent,
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
  if (!isObjectDetails(details)) return undefined;

  return {
    ...details,
    [CODE_FEEDBACK_DETAILS_KEY]: feedback,
  };
}

function isObjectDetails(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toCodeFeedbackEditDetails(runtime: CodeFeedbackRuntime, edit: CompletedEdit): CodeFeedbackEditDetails {
  const displayPath = path.relative(runtime.projectRoot, edit.filePath) || edit.filePath;
  const filter = edit.diagnosticFilter;
  return {
    id: edit.id,
    toolName: edit.toolName,
    filePath: edit.filePath,
    displayPath,
    touchedRanges: edit.touchedRanges,
    timing: edit.timing,
    formatter: edit.formatter,
    diagnostics: filter
      ? {
          label: runtime.config.diagnostics.inline === "all" ? "diagnostics" : "touched diagnostics",
          linked: filter.linked,
          summary: filter.summary,
        }
      : undefined,
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

