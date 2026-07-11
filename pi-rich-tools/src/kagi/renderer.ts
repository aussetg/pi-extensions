/** TUI-only rendering for Kagi calls and results. */

import {
  formatSize,
  keyHint,
  truncateHead,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { cleanSearchText, humanCategory } from "./formatting.ts";
import { stripTerminalControls } from "./terminal.ts";
import type { FetchParams, SearchParams, SearchWorkflow, WebFetchDetails, WebSearchDetails } from "./types.ts";

const FETCH_COLLAPSED_MAX_LINES = 14;
const FETCH_COLLAPSED_MAX_BYTES = 12 * 1024;

interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface RenderContext {
  isError?: boolean;
  state?: Record<string, unknown>;
  invalidate?: () => void;
}

interface ToolResultLike {
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
}

interface RenderOptions {
  expanded: boolean;
  isPartial: boolean;
}

interface SearchRenderSummary {
  totalResults: number;
  workflow: SearchWorkflow;
  ms?: number;
  truncated?: boolean;
}

interface FetchRenderSummary {
  success: number;
  failed: number;
  ms?: number;
  truncated?: boolean;
}

export function renderSearchCall(args: Partial<SearchParams>, theme: ThemeLike, context?: RenderContext): Text {
  let text = theme.fg("toolTitle", theme.bold("web_search "));
  text += theme.fg("accent", `"${stripTerminalControls(args.query ?? "")}"`);
  const summary = context?.state?.searchSummary as SearchRenderSummary | undefined;
  if (summary) {
    text += theme.fg("dim", " — ") + renderSearchSummary(summary, theme);
  } else {
    if (args.workflow && args.workflow !== "search") text += theme.fg("muted", ` [${args.workflow}]`);
    if (args.numResults) text += theme.fg("dim", ` (${args.numResults})`);
  }
  if (args.extractCount) text += theme.fg("warning", ` +extract ${args.extractCount}`);
  return new Text(text, 0, 0);
}

export function renderSearchResult(
  result: ToolResultLike,
  { expanded, isPartial }: RenderOptions,
  theme: ThemeLike,
  context?: RenderContext,
): Text {
  if (isPartial) return new Text(theme.fg("warning", "Searching Kagi..."), 0, 0);
  if (context?.isError) return new Text(theme.fg("error", "✗ ") + resultText(result), 0, 0);

  const details = result.details;
  if (!isWebSearchDetails(details)) return new Text(theme.fg("dim", "No Kagi results"), 0, 0);
  setSearchSummaryOnRenderContext(context, details);

  return new Text(`\n${renderSearchResultsPreview(details, expanded, theme)}`, 0, 0);
}

export function renderFetchCall(args: Partial<FetchParams>, theme: ThemeLike, context?: RenderContext): Text {
  let text = theme.fg("toolTitle", theme.bold("web_fetch "));
  if (Array.isArray(args.urls) && args.urls.length === 1) {
    text += theme.fg("accent", stripTerminalControls(args.urls[0]!));
  }
  else text += theme.fg("accent", `${Array.isArray(args.urls) ? args.urls.length : 0} URLs`);
  const summary = context?.state?.fetchSummary as FetchRenderSummary | undefined;
  if (summary) text += theme.fg("dim", " — ") + renderFetchSummary(summary, theme);
  else if (args.maxCharacters) text += theme.fg("dim", ` (${args.maxCharacters} chars/url)`);
  return new Text(text, 0, 0);
}

export function renderFetchResult(
  result: ToolResultLike,
  { expanded, isPartial }: RenderOptions,
  theme: ThemeLike,
  context?: RenderContext,
): Text {
  if (isPartial) return new Text(theme.fg("warning", "Fetching with Kagi..."), 0, 0);
  if (context?.isError) return new Text(theme.fg("error", "✗ ") + resultText(result), 0, 0);

  const details = result.details;
  if (!isWebFetchDetails(details)) return new Text(theme.fg("dim", "No Kagi fetch results"), 0, 0);
  setFetchSummaryOnRenderContext(context, details);

  return new Text(`\n${renderFetchBody(result, expanded, theme)}`, 0, 0);
}

function resultText(result: ToolResultLike): string {
  return stripTerminalControls(result.content?.find((item) => item.type === "text")?.text ?? "Error");
}

function isWebSearchDetails(details: unknown): details is WebSearchDetails {
  return Boolean(
    details
    && typeof details === "object"
    && (details as { provider?: unknown }).provider === "kagi"
    && Array.isArray((details as { results?: unknown }).results),
  );
}

function isWebFetchDetails(details: unknown): details is WebFetchDetails {
  return Boolean(
    details
    && typeof details === "object"
    && (details as { provider?: unknown }).provider === "kagi"
    && Array.isArray((details as { results?: unknown }).results),
  );
}

function singleLine(value: string): string {
  return stripTerminalControls(value).replace(/\s+/g, " ").trim();
}

function shorten(value: string, max: number): string {
  const text = singleLine(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function domainLabel(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(stripTerminalControls(url), "https://kagi.com").hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function dateLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0];
}

function renderSearchResultsPreview(details: WebSearchDetails, expanded: boolean, theme: ThemeLike): string {
  let text = "";

  if (details.categories.length > 1 || expanded) {
    const categoryText = details.categories
      .map((category) => `${humanCategory(category.name)} ${category.count}`)
      .join(" · ");
    if (categoryText) text += theme.fg("dim", categoryText);
  }

  const limit = expanded ? 10 : 4;
  const snippetLength = expanded ? 240 : 150;
  for (const [index, item] of details.results.slice(0, limit).entries()) {
    const number = theme.fg("muted", `${index + 1}.`);
    const title = theme.fg(
      "accent",
      shorten(cleanSearchText(item.title || "Untitled") || "Untitled", expanded ? 110 : 90),
    );
    const snippet = item.snippet ? cleanSearchText(item.snippet) : undefined;
    const domain = domainLabel(item.url);
    const date = dateLabel(item.time);
    const meta = [
      domain,
      date,
      item.category !== "search" ? humanCategory(item.category) : undefined,
    ].filter(Boolean).join(" · ");

    text += `${text ? "\n" : ""}${number} ${title}`;
    if (meta) text += theme.fg("dim", `  ${meta}`);
    if (item.url) text += `\n   ${theme.fg("dim", shorten(item.url, expanded ? 130 : 105))}`;
    if (snippet) text += `\n   ${theme.fg("muted", shorten(snippet, snippetLength))}`;
  }

  if (details.results.length > limit) {
    const remaining = details.results.length - limit;
    text += `\n${theme.fg("muted", `… ${remaining} more result${remaining === 1 ? "" : "s"}`)}`;
  }
  if (expanded && details.fullOutputPath) {
    text += `\n${theme.fg("dim", `Full output: ${stripTerminalControls(details.fullOutputPath)}`)}`;
  }
  return text || theme.fg("dim", "No results");
}

function searchRenderSummary(details: WebSearchDetails): SearchRenderSummary {
  return {
    totalResults: details.totalResults,
    workflow: details.workflow,
    ms: details.meta?.ms,
    truncated: details.truncation?.truncated,
  };
}

function searchSummaryKey(summary: SearchRenderSummary): string {
  return `${summary.totalResults}:${summary.workflow}:${summary.ms ?? ""}:${summary.truncated ? 1 : 0}`;
}

function renderSearchSummary(summary: SearchRenderSummary, theme: ThemeLike): string {
  let text = theme.fg("success", `${summary.totalResults} result${summary.totalResults === 1 ? "" : "s"}`);
  text += theme.fg("muted", ` [${summary.workflow}]`);
  if (summary.ms !== undefined) text += theme.fg("dim", ` · ${summary.ms}ms`);
  if (summary.truncated) text += theme.fg("warning", " · truncated");
  return text;
}

function setSearchSummaryOnRenderContext(context: RenderContext | undefined, details: WebSearchDetails): void {
  if (!context?.state) return;
  const summary = searchRenderSummary(details);
  const key = searchSummaryKey(summary);
  if (context.state.searchSummaryKey === key) return;
  context.state.searchSummaryKey = key;
  context.state.searchSummary = summary;
  if (context.invalidate) queueMicrotask(context.invalidate);
}

function fetchRenderSummary(details: WebFetchDetails): FetchRenderSummary {
  const success = details.results.filter((item) => item.status === "success").length;
  const failed = details.results.length - success;
  return {
    success,
    failed,
    ms: details.meta?.ms,
    truncated: details.truncation?.truncated || details.fullOutputReason !== undefined,
  };
}

function fetchSummaryKey(summary: FetchRenderSummary): string {
  return `${summary.success}:${summary.failed}:${summary.ms ?? ""}:${summary.truncated ? 1 : 0}`;
}

function renderFetchSummary(summary: FetchRenderSummary, theme: ThemeLike): string {
  let text = theme.fg("success", `${summary.success} fetched`);
  if (summary.failed > 0) text += theme.fg("error", ` · ${summary.failed} failed`);
  if (summary.ms !== undefined) text += theme.fg("dim", ` · ${summary.ms}ms`);
  if (summary.truncated) text += theme.fg("warning", " · saved");
  return text;
}

function setFetchSummaryOnRenderContext(context: RenderContext | undefined, details: WebFetchDetails): void {
  if (!context?.state) return;
  const summary = fetchRenderSummary(details);
  const key = fetchSummaryKey(summary);
  if (context.state.fetchSummaryKey === key) return;
  context.state.fetchSummaryKey = key;
  context.state.fetchSummary = summary;
  if (context.invalidate) queueMicrotask(context.invalidate);
}

function fetchResultBody(result: ToolResultLike): string {
  const text = resultText(result).trimEnd();
  const lines = text.split("\n");
  if (lines[0]?.startsWith("Fetched ")) return lines.slice(1).join("\n").replace(/^\n+/, "").trimEnd();
  return text;
}

function truncationNotice(truncation: TruncationResult, theme: ThemeLike): string {
  const parts: string[] = [];
  const hiddenLines = truncation.totalLines - truncation.outputLines;
  const hiddenBytes = truncation.totalBytes - truncation.outputBytes;
  if (hiddenLines > 0) parts.push(`${hiddenLines} more ${hiddenLines === 1 ? "line" : "lines"}`);
  if (hiddenBytes > 0) parts.push(`${formatSize(hiddenBytes)} more`);
  const summary = parts.length > 0 ? parts.join(", ") : "more output";
  return theme.fg("muted", `... (truncated: ${summary},`) + ` ${keyHint("app.tools.expand", "to expand")})`;
}

function renderFetchBody(result: ToolResultLike, expanded: boolean, theme: ThemeLike): string {
  const body = fetchResultBody(result);
  if (!body) return theme.fg("dim", "No fetched content");
  if (expanded) return body;

  const preview = truncateHead(body, {
    maxLines: FETCH_COLLAPSED_MAX_LINES,
    maxBytes: FETCH_COLLAPSED_MAX_BYTES,
  });
  let text = preview.content.trimEnd();
  if (preview.truncated) text += `\n${truncationNotice(preview, theme)}`;
  return text;
}
