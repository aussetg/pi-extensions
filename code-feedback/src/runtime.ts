import { createHash } from "node:crypto";
import * as path from "node:path";
import type { FormatService } from "./format/service.ts";
import { readUtf8IfSmall } from "./fs.ts";
import type { LanguageServerConfiguration } from "./lsp/server-config.ts";
import type { LspService } from "./lsp/service.ts";
import type { CompletedEdit, DelayedDiagnosticFeedback, FeedbackConfig, PendingEdit, TrackedToolName } from "./types.ts";

export interface FileMutationToken {
  filePath: string;
  generation: number;
}

interface ActiveDelayedDiagnosticRequest {
  generation: number;
  controller: AbortController;
}

const MAX_TRACKED_FILE_MUTATIONS = 1_000;

export interface CodeFeedbackRuntime {
  config: FeedbackConfig;
  projectRoot: string;
  turnIndex: number;
  writeIndex: number;
  lspRestartCount: number;
  lastLspRestartAt?: number;
  lastReloadReason?: string;
  lastError?: string;
  projectTrusted: boolean;
  trustedEnvironmentRoots: string[];
  pendingEdits: Map<string, PendingEdit>;
  completedEdits: CompletedEdit[];
  delayedFeedback: DelayedDiagnosticFeedback[];
  fileMutationCounter: number;
  fileMutationGenerations: Map<string, number>;
  delayedDiagnosticRequests: Map<string, ActiveDelayedDiagnosticRequest>;
}

export function createRuntime(config: FeedbackConfig): CodeFeedbackRuntime {
  return {
    config,
    projectRoot: process.cwd(),
    turnIndex: 0,
    writeIndex: 0,
    lspRestartCount: 0,
    projectTrusted: true,
    trustedEnvironmentRoots: [],
    pendingEdits: new Map(),
    completedEdits: [],
    delayedFeedback: [],
    fileMutationCounter: 0,
    fileMutationGenerations: new Map(),
    delayedDiagnosticRequests: new Map(),
  };
}

export function setProjectRoot(runtime: CodeFeedbackRuntime, cwd: string): void {
  const projectRoot = path.resolve(cwd);
  if (projectRoot !== runtime.projectRoot) {
    cancelDelayedDiagnostics(runtime);
    runtime.fileMutationGenerations.clear();
  }
  runtime.projectRoot = projectRoot;
}

export function setProjectTrust(runtime: CodeFeedbackRuntime, ctx: { isProjectTrusted(): boolean }): void {
  const trusted = ctx.isProjectTrusted();
  if (runtime.projectTrusted && !trusted) cancelDelayedDiagnostics(runtime);
  runtime.projectTrusted = trusted;
}

