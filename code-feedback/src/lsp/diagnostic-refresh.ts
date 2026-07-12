export const DEFAULT_DIAGNOSTIC_REFRESH_CONCURRENCY = 4;
export const MAX_DIAGNOSTIC_REFRESH_CONCURRENCY = 16;

export function normalizeDiagnosticRefreshConcurrency(
  value: unknown,
  fallback = DEFAULT_DIAGNOSTIC_REFRESH_CONCURRENCY,
): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : Number.NaN;
  const next = Number.isFinite(parsed) ? parsed : fallback;
  const finite = Number.isFinite(next) ? next : DEFAULT_DIAGNOSTIC_REFRESH_CONCURRENCY;
  return Math.max(1, Math.min(MAX_DIAGNOSTIC_REFRESH_CONCURRENCY, Math.floor(finite)));
}
