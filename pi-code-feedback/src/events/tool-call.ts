import { readUtf8IfSmall } from "../fs.ts";
import type { LspService } from "../lsp/service.ts";
import { resolveInputPath, shouldTrackFile } from "../paths.ts";
import { createTimingRecorder } from "../perf.ts";
import { nextWriteIndex, recordPendingEdit, type CodeFeedbackRuntime } from "../runtime.ts";
import type { DiagnosticSnapshot } from "../types.ts";
import type { PendingEdit } from "../types.ts";

export interface ToolCallEvent {
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
}

export interface ToolCallContext {
  cwd?: string;
}

export async function handleToolCall(event: ToolCallEvent, ctx: ToolCallContext, runtime: CodeFeedbackRuntime, lspService?: LspService): Promise<void> {
  if (!runtime.config.enabled) return;
  if (event.toolName === "apply_patch") {
    await handleApplyPatchToolCall(event, ctx, runtime, lspService);
    return;
  }

  if (event.toolName !== "write" && event.toolName !== "edit") return;

  const filePath = resolveInputPath(event.input, ctx.cwd, runtime.projectRoot);
  if (!filePath || !shouldTrackFile(filePath, runtime.projectRoot)) return;

  const writeIndex = nextWriteIndex(runtime);
  const id = event.toolCallId || fallbackEditId(event.toolName, filePath, runtime.turnIndex, writeIndex);
  const timing = createTimingRecorder();
  const beforeContent = timing.measure("tool_call.read_before", () => readUtf8IfSmall(filePath).content);
  const edit: PendingEdit = {
    id,
    toolName: event.toolName,
    filePath,
    beforeContent,
    beforeDiagnostics: timing.measure("tool_call.before_diagnostics_cache", () => captureBeforeDiagnostics(lspService, filePath, beforeContent, runtime)),
    turnIndex: runtime.turnIndex,
    writeIndex,
    startedAt: Date.now(),
  };

  timing.measure("tool_call.record_pending", () => recordPendingEdit(runtime, edit));
  timing.measure("tool_call.prewarm", () => prewarmDiagnostics(lspService, filePath, beforeContent, runtime));
  edit.timing = timing.snapshot();
}

function fallbackEditId(toolName: "write" | "edit", filePath: string, turnIndex: number, writeIndex: number): string {
  return `${turnIndex}:${writeIndex}:${toolName}:${filePath}`;
}

async function handleApplyPatchToolCall(event: ToolCallEvent, ctx: ToolCallContext, runtime: CodeFeedbackRuntime, lspService?: LspService): Promise<void> {
  const operations = readApplyPatchOperations(event.input);
  if (operations.length === 0) return;

  const writeIndex = nextWriteIndex(runtime);
  for (const [index, operation] of operations.entries()) {
    const timing = createTimingRecorder();
    const operationPath = resolvePatchPath(operation.path, ctx.cwd, runtime.projectRoot);
    const finalPath = operation.type === "update_file" && operation.move_path
      ? resolvePatchPath(operation.move_path, ctx.cwd, runtime.projectRoot)
      : operationPath;
    if (!operationPath || !finalPath) continue;
    if (!shouldTrackFile(operationPath, runtime.projectRoot) && !shouldTrackFile(finalPath, runtime.projectRoot)) continue;

    const id = applyPatchOperationId(event.toolCallId, runtime.turnIndex, writeIndex, index);
    const beforeContent = timing.measure("tool_call.read_before", () => readUtf8IfSmall(operationPath).content);
    const edit: PendingEdit = {
      id,
      toolName: "apply_patch",
      filePath: finalPath,
      beforeContent,
      beforeDiagnostics: timing.measure("tool_call.before_diagnostics_cache", () => captureBeforeDiagnostics(lspService, operationPath, beforeContent, runtime)),
      turnIndex: runtime.turnIndex,
      writeIndex,
      startedAt: Date.now(),
      applyPatchOperationIndex: index,
      originalPath: operationPath,
    };

    timing.measure("tool_call.record_pending", () => recordPendingEdit(runtime, edit));
    timing.measure("tool_call.prewarm", () => prewarmDiagnostics(lspService, operationPath, beforeContent, runtime));
    edit.timing = timing.snapshot();
  }
}

function captureBeforeDiagnostics(
  lspService: LspService | undefined,
  filePath: string,
  content: string | undefined,
  runtime: CodeFeedbackRuntime,
): DiagnosticSnapshot | undefined {
  if (!lspService || content === undefined) return undefined;
  if (!runtime.config.lsp.enabled) return undefined;
  return lspService.cachedDiagnosticsIfKnown(filePath);
}

function prewarmDiagnostics(
  lspService: LspService | undefined,
  filePath: string,
  content: string | undefined,
  runtime: CodeFeedbackRuntime,
): void {
  if (!lspService || content === undefined) return;
  if (!runtime.config.lsp.enabled) return;
  lspService.prewarm(filePath);
}

export function applyPatchOperationId(toolCallId: string | undefined, turnIndex: number, writeIndex: number, operationIndex: number): string {
  return `${toolCallId || `${turnIndex}:${writeIndex}:apply_patch`}:${operationIndex}`;
}

export function readApplyPatchOperations(input: unknown): ApplyPatchOperationInput[] {
  if (!input || typeof input !== "object") return [];
  const operations = (input as { operations?: unknown }).operations;
  if (!Array.isArray(operations)) return [];
  return operations.filter(isApplyPatchOperationInput);
}

function isApplyPatchOperationInput(value: unknown): value is ApplyPatchOperationInput {
  if (!value || typeof value !== "object") return false;
  const operation = value as { type?: unknown; path?: unknown; move_path?: unknown };
  return (
    (operation.type === "create_file" || operation.type === "update_file" || operation.type === "delete_file") &&
    typeof operation.path === "string" &&
    (operation.move_path === undefined || typeof operation.move_path === "string")
  );
}

function resolvePatchPath(rawPath: string | undefined, cwd: string | undefined, projectRoot: string): string | undefined {
  if (!rawPath) return undefined;
  return resolveInputPath({ path: rawPath }, cwd, projectRoot);
}

export interface ApplyPatchOperationInput {
  type: "create_file" | "update_file" | "delete_file";
  path: string;
  move_path?: string;
}

