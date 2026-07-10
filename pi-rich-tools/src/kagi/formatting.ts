/** Convert Kagi response payloads into model-facing text and structured details. */

import { limitMarkdown } from "./truncation.ts";
import { stripTerminalControls, stripTerminalControlsDeep } from "./terminal.ts";
import type {
  KagiErrorDetail,
  KagiExtractPage,
  KagiExtractResponse,
  KagiSearchResponse,
  KagiSearchResult,
  SearchWorkflow,
  WebFetchDetails,
  WebSearchDetails,
} from "./types.ts";

const SEARCH_DETAIL_SNIPPET_MAX_CHARACTERS = 500;

export interface FormattedSearch {
  text: string;
  categories: Array<{ name: string; count: number }>;
  results: WebSearchDetails["results"];
}

export interface FormattedExtract {
  text: string;
  fullText: string;
  perPageTruncated: boolean;
  results: WebFetchDetails["results"];
  errors?: KagiErrorDetail[];
}

export function formatSearch(
  response: KagiSearchResponse,
  query: string,
  workflow: SearchWorkflow,
): FormattedSearch {
  const safeResponse = stripTerminalControlsDeep(response);
  const groups = categories(safeResponse.data);
  const flatResults: WebSearchDetails["results"] = [];
  let text = `Found ${groups.reduce((sum, group) => sum + group.results.length, 0)} Kagi ${workflow} result(s) for "${stripTerminalControls(query)}"`;
  if (safeResponse.meta?.trace) text += ` (trace: ${safeResponse.meta.trace})`;
  if (safeResponse.meta?.ms !== undefined) text += ` in ${safeResponse.meta.ms}ms`;
  text += ":\n";

  let globalIndex = 1;
  for (const group of groups) {
    text += `\n## ${humanCategory(group.name)} (${group.results.length})\n\n`;
    for (const result of group.results) {
      const title = cleanSearchText(
        textValue(result.title) || textValue(result.props?.question) || textValue(result.props?.answer) || "Untitled",
      );
      const url = textValue(result.url);
      const snippet = textValue(result.snippet);
      const cleanSnippet = snippet ? cleanSearchText(snippet) : undefined;
      const time = textValue(result.time);
      const imageUrl = textValue(result.image?.url);

      text += `### ${globalIndex}. ${title}\n`;
      if (url) text += `URL: ${url}\n`;
      if (time) text += `Published/updated: ${time}\n`;
      if (imageUrl) text += `Image: ${imageUrl}\n`;
      if (cleanSnippet) text += `\n${cleanSnippet}\n`;
      if (!url && !snippet && result.props) {
        text += `\nMetadata: ${stripTerminalControls(JSON.stringify(result.props)).slice(0, 1000)}\n`;
      }
      text += "\n";

      flatResults.push({
        category: group.name,
        title,
        url,
        snippet: cleanSnippet ? detailPreview(cleanSnippet, SEARCH_DETAIL_SNIPPET_MAX_CHARACTERS) : undefined,
        time,
        imageUrl,
      });
      globalIndex++;
    }
  }

  if (groups.length === 0) text += "\nNo result categories returned.\n";
  return {
    text,
    categories: groups.map((group) => ({ name: group.name, count: group.results.length })),
    results: flatResults,
  };
}

