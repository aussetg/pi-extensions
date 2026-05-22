import type { FeedbackConfig } from "./types.ts";
import type { PiApi } from "./pi.ts";

export function createDefaultConfig(): FeedbackConfig {
  return {
    enabled: true,
    strict: false,
    autoFormat: true,
    formatMode: "immediate",
    diagnostics: {
      inline: "touched",
      maxInline: 8,
      inlineTimeoutMs: 1200,
      settleMs: 0,
      timeoutMs: 1800,
      delayedTimeoutMs: 8000,
      expandToSymbol: true,
      includeCrossFileRelated: true,
    },
    lsp: {
      enabled: true,
      idleTimeoutMs: 240_000,
      servers: {},
    },
    formatters: {},
  };
}

export function registerFlags(pi: PiApi): void {
  pi.registerFlag?.("no-code-feedback", {
    description: "Disable pi-code-feedback for this session.",
    type: "boolean",
    default: false,
  });

  pi.registerFlag?.("code-feedback-no-lsp", {
    description: "Disable pi-code-feedback LSP clients and inline LSP diagnostics.",
    type: "boolean",
    default: false,
  });

  pi.registerFlag?.("code-feedback-no-format", {
    description: "Disable pi-code-feedback automatic formatter pass.",
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

  return config;
}

