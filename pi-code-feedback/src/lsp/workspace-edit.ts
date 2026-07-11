import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { LSP_RESULT_CODE_ACTION_CAN_RESOLVE_KEY, LSP_RESULT_SERVER_ID_KEY, LSP_RESULT_SERVER_SESSION_ID_KEY } from "../types.ts";
import { isLspPosition, isLspRange, uriToFilePath, type LspPosition, type LspRange } from "./positions.ts";

export type FileMutationQueue = <T>(filePath: string, run: () => Promise<T>) => Promise<T>;

export interface AppliedTextEdit {
  filePath: string;
  editCount: number;
  changed: boolean;
}

export interface WorkspaceEditApplyResult {
  applied: boolean;
  files: AppliedTextEdit[];
  editCount: number;
  changedFiles: string[];
  rejected?: string;
  rollbackFailedFiles?: string[];
}

export interface WorkspaceEditFileState {
  filePath: string;
  exists: boolean;
  sha256?: string;
  bytes?: number;
  mode?: number;
}

export interface WorkspaceEditApplyOptions {
  expectedFileStates?: readonly WorkspaceEditFileState[];
  getDocumentVersion?: (filePath: string) => number | undefined;
  mutationQueue?: FileMutationQueue;
}

export type WorkspaceEditTargetFilesResult =
  | { ok: true; files: string[]; resourceOperations: number }
  | { ok: false; files: string[]; reason: string; resourceOperations: number };

interface TextEditInput {
  range?: LspRange;
  newText?: unknown;
}

interface CollectedEdit {
  range: LspRange;
  newText: string;
}

interface ResolvedEdit {
  start: number;
  end: number;
  newText: string;
  index: number;
}

interface PlannedFileEdit extends AppliedTextEdit {
  before: string;
  after: string;
  mode: number;
}

interface StagedFileEdit {
  plan: PlannedFileEdit;
  tempPath: string;
}

interface CollectedWorkspaceEdit {
  editsByPath: Map<string, CollectedEdit[]>;
  versionsByPath: Map<string, number>;
  resourceOperations: number;
}

const localMutationQueues = new Map<string, Promise<void>>();

export function isWorkspaceEdit(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isRecord(value.changes) || Array.isArray(value.documentChanges);
}

export function workspaceEditSummary(value: unknown): { files: number; edits: number; resourceOperations: number } {
  const grouped = collectTextEdits(value, process.cwd(), { validateProjectRoot: false });
  if (!grouped.ok) {
    return { files: 0, edits: 0, resourceOperations: grouped.resourceOperations };
  }
  let edits = 0;
  for (const fileEdits of grouped.editsByPath.values()) edits += fileEdits.length;
  return { files: grouped.editsByPath.size, edits, resourceOperations: grouped.resourceOperations };
}

export function workspaceEditTargetFiles(value: unknown, projectRoot: string): WorkspaceEditTargetFilesResult {
  const collected = collectTextEdits(value, projectRoot, { validateProjectRoot: true });
  if (!collected.ok) {
    return {
      ok: false,
      files: [],
      reason: collected.reason,
      resourceOperations: collected.resourceOperations,
    };
  }

  return {
    ok: true,
    files: [...collected.editsByPath.keys()],
    resourceOperations: collected.resourceOperations,
  };
}

export function readWorkspaceEditFileState(filePath: string): WorkspaceEditFileState {
  let resolved = path.resolve(filePath);
  try {
    resolved = fs.realpathSync(resolved);
    const stat = fs.statSync(resolved);
    const content = fs.readFileSync(resolved);
    return {
      filePath: resolved,
      exists: true,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: content.byteLength,
      mode: stat.mode & 0o777,
    };
  } catch {
    return { filePath: resolved, exists: false };
  }
}

export function sameWorkspaceEditFileState(left: WorkspaceEditFileState, right: WorkspaceEditFileState): boolean {
  return (
    path.resolve(left.filePath) === path.resolve(right.filePath) &&
    left.exists === right.exists &&
    left.sha256 === right.sha256 &&
    left.mode === right.mode
  );
}