export function formatExtract(
  response: KagiExtractResponse,
  requestedUrls: string[],
  maxCharacters: number,
): FormattedExtract {
  const safeResponse = stripTerminalControlsDeep(response);
  const pages = safeResponse.data ?? [];
  const safeRequestedUrls = requestedUrls.map(stripTerminalControls);
  const matchedPages = matchExtractPages(pages, safeRequestedUrls);
  const results: WebFetchDetails["results"] = [];
  let text = `Fetched ${matchedPages.filter((page) => page?.markdown).length} of ${safeRequestedUrls.length} URL(s) with Kagi Extract`;
  if (safeResponse.meta?.trace) text += ` (trace: ${safeResponse.meta.trace})`;
  if (safeResponse.meta?.ms !== undefined) text += ` in ${safeResponse.meta.ms}ms`;
  text += ":\n";
  let fullText = text;
  let perPageTruncated = false;

  for (let index = 0; index < safeRequestedUrls.length; index++) {
    const requestedUrl = safeRequestedUrls[index]!;
    const page = matchedPages[index];
    const url = page?.url || requestedUrl;
    if (page?.markdown) {
      const limited = limitMarkdown(page.markdown, maxCharacters);
      const title = firstHeading(page.markdown) || firstHeading(limited.markdown);
      const heading = `${index > 0 ? "\n---\n" : ""}\n# ${title || url}\nURL: ${url}\n`;
      text += heading;
      if (limited.truncated) text += `Original characters: ${limited.originalCharacters}\n`;
      text += `\n${limited.markdown.trim()}\n`;
      fullText += `${heading}\n${page.markdown.trim()}\n`;
      perPageTruncated = perPageTruncated || limited.truncated;
      results.push({ url, status: "success", title, characters: page.markdown.length });
    } else {
      const error = page?.error || "No markdown content returned";
      const failure = `${index > 0 ? "\n---\n" : ""}\n# ${url}\nURL: ${url}\nStatus: failed\nError: ${error}\n`;
      text += failure;
      fullText += failure;
      results.push({ url, status: "error", error });
    }
  }

  const errors = safeResponse.errors ?? safeResponse.error;
  if (errors?.length) {
    let errorText = "\n## API errors\n";
    for (const error of errors) {
      errorText += `- ${[error.code, error.location, error.message].filter(Boolean).join(" — ")}\n`;
    }
    text += errorText;
    fullText += errorText;
  }

  return { text, fullText, perPageTruncated, results, errors };
}

function matchExtractPages(
  pages: KagiExtractPage[],
  requestedUrls: string[],
): Array<KagiExtractPage | undefined> {
  const matches: Array<KagiExtractPage | undefined> = Array.from({ length: requestedUrls.length });
  const consumedPages = new Set<number>();

  // Reserve every exact URL match first. This prevents an earlier missing URL
  // from stealing a later URL's page through the positional fallback.
  for (const [requestIndex, requestedUrl] of requestedUrls.entries()) {
    const pageIndex = pages.findIndex(
      (page, candidateIndex) => !consumedPages.has(candidateIndex) && page.url === requestedUrl,
    );
    if (pageIndex < 0) continue;
    matches[requestIndex] = pages[pageIndex];
    consumedPages.add(pageIndex);
  }

  // Kagi may return a redirected URL instead of the requested one. Pair only
  // the remaining requests and pages, in order, so each response is used once.
  const fallbackPages = pages.filter((_, index) => !consumedPages.has(index));
  let fallbackIndex = 0;
  for (let requestIndex = 0; requestIndex < matches.length && fallbackIndex < fallbackPages.length; requestIndex++) {
    if (matches[requestIndex]) continue;
    matches[requestIndex] = fallbackPages[fallbackIndex++];
  }

  return matches;
}

function categories(data: Record<string, unknown> | undefined): Array<{ name: string; results: KagiSearchResult[] }> {
  if (!data) return [];
  return Object.entries(data)
    .filter(([, value]) => Array.isArray(value) && value.length > 0)
    .map(([name, value]) => ({
      name: stripTerminalControls(name),
      results: (value as unknown[]).filter(isRecord).map((item) => item as KagiSearchResult),
    }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function textValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = stripTerminalControls(value);
  return text.trim() ? text : undefined;
}

function detailPreview(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;

  // Avoid persisting complete extracted pages in tool details. The full text
  // remains in model-facing output (and its truncation file), while details
  // only need enough context for the expanded TUI preview.
  let end = maxCharacters - 1;
  const lastIncluded = value.charCodeAt(end - 1);
  const firstExcluded = value.charCodeAt(end);
  if (lastIncluded >= 0xd800 && lastIncluded <= 0xdbff && firstExcluded >= 0xdc00 && firstExcluded <= 0xdfff) {
    end--;
  }
  return `${value.slice(0, end).trimEnd()}…`;
}

export function humanCategory(value: string): string {
  return stripTerminalControls(value).replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripHtmlTags(value: string): string {
  return value
    .replace(/<\/?(?:strong|em|b|i|mark)>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
}

export function cleanSearchText(value: string): string {
  // Strip Kagi's emphasis markup before decoding entities so escaped text such
  // as `&lt;T&gt;` remains visible instead of being mistaken for an HTML tag.
  return stripTerminalControls(decodeHtml(stripHtmlTags(value)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstHeading(markdown: string | undefined | null): string | undefined {
  if (!markdown) return undefined;
  for (const line of markdown.split("\n")) {
    const match = line.match(/^#{1,3}\s+(.+)$/);
    if (match?.[1]) return match[1].trim().slice(0, 200);
  }
  return undefined;
}
