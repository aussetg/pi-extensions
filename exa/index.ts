/**
 * Exa Web Tools - Search and fetch web content using Exa AI
 *
 * Provides two tools:
 * - web_search: Neural search via Exa's search API
 * - web_fetch: Fetch page contents via Exa's contents API
 *
 * Best practices implemented:
 * - Token-efficient highlights mode for agentic workflows
 * - Category filters for specialized content
 * - Domain filtering (include/exclude)
 * - Content freshness via maxAgeHours
 * - Output truncation with temp file fallback
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type TruncationResult,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Lazy-loaded Exa client
let _exa: any = null;
function getExa() {
	if (!_exa) {
		// Dynamic import to handle ESM module
		const Exa = require("exa-js").default;
		_exa = new Exa(process.env.EXA_API_KEY);
	}
	return _exa;
}

// ============================================================================
// Web Search Tool
// ============================================================================

const SEARCH_CATEGORIES = ["company", "research paper", "news", "pdf", "tweet", "personal site", "financial report", "people"] as const;
const SEARCH_TYPES = ["auto", "instant", "deep"] as const;

const WebSearchParams = Type.Object({
	query: Type.String({ description: "The search query. Supports long, semantically rich descriptions for finding niche content." }),
	numResults: Type.Optional(Type.Number({ description: "Number of results to return (default: 5, max: 100)", minimum: 1, maximum: 100 })),
	type: Type.Optional(StringEnum(SEARCH_TYPES)),
	useAutoprompt: Type.Optional(Type.Boolean({ description: "Let Exa optimize your query for better results (default: true)" })),
	category: Type.Optional(StringEnum(SEARCH_CATEGORIES)),
	includeDomains: Type.Optional(Type.Array(Type.String(), { description: "List of domains to include in the search" })),
	excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "List of domains to exclude from the search" })),
	startPublishedDate: Type.Optional(Type.String({ description: "Start date for results based on published date (ISO format, e.g., 2024-01-01)" })),
	endPublishedDate: Type.Optional(Type.String({ description: "End date for results based on published date (ISO format)" })),
});

interface WebSearchDetails {
	query: string;
	numResults: number;
	type: string;
	category?: string;
	results: Array<{
		title: string | null;
		url: string;
		publishedDate?: string;
		author?: string;
		score?: number;
	}>;
	costDollars: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

// ============================================================================
// Web Fetch Tool
// ============================================================================

const WebFetchParams = Type.Object({
	urls: Type.Array(Type.String(), { description: "One or more URLs to fetch content from" }),
	text: Type.Optional(Type.Boolean({ description: "Return full page text as markdown (default: true)" })),
	maxCharacters: Type.Optional(Type.Number({ description: "Maximum characters per result (default: 10000)" })),
	highlights: Type.Optional(Type.Object({
		query: Type.Optional(Type.String({ description: "Query to find relevant highlights" })),
		maxCharacters: Type.Optional(Type.Number({ description: "Maximum characters for highlights" })),
	})),
	maxAgeHours: Type.Optional(Type.Number({ description: "Maximum age of cached content in hours. 0 = always fresh, -1 = cache only" })),
	subpages: Type.Optional(Type.Number({ description: "Number of subpages to crawl from each URL" })),
	subpageTarget: Type.Optional(Type.Array(Type.String(), { description: "Keywords to prioritize when selecting subpages" })),
});

interface WebFetchDetails {
	urls: string[];
	results: Array<{
		url: string;
		title?: string;
		status: string;
	}>;
	costDollars: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
	// ----------------------------------
	// Web Search Tool
	// ----------------------------------
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: `Search the web using Exa AI's neural search. Returns a list of relevant web pages with titles, URLs, and metadata. Use this to find information on the web.

Best practices:
- Use specific category filters for better results (company, news, research paper, etc.)
- Use includeDomains to limit to trusted sources
- Use startPublishedDate/endPublishedDate for recent content
- Query supports long, semantically rich descriptions`,
		parameters: WebSearchParams,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			if (!process.env.EXA_API_KEY) {
				return {
					content: [{ type: "text", text: "Error: EXA_API_KEY environment variable is not set." }],
					isError: true,
					details: { query: params.query, error: "Missing API key" },
				};
			}

			const exa = getExa();
			const numResults = params.numResults ?? 5;

			const searchOptions: Record<string, any> = {
				numResults,
				type: params.type ?? "auto",
				useAutoprompt: params.useAutoprompt ?? true,
			};

			if (params.category) searchOptions.category = params.category;
			if (params.includeDomains) searchOptions.includeDomains = params.includeDomains;
			if (params.excludeDomains) searchOptions.excludeDomains = params.excludeDomains;
			if (params.startPublishedDate) searchOptions.startPublishedDate = params.startPublishedDate;
			if (params.endPublishedDate) searchOptions.endPublishedDate = params.endPublishedDate;

			let result;
			try {
				result = await exa.search(params.query, searchOptions);
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Search failed: ${err.message}` }],
					isError: true,
					details: { query: params.query, error: err.message },
				};
			}

			const results = result.results || [];

			// Format results for LLM
			let text = `Found ${results.length} results for "${params.query}"`;
			if (params.category) text += ` (category: ${params.category})`;
			text += ":\n\n";

			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				text += `## ${i + 1}. ${r.title || "Untitled"}\n`;
				text += `URL: ${r.url}\n`;
				if (r.publishedDate) text += `Published: ${r.publishedDate}\n`;
				if (r.author) text += `Author: ${r.author}\n`;
				if (r.score !== undefined) text += `Relevance: ${(r.score * 100).toFixed(1)}%\n`;
				text += "\n";
			}

			if (result.costDollars?.total !== undefined) {
				text += `Cost: $${result.costDollars.total.toFixed(4)}`;
			}

			const details: WebSearchDetails = {
				query: params.query,
				numResults,
				type: searchOptions.type,
				category: params.category,
				results: results.map((r: any) => ({
					title: r.title,
					url: r.url,
					publishedDate: r.publishedDate,
					author: r.author,
					score: r.score,
				})),
				costDollars: result.costDollars?.total ?? 0,
			};

			return {
				content: [{ type: "text", text }],
				details,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("web_search "));
			text += theme.fg("accent", `"${args.query}"`);
			if (args.category) {
				text += theme.fg("muted", ` [${args.category}]`);
			}
			if (args.numResults) {
				text += theme.fg("dim", ` (${args.numResults} results)`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Searching..."), 0, 0);
			}

			const details = result.details as WebSearchDetails | undefined;
			if (!details) {
				return new Text(theme.fg("dim", "No results"), 0, 0);
			}

			let text = theme.fg("success", `${details.results.length} results`);
			if (details.category) {
				text += theme.fg("muted", ` [${details.category}]`);
			}
			text += theme.fg("dim", ` · $${details.costDollars.toFixed(4)}`);

			if (expanded && details.results.length > 0) {
				for (const r of details.results.slice(0, 5)) {
					text += `\n  ${theme.fg("accent", r.title || "Untitled")}`;
					text += theme.fg("dim", ` - ${r.url}`);
				}
				if (details.results.length > 5) {
					text += `\n  ${theme.fg("muted", `... and ${details.results.length - 5} more`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// ----------------------------------
	// Web Fetch Tool
	// ----------------------------------
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: `Fetch the text content of web pages using Exa AI's contents API. Returns the extracted text content from the specified URLs. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). If truncated, full output is saved to a temp file.

Best practices:
- Use highlights.query to get the most relevant excerpts for your question
- Use subpages to crawl linked pages from a documentation site
- Use maxAgeHours=0 for real-time data, maxAgeHours=-1 for maximum speed (cache only)
- Combine text=true with highlights for both full context and key excerpts`,
		parameters: WebFetchParams,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			if (!process.env.EXA_API_KEY) {
				return {
					content: [{ type: "text", text: "Error: EXA_API_KEY environment variable is not set." }],
					isError: true,
					details: { urls: params.urls, error: "Missing API key" },
				};
			}

			const exa = getExa();

			const contentOptions: Record<string, any> = {};

			// Text option (default: true)
			if (params.text !== false) {
				contentOptions.text = params.maxCharacters
					? { maxCharacters: params.maxCharacters }
					: true;
			}

			// Highlights option
			if (params.highlights) {
				contentOptions.highlights = params.highlights;
			}

			// Freshness
			if (params.maxAgeHours !== undefined) {
				contentOptions.maxAgeHours = params.maxAgeHours;
			}

			// Subpage crawling
			if (params.subpages) {
				contentOptions.subpages = params.subpages;
			}
			if (params.subpageTarget) {
				contentOptions.subpageTarget = params.subpageTarget;
			}

			let result;
			try {
				result = await exa.getContents(params.urls, contentOptions);
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Fetch failed: ${err.message}` }],
					isError: true,
					details: { urls: params.urls, error: err.message },
				};
			}

			const results = result.results || [];
			const statuses = result.statuses || [];

			// Build details
			const details: WebFetchDetails = {
				urls: params.urls,
				results: statuses.map((s: any) => {
					const r = results.find((res: any) => res.id === s.id || res.url === s.id);
					return {
						url: s.id,
						title: r?.title,
						status: s.status,
					};
				}),
				costDollars: result.costDollars?.total ?? 0,
			};

			// Format results for LLM
			let text = "";

			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				const status = statuses.find((s: any) => s.id === r.id || s.id === r.url);

				if (i > 0) text += "\n\n---\n\n";

				text += `# ${r.title || r.url}\n`;
				text += `URL: ${r.url || r.id}\n`;
				if (status?.status) text += `Status: ${status.status}\n`;
				text += "\n";

				if (r.text) {
					text += r.text;
				} else if (r.highlights?.length) {
					text += "### Key Excerpts:\n";
					for (const h of r.highlights) {
						text += `> ${h}\n`;
					}
				} else {
					text += "(No content extracted)";
				}
			}

			// Report failed URLs
			const failed = statuses.filter((s: any) => s.status !== "success");
			if (failed.length > 0) {
				text += "\n\n## Failed URLs:\n";
				for (const f of failed) {
					text += `- ${f.id}: ${f.status}`;
					if (f.error?.tag) text += ` (${f.error.tag})`;
					text += "\n";
				}
			}

			if (result.costDollars?.total !== undefined) {
				text += `\n\nCost: $${result.costDollars.total.toFixed(4)}`;
			}

			// Apply truncation
			const truncation = truncateHead(text, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let resultText = truncation.content;
			details.truncation = truncation.truncated ? truncation : undefined;

			if (truncation.truncated) {
				const tempDir = mkdtempSync(join(tmpdir(), "pi-webfetch-"));
				const tempFile = join(tempDir, "content.md");
				writeFileSync(tempFile, text);
				details.fullOutputPath = tempFile;

				resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
				resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				resultText += ` Full output saved to: ${tempFile}]`;
			}

			return {
				content: [{ type: "text", text: resultText }],
				details,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("web_fetch "));
			if (args.urls.length === 1) {
				text += theme.fg("accent", args.urls[0]);
			} else {
				text += theme.fg("accent", `${args.urls.length} URLs`);
			}
			if (args.highlights) {
				text += theme.fg("muted", " [highlights]");
			}
			if (args.subpages) {
				text += theme.fg("muted", ` [+${args.subpages} subpages]`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			}

			const details = result.details as WebFetchDetails | undefined;
			if (!details) {
				return new Text(theme.fg("dim", "No results"), 0, 0);
			}

			const success = details.results.filter((r) => r.status === "success").length;
			const failed = details.results.length - success;

			let text = theme.fg("success", `${success} fetched`);
			if (failed > 0) {
				text += theme.fg("error", ` · ${failed} failed`);
			}
			text += theme.fg("dim", ` · $${details.costDollars.toFixed(4)}`);

			if (details.truncation?.truncated) {
				text += theme.fg("warning", " (truncated)");
			}

			if (expanded && details.results.length > 0) {
				for (const r of details.results.slice(0, 5)) {
					const statusIcon = r.status === "success" ? "✓" : "✗";
					const statusColor = r.status === "success" ? "success" : "error";
					text += `\n  ${theme.fg(statusColor, statusIcon)} ${r.title || r.url}`;
				}
				if (details.results.length > 5) {
					text += `\n  ${theme.fg("muted", `... and ${details.results.length - 5} more`)}`;
				}
				if (details.fullOutputPath) {
					text += `\n  ${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