export async function applyWorkspaceEdit(
  value: unknown,
  projectRoot: string,
  options: WorkspaceEditApplyOptions = {},
): Promise<WorkspaceEditApplyResult> {
  const collected = collectTextEdits(value, projectRoot, { validateProjectRoot: true });
  if (!collected.ok) {
    return rejectedApply(collected.reason);
  }

  const lockPaths = uniqueSortedPaths([
    ...collected.editsByPath.keys(),
    ...(options.expectedFileStates ?? []).map((state) => state.filePath),
  ]);

  try {
    return await withMutationQueues(lockPaths, options.mutationQueue ?? withLocalMutationQueue, () => applyCollectedWorkspaceEdit(collected, options));
  } catch (error) {
    return rejectedApply(errorMessage(error));
  }
}

function applyCollectedWorkspaceEdit(
  collected: CollectedWorkspaceEdit,
  options: WorkspaceEditApplyOptions,
): WorkspaceEditApplyResult {
  const staleReason = validateExpectedFileStates(options.expectedFileStates, collected.editsByPath.keys());
  if (staleReason) return rejectedApply(staleReason);

  const versionReason = validateDocumentVersions(collected.versionsByPath, options.getDocumentVersion);
  if (versionReason) return rejectedApply(versionReason);

  let planned: PlannedFileEdit[];
  try {
    planned = planWorkspaceEdit(collected.editsByPath);
  } catch (error) {
    return rejectedApply(errorMessage(error));
  }

  let staged: StagedFileEdit[] = [];
  try {
    for (const file of planned) {
      if (file.changed) staged.push(stageFileEdit(file));
    }
  } catch (error) {
    cleanupStagedFiles(staged);
    return rejectedApply(`Could not stage WorkspaceEdit: ${errorMessage(error)}`);
  }

  const changedWhileStaging = planned.find((file) => !samePlannedFileState(file));
  if (changedWhileStaging) {
    cleanupStagedFiles(staged);
    return rejectedApply(`WorkspaceEdit target changed before commit: ${changedWhileStaging.filePath}`);
  }

  const committed: StagedFileEdit[] = [];
  try {
    for (const file of staged) {
      fs.renameSync(file.tempPath, file.plan.filePath);
      committed.push(file);
    }
  } catch (error) {
    const rollbackFailedFiles = rollbackCommittedFiles(committed);
    cleanupStagedFiles(staged);
    const rollback = rollbackFailedFiles.length > 0
      ? `; rollback failed for: ${rollbackFailedFiles.join(", ")}`
      : "; committed files were rolled back";
    return {
      ...rejectedApply(`WorkspaceEdit commit failed: ${errorMessage(error)}${rollback}`),
      changedFiles: rollbackFailedFiles,
      rollbackFailedFiles: rollbackFailedFiles.length > 0 ? rollbackFailedFiles : undefined,
    };
  }

  cleanupStagedFiles(staged);

  return {
    applied: true,
    files: planned.map(({ filePath, editCount, changed }) => ({ filePath, editCount, changed })),
    editCount: planned.reduce((count, file) => count + file.editCount, 0),
    changedFiles: planned.filter((file) => file.changed).map((file) => file.filePath),
  };
}

function planWorkspaceEdit(editsByPath: Map<string, CollectedEdit[]>): PlannedFileEdit[] {
  const planned: PlannedFileEdit[] = [];
  for (const [filePath, edits] of editsByPath) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error(`WorkspaceEdit target is not a regular file: ${filePath}`);
    const before = fs.readFileSync(filePath, "utf8");
    const after = applyTextEditsToContent(before, edits, filePath);
    planned.push({ filePath, editCount: edits.length, changed: after !== before, before, after, mode: stat.mode & 0o777 });
  }
  return planned;
}

async function withMutationQueues<T>(
  filePaths: string[],
  mutationQueue: FileMutationQueue,
  run: () => Promise<T> | T,
  index = 0,
): Promise<T> {
  const filePath = filePaths[index];
  if (!filePath) return run();
  return mutationQueue(filePath, () => withMutationQueues(filePaths, mutationQueue, run, index + 1));
}

async function withLocalMutationQueue<T>(filePath: string, run: () => Promise<T>): Promise<T> {
  const key = realpathIfExists(filePath) ?? path.resolve(filePath);
  const current = localMutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = current.then(() => gate);
  localMutationQueues.set(key, tail);

  await current;
  try {
    return await run();
  } finally {
    release();
    if (localMutationQueues.get(key) === tail) localMutationQueues.delete(key);
  }
}

