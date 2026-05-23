type ExtensionAPI = any;

declare const process: { env: Record<string, string | undefined> };

const CODEX_PROVIDER = "openai-codex";
const DEFAULT_BACKEND_BASE_URL = "https://chatgpt.com/backend-api";

type HeaderMap = Headers | Array<[string, string]> | Record<string, unknown> | undefined;

type BackendWindow = {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
};

type BackendRateLimit = {
	primary_window?: BackendWindow | null;
	secondary_window?: BackendWindow | null;
};

type BackendCredits = {
	has_credits?: boolean;
	unlimited?: boolean;
	balance?: string | number | null;
};

type BackendPayload = {
	plan_type?: string;
	rate_limit?: BackendRateLimit | null;
	credits?: BackendCredits | null;
	rate_limit_reached_type?: { type?: string } | null;
	additional_rate_limits?: Array<{
		limit_name?: string;
		metered_feature?: string;
		rate_limit?: BackendRateLimit | null;
	}> | null;
};

type WindowSummary = {
	usedPercent: number;
	remainingPercent: number;
	windowMinutes?: number;
	resetAt?: number;
	resetAfterSeconds?: number;
};

type LimitSummary = {
	limitId: string;
	limitName?: string;
	primary?: WindowSummary;
	secondary?: WindowSummary;
};

type QuotaSummary = {
	fetchedAt: string;
	provider: string;
	model: string;
	url: string;
	planType?: string;
	rateLimitReachedType?: string;
	limits: LimitSummary[];
	credits?: {
		hasCredits: boolean;
		unlimited: boolean;
		balance?: string;
	};
};

function isCodexModel(model: unknown): model is { provider: string; id?: string; baseUrl?: string } {
	return !!model && typeof model === "object" && (model as { provider?: unknown }).provider === CODEX_PROVIDER;
}

function headerValue(headers: Headers, name: string): string | null {
	return headers.get(name);
}

function applyAuthHeaders(headers: Headers, extra: HeaderMap, apiKey?: string) {
	if (extra instanceof Headers) {
		extra.forEach((value, key) => headers.set(key, value));
	} else if (Array.isArray(extra)) {
		for (const [key, value] of extra) headers.set(key, value);
	} else {
		for (const [key, value] of Object.entries(extra ?? {})) {
			if (typeof value === "string" && value.length > 0) headers.set(key, value);
		}
	}

	if (!headerValue(headers, "authorization") && apiKey) {
		headers.set("authorization", apiKey.toLowerCase().startsWith("bearer ") ? apiKey : `Bearer ${apiKey}`);
	}

	if (!headerValue(headers, "user-agent")) headers.set("user-agent", "pi-codex-quota-extension");
}

function backendBaseUrl(model: { baseUrl?: string }): string {
	const raw = (process.env.PI_CODEX_QUOTA_BASE_URL || model.baseUrl || DEFAULT_BACKEND_BASE_URL).trim();
	let base = raw.replace(/\/+$/, "");

	const backendIndex = base.indexOf("/backend-api");
	if (backendIndex >= 0) return base.slice(0, backendIndex + "/backend-api".length);

	if ((base.startsWith("https://chatgpt.com") || base.startsWith("https://chat.openai.com")) && !base.includes("/backend-api")) {
		base += "/backend-api";
	}

	return base;
}

function usageUrl(baseUrl: string): string {
	return baseUrl.includes("/backend-api") ? `${baseUrl}/wham/usage` : `${baseUrl}/api/codex/usage`;
}

async function fetchText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return "";
	}
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function normalizeWindow(window: BackendWindow | null | undefined): WindowSummary | undefined {
	if (!window) return undefined;
	const usedPercent = Number(window.used_percent ?? 0);
	if (!Number.isFinite(usedPercent)) return undefined;

	const windowSeconds = Number(window.limit_window_seconds);
	const resetAt = Number(window.reset_at);
	const resetAfterSeconds = Number(window.reset_after_seconds);

	return {
		usedPercent,
		remainingPercent: clampPercent(100 - usedPercent),
		windowMinutes: Number.isFinite(windowSeconds) && windowSeconds > 0 ? Math.round(windowSeconds / 60) : undefined,
		resetAt: Number.isFinite(resetAt) && resetAt > 0 ? resetAt : undefined,
		resetAfterSeconds: Number.isFinite(resetAfterSeconds) && resetAfterSeconds >= 0 ? resetAfterSeconds : undefined,
	};
}

function makeLimit(limitId: string, limitName: string | undefined, rateLimit: BackendRateLimit | null | undefined): LimitSummary {
	return {
		limitId,
		limitName,
		primary: normalizeWindow(rateLimit?.primary_window),
		secondary: normalizeWindow(rateLimit?.secondary_window),
	};
}

