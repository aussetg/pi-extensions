import * as fs from "node:fs";
import * as path from "node:path";
import { uriToFilePath, type LspPosition, type LspRange } from "./positions.ts";

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
}

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
}

interface PlannedFileEdit extends AppliedTextEdit {
  after: string;
}

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

export async function applyWorkspaceEdit(value: unknown, projectRoot: string): Promise<WorkspaceEditApplyResult> {
  const collected = collectTextEdits(value, projectRoot, { validateProjectRoot: true });
  if (!collected.ok) {
    return {
      applied: false,
      files: [],
      editCount: 0,
      changedFiles: [],
      rejected: collected.reason,
    };
  }

  let planned: PlannedFileEdit[];
  try {
    planned = planWorkspaceEdit(collected.editsByPath);
  } catch (error) {
    return {
      applied: false,
      files: [],
      editCount: 0,
      changedFiles: [],
      rejected: error instanceof Error ? error.message : String(error),
    };
  }

  for (const file of planned) {
    if (file.changed) fs.writeFileSync(file.filePath, file.after, "utf8");
  }

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
    const before = fs.readFileSync(filePath, "utf8");
    const after = applyTextEditsToContent(before, edits, filePath);
    planned.push({ filePath, editCount: edits.length, changed: after !== before, after });
  }
  return planned;
}

export function selectCodeActionForApply(actions: unknown, query: unknown): { action?: Record<string, unknown>; error?: string; candidates: Record<string, unknown>[] } {
  const all = Array.isArray(actions) ? actions.filter(isRecord) : [];
  const withEdits = all.filter((action) => isWorkspaceEdit(action.edit));
  const queryText = typeof query === "string" ? query.trim().toLowerCase() : "";
  const candidates = queryText.length > 0 ? withEdits.filter((action) => codeActionMatches(action, queryText)) : withEdits;

  if (candidates.length === 0) {
    return {
      candidates: withEdits,
      error: queryText.length > 0
        ? `No code action with a WorkspaceEdit matched query "${query}".`
        : "No returned code action contains a WorkspaceEdit that pi-code-feedback can apply safely.",
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
    .map((value) => (typeof value === "string" ? value.toLowerCase() : ""))
    .join("\n");
  return haystack.includes(query);
}

function collectTextEdits(
  value: unknown,
  projectRoot: string,
  options: { validateProjectRoot: boolean },
): { ok: true; editsByPath: Map<string, CollectedEdit[]>; resourceOperations: number } | { ok: false; reason: string; resourceOperations: number } {
  if (!isRecord(value)) return { ok: false, reason: "LSP result is not a WorkspaceEdit object.", resourceOperations: 0 };

  const editsByPath = new Map<string, CollectedEdit[]>();
  let resourceOperations = 0;

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
      if (!Array.isArray(change.edits)) return { ok: false, reason: `WorkspaceEdit TextDocumentEdit for ${uri} has no edits array.`, resourceOperations };
      const filePath = resolveWorkspaceUri(uri, projectRoot, options.validateProjectRoot);
      if (!filePath.ok) return { ok: false, reason: filePath.reason, resourceOperations };
      const parsed = parseTextEdits(change.edits);
      if (!parsed.ok) return { ok: false, reason: parsed.reason, resourceOperations };
      appendEdits(editsByPath, filePath.filePath, parsed.edits);
    }
  }

  return { ok: true, editsByPath, resourceOperations };
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

  const resolved = path.resolve(filePath);
  if (validateProjectRoot && !isInsideProject(resolved, projectRoot)) {
    return { ok: false, reason: `WorkspaceEdit target is outside project root: ${resolved}` };
  }
  if (validateProjectRoot && !fs.existsSync(resolved)) {
    return { ok: false, reason: `WorkspaceEdit target file does not exist: ${resolved}` };
  }
  return { ok: true, filePath: resolved };
}

function isInsideProject(filePath: string, projectRoot: string): boolean {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function applyTextEditsToContent(content: string, edits: CollectedEdit[], filePath: string): string {
  const resolved = edits.map((edit) => resolveEdit(content, edit, filePath));
  resolved.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < resolved.length; i += 1) {
    if (resolved[i].start < resolved[i - 1].end) {
      throw new Error(`Overlapping LSP text edits for ${filePath}`);
    }
  }

  let next = content;
  for (const edit of resolved.slice().sort((a, b) => b.start - a.start)) {
    next = next.slice(0, edit.start) + edit.newText + next.slice(edit.end);
  }
  return next;
}

function resolveEdit(content: string, edit: CollectedEdit, filePath: string): ResolvedEdit {
  const start = positionToOffset(content, edit.range.start);
  const end = positionToOffset(content, edit.range.end);
  if (start === undefined || end === undefined || start > end) {
    throw new Error(`Invalid LSP text edit range for ${filePath}`);
  }
  return { start, end, newText: edit.newText };
}

function positionToOffset(content: string, position: LspPosition): number | undefined {
  const line = Math.max(0, Math.floor(position.line));
  const character = Math.max(0, Math.floor(position.character));
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

function isLspRange(value: unknown): value is LspRange {
  if (!isRecord(value)) return false;
  return isLspPosition(value.start) && isLspPosition(value.end);
}

function isLspPosition(value: unknown): value is LspPosition {
  if (!isRecord(value)) return false;
  return typeof value.line === "number" && typeof value.character === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