function validateExpectedFileStates(
  expected: readonly WorkspaceEditFileState[] | undefined,
  targetFiles: Iterable<string>,
): string | undefined {
  if (!expected) return undefined;
  const expectedStates = dedupeFileStates(expected);
  const expectedPaths = new Set(expectedStates.map((state) => path.resolve(state.filePath)));
  for (const filePath of targetFiles) {
    if (!expectedPaths.has(path.resolve(filePath))) return `WorkspaceEdit target set changed since preview: ${filePath}`;
  }
  for (const state of expectedStates) {
    const current = readWorkspaceEditFileState(state.filePath);
    if (sameWorkspaceEditFileState(state, current)) continue;
    return `WorkspaceEdit target changed since preview: ${current.filePath}`;
  }
  return undefined;
}

function validateDocumentVersions(
  versionsByPath: Map<string, number>,
  getDocumentVersion: WorkspaceEditApplyOptions["getDocumentVersion"],
): string | undefined {
  for (const [filePath, expected] of versionsByPath) {
    const current = getDocumentVersion?.(filePath);
    if (current === undefined) return `Cannot validate WorkspaceEdit document version ${expected} for: ${filePath}`;
    if (current !== expected) return `WorkspaceEdit document version is stale for ${filePath}: expected ${expected}, current ${current}`;
  }
  return undefined;
}

function stageFileEdit(plan: PlannedFileEdit): StagedFileEdit {
  const tempPath = uniqueTempPath(plan.filePath);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(tempPath, "wx", plan.mode);
    fs.writeFileSync(descriptor, plan.after, "utf8");
    fs.fchmodSync(descriptor, plan.mode);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    return { plan, tempPath };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the staging error.
      }
    }
    removeIfExists(tempPath);
    throw error;
  }
}

function rollbackCommittedFiles(committed: StagedFileEdit[]): string[] {
  const failed: string[] = [];
  for (const file of [...committed].reverse()) {
    let restore: StagedFileEdit | undefined;
    try {
      restore = stageFileEdit({ ...file.plan, after: file.plan.before });
      fs.renameSync(restore.tempPath, file.plan.filePath);
    } catch {
      failed.push(file.plan.filePath);
    } finally {
      if (restore) removeIfExists(restore.tempPath);
    }
  }
  return failed.reverse();
}

function cleanupStagedFiles(staged: StagedFileEdit[]): void {
  for (const file of staged) removeIfExists(file.tempPath);
}

function uniqueTempPath(filePath: string): string {
  const suffix = randomBytes(8).toString("hex");
  return path.join(path.dirname(filePath), `.pi-code-feedback-${process.pid}-${suffix}.tmp`);
}

function samePlannedFileState(file: PlannedFileEdit): boolean {
  try {
    const stat = fs.statSync(file.filePath);
    return stat.isFile() && (stat.mode & 0o777) === file.mode && fs.readFileSync(file.filePath, "utf8") === file.before;
  } catch {
    return false;
  }
}

function removeIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
}

function rejectedApply(reason: string): WorkspaceEditApplyResult {
  return {
    applied: false,
    files: [],
    editCount: 0,
    changedFiles: [],
    rejected: reason,
  };
}

function uniqueSortedPaths(filePaths: string[]): string[] {
  return [...new Set(filePaths.map((filePath) => path.resolve(filePath)))].sort((left, right) => left.localeCompare(right));
}

