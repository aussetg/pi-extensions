import { displayPathFromRoot } from "../paths.ts";
import { isLspRange, lspRangeToExternal, uriToFilePath, type LspRange } from "./positions.ts";
import { canResolveCodeActionOnApply, workspaceEditSummary } from "./workspace-edit.ts";
import { isRecord, LSP_RESULT_SERVER_ID_KEY, type LspMethod } from "../types.ts";

export function renderLspMethodResult(method: LspMethod, result: unknown, projectRoot: string): string {
  switch (method) {
    case "textDocument/hover":
      return renderHover(result);
    case "textDocument/definition":
    case "textDocument/references":
    case "textDocument/implementation":
    case "textDocument/typeDefinition":
      return renderLocations(result, projectRoot, `No ${method.slice(method.lastIndexOf("/") + 1)} result.`);
    case "textDocument/documentSymbol":
    case "workspace/symbol":
      return renderSymbols(result, projectRoot);
    case "textDocument/codeAction":
      return renderCodeActions(result);
    case "textDocument/rename":
      return renderWorkspaceEditPreview(result, projectRoot, "rename");
    case "workspace/renameFile":
      return renderWorkspaceEditPreview(result, projectRoot, "file rename");
    default:
      return renderJson(result);
  }
}

function renderHover(result: unknown): string {
  if (!isRecord(result)) return "No hover result.";
  const text = markupToText(result.contents);
  const trimmed = text.trim();
  return trimmed.length > 0 ? truncate(stripSingleCodeFence(trimmed), 12_000) : "No hover result.";
}

function markupToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(markupToText).filter(Boolean).join("\n\n");
  if (!isRecord(value)) return "";
  if (typeof value.language === "string" && typeof value.value === "string") return value.value;
  if (typeof value.value === "string") return value.value;
  return "";
}

