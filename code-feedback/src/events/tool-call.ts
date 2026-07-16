import { readUtf8IfSmall } from "../fs.ts";
import type { LspService } from "../lsp/service.ts";
import { resolveInputPath, shouldTrackFile } from "../paths.ts";
import { createTimingRecorder } from "../perf.ts";
import { nextWriteIndex, type CodeFeedbackRuntime } from "../runtime.ts";
import { isRecord, type DiagnosticSnapshot, type PendingEdit } from "../types.ts";

export interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  input?: unknown;
}

export interface ToolCallContext {
  cwd: string;
}

export async function handleToolCall(event: ToolCallEvent, ctx: ToolCallContext, runtime: CodeFeedbackRuntime, lspService: LspService): Promise<void> {
  if (!runtime.config.enabled) return;
  if (!runtime.projectTrusted) return;
  if (event.toolName === "apply_patch") {
    await handleApplyPatchToolCall(event, ctx, runtime, lspService);
    return;
  }

  if (event.toolName !== "write" && event.toolName !== "edit") return;

  const filePath = resolveInputPath(event.input, ctx.cwd);
  if (!filePath || !shouldTrackFile(filePath, runtime.projectRoot)) return;

  const writeIndex = nextWriteIndex(runtime);
  const timing = createTimingRecorder();
  const beforeRead = timing.measure("tool_call.read_before", () => readUtf8IfSmall(filePath));
  const beforeContent = beforeRead.content;
  const edit: PendingEdit = {
    id: event.toolCallId,
    toolName: event.toolName,
    filePath,
    beforeContent,
    beforeFileExisted: beforeRead.skippedReason !== "missing",
    beforeDiagnostics: timing.measure("tool_call.before_diagnostics_cache", () => captureBeforeDiagnostics(lspService, filePath, beforeContent, runtime)),
    turnIndex: runtime.turnIndex,
    writeIndex,
    startedAt: Date.now(),
  };

  timing.measure("tool_call.record_pending", () => runtime.pendingEdits.set(edit.id, edit));
  timing.measure("tool_call.prewarm", () => prewarmDiagnostics(lspService, filePath, beforeContent, runtime));
  edit.timing = timing.snapshot();
}

async function handleApplyPatchToolCall(event: ToolCallEvent, ctx: ToolCallContext, runtime: CodeFeedbackRuntime, lspService: LspService): Promise<void> {
  const operations = readApplyPatchOperations(event.input);
  if (operations.length === 0) return;

  const writeIndex = nextWriteIndex(runtime);
  for (const [index, operation] of operations.entries()) {
    const timing = createTimingRecorder();
    const operationPath = resolvePatchPath(operation.path, ctx.cwd);
    const finalPath = operation.type === "update_file" && operation.move_path
      ? resolvePatchPath(operation.move_path, ctx.cwd)
      : operationPath;
    if (!operationPath || !finalPath) continue;
    if (!shouldTrackFile(operationPath, runtime.projectRoot) && !shouldTrackFile(finalPath, runtime.projectRoot)) continue;

    const id = applyPatchOperationId(event.toolCallId, index);
    const beforeRead = timing.measure("tool_call.read_before", () => readUtf8IfSmall(operationPath));
    const beforeContent = beforeRead.content;
    const edit: PendingEdit = {
      id,
      toolName: "apply_patch",
      filePath: finalPath,
      beforeContent,
      beforeFileExisted: beforeRead.skippedReason !== "missing",
      beforeDiagnostics: timing.measure("tool_call.before_diagnostics_cache", () => captureBeforeDiagnostics(lspService, operationPath, beforeContent, runtime)),
      turnIndex: runtime.turnIndex,
      writeIndex,
      startedAt: Date.now(),
      applyPatchOperationIndex: index,
      originalPath: operationPath,
    };

    timing.measure("tool_call.record_pending", () => runtime.pendingEdits.set(edit.id, edit));
    timing.measure("tool_call.prewarm", () => prewarmDiagnostics(lspService, operationPath, beforeContent, runtime));
    edit.timing = timing.snapshot();
  }
}

function captureBeforeDiagnostics(
  lspService: LspService,
  filePath: string,
  content: string | undefined,
  runtime: CodeFeedbackRuntime,
): DiagnosticSnapshot | undefined {
  if (content === undefined) return undefined;
  if (!runtime.config.lsp.enabled) return undefined;
  const snapshotScope = runtime.config.diagnostics.inline === "all" || runtime.config.diagnostics.includeCrossFileRelated
    ? "workspace"
    : "file";
  return lspService.cachedDiagnosticsIfKnown(filePath, undefined, snapshotScope);
}

function prewarmDiagnostics(
  lspService: LspService,
  filePath: string,
  content: string | undefined,
  runtime: CodeFeedbackRuntime,
): void {
  if (content === undefined) return;
  if (!runtime.config.lsp.enabled) return;
  lspService.prewarm(filePath);
}

export function applyPatchOperationId(toolCallId: string, operationIndex: number): string {
  return `${toolCallId}:${operationIndex}`;
}

export function readApplyPatchOperations(input: unknown): ApplyPatchOperationInput[] {
  if (!isRecord(input)) return [];
  const operations = input.operations;
  if (!Array.isArray(operations)) return [];
  return operations.every(isApplyPatchOperationInput) ? operations : [];
}

function isApplyPatchOperationInput(value: unknown): value is ApplyPatchOperationInput {
  if (!isRecord(value)) return false;
  const operation = value;
  return (
    (operation.type === "create_file" || operation.type === "update_file" || operation.type === "delete_file") &&
    typeof operation.path === "string" &&
    (operation.move_path === undefined || typeof operation.move_path === "string")
  );
}

function resolvePatchPath(rawPath: string | undefined, cwd: string): string | undefined {
  if (!rawPath) return undefined;
  return resolveInputPath({ path: rawPath }, cwd);
}

export interface ApplyPatchOperationInput {
  type: "create_file" | "update_file" | "delete_file";
  path: string;
  move_path?: string;
}

