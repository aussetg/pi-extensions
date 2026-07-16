import type { JsonValue } from "../types.js";
import type { AgentWebMediator } from "./host-mediator.js";

const KAGI_API_ROOT = "https://kagi.com/api/v1";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface KagiWebMediatorOptions {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** Small coordinator-side Kagi Search/Extract client; the key never enters semantic identity. */
export class KagiWebMediator implements AgentWebMediator {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: KagiWebMediatorOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.PI_WORKFLOW_KAGI_API_KEY ?? process.env.KAGI_API_KEY ?? "";
    if (!this.apiKey || /[\u0000-\u001f\u007f]/.test(this.apiKey) || this.apiKey.length > 4_096) {
      throw new Error("Kagi mediated research requires a valid KAGI_API_KEY");
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 60_000) {
      throw new TypeError("Kagi mediator timeout is invalid");
    }
  }

  async search(input: { query: string; maxResults: number }): Promise<JsonValue> {
    const response = await this.request("/search", {
      query: input.query,
      workflow: "search",
      format: "json",
      limit: input.maxResults,
      timeout: Math.min(4, this.timeoutMs / 1_000),
    });
    const envelope = record(response, "Kagi search response");
    const payload = envelope.data;
    const data = Array.isArray(payload)
      ? payload
      : array(record(payload, "Kagi search data").search, "Kagi search results");
    return {
      results: data.slice(0, input.maxResults).flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const result = entry as Record<string, unknown>;
        if (typeof result.url !== "string" || typeof result.title !== "string") return [];
        return [{
          title: bounded(result.title, 2_000),
          url: bounded(result.url, 8_192),
          ...(typeof result.snippet === "string" ? { snippet: bounded(result.snippet, 8_000) } : {}),
          ...(typeof result.time === "string" ? { publishedAt: bounded(result.time, 128) } : {}),
        }];
      }),
    } as unknown as JsonValue;
  }

  async fetch(input: { url: string; maxBytes: number }): Promise<JsonValue> {
    const response = await this.request("/extract", {
      pages: [{ url: input.url }],
      timeout: Math.min(10, this.timeoutMs / 1_000),
      format: "json",
    });
    const data = array(record(response, "Kagi extract response").data, "Kagi extract data");
    const page = data.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
      && (entry as Record<string, unknown>).url === input.url) as Record<string, unknown> | undefined;
    if (!page) throw new Error("Kagi Extract returned no matching page");
    if (typeof page.error === "string" && page.error) throw new Error(`Kagi Extract failed: ${bounded(page.error, 2_000)}`);
    if (typeof page.markdown !== "string") throw new Error("Kagi Extract returned no markdown content");
    const content = truncateUtf8(page.markdown, input.maxBytes);
    return {
      url: input.url,
      content: content.text,
      bytes: Buffer.byteLength(content.text),
      truncated: content.truncated,
      format: "markdown",
    } as unknown as JsonValue;
  }

  private async request(endpoint: "/search" | "/extract", body: unknown): Promise<unknown> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetchImpl(`${KAGI_API_ROOT}${endpoint}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES) throw new Error("Kagi API response exceeded its bound");
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error(`Kagi API returned non-JSON status ${response.status}`); }
    if (!response.ok) {
      throw new Error(`Kagi API returned ${response.status}: ${bounded(errorMessage(value), 2_000)}`);
    }
    return value;
  }
}

function truncateUtf8(value: string, maximumBytes: number): { text: string; truncated: boolean } {
  const source = Buffer.from(value, "utf8");
  if (source.length <= maximumBytes) return { text: value, truncated: false };
  let end = maximumBytes;
  while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
  return { text: source.subarray(0, end).toString("utf8"), truncated: true };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value;
}

function bounded(value: string, scalars: number): string {
  return Array.from(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�")).slice(0, scalars).join("");
}

function errorMessage(value: unknown): string {
  if (!value || typeof value !== "object") return String(value);
  const recordValue = value as Record<string, unknown>;
  const errors = recordValue.errors ?? recordValue.error;
  return typeof errors === "string" ? errors : JSON.stringify(errors ?? value);
}
