export const DEFAULT_MAX_ACTIVE_LSP_CLIENTS = 8;
export const MAX_ACTIVE_LSP_CLIENTS = 32;
export const DEFAULT_LSP_INITIALIZATION_CONCURRENCY = 2;
export const MAX_LSP_INITIALIZATION_CONCURRENCY = 8;
export const DEFAULT_DIAGNOSTIC_REFRESH_CONCURRENCY = 4;
export const MAX_DIAGNOSTIC_REFRESH_CONCURRENCY = 16;

export function normalizeMaxActiveLspClients(value: unknown, fallback = DEFAULT_MAX_ACTIVE_LSP_CLIENTS): number {
  return normalizeBoundedPositiveInteger(value, fallback, MAX_ACTIVE_LSP_CLIENTS);
}

export function normalizeLspInitializationConcurrency(
  value: unknown,
  fallback = DEFAULT_LSP_INITIALIZATION_CONCURRENCY,
): number {
  return normalizeBoundedPositiveInteger(value, fallback, MAX_LSP_INITIALIZATION_CONCURRENCY);
}

export function normalizeDiagnosticRefreshConcurrency(
  value: unknown,
  fallback = DEFAULT_DIAGNOSTIC_REFRESH_CONCURRENCY,
): number {
  return normalizeBoundedPositiveInteger(value, fallback, MAX_DIAGNOSTIC_REFRESH_CONCURRENCY);
}

function normalizeBoundedPositiveInteger(value: unknown, fallback: number, maximum: number): number {
  const normalizedFallback = Number.isFinite(fallback)
    ? Math.max(1, Math.min(maximum, Math.floor(fallback)))
    : 1;
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : normalizedFallback;
  if (!Number.isFinite(parsed)) return normalizedFallback;
  return Math.max(1, Math.min(maximum, Math.floor(parsed)));
}
