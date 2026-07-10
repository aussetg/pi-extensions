/** Request validation, request construction, credentials, and Kagi HTTP transport. */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  PERSONALIZATION_KINDS,
  type FetchParams,
  type KagiErrorDetail,
  type SearchParams,
  type SearchWorkflow,
} from "./types.ts";
import { stripTerminalControls, stripTerminalControlsDeep } from "./terminal.ts";

const KAGI_API_BASE = "https://kagi.com/api/v1";
const USER_AGENT = "pi-rich-tools/kagi-web-tools";
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

interface KagiRequestOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface SearchRequest {
  body: Record<string, unknown>;
  workflow: SearchWorkflow;
  numResults: number;
  extractCount: number;
  timeoutSeconds: number;
}

export interface ExtractRequest {
  body: Record<string, unknown>;
  urls: string[];
  maxCharacters: number;
  timeoutSeconds: number;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function kagiConfigPath(): string {
  return process.env.KAGI_CONFIG_FILE || join(agentDir(), "kagi.json");
}

async function getKagiApiKey(): Promise<string> {
  const configPath = kagiConfigPath();
  let configReadError: unknown;
  try {
    const raw = await readFile(configPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const value = parsed && typeof parsed === "object"
      ? (parsed as { apiKey?: unknown; key?: unknown; kagiApiKey?: unknown }).apiKey
        ?? (parsed as { apiKey?: unknown; key?: unknown; kagiApiKey?: unknown }).key
        ?? (parsed as { apiKey?: unknown; key?: unknown; kagiApiKey?: unknown }).kagiApiKey
      : undefined;

    if (typeof value === "string" && value.trim()) return value.trim();
    throw new Error(`Kagi API key not found in ${configPath}. Expected { "apiKey": "..." }.`);
  } catch (error) {
    configReadError = error;
  }

  const envKey = process.env.KAGI_API_KEY?.trim();
  if (envKey) return envKey;

  if (configReadError instanceof Error && !configReadError.message.includes("ENOENT")) throw configReadError;
  throw new Error(`Kagi API key not found. Create ${configPath} with { "apiKey": "..." } or set KAGI_API_KEY.`);
}

function abortSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`Kagi request timed out after ${Math.round(timeoutMs / 1000)}s`)),
    timeoutMs,
  );
  const onAbort = () => controller.abort(parent?.reason ?? new Error("Kagi request aborted"));

  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