function stripSingleCodeFence(text: string): string {
  const match = /^```[^\n`]*\n([\s\S]*?)\n```\s*$/.exec(text.trim());
  return match ? match[1] ?? "" : text;
}

function renderLocations(result: unknown, projectRoot: string, emptyText: string): string {
  const locations = normalizeLocationResult(result);
  if (locations.length === 0) return emptyText;
  const lines = [`${locations.length} location${locations.length === 1 ? "" : "s"}:`];
  for (const location of locations.slice(0, 80)) {
    lines.push(`  ${formatUriRange(projectRoot, location.uri, location.range)}`);
  }
  if (locations.length > 80) lines.push(`  ... ${locations.length - 80} more`);
  return lines.join("\n");
}

function normalizeLocationResult(result: unknown): Array<{ uri: string; range: LspRange }> {
  const values = Array.isArray(result) ? result : result === undefined || result === null ? [] : [result];
  return values
    .map((value): { uri: string; range: LspRange } | undefined => {
      if (!isRecord(value)) return undefined;
      if (typeof value.uri === "string" && isLspRange(value.range)) return { uri: value.uri, range: value.range };
      if (typeof value.targetUri === "string" && isLspRange(value.targetSelectionRange ?? value.targetRange)) {
        return { uri: value.targetUri, range: (value.targetSelectionRange ?? value.targetRange) as LspRange };
      }
      return undefined;
    })
    .filter((value): value is { uri: string; range: LspRange } => value !== undefined);
}

function renderSymbols(result: unknown, projectRoot: string): string {
  const values = Array.isArray(result) ? result : [];
  if (values.length === 0) return "No symbols.";
  const lines = [`${values.length} top-level symbol${values.length === 1 ? "" : "s"}:`];
  for (const symbol of values.slice(0, 120)) {
    lines.push(...formatSymbol(projectRoot, symbol, 1));
  }
  if (values.length > 120) lines.push(`  ... ${values.length - 120} more`);
  return lines.join("\n");
}

function formatSymbol(projectRoot: string, value: unknown, depth: number): string[] {
  if (!isRecord(value)) return [];
  const indent = "  ".repeat(depth);
  const name = typeof value.name === "string" ? value.name : "<unnamed>";
  const kind = typeof value.kind === "number" ? symbolKindName(value.kind) : "symbol";
  const location = isRecord(value.location) && typeof value.location.uri === "string" && isLspRange(value.location.range)
    ? ` ${formatUriRange(projectRoot, value.location.uri, value.location.range)}`
    : isLspRange(value.selectionRange ?? value.range)
    ? ` ${formatRange((value.selectionRange ?? value.range) as LspRange)}`
    : "";
  const lines = [`${indent}${kind} ${name}${location}`];
  if (Array.isArray(value.children)) {
    for (const child of value.children.slice(0, 30)) lines.push(...formatSymbol(projectRoot, child, depth + 1));
    if (value.children.length > 30) lines.push(`${indent}  ... ${value.children.length - 30} more children`);
  }
  return lines;
}

function renderCodeActions(result: unknown): string {
  const actions = Array.isArray(result) ? result.filter(isRecord) : [];
  if (actions.length === 0) return "No code actions.";
  const lines = [`${actions.length} code action${actions.length === 1 ? "" : "s"}:`];
  for (const action of actions.slice(0, 40)) {
    const title = typeof action.title === "string" ? action.title : typeof action.command === "string" ? action.command : "untitled action";
    const server = typeof action[LSP_RESULT_SERVER_ID_KEY] === "string" ? ` (${action[LSP_RESULT_SERVER_ID_KEY]})` : "";
    const kind = typeof action.kind === "string" ? ` [${action.kind}]` : "";
    const preferred = action.isPreferred === true ? " preferred" : "";
    const edit = workspaceEditSummary(action.edit);
    const editText = edit.edits > 0 ? ` edits=${edit.edits} files=${edit.files}` : "";
    const lazy = canResolveCodeActionOnApply(action) ? " resolves-on-apply" : "";
    lines.push(`  - ${title}${server}${kind}${preferred}${editText}${lazy}`);
  }
  if (actions.length > 40) lines.push(`  ... ${actions.length - 40} more`);
  return lines.join("\n");
}

function renderWorkspaceEditPreview(result: unknown, _projectRoot: string, label: string): string {
  const summary = workspaceEditSummary(result);
  if (summary.edits === 0 && summary.resourceOperations === 0) return `No ${label} WorkspaceEdit.`;
  const resourceText = summary.resourceOperations > 0 ? `, ${summary.resourceOperations} resource operation${summary.resourceOperations === 1 ? "" : "s"}` : "";
  return `${label} WorkspaceEdit: ${summary.edits} text edit${summary.edits === 1 ? "" : "s"} across ${summary.files} file${summary.files === 1 ? "" : "s"}${resourceText}.`;
}

function formatUriRange(projectRoot: string, uri: string, range: LspRange): string {
  const filePath = uriToFilePath(uri);
  const displayPath = filePath ? displayPathFromRoot(filePath, projectRoot) : uri;
  return `${displayPath}:${formatRange(range)}`;
}

function formatRange(range: LspRange): string {
  const external = lspRangeToExternal(range);
  return external ? `${external.start.line}:${external.start.character}` : "?:?";
}

function renderJson(result: unknown): string {
  if (result === null || result === undefined) return "No LSP result.";
  const text = JSON.stringify(result, null, 2) ?? String(result);
  return truncate(text, 12_000);
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n... truncated`;
}

function symbolKindName(kind: number): string {
  const names: Record<number, string> = {
    1: "File",
    2: "Module",
    3: "Namespace",
    4: "Package",
    5: "Class",
    6: "Method",
    7: "Property",
    8: "Field",
    9: "Constructor",
    10: "Enum",
    11: "Interface",
    12: "Function",
    13: "Variable",
    14: "Constant",
    15: "String",
    16: "Number",
    17: "Boolean",
    18: "Array",
    19: "Object",
    20: "Key",
    21: "Null",
    22: "EnumMember",
    23: "Struct",
    24: "Event",
    25: "Operator",
    26: "TypeParameter",
  };
  return names[kind] ?? `Symbol(${kind})`;
}