function dedupeFileStates(states: readonly WorkspaceEditFileState[]): WorkspaceEditFileState[] {
  const byPath = new Map<string, WorkspaceEditFileState>();
  for (const state of states) byPath.set(path.resolve(state.filePath), state);
  return [...byPath.values()];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

export function canResolveCodeActionOnApply(action: Record<string, unknown>): boolean {
  return action.edit === undefined &&
    typeof action[LSP_RESULT_SERVER_ID_KEY] === "string" &&
    typeof action[LSP_RESULT_SERVER_SESSION_ID_KEY] === "string" &&
    action[LSP_RESULT_CODE_ACTION_CAN_RESOLVE_KEY] === true;
}

export function selectCodeActionForApply(actions: unknown, query: unknown): { action?: Record<string, unknown>; error?: string; candidates: Record<string, unknown>[] } {
  const all = Array.isArray(actions) ? actions.filter(isRecord) : [];
  const withEdits = all.filter((action) => isWorkspaceEdit(action.edit) || canResolveCodeActionOnApply(action));
  const queryText = typeof query === "string" ? query.trim().toLowerCase() : "";
  const candidates = queryText.length > 0 ? withEdits.filter((action) => codeActionMatches(action, queryText)) : withEdits;

  if (candidates.length === 0) {
    return {
      candidates: withEdits,
      error: queryText.length > 0
        ? `No code action with a WorkspaceEdit or resolvable edit matched query "${query}".`
        : "No returned code action contains or can resolve a WorkspaceEdit that pi-code-feedback can apply safely.",
    };
  }

  if (candidates.length === 1) return { action: candidates[0], candidates };

  const preferred = candidates.filter((action) => action.isPreferred === true);
  if (preferred.length === 1) return { action: preferred[0], candidates };

  return {
    candidates,
    error: "Multiple applicable code actions matched. Pass query with part of the desired action title/kind.",
  };
}

function codeActionMatches(action: Record<string, unknown>, query: string): boolean {
  const haystack = [action.title, action.kind, action.command]
    .concat(action[LSP_RESULT_SERVER_ID_KEY])
    .map((value) => (typeof value === "string" ? value.toLowerCase() : ""))
    .join("\n");
  return haystack.includes(query);
}

function collectTextEdits(
  value: unknown,
  projectRoot: string,
  options: { validateProjectRoot: boolean },
): ({ ok: true } & CollectedWorkspaceEdit) | { ok: false; reason: string; resourceOperations: number } {
  if (!isRecord(value)) return { ok: false, reason: "LSP result is not a WorkspaceEdit object.", resourceOperations: 0 };

  const editsByPath = new Map<string, CollectedEdit[]>();
  const versionsByPath = new Map<string, number>();
  let resourceOperations = 0;

  if (isRecord(value.changes) && Array.isArray(value.documentChanges)) {
    return { ok: false, reason: "WorkspaceEdit must not contain both changes and documentChanges.", resourceOperations };
  }

  if (isRecord(value.changes)) {
    for (const [uri, edits] of Object.entries(value.changes)) {
      if (!Array.isArray(edits)) return { ok: false, reason: `WorkspaceEdit changes for ${uri} are not an array.`, resourceOperations };
      const filePath = resolveWorkspaceUri(uri, projectRoot, options.validateProjectRoot);
      if (!filePath.ok) return { ok: false, reason: filePath.reason, resourceOperations };
      const parsed = parseTextEdits(edits);
      if (!parsed.ok) return { ok: false, reason: parsed.reason, resourceOperations };
      appendEdits(editsByPath, filePath.filePath, parsed.edits);
    }
  }

  if (Array.isArray(value.documentChanges)) {
    for (const change of value.documentChanges) {
      if (!isRecord(change)) return { ok: false, reason: "WorkspaceEdit documentChanges contains a non-object entry.", resourceOperations };

      if (typeof change.kind === "string") {
        resourceOperations += 1;
        return { ok: false, reason: `WorkspaceEdit resource operation "${change.kind}" is not applied automatically yet.`, resourceOperations };
      }

      const textDocument = isRecord(change.textDocument) ? change.textDocument : undefined;
      const uri = typeof textDocument?.uri === "string" ? textDocument.uri : undefined;
      if (!uri) return { ok: false, reason: "WorkspaceEdit TextDocumentEdit is missing textDocument.uri.", resourceOperations };
      const version = readDocumentVersion(textDocument?.version);
      if (version === "invalid") return { ok: false, reason: `WorkspaceEdit TextDocumentEdit for ${uri} has an invalid document version.`, resourceOperations };
      if (!Array.isArray(change.edits)) return { ok: false, reason: `WorkspaceEdit TextDocumentEdit for ${uri} has no edits array.`, resourceOperations };
      const filePath = resolveWorkspaceUri(uri, projectRoot, options.validateProjectRoot);
      if (!filePath.ok) return { ok: false, reason: filePath.reason, resourceOperations };
      if (typeof version === "number") {
        const previous = versionsByPath.get(filePath.filePath);
        if (previous !== undefined && previous !== version) {
          return { ok: false, reason: `WorkspaceEdit contains conflicting document versions for ${uri}.`, resourceOperations };
        }
        versionsByPath.set(filePath.filePath, version);
      }
      const parsed = parseTextEdits(change.edits);
      if (!parsed.ok) return { ok: false, reason: parsed.reason, resourceOperations };
      appendEdits(editsByPath, filePath.filePath, parsed.edits);
    }
  }

  return { ok: true, editsByPath, versionsByPath, resourceOperations };
}

function readDocumentVersion(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : "invalid";
}

function parseTextEdits(values: unknown[]): { ok: true; edits: CollectedEdit[] } | { ok: false; reason: string } {
  const edits: CollectedEdit[] = [];
  for (const value of values) {
    if (!isRecord(value)) return { ok: false, reason: "TextEdit entry is not an object." };
    const edit = value as TextEditInput;
    if (!edit.range || typeof edit.newText !== "string") return { ok: false, reason: "TextEdit is missing range or newText." };
    if (!isLspRange(edit.range)) return { ok: false, reason: "TextEdit range is malformed." };
    edits.push({ range: edit.range, newText: edit.newText });
  }
  return { ok: true, edits };
}

function appendEdits(map: Map<string, CollectedEdit[]>, filePath: string, edits: CollectedEdit[]): void {
  const existing = map.get(filePath);
  if (existing) existing.push(...edits);
  else map.set(filePath, [...edits]);
}

function resolveWorkspaceUri(uri: string, projectRoot: string, validateProjectRoot: boolean): { ok: true; filePath: string } | { ok: false; reason: string } {
  const filePath = uriToFilePath(uri);
  if (!filePath) return { ok: false, reason: `WorkspaceEdit URI is not a file URI: ${uri}` };

  const lexicalPath = path.resolve(filePath);
  let resolved: string;
  try {
    resolved = fs.realpathSync(lexicalPath);
  } catch {
    return { ok: false, reason: `WorkspaceEdit target file does not exist: ${lexicalPath}` };
  }
  if (validateProjectRoot) {
    const resolvedRoot = realpathIfExists(projectRoot) ?? path.resolve(projectRoot);
    if (!isInsideProject(resolved, resolvedRoot)) {
      return { ok: false, reason: `WorkspaceEdit target is outside project root: ${resolved}` };
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return { ok: false, reason: `WorkspaceEdit target file does not exist: ${resolved}` };
    }
    if (!stat.isFile()) return { ok: false, reason: `WorkspaceEdit target is not a regular file: ${resolved}` };
  }
  return { ok: true, filePath: resolved };
}

function realpathIfExists(filePath: string): string | undefined {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return undefined;
  }
}

