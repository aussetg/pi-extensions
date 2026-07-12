import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");

export type PierreColorValue =
  | string
  | {
      dark?: string;
      light?: string;
    };

export interface PierreRendererConfig {
  spacing: {
    beforeDiff: number;
    afterDiff: number;
  };
  layout: {
    leftPadding: number;
    showFileHeaders: "auto" | "always" | "never";
  };
  gutter: {
    barPosition: "before-number" | "after-number";
    lineNumberAlign: "left" | "right";
    lineNumberMinWidth: number;
    lineNumberPaddingRight: number;
    separator: string;
    barGap: string;
    contextBar: string;
    additionBar: string;
    deletionBar: string;
    continuationBar: string;
    hunkBar: string;
  };
  hunk: {
    collapsedLabel: string;
  };
  wordDiff: {
    enabled: boolean;
    style: "word-alt" | "none";
    maxLineLength: number;
  };
  syntaxHighlight: {
    enabled: boolean;
    maxLines: number;
    maxLineLength: number;
  };
  colors: {
    editorBg: PierreColorValue;
    headerBg: PierreColorValue;
    headerFg: PierreColorValue;
    headerAccentFg: PierreColorValue;
    contextFg: PierreColorValue;
    contextRowBg: PierreColorValue;
    additionFg: PierreColorValue;
    additionRowBg: PierreColorValue;
    deletionFg: PierreColorValue;
    deletionRowBg: PierreColorValue;
    lineNumberFg: PierreColorValue;
    lineNumberBg: PierreColorValue;
    additionLineNumberFg: PierreColorValue;
    additionLineNumberBg: PierreColorValue;
    deletionLineNumberFg: PierreColorValue;
    deletionLineNumberBg: PierreColorValue;
    gutterFg: PierreColorValue;
    gutterBg: PierreColorValue;
    contextBarFg: PierreColorValue;
    contextBarBg: PierreColorValue;
    additionBarFg: PierreColorValue;
    additionBarBg: PierreColorValue;
    deletionBarFg: PierreColorValue;
    deletionBarBg: PierreColorValue;
    hunkFg: PierreColorValue;
    hunkKeyFg: PierreColorValue;
    hunkBg: PierreColorValue;
    additionWordBg: PierreColorValue;
    deletionWordBg: PierreColorValue;
    syntaxText: PierreColorValue;
    syntaxComment: PierreColorValue;
    syntaxKeyword: PierreColorValue;
    syntaxFunction: PierreColorValue;
    syntaxVariable: PierreColorValue;
    syntaxString: PierreColorValue;
    syntaxNumber: PierreColorValue;
    syntaxType: PierreColorValue;
    syntaxOperator: PierreColorValue;
    syntaxPunctuation: PierreColorValue;
    metadataFg: PierreColorValue;
    metadataBg: PierreColorValue;
    pendingFg: PierreColorValue;
    pendingBg: PierreColorValue;
    successFg: PierreColorValue;
    successBg: PierreColorValue;
    errorFg: PierreColorValue;
    errorBg: PierreColorValue;
  };
}

export const PIERRE_CONFIG_PATH = join(
  AGENT_DIR,
  "rich-tools-pierre.json",
);

export const DEFAULT_PIERRE_RENDERER_CONFIG: PierreRendererConfig = {
  spacing: {
    beforeDiff: 1,
    afterDiff: 1,
  },
  layout: {
    leftPadding: 1,
    showFileHeaders: "auto",
  },
  gutter: {
    barPosition: "before-number",
    lineNumberAlign: "left",
    lineNumberMinWidth: 3,
    lineNumberPaddingRight: 1,
    separator: " ",
    barGap: " ",
    contextBar: " ",
    additionBar: "┃",
    deletionBar: "┋",
    continuationBar: " ",
    hunkBar: " ",
  },
  hunk: {
    collapsedLabel: "... ({count} more {line|lines}, ctrl+o to expand)",
  },
  wordDiff: {
    enabled: true,
    style: "word-alt",
    maxLineLength: 2000,
  },
  syntaxHighlight: {
    enabled: true,
    maxLines: 1200,
    maxLineLength: 1000,
  },
  colors: {
    editorBg: "toolSuccessBg",
    headerBg: "toolSuccessBg",
    headerFg: "toolTitle",
    headerAccentFg: "accent",
    contextFg: "toolDiffContext",
    contextRowBg: "toolSuccessBg",
    additionFg: "toolDiffAdded",
    additionRowBg: { dark: "#223b2a", light: "#dff4e7" },
    deletionFg: "toolDiffRemoved",
    deletionRowBg: "toolErrorBg",
    lineNumberFg: "dim",
    lineNumberBg: "toolSuccessBg",
    additionLineNumberFg: "toolDiffAdded",
    additionLineNumberBg: { dark: "#223b2a", light: "#dff4e7" },
    deletionLineNumberFg: "toolDiffRemoved",
    deletionLineNumberBg: "toolErrorBg",
    gutterFg: "dim",
    gutterBg: "toolSuccessBg",
    contextBarFg: "dim",
    contextBarBg: "toolSuccessBg",
    additionBarFg: "toolDiffAdded",
    additionBarBg: { dark: "#223b2a", light: "#dff4e7" },
    deletionBarFg: "toolDiffRemoved",
    deletionBarBg: "toolErrorBg",
    hunkFg: "muted",
    hunkKeyFg: "dim",
    hunkBg: "toolSuccessBg",
    additionWordBg: { dark: "#214a34", light: "#c8efd8" },
    deletionWordBg: { dark: "#5a2a2a", light: "#ffd0d0" },
    syntaxText: "toolOutput",
    syntaxComment: "syntaxComment",
    syntaxKeyword: "syntaxKeyword",
    syntaxFunction: "syntaxFunction",
    syntaxVariable: "syntaxVariable",
    syntaxString: "syntaxString",
    syntaxNumber: "syntaxNumber",
    syntaxType: "syntaxType",
    syntaxOperator: "syntaxOperator",
    syntaxPunctuation: "syntaxPunctuation",
    metadataFg: "dim",
    metadataBg: "toolSuccessBg",
    pendingFg: "warning",
    pendingBg: "toolPendingBg",
    successFg: "success",
    successBg: "toolSuccessBg",
    errorFg: "error",
    errorBg: "toolErrorBg",
  },
};

