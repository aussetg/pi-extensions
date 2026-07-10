/** Kagi-backed web_search and web_fetch tool registration. */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildExtractRequest, buildSearchRequest, kagiPost } from "./kagi/api.ts";
import { formatExtract, formatSearch } from "./kagi/formatting.ts";
import {
  renderFetchCall,
  renderFetchResult,
  renderSearchCall,
  renderSearchResult,
} from "./kagi/renderer.ts";
import { truncateToolOutput } from "./kagi/truncation.ts";
import {
  PERSONALIZATION_KINDS,
  SEARCH_WORKFLOWS,
  TIME_RELATIVE,
  type FetchParams,
  type KagiExtractResponse,
  type KagiSearchResponse,
  type SearchParams,
  type WebFetchDetails,
  type WebSearchDetails,
} from "./kagi/types.ts";

const WebSearchParams = Type.Object({
  query: Type.String({
    description: "Search query to run. Prefer concise, keyword-focused queries with enough context to stand alone.",
  }),
  numResults: Type.Optional(Type.Integer({
    description: "Maximum number of results per category to return (default: 10, max: 100).",
    minimum: 1,
    maximum: 100,
  })),
  workflow: Type.Optional(StringEnum(SEARCH_WORKFLOWS, {
    description: "Result type: general web search, news, videos, podcasts, or images (default: search).",
  })),
  extractCount: Type.Optional(Type.Integer({
    description: "Fetch full markdown content inline for this many top search results (default: 0, max: 10). Costs extra Kagi Extract API units.",
    minimum: 0,
    maximum: 10,
  })),
  includeDomains: Type.Optional(Type.Array(Type.String(), {
    description: "Restrict results to these domains, e.g. ['docs.python.org', 'github.com'].",
  })),
  excludeDomains: Type.Optional(Type.Array(Type.String(), {
    description: "Exclude results from these domains, e.g. ['pinterest.com', 'quora.com'].",
  })),
  includeKeywords: Type.Optional(Type.Array(Type.String(), {
    description: "Kagi inline lens: return only results containing these keywords.",
  })),
  excludeKeywords: Type.Optional(Type.Array(Type.String(), {
    description: "Kagi inline lens: exclude results containing these keywords.",
  })),
  timeRelative: Type.Optional(StringEnum(TIME_RELATIVE, {
    description: "Restrict to results published or updated within the last day, week, or month. Mutually exclusive with after/before.",
  })),
  after: Type.Optional(Type.String({
    description: "Only include results published or updated on or after this date (YYYY-MM-DD).",
  })),
  before: Type.Optional(Type.String({
    description: "Only include results published or updated on or before this date (YYYY-MM-DD).",
  })),
  region: Type.Optional(Type.String({
    description: "Filter results to a region using an ISO 3166-1 alpha-2 country code supported by Kagi, e.g. US, GB, FR.",
  })),
  searchRegion: Type.Optional(Type.String({
    description: "Kagi inline lens search_region. ISO 3166-1 alpha-2 country code, or 'no_region' for general results.",
  })),
  fileType: Type.Optional(Type.String({
    description: "Restrict to this file type, e.g. pdf, docx, xlsx. Omit the leading dot.",
  })),
  lensId: Type.Optional(Type.String({
    description: "Apply a Kagi lens ID or shareable lens URL. Mutually exclusive with inline lens fields: include/exclude domains, include/exclude keywords, timeRelative, fileType, and searchRegion.",
  })),
  domainPersonalizations: Type.Optional(Type.Array(Type.Object({
    domain: Type.String({ description: "Domain pattern to personalize, e.g. example.com or .co.uk." }),
    kind: StringEnum(PERSONALIZATION_KINDS, {
      description: "How Kagi should rank this request.",
    }),
  }), {
    description: "Per-request Kagi domain personalization rules: block, lower, raise, or pin domains.",
    maxItems: 1000,
  })),
  regexPersonalizations: Type.Optional(Type.Array(Type.Object({
    regex: Type.String({ description: "Regex pattern to match result URLs." }),
    replacement: Type.Optional(Type.String({
      description: "Replacement URL/string. Capture groups like $1 are supported.",
    })),
  }), {
    description: "Per-request Kagi regex personalization rules for URL rewrites.",
    maxItems: 1000,
  })),
  safeSearch: Type.Optional(Type.Boolean({ description: "Enable Kagi safe search (default: true)." })),
  page: Type.Optional(Type.Integer({
    description: "Page number for paginated results (1-10).",
    minimum: 1,
    maximum: 10,
  })),
  timeoutSeconds: Type.Optional(Type.Number({
    description: "Kagi search collection timeout in seconds (0.5-4). Lower is faster but can reduce quality.",
    minimum: 0.5,
    maximum: 4,
  })),
});