function isInsideProject(filePath: string, projectRoot: string): boolean {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function applyTextEditsToContent(content: string, edits: CollectedEdit[], filePath: string): string {
  const resolved = edits.map((edit, index) => resolveEdit(content, edit, filePath, index));
  resolved.sort((left, right) => left.start - right.start || left.index - right.index);

  let output = "";
  let cursor = 0;

  for (let index = 0; index < resolved.length;) {
    const start = resolved[index].start;
    if (start < cursor) throw new Error(`Overlapping LSP text edits for ${filePath}`);

    let endIndex = index + 1;
    while (endIndex < resolved.length && resolved[endIndex].start === start) endIndex += 1;

    const group = resolved.slice(index, endIndex);
    const replacement = group.filter((edit) => edit.start !== edit.end);
    if (replacement.length > 1) throw new Error(`Overlapping LSP text edits for ${filePath}`);

    const replace = replacement[0];
    const inserts = group.filter((edit) => edit.start === edit.end).sort((left, right) => left.index - right.index);
    if (replace && inserts.some((edit) => edit.index > replace.index)) {
      throw new Error(`Invalid same-position LSP text edit order for ${filePath}: inserts must precede the replace/delete edit`);
    }

    output += content.slice(cursor, start);
    for (const insert of inserts) output += insert.newText;

    if (replace) {
      output += replace.newText;
      cursor = replace.end;
    } else {
      cursor = start;
    }

    index = endIndex;
  }

  return output + content.slice(cursor);
}

function resolveEdit(content: string, edit: CollectedEdit, filePath: string, index: number): ResolvedEdit {
  const start = positionToOffset(content, edit.range.start);
  const end = positionToOffset(content, edit.range.end);
  if (start === undefined || end === undefined || start > end) {
    throw new Error(`Invalid LSP text edit range for ${filePath}`);
  }
  return { start, end, newText: edit.newText, index };
}

function positionToOffset(content: string, position: LspPosition): number | undefined {
  if (!isLspPosition(position)) return undefined;
  const { line, character } = position;
  let lineStart = 0;
  let currentLine = 0;

  while (currentLine < line) {
    const newline = content.indexOf("\n", lineStart);
    if (newline < 0) return undefined;
    lineStart = newline + 1;
    currentLine += 1;
  }

  const lineEnd = content.indexOf("\n", lineStart);
  const end = lineEnd < 0 ? content.length : lineEnd;
  if (lineStart + character > end) return undefined;
  return lineStart + character;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