function maxRetries(): number {
  const raw = process.env.KAGI_MAX_RETRIES?.trim();
  if (!raw) return 2;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 5) : 2;
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 10_000);
  }
  return Math.min(500 * 2 ** attempt, 5_000);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      settled = true;
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("aborted"));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function kagiPost<T>(
  path: "/search" | "/extract",
  body: Record<string, unknown>,
  options: KagiRequestOptions,
): Promise<{ data: T; headers: Headers; status: number }> {
  const apiKey = await getKagiApiKey();
  const attempts = maxRetries() + 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const requestSignal = abortSignal(options.signal, options.timeoutMs);
    let requestResult: { response: Response; text: string } | { error: unknown };
    try {
      const response = await fetch(`${KAGI_API_BASE}${path}`, {
        method: "POST",
        signal: requestSignal.signal,
        headers: {
          "Accept": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      requestResult = { response, text };
    } catch (error) {
      requestResult = { error };
    } finally {
      requestSignal.cleanup();
    }

    if ("error" in requestResult) {
      lastError = requestResult.error;
      if (options.signal?.aborted) throw requestResult.error;
      if (attempt + 1 >= attempts) break;
      await sleep(Math.min(500 * 2 ** attempt, 5_000), options.signal);
      continue;
    }

    const { response, text } = requestResult;
    if (!response.ok) {
      const error = new Error(`Kagi API error (${response.status}): ${formatKagiError(text)}${traceSuffix(response.headers)}`);
      if (!RETRY_STATUSES.has(response.status) || attempt + 1 >= attempts) throw error;
      lastError = error;
      await sleep(retryDelayMs(response, attempt), options.signal);
      continue;
    }

    try {
      return {
        data: stripTerminalControlsDeep(JSON.parse(text) as T),
        headers: response.headers,
        status: response.status,
      };
    } catch (error) {
      throw new Error(stripTerminalControls(
        `Kagi API returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function traceSuffix(headers: Headers): string {
  const trace = headers.get("x-kagi-trace");
  return trace ? ` (trace id: ${stripTerminalControls(trace)})` : "";
}

function formatKagiError(text: string): string {
  if (!text.trim()) return "empty response body";
  try {
    const parsed = JSON.parse(text) as { errors?: KagiErrorDetail[]; error?: KagiErrorDetail[]; message?: string };
    const errors = parsed.errors ?? parsed.error;
    if (Array.isArray(errors) && errors.length > 0) {
      return stripTerminalControls(
        errors.map((error) => [error.code, error.location, error.message].filter(Boolean).join(" at ")).join("; "),
      );
    }
    if (parsed.message) return stripTerminalControls(parsed.message);
  } catch {
    // Fall through to the raw body.
  }
  return stripTerminalControls(text.slice(0, 2000));
}

export function buildSearchRequest(params: SearchParams): SearchRequest {
  if (!params.query.trim()) throw new Error("web_search requires a non-empty query.");
  if (params.timeRelative && (params.after || params.before)) {
    throw new Error("timeRelative is mutually exclusive with after/before.");
  }

  const workflow = params.workflow ?? "search";
  const numResults = clampInteger(params.numResults, 10, 1, 100);
  const extractCount = clampInteger(params.extractCount, 0, 0, 10);
  const timeoutSeconds = clampNumber(params.timeoutSeconds, 4, 0.5, 4);

  const lensFields: Record<string, unknown> = {
    sites_included: cleanStringArray(params.includeDomains),
    sites_excluded: cleanStringArray(params.excludeDomains),
    keywords_included: cleanStringArray(params.includeKeywords),
    keywords_excluded: cleanStringArray(params.excludeKeywords),
    time_relative: params.timeRelative,
    file_type: params.fileType?.replace(/^\./, "").trim() || undefined,
    search_region: params.searchRegion?.trim() || undefined,
  };
  const hasLensFields = Object.values(lensFields).some((value) => value !== undefined);
  if (params.lensId && hasLensFields) {
    throw new Error("lensId is mutually exclusive with inline lens fields such as includeDomains, excludeDomains, includeKeywords, excludeKeywords, timeRelative, fileType, and searchRegion.");
  }

  const filters: Record<string, unknown> = {};
  const after = validateDate("after", params.after);
  const before = validateDate("before", params.before);
  if (after && before && after > before) throw new Error("after must not be later than before.");
  if (after) filters.after = after;
  if (before) filters.before = before;
  if (params.region?.trim()) filters.region = params.region.trim();

  const body: Record<string, unknown> = {
    query: params.query,
    workflow,
    format: "json",
    limit: numResults,
    safe_search: params.safeSearch ?? true,
    timeout: timeoutSeconds,
  };
  if (params.page !== undefined) body.page = clampInteger(params.page, 1, 1, 10);
  if (extractCount > 0) body.extract = { count: extractCount, timeout: timeoutSeconds };
  if (params.lensId?.trim()) body.lens_id = params.lensId.trim();
  if (hasLensFields) {
    body.lens = Object.fromEntries(Object.entries(lensFields).filter(([, value]) => value !== undefined));
  }
  if (Object.keys(filters).length > 0) body.filters = filters;

  const domainPersonalizations = (params.domainPersonalizations ?? [])
    .map((rule) => ({ domain: rule.domain.trim(), kind: rule.kind }))
    .filter((rule) => rule.domain && (PERSONALIZATION_KINDS as readonly string[]).includes(rule.kind));
  const regexPersonalizations = (params.regexPersonalizations ?? [])
    .map((rule) => ({ regex: rule.regex.trim(), replacement: rule.replacement }))
    .filter((rule) => rule.regex);
  if (domainPersonalizations.length > 0 || regexPersonalizations.length > 0) {
    body.personalizations = {
      ...(domainPersonalizations.length > 0 ? { domains: domainPersonalizations } : {}),
      ...(regexPersonalizations.length > 0 ? { regexes: regexPersonalizations } : {}),
    };
  }

  return { body, workflow, numResults, extractCount, timeoutSeconds };
}

export function buildExtractRequest(params: FetchParams): ExtractRequest {
  const urls = cleanStringArray(params.urls) ?? [];
  if (urls.length === 0) throw new Error("web_fetch requires at least one URL.");
  if (urls.length > 10) throw new Error("Kagi Extract accepts at most 10 URLs per request.");
  for (let index = 0; index < urls.length; index++) validateHttpsUrl(urls[index]!, index);

  const timeoutSeconds = clampNumber(params.timeoutSeconds, 10, 0.5, 10);
  const maxCharacters = clampInteger(params.maxCharacters, 20_000, 1_000, 200_000);
  return {
    urls,
    maxCharacters,
    timeoutSeconds,
    body: {
      pages: urls.map((url) => ({ url })),
      format: "json",
      timeout: timeoutSeconds,
    },
  };
}

function validateDate(name: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} must be an ISO date in YYYY-MM-DD format.`);
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (daysInMonth === undefined || day < 1 || day > daysInMonth) {
    throw new Error(`${name} must be a valid ISO date in YYYY-MM-DD format.`);
  }
  return value;
}

function validateHttpsUrl(value: string, index: number): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`urls[${index}] must be a valid HTTPS URL.`);
  }
  if (parsed.protocol !== "https:") throw new Error(`urls[${index}] must use HTTPS.`);
  return value;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function cleanStringArray(values: string[] | undefined): string[] | undefined {
  const cleaned = values?.map((value) => value.trim()).filter(Boolean);
  return cleaned && cleaned.length > 0 ? cleaned : undefined;
}
