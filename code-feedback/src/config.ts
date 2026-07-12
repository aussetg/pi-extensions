import type { FeedbackConfig } from "./types.ts";
import type { PiApi } from "./pi.ts";
import { DEFAULT_DIAGNOSTIC_REFRESH_CONCURRENCY, normalizeDiagnosticRefreshConcurrency } from "./lsp/diagnostic-refresh.ts";

export function createDefaultConfig(): FeedbackConfig {
  return {
    enabled: true,
    strict: false,
    autoFormat: true,
    formatMode: "immediate",
    diagnostics: {
      inline: "touched",
      maxInline: 8,
      inlineTimeoutMs: 500,
      settleMs: 0,
      timeoutMs: 1800,
      delayedTimeoutMs: 8000,
      includeCrossFileRelated: true,
    },
    lsp: {
      enabled: true,
      idleTimeoutMs: 240_000,
      diagnosticRefreshConcurrency: DEFAULT_DIAGNOSTIC_REFRESH_CONCURRENCY,
      servers: {},
    },
    formatters: {},
  };
}

export function registerFlags(pi: PiApi): void {
  pi.registerFlag?.("no-code-feedback", {
    description: "Disable code-feedback for this session.",
    type: "boolean",
    default: false,
  });

  pi.registerFlag?.("code-feedback-no-lsp", {
    description: "Disable code-feedback LSP clients and inline LSP diagnostics.",
    type: "boolean",
    default: false,
  });

  pi.registerFlag?.("code-feedback-no-format", {
    description: "Disable code-feedback automatic formatter pass.",
    type: "boolean",
    default: false,
  });

  pi.registerFlag?.("code-feedback-strict", {
    description: "Treat linked error diagnostics as edit errors.",
    type: "boolean",
    default: false,
  });

  pi.registerFlag?.("code-feedback-all-diagnostics", {
    description: "Inline all diagnostics instead of only touched/provenance-linked diagnostics.",
    type: "boolean",
    default: false,
  });

  pi.registerFlag?.("code-feedback-lsp-concurrency", {
    description: `Max concurrent LSP diagnostic refreshes across different files (1-16, default ${DEFAULT_DIAGNOSTIC_REFRESH_CONCURRENCY}).`,
    type: "string",
    default: String(DEFAULT_DIAGNOSTIC_REFRESH_CONCURRENCY),
  });
}

export function resolveConfig(pi: PiApi): FeedbackConfig {
  const config = createDefaultConfig();

  if (pi.getFlag?.("no-code-feedback")) {
    config.enabled = false;
  }
  if (pi.getFlag?.("code-feedback-no-lsp")) {
    config.lsp.enabled = false;
  }
  if (pi.getFlag?.("code-feedback-no-format")) {
    config.autoFormat = false;
  }
  if (pi.getFlag?.("code-feedback-strict")) {
    config.strict = true;
  }
  if (pi.getFlag?.("code-feedback-all-diagnostics")) {
    config.diagnostics.inline = "all";
  }
  config.lsp.diagnosticRefreshConcurrency = normalizeDiagnosticRefreshConcurrency(
    pi.getFlag?.("code-feedback-lsp-concurrency"),
    config.lsp.diagnosticRefreshConcurrency,
  );

  return config;
}