export function configureFeedbackServices(
  runtime: CodeFeedbackRuntime,
  lspService: LspService,
  formatService: FormatService,
  serverConfiguration?: LanguageServerConfiguration,
): void {
  lspService.configure({
    projectRoot: runtime.projectRoot,
    trustedEnvironmentRoots: runtime.trustedEnvironmentRoots,
    idleTimeoutMs: runtime.config.lsp.idleTimeoutMs,
    maxActiveClients: runtime.config.lsp.maxActiveClients,
    initializationConcurrency: runtime.config.lsp.initializationConcurrency,
    diagnosticRefreshConcurrency: runtime.config.lsp.diagnosticRefreshConcurrency,
    serverConfiguration,
  });
  formatService.configure({
    projectRoot: runtime.projectRoot,
    trustedEnvironmentRoots: runtime.trustedEnvironmentRoots,
  });
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

export function takePendingEdit(
  runtime: CodeFeedbackRuntime,
  id: string,
): PendingEdit | undefined {
  const edit = runtime.pendingEdits.get(id);
  if (!edit) return undefined;
  runtime.pendingEdits.delete(id);
  return edit;
}

export function discardPendingEditsForToolCall(
  runtime: CodeFeedbackRuntime,
  toolCallId: string,
  toolName: TrackedToolName,
): PendingEdit[] {
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

export function recordFileMutation(runtime: CodeFeedbackRuntime, filePath: string): FileMutationToken {
  const resolved = path.resolve(filePath);
  runtime.fileMutationCounter += 1;
  const generation = runtime.fileMutationCounter;
  runtime.fileMutationGenerations.delete(resolved);
  runtime.fileMutationGenerations.set(resolved, generation);
  while (runtime.fileMutationGenerations.size > MAX_TRACKED_FILE_MUTATIONS) {
    const oldest = runtime.fileMutationGenerations.keys().next().value;
    if (oldest === undefined) break;
    runtime.fileMutationGenerations.delete(oldest);
  }

  const active = runtime.delayedDiagnosticRequests.get(resolved);
  if (active) {
    runtime.delayedDiagnosticRequests.delete(resolved);
    active.controller.abort();
  }
  if (runtime.delayedFeedback.length > 0) {
    runtime.delayedFeedback = runtime.delayedFeedback.filter((feedback) => !delayedFeedbackReferencesFile(feedback, resolved));
  }

  return { filePath: resolved, generation };
}

export function isFileMutationCurrent(runtime: CodeFeedbackRuntime, token: FileMutationToken): boolean {
  const resolved = path.resolve(token.filePath);
  return (runtime.fileMutationGenerations.get(resolved) ?? 0) === token.generation;
}

export function startDelayedDiagnosticRequest(
  runtime: CodeFeedbackRuntime,
  token: FileMutationToken,
): AbortController | undefined {
  if (!isFileMutationCurrent(runtime, token)) return undefined;

  const resolved = path.resolve(token.filePath);
  const existing = runtime.delayedDiagnosticRequests.get(resolved);
  if (existing) existing.controller.abort();

  const controller = new AbortController();
  runtime.delayedDiagnosticRequests.set(resolved, {
    generation: token.generation,
    controller,
  });
  return controller;
}

export function finishDelayedDiagnosticRequest(
  runtime: CodeFeedbackRuntime,
  token: FileMutationToken,
  controller: AbortController,
): void {
  const resolved = path.resolve(token.filePath);
  const active = runtime.delayedDiagnosticRequests.get(resolved);
  if (active?.generation === token.generation && active.controller === controller) {
    runtime.delayedDiagnosticRequests.delete(resolved);
  }
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("base64url");
}

export function fileContentMatchesHash(filePath: string, expectedHash: string): boolean {
  const content = readUtf8IfSmall(path.resolve(filePath)).content;
  return content !== undefined && contentHash(content) === expectedHash;
}

export function enqueueDelayedFeedback(runtime: CodeFeedbackRuntime, feedback: DelayedDiagnosticFeedback): boolean {
  if (!isDelayedFeedbackCurrent(runtime, feedback)) return false;

  const existingIndex = runtime.delayedFeedback.findIndex((candidate) => candidate.id === feedback.id);
  if (existingIndex >= 0) {
    runtime.delayedFeedback.splice(existingIndex, 1, feedback);
  } else {
    runtime.delayedFeedback.push(feedback);
  }

  if (runtime.delayedFeedback.length > 20) {
    runtime.delayedFeedback.splice(0, runtime.delayedFeedback.length - 20);
  }
  return true;
}

export function consumeDelayedFeedback(runtime: CodeFeedbackRuntime, limit = 3): DelayedDiagnosticFeedback[] {
  if (runtime.delayedFeedback.length === 0 || limit <= 0) return [];
  const current: DelayedDiagnosticFeedback[] = [];
  while (runtime.delayedFeedback.length > 0 && current.length < limit) {
    const feedback = runtime.delayedFeedback.shift();
    if (feedback && isDelayedFeedbackCurrent(runtime, feedback)) current.push(feedback);
  }
  return current;
}

export function cancelDelayedDiagnostics(runtime: CodeFeedbackRuntime): void {
  for (const active of runtime.delayedDiagnosticRequests.values()) active.controller.abort();
  runtime.delayedDiagnosticRequests.clear();
  runtime.delayedFeedback = [];
}

export function setLspEnabled(runtime: CodeFeedbackRuntime, enabled: boolean): void {
  runtime.config.lsp.enabled = enabled;
  if (!enabled) cancelDelayedDiagnostics(runtime);
}

export function restartLsp(runtime: CodeFeedbackRuntime, reason: string): void {
  cancelDelayedDiagnostics(runtime);
  runtime.lspRestartCount += 1;
  runtime.lastLspRestartAt = Date.now();
  runtime.lastReloadReason = reason;
}

export function addTrustedEnvironmentRoot(runtime: CodeFeedbackRuntime, root: string): boolean {
  const resolved = path.resolve(root);
  if (runtime.trustedEnvironmentRoots.some((existing) => path.resolve(existing) === resolved)) return false;
  runtime.trustedEnvironmentRoots.push(resolved);
  runtime.trustedEnvironmentRoots.sort((left, right) => left.localeCompare(right));
  return true;
}

export function removeTrustedEnvironmentRoot(runtime: CodeFeedbackRuntime, root: string): boolean {
  const resolved = path.resolve(root);
  const before = runtime.trustedEnvironmentRoots.length;
  runtime.trustedEnvironmentRoots = runtime.trustedEnvironmentRoots.filter((existing) => path.resolve(existing) !== resolved);
  return runtime.trustedEnvironmentRoots.length !== before;
}

export function clearTrustedEnvironmentRoots(runtime: CodeFeedbackRuntime): number {
  const count = runtime.trustedEnvironmentRoots.length;
  runtime.trustedEnvironmentRoots = [];
  return count;
}

function isDelayedFeedbackCurrent(runtime: CodeFeedbackRuntime, feedback: DelayedDiagnosticFeedback): boolean {
  const resolved = path.resolve(feedback.filePath);
  if ((runtime.fileMutationGenerations.get(resolved) ?? 0) !== feedback.mutationGeneration) return false;
  if (!fileContentMatchesHash(resolved, feedback.contentHash)) return false;
  return (feedback.validationContentHashes ?? []).every((entry) => fileContentMatchesHash(entry.filePath, entry.contentHash));
}

function delayedFeedbackReferencesFile(feedback: DelayedDiagnosticFeedback, filePath: string): boolean {
  if (path.resolve(feedback.filePath) === filePath) return true;
  return (feedback.validationContentHashes ?? []).some((entry) => path.resolve(entry.filePath) === filePath);
}

