import * as path from "node:path";
import type { CompletedEdit, DelayedDiagnosticFeedback, FeedbackConfig, PendingEdit, TrackedToolName } from "./types.ts";

export interface CodeFeedbackRuntime {
  config: FeedbackConfig;
  projectRoot: string;
  turnIndex: number;
  writeIndex: number;
  lspRestartCount: number;
  lastLspRestartAt?: number;
  lastReloadReason?: string;
  lastError?: string;
  pendingEdits: Map<string, PendingEdit>;
  completedEdits: CompletedEdit[];
  delayedFeedback: DelayedDiagnosticFeedback[];
}

export function createRuntime(config: FeedbackConfig): CodeFeedbackRuntime {
  return {
    config,
    projectRoot: fallbackCwd(),
    turnIndex: 0,
    writeIndex: 0,
    lspRestartCount: 0,
    pendingEdits: new Map(),
    completedEdits: [],
    delayedFeedback: [],
  };
}

export function refreshRuntimeConfig(runtime: CodeFeedbackRuntime, config: FeedbackConfig): void {
  runtime.config = config;
}

export function setProjectRoot(runtime: CodeFeedbackRuntime, cwd: string | undefined): void {
  runtime.projectRoot = path.resolve(cwd || fallbackCwd());
}

export function beginTurn(runtime: CodeFeedbackRuntime): void {
  runtime.turnIndex += 1;
  runtime.writeIndex = 0;
  runtime.pendingEdits.clear();
}

export function nextWriteIndex(runtime: CodeFeedbackRuntime): number {
  runtime.writeIndex += 1;
  return runtime.writeIndex;
}

export function recordPendingEdit(runtime: CodeFeedbackRuntime, edit: PendingEdit): void {
  runtime.pendingEdits.set(edit.id, edit);
}

export function takePendingEdit(
  runtime: CodeFeedbackRuntime,
  id: string | undefined,
  filePath: string,
  toolName: TrackedToolName,
): PendingEdit | undefined {
  if (id) {
    const exact = takePendingEditById(runtime, id);
    if (exact) return exact;
  }

  const resolvedFilePath = path.resolve(filePath);
  let fallback: PendingEdit | undefined;
  for (const candidate of runtime.pendingEdits.values()) {
    if (candidate.toolName !== toolName) continue;
    if (path.resolve(candidate.filePath) !== resolvedFilePath) continue;
    if (!fallback || candidate.startedAt > fallback.startedAt) {
      fallback = candidate;
    }
  }
  if (fallback) {
    runtime.pendingEdits.delete(fallback.id);
  }
  return fallback;
}

export function takePendingEditById(runtime: CodeFeedbackRuntime, id: string | undefined): PendingEdit | undefined {
  if (!id) return undefined;
  const edit = runtime.pendingEdits.get(id);
  if (!edit) return undefined;
  runtime.pendingEdits.delete(id);
  return edit;
}

export function discardPendingEditsForToolCall(
  runtime: CodeFeedbackRuntime,
  toolCallId: string | undefined,
  toolName: TrackedToolName,
): PendingEdit[] {
  if (!toolCallId) return [];

  const prefix = `${toolCallId}:`;
  const discarded: PendingEdit[] = [];
  for (const [id, edit] of [...runtime.pendingEdits.entries()]) {
    if (edit.toolName !== toolName) continue;
    if (id !== toolCallId && !id.startsWith(prefix)) continue;
    runtime.pendingEdits.delete(id);
    discarded.push(edit);
  }

  return discarded;
}

export function recordCompletedEdit(runtime: CodeFeedbackRuntime, edit: CompletedEdit): void {
  runtime.completedEdits.push(edit);
  if (runtime.completedEdits.length > 50) {
    runtime.completedEdits.splice(0, runtime.completedEdits.length - 50);
  }
}

export function hasPendingEditForFile(runtime: CodeFeedbackRuntime, filePath: string): boolean {
  const resolved = path.resolve(filePath);
  for (const edit of runtime.pendingEdits.values()) {
    if (path.resolve(edit.filePath) === resolved) return true;
    if (edit.originalPath && path.resolve(edit.originalPath) === resolved) return true;
  }
  return false;
}

export function enqueueDelayedFeedback(runtime: CodeFeedbackRuntime, feedback: DelayedDiagnosticFeedback): void {
  const existingIndex = runtime.delayedFeedback.findIndex((candidate) => candidate.id === feedback.id);
  if (existingIndex >= 0) {
    runtime.delayedFeedback.splice(existingIndex, 1, feedback);
  } else {
    runtime.delayedFeedback.push(feedback);
  }

  if (runtime.delayedFeedback.length > 20) {
    runtime.delayedFeedback.splice(0, runtime.delayedFeedback.length - 20);
  }
}

export function consumeDelayedFeedback(runtime: CodeFeedbackRuntime, limit = 3): DelayedDiagnosticFeedback[] {
  if (runtime.delayedFeedback.length === 0 || limit <= 0) return [];
  return runtime.delayedFeedback.splice(0, limit);
}

export function setLspEnabled(runtime: CodeFeedbackRuntime, enabled: boolean): void {
  runtime.config.lsp.enabled = enabled;
  if (!enabled) runtime.delayedFeedback = [];
}

export function restartLsp(runtime: CodeFeedbackRuntime, reason: string): void {
  runtime.lspRestartCount += 1;
  runtime.lastLspRestartAt = Date.now();
  runtime.lastReloadReason = reason;
}

function fallbackCwd(): string {
  const processLike = (globalThis as { process?: { cwd?: () => string } }).process;
  try {
    return processLike?.cwd?.() ?? ".";
  } catch {
    return ".";
  }
}

