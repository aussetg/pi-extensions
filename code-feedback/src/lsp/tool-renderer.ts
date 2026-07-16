import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatSize, type LspToolTruncation } from "./tool-output.ts";

interface ThemeLike {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

interface ToolResultLike {
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

interface RenderOptionsLike {
  expanded?: boolean;
  isPartial?: boolean;
}

interface RenderContextLike {
  args?: Record<string, unknown>;
  invalidate?: () => void;
  isError?: boolean;
}

interface ComponentLike {
  render(width: number): string[];
  invalidate(): void;
}

const COLLAPSED_MAX_LINES = 14;
const EXPANDED_MAX_LINES = 120;

export function renderLspToolCall(args: Record<string, unknown>, theme: ThemeLike): ComponentLike {
  const method = displayMethod(args);
  const target = displayTarget(args);
  const parts = [
    fg(theme, "toolTitle", bold(theme, "lsp")),
    fg(theme, "accent", method),
    target ? fg(theme, "muted", target) : "",
  ].filter(Boolean);
  return linesComponent([parts.join(" ")]);
}

export function renderLspToolResult(result: ToolResultLike, options: RenderOptionsLike, theme: ThemeLike, context: RenderContextLike): ComponentLike {
  if (options.isPartial) return linesComponent([fg(theme, "warning", "LSP request running…")]);

  const text = textContent(result);
  const feedback = additionalTextContent(result);
  const details = objectDetails(result.details);
  const method = typeof details?.method === "string" ? details.method : displayMethod(context.args ?? {});
  const truncation = details?.truncation as LspToolTruncation | undefined;
  const hasCodeFeedback = objectDetails(details?.piCodeFeedback) !== undefined;
  let rendered: ComponentLike;

  if (details?.ok === false || parseJson(text)?.ok === false || ((context.isError || result.isError) && !hasCodeFeedback)) {
    rendered = renderError(text, theme, options.expanded === true, details);
  } else if (details?.raw === true) {
    rendered = renderRawPayload(method, text, theme, options.expanded === true, truncation);
  } else {
    switch (method) {
      case "server/status":
        rendered = renderStatus(text, theme, options.expanded === true, truncation);
        break;
      case "server/capabilities":
        rendered = renderCapabilities(text, theme, options.expanded === true, truncation);
        break;
      case "textDocument/diagnostic":
      case "workspace/diagnostic":
        rendered = renderDiagnostics(text, theme, options.expanded === true, truncation);
        break;
      case "textDocument/hover":
        rendered = renderHover(text, theme, options.expanded === true, truncation, context);
        break;
      case "textDocument/definition":
      case "textDocument/references":
      case "textDocument/implementation":
      case "textDocument/typeDefinition":
        rendered = renderLocationLike(text, theme, options.expanded === true, truncation);
        break;
      case "textDocument/documentSymbol":
      case "workspace/symbol":
        rendered = renderSymbolLike(text, theme, options.expanded === true, truncation);
        break;
      case "textDocument/codeAction":
        rendered = renderCodeActions(text, theme, options.expanded === true, truncation, context);
        break;
      case "textDocument/rename":
        rendered = renderWorkspaceEditPreview(text, theme, options.expanded === true, truncation, context);
        break;
      case "workspaceEdit/apply":
        rendered = renderApplyJson(text, theme, options.expanded === true, truncation, context);
        break;
      default:
        rendered = renderGeneric(text, theme, options.expanded === true, truncation, context);
    }
  }

  if (!feedback) return rendered;
  return appendComponent(rendered, linesComponent(styleContentLines(
    feedback,
    theme,
    undefined,
    options.expanded ? EXPANDED_MAX_LINES : COLLAPSED_MAX_LINES,
  )));
}

function renderStatus(text: string, theme: ThemeLike, expanded: boolean, truncation?: LspToolTruncation): ComponentLike {
  const clients = findLineValue(text, "clients") ?? "unknown";
  const lsp = findLineValue(text, "lsp feedback") ?? "unknown";
  const lines = [statusLine(theme, "LSP", clients, lsp === "enabled" ? "success" : "warning")];
  if (expanded) lines.push(...styleContentLines(text, theme, truncation, EXPANDED_MAX_LINES));
  else lines.push(collapseHint(theme));
  return linesComponent(lines);
}

function renderCapabilities(text: string, theme: ThemeLike, expanded: boolean, truncation?: LspToolTruncation): ComponentLike {
  const clients = findLineValue(text, "clients") ?? "unknown";
  const lines = [statusLine(theme, "Capabilities", clients, "success")];
  if (expanded) lines.push(...styleContentLines(text, theme, truncation, EXPANDED_MAX_LINES));
  else lines.push(collapseHint(theme));
  return linesComponent(lines);
}

function renderDiagnostics(text: string, theme: ThemeLike, expanded: boolean, truncation?: LspToolTruncation): ComponentLike {
  const target = findLineValue(text, "target") ?? "current session";
  const count = findLineValue(text, "known LSP diagnostics") ?? "0";
  const refresh = findLineValue(text, "refresh");
  const scanFiles = findLineValue(text, "files");
  const scan = findLineValue(text, "scan");
  const summary = [count, target, refresh, scanFiles].filter(Boolean).join(" · ");
  const authoritativeRefresh = refresh === undefined || refresh.startsWith("fresh");
  const cleanScan = scanFiles === undefined || /· 0 timed out · 0 unavailable · 0 skipped$/.test(scanFiles);
  const completeScan = scan === undefined || scan.startsWith("complete ") || scan === "complete";
  const lines = [statusLine(theme, "Diagnostics", summary, count === "0" && authoritativeRefresh && cleanScan && completeScan ? "success" : "warning")];
  const diagnosticLines = text.split("\n").filter((line) => /^\s*(ERROR|WARNING|INFORMATION|HINT)\b/.test(line));
  if (expanded) {
    lines.push(...styleContentLines(text, theme, truncation, EXPANDED_MAX_LINES));
  } else {
    for (const line of diagnosticLines.slice(0, 3)) lines.push(colorDiagnosticLine(line, theme));
    if (diagnosticLines.length > 3) lines.push(fg(theme, "dim", `… ${diagnosticLines.length - 3} more`));
  }
  return linesComponent(dedupeAdjacent(lines));
}

function renderHover(text: string, theme: ThemeLike, expanded: boolean, truncation: LspToolTruncation | undefined, context: RenderContextLike): ComponentLike {
  const code = parseSingleCodeFence(text);
  if (code) return linesComponent(styleContentLines(code.code, theme, truncation, expanded ? EXPANDED_MAX_LINES : COLLAPSED_MAX_LINES));
  return renderGeneric(text, theme, expanded, truncation, context);
}

function renderLocationLike(text: string, theme: ThemeLike, expanded: boolean, truncation?: LspToolTruncation): ComponentLike {
  const lines = text.split("\n");
  const title = lines[0] ?? "No locations.";
  const out = [fg(theme, title.startsWith("No ") ? "dim" : "success", title)];
  if (expanded) out.push(...styleContentLines(text, theme, truncation, EXPANDED_MAX_LINES));
  else out.push(...lines.slice(1, 6).map((line) => fg(theme, "muted", line.trim())));
  if (!expanded && lines.length > 6) out.push(fg(theme, "dim", `… ${lines.length - 6} more`));
  return linesComponent(dedupeAdjacent(out));
}

function renderSymbolLike(text: string, theme: ThemeLike, expanded: boolean, truncation?: LspToolTruncation): ComponentLike {
  const lines = text.split("\n");
  const title = lines[0] ?? "No symbols.";
  const out = [fg(theme, title.startsWith("No ") ? "dim" : "success", title)];
  if (expanded) out.push(...styleContentLines(text, theme, truncation, EXPANDED_MAX_LINES));
  else out.push(collapseHint(theme));
  return linesComponent(dedupeAdjacent(out));
}

function renderCodeActions(text: string, theme: ThemeLike, expanded: boolean, truncation: LspToolTruncation | undefined, context: RenderContextLike): ComponentLike {
  const payload = parseJson(text);
  if (!payload || !Array.isArray(payload.actions)) return renderGeneric(text, theme, expanded, truncation, context);

  const actions = payload.actions.filter(objectDetails);
  const out = [statusLine(theme, "Code actions", `${actions.length}`, actions.length > 0 ? "success" : "dim")];
  for (const action of actions.slice(0, expanded ? 20 : 5)) {
    const title = typeof action.title === "string" ? action.title : "untitled";
    const id = typeof action.id === "string" ? action.id : "?";
    const kind = typeof action.kind === "string" ? ` ${action.kind}` : "";
    const applyable = action.applyable === true ? fg(theme, "success", "applyable") : fg(theme, "dim", "preview-only");
    const resolve = action.requiresResolve === true ? fg(theme, "dim", " resolves-on-apply") : "";
    out.push(`${fg(theme, "accent", id)} ${title}${fg(theme, "dim", kind)} ${applyable}${resolve}`);
  }
  if (!expanded && actions.length > 5) out.push(fg(theme, "dim", `… ${actions.length - 5} more`));
  if (expanded && truncation) out.push(formatTruncation(theme, truncation));
  return linesComponent(out);
}

function renderWorkspaceEditPreview(text: string, theme: ThemeLike, expanded: boolean, truncation: LspToolTruncation | undefined, context: RenderContextLike): ComponentLike {
  const payload = parseJson(text);
  const preview = objectDetails(payload?.workspaceEdit);
  if (!preview) return renderGeneric(text, theme, expanded, truncation, context);

  const id = typeof preview.id === "string" ? preview.id : "?";
  const title = typeof preview.title === "string" ? preview.title : "WorkspaceEdit";
  const summary = typeof preview.editSummary === "string" ? preview.editSummary : "no text edits";
  const applyable = preview.applyable === true ? "success" : "warning";
  const out = [statusLine(theme, "WorkspaceEdit preview", `${id} · ${title} · ${summary}`, applyable)];
  if (expanded) out.push(...styleContentLines(text, theme, truncation, EXPANDED_MAX_LINES));
  return linesComponent(out);
}

function renderApplyJson(text: string, theme: ThemeLike, expanded: boolean, truncation: LspToolTruncation | undefined, context: RenderContextLike): ComponentLike {
  const payload = parseJson(text);
  if (!payload) return renderGeneric(text, theme, expanded, truncation, context);

  const ok = payload.ok !== false && payload.applied !== false;
  const title = typeof payload.title === "string" ? payload.title : typeof payload.newName === "string" ? `rename → ${payload.newName}` : "applied";
  const editCount = typeof payload.editCount === "number" ? `${payload.editCount} edit${payload.editCount === 1 ? "" : "s"}` : "";
  const files = Array.isArray(payload.changedFiles) ? `${payload.changedFiles.length} file${payload.changedFiles.length === 1 ? "" : "s"}` : "";
  const out = [statusLine(theme, ok ? "Applied" : "Not applied", [title, editCount, files].filter(Boolean).join(" · "), ok ? "success" : "error")];
  if (expanded) out.push(...styleContentLines(text, theme, truncation, EXPANDED_MAX_LINES));
  return linesComponent(out);
}

function renderRawPayload(method: string, text: string, theme: ThemeLike, expanded: boolean, truncation?: LspToolTruncation): ComponentLike {
  const value = parseJsonValue(text);
  const objectValue = objectDetails(value);
  const lines = text.split("\n");
  const label = Array.isArray(value)
    ? `${value.length} item${value.length === 1 ? "" : "s"}`
    : objectValue
    ? `${Object.keys(objectValue).length} field${Object.keys(objectValue).length === 1 ? "" : "s"}`
    : `${lines.length} line${lines.length === 1 ? "" : "s"}`;
  const out = [statusLine(theme, "Raw LSP", `${method} · ${label}`, "success")];
  if (expanded) out.push(...styleContentLines(text, theme, truncation, EXPANDED_MAX_LINES));
  else out.push(collapseHint(theme, `${lines.length} line${lines.length === 1 ? "" : "s"}`));
  return linesComponent(out);
}

function renderGeneric(text: string, theme: ThemeLike, expanded: boolean, truncation: LspToolTruncation | undefined, _context: RenderContextLike): ComponentLike {
  const lines = text.split("\n");
  const code = parseSingleCodeFence(text);
  if (code) return linesComponent(styleContentLines(code.code, theme, truncation, expanded ? EXPANDED_MAX_LINES : COLLAPSED_MAX_LINES));
  if (!expanded && lines.length > COLLAPSED_MAX_LINES) {
    return linesComponent([fg(theme, "success", lines[0] ?? "LSP result"), collapseHint(theme, `${lines.length} lines`)]);
  }
  return linesComponent(styleContentLines(text, theme, truncation, expanded ? EXPANDED_MAX_LINES : COLLAPSED_MAX_LINES));
}

function renderError(text: string, theme: ThemeLike, expanded: boolean, details?: Record<string, unknown>): ComponentLike {
  const payload = parseJson(text) ?? details;
  const message = typeof payload?.error === "string" ? payload.error : text.split("\n")[0] ?? "LSP error";
  const lines = [fg(theme, "error", message)];
  if (typeof payload?.hint === "string") lines.push(fg(theme, "dim", payload.hint));
  if (expanded) lines.push(...text.split("\n").map((line) => fg(theme, "dim", line)));
  return linesComponent(lines);
}

function styleContentLines(text: string, theme: ThemeLike, truncation: LspToolTruncation | undefined, maxLines: number): string[] {
  const lines = text.split("\n");
  const shown = lines.slice(0, maxLines).map((line) => styleLine(line, theme));
  if (lines.length > maxLines) shown.push(fg(theme, "dim", `… ${lines.length - maxLines} more lines`));
  if (truncation) shown.push(formatTruncation(theme, truncation));
  return shown;
}

function styleLine(line: string, theme: ThemeLike): string {
  if (/^\s*ERROR\b/.test(line)) return fg(theme, "error", line);
  if (/^\s*WARNING\b/.test(line)) return fg(theme, "warning", line);
  if (/^\s*(INFORMATION|HINT)\b/.test(line)) return fg(theme, "muted", line);
  if (/^\s*(target|clients|project root|known LSP diagnostics|lsp feedback):/.test(line)) return fg(theme, "accent", line);
  if (/^\s*\.\.\.|^\s*…/.test(line)) return fg(theme, "dim", line);
  return fg(theme, "toolOutput", line);
}

function colorDiagnosticLine(line: string, theme: ThemeLike): string {
  if (/^\s*ERROR\b/.test(line)) return fg(theme, "error", line.trim());
  if (/^\s*WARNING\b/.test(line)) return fg(theme, "warning", line.trim());
  return fg(theme, "muted", line.trim());
}

function statusLine(theme: ThemeLike, label: string, value: string, color: string): string {
  return `${fg(theme, color, bold(theme, label))}${value ? ` ${fg(theme, "muted", value)}` : ""}`;
}

function formatTruncation(theme: ThemeLike, truncation: LspToolTruncation): string {
  return fg(theme, "warning", `truncated: ${truncation.outputLines}/${truncation.totalLines} lines, ${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)} · ${truncation.fullOutputPath}`);
}

function collapseHint(theme: ThemeLike, prefix = "…"): string {
  return fg(theme, "dim", `${prefix} (ctrl+o to expand)`);
}

function displayMethod(args: Record<string, unknown>): string {
  return typeof args.method === "string" ? args.method : "server/status";
}

function displayTarget(args: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  if (typeof args.server === "string") parts.push(`[${args.server}]`);
  if (typeof args.path === "string") parts.push(args.path);
  if (typeof args.limit === "number") parts.push(`limit=${args.limit}`);
  if (typeof args.line === "number") parts.push(`${args.line}:${typeof args.column === "number" ? args.column : "?"}`);
  if (typeof args.query === "string") parts.push(`“${args.query}”`);
  if (typeof args.id === "string") parts.push(args.id);
  if (typeof args.newName === "string") parts.push(`→ ${args.newName}`);
  return parts.join(" ") || undefined;
}

function findLineValue(text: string, key: string): string | undefined {
  const prefix = `${key}:`;
  const line = text.split("\n").find((candidate) => candidate.trimStart().startsWith(prefix));
  return line?.trimStart().slice(prefix.length).trim();
}

function parseSingleCodeFence(text: string): { language?: string; code: string } | undefined {
  const match = /^```([^\n`]*)\n([\s\S]*?)\n```\s*$/.exec(text.trim());
  if (!match) return undefined;
  const language = match[1]?.trim() || undefined;
  return { language, code: match[2] ?? "" };
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text);
    return objectDetails(value) ?? undefined;
  } catch {
    return undefined;
  }
}

function parseJsonValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function textContent(result: ToolResultLike): string {
  const first = result.content?.find((entry) => entry.type === "text" && typeof entry.text === "string");
  return first?.text ?? "";
}

function additionalTextContent(result: ToolResultLike): string | undefined {
  const texts = result.content
    ?.filter((entry): entry is { type: string; text: string } => entry.type === "text" && typeof entry.text === "string")
    .slice(1)
    .map((entry) => entry.text)
    .filter(Boolean);
  return texts && texts.length > 0 ? texts.join("\n\n") : undefined;
}

function objectDetails(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function dedupeAdjacent(lines: string[]): string[] {
  return lines.filter((line, index) => index === 0 || line !== lines[index - 1]);
}

function fg(theme: ThemeLike, color: string, text: string): string {
  return theme.fg?.(color, text) ?? text;
}

function bold(theme: ThemeLike, text: string): string {
  return theme.bold?.(text) ?? text;
}

function linesComponent(lines: string[]): ComponentLike {
  return {
    render(width: number) {
      return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
    },
    invalidate() {},
  };
}

function appendComponent(first: ComponentLike, second: ComponentLike): ComponentLike {
  return {
    render(width: number) {
      return [...first.render(width), ...second.render(width)];
    },
    invalidate() {
      first.invalidate();
      second.invalidate();
    },
  };
}