let cachedConfig: PierreRendererConfig = DEFAULT_PIERRE_RENDERER_CONFIG;

export function getPierreRendererConfig(): PierreRendererConfig {
  return cachedConfig;
}

export function reloadPierreRendererConfig(): void {
  cachedConfig = loadConfigFile();
}

function loadConfigFile(): PierreRendererConfig {
  try {
    const raw = readFileSync(PIERRE_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return sanitizeConfig(mergeConfig(DEFAULT_PIERRE_RENDERER_CONFIG, parsed));
  } catch {
    return DEFAULT_PIERRE_RENDERER_CONFIG;
  }
}

function mergeConfig<T>(defaults: T, value: unknown): T {
  if (!isPlainObject(defaults)) return value === undefined ? defaults : (value as T);
  if (isColorObject(defaults)) return value === undefined ? defaults : (value as T);
  if (!isPlainObject(value)) return defaults;

  const merged: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const [key, nextValue] of Object.entries(value)) {
    const defaultValue = (defaults as Record<string, unknown>)[key];
    merged[key] = isPlainObject(defaultValue)
      ? mergeConfig(defaultValue, nextValue)
      : nextValue;
  }
  return merged as T;
}

function sanitizeConfig(config: PierreRendererConfig): PierreRendererConfig {
  return {
    ...config,
    spacing: {
      ...config.spacing,
      beforeDiff: clampInt(config.spacing.beforeDiff, 0, 4),
      afterDiff: clampInt(config.spacing.afterDiff, 0, 4),
    },
    layout: {
      ...config.layout,
      leftPadding: clampInt(config.layout.leftPadding, 0, 8),
      showFileHeaders: ["auto", "always", "never"].includes(
        config.layout.showFileHeaders,
      )
        ? config.layout.showFileHeaders
        : "auto",
    },
    gutter: {
      ...config.gutter,
      barPosition:
        config.gutter.barPosition === "after-number"
          ? "after-number"
          : "before-number",
      lineNumberAlign:
        config.gutter.lineNumberAlign === "right" ? "right" : "left",
      lineNumberMinWidth: clampInt(config.gutter.lineNumberMinWidth, 1, 8),
      lineNumberPaddingRight: clampInt(config.gutter.lineNumberPaddingRight, 0, 4),
      separator: safeGlyph(config.gutter.separator, ""),
      barGap: safeGlyph(config.gutter.barGap, " "),
      contextBar: safeGlyph(config.gutter.contextBar, "│"),
      additionBar: safeGlyph(config.gutter.additionBar, "┃"),
      deletionBar: safeGlyph(config.gutter.deletionBar, "┃"),
      continuationBar: safeGlyph(config.gutter.continuationBar, "│"),
      hunkBar: safeGlyph(config.gutter.hunkBar, "│"),
    },
    wordDiff: {
      ...config.wordDiff,
      enabled: Boolean(config.wordDiff.enabled),
      style: config.wordDiff.style === "none" ? "none" : "word-alt",
      maxLineLength: clampInt(config.wordDiff.maxLineLength, 80, 20000),
    },
    syntaxHighlight: {
      ...config.syntaxHighlight,
      enabled: Boolean(config.syntaxHighlight.enabled),
      maxLines: clampInt(config.syntaxHighlight.maxLines, 0, 20000),
      maxLineLength: clampInt(config.syntaxHighlight.maxLineLength, 80, 20000),
    },
  };
}

function safeGlyph(value: unknown, fallback: string): string {
  return typeof value === "string" && visibleGlyphLength(value) <= 8
    ? value
    : fallback;
}

function visibleGlyphLength(value: string): number {
  return [...value].length;
}

function clampInt(value: unknown, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isColorObject(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key === "dark" || key === "light");
}
