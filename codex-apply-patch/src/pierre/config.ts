import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

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
    maxVisibleLines: number;
    expandedMaxVisibleRatio: number;
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
    moreDiffLabel: string;
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
  homedir(),
  ".pi",
  "agent",
  "codex-apply-patch-pierre.json",
);

export const DEFAULT_PIERRE_RENDERER_CONFIG: PierreRendererConfig = {
  spacing: {
    beforeDiff: 1,
    afterDiff: 1,
  },
  layout: {
    leftPadding: 1,
    maxVisibleLines: 18,
    expandedMaxVisibleRatio: 0.7,
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
    moreDiffLabel: "... ({count} more {line|lines}, ctrl+o to expand)",
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
    hunkFg: "dim",
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

let cachedConfig: PierreRendererConfig | undefined;
let cachedMtime = -1;

export function getPierreRendererConfig(): PierreRendererConfig {
  ensureDefaultConfigFile();

  const mtime = configMtime();
  if (cachedConfig && cachedMtime === mtime) return cachedConfig;

  cachedMtime = mtime;
  cachedConfig = loadConfigFile();
  return cachedConfig;
}

function ensureDefaultConfigFile(): void {
  if (existsSync(PIERRE_CONFIG_PATH)) return;

  try {
    mkdirSync(dirname(PIERRE_CONFIG_PATH), { recursive: true });
    writeFileSync(
      PIERRE_CONFIG_PATH,
      `${JSON.stringify(DEFAULT_PIERRE_RENDERER_CONFIG, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // Rendering must not fail because config creation failed.
  }
}

function configMtime(): number {
  try {
    return statSync(PIERRE_CONFIG_PATH).mtimeMs;
  } catch {
    return -1;
  }
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
      maxVisibleLines: clampInt(config.layout.maxVisibleLines, 4, 200),
      expandedMaxVisibleRatio: clampNumber(
        config.layout.expandedMaxVisibleRatio,
        0.2,
        1,
      ),
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

function clampNumber(value: unknown, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isColorObject(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key === "dark" || key === "light");
}
