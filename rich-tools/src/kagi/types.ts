/** Shared Kagi request, response, and tool-detail shapes. */

import type { TruncationResult } from "@earendil-works/pi-coding-agent";

export const SEARCH_WORKFLOWS = ["search", "news", "videos", "podcasts", "images"] as const;
export const TIME_RELATIVE = ["day", "week", "month"] as const;
export const PERSONALIZATION_KINDS = ["block", "lower", "raise", "pin"] as const;

export type SearchWorkflow = (typeof SEARCH_WORKFLOWS)[number];
export type TimeRelative = (typeof TIME_RELATIVE)[number];
export type PersonalizationKind = (typeof PERSONALIZATION_KINDS)[number];

export interface SearchParams {
  query: string;
  numResults?: number;
  workflow?: SearchWorkflow;
  extractCount?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  includeKeywords?: string[];
  excludeKeywords?: string[];
  timeRelative?: TimeRelative;
  after?: string;
  before?: string;
  region?: string;
  searchRegion?: string;
  fileType?: string;
  lensId?: string;
  domainPersonalizations?: Array<{ domain: string; kind: PersonalizationKind }>;
  regexPersonalizations?: Array<{ regex: string; replacement?: string }>;
  safeSearch?: boolean;
  page?: number;
  timeoutSeconds?: number;
}

export interface FetchParams {
  urls: string[];
  maxCharacters?: number;
  timeoutSeconds?: number;
}

export interface KagiMeta {
  trace?: string;
  ms?: number;
  node?: string;
}

export interface KagiSearchResult {
  url?: string;
  title?: string;
  snippet?: string;
  time?: string;
  image?: { url?: string; width?: number; height?: number };
  props?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface KagiSearchResponse {
  meta?: KagiMeta;
  data?: Record<string, unknown>;
}

export interface KagiExtractPage {
  url?: string;
  markdown?: string | null;
  error?: string;
}

export interface KagiExtractResponse {
  meta?: KagiMeta;
  data?: KagiExtractPage[];
  errors?: KagiErrorDetail[];
  error?: KagiErrorDetail[];
}

export interface KagiErrorDetail {
  code?: string;
  message?: string | null;
  location?: string | null;
  url?: string;
}

export interface WebSearchDetails {
  ok: true;
  provider: "kagi";
  query: string;
  workflow: SearchWorkflow;
  numResults: number;
  extractCount: number;
  meta?: KagiMeta;
  totalResults: number;
  categories: Array<{ name: string; count: number }>;
  results: Array<{
    category: string;
    title?: string;
    url?: string;
    snippet?: string;
    time?: string;
    imageUrl?: string;
  }>;
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

export interface WebFetchDetails {
  ok: true;
  provider: "kagi";
  urls: string[];
  meta?: KagiMeta;
  results: Array<{
    url: string;
    status: "success" | "error";
    title?: string;
    characters?: number;
    error?: string;
  }>;
  errors?: KagiErrorDetail[];
  truncation?: TruncationResult;
  fullOutputPath?: string;
  fullOutputReason?: string;
}
