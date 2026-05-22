import { readUtf8IfExists } from "../fs.ts";
import type { LspService } from "../lsp/service.ts";
import { resolveInputPath, shouldTrackFile } from "../paths.ts";
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
  const beforeContent = readUtf8IfExists(filePath);
  const edit: PendingEdit = {
    id,
    toolName: event.toolName,
    filePath,
    beforeContent,
    beforeDiagnostics: await captureBeforeDiagnostics(lspService, filePath, beforeContent, runtime),
    turnIndex: runtime.turnIndex,
    writeIndex,
    startedAt: Date.now(),
  };

  recordPendingEdit(runtime, edit);
}

function fallbackEditId(toolName: "write" | "edit", filePath: string, turnIndex: number, writeIndex: number): string {
  return `${turnIndex}:${writeIndex}:${toolName}:${filePath}`;
}

async function handleApplyPatchToolCall(event: ToolCallEvent, ctx: ToolCallContext, runtime: CodeFeedbackRuntime, lspService?: LspService): Promise<void> {
  const operations = readApplyPatchOperations(event.input);
  if (operations.length === 0) return;

  const writeIndex = nextWriteIndex(runtime);
  for (const [index, operation] of operations.entries()) {
    const operationPath = resolvePatchPath(operation.path, ctx.cwd, runtime.projectRoot);
    const finalPath = operation.type === "update_file" && operation.move_path
      ? resolvePatchPath(operation.move_path, ctx.cwd, runtime.projectRoot)
      : operationPath;
    if (!operationPath || !finalPath) continue;
    if (!shouldTrackFile(operationPath, runtime.projectRoot) && !shouldTrackFile(finalPath, runtime.projectRoot)) continue;

    const id = applyPatchOperationId(event.toolCallId, runtime.turnIndex, writeIndex, index);
    const beforeContent = readUtf8IfExists(operationPath);
    const edit: PendingEdit = {
      id,
      toolName: "apply_patch",
      filePath: finalPath,
      beforeContent,
      beforeDiagnostics: await captureBeforeDiagnostics(lspService, operationPath, beforeContent, runtime),
      turnIndex: runtime.turnIndex,
      writeIndex,
      startedAt: Date.now(),
      applyPatchOperationIndex: index,
      originalPath: operationPath,
    };

    recordPendingEdit(runtime, edit);
  }
}

async function captureBeforeDiagnostics(
  lspService: LspService | undefined,
  filePath: string,
  content: string | undefined,
  runtime: CodeFeedbackRuntime,
): Promise<DiagnosticSnapshot | undefined> {
  if (!lspService || content === undefined) return undefined;
  if (!runtime.config.lsp.enabled) return undefined;
  return lspService.diagnosticsForFile(filePath, content, {
    timeoutMs: Math.min(400, runtime.config.diagnostics.timeoutMs),
    settleMs: 0,
  });
}

export function applyPatchOperationId(toolCallId: string | undefined, turnIndex: number, writeIndex: number, operationIndex: number): string {
  return `${toolCallId || `${turnIndex}:${writeIndex}:apply_patch`}:${operationIndex}`;
}

function readApplyPatchOperations(input: unknown): ApplyPatchOperationInput[] {
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

interface ApplyPatchOperationInput {
  type: "create_file" | "update_file" | "delete_file";
  path: string;
  move_path?: string;
}