const WebFetchParams = Type.Object({
  urls: Type.Array(Type.String(), {
    description: "One to ten HTTPS URLs to extract as markdown via Kagi Extract.",
    minItems: 1,
    maxItems: 10,
  }),
  maxCharacters: Type.Optional(Type.Integer({
    description: "Maximum markdown characters to include per URL before global tool truncation (default: 20000).",
    minimum: 1000,
    maximum: 200000,
  })),
  timeoutSeconds: Type.Optional(Type.Number({
    description: "Bulk extraction timeout in seconds (0.5-10). All URLs are fetched concurrently.",
    minimum: 0.5,
    maximum: 10,
  })),
});

export function registerKagiWebTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: `Search the web using Kagi Search API. Returns Kagi result categories with titles, URLs, snippets, dates, image URLs, and metadata. Supports Kagi lenses, inline lens constraints, region/date filters, and per-request personalizations. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). If truncated, full output is saved to a temp file.`,
    promptSnippet: "Search the web with Kagi.",
    promptGuidelines: [
      "Use web_search when current or external web information is needed.",
      "Use web_search workflow='news' for current events and reporting; use workflow='search' for general web results.",
      "Use web_search includeDomains for trusted-source searches and after/before/timeRelative for freshness constraints.",
      "Use web_search lensId for Kagi lenses, or inline lens fields such as includeDomains, excludeDomains, includeKeywords, excludeKeywords, fileType, and searchRegion.",
      "Use web_search domainPersonalizations or regexPersonalizations when the user wants this request to pin, raise, lower, block, or rewrite specific sources beyond their account defaults.",
      "Use web_search extractCount only when search snippets are insufficient, because it consumes extra Kagi Extract API units.",
    ],
    parameters: WebSearchParams,

    async execute(_toolCallId: string, params: SearchParams, signal?: AbortSignal) {
      const request = buildSearchRequest(params);
      const response = await kagiPost<KagiSearchResponse>("/search", request.body, {
        signal,
        timeoutMs: Math.ceil(
          (request.timeoutSeconds + Math.max(request.extractCount, 0) * request.timeoutSeconds + 8) * 1000,
        ),
      });

      const formatted = formatSearch(response.data, params.query, request.workflow);
      const truncated = await truncateToolOutput(formatted.text, "pi-kagi-search-", "search.md");
      const details: WebSearchDetails = {
        ok: true,
        provider: "kagi",
        query: params.query,
        workflow: request.workflow,
        numResults: request.numResults,
        extractCount: request.extractCount,
        meta: response.data.meta,
        totalResults: formatted.results.length,
        categories: formatted.categories,
        results: formatted.results,
        truncation: truncated.truncation,
        fullOutputPath: truncated.fullOutputPath,
      };

      return { content: [{ type: "text" as const, text: truncated.text }], details };
    },

    renderCall: renderSearchCall,
    renderResult: renderSearchResult,
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: `Fetch the markdown content of web pages using Kagi Extract API. Accepts up to 10 HTTPS URLs. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). If truncated, full output is saved to a temp file.`,
    promptSnippet: "Fetch web page markdown with Kagi Extract.",
    promptGuidelines: [
      "Use web_fetch to read a known URL after web_search returns it or when the user gives a URL.",
      "Use web_fetch with multiple URLs only when comparing sources; keep batches small because extraction costs API units.",
      "Use web_fetch maxCharacters to increase per-page content when a long page is important.",
    ],
    parameters: WebFetchParams,

    async execute(_toolCallId: string, params: FetchParams, signal?: AbortSignal) {
      const request = buildExtractRequest(params);
      const response = await kagiPost<KagiExtractResponse>("/extract", request.body, {
        signal,
        timeoutMs: Math.ceil((request.timeoutSeconds + 8) * 1000),
      });

      const formatted = formatExtract(response.data, request.urls, request.maxCharacters);
      const truncated = await truncateToolOutput(formatted.text, "pi-kagi-fetch-", "content.md", {
        fullText: formatted.fullText,
        forceSaveFullOutput: formatted.perPageTruncated,
        saveReason: formatted.perPageTruncated ? "one or more pages exceeded maxCharacters" : undefined,
      });
      const details: WebFetchDetails = {
        ok: true,
        provider: "kagi",
        urls: request.urls,
        meta: response.data.meta,
        results: formatted.results,
        errors: formatted.errors,
        truncation: truncated.truncation,
        fullOutputPath: truncated.fullOutputPath,
        fullOutputReason: truncated.fullOutputReason,
      };

      return { content: [{ type: "text" as const, text: truncated.text }], details };
    },

    renderCall: renderFetchCall,
    renderResult: renderFetchResult,
  });
}