function summarize(payload: BackendPayload, provider: string, model: string, url: string): QuotaSummary {
	const limits = [makeLimit("codex", undefined, payload.rate_limit)];

	for (const extra of payload.additional_rate_limits ?? []) {
		const limitId = extra.metered_feature || extra.limit_name || "unknown";
		limits.push(makeLimit(limitId, extra.limit_name, extra.rate_limit));
	}

	return {
		fetchedAt: new Date().toISOString(),
		provider,
		model,
		url,
		planType: payload.plan_type,
		rateLimitReachedType: payload.rate_limit_reached_type?.type,
		limits,
		credits: payload.credits
			? {
					hasCredits: !!payload.credits.has_credits,
					unlimited: !!payload.credits.unlimited,
					balance: payload.credits.balance == null ? undefined : String(payload.credits.balance),
				}
			: undefined,
	};
}

async function fetchQuota(ctx: { model: { provider: string; id?: string; baseUrl?: string }; modelRegistry: any }): Promise<QuotaSummary> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth?.ok) throw new Error(auth?.error || "could not resolve openai-codex auth");

	const headers = new Headers();
	applyAuthHeaders(headers, auth.headers, auth.apiKey);

	if (!headerValue(headers, "authorization")) {
		throw new Error("openai-codex auth did not provide a bearer token; /quota needs ChatGPT subscription auth");
	}

	const url = usageUrl(backendBaseUrl(ctx.model));
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	let response: Response;
	try {
		response = await fetch(url, { method: "GET", headers, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
	if (!response.ok) {
		const body = (await fetchText(response)).slice(0, 1000);
		throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}${body ? `; ${body}` : ""}`);
	}

	const payload = (await response.json()) as BackendPayload;
	return summarize(payload, ctx.model.provider, ctx.model.id ?? "unknown", url);
}

function percent(value: number): string {
	return Math.abs(value - Math.round(value)) < 0.05 ? String(Math.round(value)) : value.toFixed(1);
}

function durationMinutes(minutes: number): string {
	if (minutes < 60) return `${minutes}m`;
	if (minutes < 60 * 24) {
		const h = Math.floor(minutes / 60);
		const m = minutes % 60;
		return m ? `${h}h ${m}m` : `${h}h`;
	}
	const d = Math.floor(minutes / (60 * 24));
	const h = Math.floor((minutes % (60 * 24)) / 60);
	return h ? `${d}d ${h}h` : `${d}d`;
}

function durationSeconds(seconds: number): string {
	if (seconds <= 0) return "now";
	if (seconds < 90) return `${Math.round(seconds)}s`;
	return durationMinutes(Math.round(seconds / 60));
}

function windowLabel(window: WindowSummary, fallback: string): string {
	return window.windowMinutes ? `${durationMinutes(window.windowMinutes)} window` : fallback;
}

function resetText(window: WindowSummary): string {
	const resetAfter = window.resetAfterSeconds ?? (window.resetAt ? Math.round(window.resetAt - Date.now() / 1000) : undefined);
	if (resetAfter == null && !window.resetAt) return "";

	const parts: string[] = [];
	if (resetAfter != null) parts.push(`in ${durationSeconds(resetAfter)}`);
	if (window.resetAt) parts.push(new Date(window.resetAt * 1000).toLocaleString());
	return `, resets ${parts.join(" · ")}`;
}

function formatWindow(label: string, window: WindowSummary): string {
	return `  ${windowLabel(window, label)}: ${percent(window.remainingPercent)}% left (${percent(window.usedPercent)}% used${resetText(window)})`;
}

function formatQuota(quota: QuotaSummary): string {
	const plan = quota.planType ? ` · plan ${quota.planType}` : "";
	const lines = [`Codex quota for ${quota.provider}/${quota.model}${plan}`];

	for (const limit of quota.limits) {
		const label = limit.limitName || limit.limitId;
		lines.push(`${label}:`);
		if (limit.primary) lines.push(formatWindow("primary window", limit.primary));
		if (limit.secondary) lines.push(formatWindow("secondary window", limit.secondary));
		if (!limit.primary && !limit.secondary) lines.push("  no rate-limit windows returned");
	}

	if (quota.credits?.hasCredits) {
		const value = quota.credits.unlimited ? "unlimited" : quota.credits.balance ? `${quota.credits.balance} credits` : "available";
		lines.push(`credits: ${value}`);
	}

	if (quota.rateLimitReachedType) lines.push(`limit state: ${quota.rateLimitReachedType}`);
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("quota", {
		description: "Show OpenAI Codex quota when the active provider is openai-codex",
		handler: async (_args: string, ctx: any) => {
			if (!isCodexModel(ctx.model)) return;

			ctx.ui.setStatus("quota", "quota…");
			try {
				const quota = await fetchQuota({ model: ctx.model, modelRegistry: ctx.modelRegistry });
				pi.sendMessage({
					customType: "quota",
					content: formatQuota(quota),
					display: true,
					details: quota,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				pi.sendMessage({
					customType: "quota",
					content: `Codex quota failed: ${message}`,
					display: true,
					details: { error: message },
				});
			} finally {
				ctx.ui.setStatus("quota", undefined);
			}
		},
	});
}
